-- 0035 — Automated template notifications (шаблонные рассылки).
--
-- Template notifications are sent ONLY automatically by the bot; accountants
-- review the 30-day chain, attach manual files, and may EDIT a planned message
-- (button + audit log, never a raw field) — the send TIME is fixed. Managers
-- get a by-day view; every sent message is logged. See templates.js /
-- notifications.js (JS spec) and docs/TEMPLATE_NOTIFICATIONS.md.
--
-- ISOLATION (locked from the start): the SPA has no Supabase Auth session
-- (identity = a login code), so these tables have RLS enabled with NO anon
-- policy — anon/authenticated cannot read or write them directly. All reads are
-- scoped SECURITY DEFINER RPCs (kk_list_*) that return only the caller's own
-- clients (supervisors see all); all attributable writes are SECURITY DEFINER
-- RPCs resolving the login code (the kk_acknowledge_violation pattern, 0027).
-- The bot uses the service-role key and bypasses RLS.

-- Prerequisites (fail loudly, like 0027/0033).
do $$
begin
  if to_regclass('public.mqa_chats') is null
     or to_regclass('public.client_telegram_chats') is null
     or to_regclass('public.kk_tasks') is null then
    raise exception 'Prerequisite missing: mqa_chats / client_telegram_chats / kk_tasks';
  end if;
  if not exists (select 1 from pg_proc where proname='kk_resolve_employee') then
    raise exception 'Prerequisite missing: kk_resolve_employee() (0003)';
  end if;
  if not exists (select 1 from pg_proc where proname='resolve_login_code') then
    raise exception 'Prerequisite missing: resolve_login_code() (shared)';
  end if;
end $$;

-- ---- Tables ----------------------------------------------------------------
create table if not exists public.kk_company_settings (
  agr_no           text primary key,               -- contract (mqa_chats.agr_no)
  language         text not null default 'RU' check (language in ('RU','AM','ENG')),
  telegram_chat_id text,                            -- numeric id from chat_link
  bot_can_send     boolean not null default false,  -- bot verified as chat member
  active           boolean not null default true,   -- mirrors mqa_chats status
  accountant_id    text,                            -- resolved employee uuid (scoping)
  accountant_name  text,
  client_name      text,
  chat_name        text,
  updated_at       timestamptz not null default now()
);

create table if not exists public.kk_mailing_schedule (
  id           uuid primary key default gen_random_uuid(),
  agr_no       text not null,
  category     text not null check (category in ('primary_docs','debts','salary','main_taxes')),
  subtype      text not null,
  day_of_month int  not null check (day_of_month between 1 and 31),
  send_hour    int  not null default 11 check (send_hour between 0 and 23),
  send_minute  int  not null default 0  check (send_minute between 0 and 59),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now(),
  unique (agr_no, category, subtype)
);
create index if not exists kk_mailing_schedule_agr_idx on public.kk_mailing_schedule (agr_no);

create table if not exists public.kk_planned_mailings (
  id              uuid primary key default gen_random_uuid(),
  agr_no          text not null,
  client_name     text,
  chat_name       text,
  category        text not null check (category in ('primary_docs','debts','salary','main_taxes')),
  subtype         text not null,
  period          text not null,                    -- YYYYMM
  language        text not null default 'RU',
  scheduled_at    timestamptz not null,             -- FIXED send time
  composed_text   text not null default '',
  accountant_id   text,
  accountant_name text,
  status          text not null default 'planned'
                    check (status in ('planned','edited','awaiting_file','covered','sent','skipped','failed')),
  edited          boolean not null default false,
  is_test         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (agr_no, category, subtype, period, is_test)
);
create index if not exists kk_planned_mailings_sched_idx on public.kk_planned_mailings (scheduled_at);
create index if not exists kk_planned_mailings_agr_idx   on public.kk_planned_mailings (agr_no);

create table if not exists public.kk_planned_mailing_edits (
  id           uuid primary key default gen_random_uuid(),
  planned_id   uuid not null references public.kk_planned_mailings(id) on delete cascade,
  old_text     text, new_text text,
  edited_by    text, edited_by_id uuid,
  edited_at    timestamptz not null default now()
);
create index if not exists kk_planned_mailing_edits_planned_idx on public.kk_planned_mailing_edits (planned_id);

