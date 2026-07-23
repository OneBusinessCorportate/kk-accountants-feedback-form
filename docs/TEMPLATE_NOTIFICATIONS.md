# Automated template notifications (шаблонные рассылки)

Owner rule (2026-07): template notifications go out **only automatically** by
the bot. Accountants review the 30-day chain, attach manual files, and may edit
a planned message before it goes out; they cannot change the send time.

## Where things live

- **Cabinet UI** — `src/pages/Mailings.jsx` (route `/mailings`; the "По дням" tab
  is manager-only). Tabs: Планировщик · Ручные вложения · По дням · Журнал · Шаблоны.
- **Pure logic (tested)** — `src/lib/templates.js` (inventory + auto/manual
  class) + `src/lib/notifications.js` (+ `notifications.test.js`) +
  `scripts/lib/mailingSafety.mjs` (+ `mailingSafety.test.js`).
- **Data access** — `src/lib/api.js` (scoped RPC reads + audited writes).
- **Schema** — `supabase/migrations/0035_template_notifications.sql`.
- **Bot** — `scripts/mailing_bot.mjs` (Bot API) + cron in `render.yaml`.

## Requirements → implementation

1. **Inventory / auto vs manual** — `templates.js`: `primary_docs` (auto),
   `debts` (auto+data), `salary` (table=manual ведомость / no_employees=auto),
   `main_taxes` (report=manual tax PDF). Manual = salary sheet + tax report.
2. **Manual-add sections** — attach a file *or* mark done by month; note
   optional. Files are private (signed URLs); bucket must be private.
3. **30-day planner** — chain per client with a "уйдёт автоматически …"
   warning; edits via an audited button (`kk_edit`/`kk_upsert_planned_mailing`,
   logs who/what/when); send time not editable.
4. **Language** — per company (RU/AM/ENG), from `client_telegram_chats.language`
   or the chat-name suffix. Backlog: chat-rename → language review (kk_task filed).
5. **Manager by-day view.** 6. **Sent-notifications log** (date/text/type/subtype/
   contract), scoped per accountant.

## Isolation (server-side)

The SPA has no Supabase Auth session (identity = a login code), so the mailing
tables have RLS enabled with **no anon policy** — no direct anon read/write.
Every read is a scoped `SECURITY DEFINER` RPC (`kk_list_*`) returning only the
caller's clients (supervisors all); writes are ownership-checked RPCs
(`kk_save_manual_asset`, `kk_edit`/`kk_upsert_planned_mailing`). The bot uses the
service-role key.

## Delivery + the two hard safety rules

Bot API via `@onebusiness_agent_bot`. Rules (tested, `mailingSafety`):
1. Nothing sends unless `ALLOW_SENDING=true` (default dry-run; `--mode preview`
   is always dry-run).
2. `FORCE_TEST_CHAT_ONLY` forces **every** send to the hard literal test chat
   `-5225180694` (`scripts/lib/mailingSafety.mjs`, not env) — a real client chat
   can never receive anything this phase. A forced test send is logged
   `is_test=true` and never advances the real mailing's `sent` state.

Manual categories deliver the attached file too (`sendDocument`), not just text.
Per-client delivery (numeric `telegram_chat_id`, backfilled from `chat_link`,
687/707) is enabled only after an owner decision + verified bot membership;
alternative userbot is a documented fallback, not built.

## Modes

`--mode plan` materialises the chain (service role, dedup-aware, never clobbers
edited/sent) — run nightly. `preview` read-only. `demo-today` = 5 random active
companies, mixed languages/types, logged `is_test=true`, never written to
`mqa_chat_mailings`. `send` is send-only and polls every 30 min in Yerevan
business hours so a message goes out within ~30 min of its scheduled time (both
rules; dedup re-checked at send).

Manual attach semantics (req 2): a file attached → the bot delivers it and the
send fails if the file can't be delivered; **marked done without a file** →
the bot sends the text only (the accountant's explicit "handled" choice).

## Dedup

Never double-send / never override a manual send: a mailing whose
`(agr_no, period, category)` is done or `source='manual'` in `mqa_chat_mailings`
is `covered` and skipped — enforced in the bot (`loadCoveredKeys`) and the UI.
Category strings match `mqa_chat_mailings.category` (verified 2026-07-23).

## Env / secrets (Render, never committed)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`TEST_CHAT_ID` (default `-5225180694`), `ALLOW_SENDING` (`false` until enabled),
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
