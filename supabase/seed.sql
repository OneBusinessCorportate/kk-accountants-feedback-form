-- Optional sample data for local testing / demos.
-- Safe to run more than once thanks to the unique problem_id + on conflict guard.

insert into public.kk_problems
  (problem_id, source, client_name, contract_id, chat_name, chat_link, accountant_name, accountant_id, priority, problem_title, problem_description, ai_comment, detected_at, status)
values
  ('KK-2026-0001','ai','ООО "Альфа"','C-1001','Альфа / бухгалтерия','https://t.me/c/100100/1','Анна Петросян','acc-anna',1,
   'Не сдан отчёт по НДС вовремя','Клиент сообщил, что декларация по НДС за май не была подана в срок.',
   'AI обнаружил пропущенный дедлайн по НДС в переписке от 14.06.','2026-06-15T09:12:00Z','waiting_for_accountant'),
  ('KK-2026-0002','margarita_review','ИП Сахакян','C-1002','Сахакян / чат','https://t.me/c/100100/2','Давид Григорян','acc-david',2,
   'Долгий ответ клиенту','Клиент ждал ответа более 2 дней по вопросу зарплатных налогов.',
   'Маргарита отметила задержку реакции на запрос клиента.','2026-06-16T11:30:00Z','waiting_for_accountant'),
  ('KK-2026-0003','sona_review','ООО "Бета"','C-1003','Бета / поддержка','https://t.me/c/100100/3','Анна Петросян','acc-anna',3,
   'Ошибка в расчёте аванса','В расчёте авансового платежа допущена неточность.',
   'Сона при проверке нашла расхождение в сумме аванса.','2026-06-17T15:45:00Z','waiting_for_accountant'),
  ('KK-2026-0004','manual','ООО "Гамма"','C-1004','Гамма / общий','https://t.me/c/100100/4','Давид Григорян','acc-david',2,
   'Клиент жалуется на коммуникацию','Руководитель вручную завёл проблему по жалобе клиента на стиль общения.',
   null,'2026-06-18T10:00:00Z','waiting_for_accountant')
on conflict (problem_id) do nothing;
