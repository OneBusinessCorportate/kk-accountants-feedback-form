-- Auto-resolve stale LIVE QA problems whose detection the QA layer has stopped
-- reporting (i.e. the chat was answered after we flagged it).
--
-- Problem observed: kk_ingest_problems() was insert/update-only. A chat flagged
-- «Без ответа клиенту» the moment a client message looked unanswered stayed in
-- the accountant's queue FOREVER — even after staff replied minutes later and
-- qa_unanswered_chats stopped returning it. Example: B-3983 «Հայկ Կառույց ՍՊԸ»
-- (chat -4930687158) was flagged at 15:18, answered by ~18:00, yet still showed
-- as an open «Без ответа» pinned on two accountants days later. The same applies
-- to «Поздний ответ», «Невыполненное обещание» and the soft review items: once
-- the live detector drops a chat, the kk_problems row must retire too.
--
-- Fix: after re-ingesting the four live detections, mark as `auto_resolved` any
-- still-open AI problem (unanswered / review / late / promise) that this run did
-- NOT refresh but is recent enough that the detector WOULD still report it if it
-- were a live problem (detected_at within the 120h detection window). Because
-- every currently-detected row is upserted first (bumping updated_at to the
-- transaction's now()), the ones left untouched are exactly the resolved ones.
--
-- Scope: only the AI live sources, only un-acted statuses (we never disturb an
-- accountant's in-progress submission or a reviewer's verdict), and we keep the
-- row (a new terminal status, not a delete) so QA-accuracy history is preserved.
-- The qa_* RPCs are NOT modified. Sona/Margarita reviews are untouched.

-- 1. Allow the new terminal status.
alter table public.kk_problems drop constraint if exists kk_problems_status_check;
alter table public.kk_problems add constraint kk_problems_status_check
  check (status in (
    'new','waiting_for_accountant','submitted_by_accountant',
    'in_review','fixed','explained_accepted','returned_to_accountant',
    'auto_resolved'
  ));

-- 2. Recreate ingestion with the retire step (otherwise identical to 0006).
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
  retired_count    integer := 0;
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

  -- ---- Retire live detections the QA layer no longer reports ----------------
  -- Every still-live detection above was upserted first, so its updated_at now
  -- equals this transaction's now(). Any open AI problem whose detected_at is
  -- still inside the 120h window (so the detector WOULD re-report it if real)
  -- but was NOT refreshed this run is one the detector has dropped — the chat
  -- got answered / the promise was sent. Retire it so it leaves the queues and
  -- dashboard counts. We never touch rows an accountant/reviewer has acted on,
  -- nor reviewer-judged false positives (those are handled by the verdict loop).
  update public.kk_problems p
  set status = 'auto_resolved'
  where p.source = 'ai'
    and split_part(p.problem_id, ':', 1) in ('unanswered', 'review', 'late', 'promise')
    and p.status in ('new', 'waiting_for_accountant')
    and p.detected_at >= win
    and coalesce(p.verdict, '') <> 'not_problematic'
    and p.updated_at < now();  -- not refreshed by this run => no longer detected
  get diagnostics retired_count = row_count;

  return jsonb_build_object(
    'sona', sona_count, 'margarita', margarita_count,
    'unanswered', unanswered_count, 'late', late_count, 'promise', promise_count,
    'retired', retired_count, 'ran_at', now()
  );
end;
$$;

-- 3. Backfill: run once so already-stale rows (e.g. B-3983) retire immediately.
select public.kk_ingest_problems();
