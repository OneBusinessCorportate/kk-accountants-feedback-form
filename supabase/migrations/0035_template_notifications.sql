-- 0035 — Automated template notifications (шаблонные рассылки)
--
-- Owner rule (2026-07): template notifications to clients are sent ONLY
-- automatically by the bot; accountants no longer press "send". In their
-- cabinet they see the planned chain for the next 30 days per client chat and
-- may EDIT a planned message (button-driven + audit-logged, never a raw field);
-- they cannot change the send TIME. Managers get a by-day overview. Every sent
-- message is logged. See docs/TEMPLATE_NOTIFICATIONS.md and src/lib/templates.js
-- / notifications.js (the JS spec/mirrors).
--
-- All new objects are additive kk_* tables (they don't touch the mqa_* QA
-- tables). Reads are anon via permissive RLS (same as kk_problems/kk_tasks);
-- the ONE attributable write — editing a planned message — goes through a
-- SECURITY DEFINER RPC that resolves the login code to an employee and logs
-- who/what/when (the kk_acknowledge_violation pattern, migration 0027).

-- Prerequisite guard (fail loudly, like 0027/0033): the seed reads mqa_chats +
-- client_telegram_chats and resolves the accountant via kk_resolve_employee.
do $$
begin
  if to_regclass('public.mqa_chats') is null
     or to_regclass('public.client_telegram_chats') is null
     or to_regclass('public.kk_tasks') is null then
    raise exception 'Prerequisite missing: mqa_chats / client_telegram_chats / kk_tasks must exist first';
  end if;
  if not exists (select 1 from pg_proc where proname = 'kk_resolve_employee') then
    raise exception 'Prerequisite missing: kk_resolve_employee() (migration 0003)';
  end if;
  if not exists (select 1 from pg_proc where proname = 'resolve_login_code') then
    raise exception 'Prerequisite missing: resolve_login_code() (shared dashboards)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Per-company settings (req 4: language is a per-company parameter)
-- ---------------------------------------------------------------------------
create table if not exists public.kk_company_settings (
  agr_no           text primary key,              -- contract number (mqa_chats.agr_no)
  language         text not null default 'RU'
                     check (language in ('RU', 'AM', 'ENG')),
  telegram_chat_id text,                           -- numeric id backfilled from chat_link
  bot_can_send     boolean not null default false, -- bot verified as a chat member
  active           boolean not null default true,  -- mirrors mqa_chats Active/Inactive
  accountant_id    text,                           -- resolved employee uuid (for scoping)
  accountant_name  text,                           -- resolved employee full name
  client_name      text,                           -- name_agr / name_tax
  chat_name        text,
  updated_at       timestamptz not null default now()
);
alter table public.kk_company_settings add column if not exists accountant_id   text;
alter table public.kk_company_settings add column if not exists accountant_name text;
alter table public.kk_company_settings add column if not exists client_name     text;
alter table public.kk_company_settings add column if not exists chat_name       text;

-- ---------------------------------------------------------------------------
-- 2. Per-company schedule (individual schedule per company; seeded from the
--    department default — до 5 / 10 / 15 / 28 — overridable per company).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. The 30-day planned chain (req 3). One materialised row per planned send.
--    scheduled_at is FIXED (not editable); composed_text is editable via RPC.
-- ---------------------------------------------------------------------------
create table if not exists public.kk_planned_mailings (
  id              uuid primary key default gen_random_uuid(),
  agr_no          text not null,
  client_name     text,
  chat_name       text,
  category        text not null check (category in ('primary_docs','debts','salary','main_taxes')),
  subtype         text not null,
  period          text not null,                  -- YYYYMM
  language        text not null default 'RU',
  scheduled_at    timestamptz not null,           -- FIXED send time
  composed_text   text not null default '',       -- current body (auto + any edits)
  accountant_id   text,                           -- employee uuid (text), for scoping/ownership
  accountant_name text,
  status          text not null default 'planned'
                    check (status in ('planned','edited','awaiting_file','covered','sent','skipped','failed')),
  edited          boolean not null default false,
  is_test         boolean not null default false, -- demo rows (test chat only)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (agr_no, category, subtype, period, is_test)
);
create index if not exists kk_planned_mailings_sched_idx on public.kk_planned_mailings (scheduled_at);
create index if not exists kk_planned_mailings_agr_idx   on public.kk_planned_mailings (agr_no);

