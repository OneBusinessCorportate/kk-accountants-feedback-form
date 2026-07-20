-- 0030 — Sona work-report data + positive feedback («похвала»)
--
-- Task «[КК бух.услуг] форма для Соны, отчёт по КК и уведомление в Telegram»:
--   * ОТЧЁТ ПО РАБОТЕ СОНЫ — like «Объём работы Маргариты», we need the true
--     record of how many companies Sona checked, with what score/record type, by
--     day and by accountant. Her reviews live in `sqa_reviews` (repo #1). Expose a
--     read-only projection `kk_sona_checks` (same pattern as kk_margarita_checks /
--     kk_chat_directory: definer-rights view, anon/authenticated SELECT), with the
--     accountant short-name resolved to a real employee via kk_accountant_aliases.
--   * «ПОХВАЛА» / позитив — the owner's rule: «Если позитивно всё, то может быть
--     не тикет … проблема или похвала». Problems already flow into kk_problems;
--     the POSITIVE signal was thrown away. This migration is ADDITIVE and never
--     touches kk_ingest_problems(): a separate table `kk_praise` + a standalone
--     `kk_ingest_praise()` collect the positive results so they can be counted per
--     accountant / department without polluting the problem queues or counts:
--       - mqa_evaluations rated «Хорошо» / «Отлично» (role accountant, resolves to
--         a real employee) → margarita_eval_ok:<id>, source margarita_review;
--       - sqa_reviews with record_type='other' (a check that raised NO problem →
--         a clean, positive result) → sona_ok:<id>, source sona_review.
--     Both keyed by a stable praise_id → idempotent upsert, safe to re-run.
--
-- Reversible: drop view kk_sona_checks; drop function kk_ingest_praise();
-- drop table kk_praise. Nothing here alters existing objects.

begin;

-- ---------------------------------------------------------------------------
-- 1. Sona's per-review projection (the Sona work-report source).
-- ---------------------------------------------------------------------------
create or replace view public.kk_sona_checks as
select
  r.id,
  r.company_agr_no       as chat_agr_no,
  r.checking_date,
  r.period,
  r.record_type,
  r.score_accountant,
  r.risk_level,
  r.report_type,
  r.efficiency_pct,
  al.full_name           as accountant_name,
  al.employee_id::text   as accountant_id
from public.sqa_reviews r
left join public.mqa_chats c on c.agr_no = r.company_agr_no
left join public.kk_accountant_aliases al
  on al.alias_norm = public.kk_norm_name(
       coalesce(nullif(btrim(r.accountant), ''), nullif(btrim(c.accountant), '')));

comment on view public.kk_sona_checks is
  'Read-only projection of Sona QA reviews (sqa_reviews): one row per checked company/period with the resolved accountant. Powers the Sona work report («Объём работы Соны»).';

grant select on public.kk_sona_checks to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Positive feedback / praise («похвала»).
-- ---------------------------------------------------------------------------
create table if not exists public.kk_praise (
  praise_id       text primary key,
  source          text not null,            -- margarita_review | sona_review
  client_name     text,
  contract_id     text,
  chat_name       text,
  chat_link       text,
  accountant_name text,
  accountant_id   text,
  title           text,
  detail          text,
  band            text,                      -- Хорошо / Отлично / Без замечаний
  score           numeric,
  period          text,
  detected_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.kk_praise is
  'Positive QA results («похвала»): good Margarita evaluations + clean Sona reviews. Additive to kk_problems — never a ticket, only counted in reports.';

alter table public.kk_praise enable row level security;
drop policy if exists kk_praise_anon_select on public.kk_praise;
create policy kk_praise_anon_select on public.kk_praise
  for select to anon, authenticated using (true);
grant select on public.kk_praise to anon, authenticated;

create index if not exists kk_praise_accountant_idx on public.kk_praise (accountant_id);
create index if not exists kk_praise_detected_idx  on public.kk_praise (detected_at);

-- ---------------------------------------------------------------------------
-- 3. Ingest positive signals. Standalone + idempotent; NEVER modifies
--    kk_ingest_problems(). Only rows attributable to a real employee are kept
--    (praise is intrinsically about one accountant's work).
-- ---------------------------------------------------------------------------
create or replace function public.kk_ingest_praise()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  marg_ok integer := 0;
  sona_ok integer := 0;
begin
  -- Margarita positive evaluations (Хорошо / Отлично).
  insert into public.kk_praise (
    praise_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, title, detail, band, score, period, detected_at)
  select
    'margarita_eval_ok:' || e.id, 'margarita_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    e.chat_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    case when e.quality_band = 'Отлично'
         then 'Отличная оценка качества сервиса'
         else 'Хорошая оценка качества сервиса' end,
    concat_ws('. ',
      nullif(btrim(e.comment), ''),
      'Оценка качества обслуживания: ' || coalesce(e.total_score::text, '—')
        || '/100 («' || e.quality_band || '»), период '
        || coalesce(nullif(btrim(e.period), ''), '—')),
    e.quality_band, e.total_score, e.period,
    coalesce(e.created_at, e.checking_date::timestamptz, now())
  from public.mqa_evaluations e
  left join public.mqa_chats c on c.agr_no = e.chat_agr_no
  join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(e.accountant)
  where e.quality_band in ('Хорошо', 'Отлично')
    and coalesce(e.role, 'accountant') = 'accountant'
  on conflict (praise_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    title=excluded.title, detail=excluded.detail, band=excluded.band, score=excluded.score,
    period=excluded.period, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics marg_ok = row_count;

  -- Sona reviews that raised NO problem (record_type = 'other') → a clean check.
  insert into public.kk_praise (
    praise_id, source, client_name, contract_id, chat_name, chat_link,
    accountant_name, accountant_id, title, detail, band, score, period, detected_at)
  select
    'sona_ok:' || r.id, 'sona_review',
    coalesce(nullif(btrim(c.name_agr), ''), nullif(btrim(c.chat_name), '')),
    r.company_agr_no, nullif(btrim(c.chat_name), ''), nullif(btrim(c.chat_link), ''),
    al.full_name, al.employee_id::text,
    'Проверка без замечаний',
    concat_ws('. ',
      nullif(btrim(r.comment), ''),
      nullif(btrim(r.praise), ''),
      case when r.score_accountant is not null
           then 'Оценка бухгалтера: ' || r.score_accountant::text end),
    'Без замечаний', r.score_accountant, r.period,
    coalesce(r.created_at, r.checking_date::timestamptz, now())
  from public.sqa_reviews r
  left join public.mqa_chats c on c.agr_no = r.company_agr_no
  join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(
         coalesce(nullif(btrim(r.accountant), ''), nullif(btrim(c.accountant), '')))
  where r.record_type = 'other'
  on conflict (praise_id) do update set
    client_name=excluded.client_name, contract_id=excluded.contract_id, chat_name=excluded.chat_name,
    chat_link=excluded.chat_link, accountant_name=excluded.accountant_name, accountant_id=excluded.accountant_id,
    title=excluded.title, detail=excluded.detail, band=excluded.band, score=excluded.score,
    period=excluded.period, detected_at=excluded.detected_at, updated_at=now();
  get diagnostics sona_ok = row_count;

  return jsonb_build_object('margarita_ok', marg_ok, 'sona_ok', sona_ok, 'ran_at', now());
end;
$$;

-- Keep praise fresh alongside the problem ingestion (pg_cron already enabled).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'kk_ingest_praise') then
      perform cron.unschedule('kk_ingest_praise');
    end if;
    perform cron.schedule('kk_ingest_praise', '*/30 * * * *',
      $cron$select public.kk_ingest_praise();$cron$);
  end if;
end $$;

select public.kk_ingest_praise();

commit;
