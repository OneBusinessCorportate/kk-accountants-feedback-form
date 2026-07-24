-- ---------------------------------------------------------------------------
-- Notifications logic change (owner decision): the bot ALWAYS sends the planned
-- message at its scheduled time — the accountant can NOT cancel it, and there is
-- no "approve/lock" step. The only action before send is EDIT: the accountant
-- may change the message text at any time up until the bot sends it.
--
-- Concretely, relative to 0035:
--   • drop kk_cancel_notification  — cancelling a send is no longer allowed;
--   • drop kk_approve_notification — no lock step (edit stays open until sent);
--   • kk_edit_notification         — editable while 'planned'/'edited' (i.e. any
--                                    time before the bot flips it to 'sent'); no
--                                    'approved' branch anymore;
--   • kk_list_planned_notifications — active window is 'planned'/'edited' only.
--
-- The kk_attach_notification RPC and the read RPCs are otherwise unchanged.
-- ORDERING: depends on 0035 (guard below).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.routines
    where routine_schema = 'public' and routine_name = 'kk_edit_notification'
  ) then
    raise exception 'Prerequisite missing: apply 0035_kk_notifications_bridge.sql first.';
  end if;
end $$;

-- 1. Remove cancel + approve entirely -------------------------------------
drop function if exists public.kk_cancel_notification(text, text);
drop function if exists public.kk_approve_notification(text, text);

-- Migrate away the now-defunct 'approved' state: any notification that was
-- approved under 0035 but NOT yet sent becomes 'edited', so it stays visible in
-- the upcoming list and remains editable right up until the bot sends it (the
-- new promise). Without this, such rows would be hidden + uneditable yet still
-- get sent. (approved_by/at are left as historical breadcrumbs.)
update public.mqa_planned_notifications
   set status = 'edited', updated_at = now()
 where status = 'approved';

-- 2. Edit is allowed any time before the bot sends the message ------------
-- Editable while the row is still 'planned' or 'edited'; a 'sent' (or otherwise
-- terminal) row is locked. Atomic status-guarded UPDATE (race-safe against the
-- bot flipping the row to 'sent'); every edit is logged (no silent edits).
create or replace function public.kk_edit_notification(
  p_planned_id text,
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
  v_hit  bigint;
begin
  if v_text = '' then
    raise exception 'Текст уведомления не может быть пустым.' using errcode = '22023';
  end if;

  select * into o from public.kk_assert_planned_owner(v_id, p_login_code);
  if o.status not in ('planned', 'edited') then
    raise exception 'Уведомление уже отправлено — изменить текст нельзя.' using errcode = '22023';
  end if;

  select p.rendered_text into v_old from public.mqa_planned_notifications p where p.id = v_id;

  update public.mqa_planned_notifications p
     set rendered_text = v_text,
         status        = 'edited',
         edited_by     = o.full_name,
         edited_at     = now(),
         updated_at    = now()
   where p.id = v_id
     and p.status in ('planned', 'edited')
  returning p.id into v_hit;

  if v_hit is null then
    raise exception 'Уведомление уже отправлено — правка не применена.' using errcode = '22023';
  end if;

  insert into public.mqa_notification_edits (planned_id, action, editor, old_text, new_text)
  values (v_id, 'edit_text', o.full_name, v_old, v_text);

  return query
    select p.id, p.status, p.rendered_text, p.edited_by, p.edited_at
    from public.mqa_planned_notifications p where p.id = v_id;
end;
$$;

grant execute on function public.kk_edit_notification(text, text, text) to anon, authenticated;

-- 3. Upcoming list = active rows ('planned'/'edited') in the forward window --
create or replace function public.kk_list_planned_notifications(p_login_code text)
returns table(
  id bigint, agr_no text, period text, category text, subtype text, language text,
  scheduled_date date, template_id text, mode text, requires_attachment boolean,
  rendered_text text, accompanying_text text, status text,
  edited_by text, edited_at timestamptz, approved_by text, approved_at timestamptz,
  cancelled_by text, cancelled_at timestamptz, sent_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare s record;
begin
  select * into s from public.kk_notification_scope(p_login_code);
  return query
    select p.id, p.agr_no, p.period, p.category, p.subtype, p.language,
           p.scheduled_date, p.template_id, p.mode, p.requires_attachment,
           p.rendered_text, p.accompanying_text, p.status,
           p.edited_by, p.edited_at, p.approved_by, p.approved_at,
           p.cancelled_by, p.cancelled_at, p.sent_at
    from public.mqa_planned_notifications p
    where (s.is_supervisor or public.kk_owns_contract(p.agr_no, s.employee_id))
      and p.status in ('planned', 'edited')
      and p.scheduled_date >= (current_date - interval '2 days')
      and p.scheduled_date <= (current_date + interval '35 days')
    order by p.scheduled_date asc;
end;
$$;

grant execute on function public.kk_list_planned_notifications(text) to anon, authenticated;
