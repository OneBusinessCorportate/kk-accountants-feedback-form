-- KK Accountants Feedback Form schema
-- Run this in the Supabase SQL Editor (or via the Supabase CLI) on your project.
-- Tables are prefixed with kk_ to avoid collisions with existing tables.

create extension if not exists "pgcrypto";

-- 1. Problems detected by AI / Margarita / Sona / manual
create table if not exists public.kk_problems (
  id                  uuid primary key default gen_random_uuid(),
  problem_id          text unique not null,
  source              text not null default 'manual'
                        check (source in ('ai','margarita_review','sona_review','manual')),
  client_name         text,
  contract_id         text,
  chat_name           text,
  chat_link           text,
  accountant_name     text,
  accountant_id       text,
  priority            int default 2,
  problem_title       text,
  problem_description text,
  ai_comment          text,
  detected_at         timestamptz,
  status              text not null default 'waiting_for_accountant'
                        check (status in (
                          'new','waiting_for_accountant','submitted_by_accountant',
                          'in_review','fixed','explained_accepted','returned_to_accountant'
                        )),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists kk_problems_accountant_id_idx on public.kk_problems (accountant_id);
create index if not exists kk_problems_status_idx        on public.kk_problems (status);
create index if not exists kk_problems_source_idx        on public.kk_problems (source);

-- 2. Accountant feedback (one row per submission, linked by problem_id)
create table if not exists public.kk_accountant_feedback (
  id                uuid primary key default gen_random_uuid(),
  problem_id        text not null references public.kk_problems(problem_id) on delete cascade,
  accountant_name   text,
  accountant_id     text,
  situation_comment text not null,
  solution_comment  text not null,
  submitted_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index if not exists kk_accountant_feedback_problem_id_idx
  on public.kk_accountant_feedback (problem_id);

-- 3. Reviewer / manager actions (linked by problem_id)
create table if not exists public.kk_review_actions (
  id             uuid primary key default gen_random_uuid(),
  problem_id     text not null references public.kk_problems(problem_id) on delete cascade,
  reviewer_name  text,
  action         text not null
                   check (action in ('fixed','explained_accepted','returned_to_accountant','in_review')),
  review_comment text,
  created_at     timestamptz not null default now()
);

create index if not exists kk_review_actions_problem_id_idx
  on public.kk_review_actions (problem_id);

-- Keep updated_at fresh on kk_problems
create or replace function public.kk_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists kk_problems_set_updated_at on public.kk_problems;
create trigger kk_problems_set_updated_at
  before update on public.kk_problems
  for each row execute function public.kk_set_updated_at();

-- Row Level Security.
-- This is an internal tool with no end-user auth; the frontend uses the anon key.
-- We enable RLS and add permissive policies for the anon + authenticated roles so the
-- app works while still scoping access explicitly to these three tables only.
-- If you later add Supabase Auth, tighten these policies.
alter table public.kk_problems            enable row level security;
alter table public.kk_accountant_feedback enable row level security;
alter table public.kk_review_actions      enable row level security;

drop policy if exists kk_problems_all on public.kk_problems;
create policy kk_problems_all on public.kk_problems
  for all to anon, authenticated using (true) with check (true);

drop policy if exists kk_accountant_feedback_all on public.kk_accountant_feedback;
create policy kk_accountant_feedback_all on public.kk_accountant_feedback
  for all to anon, authenticated using (true) with check (true);

drop policy if exists kk_review_actions_all on public.kk_review_actions;
create policy kk_review_actions_all on public.kk_review_actions
  for all to anon, authenticated using (true) with check (true);
