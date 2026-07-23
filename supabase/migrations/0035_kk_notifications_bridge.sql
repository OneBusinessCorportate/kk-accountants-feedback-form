-- ---------------------------------------------------------------------------
-- Cross-app bridge: templated client notifications.
--
-- The QA platform (margarita-qa-platform, repo #1) owns the notification tables
-- (mqa_notification_templates / mqa_planned_notifications /
-- mqa_notification_edits / mqa_notification_attachments / mqa_sent_notifications
-- and mqa_chats.language — see repo #1 migration
-- 20260723_mqa_notifications_v1.sql). It PLANS the upcoming client messages, and
-- a bot SENDS them on schedule. This feedback form (repo #2) is the accountant
-- app: it must let the accountant SEE the planned messages, EDIT the text,
-- ATTACH a monthly document / mark done, APPROVE or CANCEL — and if they do
-- nothing the bot sends the planned message by itself.
--
-- Same shared-DB bridge as kk_violation_workflow (0027): repo #2 is a static SPA
-- on the anon key, so it READS through read-only definer views (kk_*) and WRITES
-- through SECURITY DEFINER RPCs that authenticate the login code and enforce
-- ownership server-side. The anon role has NO direct DML on mqa_*.
--
-- ORDERING: repo #1's 20260723_mqa_notifications_v1.sql MUST be applied first.
-- The guard below fails loudly otherwise.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'mqa_planned_notifications'
  ) or not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'mqa_notification_templates'
  ) or not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'mqa_sent_notifications'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mqa_chats' and column_name = 'language'
  ) then
    raise exception
      'Prerequisite missing: apply margarita-qa-platform migration 20260723_mqa_notifications_v1.sql first (repo #1) — it creates the mqa_notification_* tables and mqa_chats.language.';
  end if;
end $$;

-- 1. Read-only projections --------------------------------------------------

-- Add language to the existing chat directory (additive; existing selects of
-- agr_no/chat_link/status keep working).
create or replace view public.kk_chat_directory as
select
  c.agr_no,
  c.chat_link,
  c.status,
  coalesce(c.language, 'ru')    as language,
  c.accountant                  as accountant,       -- raw name from mqa_chats
  e.id                          as accountant_id,    -- resolved employee uuid (may be null)
  e.full_name                   as accountant_name   -- canonical full name (may be null)
from public.mqa_chats c
left join lateral (
  select id, full_name from public.kk_resolve_employee(c.accountant) limit 1
) e on true;

comment on view public.kk_chat_directory is
  'Read-only projection of mqa_chats (agr_no, chat_link, status, language) plus the resolved responsible accountant (accountant_id/name via kk_resolve_employee) so the accountant app can scope client notifications to their own companies. language drives template rendering (0035).';

grant select on public.kk_chat_directory to anon, authenticated;

-- The template catalog (client-facing wording + auto/manual + approved flag).
create or replace view public.kk_notification_templates as
select
  t.id, t.category, t.subtype, t.language, t.mode, t.title, t.body,
  t.requires_attachment, t.approved, t.active
from public.mqa_notification_templates t;

comment on view public.kk_notification_templates is
  'Read-only projection of mqa_notification_templates (pt.1): client-facing wording per (category, subtype, language), auto/manual, and whether the owner has approved the text.';

grant select on public.kk_notification_templates to anon, authenticated;

-- The planned 30-day chain — the upcoming messages the bot will send.
create or replace view public.kk_planned_notifications as
select
  p.id, p.agr_no, p.period, p.category, p.subtype, p.language,
  p.scheduled_date, p.template_id, p.mode, p.requires_attachment,
  p.rendered_text, p.accompanying_text, p.status,
  p.edited_by, p.edited_at, p.approved_by, p.approved_at,
  p.cancelled_by, p.cancelled_at, p.sent_at
from public.mqa_planned_notifications p;

comment on view public.kk_planned_notifications is
  'Read-only projection of mqa_planned_notifications (pt.3): the queued upcoming client notifications, their rendered text and status. planned/edited/approved will be sent; cancelled/sent/skipped will not.';

grant select on public.kk_planned_notifications to anon, authenticated;

-- Manual-input attachments (files by month / mark-done) for MANUAL types.
create or replace view public.kk_notification_attachments as
select
  a.agr_no, a.period, a.category, a.file_name, a.file_url,
  a.marked_done, a.uploaded_by, a.created_at, a.updated_at
from public.mqa_notification_attachments a;

comment on view public.kk_notification_attachments is
  'Read-only projection of mqa_notification_attachments (pt.2): the monthly file / mark-done for MANUAL notification types.';

grant select on public.kk_notification_attachments to anon, authenticated;

