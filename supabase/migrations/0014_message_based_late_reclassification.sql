-- Make the «Без ответа» → «Поздний ответ» classification correct and durable.
--
-- Reported (owner, 2026-06-26): the queue shows almost only «Без ответа
-- клиенту»; «Поздний ответ клиенту» barely appears, and chats that WERE answered
-- (just late) are shown as «Без ответа».
--
-- Root cause. A chat is first flagged «Без ответа» the moment a client question
-- sits unanswered past the SLA. When the accountant later answers LATE, two
-- things were supposed to happen but didn't:
--   * qa_answered_late_chats was supposed to report the chat so 0010 could
--     reclassify the «Без ответа» row to «Поздний ответ» — but that RPC only
--     considers replies from the last 24h AND skips "active back-and-forth"
--     follow-ups (the recent-engagement guard), which is exactly the shape of
--     these chats. So the `late:<chat>` counterpart was usually never created.
--   * With no `late:` counterpart, the reclassification (0010) never fired, and
--     on the next run the auto-resolve step (0012) — seeing the chat dropped from
--     qa_unanswered_chats because staff DID eventually reply — silently retired
--     the row as `auto_resolved`. The late answer disappeared entirely.
-- Measured on live data: of the open+auto_resolved «Без ответа» rows inside the
-- 120h window, 42 had in fact been answered LATE (e.g. N-3545's neighbour chat
-- -5258193111: client asked 08:47, real staff answer 13:59 — 5.2 business hours,
-- yet auto_resolved as «Без ответа»). Only the genuinely-unanswered ones should
-- stay «Без ответа».
--
-- Fix. Reclassify from the MESSAGES, not from the transient `late:` row:
--   1. kk_first_substantive_staff_reply_after() — the earliest real (substantive,
--      non-promise) reply from a recognised employee after a given moment, using
--      the SAME staff-recognition rules as qa_unanswered_chats' suppression
--      (including the 0013 inactive-employee fix: a former employee's reply still
--      counts). Bare acknowledgements / @mentions (qa_is_substantive_staff_text =
--      false) do NOT count as the answer, matching how the SLA timer is computed.
--   2. The reclassification step now relabels an «Без ответа» row to «Поздний
--      ответ» whenever that chat's flagged question (detected_at) eventually got a
--      substantive staff reply MORE than 2 business hours later — regardless of
--      when it happened or whether the live late RPC noticed. It also re-stamps
--      already-late rows every run so the auto-resolve step keeps them alive
--      (a late answer is a real problem to surface, not something to retire).
--      Runs BEFORE auto-resolve, so a late answer is relabelled instead of lost.
--   3. The `late:` RPC ingestion is kept (it still covers chats never flagged
--      unanswered) but de-duplicated: it skips a chat that already has an open
--      `unanswered:<chat>` row (which is the attributed, now-relabelled one). Any
--      now-redundant open `late:` row is left unrefreshed and the existing
--      auto-resolve step retires it on this same run.
-- Finally, a one-time backfill resurrects the already-lost late answers inside the
-- window (auto_resolved «Без ответа» that were really answered late) as open
-- «Поздний ответ» so they show immediately.
--
-- Display needs no change: Dashboard already counts «Поздний ответ» by title and
-- excludes auto_resolved; this migration only corrects the underlying data.

