alter table public.kk_tasks enable row level security;

drop policy if exists kk_tasks_all on public.kk_tasks;
create policy kk_tasks_all on public.kk_tasks for all using (true) with check (true);