-- The sent-notifications log (read-only "all notifications sent to this client").
create or replace view public.kk_sent_notifications as
select
  s.id, s.sent_at, s.sent_date, s.agr_no, s.category, s.subtype,
  s.language, s.full_text, s.template_id, s.planned_id, s.telegram_ok
from public.mqa_sent_notifications s;

comment on view public.kk_sent_notifications is
  'Read-only projection of mqa_sent_notifications (pt.6): every message the bot actually sent — date, full text, type, subtype, contract number.';

grant select on public.kk_sent_notifications to anon, authenticated;

-- 2. Ownership helper -------------------------------------------------------
-- Resolve the login code to an employee and confirm they own the chat (the
-- chat's accountant resolves to the same employee via kk_resolve_employee) OR
-- they are a supervisor (can_see_all / management role) — same reach model as
-- scope.js SUPERVISOR_ROLES. Ownership is computed in the DB from the stored
-- chat, never from client input.
create or replace function public.kk_assert_chat_owner(
  p_agr_no       text,
  p_login_code   text,
  out employee_id uuid,
  out full_name   text,
  out accountant  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner       uuid;
  v_role        text;
  v_can_see_all boolean;
begin
  select r.employee_id, r.full_name, r.role, r.can_see_all
    into employee_id, full_name, v_role, v_can_see_all
  from public.resolve_login_code(p_login_code) r
  limit 1;
  if employee_id is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode = '28000';
  end if;

  select c.accountant into accountant
  from public.mqa_chats c
  where c.agr_no = p_agr_no;
  if not found then
    raise exception 'Чат не найден.' using errcode = 'P0002';
  end if;

  -- Supervisors / management may act on any chat.
  if coalesce(v_can_see_all, false)
     or lower(coalesce(v_role, '')) in ('head_accountant', 'ceo', 'founder', 'qa', 'admin') then
    return;
  end if;

  select e.id into v_owner from public.kk_resolve_employee(accountant) e limit 1;
  if v_owner is null or v_owner <> employee_id then
    raise exception 'Можно управлять только уведомлениями своих клиентов.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.kk_assert_chat_owner(text, text) from public;

-- Load a planned row's owning contract, asserting the caller owns it. Returns
-- the identity + the row's current status (for the status guards below).
create or replace function public.kk_assert_planned_owner(
  p_planned_id   bigint,
  p_login_code   text,
  out employee_id uuid,
  out full_name   text,
  out agr_no      text,
  out status      text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
begin
  select p.agr_no, p.status into agr_no, status
  from public.mqa_planned_notifications p
  where p.id = p_planned_id;
  if not found then
    raise exception 'Запланированное уведомление не найдено.' using errcode = 'P0002';
  end if;

  select * into o from public.kk_assert_chat_owner(agr_no, p_login_code);
  employee_id := o.employee_id;
  full_name   := o.full_name;
end;
$$;

revoke all on function public.kk_assert_planned_owner(bigint, text) from public;

-- 3. Edit the planned text (audited) ----------------------------------------
-- Last-minute edit allowed, but ALWAYS logged (who/what/when) — no silent edits
-- (pt.3). Keeps the row scheduled (status → 'edited'); the bot still sends it.
create or replace function public.kk_edit_notification(
  p_planned_id text,   -- text so the anon client's JSON number/string both work
  p_login_code text,
  p_new_text   text
)
returns table(id bigint, status text, rendered_text text, edited_by text, edited_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   bigint := p_planned_id::bigint;
  o      record;
  v_text text := btrim(coalesce(p_new_text, ''));
  v_old  text;
begin
  if v_text = '' then
    raise exception 'Текст уведомления не может быть пустым.' using errcode = '22023';
  end if;

  select * into o from public.kk_assert_planned_owner(v_id, p_login_code);
  if o.status in ('sent', 'cancelled') then
    raise exception 'Это уведомление уже отправлено или отменено — правка недоступна.' using errcode = '22023';
  end if;

  select p.rendered_text into v_old from public.mqa_planned_notifications p where p.id = v_id;

  insert into public.mqa_notification_edits (planned_id, action, editor, old_text, new_text)
  values (v_id, 'edit_text', o.full_name, v_old, v_text);

  update public.mqa_planned_notifications p
     set rendered_text = v_text,
         status        = 'edited',
         edited_by     = o.full_name,
         edited_at     = now(),
         updated_at    = now()
   where p.id = v_id;

  return query
    select p.id, p.status, p.rendered_text, p.edited_by, p.edited_at
    from public.mqa_planned_notifications p where p.id = v_id;
end;
$$;

-- 4. Approve (lock the wording) ---------------------------------------------
create or replace function public.kk_approve_notification(
  p_planned_id text,
  p_login_code text
)
returns table(id bigint, status text, approved_by text, approved_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint := p_planned_id::bigint;
  o    record;
begin
  select * into o from public.kk_assert_planned_owner(v_id, p_login_code);
  if o.status in ('sent', 'cancelled') then
    raise exception 'Это уведомление уже отправлено или отменено.' using errcode = '22023';
  end if;

  insert into public.mqa_notification_edits (planned_id, action, editor)
  values (v_id, 'approve', o.full_name);

  update public.mqa_planned_notifications p
     set status      = 'approved',
         approved_by = o.full_name,
         approved_at = now(),
         updated_at  = now()
   where p.id = v_id
     and p.status in ('planned', 'edited');

  return query
    select p.id, p.status, p.approved_by, p.approved_at
    from public.mqa_planned_notifications p where p.id = v_id;
end;
$$;

-- 5. Cancel (stop the bot from sending it) ----------------------------------
create or replace function public.kk_cancel_notification(
  p_planned_id text,
  p_login_code text
)
returns table(id bigint, status text, cancelled_by text, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint := p_planned_id::bigint;
  o    record;
begin
  select * into o from public.kk_assert_planned_owner(v_id, p_login_code);
  if o.status = 'sent' then
    raise exception 'Это уведомление уже отправлено — отмена недоступна.' using errcode = '22023';
  end if;

  insert into public.mqa_notification_edits (planned_id, action, editor)
  values (v_id, 'cancel', o.full_name);

  update public.mqa_planned_notifications p
     set status       = 'cancelled',
         cancelled_by = o.full_name,
         cancelled_at = now(),
         updated_at   = now()
   where p.id = v_id
     and p.status <> 'sent';

  return query
    select p.id, p.status, p.cancelled_by, p.cancelled_at
    from public.mqa_planned_notifications p where p.id = v_id;
end;
$$;

-- 6. Manual attachment / mark-done (pt.2) -----------------------------------
-- Attach the monthly file (salary ведомость / tax report) or just mark done,
-- plus optional accompanying text. Upserts one row per (chat, period, category)
-- and records the accompanying text onto the matching planned row so it goes out
-- with the message.
create or replace function public.kk_attach_notification(
  p_agr_no            text,
  p_period            text,
  p_category          text,
  p_login_code        text,
  p_file_url          text default null,
  p_file_name         text default null,
  p_marked_done       boolean default false,
  p_accompanying_text text default null
)
returns table(agr_no text, period text, category text, file_url text, marked_done boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
begin
  select * into o from public.kk_assert_chat_owner(p_agr_no, p_login_code);

  if coalesce(p_file_url, '') = '' and not coalesce(p_marked_done, false) then
    raise exception 'Приложите файл или отметьте «сделано».' using errcode = '22023';
  end if;

  insert into public.mqa_notification_attachments
    (agr_no, period, category, file_name, file_url, marked_done, uploaded_by)
  values (p_agr_no, p_period, p_category, p_file_name, p_file_url,
          coalesce(p_marked_done, false), o.full_name)
  on conflict (agr_no, period, category) do update
    set file_name   = coalesce(excluded.file_name, mqa_notification_attachments.file_name),
        file_url    = coalesce(excluded.file_url, mqa_notification_attachments.file_url),
        marked_done = excluded.marked_done or mqa_notification_attachments.marked_done,
        uploaded_by = excluded.uploaded_by,
        updated_at  = now();

  insert into public.mqa_notification_edits (planned_id, action, editor, note)
  select p.id,
         case when coalesce(p_marked_done, false) and coalesce(p_file_url,'') = ''
              then 'mark_done' else 'attach' end,
         o.full_name,
         coalesce(p_file_name, p_file_url)
  from public.mqa_planned_notifications p
  where p.agr_no = p_agr_no and p.period = p_period and p.category = p_category;

  if p_accompanying_text is not null then
    update public.mqa_planned_notifications p
       set accompanying_text = btrim(p_accompanying_text),
           updated_at = now()
     where p.agr_no = p_agr_no and p.period = p_period and p.category = p_category
       and p.status not in ('sent', 'cancelled');
  end if;

  return query
    select a.agr_no, a.period, a.category, a.file_url, a.marked_done
    from public.mqa_notification_attachments a
    where a.agr_no = p_agr_no and a.period = p_period and a.category = p_category;
end;
$$;

-- The anon/authenticated roles may CALL the RPCs (they enforce their own auth
-- via the login code) but have NO direct DML on the mqa_* tables.
grant execute on function public.kk_edit_notification(text, text, text)               to anon, authenticated;
grant execute on function public.kk_approve_notification(text, text)                   to anon, authenticated;
grant execute on function public.kk_cancel_notification(text, text)                    to anon, authenticated;
grant execute on function public.kk_attach_notification(text, text, text, text, text, text, boolean, text) to anon, authenticated;
