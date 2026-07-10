-- 0025 — Accountant appeals, acknowledgements, and QA-issue tasks.
--
-- Adds the reaction loop on top of every QA issue (a row in kk_problems):
--   * «Ознакомлен»       — the accountant confirms they have seen & accept the
--                          issue                         → kk_problem_acknowledgements
--   * «Подать апелляцию» — the accountant disputes it with a short comment
--                          → kk_problem_appeals (status 'pending')
--   * Margarita/management approve or reject each appeal, optionally with a
--     comment → kk_problem_appeals.status becomes 'approved' / 'rejected'.
--
-- The current reaction is also mirrored onto kk_problems.status so the existing
-- queues / dashboard filters keep working:
--   acknowledged      — seen & accepted, drops out of the actionable queue
--   appeal_pending    — appeal awaiting a decision
--   appeal_approved   — appeal upheld → issue dismissed (also verdict
--                       'not_problematic', so it leaves dashboard counts, same
--                       as a reviewer-confirmed false positive)
--   appeal_rejected   — appeal denied → issue stays active/confirmed
--
-- kk_tasks gains an optional link to the source QA issue plus an open /
-- in_progress / done status so QA-driven follow-ups live in the task queue.

begin;

-- ---------------------------------------------------------------------------
-- 1. Extend kk_problems.status with the appeal / acknowledgement states.
-- ---------------------------------------------------------------------------
alter table public.kk_problems drop constraint if exists kk_problems_status_check;
alter table public.kk_problems
  add constraint kk_problems_status_check check (status in (
    'new',
    'waiting_for_accountant',
    'submitted_by_accountant',
    'in_review',
    'fixed',
    'explained_accepted',
    'returned_to_accountant',
    'auto_resolved',
    'acknowledged',
    'appeal_pending',
    'appeal_approved',
    'appeal_rejected'
  ));

-- ---------------------------------------------------------------------------
-- 2. Acknowledgements — one «Ознакомлен» per problem (idempotent upsert).
-- ---------------------------------------------------------------------------
create table if not exists public.kk_problem_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  problem_id      text not null references public.kk_problems(problem_id) on delete cascade,
  accountant_id   text,
  accountant_name text,
  note            text,
  created_at      timestamptz not null default now()
);

create unique index if not exists kk_prob_ack_problem_uniq
  on public.kk_problem_acknowledgements (problem_id);

-- ---------------------------------------------------------------------------
-- 3. Appeals — an accountant's dispute + the reviewer's decision.
-- ---------------------------------------------------------------------------
create table if not exists public.kk_problem_appeals (
  id                 uuid primary key default gen_random_uuid(),
  problem_id         text not null references public.kk_problems(problem_id) on delete cascade,
  accountant_id      text,
  accountant_name    text,
  comment            text not null,
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected')),
  resolved_by        text,
  resolution_comment text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);

create index if not exists kk_prob_appeals_problem_idx
  on public.kk_problem_appeals (problem_id, created_at desc);
create index if not exists kk_prob_appeals_status_idx
  on public.kk_problem_appeals (status);
create index if not exists kk_prob_appeals_accountant_idx
  on public.kk_problem_appeals (accountant_id);

-- At most ONE pending appeal per problem: a new appeal is only allowed once the
-- previous one has been resolved (approved/rejected). Req 9.
create unique index if not exists kk_prob_appeals_one_pending
  on public.kk_problem_appeals (problem_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 4. Tasks: link a task to the source QA issue + open/in_progress/done status.
-- ---------------------------------------------------------------------------
alter table public.kk_tasks
  add column if not exists problem_id text
    references public.kk_problems(problem_id) on delete set null;

alter table public.kk_tasks
  add column if not exists status text not null default 'open';

alter table public.kk_tasks drop constraint if exists kk_tasks_status_check;
alter table public.kk_tasks
  add constraint kk_tasks_status_check
    check (status in ('open', 'in_progress', 'done'));

-- Keep the existing `done` flag consistent with the richer status for old rows.
update public.kk_tasks set status = case when done then 'done' else 'open' end
where status is null or status not in ('open', 'in_progress', 'done');

-- Allow a 'qa' task_type for follow-ups raised from a QA issue.
alter table public.kk_tasks drop constraint if exists kk_tasks_task_type_check;
alter table public.kk_tasks
  add constraint kk_tasks_task_type_check
    check (task_type in ('mailing', 'report', 'receipt', 'audit', 'contact', 'qa', 'other'));

create index if not exists kk_tasks_problem_idx on public.kk_tasks (problem_id);
create index if not exists kk_tasks_status_idx on public.kk_tasks (status);

-- ---------------------------------------------------------------------------
-- 5. RLS — same permissive anon/authenticated access as the other kk_ tables
--    (the frontend uses the anon key; per-accountant scoping is enforced in the
--    app layer, exactly like kk_problems / kk_accountant_feedback). Idempotent.
-- ---------------------------------------------------------------------------
alter table public.kk_problem_acknowledgements enable row level security;
alter table public.kk_problem_appeals          enable row level security;

do $$
begin
  create policy kk_prob_ack_select on public.kk_problem_acknowledgements for select using (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy kk_prob_ack_insert on public.kk_problem_acknowledgements for insert with check (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy kk_prob_ack_update on public.kk_problem_acknowledgements for update using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$
begin
  create policy kk_prob_appeals_select on public.kk_problem_appeals for select using (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy kk_prob_appeals_insert on public.kk_problem_appeals for insert with check (true);
exception when duplicate_object then null; end $$;
do $$
begin
  create policy kk_prob_appeals_update on public.kk_problem_appeals for update using (true) with check (true);
exception when duplicate_object then null; end $$;

commit;
