-- Task manager: per-client, per-accountant tasks with fixed types.
-- Covers mailings (рассылка), reports (отчёты), receipts (квитанции),
-- audit links, client contacts, and general tasks.

create table if not exists public.kk_tasks (
  id              uuid primary key default gen_random_uuid(),
  task_type       text not null check (task_type in ('mailing','report','receipt','audit','contact','other')),
  title           text not null,
  client_name     text,
  chat_name       text,
  chat_link       text,
  accountant_id   text,
  accountant_name text,
  due_date        date,
  done            boolean not null default false,
  done_at         timestamptz,
  done_by         text,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists kk_tasks_accountant_id_idx on public.kk_tasks (accountant_id);
create index if not exists kk_tasks_done_idx          on public.kk_tasks (done);
create index if not exists kk_tasks_task_type_idx     on public.kk_tasks (task_type);
create index if not exists kk_tasks_client_name_idx   on public.kk_tasks (client_name);

drop trigger if exists kk_tasks_set_updated_at on public.kk_tasks;
create trigger kk_tasks_set_updated_at
  before update on public.kk_tasks
  for each row execute function public.kk_set_updated_at();
