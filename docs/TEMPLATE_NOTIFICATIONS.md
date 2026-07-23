# Automated template notifications (шаблонные рассылки)

Owner rule (2026-07): template notifications to clients are sent **only
automatically** by the bot. Accountants no longer press "send" — they review
the planned chain, attach the manual files, and may edit a message before it
goes out. Time is fixed by the schedule.

## Where things live

- **Cabinet UI** — `src/pages/Mailings.jsx` (route `/mailings`, all users; the
  "По дням" tab is manager-only). Tabs: Планировщик (30 дней) · Ручные вложения
  · По дням · Журнал отправленных · Шаблоны.
- **Pure logic (tested)** — `src/lib/templates.js` (template inventory + auto/
  manual classification) and `src/lib/notifications.js` (language resolution,
  30-day chain expansion, composition, dedup, sendability). Tests in
  `src/lib/notifications.test.js`.
- **Data access** — `src/lib/api.js`: `fetchCompanySettings`,
  `fetchMailingSchedule`, `fetchPlannedMailings`, `savePlannedMailing`
  (audited RPC), `fetchPlannedMailingEdits`, `fetchSentNotifications`,
  `fetchManualAssets`, `saveManualAsset`.
- **Schema** — `supabase/migrations/0035_template_notifications.sql` on the
  shared project (`fjsogozwseqoxgddjeig`).
- **Bot** — `scripts/mailing_bot.mjs` (Node, Bot API). Cron in `render.yaml`.

## Data model (0035)

| Table | Purpose |
|---|---|
| `kk_company_settings` | Per-company language (RU/AM/ENG), `telegram_chat_id` (backfilled from `mqa_chats.chat_link`), resolved accountant, active flag. Req 4. |
| `kk_mailing_schedule` | Per-company schedule rows (day-of-month per category). Seeded from the department default (до 5/10/15/28), overridable. |
| `kk_planned_mailings` | Materialised 30-day chain. `scheduled_at` is **fixed**; `composed_text` edited only via the audited RPC. |
| `kk_planned_mailing_edits` | Edit audit log: old/new text, who, when. Req 3. |
| `kk_sent_notifications` | Log of every sent message: date, text, type, subtype, contract/client. Req 6. |
| `kk_manual_mailing_assets` | Salary sheet + tax report, by month: file OR "done" mark, optional note. Req 2. |

Writes that must be attributable go through `SECURITY DEFINER` RPCs that
resolve the login code to an employee (the migration-0027 pattern):
`kk_edit_planned_mailing` and `kk_upsert_planned_mailing` (edit + audit),
`kk_save_manual_asset` (ownership-checked file/mark), `kk_extract_tg_id`
(chat_link → numeric id).

**Per-role isolation is server-side (migration 0036).** The SPA has no Supabase
Auth session (identity = a login code), so the mailing tables are locked (no
anon SELECT/DML) and every read is a scoped `SECURITY DEFINER` RPC —
`kk_list_company_settings` / `kk_list_mailing_schedule` /
`kk_list_planned_mailings` / `kk_list_planned_mailing_edits` /
`kk_list_sent_notifications` / `kk_list_manual_assets` — returning only the
caller's own clients (supervisors see all). A regular accountant cannot read
another accountant's plans, sent-log, or attachment records by querying Supabase
directly; the browser filter is no longer the only guard. The bot uses the
service-role key and bypasses this. The manual-add file itself (salary sheet /
tax report) is delivered by the bot via `sendDocument`, not only referenced in
text.

## Template inventory & auto/manual split (req 1)

Categories mirror `mqa_chat_mailings.category` (dedup lines up 1:1):

| Category | Templates | Assembly |
|---|---|---|
| `primary_docs` | request (до 28) | **auto** |
| `debts` | service_payment (до 5), reminder | **auto + data** (amount/period) |
| `salary` | table (до 10), no_employees | table = **manual** (salary ведомость), no_employees = auto |
| `main_taxes` | report (до 15) | **manual** (tax report PDF / расчёт) |

Manual parts = the **salary ведомость** and the **tax report PDF/расчёт** —
exactly what the owner flagged ("документ с зп; отчет налогов"). The text still
auto-assembles; the **file/marker** is the required unit (no forced comment).

## Composition (what the bot plans/sends)