-- ---------------------------------------------------------------------------
-- 4. Edit audit log (req 3: log WHAT changed and WHO — never accidental).
-- ---------------------------------------------------------------------------
create table if not exists public.kk_planned_mailing_edits (
  id           uuid primary key default gen_random_uuid(),
  planned_id   uuid not null references public.kk_planned_mailings(id) on delete cascade,
  old_text     text,
  new_text     text,
  edited_by    text,           -- employee full name (resolved from login code)
  edited_by_id uuid,           -- employee uuid
  edited_at    timestamptz not null default now()
);
create index if not exists kk_planned_mailing_edits_planned_idx on public.kk_planned_mailing_edits (planned_id);

-- ---------------------------------------------------------------------------
-- 5. Sent-notifications log (req 6: date, text, type, subtype, contract/client)
-- ---------------------------------------------------------------------------
create table if not exists public.kk_sent_notifications (
  id                  uuid primary key default gen_random_uuid(),
  agr_no              text not null,
  client_name         text,
  category            text not null,
  subtype             text,
  language            text,
  text                text not null,
  telegram_chat_id    text,
  telegram_message_id text,
  is_test             boolean not null default false,
  sent_at             timestamptz not null default now(),
  planned_id          uuid references public.kk_planned_mailings(id) on delete set null
);
create index if not exists kk_sent_notifications_agr_idx  on public.kk_sent_notifications (agr_no);
create index if not exists kk_sent_notifications_sent_idx on public.kk_sent_notifications (sent_at);

-- ---------------------------------------------------------------------------
-- 6. Manual-add file sections (req 2): the salary ведомость + the tax report
--    PDF, per month. A file OR a "done" mark is the unit; a note is optional.
-- ---------------------------------------------------------------------------
create table if not exists public.kk_manual_mailing_assets (
  id           uuid primary key default gen_random_uuid(),
  agr_no       text not null,
  period       text not null,                        -- YYYYMM
  kind         text not null check (kind in ('salary_sheet','tax_report')),
  storage_path text,                                 -- kk-attachments bucket path
  file_name    text,
  public_url   text,
  marked_done  boolean not null default false,       -- "nothing to attach / done" mark
  note         text,                                 -- optional accompanying text
  uploaded_by  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (agr_no, period, kind)
);
create index if not exists kk_manual_mailing_assets_agr_idx on public.kk_manual_mailing_assets (agr_no);

-- ---------------------------------------------------------------------------
-- RLS — permissive select/insert/update for the anon SPA (same posture as
-- kk_problems / kk_tasks). kk_planned_mailings gets SELECT only (edits go
-- through the audited RPC below); the edit-log is SELECT only (append via RPC).
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'alter table public.kk_company_settings        enable row level security';
  execute 'alter table public.kk_mailing_schedule        enable row level security';
  execute 'alter table public.kk_planned_mailings        enable row level security';
  execute 'alter table public.kk_planned_mailing_edits   enable row level security';
  execute 'alter table public.kk_sent_notifications      enable row level security';
  execute 'alter table public.kk_manual_mailing_assets   enable row level security';
end $$;

-- kk_manual_mailing_assets is the only table the anon frontend writes (an
-- accountant attaches the salary sheet / tax report). The delivery registry,
-- schedule and the sent-notifications audit log are written by the bot
-- (service role) only — anon gets SELECT so it can't forge them.
do $$
declare
  full_rw text[] := array['kk_manual_mailing_assets'];
  t text;
