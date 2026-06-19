-- Problem ingestion: pull detected problems from the two QA systems that share
-- this Supabase project (OB FAQ) into kk_problems.
--
--   Sona      (sona-qa-platform)      sqa_tickets    -> source 'sona_review'
--   Margarita (margarita-qa-platform) mqa_violations -> source 'margarita_review'
--
-- All three systems live in ONE Postgres database, so ingestion is a pure
-- in-database upsert — no cross-project sync, no extra service, no service_role
-- key shipped anywhere. The frontend keeps using only the anon key and is never
-- aware of this.
--
-- Idempotency / safety:
--   * The write is an UPSERT keyed on kk_problems.problem_id.
--   * problem_id is the source's stable primary key, prefixed by source
--     ('sona:<ticket_id>', 'margarita:<violation_id>') — globally unique and
--     stable across re-runs, so re-ingesting never creates duplicates.
--   * ON CONFLICT refreshes only source-owned display columns. It deliberately
--     does NOT touch `status`, so an accountant's / reviewer's progress is
--     preserved, and it never touches kk_accountant_feedback.
--
-- The mapping rules here mirror src/lib/ingestion.js (kept in sync + unit-tested).

create or replace function public.kk_ingest_problems()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sona_count      integer := 0;
  margarita_count integer := 0;
begin
  -- ---- Sona: sqa_tickets ---------------------------------------------------
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'sona:' || t.id,
    'sona_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    t.company_agr_no,
    nullif(btrim(c.chat_name), ''),
    nullif(btrim(c.chat_link), ''),
    coalesce(nullif(btrim(t.accountant), ''), nullif(btrim(c.accountant), '')),
    coalesce(nullif(btrim(t.accountant), ''), nullif(btrim(c.accountant), '')),
    case
      when t.urgent or t.priority = 'critical' then 1
      when t.priority = 'medium' then 2
      else 2
    end,
    coalesce(nullif(btrim(t.title), ''), nullif(btrim(t.type), ''), 'Проблема по проверке (Сона)'),
    coalesce(nullif(btrim(t.description), ''), nullif(btrim(r.comment), '')),
    nullif(btrim(r.comment), ''),
    coalesce(t.created_at, now()),
    'waiting_for_accountant'
  from public.sqa_tickets t
  left join public.sqa_reviews r on r.id = t.review_id
  left join public.mqa_chats   c on c.agr_no = t.company_agr_no
  -- Cancelled tickets are not real problems for the accountant.
  where coalesce(t.status, 'open') <> 'cancelled'
  on conflict (problem_id) do update set
    client_name         = excluded.client_name,
    contract_id         = excluded.contract_id,
    chat_name           = excluded.chat_name,
    chat_link           = excluded.chat_link,
    accountant_name     = excluded.accountant_name,
    accountant_id       = excluded.accountant_id,
    priority            = excluded.priority,
    problem_title       = excluded.problem_title,
    problem_description = excluded.problem_description,
    ai_comment          = excluded.ai_comment,
    detected_at         = excluded.detected_at,
    updated_at          = now();
    -- NOTE: status intentionally NOT updated -> accountant progress preserved.
  get diagnostics sona_count = row_count;

  -- ---- Margarita: mqa_violations -------------------------------------------
  insert into public.kk_problems (
    problem_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, priority, problem_title, problem_description,
    ai_comment, detected_at, status
  )
  select
    'margarita:' || v.id,
    'margarita_review',
    coalesce(nullif(btrim(v.client), ''), nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    v.chat_agr_no,
    nullif(btrim(c.chat_name), ''),
    nullif(btrim(c.chat_link), ''),
    coalesce(nullif(btrim(v.accountant), ''), nullif(btrim(c.accountant), '')),
    coalesce(nullif(btrim(v.accountant), ''), nullif(btrim(c.accountant), '')),
    case
      when v.severity in ('Критичное', 'Грубое') then 1
      when v.severity = 'Среднее' then 2
      else 2
    end,
    coalesce(nullif(btrim(v.violation_type), ''), 'Нарушение (Маргарита)'),
    coalesce(nullif(btrim(v.note), ''), nullif(btrim(v.violation_type), '')),
    null,
    coalesce(v.created_at, v.vdate::timestamptz, now()),
    'waiting_for_accountant'
  from public.mqa_violations v
  left join public.mqa_chats c on c.agr_no = v.chat_agr_no
  on conflict (problem_id) do update set
    client_name         = excluded.client_name,
    contract_id         = excluded.contract_id,
    chat_name           = excluded.chat_name,
    chat_link           = excluded.chat_link,
    accountant_name     = excluded.accountant_name,
    accountant_id       = excluded.accountant_id,
    priority            = excluded.priority,
    problem_title       = excluded.problem_title,
    problem_description = excluded.problem_description,
    detected_at         = excluded.detected_at,
    updated_at          = now();
    -- NOTE: status + ai_comment left untouched on conflict.
  get diagnostics margarita_count = row_count;

  return jsonb_build_object(
    'sona', sona_count,
    'margarita', margarita_count,
    'ran_at', now()
  );
end;
$$;

comment on function public.kk_ingest_problems() is
  'Idempotent upsert of Sona (sqa_tickets) and Margarita (mqa_violations) detected problems into kk_problems. Safe to re-run; never resets status or accountant feedback.';

-- Run it once now so existing problems are backfilled.
select public.kk_ingest_problems();

-- Schedule it every 10 minutes via pg_cron (already enabled on this project).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'kk_ingest_problems') then
    perform cron.unschedule('kk_ingest_problems');
  end if;
  perform cron.schedule(
    'kk_ingest_problems',
    '*/10 * * * *',
    $cron$select public.kk_ingest_problems();$cron$
  );
end;
$$;
