-- 0026 — Penalties/fines on QA tickets, Margarita's real work-volume feed, and
--        the richer system-task states.
--
-- Builds on the accountant reaction loop (0025). Three additions:
--
-- 1. Penalty / fine lifecycle on a QA ticket (kk_problems). Margarita's
--    `mqa_violations` already carries a `sanction` amount; carry it onto the
--    matching kk_problems row as `penalty_amount`. When an appeal is APPROVED
--    the issue is dismissed AND its fine is cancelled (`penalty_cancelled`);
--    when it is rejected the fine stays active (req 4/5). `penalty_cancelled`
--    is never un-set by re-ingestion — only the amount is refreshed.
--
-- 2. `kk_margarita_checks` — a read-only projection of `mqa_evaluations` (the
--    per-chat monthly scorecards, ~5 900 rows), the true record of how many
--    chats Margarita actually checked. Exposed like kk_chat_directory /
--    kk_chat_mailings (definer-rights view, anon/authenticated SELECT) so the
--    «Объём работы Маргариты» report can count checked chats by day and by
--    accountant. The accountant short-name is resolved to a real employee via
--    kk_accountant_aliases so per-accountant figures line up with kk_problems.
--
-- 3. System-task tracker (kk_tasks) gains a `priority` and a postponed due date
--    plus the `postponed` / `cancelled` states, so QA-driven follow-ups can be
--    tracked through their full lifecycle (req 6). The legacy `open` / `done`
--    values are kept (open = new, done = completed) so existing rows and the
--    `done` flag keep working.

begin;

-- ---------------------------------------------------------------------------
-- 1. Penalties on QA tickets.
-- ---------------------------------------------------------------------------
alter table public.kk_problems
  add column if not exists penalty_amount      numeric,
  add column if not exists penalty_cancelled   boolean not null default false,
  add column if not exists penalty_cancelled_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. System-task fields + states.
-- ---------------------------------------------------------------------------
alter table public.kk_tasks
  add column if not exists priority           integer not null default 2,
  add column if not exists due_date_postponed date;

alter table public.kk_tasks drop constraint if exists kk_tasks_status_check;
alter table public.kk_tasks
  add constraint kk_tasks_status_check
    check (status in ('open', 'in_progress', 'postponed', 'done', 'cancelled'));

