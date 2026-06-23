-- Accountant comments table (visible to admins)
create table if not exists public.kk_accountant_comments (
  id                uuid primary key default gen_random_uuid(),
  problem_id        text references public.kk_problems(problem_id) on delete cascade,
  accountant_id     text,
  accountant_name   text,
  comment_text      text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists kk_accountant_comments_problem_id_idx 
  on public.kk_accountant_comments (problem_id);
create index if not exists kk_accountant_comments_accountant_id_idx 
  on public.kk_accountant_comments (accountant_id);

alter table public.kk_accountant_comments enable row level security;

drop policy if exists kk_accountant_comments_all on public.kk_accountant_comments;
create policy kk_accountant_comments_all on public.kk_accountant_comments
  for all to anon, authenticated using (true) with check (true);
