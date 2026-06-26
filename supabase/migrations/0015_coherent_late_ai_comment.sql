-- Make a reclassified «Поздний ответ» row fully self-consistent.
--
-- 0014 relabels an `unanswered:` row's TITLE to «Поздний ответ» when the chat was
-- answered late, but left two stale fields that made the QA page contradict
-- itself (reported by the head accountant on the «QA Точность» screen):
--   * ai_comment still held the unanswered flag `no_staff_reply_after_client_question`
--     while the title said «Поздний ответ» — shown verbatim as «ИИ: …».
--   * the AI-subtype chip / accuracy split were derived from the problem_id PREFIX
--     (`unanswered:`) → «Без ответа», also contradicting the title. (That half is
--     fixed in the frontend: qaKind() now classifies by title.)
-- This migration fixes the data half: when reclassifying, also stamp the late
-- flag `answered_but_after_sla` (the same token qa_answered_late_chats emits), so
-- every «Поздний ответ» row — whether born from the late RPC or reclassified —
-- carries the same coherent reason.
--
-- Also tightened: the reclassification now skips rows a reviewer judged a false
-- positive (verdict = 'not_problematic'), consistent with the auto-resolve step
-- and the 0014 backfill — we don't relabel something the verdict loop has retired.
--
-- Only the reclassification block of kk_ingest_problems() changes; the rest is
-- reproduced verbatim from 0014.

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

  -- ---- Live: late answers («Поздний ответ») — skip chats with an open unanswered: row
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
  -- Relabel an open unanswered:<chat> row whose flagged question got a substantive
  -- staff reply MORE than 2 business hours later, and stamp the coherent late flag
  -- so title, chip and «ИИ:» note all agree. Skips reviewer-judged false positives.
  update public.kk_problems p
  set    problem_title = 'Поздний ответ клиенту',
         ai_comment    = 'answered_but_after_sla',
         updated_at    = now()
  where  p.source = 'ai'
    and  p.problem_id like 'unanswered:%'
    and  p.problem_title in ('Без ответа клиенту', 'Поздний ответ клиенту')
    and  p.status not in ('fixed', 'explained_accepted', 'auto_resolved')
    and  coalesce(p.verdict, '') <> 'not_problematic'
    and  p.detected_at >= win
    and  public.qa_business_hours_elapsed(
           p.detected_at,
           public.kk_first_substantive_staff_reply_after(
             split_part(p.problem_id, ':', 2)::bigint, p.detected_at)
         ) > 2;
  get diagnostics reclassified = row_count;

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

-- One-time backfill: align ai_comment on rows already reclassified to «Поздний
-- ответ» by 0014 (they still carry the old unanswered flag).
update public.kk_problems
set    ai_comment = 'answered_but_after_sla',
       updated_at = updated_at      -- keep updated_at; this is a display-only fix
where  source = 'ai'
  and  problem_id like 'unanswered:%'
  and  problem_title = 'Поздний ответ клиенту'
  and  coalesce(ai_comment, '') <> 'answered_but_after_sla';

select public.kk_ingest_problems();