create table if not exists public.kk_sent_notifications (
  id                  uuid primary key default gen_random_uuid(),
  agr_no              text not null,
  client_name         text, category text not null, subtype text, language text,
  text                text not null,
  telegram_chat_id    text, telegram_message_id text,
  is_test             boolean not null default false,
  sent_at             timestamptz not null default now(),
  planned_id          uuid references public.kk_planned_mailings(id) on delete set null
);
create index if not exists kk_sent_notifications_agr_idx  on public.kk_sent_notifications (agr_no);
create index if not exists kk_sent_notifications_sent_idx on public.kk_sent_notifications (sent_at);

create table if not exists public.kk_manual_mailing_assets (
  id           uuid primary key default gen_random_uuid(),
  agr_no       text not null, period text not null,
  kind         text not null check (kind in ('salary_sheet','tax_report')),
  storage_path text, file_name text, public_url text,
  marked_done  boolean not null default false,
  note         text, uploaded_by text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (agr_no, period, kind)
);
create index if not exists kk_manual_mailing_assets_agr_idx on public.kk_manual_mailing_assets (agr_no);

-- ---- RLS: enable, NO anon policies (deny-all), revoke direct grants ---------
-- Access is ONLY via the scoped SECURITY DEFINER RPCs below + the bot's
-- service-role key. There are intentionally no permissive `using (true)`
-- policies for these tables — that is the role-isolation guarantee.
do $$
declare t text;
begin
  foreach t in array array[
    'kk_company_settings','kk_mailing_schedule','kk_planned_mailings',
    'kk_planned_mailing_edits','kk_sent_notifications','kk_manual_mailing_assets'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- drop any legacy permissive policies from earlier iterations
    execute (select coalesce(string_agg(format('drop policy %I on public.%I;', policyname, t), ' '), '')
             from pg_policies where schemaname='public' and tablename=t);
  end loop;
end $$;
revoke all on
  public.kk_company_settings, public.kk_mailing_schedule, public.kk_planned_mailings,
  public.kk_planned_mailing_edits, public.kk_sent_notifications, public.kk_manual_mailing_assets
  from anon, authenticated;

-- ---- Identity helper: who is calling + may they see everyone ----------------
create or replace function public.kk_caller(p_login_code text,
  out employee_id uuid, out is_all boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_can_all boolean;
begin
  select r.employee_id, r.role, coalesce(r.can_see_all,false)
    into employee_id, v_role, v_can_all
  from public.resolve_login_code(p_login_code) r limit 1;
  if employee_id is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode='28000';
  end if;
  is_all := v_can_all or lower(coalesce(v_role,'')) in ('head_accountant','ceo','founder','qa','admin');
end; $$;
revoke all on function public.kk_caller(text) from public;

-- chat_link → numeric telegram id (mirror of notifications.js / mqa_norm_tg_id)
create or replace function public.kk_extract_tg_id(p_link text)
returns text language sql immutable as $$
  select case when p_link is null then null else (
    with m as (select (regexp_match(p_link,'#(-?\d+)'))[1] raw)
    select case when raw is null then null else (
      with s as (select ltrim(raw,'-+') v)
      select case when v ~ '^\d+$' and left(v,3)='100' and length(v)>=13 then substr(v,4) else v end from s
    ) end from m
  ) end
$$;

-- ---- Scoped reads (return only the caller's own clients) --------------------
create or replace function public.kk_list_company_settings(p_login_code text)
returns setof public.kk_company_settings language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
  select * into c from public.kk_caller(p_login_code);
  return query select * from public.kk_company_settings s
    where s.active and (c.is_all or s.accountant_id = c.employee_id::text);
end; $$;

create or replace function public.kk_list_mailing_schedule(p_login_code text)
returns setof public.kk_mailing_schedule language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
  select * into c from public.kk_caller(p_login_code);
  return query select sc.* from public.kk_mailing_schedule sc
    where c.is_all or exists (select 1 from public.kk_company_settings s
      where s.agr_no=sc.agr_no and s.accountant_id=c.employee_id::text);
end; $$;

create or replace function public.kk_list_planned_mailings(p_login_code text, p_include_test boolean default false)
returns setof public.kk_planned_mailings language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
  select * into c from public.kk_caller(p_login_code);
  return query select m.* from public.kk_planned_mailings m
    where (p_include_test or m.is_test=false)
      and (c.is_all or m.accountant_id=c.employee_id::text)
    order by m.scheduled_at;
end; $$;

create or replace function public.kk_list_planned_mailing_edits(p_login_code text, p_planned_id uuid)
returns setof public.kk_planned_mailing_edits language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; v_owner text; begin
  select * into c from public.kk_caller(p_login_code);
  select accountant_id into v_owner from public.kk_planned_mailings where id=p_planned_id;
  if not c.is_all and v_owner is not null and v_owner<>c.employee_id::text then
    raise exception 'Недоступно.' using errcode='42501'; end if;
  return query select e.* from public.kk_planned_mailing_edits e
    where e.planned_id=p_planned_id order by e.edited_at desc;
end; $$;

create or replace function public.kk_list_sent_notifications(p_login_code text, p_limit int default 500)
returns setof public.kk_sent_notifications language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
  select * into c from public.kk_caller(p_login_code);
  return query select n.* from public.kk_sent_notifications n
    where c.is_all or exists (select 1 from public.kk_company_settings s
      where s.agr_no=n.agr_no and s.accountant_id=c.employee_id::text)
    order by n.sent_at desc limit greatest(1, least(p_limit,2000));
end; $$;

create or replace function public.kk_list_manual_assets(p_login_code text, p_period text default null)
returns setof public.kk_manual_mailing_assets language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
  select * into c from public.kk_caller(p_login_code);
  return query select a.* from public.kk_manual_mailing_assets a
    where (p_period is null or a.period=p_period)
      and (c.is_all or exists (select 1 from public.kk_company_settings s
        where s.agr_no=a.agr_no and s.accountant_id=c.employee_id::text));
end; $$;

-- ---- Attributable writes ----------------------------------------------------
-- Attach a file / mark done (ownership-checked). File bytes go to Storage
-- client-side; only the private path is stored (no public url).
create or replace function public.kk_save_manual_asset(
  p_login_code text, p_agr_no text, p_period text, p_kind text,
  p_storage_path text, p_file_name text, p_marked_done boolean, p_note text)
returns public.kk_manual_mailing_assets language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; v_owner text; v_found boolean; v_row public.kk_manual_mailing_assets; begin
  select * into c from public.kk_caller(p_login_code);
  if p_kind not in ('salary_sheet','tax_report') then
    raise exception 'Недопустимый тип вложения.' using errcode='22023'; end if;
  select accountant_id, true into v_owner, v_found from public.kk_company_settings where agr_no=p_agr_no;
  if not v_found then raise exception 'Неизвестная компания.' using errcode='P0002'; end if;
  -- deny when the company has no resolved owner (unless supervisor): never let
  -- a valid code write for an unassigned/unknown contract.
  if not c.is_all and (v_owner is null or v_owner<>c.employee_id::text) then
    raise exception 'Можно вкладывать файлы только своим клиентам.' using errcode='42501'; end if;
  insert into public.kk_manual_mailing_assets
    (agr_no,period,kind,storage_path,file_name,public_url,marked_done,note,uploaded_by,updated_at)
  values (p_agr_no,p_period,p_kind,p_storage_path,p_file_name,null,
          coalesce(p_marked_done, p_storage_path is not null), p_note,
          coalesce((select full_name from public.resolve_login_code(p_login_code) limit 1),'unknown'), now())
  on conflict (agr_no,period,kind) do update
    set storage_path=coalesce(excluded.storage_path,kk_manual_mailing_assets.storage_path),
        file_name=coalesce(excluded.file_name,kk_manual_mailing_assets.file_name),
        marked_done=excluded.marked_done or kk_manual_mailing_assets.marked_done,
        note=coalesce(excluded.note,kk_manual_mailing_assets.note),
        uploaded_by=excluded.uploaded_by, updated_at=now()
  returning * into v_row;
  return v_row;
end; $$;

-- Edit a planned message by id (button + audit log). Time never changes here.
create or replace function public.kk_edit_planned_mailing(p_planned_id uuid, p_new_text text, p_login_code text)
returns table(id uuid, status text, composed_text text, updated_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; v_old text; v_owner text; begin
  select * into c from public.kk_caller(p_login_code);
  if p_new_text is null or length(btrim(p_new_text))=0 then
    raise exception 'Текст сообщения не может быть пустым.' using errcode='22023'; end if;
  select composed_text, accountant_id into v_old, v_owner from public.kk_planned_mailings where kk_planned_mailings.id=p_planned_id;
  if not found then raise exception 'Планируемое сообщение не найдено.' using errcode='P0002'; end if;
  if not c.is_all and (v_owner is null or v_owner<>c.employee_id::text) then
    raise exception 'Можно редактировать только собственные рассылки.' using errcode='42501'; end if;
  update public.kk_planned_mailings set composed_text=p_new_text, status='edited', edited=true, updated_at=now()
    where kk_planned_mailings.id=p_planned_id;
  insert into public.kk_planned_mailing_edits (planned_id, old_text, new_text, edited_by, edited_by_id)
    values (p_planned_id, v_old, p_new_text, coalesce((select full_name from public.resolve_login_code(p_login_code) limit 1),'unknown'), c.employee_id);
  return query select m.id, m.status, m.composed_text, m.updated_at from public.kk_planned_mailings m where m.id=p_planned_id;
end; $$;

-- Materialise-and-edit by natural key (the cabinet computes the chain locally,
-- so a row may not be persisted yet). Upsert + audit; time from the schedule.
create or replace function public.kk_upsert_planned_mailing(
  p_login_code text, p_agr_no text, p_category text, p_subtype text, p_period text,
  p_language text, p_scheduled_at timestamptz, p_text text, p_is_test boolean default false)
returns table(id uuid, status text, composed_text text, updated_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; v_id uuid; v_old text; v_owner text; v_cs record; v_name text; begin
  select * into c from public.kk_caller(p_login_code);
  if p_text is null or length(btrim(p_text))=0 then
    raise exception 'Текст сообщения не может быть пустым.' using errcode='22023'; end if;
  select * into v_cs from public.kk_company_settings where agr_no=p_agr_no;
  if not found then raise exception 'Неизвестная компания.' using errcode='P0002'; end if;
  select m.id, m.composed_text, m.accountant_id into v_id, v_old, v_owner from public.kk_planned_mailings m
    where m.agr_no=p_agr_no and m.category=p_category and m.subtype=p_subtype and m.period=p_period and m.is_test=coalesce(p_is_test,false);
  -- effective owner = existing row's owner, else the company's resolved owner;
  -- deny non-supervisors when there is no owner (bot rows have accountant_id null).
  if not c.is_all and (coalesce(v_owner,v_cs.accountant_id) is null or coalesce(v_owner,v_cs.accountant_id)<>c.employee_id::text) then
    raise exception 'Можно редактировать только собственные рассылки.' using errcode='42501'; end if;
  select full_name into v_name from public.resolve_login_code(p_login_code) limit 1;
  if v_id is null then
    insert into public.kk_planned_mailings
      (agr_no,client_name,chat_name,category,subtype,period,language,scheduled_at,composed_text,accountant_id,accountant_name,status,edited,is_test)
    values (p_agr_no,v_cs.client_name,v_cs.chat_name,p_category,p_subtype,p_period,
            coalesce(p_language,v_cs.language,'RU'),p_scheduled_at,p_text,
            coalesce(v_cs.accountant_id,c.employee_id::text),coalesce(v_cs.accountant_name,v_name),'edited',true,coalesce(p_is_test,false))
    returning kk_planned_mailings.id into v_id;
  else
    update public.kk_planned_mailings m set composed_text=p_text, status='edited', edited=true,
      scheduled_at=p_scheduled_at, language=coalesce(p_language,m.language), updated_at=now() where m.id=v_id;
  end if;
  insert into public.kk_planned_mailing_edits (planned_id, old_text, new_text, edited_by, edited_by_id)
    values (v_id, v_old, p_text, coalesce(v_name,'unknown'), c.employee_id);
  return query select m.id, m.status, m.composed_text, m.updated_at from public.kk_planned_mailings m where m.id=v_id;
end; $$;

-- Grants: only EXECUTE on the scoped RPCs (no table DML for anon).
do $$
declare fn text;
begin
  foreach fn in array array[
    'kk_list_company_settings(text)','kk_list_mailing_schedule(text)',
    'kk_list_planned_mailings(text, boolean)','kk_list_planned_mailing_edits(text, uuid)',
    'kk_list_sent_notifications(text, integer)','kk_list_manual_assets(text, text)',
    'kk_save_manual_asset(text, text, text, text, text, text, boolean, text)',
    'kk_edit_planned_mailing(uuid, text, text)',
    'kk_upsert_planned_mailing(text, text, text, text, text, text, timestamptz, text, boolean)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated', fn);
  end loop;
end $$;

-- Margarita's mailing log with `source` exposed (vs 0024) so the dedup
-- "never override a manual send" branch is live in-app. This view is
-- aggregate mailing status (not per-accountant sensitive), read like 0024.
create or replace view public.kk_chat_mailings as
select m.agr_no, m.period, m.category, m.status, m.confirmed, m.source
from public.mqa_chat_mailings m;
grant select on public.kk_chat_mailings to anon, authenticated;

-- ---- Seed settings + default schedule for every chat (re-runnable) ----------
-- distinct on (agr_no) + limit-1 lateral guard the ON CONFLICT target; all
-- chats inserted (active computed) so a re-run flips a now-inactive company.
insert into public.kk_company_settings
  (agr_no, language, telegram_chat_id, active, accountant_id, accountant_name, client_name, chat_name, updated_at)
select distinct on (c.agr_no)
  c.agr_no,
  coalesce(ct.language, case
    when c.chat_name ~* '(^|[^A-Za-zԱ-Ֆ])(ENG|EN)([^A-Za-zԱ-Ֆ]|$)' then 'ENG'
    when c.chat_name ~* '(^|[^A-Za-zԱ-Ֆ])(AM|HY|ARM)([^A-Za-zԱ-Ֆ]|$)' then 'AM'
    else 'RU' end),
  public.kk_extract_tg_id(c.chat_link),
  (lower(btrim(c.status))='active'),
  emp.id::text, emp.full_name, coalesce(c.name_agr,c.name_tax), c.chat_name, now()
from public.mqa_chats c
left join public.client_telegram_chats ct
  on ct.contract_number is not null
  and upper(replace(replace(ct.contract_number,'В','B'),'Н','N')) = upper(replace(replace(c.agr_no,'В','B'),'Н','N'))
left join lateral (select id, full_name from public.kk_resolve_employee(c.accountant) limit 1) emp on true
order by c.agr_no
on conflict (agr_no) do update
  set telegram_chat_id=coalesce(excluded.telegram_chat_id, kk_company_settings.telegram_chat_id),
      active=excluded.active, accountant_id=excluded.accountant_id, accountant_name=excluded.accountant_name,
      client_name=excluded.client_name, chat_name=excluded.chat_name, updated_at=now();
-- language is NOT overwritten on re-run (may be set manually per company, req 4)

insert into public.kk_mailing_schedule (agr_no, category, subtype, day_of_month, enabled)
select s.agr_no, d.category, d.subtype, d.day_of_month, true
from public.kk_company_settings s
cross join (values
  ('primary_docs','request',28), ('debts','service_payment',5),
  ('salary','table',10), ('main_taxes','report',15)
) as d(category, subtype, day_of_month)
where s.active
on conflict (agr_no, category, subtype) do nothing;

-- Backlog (point 4): chat-name change → language review. Filed once.
insert into public.kk_tasks (task_type, title, notes, status, priority, created_by)
select 'other',
  '[Backlog] Отслеживать смену названия чата → пересмотреть язык компании',
  'Точка 4 «Шаблонные уведомления»: язык — параметр компании (kk_company_settings.language). Нужно ловить смену названия чата и уведомлять, что язык, возможно, надо обновить. Пока не реализовано.',
  'open', 3, 'migration_0035'
where not exists (select 1 from public.kk_tasks
  where title='[Backlog] Отслеживать смену названия чата → пересмотреть язык компании');

comment on table public.kk_planned_mailings is 'Materialised 30-day chain; scheduled_at fixed; composed_text edited only via kk_edit/upsert_planned_mailing (audited).';
comment on table public.kk_sent_notifications is 'Log of every notification sent to a client (req 6): date, text, type, subtype, contract.';
