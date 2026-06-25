-- Optional sample data for LOCAL testing / demos only.
-- Safe to run more than once thanks to the unique problem_id + on conflict guard.
--
-- Accountants here are REAL employees from the shared project: accountant_id is
-- the employee UUID and accountant_name is the canonical employees.full_name, so
-- per-accountant scoping (src/lib/scope.js) works when that person logs in.
-- NEVER use invented names here — only valid employees. (Production problems are
-- created by kk_ingest_problems(); these demo rows are not loaded in prod.)

insert into public.kk_problems
  (problem_id, source, client_name, contract_id, chat_name, chat_link, accountant_name, accountant_id, priority, problem_title, problem_description, ai_comment, detected_at, status)
values
  ('KK-2026-0001','ai','ООО "Альфа"','C-1001','Альфа / бухгалтерия','https://t.me/c/100100/1','Naira Mkhitaryan','f04c637e-2d94-46d4-85cb-e8e7399835be',1,
   'Не сдан отчёт по НДС вовремя','Клиент сообщил, что декларация по НДС за май не была подана в срок.',
   'AI обнаружил пропущенный дедлайн по НДС в переписке от 14.06.','2026-06-15T09:12:00Z','waiting_for_accountant'),
  ('KK-2026-0002','margarita_review','ИП Сахакян','C-1002','Сахакян / чат','https://t.me/c/100100/2','Davit Accounting','db613c42-efa0-4bc9-a267-ccfde1676681',2,
   'Долгий ответ клиенту','Клиент ждал ответа более 2 дней по вопросу зарплатных налогов.',
   'Маргарита отметила задержку реакции на запрос клиента.','2026-06-16T11:30:00Z','waiting_for_accountant'),
  ('KK-2026-0003','sona_review','ООО "Бета"','C-1003','Бета / поддержка','https://t.me/c/100100/3','Olya Accounting','2b22a577-7683-4f22-9834-c957312da4bc',3,
   'Ошибка в расчёте аванса','В расчёте авансового платежа допущена неточность.',
   'Сона при проверке нашла расхождение в сумме аванса.','2026-06-17T15:45:00Z','waiting_for_accountant'),
  ('KK-2026-0004','manual','ООО "Гамма"','C-1004','Гамма / общий','https://t.me/c/100100/4','Sona Accounting','f4720d0f-3192-4389-9d56-185b97928d46',2,
   'Клиент жалуется на коммуникацию','Руководитель вручную завёл проблему по жалобе клиента на стиль общения.',
   null,'2026-06-18T10:00:00Z','waiting_for_accountant')
on conflict (problem_id) do nothing;
