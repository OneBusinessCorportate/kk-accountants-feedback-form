# Project notes for Claude

## Workflow preference (set by the owner)

- Before pushing, **always run the test suite** (`npm test`) and the build (`npm run build`).
- If everything passes, **push directly to `main`**.
- If tests fail, **fix the issues first**, re-run, and only push once green.

## Project overview

Internal OneBusiness web app for accountant feedback on client problems.
React + Vite frontend, Supabase (Postgres) backend, deployed on Render as a Static Site.

- `src/pages/` — Dashboard `/`, Accountant `/accountant`, Review `/review`, Admin `/admin`
- `src/lib/` — `supabaseClient.js`, `constants.js`, `api.js` (all data access),
  `auth.js` + `scope.js` + `AuthContext.jsx` (login-code auth & per-accountant scoping)
- `src/lib/*.test.js` — Vitest unit tests (constants integrity, api call flow, auth, scope, ingestion)
- `supabase/migrations/0001_init.sql` — schema (`kk_problems`, `kk_accountant_feedback`, `kk_review_actions`)

## Accountant identity & ingestion (use ONLY valid employees)

**Sona + Margarita only (0022, owner decision).** `kk_ingest_problems()` creates
problems ONLY from the manual review results: Sona (`sqa_tickets` + ticketless
`sqa_reviews` problems, 0021) and Margarita (`mqa_violations` + «Критично»/«Плохо»
`mqa_evaluations`, 0021). The **live QA detection ingestion is DISABLED** —
migration 0022 removed the `qa_unanswered_chats`/`qa_answered_late_chats`/
`qa_overdue_promises` blocks (and their 0012 auto-resolve + 0014/0015
reclassification steps) from the function and retired the open untouched `ai`
rows to `auto_resolved`; `ai` rows an accountant/reviewer had acted on keep
living through the normal review flow. The `qa_*` RPCs themselves are untouched
(the QA dashboards still use them), the historical `ai` rows stay for QAStats /
Review, and the Dashboard's «Проблемные чаты (AI)» section was removed. The
paragraphs below about the live-QA mapping/auto-resolve/reclassification are
kept as documentation of migrations 0004-0015 and of the JS mappers (which
remain as the spec for the historical rows).

Historically, problems were created by `kk_ingest_problems()` from (a) the manual Sona
(`sqa_tickets`) and Margarita (`mqa_violations`) reviews and (b) the **live QA
detection RPCs** that power the dashboards — `qa_unanswered_chats` («Без ответа»),
`qa_answered_late_chats` («Поздний ответ») and `qa_overdue_promises`
(«Невыполненное обещание») — see `supabase/migrations/0004_qa_detection_ingestion.sql`.
The RPCs each return a JSON **array** (not `{key: array}`). Unanswered targeting
(0005): a row the QA layer marks `data_incomplete`/`needs_review` is UNCERTAIN
(staff reply likely dropped — someone may have answered) → one **unassigned** soft
item «Возможно без ответа (требует проверки)», nobody blamed. A CONFIRMED row
(`no_staff_reply_after_client_question`) is assigned to the client's **@mentioned**
employees (the ones actually asked, resolved via `employees.normalized_username`);
else to all named accountants; else unassigned. `kk_resolve_employee()` resolves a
name to an employee (full_name → alias → space-insensitive). Promises name no one →
unassigned (supervisors only).
`src/lib/ingestion.js` mirrors these as `mapUnansweredChat`/`mapLateChat`/`mapOverduePromise`
for spec + tests.

**Full quality-review coverage (0021).** Tickets and violations alone left most
accountants with little or no data (17 `sqa_tickets` + 62 `mqa_violations`,
while `mqa_evaluations` holds 5 687 monthly per-chat scorecards). Two more
sources now feed `kk_ingest_problems()`:

- `mqa_evaluations` rated «Критично» (priority 1) / «Плохо» (priority 2) →
  `margarita_eval:<id>`, source `margarita_review`, titles «Критичная/Низкая
  оценка качества сервиса», description = reviewer comment + score/band/period +
  manual SLA/accuracy criteria. Skips an evaluation already covered by an
  `mqa_violations` row for the same chat + accountant within ±3 days (the
  violation has the more specific title), and — unlike other manual sources —
  ingests ONLY rows that resolve to a real employee: an evaluation is
  intrinsically about one accountant's work, so «-»/«հանձնված»/«#N/A» rows are
  dropped rather than queued unassigned.
