-- 0032 — private key/value store for Edge Function credentials.
--
-- The `quality-report-telegram` function needs TELEGRAM_BOT_TOKEN /
-- TELEGRAM_CHAT_ID. The canonical way to provide them is Supabase function
-- secrets (`supabase secrets set …`, read from Deno.env). When the Supabase CLI
-- is not available in the deploy environment, the function falls back to reading
-- them from this table (see supabase/functions/quality-report-telegram/index.ts).
-- Function secrets (Deno.env) ALWAYS take precedence over this table.
--
-- Security: the table is reached ONLY through the service_role key (the Edge
-- Function's injected key). RLS is enabled with NO policies, so anon /
-- authenticated clients (the SPA's key) can neither read nor write it — same
-- posture as the other server-only tables. Values are inserted out-of-band via
-- SQL, never committed to git.

create table if not exists public.kk_app_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table public.kk_app_secrets is
  'Server-only key/value store for Edge Function credentials (e.g. Telegram bot token / chat id). Read via service_role; RLS on with no anon policy. Values never live in git.';

alter table public.kk_app_secrets enable row level security;
-- No policies on purpose: only service_role (which bypasses RLS) may touch it.
revoke all on public.kk_app_secrets from anon, authenticated;