begin
  foreach t in array full_rw loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_select') then
      execute format('create policy %I on public.%I for select using (true)', t||'_select', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_insert') then
      execute format('create policy %I on public.%I for insert with check (true)', t||'_insert', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_update') then
      execute format('create policy %I on public.%I for update using (true) with check (true)', t||'_update', t);
    end if;
  end loop;
  -- read-only tables for the SPA (writes via RPC / service role only)
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kk_company_settings' and policyname='kk_company_settings_select') then
    create policy kk_company_settings_select on public.kk_company_settings for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kk_mailing_schedule' and policyname='kk_mailing_schedule_select') then
    create policy kk_mailing_schedule_select on public.kk_mailing_schedule for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kk_sent_notifications' and policyname='kk_sent_notifications_select') then
    create policy kk_sent_notifications_select on public.kk_sent_notifications for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kk_planned_mailings' and policyname='kk_planned_mailings_select') then
    create policy kk_planned_mailings_select on public.kk_planned_mailings for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kk_planned_mailing_edits' and policyname='kk_planned_mailing_edits_select') then
    create policy kk_planned_mailing_edits_select on public.kk_planned_mailing_edits for select using (true);
  end if;
end $$;

grant select, insert, update on public.kk_manual_mailing_assets to anon, authenticated;
grant select on
  public.kk_company_settings, public.kk_mailing_schedule, public.kk_sent_notifications,
  public.kk_planned_mailings, public.kk_planned_mailing_edits
  to anon, authenticated;

-- D2: expose Margarita's mailing `source` so the "never override a manual send"
-- dedup branch is live in-app (kk_chat_mailings gains `source` vs 0024).
create or replace view public.kk_chat_mailings as
select m.agr_no, m.period, m.category, m.status, m.confirmed, m.source
from public.mqa_chat_mailings m;
grant select on public.kk_chat_mailings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper: extract the numeric telegram id from a chat_link (mirror of
-- notifications.js extractTelegramId / the QA platform mqa_norm_tg_id).
-- ---------------------------------------------------------------------------
create or replace function public.kk_extract_tg_id(p_link text)
returns text language sql immutable as $$
  select case
    when p_link is null then null
    else (
      with m as (select (regexp_match(p_link, '#(-?\d+)'))[1] as raw)
      select case
        when raw is null then null
        else (
          with s as (select ltrim(raw, '-+') as v)
          select case when v ~ '^\d+$' and left(v,3)='100' and length(v) >= 13
                      then substr(v,4) else v end from s
        )
      end from m
    )
  end
$$;

-- ---------------------------------------------------------------------------
-- Audited edit RPC (req 3): edit a planned message's text through a button.
-- Authenticates the login code, records who/what/when, sets status='edited'.
-- Ownership: the chat's accountant OR a supervisor (can_see_all). The send
-- TIME is never touched here.
-- ---------------------------------------------------------------------------
create or replace function public.kk_edit_planned_mailing(
  p_planned_id uuid, p_new_text text, p_login_code text)
returns table(id uuid, status text, composed_text text, updated_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_emp uuid;
  v_name text;
  v_all boolean;
  v_old text;
  v_owner text;
begin
  select r.employee_id, r.full_name, coalesce(r.can_see_all, false)
    into v_emp, v_name, v_all
  from public.resolve_login_code(p_login_code) r limit 1;
  if v_emp is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode = '28000';
  end if;
  if p_new_text is null or length(btrim(p_new_text)) = 0 then
    raise exception 'Текст сообщения не может быть пустым.' using errcode = '22023';
  end if;

  select composed_text, accountant_id into v_old, v_owner
  from public.kk_planned_mailings where kk_planned_mailings.id = p_planned_id;
  if not found then
    raise exception 'Планируемое сообщение не найдено.' using errcode = 'P0002';
  end if;
  if not v_all and v_owner is not null and v_owner <> v_emp::text then
    raise exception 'Можно редактировать только собственные рассылки.' using errcode = '42501';
  end if;

  update public.kk_planned_mailings
     set composed_text = p_new_text, status = 'edited', edited = true, updated_at = now()
   where kk_planned_mailings.id = p_planned_id;

  insert into public.kk_planned_mailing_edits (planned_id, old_text, new_text, edited_by, edited_by_id)
  values (p_planned_id, v_old, p_new_text, coalesce(v_name, 'unknown'), v_emp);

  return query
    select m.id, m.status, m.composed_text, m.updated_at
    from public.kk_planned_mailings m where m.id = p_planned_id;
end;
$$;

revoke all on function public.kk_edit_planned_mailing(uuid, text, text) from public;
grant execute on function public.kk_edit_planned_mailing(uuid, text, text) to anon, authenticated;

-- On-demand materialise-and-edit (req 3): the cabinet computes the 30-day chain
-- locally from the schedule, so a planned row may not be persisted yet when the
-- accountant edits it. This upserts the row by its natural key AND logs the edit
-- (who/what/when) — the audit trail is identical to kk_edit_planned_mailing.
-- The send TIME comes from the schedule (passed in), never from free input.
create or replace function public.kk_upsert_planned_mailing(
  p_login_code   text,
  p_agr_no       text,
  p_category     text,
  p_subtype      text,
  p_period       text,
  p_language     text,
  p_scheduled_at timestamptz,
  p_text         text,
  p_is_test      boolean default false)
returns table(id uuid, status text, composed_text text, updated_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_emp uuid;
  v_name text;
  v_all boolean;
  v_id uuid;
  v_old text;
  v_owner text;
  v_cs record;
begin
  select r.employee_id, r.full_name, coalesce(r.can_see_all, false)
    into v_emp, v_name, v_all
  from public.resolve_login_code(p_login_code) r limit 1;
  if v_emp is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode = '28000';
  end if;
  if p_text is null or length(btrim(p_text)) = 0 then
    raise exception 'Текст сообщения не может быть пустым.' using errcode = '22023';
  end if;

  select * into v_cs from public.kk_company_settings where agr_no = p_agr_no;
  if not found then
    raise exception 'Неизвестная компания.' using errcode = 'P0002';
  end if;

  select m.id, m.composed_text, m.accountant_id into v_id, v_old, v_owner
  from public.kk_planned_mailings m
  where m.agr_no = p_agr_no and m.category = p_category and m.subtype = p_subtype
    and m.period = p_period and m.is_test = coalesce(p_is_test, false);

  -- ownership: an existing row's owner, else the company's resolved accountant
  if not v_all
     and coalesce(v_owner, v_cs.accountant_id) is not null
     and coalesce(v_owner, v_cs.accountant_id) <> v_emp::text then
    raise exception 'Можно редактировать только собственные рассылки.' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.kk_planned_mailings
      (agr_no, client_name, chat_name, category, subtype, period, language,
       scheduled_at, composed_text, accountant_id, accountant_name, status, edited, is_test)
    values
      (p_agr_no, v_cs.client_name, v_cs.chat_name, p_category, p_subtype, p_period,
       coalesce(p_language, v_cs.language, 'RU'), p_scheduled_at, p_text,
       coalesce(v_cs.accountant_id, v_emp::text), coalesce(v_cs.accountant_name, v_name),
       'edited', true, coalesce(p_is_test, false))
    returning kk_planned_mailings.id into v_id;
  else
    update public.kk_planned_mailings m
       set composed_text = p_text, status = 'edited', edited = true,
           scheduled_at = p_scheduled_at, language = coalesce(p_language, m.language),
           updated_at = now()
     where m.id = v_id;
  end if;

  insert into public.kk_planned_mailing_edits (planned_id, old_text, new_text, edited_by, edited_by_id)
  values (v_id, v_old, p_text, coalesce(v_name, 'unknown'), v_emp);

  return query
    select m.id, m.status, m.composed_text, m.updated_at
    from public.kk_planned_mailings m where m.id = v_id;
end;
$$;

revoke all on function public.kk_upsert_planned_mailing(text, text, text, text, text, text, timestamptz, text, boolean) from public;
grant execute on function public.kk_upsert_planned_mailing(text, text, text, text, text, text, timestamptz, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed per-company settings + default schedule for every ACTIVE chat, from
-- kk-soprovozhdeniya (mqa_chats) + client_telegram_chats.language. Re-runnable.
-- ---------------------------------------------------------------------------
-- distinct on (agr_no): mqa_chats.agr_no is the PK, but kk_resolve_employee is
-- a set-returning function — the lateral is capped at 1 row and distinct on
-- guards against any duplicate landing in the same ON CONFLICT target twice
-- ("cannot affect row a second time"). All chats are inserted (active flag
-- computed) so a re-run flips a now-inactive company's `active` to false (#9).
insert into public.kk_company_settings
  (agr_no, language, telegram_chat_id, active, accountant_id, accountant_name, client_name, chat_name, updated_at)
select distinct on (c.agr_no)
  c.agr_no,
  coalesce(
    ct.language,
    case
      when c.chat_name ~* '(^|[^A-Za-zԱ-Ֆ])(ENG|EN)([^A-Za-zԱ-Ֆ]|$)' then 'ENG'
      when c.chat_name ~* '(^|[^A-Za-zԱ-Ֆ])(AM|HY|ARM)([^A-Za-zԱ-Ֆ]|$)' then 'AM'
      when c.chat_name ~* '(^|[^A-Za-zԱ-Ֆ])(RU|RUS)([^A-Za-zԱ-Ֆ]|$)' then 'RU'
      else 'RU'
    end
  ) as language,
  public.kk_extract_tg_id(c.chat_link) as telegram_chat_id,
  (lower(btrim(c.status)) = 'active') as active,
  emp.id::text as accountant_id,
  emp.full_name as accountant_name,
  coalesce(c.name_agr, c.name_tax) as client_name,
  c.chat_name,
  now()
from public.mqa_chats c
left join public.client_telegram_chats ct
  on ct.contract_number is not null
  and upper(replace(replace(ct.contract_number,'В','B'),'Н','N')) = upper(replace(replace(c.agr_no,'В','B'),'Н','N'))
left join lateral (select id, full_name from public.kk_resolve_employee(c.accountant) limit 1) emp on true
order by c.agr_no
on conflict (agr_no) do update
  set telegram_chat_id = coalesce(excluded.telegram_chat_id, kk_company_settings.telegram_chat_id),
      active = excluded.active,
      accountant_id = excluded.accountant_id,
      accountant_name = excluded.accountant_name,
      client_name = excluded.client_name,
      chat_name = excluded.chat_name,
      updated_at = now();
-- (language is intentionally NOT overwritten on re-run: it may have been set
--  manually per company, req 4.)

insert into public.kk_mailing_schedule (agr_no, category, subtype, day_of_month, enabled)
select s.agr_no, d.category, d.subtype, d.day_of_month, true
from public.kk_company_settings s
cross join (values
  ('primary_docs','request',    28),
  ('debts',       'service_payment', 5),
  ('salary',      'table',      10),
  ('main_taxes',  'report',     15)
) as d(category, subtype, day_of_month)
where s.active
on conflict (agr_no, category, subtype) do nothing;

-- ---------------------------------------------------------------------------
-- Backlog task (req/point 4): detect client chat-name changes → flag that the
-- company language may need updating. Documented in docs/TEMPLATE_NOTIFICATIONS.md;
-- also filed once as a supervisor kk_task so it isn't lost. Guarded so re-runs
-- don't duplicate it.
-- ---------------------------------------------------------------------------
insert into public.kk_tasks (task_type, title, notes, status, priority, created_by)
select 'other',
  '[Backlog] Отслеживать смену названия чата → пересмотреть язык компании',
  'Точка 4 задачи «Шаблонные уведомления». Язык рассылок — параметр компании '
  || '(kk_company_settings.language). Нужно ловить изменения названия Telegram-чата '
  || 'и уведомлять, что язык в платформе, возможно, надо обновить. Пока не реализовано.',
  'open', 3, 'migration_0035'
where not exists (
  select 1 from public.kk_tasks
  where title = '[Backlog] Отслеживать смену названия чата → пересмотреть язык компании'
);

comment on table public.kk_planned_mailings is
  'Materialised 30-day chain of planned client notifications. scheduled_at is fixed; composed_text edited only via kk_edit_planned_mailing (audited).';
comment on table public.kk_sent_notifications is
  'Log of every notification actually sent to a client (req 6): date, text, type, subtype, contract.';
