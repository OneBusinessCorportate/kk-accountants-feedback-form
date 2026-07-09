-- Margarita's mailing log (рассылки), exposed read-only to the feedback-form
-- frontend.
--
-- The Clients page shows a «Рассылка» status per client. It used to read only
-- kk_tasks, which is almost always empty, so a mailing that WAS actually sent
-- showed up as "not done" (false negative). Margarita already records every
-- monthly mailing per contract in `mqa_chat_mailings` (status «Отправил» /
-- «Получил» / «Нет долга» + a `confirmed` flag), which is the real source of
-- truth. That table has RLS enabled with no anon policy, so — as with
-- kk_chat_directory (0023) — expose only the columns the dashboard needs
-- through a definer-rights view, granting SELECT to the anon/authenticated
-- frontend roles.

create or replace view public.kk_chat_mailings as
select
  m.agr_no,
  m.period,
  m.category,
  m.status,
  m.confirmed
from public.mqa_chat_mailings m;

comment on view public.kk_chat_mailings is
  'Read-only projection of Margarita mqa_chat_mailings (contract, period, category, status, confirmed). Source of truth for whether a client mailing (рассылка) was actually done.';

grant select on public.kk_chat_mailings to anon, authenticated;
