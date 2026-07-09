-- kk-soprovozhdeniya, exposed read-only to the feedback-form frontend.
--
-- The dashboard must show ONLY active chats (owner decision, 2026-07), and the
-- single source of truth for chat activity is Margarita's kk-soprovozhdeniya =
-- the `mqa_chats` table. That table has RLS enabled with no anon policy, so the
-- anon-key frontend cannot read it directly. Rather than open up the whole
-- Margarita table, expose ONLY the three columns the dashboard needs
-- (contract number, chat link, active/inactive status) through a view.
--
-- The view runs with the definer's rights (security_invoker = off, the default)
-- so it can read mqa_chats; anon/authenticated get SELECT on the view only.

create or replace view public.kk_chat_directory as
select
  c.agr_no,
  c.chat_link,
  c.status
from public.mqa_chats c;

comment on view public.kk_chat_directory is
  'Read-only projection of kk-soprovozhdeniya (mqa_chats): contract no, chat link, active/inactive status. Source of truth for which chats the KK dashboard may show.';

grant select on public.kk_chat_directory to anon, authenticated;
