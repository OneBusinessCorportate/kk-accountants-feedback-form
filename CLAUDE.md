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

Problems are created by `kk_ingest_problems()` from (a) the manual Sona
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

## Commands

- `npm run dev` — local dev server
- `npm test` — run Vitest once
- `npm run build` — production build to `dist/`

## Env vars (frontend, public)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`  (anon/publishable only — never the service_role key)
