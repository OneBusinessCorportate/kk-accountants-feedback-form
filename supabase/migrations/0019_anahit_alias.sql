-- Անահիտ appears as an accountant name in the QA sources but had no alias →
-- her problems were unassigned. Map to the real (inactive) employee.
-- (Applied to production via MCP on 2026-07-06.)
insert into kk_accountant_aliases (alias_norm, employee_id, full_name)
values (kk_norm_name('Անահիտ'), '5ca23678-3189-46ca-85be-a4257cb54734', 'Anahit Accounting')
on conflict (alias_norm) do update set employee_id = excluded.employee_id, full_name = excluded.full_name;

update kk_problems set accountant_id = '5ca23678-3189-46ca-85be-a4257cb54734', accountant_name = 'Anahit Accounting'
where accountant_id is null and kk_norm_name(coalesce(accountant_name,'')) = kk_norm_name('Անահիտ');