Not a generic template: for each client the message is built from their real
data (debt amount, period, contract, company language) and their own chat
history/tone. The template is the starting style only. The cabinet preview
shows the same text the client would receive.

## Delivery mechanism (the hard problem) — chosen: Bot API + registry

- **Chosen:** `@onebusiness_agent_bot` via the Bot API, with a numeric
  `telegram_chat_id` registry (`kk_company_settings.telegram_chat_id`,
  backfilled from `mqa_chats.chat_link` — 687/707 active chats resolved).
  The bot must be a member of a group to message it; until it is, that chat is
  "pending delivery" (`bot_can_send=false`).
- **Fallback (documented, not built):** a Telethon/Pyrogram **userbot** on the
  account that already ingests the `messages` feed could reach all groups
  without adding the bot to each — at the cost of running as a human account
  (Telegram ToS/session risk). Build only if adding the bot everywhere proves
  impractical.

## Two hard safety rules in the bot (current phase)

`scripts/mailing_bot.mjs`:

1. **SENDING LOCK** — nothing is sent unless `ALLOW_SENDING=true`. Default is
   preview/dry-run (compose + print only). `--mode preview` is **always**
   dry-run even if sending is unlocked.
2. **TEST-CHAT-ONLY OVERRIDE** — `FORCE_TEST_CHAT_ONLY = true` forces **every**
   send to the hard literal `FORCED_TEST_CHAT` (`-5225180694`) defined in
   `scripts/lib/mailingSafety.mjs` — **not** read from any env var, so a stray
   `TEST_CHAT_ID` cannot redirect sends. A real client chat can never receive a
   message in this phase. Both rules are the tested pure functions
   `resolveTarget()` / `canDeliver()` (`src/lib/mailingSafety.test.js`).
   Per-client delivery is enabled only after an owner decision + verified
   chat_id registry + bot membership.

## Modes / commands

- `node scripts/mailing_bot.mjs --mode plan` — materialise the 30-day chain into
  `kk_planned_mailings` (service role). Dedup-aware; never clobbers an
  accountant-edited (`status='edited'`) or already-`sent` row. No sending.
- `npm run mailing:preview` — read-only: prints today's due mailings, never
  writes, never sends.
- `npm run mailing:demo` — the owner demo: 5 random active companies, mixed
  languages + mixed types ("break the schedule only today"). Preview unless
  unlocked; logged with `is_test=true`, never written to `mqa_chat_mailings`.
- `npm run mailing:send` — plans, then sends due mailings (guarded by both
  rules; dedup re-checked at send time).

## Env / secrets (never committed)

Set in Render dashboard:

| Var | Used by | Note |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | bot | writes the sent-log |
| `TELEGRAM_BOT_TOKEN` | bot | `@onebusiness_agent_bot` |
| `TEST_CHAT_ID` | bot | default `-5225180694` |
| `ALLOW_SENDING` | bot | `false` until the owner enables sending |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | web | frontend |

## Dedup against Margarita's QA platform

The bot never double-sends and never overrides a manual send: a planned mailing
whose `(agr_no, period, category)` already has a done or `source='manual'` row in
`mqa_chat_mailings` is marked `covered` and skipped. This is enforced **both**
in the bot (`loadCoveredKeys` in `mailing_bot.mjs`, checked in `runPlan` and
re-checked in `runSendDue` at send time) and in the UI (`coveredMailingKeys` /
`classifyMailingStatus`). The `source` column is exposed through the
`kk_chat_mailings` view (updated in 0035) so the "manual send" branch is live.
Category strings (`primary_docs`/`main_taxes`/`salary`/`debts`) are verified to
match `mqa_chat_mailings.category` (checked against live data 2026-07-23). Real
sends write back into `mqa_chat_mailings` (`source='telegram'`) so detection/QA
stay consistent; demo/test sends do NOT.

Manual-add files (salary sheet, tax report) are sensitive client documents:
only the private `storage_path` is stored (no public URL), and the cabinet
opens them via short-lived **signed URLs** (`signedAssetUrl`). The
`kk-attachments` bucket must be private.

## Backlog (point 4)

Detect client chat-name changes → flag that the company language may need
updating. Filed once as a supervisor `kk_task`
("[Backlog] Отслеживать смену названия чата → пересмотреть язык компании")
by migration 0035. Not implemented yet.
