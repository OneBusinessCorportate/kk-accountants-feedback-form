-- 0034 — schedule the daily ArmSoft/TaxService database analysis to Telegram.
--
-- Owner ask: «for every day make sure there is the full analysis from supabase
-- that is sent in the chat». Uses pg_cron + pg_net to POST to the
-- `daily-db-analysis-telegram` Edge Function (supabase/functions/
-- daily-db-analysis-telegram), which reads the OB Artyom project's
-- accounting_activities / accountant_daily_comments, aggregates them per
-- accountant (same logic as src/lib/artyomCompare.js and the in-app
-- DailyAnalysis panel — so «sent in the chat» === «seen here»), and posts the
-- message to the ОК Telegram group.
--
-- SAFE TO APPLY: it does NOTHING until two Postgres settings are provided, so it
-- never schedules a broken job. Configure them once (values NOT in git), then
-- re-run this migration (or just the DO block):
--
--   alter database postgres set app.edge_base_url = 'https://<PROJECT_REF>.supabase.co/functions/v1';
--   alter database postgres set app.edge_auth = 'Bearer <SERVICE_ROLE_OR_FUNCTION_KEY>';
--
-- and set the function's own secrets (the Artyom project + the bot):
--   supabase secrets set ARTYOM_SUPABASE_URL=... ARTYOM_SUPABASE_ANON_KEY=... \
--                        TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
--
-- Schedule (Asia/Yerevan = UTC+4): every day at 19:45 local = 15:45 UTC, i.e.
-- just after the working day ends, so the message covers the day just finished.

do $$
declare
  base text := current_setting('app.edge_base_url', true);
  auth text := current_setting('app.edge_auth', true);
begin
  if base is null or auth is null then
    raise notice 'daily-db-analysis cron NOT scheduled: set app.edge_base_url and app.edge_auth first.';
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

  -- Daily — every day at 19:45 Yerevan (15:45 UTC), covering the same day.
  if exists (select 1 from cron.job where jobname = 'kk_daily_db_analysis') then
    perform cron.unschedule('kk_daily_db_analysis');
  end if;
  perform cron.schedule(
    'kk_daily_db_analysis', '45 15 * * *',
    format(
      $cron$select net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %L)
      );$cron$,
      base || '/daily-db-analysis-telegram', auth));

  raise notice 'daily-db-analysis-telegram cron scheduled (every day 19:45 Yerevan).';
end $$;
