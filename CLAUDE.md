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

Problems are created by `kk_ingest_problems()` from the Sona (`sqa_tickets`) and
Margarita (`mqa_violations`) QA systems in the same project. Those sources record
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
