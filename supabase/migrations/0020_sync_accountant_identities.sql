-- Full identity sync between the QA sources and the employees table.
-- (Applied to production via MCP on 2026-07-06.)

-- 1) «Լիլիթ Ք․» (Lilit K.) was wrongly aliased to Lilit Khosrovyan; Ք is
--    Kyababchyan. Point the alias at the right employee.
update kk_accountant_aliases
set employee_id = '5c33b66d-20b7-406e-af0b-2218e335c910', full_name = 'Lilit Kyababchyan'
where alias_norm = kk_norm_name('Լիլիթ Ք․');

-- 2) Alias display names had gone stale (employees were renamed from
--    «X Accounting» to real names). Mirror the current employee names.
update kk_accountant_aliases a
set full_name = e.full_name
from employees e
where e.id = a.employee_id and a.full_name <> e.full_name;

-- 3) Re-attribute Sona-sourced problems filed under Khosrovyan while the
--    source ticket names Լիլիթ Ք․ (join back to the original tickets).
update kk_problems p
set accountant_id = '5c33b66d-20b7-406e-af0b-2218e335c910', accountant_name = 'Lilit Kyababchyan'
from sqa_tickets t
where p.problem_id = 'sona:' || t.id
  and kk_norm_name(coalesce(t.accountant, '')) = kk_norm_name('Լիլիթ Ք․');

-- 4) Sync every stored accountant_name to the employee's current full_name,
--    so both platforms display the same person identically.
update kk_problems p
set accountant_name = e.full_name
from employees e
where e.id::text = p.accountant_id and p.accountant_name is distinct from e.full_name;

update kk_tasks t
set accountant_name = e.full_name
from employees e
where e.id::text = t.accountant_id and t.accountant_name is distinct from e.full_name;