- `sqa_reviews` with `record_type='problem'` but no `sqa_tickets` row →
  `sona_review:<id>`, source `sona_review`, neutral title «Проблема по проверке
  качества» (0018 — checker identity stays hidden).

JS mirrors: `mapMargaritaEvaluation` (returns null for unresolved names) and
`mapSonaReviewProblem` in `src/lib/ingestion.js`. First run ingested 258 + 1
problems; every accountant present in the QA sources now has data. The four
active accountants absent from ALL sources (Alisa Tsaturyan, Arthur Barseghyan,
Ashot Mantashyan, Marianna Khachatryan) still have none — there is nothing to
ingest until the QA platforms start covering them.

**Auto-resolution of stale live detections (0012).** The live `qa_*` detections are
transient: a chat flagged «Без ответа» / «Поздний ответ» / «Невыполненное обещание»
stops being reported once it's answered/sent. Since `kk_ingest_problems()` is an
upsert, it used to leave those rows in the queue forever (e.g. B-3983 was flagged at
15:18, answered ~18:00, yet kept showing as open «Без ответа» days later). After
re-ingesting the four live detections, the function now retires any still-open AI
problem (`unanswered`/`review`/`late`/`promise`) whose `detected_at` is within the
120h window but that this run did NOT refresh → status `auto_resolved` (new terminal
status; `STATUS.auto_resolved` / «Снято автоматически (получен ответ)»). It never
touches rows an accountant/reviewer has acted on, reviewer-judged false positives
(the verdict loop owns those), Sona/Margarita reviews, or items older than the window.
`auto_resolved` is excluded from both queues and dashboard counts.

**Message-based «Без ответа» → «Поздний ответ» reclassification (0014).** A chat
flagged «Без ответа» that is later answered LATE must become «Поздний ответ», not
silently auto-resolve. The old reclassification (0010) depended on a live `late:`
RPC row existing, but `qa_answered_late_chats` only looks back 24h and skips
"active back-and-forth" follow-ups, so that counterpart was usually never created
and the row was retired instead — losing the late signal (measured: 42 late answers
swallowed). The reclassification is now driven from the **messages**:
`kk_first_substantive_staff_reply_after(chat_id, ts)` returns the earliest real
(substantive, non-promise) reply from a recognised employee after `ts`, using the
same staff-recognition rules as `qa_unanswered_chats` (incl. the 0013 inactive-employee
fix). `kk_ingest_problems()` relabels an open `unanswered:` row to «Поздний ответ»
whenever its flagged question (`detected_at`) got such a reply MORE than 2 business
hours later — runs BEFORE the auto-resolve step (so late answers are kept, not
retired) and re-stamps already-late rows each run to keep them alive. The `late:`
RPC ingestion is kept but de-duplicated (skips a chat that already has an open
`unanswered:` row). A one-time backfill in 0014 resurrects late answers already lost
to `auto_resolved`. Display is unchanged — the Dashboard already counts «Поздний
ответ» by title and excludes `auto_resolved`.

## Dashboard rebuild — Margarita + Sona only, active chats, working-hours SLA (0023)

Owner decision (2026-07): the accountant-facing dashboard must use **only**
Margarita's and Sona's review results — **no AI analysis of any kind** (no AI
conclusions/comments/risks/missed-call/SLA/classification). All that logic now
lives in one tested, DB-free module, `src/lib/dashboard.js` (spec + tests in
`dashboard.test.js`), and `prepareDashboard()` is the single entry point every
accountant-facing page calls. Rules enforced there:

- **No AI.** Only `source ∈ {margarita_review, sona_review}` is ever counted
  (`DASHBOARD_SOURCES`); `ai` rows and reviewer-confirmed false positives are
  dropped before anything else. Pages fetch with `fetchProblems({ sourceIn:
  DASHBOARD_SOURCES })`.
