-- ---------------------------------------------------------------------------
-- Expose the raw ticket fields of a Margarita violation through the read-only
-- kk_violation_workflow view, so the accountant dashboard can render and
-- aggregate a ticket STRAIGHT from the QA platform's source of truth
-- (mqa_violations) instead of only from the mirrored kk_problems row.
--
-- Why. The accountant view (req 1) must list its own tickets showing
-- vdate / client / violation_type / note / sanction / status, and — crucially —
-- only those with `confirmed <> false` (a violation Margarita has un-confirmed
-- must disappear, without us ever touching the `confirmed` column). The
-- original 0027 view exposed the workflow/decision fields but NOT `confirmed`
-- nor the descriptive columns, so the frontend could neither filter by
-- `confirmed` nor build the per-accountant mini-report (req 4) from the true
-- record. This migration adds those columns.
--
-- Purely additive: `create or replace view` keeps the existing 14 columns in
-- the same order and appends the new ones at the end. No schema change to any
-- mqa_* table, no data touched, same anon-facing read pattern (definer rights)
-- as kk_chat_directory / kk_chat_mailings / kk_margarita_checks.
--
-- ORDERING: depends on 0027 (which creates the view) and, transitively, on
-- repo #1's 20260716_mqa_violation_workflow_appeals.sql. The guard below fails
-- loudly if the prerequisite columns are missing.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mqa_violations' and column_name = 'confirmed'
  ) then
    raise exception
      'Prerequisite missing: mqa_violations.confirmed not found — apply the QA-platform (repo #1) violation migrations first.';
  end if;
end $$;

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
  a.resolved_at                  as appeal_resolved_at,
  -- Raw ticket fields (added 0029) — the descriptive record the accountant sees
  -- and the fields the per-accountant mini-report aggregates.
  v.client,
  v.manager,
  v.vdate,
  v.violation_type,
  v.note,
  v.sanction,
  v.confirmed
from public.mqa_violations v
left join lateral (
  select aa.*
  from public.mqa_violation_appeals aa
  where aa.violation_id = v.id
  order by aa.created_at desc
  limit 1
) a on true;

comment on view public.kk_violation_workflow is
  'Read-only projection of the QA-platform violation workflow (mqa_violations + latest mqa_violation_appeals): status, acknowledgement, appeal text and Margarita''s decision, PLUS the raw ticket fields (client, manager, vdate, violation_type, note, sanction, confirmed) so the accountant dashboard can list and report tickets straight from the source of truth and drop confirmed = false ones. Keyed by problem_id = margarita:<id> to line up with kk_problems.';

grant select on public.kk_violation_workflow to anon, authenticated;
