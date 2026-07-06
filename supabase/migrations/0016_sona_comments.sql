-- Cross-platform comment thread: lets Sona post follow-up notes on a kk_problem
-- after reading the accountant's feedback, and lets kk supervisors reply back.
-- Both the kk app (anon key) and the sona-qa-platform (service-role) can read;
-- the sona server writes via service-role (bypasses RLS); kk supervisors write
-- via anon client (covered by the insert policy below).
--
-- Link: kk_problems.problem_id = 'sona:' || sqa_tickets.id
-- so comments are always attached to the original ticket's problem row.

create table if not exists public.kk_sona_comments (
  id          uuid        primary key default gen_random_uuid(),
  problem_id  text        not null
                references public.kk_problems(problem_id) on delete cascade,
  author      text        not null default 'Sona',
  body        text        not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);

create index if not exists kk_sona_comments_problem_id_idx
  on public.kk_sona_comments (problem_id, created_at);

alter table public.kk_sona_comments enable row level security;

create policy "kk_sona_comments_select"
  on public.kk_sona_comments for select using (true);

create policy "kk_sona_comments_insert"
  on public.kk_sona_comments for insert with check (true);