-- ---------------------------------------------------------------------------
-- 3. Re-create kk_ingest_problems() = 0022 body, with the Margarita violation
--    block now carrying the sanction amount into penalty_amount. Everything
--    else is byte-for-byte the deployed 0022 function.
-- ---------------------------------------------------------------------------
create or replace function public.kk_ingest_problems()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sona_count       integer := 0;
  sona_problem_cnt integer := 0;
  margarita_count  integer := 0;
  marg_eval_count  integer := 0;
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
    coalesce(nullif(btrim(t.title), ''), nullif(btrim(t.type), ''), 'Проблема по проверке качества'),
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

  -- ---- Sona review problems that never got a ticket (0021) ------------------
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'sona_review:' || r.id, 'sona_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    r.company_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when coalesce(r.ticket_urgent, false) or r.ticket_priority = 'critical' then 1
         when r.ticket_priority = 'medium' then 2 else 2 end,
    'Проблема по проверке качества',
    nullif(btrim(r.comment), ''),
    null, coalesce(r.created_at, r.checking_date::timestamptz, now()), 'waiting_for_accountant'
  from public.sqa_reviews r
  left join public.mqa_chats c on c.agr_no = r.company_agr_no
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(coalesce(nullif(btrim(r.accountant), ''), nullif(btrim(c.accountant), '')))
  where r.record_type = 'problem'
    and not exists (select 1 from public.sqa_tickets t where t.review_id = r.id)
  on conflict (problem_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    priority=excluded.priority, problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    detected_at=excluded.detected_at, updated_at=now();
  get diagnostics sona_problem_cnt = row_count;

  -- ---- Margarita violations — now carry the sanction as penalty_amount ------
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status, penalty_amount
  )
  select
    'margarita:' || v.id, 'margarita_review',
    coalesce(nullif(btrim(v.client), ''), nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    v.chat_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when v.severity in ('Критичное', 'Грубое') then 1 when v.severity = 'Среднее' then 2 else 2 end,
    coalesce(nullif(btrim(v.violation_type), ''), 'Нарушение (Маргарита)'),
    coalesce(nullif(btrim(v.note), ''), nullif(btrim(v.violation_type), '')),
    null, coalesce(v.created_at, v.vdate::timestamptz, now()), 'waiting_for_accountant',
    nullif(v.sanction, 0)
  from public.mqa_violations v
  left join public.mqa_chats c on c.agr_no = v.chat_agr_no
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(coalesce(nullif(btrim(v.accountant), ''), nullif(btrim(c.accountant), '')))
  on conflict (problem_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    priority=excluded.priority, problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    detected_at=excluded.detected_at, penalty_amount=excluded.penalty_amount, updated_at=now();
    -- penalty_cancelled is intentionally NOT reset here — an approved appeal's
    -- cancellation survives re-ingestion.
  get diagnostics margarita_count = row_count;

  -- ---- Margarita chat-quality evaluations rated «Критично» / «Плохо» (0021) --
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'margarita_eval:' || e.id, 'margarita_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    e.chat_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when e.quality_band = 'Критично' then 1 else 2 end,
    case when e.quality_band = 'Критично'
         then 'Критичная оценка качества сервиса'
         else 'Низкая оценка качества сервиса' end,
    concat_ws('. ',
      nullif(btrim(e.comment), ''),
      'Оценка качества обслуживания: ' || coalesce(e.total_score::text, '—')
        || '/100 («' || e.quality_band || '»), период '
        || coalesce(nullif(btrim(e.period), ''), '—'),
      case when nullif(e.scores->'criteria'->>'sla', '') is not null
           then 'SLA: ' || (e.scores->'criteria'->>'sla') || '/5' end,
      case when nullif(e.scores->'criteria'->>'accuracy', '') is not null
           then 'Точность: ' || (e.scores->'criteria'->>'accuracy') || '/5' end
    ),
    null, coalesce(e.created_at, e.checking_date::timestamptz, now()), 'waiting_for_accountant'
  from public.mqa_evaluations e
  left join public.mqa_chats c on c.agr_no = e.chat_agr_no
  join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(e.accountant)
  where e.quality_band in ('Критично', 'Плохо')
    and coalesce(e.role, 'accountant') = 'accountant'
    and not exists (
      select 1 from public.mqa_violations v
      where v.chat_agr_no = e.chat_agr_no
        and public.kk_norm_name(v.accountant) = public.kk_norm_name(e.accountant)
        and abs(extract(epoch from (
              coalesce(v.created_at, v.vdate::timestamptz)
              - coalesce(e.created_at, e.checking_date::timestamptz)
            ))) <= 86400 * 3
    )
  on conflict (problem_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    priority=excluded.priority, problem_title=excluded.problem_title, problem_description=excluded.problem_description,
    detected_at=excluded.detected_at, updated_at=now();
  get diagnostics marg_eval_count = row_count;

  return jsonb_build_object(
    'sona', sona_count, 'sona_problem', sona_problem_cnt,
    'margarita', margarita_count, 'margarita_eval', marg_eval_count,
    'ran_at', now()
  );
end;
$$;

-- Backfill penalty_amount for existing Margarita-violation tickets. (Today all
-- sanctions are 0, so this is a no-op; it keeps history correct if fines land
-- before the next ingestion run.)
update public.kk_problems p
set    penalty_amount = nullif(v.sanction, 0)
from   public.mqa_violations v
where  p.problem_id = 'margarita:' || v.id
  and  coalesce(p.penalty_cancelled, false) = false
  and  p.penalty_amount is distinct from nullif(v.sanction, 0);

-- ---------------------------------------------------------------------------
-- 4. Margarita's checked-chats feed (read-only projection of mqa_evaluations).
-- ---------------------------------------------------------------------------
create or replace view public.kk_margarita_checks as
select
  e.id,
  e.chat_agr_no,
  e.checking_date,
  e.quality_band,
  al.full_name          as accountant_name,
  al.employee_id::text  as accountant_id
from public.mqa_evaluations e
left join public.kk_accountant_aliases al
  on al.alias_norm = public.kk_norm_name(e.accountant)
where coalesce(e.role, 'accountant') = 'accountant';

comment on view public.kk_margarita_checks is
  'Read-only projection of Margarita mqa_evaluations (per-chat scorecards): one row per checked chat/period with the resolved accountant. Source for «Объём работы Маргариты» (chats checked, by day/accountant).';

grant select on public.kk_margarita_checks to anon, authenticated;

commit;

-- Refresh so new penalty_amount values land on existing rows.
select public.kk_ingest_problems();
