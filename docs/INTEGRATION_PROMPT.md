# Integration prompt — connecting problem sources to the KK feedback app

> Paste this prompt when you attach the **2 other repositories** (the systems that
> detect client problems) alongside `kk-accountants-feedback-form`. Fill in the two
> repo names where marked. Everything else is context the agent needs.

---

## Prompt to paste

You are working across three repositories:

1. **`kk-accountants-feedback-form`** — the feedback app (the **destination / "sink"**).
   It is already built and live. Do **not** break its data contract or UI.
2. **`<REPO A — first problem source>`** — a system that detects client problems.
3. **`<REPO B — second problem source>`** — another system that detects client problems.

### What the feedback app already is

- React + Vite frontend, Supabase (Postgres) backend, deployed on Render as a Static Site.
- Supabase project: **OB FAQ** (`project_ref: fjsogozwseqoxgddjeig`).
- Three tables, all linked by a **unique text `problem_id`** (never by `contract_id` alone,
  because one problem can repeat and come from different sources):
  - `kk_problems` — one row per problem. Key columns: `problem_id` (unique),
    `source` (`ai` | `margarita_review` | `sona_review` | `manual`), `client_name`,
    `contract_id`, `chat_name`, `chat_link`, `accountant_name`, `accountant_id`,
    `priority` (1=high…3=low), `problem_title`, `problem_description`, `ai_comment`,
    `detected_at`, `status`, `created_at`, `updated_at`.
  - `kk_accountant_feedback` — the accountant's `situation_comment` + `solution_comment`.
  - `kk_review_actions` — manager decisions.
- Status lifecycle: `new` → `waiting_for_accountant` → `submitted_by_accountant`
  → `in_review` → `fixed` | `explained_accepted`, or `returned_to_accountant`.
- New problems should land as `waiting_for_accountant`.

### Your task

Make problems detected in **Repo A** and **Repo B** automatically appear for the
correct accountant in the feedback app — without duplicates and without changing
how accountants/reviewers use the app.

Do it in this order:

1. **Explore both source repos first.** For each, find: where problems live
   (DB table, API, file/export, queue), which fields are available, how the
   responsible **accountant** is identified, and what stable identifier can serve
   as a unique key. Report what you found before writing integration code.
2. **Write a field mapping** from each source to `kk_problems` columns. Decide the
   `source` value for each repo (use `ai`, `margarita_review`, or `sona_review` as
   appropriate; add a new allowed value via migration only if truly needed).
3. **Define the `problem_id` rule.** It must be **stable** (same problem → same id
   on re-runs) and **globally unique** across sources. Prefix by source, e.g.
   `ai:<source-record-id>` or `sona:<contract>-<detected-date>-<hash>`. Never rely
   on `contract_id` alone.
4. **Build the simplest ingestion path that fits** — pick one, don't over-engineer:
   - a Supabase SQL view/function + scheduled upsert, or
   - a small sync script (Node) the source repo runs, or
   - a Supabase Edge Function the sources call on detection.
   Whatever you choose, the write must be an **idempotent upsert on `problem_id`**
   (`on conflict (problem_id) do update`/`do nothing`) so re-running never creates
   duplicates and never clobbers an accountant's in-progress feedback.
5. **Respect the security model.** The frontend uses only the anon/publishable key.
   Any ingestion that needs elevated rights runs server-side (script/edge function)
   with the service_role key kept **out of the frontend and out of git**.

### Keep it simple for accountants (hard requirement)

The people using `/accountant` are accountants, not engineers. Every change must keep
their experience effortless:

- **Russian UI, plain language**, no technical jargon, no internal ids shown unless useful.
- An accountant sees **only the problems assigned to them**, newest/most-urgent first.
- Each problem is **one clear card**: client, what happened, link to the chat, and the
  **two fields they must fill** — *situation* and *solution* — with helper placeholders.
- **Save stays disabled until both fields are filled** (already implemented — keep it).
- After saving, give clear confirmation and remove it from their queue.
- Friendly **empty/loading/error states** ("Нет проблем — всё в порядке 🎉").
- Works on a phone (responsive). No setup, no login friction for internal use.
- If you add fields, keep them optional and few — never make the form heavier.

### Guardrails & workflow

- Do **not** change existing statuses, the `problem_id` contract, or the accountant/
  reviewer flows in a breaking way.
- Ingestion must be safe to re-run and must not overwrite `kk_accountant_feedback`.
- Follow this repo's workflow: run `npm test` and `npm run build`; fix failures first;
  push to `main` only when green. Add tests for any new mapping/ingestion logic.

### Report back

1. What each source repo exposes and the field mapping you chose.
2. The `problem_id` derivation rule and why it's unique + stable.
3. The ingestion mechanism and how to run/schedule it.
4. Any new env vars or migrations, and where secrets go.
5. How to test the end-to-end flow (source detects → appears for accountant →
   submitted → reviewed).
