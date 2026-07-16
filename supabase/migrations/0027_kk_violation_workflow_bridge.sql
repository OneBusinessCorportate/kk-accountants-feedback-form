-- ---------------------------------------------------------------------------
-- Cross-app bridge: accountant reactions on Margarita's QA violations write
-- straight into the QA platform's OWN tables (mqa_violations /
-- mqa_violation_appeals), so the loop closes across the two apps.
--
-- Context. This feedback form (repo #2) and Margarita's QA back-office
-- (margarita-qa-platform, repo #1) share ONE Supabase project. Repo #1 owns the
-- violation workflow: `mqa_violations.status`
-- (new|acknowledged|appealed|appeal_approved|appeal_rejected), acknowledgement
-- fields, and the `mqa_violation_appeals` table (see repo #1 migration
-- `20260716_mqa_violation_workflow_appeals.sql`). Repo #1 is the SOURCE OF TRUTH
-- for a violation and where Margarita rules on appeals.
--
-- Previously an accountant's «Ознакомлен»/«Подать апелляцию» only reached this
-- app's own kk_problem_* tables, which Margarita's platform / reports / Telegram
-- never read — so her side never saw the reaction, and her decision never
-- reached the accountant. This migration bridges the gap WITHOUT any HTTP call
-- between the apps (this app is a static SPA on the anon key, and repo #1's APIs
-- are auth-guarded to Margarita's own users): the frontend calls two
-- SECURITY DEFINER RPCs that authenticate the accountant's login code, enforce
-- ownership + validation + idempotency in the database, and write to the mqa_*
-- tables; and it reads Margarita's live status + decision back through a
-- read-only view. This mirrors the existing kk_chat_directory / kk_chat_mailings
-- / kk_margarita_checks pattern (anon-facing kk_ objects over mqa_ tables).
--
-- ORDERING: repo #1's `20260716_mqa_violation_workflow_appeals.sql` MUST be
-- applied first (it creates mqa_violations.status/acknowledged_* and the
-- mqa_violation_appeals table). The guard below fails loudly otherwise.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'mqa_violation_appeals'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mqa_violations' and column_name = 'status'
  ) then
    raise exception
      'Prerequisite missing: apply margarita-qa-platform migration 20260716_mqa_violation_workflow_appeals.sql first (repo #1 / PR #15) — it creates mqa_violations.status and mqa_violation_appeals.';
  end if;
end $$;

-- 1. Read-only projection of the violation workflow -------------------------
--
-- One row per violation, joined to its LATEST appeal, keyed by both the
-- violation id and the kk_problems key ('margarita:'||id) so the frontend can
-- line it up with the mirrored kk_problems row it already renders. Exposes only
-- the workflow/decision fields the accountant needs to see (never the money
-- engine). Runs with the definer's rights (security_invoker off, the default),
-- so the anon frontend can read it even though mqa_violation_appeals has RLS.
create or replace view public.kk_violation_workflow as
select
  v.id                           as violation_id,
  'margarita:' || v.id           as problem_id,
  v.accountant,
  v.chat_agr_no,
  v.status,
  v.acknowledged_at,
  v.acknowledged_by,
  a.id                           as appeal_id,
  a.appeal_text,
  a.status                       as appeal_status,
  a.decision_comment,
  a.resolved_by,
  a.created_at                   as appeal_created_at,
  a.resolved_at                  as appeal_resolved_at
from public.mqa_violations v
left join lateral (
  select aa.*
  from public.mqa_violation_appeals aa
  where aa.violation_id = v.id
  order by aa.created_at desc
  limit 1
) a on true;

comment on view public.kk_violation_workflow is
  'Read-only projection of the QA-platform violation workflow (mqa_violations + latest mqa_violation_appeals): status, acknowledgement, appeal text and Margarita''s decision. Keyed by problem_id = margarita:<id> to line up with kk_problems. Same anon-facing read pattern as kk_chat_directory.';

grant select on public.kk_violation_workflow to anon, authenticated;

-- 2. Ownership helper -------------------------------------------------------
-- Shared by both RPCs: resolve the login code to an employee and confirm they
-- own the violation (the violation's accountant name resolves to the same
-- employee via kk_resolve_employee — the same alias/normalisation used by
-- kk_ingest_problems). Raises a clean, typed error otherwise. Ownership is
-- computed in the DB from the stored violation, never from client input, so the
-- anon key cannot forge it: the only thing the caller proves is possession of a
-- valid login code (exactly this app's auth model).
create or replace function public.kk_assert_violation_owner(
  p_violation_id text,
  p_login_code   text,
  out employee_id uuid,
  out full_name   text,
  out accountant  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  select r.employee_id, r.full_name into employee_id, full_name
  from public.resolve_login_code(p_login_code) r
  limit 1;
  if employee_id is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode = '28000';
  end if;

  select v.accountant into accountant
  from public.mqa_violations v
  where v.id = p_violation_id;
  if not found then
    raise exception 'Нарушение не найдено.' using errcode = 'P0002';
  end if;

  select e.id into v_owner from public.kk_resolve_employee(accountant) e limit 1;
  if v_owner is null or v_owner <> employee_id then
    raise exception 'Можно реагировать только на собственное нарушение.' using errcode = '42501';
  end if;
end;
$$;

-- 3. «Ознакомлен» -----------------------------------------------------------
-- Idempotent: only a `new` violation transitions to `acknowledged` (guarded in
-- the UPDATE), so a double-click / refresh / concurrent call never duplicates
-- or overwrites a later appeal — it just returns the current row. Mirrors repo
-- #1's acknowledgeViolation() semantics exactly.
create or replace function public.kk_acknowledge_violation(
  p_violation_id text,
  p_login_code   text
)
returns table(violation_id text, status text, acknowledged_at timestamptz, acknowledged_by text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
begin
  select * into o from public.kk_assert_violation_owner(p_violation_id, p_login_code);

  update public.mqa_violations v
     set status          = 'acknowledged',
         acknowledged_at = now(),
         acknowledged_by = coalesce(v.acknowledged_by, o.full_name, o.accountant)
   where v.id = p_violation_id
     and v.status = 'new';

  return query
    select v.id, v.status, v.acknowledged_at, v.acknowledged_by
    from public.mqa_violations v
    where v.id = p_violation_id;
end;
$$;

-- 4. «Подать апелляцию» -----------------------------------------------------
-- Server-side validation (non-empty text), ownership, and status guards
-- mirroring repo #1's assertCanAppeal; the DB partial-unique index
-- (one pending appeal per violation) is the race backstop. On success the
-- violation moves to `appealed` and the appeal shows up in Margarita's existing
-- /appeals queue, work-report and Telegram section automatically (they already
-- read mqa_violation_appeals).
create or replace function public.kk_appeal_violation(
  p_violation_id text,
  p_login_code   text,
  p_appeal_text  text
)
returns table(appeal_id text, violation_id text, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o       record;
  v_text  text;
  v_status text;
  v_new_id text;
begin
  v_text := btrim(coalesce(p_appeal_text, ''));
  if v_text = '' then
    raise exception 'Текст апелляции обязателен.' using errcode = '22023';
  end if;

  select * into o from public.kk_assert_violation_owner(p_violation_id, p_login_code);

  select v.status into v_status from public.mqa_violations v where v.id = p_violation_id;
  if v_status = 'appealed' then
    raise exception 'По этому нарушению уже подана апелляция.' using errcode = '23505';
  elsif v_status in ('appeal_approved', 'appeal_rejected') then
    raise exception 'Апелляция по этому нарушению уже рассмотрена.' using errcode = '23505';
  end if;

  begin
    insert into public.mqa_violation_appeals (violation_id, accountant, appeal_text, status)
    values (p_violation_id, o.accountant, v_text, 'pending')
    returning id into v_new_id;
  exception when unique_violation then
    raise exception 'По этому нарушению уже есть апелляция на рассмотрении.' using errcode = '23505';
  end;

  update public.mqa_violations v
     set status = 'appealed', appeal_status = 'appealed'
   where v.id = p_violation_id;

  return query
    select a.id, a.violation_id, a.status, a.created_at
    from public.mqa_violation_appeals a
    where a.id = v_new_id;
end;
$$;

-- The anon/authenticated roles may CALL the RPCs (they enforce their own auth
-- via the login code) but have NO direct DML on the mqa_* tables.
revoke all on function public.kk_assert_violation_owner(text, text) from public;
grant execute on function public.kk_acknowledge_violation(text, text)        to anon, authenticated;
grant execute on function public.kk_appeal_violation(text, text, text)       to anon, authenticated;

comment on function public.kk_acknowledge_violation(text, text) is
  'Accountant «Ознакомлен» on a Margarita violation. Authenticates the login code, enforces ownership, idempotent new→acknowledged. Writes to mqa_violations (repo #1 source of truth).';
comment on function public.kk_appeal_violation(text, text, text) is
  'Accountant «Подать апелляцию» on a Margarita violation. Authenticates the login code, enforces ownership + one-pending, inserts into mqa_violation_appeals and moves the violation to appealed.';
