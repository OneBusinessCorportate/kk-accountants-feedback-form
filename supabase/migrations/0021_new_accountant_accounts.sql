-- Accounts for the accountants who had none (requested by the owner).
-- (Applied to production via MCP on 2026-07-08; login codes were inserted
-- directly into login_codes and are deliberately NOT committed here.)
--
-- 1) Employees that existed but were missing their Telegram identity, so the
--    QA layer treated their replies as CLIENT messages (false «Без ответа»):
--    - Arthur Barseghyan writes as «Artur Accounting» (id 8668649901,
--      @Artur_Accounting) — 105 messages across 8 chats since 2026-06-24.
--    - Lilit Kyababchyan already had telegram_id 8736906642 but no username;
--      observed as @LilithAccounting.
update employees set
  telegram_id = 8668649901, telegram_user_id = 8668649901,
  telegram_username = 'Artur_Accounting', normalized_username = 'artur_accounting',
  display_aliases = array['Artur Accounting'], updated_at = now()
where id = 'ba6f193c-0786-4be7-bdb2-972ad8ef92d9' and telegram_id is null;

update employees set
  telegram_username = 'LilithAccounting', normalized_username = 'lilithaccounting', updated_at = now()
where id = '5c33b66d-20b7-406e-af0b-2218e335c910' and telegram_username is null;

-- 2) New hires with no employees row at all. Telegram identities taken from
--    the real chat traffic («Marianna Accounting», «Alisa Accounting»);
--    started_at = their first observed staff message. Ashot Mantashyan has no
--    observed Telegram identity yet — created without one (fill in when he
--    starts messaging), so nothing is invented.
insert into employees (id, full_name, role, started_at, telegram_id, telegram_user_id,
                       telegram_username, normalized_username, normalized_full_name,
                       display_aliases, notes)
select * from (values
  ('054ab7f5-cf51-40fc-8c01-ea5859423b94'::uuid, 'Marianna Khachatryan', 'accountant', '2026-07-02'::date,
   8802775342::bigint, 8802775342::bigint, 'mariannaaccounting', 'mariannaaccounting',
   'marianna khachatryan', array['Marianna Accounting'], null::text),
  ('d4e91c8a-f53d-499a-847f-9f34b9e410cb'::uuid, 'Alisa Tsaturyan', 'accountant', '2026-06-29'::date,
   8775125707::bigint, 8775125707::bigint, null, null,
   'alisa tsaturyan', array['Alisa Accounting'], null::text),
  ('55b6065d-f681-4067-9080-261e0847ea6e'::uuid, 'Ashot Mantashyan', 'accountant', '2026-07-08'::date,
   null::bigint, null::bigint, null, null,
   'ashot mantashyan', array[]::text[],
   'No Telegram staff identity observed in chat data yet (2026-07-08); fill telegram_id/username when he starts messaging in client chats.')
) as v(id, full_name, role, started_at, telegram_id, telegram_user_id,
       telegram_username, normalized_username, normalized_full_name, display_aliases, notes)
where not exists (select 1 from employees e where e.id = v.id);

-- 3) Source-name aliases (bare Armenian first names are unambiguous here),
--    mirrored in src/lib/ingestion.js ACCOUNTANT_ALIASES.
insert into kk_accountant_aliases (alias_norm, employee_id, full_name) values
  (kk_norm_name('Մարիաննա'), '054ab7f5-cf51-40fc-8c01-ea5859423b94', 'Marianna Khachatryan'),
  (kk_norm_name('Ալիսա'),    'd4e91c8a-f53d-499a-847f-9f34b9e410cb', 'Alisa Tsaturyan'),
  (kk_norm_name('Աշոտ'),     '55b6065d-f681-4067-9080-261e0847ea6e', 'Ashot Mantashyan'),
  (kk_norm_name('Արթուր'),   'ba6f193c-0786-4be7-bdb2-972ad8ef92d9', 'Arthur Barseghyan')
on conflict (alias_norm) do update set employee_id = excluded.employee_id, full_name = excluded.full_name;