-- 1. Helper: earliest substantive staff reply in a chat after a given moment.
create or replace function public.kk_first_substantive_staff_reply_after(
    p_chat_id bigint,
    p_after   timestamptz
)
returns timestamptz
language sql
stable
as $$
  with known_ids as (
    -- No is_active filter (mirrors 0013): a former employee's reply still answers.
    select telegram_id as tid from public.employees where telegram_id is not null
    union
    select telegram_user_id from public.employees where telegram_user_id is not null
  ),
  known_unames as (
    select lower(replace(coalesce(telegram_username,''),'@','')) as uname
    from public.employees
    where is_active = true and nullif(trim(telegram_username),'') is not null
  ),
  known_names as (
    select lower(trim(full_name)) as ename from public.employees
    where is_active = true and nullif(trim(full_name),'') is not null
    union select lower(trim(split_part(full_name,' ',1))) from public.employees
    where is_active = true and length(trim(split_part(full_name,' ',1))) > 2
    union select lower(trim(alias)) from public.employees,
          unnest(coalesce(display_aliases, array[]::text[])) as alias
    where is_active = true and length(trim(alias)) > 2
  )
  select min(m.created_at)
  from public.messages m
  where m.chat_id = p_chat_id
    and m.created_at > p_after
    and public.qa_is_substantive_staff_text(m.text)
    and not public.qa_is_employee_promise(coalesce(m.text, ''))
    and (
      public.qa_is_staff_role(m.sender_role)
      or (m.sender_id is not null and m.sender_id in (select tid from known_ids))
      or (nullif(trim(lower(coalesce(m.raw_payload->'from_user'->>'username',''))), '') is not null
          and lower(m.raw_payload->'from_user'->>'username') in (select uname from known_unames))
      or (m.sender_name is not null and length(trim(m.sender_name)) > 2
          and (m.sender_name ilike '%Accounting%'
            or m.sender_name ilike '%OneBusiness%'
            or m.sender_name ilike '%ВанБизнес%'
            or m.sender_name ilike '%бухгалтер%'
            or m.sender_name ilike '%менеджер%'
            or lower(trim(m.sender_name)) in (select ename from known_names)))
    )
$$;

-- 2. Recreate ingestion: live 0012 body + de-duplicated late insert + message-based
--    reclassification (everything else byte-for-byte the same).
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
  reclassified     integer := 0;
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

  -- ---- Live: unanswered chats («Без ответа») — one row per responsible accountant
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select distinct on (problem_id) * from (
    select
      'unanswered:' || (e.elem->>'chat_id') || coalesce(':' || re.id::text, '') as problem_id,
      'ai' as source,
      nullif(btrim(e.elem->>'chat_name'), '') as client_name,
      null::text as contract_id,
      nullif(btrim(e.elem->>'chat_name'), '') as chat_name,
      'https://web.telegram.org/a/#' || (e.elem->>'chat_id') as chat_link,
      re.full_name as accountant_name,
      re.id::text as accountant_id,
      case when e.elem->>'severity' = 'critical' then 1 when e.elem->>'severity' = 'minor' then 3 else 2 end as priority,
      'Без ответа клиенту' as problem_title,
      nullif(btrim(e.elem->>'problematic_client_message'), '') as problem_description,
      nullif(btrim(e.elem->>'flag_reason'), '') as ai_comment,
      nullif(e.elem->>'oldest_pending_at', '')::timestamptz as detected_at,
      'waiting_for_accountant' as status
    from jsonb_array_elements(
           coalesce((public.qa_unanswered_chats(win, 2))::jsonb, '[]'::jsonb)
         ) as e(elem)
    cross join lateral unnest(
      case when nullif(btrim(e.elem->>'accountant_names'), '') is null
        then array[null::text]
        else string_to_array(e.elem->>'accountant_names', ',')
      end
    ) as an(name)
    left join lateral public.kk_resolve_employee(an.name) re on true
  ) rows
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics unanswered_count = row_count;

  -- ---- Live: late answers («Поздний ответ») --------------------------------
  -- De-dup: skip a chat that already has an OPEN unanswered:<chat> row — that row
  -- is the attributed one and the reclassification step below relabels it to
  -- «Поздний ответ». Any now-redundant open late:<chat> row is left unrefreshed
  -- and retired by the auto-resolve step at the end of this same run.
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
      re.full_name as accountant_name,
      re.id::text as accountant_id,
      2 as priority,
      'Поздний ответ клиенту' as problem_title,
      nullif(btrim(e.elem->>'oldest_pending_text'), '') as problem_description,
      nullif(btrim(e.elem->>'flag_reason'), '') as ai_comment,
      nullif(e.elem->>'request_time', '')::timestamptz as detected_at,
      'waiting_for_accountant' as status
    from jsonb_array_elements(
           coalesce((public.qa_answered_late_chats(win, 2))::jsonb, '[]'::jsonb)
         ) as e(elem)
    left join lateral public.kk_resolve_employee(e.elem->>'responder_name') re on true
    where not exists (
      select 1 from public.kk_problems u
      where split_part(u.problem_id, ':', 2) = (e.elem->>'chat_id')
        and u.problem_id like 'unanswered:%'
        and u.status in ('new','waiting_for_accountant','submitted_by_accountant',
                         'in_review','returned_to_accountant')
    )
  ) rows
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id, priority=excluded.priority,
    problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    ai_comment=excluded.ai_comment, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics late_count = row_count;

  -- ---- Reclassify «Без ответа» → «Поздний ответ» from the messages -----------
  -- An open unanswered:<chat> row whose flagged question (detected_at) eventually
  -- received a substantive staff reply MORE than 2 business hours later was in
  -- fact answered late, not left unanswered. Relabel it (and re-stamp already-late
  -- rows) so the auto-resolve step below keeps it alive instead of retiring it.
  -- Independent of the live late RPC, so it can never be missed or lost.
  update public.kk_problems p
  set    problem_title = 'Поздний ответ клиенту',
         updated_at    = now()
  where  p.source = 'ai'
    and  p.problem_id like 'unanswered:%'
    and  p.problem_title in ('Без ответа клиенту', 'Поздний ответ клиенту')
    and  p.status not in ('fixed', 'explained_accepted', 'auto_resolved')
    and  p.detected_at >= win
    and  public.qa_business_hours_elapsed(
           p.detected_at,
           public.kk_first_substantive_staff_reply_after(
             split_part(p.problem_id, ':', 2)::bigint, p.detected_at)
         ) > 2;
  get diagnostics reclassified = row_count;

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
      null::text as accountant_name,
      null::text as accountant_id,
      2 as priority,
      'Невыполненное обещание (не отправлено)' as problem_title,
      nullif(btrim(e.elem->>'promise_text'), '') as problem_description,
      nullif(btrim(e.elem->>'flag_reason'), '') as ai_comment,
      nullif(e.elem->>'promise_time', '')::timestamptz as detected_at,
      'waiting_for_accountant' as status
    from jsonb_array_elements(
           coalesce((public.qa_overdue_promises(win))::jsonb, '[]'::jsonb)
         ) as e(elem)
  ) rows
  on conflict (problem_id) do update set
    client_name=excluded.client_name, chat_name=excluded.chat_name, chat_link=excluded.chat_link,
    priority=excluded.priority, problem_title=excluded.problem_title,
    problem_description=excluded.problem_description, ai_comment=excluded.ai_comment,
    detected_at=excluded.detected_at, updated_at=now();
  get diagnostics promise_count = row_count;

  -- ---- Retire live detections the QA layer no longer reports ----------------
  -- Rows the reclassification above kept (late answers) were stamped updated_at =
  -- now(), so they survive. Only genuinely-gone detections (answered on time, no
  -- substantive answer, or promise sent) are retired.
  update public.kk_problems p
  set status = 'auto_resolved'
  where p.source = 'ai'
    and split_part(p.problem_id, ':', 1) in ('unanswered', 'review', 'late', 'promise')
    and p.status in ('new', 'waiting_for_accountant')
    and p.detected_at >= win
    and coalesce(p.verdict, '') <> 'not_problematic'
    and p.updated_at < now();
  get diagnostics retired_count = row_count;

  return jsonb_build_object(
    'sona', sona_count, 'margarita', margarita_count,
    'unanswered', unanswered_count, 'late', late_count, 'promise', promise_count,
    'reclassified', reclassified, 'retired', retired_count,
    'ran_at', now()
  );
