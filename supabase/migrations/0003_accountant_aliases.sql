-- Resolve QA-source accountant names to REAL employees.
--
-- The Sona / Margarita sources record the accountant only by a short, localized
-- NAME (e.g. the Armenian first name "Օլյա"), which does not match the canonical
-- employees.full_name ("Olya Accounting"). Per-accountant scoping in the app
-- keys off the employee identity, so an unmapped name means the right accountant
-- never sees their problem (and the dashboard counts come up empty for them).
--
-- This migration adds a name → employee alias table and rewrites
-- kk_ingest_problems() to store the resolved employee uuid (accountant_id) and
-- canonical full_name (accountant_name). A source name with NO matching employee
-- resolves to NULL on both fields — we never attribute a problem to an invented
-- person. Mirror of src/lib/ingestion.js (kept in sync + unit-tested).

-- Name normalization shared by the alias seed and the lookup: trim, lowercase,
-- collapse internal whitespace. Matches normalizeAccountant() in ingestion.js.
create or replace function public.kk_norm_name(p text)
returns text
language sql
immutable
as $$
  select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))
$$;

create table if not exists public.kk_accountant_aliases (
  alias_norm  text primary key,
  employee_id uuid not null,
  full_name   text not null
);

comment on table public.kk_accountant_aliases is
  'Maps a normalized QA-source accountant name to a real employee. Used by kk_ingest_problems(); mirrors src/lib/ingestion.js ACCOUNTANT_ALIASES.';

-- (Re)seed from a fixed alias → canonical full_name list. The employee uuid and
-- the stored full_name are taken FROM employees, so a typo'd target name simply
-- yields no row (fails safe) rather than an invented identity. Non-person source
-- labels ("հանձнված" = handed over, "-", and names with no employee such as
-- "Էрик"/"Անаhit"/"Шушаник") are intentionally omitted → they resolve to NULL.
truncate public.kk_accountant_aliases;
insert into public.kk_accountant_aliases (alias_norm, employee_id, full_name)
select public.kk_norm_name(v.alias), e.id, e.full_name
from (values
  ('Գայանե',   'Gayane Accounting'),
  ('Թագուհի',  'Taguhi Accounting'),
  ('Ստելլա',   'Stella Accounting'),
  ('Լիլիթ',    'Lilit Accounting'),
  ('Լիլիթ Ք․', 'Lilit Accounting'),
  ('Նաիրա',    'Naira Accounting'),
  ('Նաիրա Մ․', 'Naira Mkhitaryan'),
  ('Օլյա',     'Olya Accounting'),
  ('Հասմիկ',   'Hasmik Accounting'),
  ('Ավագ',     'Avag Accounting'),
  ('Դավիթ',    'Davit Accounting'),
  ('Սաթենիկ',  'Satenik'),
  ('Ռոբերտ',   'Rob Accounting'),
  ('Էմիլյա',   'Emiliya Avanesyan'),
  ('Տաթև',     'Tatev Accounting'),
  ('Առփինե',   'Arpine')
) as v(alias, full_name)
join lateral (
  select id, full_name from public.employees
  where full_name = v.full_name
  order by id
  limit 1
) e on true;

-- Rewrite ingestion to resolve the accountant via the alias table.
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
    al.full_name,
    al.employee_id::text,
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
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(
         coalesce(nullif(btrim(t.accountant), ''), nullif(btrim(c.accountant), ''))
       )
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
    al.full_name,
    al.employee_id::text,
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
  left join public.kk_accountant_aliases al
    on al.alias_norm = public.kk_norm_name(
         coalesce(nullif(btrim(v.accountant), ''), nullif(btrim(c.accountant), ''))
       )
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
  get diagnostics margarita_count = row_count;

  return jsonb_build_object(
    'sona', sona_count,
    'margarita', margarita_count,
    'ran_at', now()
  );
end;
$$;

-- Backfill existing rows with resolved employees.
select public.kk_ingest_problems();
