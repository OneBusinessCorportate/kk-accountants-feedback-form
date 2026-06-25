-- Sharpen «Без ответа» attribution so we don't blame an accountant who answered.
--
-- Problem observed: a chat with several accountants was fanned out to EACH of
-- them, and rows the QA layer marks data_incomplete / needs_review (importer
-- likely dropped the staff reply — i.e. someone DID answer) were shown as a hard
-- «Без ответа». Example: Inga answered "да, конечно", but the reply was lost on
-- import, so the chat was flagged and pinned on Inga.
--
-- New rules for qa_unanswered_chats ingestion:
--   * uncertain (data_incomplete OR needs_review) → ONE unassigned soft problem
--     «Возможно без ответа (требует проверки)», low priority. No accountant is
--     blamed (a regular accountant won't even see it — it's unassigned).
--   * confirmed (no_staff_reply_after_client_question):
--       - if the client @mentioned employees → assign ONLY to those (the people
--         actually asked), resolved via employees.normalized_username/telegram_username;
--       - else if accountant_names present → all named accountants (shared);
--       - else unassigned.
-- Late / promise / Sona / Margarita blocks are unchanged.

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
  -- ---- Sona: sqa_tickets ---------------------------------------------------
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

  -- ---- Margarita: mqa_violations -------------------------------------------
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

  -- ---- Live: unanswered chats («Без ответа») --------------------------------
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
  mentioned as (  -- employees the client @mentioned (the ones actually asked)
    select s.chat_id, emp.id as emp_id, emp.full_name as emp_name, 1 as tier
    from src s
    cross join lateral regexp_matches(coalesce(s.msg, ''), '@([A-Za-z0-9_]+)', 'g') as g(m)
    join public.employees emp
      on lower(emp.normalized_username) = lower(g.m[1]) or lower(emp.telegram_username) = lower(g.m[1])
    where not s.uncertain
  ),
  named as (      -- all accountants named on the chat (shared responsibility)
    select s.chat_id, re.id as emp_id, re.full_name as emp_name, 2 as tier
    from src s
    cross join lateral unnest(string_to_array(s.acc_names, ',')) as an(name)
    cross join lateral public.kk_resolve_employee(an.name) re
    where not s.uncertain and nullif(btrim(s.acc_names), '') is not null
  ),
  fallback as (   -- confirmed but nobody to attribute → unassigned
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
    -- confirmed → assigned (mentioned / named / unassigned)
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
    -- uncertain → one unassigned soft review item (nobody blamed)
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
  order by problem_id
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics unanswered_count = row_count;

  -- ---- Live: late answers («Поздний ответ») --------------------------------
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
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics late_count = row_count;

  -- ---- Live: overdue promises («Невыполненное обещание») --------------------
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