- **Active chats only (source of truth = kk-soprovozhdeniya).** The Margarita
  `mqa_chats` table (Чаты sheet; `status` Active/Inactive) is exposed read-only
  to the anon frontend through the `kk_chat_directory` view (migration 0023 —
  `mqa_chats` itself has RLS with no anon policy). `fetchChats()` loads it.
  A problem on an **inactive** chat is hidden entirely; a chat that can't be
  matched by link or contract number is **unknown** → «Требует проверки», never
  counted. Matching normalises chat links and Cyrillic/Latin contract numbers.
- **Responsible accountant only from the resolved employee id.** A row with no
  `accountant_id` goes to «Требует проверки» — we never guess an owner (req 7).
- **Dedup (req 4).** `dedupeProblems()` collapses rows sharing
  source+chat+accountant+day+title; `groupClients()` gives one row per client
  (case/space-insensitive key) merging its chats + sources, so a client never
  repeats. Similar-but-unequal names are NOT auto-merged.
- **Date filters actually recompute (req 3).** `PERIODS` = Сегодня / 2 дня /
  Неделя / Всё время; boundaries are day-aligned in **Asia/Yerevan** and filter
  on `detected_at`. `formatDate()` also renders in Yerevan tz so dates are
  correct.
- **SLA in Margarita working hours (req 1).** `businessMinutesBetween()` counts
  only 10:00–13:00 and 14:00–19:00 Yerevan (8h/day); lunch and off-hours don't
  count, a message after 19:00 effectively starts next morning, one in 13–14
  starts at 14:00. `isOverdue()` compares the working-hours age to
  `SLA_BUSINESS_HOURS` by priority. No AI/message timing is used.

Pages: `Dashboard.jsx` shows period pills + category cards; **clicking a
category shows only that category** (req 5/6) and nothing before a click.
`Clients.jsx` and `Accountant.jsx` route their data through
`prepareDashboard()` too. Tasks come only from `kk_tasks` (manual / Emilia's
side — never auto-created from AI, req 9) and are scoped by `access.employee_id`
(the login identity field; the old `access.id` was undefined → a scoping bug,
now fixed). The management-only `Review` / `QA Точность` pages still rate the
historical `ai` detections for the learning loop below — they are QA tools, not
the dashboard.

## «Рассылка» status from Margarita's real mailing log (0024)

The Clients page «Рассылка» column used to read only `kk_tasks` (nearly empty),
so a mailing that WAS actually sent showed as "not done" (false negative — every
client showed «+»). The real record is Margarita's `mqa_chat_mailings` (per
contract + period + category), exposed read-only via the `kk_chat_mailings` view
(migration 0024). `classifyMailingStatus()` normalises the per-category wording
before checking — done = «Отправил»/«Получил»/«Нет долга» or `confirmed=true`;
pending = «Не отправил»/«Запросил …, не получил»/«Предстоящая»/«… написал/
позвонил»; «Inactive»/blank ignored; negatives matched first so «Не отправил»
isn't read as «Отправил». `buildMailingIndex()` reduces to one state per
contract using its LATEST period; `mailingStateForContracts()` gives a client
«done» only when every contract is done and nothing is outstanding (so no new
false positives), «pending» when something is still open, «none» when Margarita
has no record (then the manual kk_tasks mailing is used as a fallback / override).
Only the «Рассылка» column changed; «Отчёт»/«Квитанция» still use kk_tasks.

