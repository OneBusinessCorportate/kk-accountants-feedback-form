-- Margarita's approved daily report, exposed read-only to the accountant
-- feedback-form frontend.
--
-- WHY. The отчёт бухгалтерии used to be an auto-generated PDF (in the QA
-- platform) that could show WRONG numbers (e.g. «Общий уровень сервиса: 0%», an
-- accountant with a critical chat shown at 100). Owner decision: drop the PDF —
-- instead Margarita reviews/edits the generated report on her platform, APPROVES
-- it, and accountants see ONLY that approved text here. The approved reports live
-- in the QA platform table `mqa_published_reports` (repo #1 migration
-- 20260721_mqa_published_reports.sql). That table has RLS with no anon policy,
-- so — exactly like kk_chat_directory (0023) / kk_chat_mailings (0024) — expose
-- the needed columns through a definer-rights view and grant SELECT to the
-- anon/authenticated frontend roles.
--
-- ORDERING: repo #1's `20260721_mqa_published_reports.sql` MUST be applied first
-- (it creates mqa_published_reports). The guard below fails loudly otherwise.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'mqa_published_reports'
  ) then
    raise exception
      'Prerequisite missing: apply margarita-qa-platform migration 20260721_mqa_published_reports.sql first (repo #1) — it creates mqa_published_reports.';
  end if;
end $$;

create or replace view public.kk_published_reports as
select
  r.id,
  r.title,
  r.body,
  r.report_date,
  r.period_label,
  r.published_by,
  r.published_at
from public.mqa_published_reports r;

comment on view public.kk_published_reports is
  'Read-only projection of the QA-platform mqa_published_reports — the daily report AFTER Margarita edited + approved it. Accountants see the latest (by published_at) instead of the retired PDF.';

grant select on public.kk_published_reports to anon, authenticated;
