-- Detection-quality feedback loop: reviewers rate whether a flagged problem was
-- TRULY problematic; the ingestion learns from it and stops re-surfacing
-- confirmed false positives (until a genuinely newer episode occurs).
--
-- Scope note: the qa_* detection RPCs are shared with the bot + dashboards and
-- are NOT modified here. Learning happens at the kk layer: kk_problem_ratings is
-- the labeled signal (which the QA-bot team can later feed into qa_*), and
-- kk_ingest_problems() suppresses detections a reviewer marked "not a problem".

-- Reviewer's truthiness verdict on a problem (separate from the resolution
-- workflow status). Mirrored to kk_problems.verdict for easy filtering/display.
alter table public.kk_problems
  add column if not exists verdict text check (verdict in ('problematic', 'not_problematic')),
  add column if not exists verdict_at timestamptz;

-- Append-only history of ratings = the learning signal.
create table if not exists public.kk_problem_ratings (
  id                  uuid primary key default gen_random_uuid(),
  problem_id          text not null references public.kk_problems(problem_id) on delete cascade,
  is_problematic      boolean not null,
  comment             text,
  rated_by            text,
  -- the problem's detected_at when it was rated, so a strictly NEWER episode in
  -- the same chat re-surfaces instead of staying suppressed forever.
  problem_detected_at timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists kk_problem_ratings_problem_id_idx
  on public.kk_problem_ratings (problem_id);

-- Latest verdict per problem.
create or replace view public.kk_latest_rating as
  select distinct on (problem_id)
    problem_id, is_problematic, problem_detected_at, created_at
  from public.kk_problem_ratings
  order by problem_id, created_at desc;

-- Re-create ingestion with false-positive suppression on the three live
-- detection sources (unanswered / late / promise). A row is suppressed when its
-- latest verdict is "not problematic" AND that verdict covers this episode
-- (rated detected_at >= the new detected_at).
create or replace function public.kk_ingest_problems()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sona_count       integer := 0;
  margarita_count  integer := 0;
  unanswered_count integer := 0;
  late_count       integer := 0;
  promise_count    integer := 0;
  win timestamptz := now() - interval '120 hours';
begin
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'sona:' || t.id, 'sona_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    t.company_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when t.urgent or t.priority = 'critical' then 1 when t.priority = 'medium' then 2 else 2 end,
    coalesce(nullif(btrim(t.title), ''), nullif(btrim(t.type), ''), 'Проблема по проверке (Сона)'),
    coalesce(nullif(btrim(t.description), ''), nullif(btrim(r.comment), '')),
    nullif(btrim(r.comment), ''), coalesce(t.created_at, now()), 'waiting_for_accountant'
  from public.sqa_tickets t
  left join public.sqa_reviews r on r.id = t.review_id
  left join public.mqa_chats   c on c.agr_no = t.company_agr_no
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(coalesce(nullif(btrim(t.accountant), ''), nullif(btrim(c.accountant), '')))
  where coalesce(t.status, 'open') <> 'cancelled'
  on conflict (problem_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    priority=excluded.priority, problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics sona_count = row_count;

  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'margarita:' || v.id, 'margarita_review',
    coalesce(nullif(btrim(v.client), ''), nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    v.chat_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when v.severity in ('Критичное', 'Грубое') then 1 when v.severity = 'Среднее' then 2 else 2 end,
    coalesce(nullif(btrim(v.violation_type), ''), 'Нарушение (Маргарита)'),
    coalesce(nullif(btrim(v.note), ''), nullif(btrim(v.violation_type), '')),
    null, coalesce(v.created_at, v.vdate::timestamptz, now()), 'waiting_for_accountant'
  from public.mqa_violations v
  left join public.mqa_chats c on c.agr_no = v.chat_agr_no
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(coalesce(nullif(btrim(v.accountant), ''), nullif(btrim(c.accountant), '')))
  on conflict (problem_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    priority=excluded.priority, problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    detected_at=excluded.detected_at, updated_at=now();
  get diagnostics margarita_count = row_count;

  with src as (
    select
      e.elem,
      (e.elem->>'chat_id') as chat_id,
      (coalesce((e.elem->>'data_incomplete')::bool, false) or coalesce((e.elem->>'needs_review')::bool, false)) as uncertain,
      e.elem->>'problematic_client_message' as msg,
      e.elem->>'accountant_names' as acc_names,
      e.elem->>'severity' as severity,
      nullif(e.elem->>'oldest_pending_at', '')::timestamptz as detected_at,
      nullif(btrim(e.elem->>'chat_name'), '') as chat_name,
      nullif(btrim(e.elem->>'flag_reason'), '') as flag_reason
    from jsonb_array_elements(coalesce((public.qa_unanswered_chats(win, 2))::jsonb, '[]'::jsonb)) as e(elem)
  ),
  mentioned as (
    select s.chat_id, emp.id as emp_id, emp.full_name as emp_name, 1 as tier
    from src s
    cross join lateral regexp_matches(coalesce(s.msg, ''), '@([A-Za-z0-9_]+)', 'g') as g(m)
    join public.employees emp
      on lower(emp.normalized_username) = lower(g.m[1]) or lower(emp.telegram_username) = lower(g.m[1])
    where not s.uncertain
  ),
  named as (
    select s.chat_id, re.id as emp_id, re.full_name as emp_name, 2 as tier
    from src s
    cross join lateral unnest(string_to_array(s.acc_names, ',')) as an(name)
    cross join lateral public.kk_resolve_employee(an.name) re
    where not s.uncertain and nullif(btrim(s.acc_names), '') is not null
  ),
  fallback as (
    select s.chat_id, null::uuid as emp_id, null::text as emp_name, 3 as tier
    from src s where not s.uncertain
  ),
  cand as (
    select * from mentioned union all select * from named union all select * from fallback
  ),
  best as (select chat_id, min(tier) as t from cand group by chat_id),
  assignees as (
    select distinct c.chat_id, c.emp_id, c.emp_name
    from cand c join best b on b.chat_id = c.chat_id and b.t = c.tier
  )
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select distinct on (problem_id) * from (
    select
      'unanswered:' || s.chat_id || coalesce(':' || a.emp_id::text, '') as problem_id,
      'ai' as source, s.chat_name as client_name, null::text as contract_id, s.chat_name as chat_name,
      'https://web.telegram.org/a/#' || s.chat_id as chat_link,
      a.emp_name as accountant_name, a.emp_id::text as accountant_id,
      case when s.severity = 'critical' then 1 when s.severity = 'minor' then 3 else 2 end as priority,
      'Без ответа клиенту' as problem_title,
      nullif(btrim(s.msg), '') as problem_description,
      s.flag_reason as ai_comment, s.detected_at as detected_at, 'waiting_for_accountant' as status
    from src s
    join assignees a on a.chat_id = s.chat_id
    where not s.uncertain
    union all
    select
      'review:' || s.chat_id,
      'ai', s.chat_name, null::text, s.chat_name,
      'https://web.telegram.org/a/#' || s.chat_id,
      null::text, null::text,
      3,
      'Возможно без ответа (требует проверки)',
      nullif(btrim(s.msg), ''),
      s.flag_reason, s.detected_at, 'waiting_for_accountant'
    from src s where s.uncertain
  ) rows
  where not exists (
    select 1 from public.kk_latest_rating lr
    where lr.problem_id = rows.problem_id and lr.is_problematic = false
      and coalesce(lr.problem_detected_at, 'infinity'::timestamptz) >= coalesce(rows.detected_at, '-infinity'::timestamptz)
  )
  order by problem_id
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics unanswered_count = row_count;

  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select distinct on (problem_id) * from (
    select
      'late:' || (e.elem->>'chat_id') as problem_id,
      'ai' as source,
      coalesce(nullif(btrim(e.elem->>'client_name'), ''), nullif(btrim(e.elem->>'chat_name'), '')) as client_name,
      null::text as contract_id,
      nullif(btrim(e.elem->>'chat_name'), '') as chat_name,
      'https://web.telegram.org/a/#' || (e.elem->>'chat_id') as chat_link,
      re.full_name as accountant_name, re.id::text as accountant_id,
      2 as priority,
      'Поздний ответ клиенту' as problem_title,
      nullif(btrim(e.elem->>'oldest_pending_text'), '') as problem_description,
      nullif(btrim(e.elem->>'flag_reason'), '') as ai_comment,
      nullif(e.elem->>'request_time', '')::timestamptz as detected_at,
      'waiting_for_accountant' as status
    from jsonb_array_elements(coalesce((public.qa_answered_late_chats(win, 2))::jsonb, '[]'::jsonb)) as e(elem)
    left join lateral public.kk_resolve_employee(e.elem->>'responder_name') re on true
  ) rows
  where not exists (
    select 1 from public.kk_latest_rating lr
    where lr.problem_id = rows.problem_id and lr.is_problematic = false
      and coalesce(lr.problem_detected_at, 'infinity'::timestamptz) >= coalesce(rows.detected_at, '-infinity'::timestamptz)
  )
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics late_count = row_count;

  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select distinct on (problem_id) * from (
    select
      'promise:' || (e.elem->>'chat_id') as problem_id,
      'ai' as source,
      nullif(btrim(e.elem->>'chat_name'), '') as client_name,
      null::text as contract_id,
      nullif(btrim(e.elem->>'chat_name'), '') as chat_name,
      'https://web.telegram.org/a/#' || (e.elem->>'chat_id') as chat_link,
      null::text as accountant_name, null::text as accountant_id,
      2 as priority,
      'Невыполненное обещание (не отправлено)' as problem_title,
      nullif(btrim(e.elem->>'promise_text'), '') as problem_description,
      nullif(btrim(e.elem->>'flag_reason'), '') as ai_comment,
      nullif(e.elem->>'promise_time', '')::timestamptz as detected_at,
      'waiting_for_accountant' as status
    from jsonb_array_elements(coalesce((public.qa_overdue_promises(win))::jsonb, '[]'::jsonb)) as e(elem)
  ) rows
  where not exists (
    select 1 from public.kk_latest_rating lr
    where lr.problem_id = rows.problem_id and lr.is_problematic = false
      and coalesce(lr.problem_detected_at, 'infinity'::timestamptz) >= coalesce(rows.detected_at, '-infinity'::timestamptz)
  )
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    priority=excluded.priority, problem_title=excluded.problem_title,
    problem_description=excluded.problem_description, ai_comment=excluded.ai_comment,
    detected_at=excluded.detected_at, updated_at=now();
  get diagnostics promise_count = row_count;

  return jsonb_build_object(
    'sona', sona_count, 'margarita', margarita_count,
    'unanswered', unanswered_count, 'late', late_count, 'promise', promise_count,
    'ran_at', now()
  );
end;
$$;