**Broaden salary «рассылка» auto-detection (0028).** Owner reported still marking
the salary mailing by hand for many chats. The mailing rows are produced by
`mqa_detect_mailings()` (Margarita's QA platform, cron every 2h) which scans
accountant `messages` per active chat and upserts `mqa_chat_mailings` with
`source='telegram'`. Measured over period 202607: ~197 salary chats auto-detected
OK, ~160 blocked by the `on conflict … where source <> 'manual'` **manual lock**
(a human mark is never overwritten — owner chose to KEEP that), and ~19 real
salary sends fired NO salary regex branch. The gap was the salary "done" verb list
missing the accountant's commonest send/payment verbs: «Направляю таблицу по
заработным платам …» (`направля…`), «перечислил/переведена зарплату» , «произвели
выплаты заработной платы». 0028 `create or replace`s `mqa_detect_mailings` adding
those past-tense forms to the RU salary "done" branch (and to the shared
`neg_done` guard so «не перевели …» is still suppressed); past-tense only, so the
noun «перечислении» / imperative «направьте» / discussion questions don't match.
Everything else (other categories, Armenian branches, windowing, the manual-lock
upsert) is byte-identical to the live definition. Verified against live `messages`;
detection re-run for 202607 auto-filled 7 previously-unmarked chats and left every
manual row untouched. NOTE: this function canonically lives in the QA platform
("repo #1"); the copy here must be ported there if the repos diverge.

## Accountant reaction loop + Margarita work report (0025 / 0026)

After Margarita/Sona QA, every issue (a `kk_problems` row, source
`margarita_review`/`sona_review`) is a *ticket sent to the accountant*
(`status='waiting_for_accountant'` on ingestion). The accountant must react —
they cannot leave it stateless:

- **«Ознакомлен»** → `acknowledgeProblem()` upserts `kk_problem_acknowledgements`
  (one per problem, keeps `accountant_id/name` + `created_at` = acknowledged_at)
  and sets `status='acknowledged'`.
- **«Подать апелляцию»** → `submitAppeal()` inserts `kk_problem_appeals`
  (`status='pending'`, the accountant's `comment`) and sets
  `status='appeal_pending'`. A partial-unique index allows only ONE pending
  appeal per problem.

Every sent ticket therefore always carries one of: `waiting_for_accountant`,
`acknowledged`, `appeal_pending`, `appeal_approved`, `appeal_rejected`. The
accountant's card (`Accountant.jsx` → `ReactionBox`) shows the two buttons, a
«Мои апелляции» tracker, and any attached fine.

**Appeal review (Margarita/management, `Appeals.jsx`, management-only route).**
Each appeal shows accountant, client/chat, the original feedback, the fine, the
appeal text, date and status. `resolveAppeal()`:
- **approve** → appeal `approved`; problem → `appeal_approved`,
  `verdict='not_problematic'` (drops from dashboard counts), and the fine is
  cancelled (`penalty_cancelled=true`, `penalty_cancelled_at`). Saves
  `resolved_by` / `resolved_at` / `resolution_comment`.
- **reject** → appeal `rejected`; problem → `appeal_rejected` (stays active),
  fine stays active. The issue returns to the accountant's actionable queue.

**Penalties / fines (0026).** `kk_problems` gained `penalty_amount`,
`penalty_cancelled`, `penalty_cancelled_at`. `kk_ingest_problems()` carries
`mqa_violations.sanction` onto the matching `margarita:<id>` ticket
(`penalty_amount`), and re-ingestion never un-cancels a fine. Margarita can also
set/clear a fine from the appeal card (`setProblemPenalty`). All sanctions are 0
today, so the amount is a capability, but the whole lifecycle is wired.

**Margarita work report (`reports.js` + `Reports.jsx`, management-only).**
Pure/DB-free aggregation over problems + appeals + acks + her per-chat
scorecards. `kk_margarita_checks` (0026) is a read-only projection of
`mqa_evaluations` (one row per checked chat/period, accountant resolved via
`kk_accountant_aliases`) — the true record of **chats checked** (644 distinct).
The «Объём работы Маргариты» card shows Проверено чатов / Создано замечаний /
Получено-Подтверждено-Отклонено апелляций / Ожидают рассмотрения, plus by-day
and by-accountant breakdowns and per-accountant active/cancelled violations &
fines. Period pills recompute in Asia/Yerevan (checks filter on `checking_date`,
issues on `detected_at`, appeals on `created_at`).

**System tasks (`Tasks.jsx` = «Системные задачи бухгалтеров»).** Separate from
appeals. `kk_tasks` gained `priority` + `due_date_postponed` and the
`postponed`/`cancelled` states (0026; `open`≈new, `done`≈completed, `done_at`
doubles as completed_at). A QA follow-up can be spun off an appeal via
`createTask({ task_type:'qa', problem_id })`. Regular accountants see only their
own tasks; supervisors see all, grouped by accountant.

## Cross-app violation loop — write back to Margarita's QA platform (0027)

A `margarita_review` problem keyed `margarita:<id>` is a **mirror** of a row that
actually lives in Margarita's QA platform (`mqa_violations`), which is the SOURCE
OF TRUTH for that violation and where she rules on appeals (her platform has
`mqa_violations.status` new/acknowledged/appealed/appeal_approved/appeal_rejected,
`acknowledged_*`, and the `mqa_violation_appeals` table). So for these problems the
accountant's «Ознакомлен»/«Подать апелляцию» must NOT go to this app's
`kk_problem_*` tables — that stayed invisible to her platform/reports/Telegram.
Instead they write back into `mqa_violations` / `mqa_violation_appeals`, and her
decision flows back here.

Both apps share one Supabase project and this app is a static SPA on the anon key,
so the write path is a **shared-DB** bridge (migration `0027`), not an HTTP call:

- Two `SECURITY DEFINER` RPCs — `kk_acknowledge_violation(p_violation_id,
  p_login_code)` and `kk_appeal_violation(p_violation_id, p_login_code,
  p_appeal_text)` — authenticate the login code via `resolve_login_code`, enforce
  **ownership** server-side (the violation's `accountant` must resolve to the same
  employee via `kk_resolve_employee`, computed in the DB from the stored row — the
  anon client cannot forge it), validate text, and are idempotent (acknowledge is
  guarded `status='new'`; appeal relies on the one-pending partial unique index).
  anon/authenticated may only EXECUTE these, they have no direct DML on `mqa_*`.
- Read-only view `kk_violation_workflow` (same pattern as `kk_chat_directory`)
  exposes the live status + latest appeal + Margarita's decision, keyed
  `problem_id = margarita:<id>` so it lines up with `kk_problems`.

**ORDERING:** migration 0027 depends on repo #1's
`20260716_mqa_violation_workflow_appeals.sql` (it creates `mqa_violations.status`
and `mqa_violation_appeals`). A guard at the top of 0027 fails loudly if that
prerequisite is missing.

JS: `src/lib/violationWorkflow.js` (pure: `isMargaritaProblem`,
`violationIdFromProblemId`, `interpretWorkflow`) + `api.js`
(`fetchViolationWorkflow*`, `acknowledgeViolation`, `appealViolation`, which send
`getStoredCode()` as the identity). `Accountant.jsx` renders a
`MargaritaReactionBox` (mqa-backed) for these problems and the existing
`ReactionBox` (kk-backed) for every other source. An appeal submitted here shows
up in Margarita's own `/appeals` queue, work-report and Telegram automatically
(they already read `mqa_violation_appeals`). NOTE: a «Критично»/«Плохо»
**evaluation** is source `margarita_review` too but keyed `margarita_eval:<id>`
(no `mqa_violations` row) — `isMargaritaProblem` returns false for it, so it keeps
using the local kk_problem flow.

## Detection-quality feedback loop (Review → learning)

Reviewers (Проверка, management-only) rate whether a flagged problem was TRULY a
problem — «Действительно проблема» / «Ложное срабатывание» (`rateProblem` →
`kk_problem_ratings` history + `kk_problems.verdict`). A «Ложное срабатывание»
verdict (1) drops the problem from accountant queues + dashboard counts
(`verdict !== 'not_problematic'` filter) and (2) makes `kk_ingest_problems()`
SUPPRESS that detection so it stops reappearing — until a strictly NEWER episode
(rating stores `problem_detected_at`; suppression re-surfaces when a newer
`detected_at` arrives), so it never goes permanently blind (see
`0006_problem_ratings.sql`). The `qa_*` RPCs are NOT modified; `kk_problem_ratings`
is the labeled signal the QA-bot team can later feed into them. Toggle «Показывать
обнаруженные ИИ» in Review loads the live AI items for rating. Those sources record
the accountant only by a **short localized name** (e.g. Armenian `Օлия`), which does
NOT match `employees.full_name` (`Olya Accounting`). Since per-accountant scoping
keys off the employee identity, every source name MUST be resolved to a real
employee before it is stored:

- `src/lib/ingestion.js` — `ACCOUNTANT_ALIASES` + `resolveAccountant(name)` map a
  source name to `{ accountant_id = employee uuid, accountant_name = full_name }`.
  An unmapped name (e.g. `Էрик`, `հанձнвад`, `-`) resolves to **null on both** — we
  never attribute a problem to an invented person. **Do not store raw source names
  or invented people** (no "Анна Петросян"); add new aliases to BOTH the JS map and
  the SQL table below.
- `supabase/migrations/0003_accountant_aliases.sql` — the `kk_accountant_aliases`
  table (mirror of the JS map) + `kk_norm_name()`; `kk_ingest_problems()` joins it so
  `kk_problems.accountant_id` holds the employee uuid. Re-runnable backfill at the end.
- Bare first name → the `{Name} Accounting` employee; an initial disambiguates
  (`Նаира Մ․` → `Naira Mkhitaryan`). `seed.sql` is local-demo only and also uses real
  employees (uuid + canonical name); demo rows are not loaded in production.

## Auth & per-accountant scoping (ported from ob-dashboards-for-accounters)

This app shares the **same Supabase project** as the OneBusiness dashboards, so it
reuses their `login_codes` table and `resolve_login_code(p_code)` RPC — **do not
create a second copy of either.** There is **no Supabase Auth session**; login is
code-only and reads use the anon key.

- `lib/auth.js` — `normalizeCode` (strip non-alphanumerics, uppercase), `resolveCode`,
  `signInWithCode`, `signOut`. Session stored in localStorage under `kk_dash_login_code`.
- `lib/scope.js` — `SUPERVISOR_ROLES = {head_accountant, ceo, founder, qa, admin}`.
  `seesAllClients`/`canManage` gate visibility; `ownsProblem`/`keepOwnProblems` narrow
  the problem list for regular accountants. Matching is defensive (employee uuid AND
  normalized full_name vs `kk_problems.accountant_id`/`accountant_name`) because there
  is no FK between problems and `employees`.
- `App.jsx` — auth gate (loading → anon/authed/error), `AuthContext` provider, role
  label + sign-out in the topbar. **Review and Admin are management-only** (`canManage`);
  regular accountants see only their own scoped problems on Dashboard & Accountant.
- UI: `components/LoginScreen.jsx`, `LoadingScreen.jsx`, `ErrorScreen.jsx` (plain CSS,
  no Tailwind/icon deps — adapted from the dashboard equivalents).

## Sona work report + praise + «ОЧЕНЬ СРОЧНО» + Telegram (0030 / 0031)

Implements the «форма для Соны, отчёт по КК и уведомление в Telegram» task
(status: `docs/SONA_QC_TASK_STATUS.md`; Telegram deploy: `docs/TELEGRAM_REPORT_SETUP.md`).

- **`kk_sona_checks` (view, 0030)** — read-only projection of Sona's reviews
  (`sqa_reviews`, repo #1) with the accountant resolved via `kk_accountant_aliases`
  (same pattern as `kk_margarita_checks`). Powers the **Sona work report** («Объём
  работы Соны»): companies checked, with/without remarks, by day, by accountant,
  avg score. JS: `buildSonaReport()` in `reports.js`; `fetchSonaChecks()` in `api.js`.
- **Praise / «похвала» (0030)** — owner rule «если позитивно всё … может быть
  похвала, а не тикет». `kk_praise` table + `kk_ingest_praise()` are **additive** and
  never touch `kk_ingest_problems()`: good Margarita evaluations («Хорошо»/«Отлично»)
  + clean Sona reviews (`record_type='other'`) → praise rows (never tickets). Cron
  every 30 min. `FEEDBACK_TYPE` in `constants.js`; `fetchPraise()`; shown as
  «Похвалы» on the dashboard and in reports. Only rows resolving to a real employee.
- **«ОЧЕНЬ СРОЧНО» urgency** — `urgencyLevel()` / `isVeryUrgent()` in `dashboard.js`,
  derived from priority + working-hours SLA (NO schema change): priority 1 + overdue
  = `critical`. Surfaced as a red badge on the dashboard, the accountant card, the
  report and the Telegram message; `prepareDashboard()` adds a `urgent` category.
- **Combined department report (`qualityReport.js`)** — `buildQualityReport()` fuses
  problems + praise + Sona/Margarita checks into ONE report by department and by
  accountant (task req: «один отчёт по отделу и по каждому бухгалтеру»), period-aware
  (day/week/all). `/reports` gained the «Отдел (общий отчёт)» and «Работа Соны» tabs.
- **Telegram (0031 + edge fn)** — `telegramReport.js` (pure, tested) is the message
  spec; `supabase/functions/quality-report-telegram/` fetches + aggregates + sends;
  `0031` schedules it daily (Пн–Пт 19:30) + weekly (Пн 09:30 Yerevan) via pg_cron +
  pg_net. `0031` is a no-op until `app.edge_base_url` / `app.edge_auth` are set, and
  the function needs `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets (not in git).

Cross-repo TODO (repo #1 = Sona's QA platform): the Sona INPUT form (company select
→ pulled accountant/forms) and the after-3rd-check «что улучшить» survey live there.

## Approved daily report replaces the PDF (0033)

Owner decision (2026-07): the QA platform's auto-generated **PDF отчёт бухгалтерии
is retired** — it showed wrong data (e.g. «Общий уровень сервиса: 0%», an
accountant with a critical chat displayed at 100, no per-accountant checked-chats
count). Instead Margarita reviews/edits the generated report on her platform,
**approves** it (stored in `mqa_published_reports`, repo #1 migration
`20260721_mqa_published_reports.sql`), and accountants see ONLY the approved text
here.

- **`kk_published_reports` (view, 0033)** — read-only projection of
  `mqa_published_reports` (same definer-view bridge as `kk_chat_directory` /
  `kk_chat_mailings`), granted to anon/authenticated. Guarded to fail loudly if
  the repo #1 table is missing. JS: `fetchLatestPublishedReport()` in `api.js`
  returns the newest approved report (by `published_at`) or `null`.
- **`/report` page (`Report.jsx`, «Отчёт», all users)** — renders the latest
  approved report body read-only, with its period + publish time. Empty state
  when nothing is published yet. Added to `nav.js` (`manageOnly: false`).
- Correctness of the generated text (service % «—» when no checks, per-accountant
  «Проверено чатов (QA)», critical-violation accountant excluded from «Звезда
  дня») is fixed in repo #1 (`report.ts` / `templates.ts`), so the text Margarita
  approves is already correct. Mailing auto-detection was also broadened in repo
  #1 (v11: service-payment/«оплата услуг» debt reminders, ЗП/document templates).

## Сравнение с базой (ArmSoft / TaxService) + дневной анализ в чат (0034)

Owner ask: «for every day make sure there is the full analysis from supabase
that is sent in the chat (shown/hidden), and for every person's word and every
person's zadacha in the accountant feedback form there is сравнение with the
taxservice/armsoft database». The ground-truth work lives in the **OB Artyom
project** (a different Supabase project, reached via `artyomClient.js`); this app
now cross-references every task/comment against it and posts a daily rollup.

- **`src/lib/artyomCompare.js` (pure, tested `artyomCompare.test.js`)** owns ALL
  the logic so «sent in the chat» === «seen here»:
  - `matchCompany()` — resolves a task/comment's client to `ob_accounting_companies`
    by normalised contract number (Cyrillic/Latin equal, mirrors `mainClient`) then
    exact name; **no fuzzy merge** (similar-but-unequal names don't match).
  - `buildComparison({companies, activities, clientName, contractNo, accountantName,
    taskType})` → per-entity verdict over ArmSoft vs TaxService counts
    (`invoices/reports/applications/balance`): `unmatched` · `no_systems` ·
    `no_work` · `discrepancy` (ТаксСервис−АрмСофт ≠ 0) · `ok`. `TASK_METRIC` points
    the verdict at the metric a task type is really about.
  - `buildDailyAnalysis(activities, {date, comments})` → department + per-accountant
    rollup for one day; `formatDailyAnalysisText()` renders the Telegram HTML.
- **Data path** (all no-ops when Artyom isn't configured — the form still works):
  `api.js` gains `fetchArtyomCompanies` / `fetchArtyomActivities` /
  `fetchArtyomComments` reading the SAME Artyom tables `Accounting.jsx` proved
  (`ob_accounting_companies`, `accounting_activities` with `system_source ∈
  base|armsoft|taxservice`, `accountant_daily_comments`). `useArtyomData()` loads
  the reference data ONCE per page (30-day window) so each card computes locally.
- **UI.** `components/DbComparison.jsx` — collapsible «Сравнение с базой» panel
  (verdict badge always visible; body shows per-system counts + reconciliation
  gap). Wired into **`Tasks.jsx`** (a sub-row under every task = «задача») and
  **`Accountant.jsx` → `ProblemFeedbackCard`** (under every feedback card =
  «слово»). `components/DailyAnalysis.jsx` — the full day analysis, **shown/hidden**
  by a toggle, on `Dashboard.jsx` and `Tasks.jsx`; it fetches the picked day only
  when opened and renders the identical content the chat gets.
- **Chat (0034 + edge fn).** `supabase/functions/daily-db-analysis-telegram/`
  reads the Artyom project over PostgREST (secrets `ARTYOM_SUPABASE_URL` /
  `ARTYOM_SUPABASE_ANON_KEY`), rebuilds the analysis (TS mirror of
  `artyomCompare.js`) and posts it to the ОК group daily. `0034` schedules it
  (every day 19:45 Yerevan) via pg_cron + pg_net; **no-op** until
  `app.edge_base_url` / `app.edge_auth` are set, and needs `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_CHAT_ID` too. Runs "dry" (returns the message) without the bot secrets.

## Templated client notifications — plan → edit/attach → bot sends → log (0035)

Owner decision (2026-07): flip the mailings flow. Instead of accountants sending
client mailings by hand and the platform only DETECTING them afterwards
(`mqa_chat_mailings`), the QA platform now **PLANS** the upcoming notifications
per company for the next 30 days, the accountant **SEES/EDITS/ATTACHES** them
here, and a **BOT SENDS** on schedule — every send **LOGGED** with full text.
Templated client messages go out only via the bot, never hand-typed. If the
accountant does nothing, the bot sends the planned message as-is.

The source-of-truth tables live in repo #1 (margarita-qa-platform migration
`20260723_mqa_notifications_v1.sql`): `mqa_notification_templates` (client
wording per category/subtype/language + `mode` auto/manual + `approved`),
`mqa_planned_notifications` (the 30-day chain + `mqa_notification_edits` audit),
`mqa_notification_attachments` (monthly file / mark-done for MANUAL types),
`mqa_sent_notifications` (the log), and `mqa_chats.language`. AUTO = bot sends
fixed wording (debts/primary_docs, from Naira); MANUAL = accountant must attach a
file / mark done first (salary ведомость, tax report). Live client sending is
GATED OFF (repo #1 sender is dry-run until a template is `approved` AND
`NOTIFICATIONS_SEND_ENABLED=1`).

This app is the accountant/manager UI over that (same shared-DB bridge as the
violation loop 0027):

- **`0035_kk_notifications_bridge.sql`** — read-only definer views
  `kk_planned_notifications` / `kk_notification_templates` /
  `kk_notification_attachments` / `kk_sent_notifications`, and `kk_chat_directory`
  extended with `language` + the resolved responsible accountant
  (`accountant_id`/`accountant_name` via `kk_resolve_employee`) so notifications
  scope to the accountant's own companies. Write RPCs (SECURITY DEFINER, login-code
  auth, ownership via `kk_assert_chat_owner` — own client OR supervisor):
  `kk_edit_notification` (edits are logged — no silent edits), `kk_approve_notification`,
  `kk_cancel_notification`, `kk_attach_notification`. Guarded to fail loudly if the
  repo #1 prerequisite migration is missing.
- **`src/lib/notifications.js`** (pure, tested) — `WILL_SEND_WARNING`, status/mode/
  category labels + badges, `isSendable`/`willBeSent`/`needsAttachment`, and
  `groupByDay` for the manager overview.
- **`src/lib/api.js`** — `fetchPlannedNotifications`/`fetchNotificationTemplates`/
  `fetchNotificationAttachments`/`fetchSentNotifications` (reads) and
  `editPlannedNotification`/`approvePlannedNotification`/`cancelPlannedNotification`/
  `attachNotification` (RPCs, send `getStoredCode()`).
- **`src/pages/Notifications.jsx`** (`/notifications`, all users) — per-company
  upcoming chain with the explicit «это БУДЕТ отправлено» warning, edit/approve/
  cancel, the manual attach section for MANUAL types, and a read-only sent-log per
  client. **`src/pages/NotificationsDaily.jsx`** (`/notifications-daily`,
  management-only) — all notifications grouped by send day (pt.5) with cancel.
- Language auto-detect (chat-name change → alert) is BACKLOG (`mqa_backlog_notes`
  in repo #1), not built.

## Commands

- `npm run dev` — local dev server
- `npm test` — run Vitest once
- `npm run build` — production build to `dist/`

## Env vars (frontend, public)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`  (anon/publishable only — never the service_role key)
