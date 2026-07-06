-- Optional file attachments (documents / screenshots of the work done) that an
-- accountant can add alongside feedback. Files live in the public storage
-- bucket `kk-attachments`; metadata rows live in `kk_problem_attachments` so
-- both the kk app (anon key) and the sona-qa-platform (service role) can list
-- a problem's files and render links.
--
-- Attaching files is NOT required to submit feedback.

-- 1) Public bucket. Public = files are readable via their URL (the apps are
--    internal and the anon key already reads all kk_* tables); uploads still
--    need the insert policy below.
insert into storage.buckets (id, name, public)
values ('kk-attachments', 'kk-attachments', true)
on conflict (id) do nothing;

do $$ begin
  create policy "kk_attachments_read"
    on storage.objects for select
    using (bucket_id = 'kk-attachments');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "kk_attachments_insert"
    on storage.objects for insert
    with check (bucket_id = 'kk-attachments');
exception when duplicate_object then null; end $$;

-- 2) Metadata: one row per uploaded file, attached to the problem.
create table if not exists public.kk_problem_attachments (
  id           uuid        primary key default gen_random_uuid(),
  problem_id   text        not null
                 references public.kk_problems(problem_id) on delete cascade,
  file_name    text        not null,
  storage_path text        not null,
  public_url   text        not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  text,
  created_at   timestamptz not null default now()
);

create index if not exists kk_problem_attachments_problem_id_idx
  on public.kk_problem_attachments (problem_id, created_at);

alter table public.kk_problem_attachments enable row level security;

do $$ begin
  create policy "kk_problem_attachments_select"
    on public.kk_problem_attachments for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "kk_problem_attachments_insert"
    on public.kk_problem_attachments for insert with check (true);
exception when duplicate_object then null; end $$;
