-- 0036 — Server-side per-role scoping for the template-notifications data.
--
-- Fixes the role data-isolation gap flagged in review: previously kk_* mailing
-- tables were readable by anon/authenticated with permissive RLS, so a regular
-- accountant could read EVERY client's settings/plans/edits/sent-log/attachment
-- records by querying Supabase directly — the per-accountant limit was only a
-- browser-side filter. This app has no Supabase Auth session (login is a code
-- resolved via resolve_login_code), so there is no auth.uid() to key RLS on.
-- The fix is the same shape as kk_violation_workflow (0027): lock the tables
-- (no anon SELECT/DML) and expose SCOPED reads/writes through SECURITY DEFINER
-- functions that resolve the login code to an employee and filter server-side.

-- Who is calling, and may they see everyone? (supervisor roles mirror scope.js)
create or replace function public.kk_caller(p_login_code text,
  out employee_id uuid, out is_all boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_role text; v_can_all boolean;
begin
  select r.employee_id, r.role, coalesce(r.can_see_all, false)
    into employee_id, v_role, v_can_all
  from public.resolve_login_code(p_login_code) r limit 1;
  if employee_id is null then
    raise exception 'Неизвестный код входа. Войдите заново.' using errcode = '28000';
  end if;
  is_all := v_can_all or lower(coalesce(v_role, '')) in ('head_accountant','ceo','founder','qa','admin');
end;
$$;
revoke all on function public.kk_caller(text) from public;

-- Lock the tables: drop the permissive SELECT/DML policies + revoke grants.
-- Access is now only via the scoped RPCs below (SECURITY DEFINER bypasses RLS)
-- and the bot's service-role key. kk_manual_mailing_assets loses its direct
-- write too (goes through kk_save_manual_asset).
do $$
declare t text; p record;
begin
  foreach t in array array[
    'kk_company_settings','kk_mailing_schedule','kk_planned_mailings',
    'kk_planned_mailing_edits','kk_sent_notifications','kk_manual_mailing_assets'
  ] loop
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

revoke select, insert, update, delete on
  public.kk_company_settings, public.kk_mailing_schedule, public.kk_planned_mailings,
  public.kk_planned_mailing_edits, public.kk_sent_notifications, public.kk_manual_mailing_assets
  from anon, authenticated;

-- ---- Scoped reads ----------------------------------------------------------
create or replace function public.kk_list_company_settings(p_login_code text)
returns setof public.kk_company_settings
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.kk_caller(p_login_code);
  return query select * from public.kk_company_settings s
    where s.active and (c.is_all or s.accountant_id = c.employee_id::text);
end; $$;

create or replace function public.kk_list_mailing_schedule(p_login_code text)
returns setof public.kk_mailing_schedule
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.kk_caller(p_login_code);
  return query select sc.* from public.kk_mailing_schedule sc
    where c.is_all or exists (
      select 1 from public.kk_company_settings s
      where s.agr_no = sc.agr_no and s.accountant_id = c.employee_id::text);
end; $$;

create or replace function public.kk_list_planned_mailings(p_login_code text, p_include_test boolean default false)
returns setof public.kk_planned_mailings
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.kk_caller(p_login_code);
  return query select m.* from public.kk_planned_mailings m
    where (p_include_test or m.is_test = false)
      and (c.is_all or m.accountant_id = c.employee_id::text)
    order by m.scheduled_at;
end; $$;

create or replace function public.kk_list_planned_mailing_edits(p_login_code text, p_planned_id uuid)
returns setof public.kk_planned_mailing_edits
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_owner text;
begin
  select * into c from public.kk_caller(p_login_code);
  select accountant_id into v_owner from public.kk_planned_mailings where id = p_planned_id;
  if not c.is_all and v_owner is not null and v_owner <> c.employee_id::text then
    raise exception 'Недоступно.' using errcode = '42501';
  end if;
  return query select e.* from public.kk_planned_mailing_edits e
    where e.planned_id = p_planned_id order by e.edited_at desc;
end; $$;

create or replace function public.kk_list_sent_notifications(p_login_code text, p_limit int default 500)
returns setof public.kk_sent_notifications
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.kk_caller(p_login_code);
  return query select n.* from public.kk_sent_notifications n
    where c.is_all or exists (
      select 1 from public.kk_company_settings s
      where s.agr_no = n.agr_no and s.accountant_id = c.employee_id::text)
    order by n.sent_at desc limit greatest(1, least(p_limit, 2000));
end; $$;

create or replace function public.kk_list_manual_assets(p_login_code text, p_period text default null)
returns setof public.kk_manual_mailing_assets
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.kk_caller(p_login_code);
  return query select a.* from public.kk_manual_mailing_assets a
    where (p_period is null or a.period = p_period)
      and (c.is_all or exists (
        select 1 from public.kk_company_settings s
        where s.agr_no = a.agr_no and s.accountant_id = c.employee_id::text));
end; $$;

-- ---- Scoped write for manual assets (ownership-checked) ---------------------
create or replace function public.kk_save_manual_asset(
  p_login_code text, p_agr_no text, p_period text, p_kind text,
  p_storage_path text, p_file_name text, p_marked_done boolean, p_note text)
returns public.kk_manual_mailing_assets
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_owner text; v_row public.kk_manual_mailing_assets;
begin
  select * into c from public.kk_caller(p_login_code);
  if p_kind not in ('salary_sheet','tax_report') then
    raise exception 'Недопустимый тип вложения.' using errcode = '22023';
  end if;
  select accountant_id into v_owner from public.kk_company_settings where agr_no = p_agr_no;
  if not c.is_all and v_owner is not null and v_owner <> c.employee_id::text then
    raise exception 'Можно вкладывать файлы только своим клиентам.' using errcode = '42501';
  end if;
  insert into public.kk_manual_mailing_assets
    (agr_no, period, kind, storage_path, file_name, public_url, marked_done, note, uploaded_by, updated_at)
  values (p_agr_no, p_period, p_kind, p_storage_path, p_file_name, null,
          coalesce(p_marked_done, p_storage_path is not null), p_note,
          coalesce((select full_name from public.resolve_login_code(p_login_code) limit 1), 'unknown'), now())
  on conflict (agr_no, period, kind) do update
    set storage_path = coalesce(excluded.storage_path, kk_manual_mailing_assets.storage_path),
        file_name    = coalesce(excluded.file_name, kk_manual_mailing_assets.file_name),
        marked_done  = excluded.marked_done or kk_manual_mailing_assets.marked_done,
        note         = coalesce(excluded.note, kk_manual_mailing_assets.note),
        uploaded_by  = excluded.uploaded_by, updated_at = now()
  returning * into v_row;
  return v_row;
end; $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'kk_list_company_settings(text)',
    'kk_list_mailing_schedule(text)',
    'kk_list_planned_mailings(text, boolean)',
    'kk_list_planned_mailing_edits(text, uuid)',
    'kk_list_sent_notifications(text, integer)',
    'kk_list_manual_assets(text, text)',
    'kk_save_manual_asset(text, text, text, text, text, text, boolean, text)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated', fn);
  end loop;
end $$;
