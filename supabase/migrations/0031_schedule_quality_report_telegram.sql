-- 0031 — schedule the daily + weekly Telegram quality report.
--
-- Uses pg_cron + pg_net to POST to the `quality-report-telegram` Edge Function
-- (supabase/functions/quality-report-telegram). The function builds the report
-- and sends it to the ОК Telegram group.
--
-- SAFE TO APPLY: it does NOTHING until two Postgres settings are provided, so it
-- never schedules a broken job. Configure them once (values NOT in git), then
-- re-run this migration (or just the DO block):
--
--   -- the function base URL, e.g. https://<ref>.supabase.co/functions/v1
--   alter database postgres set app.edge_base_url = 'https://<PROJECT_REF>.supabase.co/functions/v1';
--   -- an Authorization bearer the function accepts (service_role or a dedicated key)
--   alter database postgres set app.edge_auth = 'Bearer <SERVICE_ROLE_OR_FUNCTION_KEY>';
--
-- and set the function's own secrets (bot token + chat id):
--   supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
--
-- Schedule (Asia/Yerevan = UTC+4): daily EVERY day at 20:00 local = 16:00 UTC
-- (owner decision — a notification every evening); weekly summary Monday 09:30
-- local = 05:30 UTC.

do $$
declare
  base text := current_setting('app.edge_base_url', true);
  auth text := current_setting('app.edge_auth', true);
begin
  if base is null or auth is null then
    raise notice 'quality-report-telegram cron NOT scheduled: set app.edge_base_url and app.edge_auth first.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not available — skipping schedule.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net not available — skipping schedule.';
    return;
  end if;

  -- Daily — every day at 20:00 Yerevan (16:00 UTC).
  if exists (select 1 from cron.job where jobname = 'kk_quality_report_daily') then
    perform cron.unschedule('kk_quality_report_daily');
  end if;
  perform cron.schedule(
    'kk_quality_report_daily', '0 16 * * *',
    format(
      $cron$select net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %L)
      );$cron$,
      base || '/quality-report-telegram?period=daily', auth));

  -- Weekly summary, Monday morning.
  if exists (select 1 from cron.job where jobname = 'kk_quality_report_weekly') then
    perform cron.unschedule('kk_quality_report_weekly');
  end if;
  perform cron.schedule(
    'kk_quality_report_weekly', '30 5 * * 1',
    format(
      $cron$select net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %L)
      );$cron$,
      base || '/quality-report-telegram?period=weekly', auth));

  raise notice 'quality-report-telegram cron scheduled (daily 20:00, weekly Mon 09:30 Yerevan).';
end $$;