end;
$$;

-- 3. One-time backfill: recover late answers already lost to auto_resolve.
-- Any auto_resolved «Без ответа» row inside the window whose flagged question got
-- a substantive staff reply > 2 business hours later was really a late answer that
-- was silently retired. Resurrect it as an open «Поздний ответ». auto_resolved is
-- a system status (never an accountant/reviewer action), so reopening is safe; we
-- still skip reviewer-judged false positives (verdict = 'not_problematic').
update public.kk_problems p
set    problem_title = 'Поздний ответ клиенту',
       status        = 'waiting_for_accountant',
       updated_at    = now()
where  p.source = 'ai'
  and  p.problem_id like 'unanswered:%'
  and  p.problem_title = 'Без ответа клиенту'
  and  p.status = 'auto_resolved'
  and  p.detected_at >= now() - interval '120 hours'
  and  coalesce(p.verdict, '') <> 'not_problematic'
  and  public.qa_business_hours_elapsed(
         p.detected_at,
         public.kk_first_substantive_staff_reply_after(
           split_part(p.problem_id, ':', 2)::bigint, p.detected_at)
       ) > 2;

-- 4. Re-run so the new logic stabilises (relabels open late answers, de-dups
--    redundant late: rows, retires the rest).
select public.kk_ingest_problems();
