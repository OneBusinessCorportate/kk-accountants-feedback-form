# KK · Обратная связь бухгалтеров по проблемам клиентов

Internal OneBusiness web app where every client problem (detected by **AI**,
**Margarita review**, **Sona review**, or created **manually**) is routed to the
responsible accountant. The accountant explains the situation and proposes a
solution; a manager then reviews and marks the problem as **fixed** or
**explained / accepted**, or returns it to the accountant.

Built with **React + Vite** on the frontend and **Supabase** (Postgres) as the
backend. Deployable on **Render** as a Static Site.

---

## Features

- **Dashboard (`/`)** — totals: all problems, waiting for accountant, submitted /
  in review, fixed, accepted.
- **Accountant (`/accountant`)** — filter by accountant, see assigned problems,
  fill two required fields (*situation* + *solution*). Save is disabled until both
  are filled. Saving sets status to `submitted_by_accountant`, stores the
  submission timestamp and accountant, and surfaces the problem in review.
- **Review (`/review`)** — submitted problems with the original problem + the
  accountant's comments. Buttons: **Mark as Fixed**, **Mark as Explained /
  Accepted**, **Return to Accountant** (return requires a comment). Optional
  reviewer name + review comment.
- **Admin (`/admin`)** — create a test problem manually and browse all problems
  in a table.

Loading / error / empty states and responsive layout are included throughout.

---

## Tech stack

- React 18 + Vite 5
- React Router 6
- `@supabase/supabase-js` v2
- Plain CSS (no UI framework) for a lightweight internal-dashboard look

---

## Project structure

```
.
├─ index.html
├─ package.json
├─ vite.config.js
├─ .env.example                # template for the two required env vars
├─ public/
│  └─ _redirects               # SPA fallback for Render (client-side routing)
├─ supabase/
│  ├─ migrations/0001_init.sql # schema: tables, indexes, trigger, RLS policies
│  └─ seed.sql                 # optional demo data
└─ src/
   ├─ main.jsx                 # entry + BrowserRouter
   ├─ App.jsx                  # top nav + routes + env-config guard
   ├─ index.css                # all styling
   ├─ lib/
   │  ├─ supabaseClient.js     # Supabase client from env vars
   │  ├─ constants.js          # statuses, sources, labels
   │  └─ api.js                # all data access (read/write helpers)
   ├─ components/
   │  ├─ StatusBadge.jsx
   │  ├─ ProblemMeta.jsx
   │  └─ States.jsx            # Loading / ErrorMessage / Empty
   └─ pages/
      ├─ Dashboard.jsx
      ├─ Accountant.jsx
      ├─ Review.jsx
      └─ Admin.jsx
```

---

## 1. Local setup

Requires Node 18+.

```bash
npm install
cp .env.example .env     # then fill in your Supabase values (see below)
npm run dev              # http://localhost:5173
```

Build / preview the production bundle:

```bash
npm run build            # outputs to dist/
npm run preview
```

---

## 2. Environment variables

Only **two** variables are needed. Both are **public** client values — never put
the Supabase `service_role` key in the frontend.

| Variable                 | Description                                  |
| ------------------------ | -------------------------------------------- |
| `VITE_SUPABASE_URL`      | `https://<your-project-ref>.supabase.co`     |
| `VITE_SUPABASE_ANON_KEY` | The project **anon** / **publishable** key   |

Find them in the Supabase dashboard → **Project Settings → API**
(URL + the `anon`/`publishable` key).

Locally they go in `.env`. On Render they are set in the dashboard (see below).
Vite only exposes variables prefixed with `VITE_`, and they are read at **build
time**, so changing them on Render requires a redeploy.

If either variable is missing, the app renders a clear configuration error
instead of failing silently.

---

## 3. Database — SQL to run in Supabase

Open **Supabase → SQL Editor** and run the contents of
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). It is
idempotent (`create table if not exists`, `create policy` after `drop policy if
exists`) so it is safe to re-run.

It creates three tables linked by a unique `problem_id` (not by `contract_id`,
because one problem can repeat and come from different sources):

1. **`kk_problems`** — the problems themselves (source, client, contract, chat,
   assigned accountant, priority, title, description, AI comment, status,
   timestamps). A trigger keeps `updated_at` fresh.
2. **`kk_accountant_feedback`** — one row per submission: `situation_comment`
   and `solution_comment` (both `NOT NULL`), accountant, `submitted_at`.
3. **`kk_review_actions`** — manager actions (`fixed`, `explained_accepted`,
   `returned_to_accountant`, `in_review`) with an optional `review_comment`.

**Statuses:** `new`, `waiting_for_accountant`, `submitted_by_accountant`,
`in_review`, `fixed`, `explained_accepted`, `returned_to_accountant`.
**Sources:** `ai`, `margarita_review`, `sona_review`, `manual`.

Optionally load demo rows with [`supabase/seed.sql`](supabase/seed.sql).

### A note on security (RLS)

This is an internal tool with **no end-user login**, so the frontend talks to
Supabase with the anon key. The migration **enables Row Level Security** on all
three `kk_` tables and adds permissive policies for the `anon` + `authenticated`
roles so the app works. This means anyone with the anon key and the URL can
read/write these tables — acceptable for an internal-only deployment, but if you
later expose it more widely, add Supabase Auth and tighten the policies (e.g.
accountants only see their own rows, only managers can run review actions).

---

## 4. Deploy on Render (Static Site)

1. Push this repo to GitHub.
2. In Render → **New → Static Site**, connect the repository.
3. Settings:
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
4. **Environment → Environment Variables**, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy. The included `public/_redirects` (`/* /index.html 200`) makes
   client-side routes like `/review` work on direct load / refresh.

Whenever you change an env var, trigger a **Manual Deploy / Clear cache &
deploy**, since Vite inlines them at build time.

---

## 5. How to test manually

1. Run the SQL migration (and optionally `seed.sql`) in Supabase.
2. Start the app (`npm run dev`) or open the Render URL.
3. **Admin (`/admin`)** — create a problem (the `problem_id` is pre-filled with a
   suggestion). It appears in the table below and on the dashboard.
4. **Accountant (`/accountant`)** — pick the accountant in the filter (or leave
   "Все бухгалтеры"). Open a problem; confirm **Save is disabled** until *both*
   the situation and solution fields are filled. Save it.
   - The problem disappears from the accountant queue and its status becomes
     `submitted_by_accountant`.
5. **Review (`/review`)** — the submitted problem appears with the original
   details and the accountant's situation/solution.
   - Try **Return to Accountant** without a comment → you get a validation error.
     Add a comment and return it → it goes back to the accountant queue as
     `returned_to_accountant`.
   - Or **Mark as Fixed** / **Explained / Accepted** → tick "Показывать закрытые"
     to keep seeing it.
6. **Dashboard (`/`)** — counts update to reflect the changes.

To verify the 10 records from the task brief, create/submit/review ~10 problems
and confirm each one moves cleanly through
`waiting_for_accountant → submitted_by_accountant → fixed/explained_accepted`.
