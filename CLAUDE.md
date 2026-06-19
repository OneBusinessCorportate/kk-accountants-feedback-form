# Project notes for Claude

## Workflow preference (set by the owner)

- Before pushing, **always run the test suite** (`npm test`) and the build (`npm run build`).
- If everything passes, **push directly to `main`**.
- If tests fail, **fix the issues first**, re-run, and only push once green.

## Project overview

Internal OneBusiness web app for accountant feedback on client problems.
React + Vite frontend, Supabase (Postgres) backend, deployed on Render as a Static Site.

- `src/pages/` — Dashboard `/`, Accountant `/accountant`, Review `/review`, Admin `/admin`
- `src/lib/` — `supabaseClient.js`, `constants.js`, `api.js` (all data access)
- `src/lib/*.test.js` — Vitest unit tests (constants integrity + api call flow)
- `supabase/migrations/0001_init.sql` — schema (`kk_problems`, `kk_accountant_feedback`, `kk_review_actions`)

## Commands

- `npm run dev` — local dev server
- `npm test` — run Vitest once
- `npm run build` — production build to `dist/`

## Env vars (frontend, public)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`  (anon/publishable only — never the service_role key)
