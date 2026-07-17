-- Broaden the salary «рассылка» auto-detection (owner request, 2026-07).
--
-- The salary newsletter (рассылка по заработной плате) is auto-detected by
-- `mqa_detect_mailings()` (Margarita's QA platform, cron every 2h): it scans
-- accountant messages per active chat and upserts mqa_chat_mailings rows keyed
-- (agr_no, period, category) with source='telegram'. This app only READS those
-- via the kk_chat_mailings view (0024). The owner reported still having to mark
-- salary mailings by hand for many chats.
--
-- Investigation (period 202607, window 2026-06-28..2026-07-28, active chats):
--   * 197 chats  — auto-detected correctly.
--   * 160 chats  — a source='manual' row exists, so the function's
--                  `on conflict ... where source <> 'manual'` clause
--                  permanently blocks auto-refresh. Owner decision: KEEP the
--                  manual lock (a human mark must not be overwritten), so this
--                  migration does NOT touch that behaviour.
--   *  ~19 chats — a real salary send fired NONE of the salary regex branches.
--
-- The dominant regex gap: the salary "done" verb list had получ/прислал/сдал/
-- отправ/… but was MISSING the accountant's most common send/payment verbs:
--   «Направляю таблицу по заработным платам …»           (направля…)  — ~10 chats
--   «я перечислил зарплату …»                            (перечислил)
--   «Переведена зарплата директора …»                    (переведен…)
--   «Мы уже произвели выплаты заработной платы …»        (произвел…)
--   «направляю расчёт/оплату заработной платы …»         (направля…)
-- Verified against the live `messages` table: adding these forms newly detects
-- 19 salary sends this period while the negation guard still suppresses the
-- discussion forms («вы сказали что вообще не перевели ему зарплату?»). Past-
-- tense forms only (перечислил, not the noun «перечислении»; направля/направил,
-- not the imperative «направьте») to avoid catching questions/explanations.
--
-- Only the RU salary "done" branch and the shared neg_done guard change; every
-- other category (main_taxes / primary_docs / debts), the Armenian branches, the
-- windowing, and the manual-lock upsert are reproduced verbatim from the live
-- definition so behaviour elsewhere is unchanged.
--
-- NOTE ON OWNERSHIP: mqa_detect_mailings canonically lives in Margarita's QA
-- platform ("repo #1"); this migration keeps a copy in sync here because the
-- owner asked for the fix on this branch/repo. If the two repos diverge, the QA
-- platform's definition wins — port these two edits there.

create or replace function public.mqa_detect_mailings(period_ym text default to_char(case when (extract(day from (now() at time zone 'Asia/Yerevan'::text)) >= (28)::numeric) then ((now() at time zone 'Asia/Yerevan'::text) + '1 mon'::interval) else (now() at time zone 'Asia/Yerevan'::text) end, 'YYYYMM'::text))
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  period_start timestamptz;
  period_end   timestamptz;
  neg_done constant text :=
    '\mне\M[[:space:]]+([[:alpha:]]+[[:space:]]+){0,2}(получ|пришл|прислал|подпис|сдал|сдела|сдан|подан|предостав|скинул|сброс|отправ|выслал|переслал|направ|подал|загруз|выгруз|отчита|задеклар|готов|выполн|оформ|провед|перечислил|переве[дл]|произвел|произвёл)';
  neg_send constant text :=
    '\mне\M[[:space:]]+([[:alpha:]]+[[:space:]]+){0,2}(рассыл|разосл|разошл|уведом|сообщ|информир|напомн|отправ|выслал|переслал|направ|подал|подан|сдан|сдела|сделан|загруз|выгруз|отчита|задеклар|оформ|провед|провёл|провел|готов|выполн)';
  neg_paid constant text :=
    '\mне\M[[:space:]]+([[:alpha:]]+[[:space:]]+){0,2}(оплат|оплач|выплат|погас|закрыт)';
  neg_hy constant text :=
    'չ(ի|ե[մսնք]|եք|կա|ստաց|ուղարկ|ներկայաց|հանձն|տրամ|վճար|մար|փակ|կատար|արվ)';
  neg_send_hy constant text :=
    'չ(ուղարկ|ներկայաց|հանձն|տեղեկաց|հիշեց|առաք|ցր)|չ(ի|ե[մսնք]{1,2}|կա)[[:space:]]+([^[:space:]]+[[:space:]]+){0,2}(ուղարկ|ներկայաց|հանձն|տեղեկաց|հիշեց|առաք|ցր)';
begin
  period_start := (((period_ym || '01')::date - interval '1 month' + interval '27 days')::timestamp
                   at time zone 'Asia/Yerevan');
  period_end   := (((period_ym || '01')::date + interval '27 days')::timestamp
                   at time zone 'Asia/Yerevan');

  with
  linked as (
    select c.agr_no,
           case
             when regexp_replace(c.chat_link, '^.*#', '') ~ '^-?\d+$'
             then regexp_replace(c.chat_link, '^.*#', '')::bigint
           end as chat_id
    from mqa_chats c
    where c.status = 'Active'
      and c.chat_link is not null
  ),
  msgs as (
    select l.agr_no, m.text, m.created_at
    from public.messages m
    join linked l on l.chat_id = m.chat_id
    where m.sender_role = 'accountant'
      and m.created_at >= period_start
      and m.created_at <  period_end
      and m.text is not null
      and length(m.text) > 3
  ),
  signals as (
    select distinct agr_no, created_at, sig_cat, sig_type
    from msgs
    cross join lateral (
      values
        (case when text ~* '(налог|декларац|ндс|налогов)'
               and text ~* '(отправ|подал|подан|сдан|направил|загрузил|выгрузил|сдала|отправила|отчита|задеклар|сдела|оформ|готов)'
               and text !~* neg_send
              then 'main_taxes' end, 'done'),
        (case when text ~* '(налог|декларац|ндс|налогов)'
               and text ~* neg_send
              then 'main_taxes' end, 'neg'),
        (case when text ~* '(зарплат|ведомост|заработн|\mзп\M|авансовый\s+отчет|авансов)'
               and text ~* '(получ|пришл|прислал|подпис|сдал|предоставил|скинул|сбросил|прислала|получила|пришла|передал|отправил|отправила|отправлен|отправлена|отправили|выслал|переслал|сдела|сделан|готов|выполн|оформ|провед|направля|направил|направлен|перечислил|перевёл|перевел|переведен|переведён|переведена|произвел|произвёл)'
               and text !~* neg_done
              then 'salary' end, 'done'),
        (case when text ~* '(зарплат|ведомост|заработн|\mзп\M|авансов)'
               and text ~* '(рассыл|разосл|разошл|уведомл|уведомил|уведомля|сообщаем|сообщил|информир|напоминаем|напомнил)'
               and text !~* neg_send
              then 'salary' end, 'done'),
        (case when text ~* '(зарплат|ведомост|заработн|\mзп\M)'
               and text ~* '(запрос|прошу|просьб|нужн|пришлит|отправьт|скиньт|передайт|пожалуйст|жду|ожида)'
              then 'salary' end, 'req'),
        (case when text ~* '(зарплат|ведомост|заработн|\mзп\M|авансовый\s+отчет|авансов)'
               and text ~* neg_done
              then 'salary' end, 'neg'),
        (case when text ~* '(зарплат|ведомост|заработн|\mзп\M|авансовый\s+отчет|авансов)'
               and text ~* neg_send
              then 'salary' end, 'neg'),
        (case when text ~* '(первичн|первичк|акт[ыа]?\M|документ|накладн|счет-факт|счёт-факт)'
               and text ~* '(получ|пришл|прислал|сдал|предоставил|скинул|передал|прислала|получила|пришла|отправил|отправила|отправлен|отправлена|отправили|выслал|переслал|сдела|сделан|готов|выполн|оформ|провед)'
               and text !~* neg_done
              then 'primary_docs' end, 'done'),
        (case when text ~* '(первичн|первичк|акт[ыа]?\M|документ|накладн)'
               and text ~* '(запрос|прошу|просьб|нужн|пришлит|отправьт|скиньт|передайт|пожалуйст|жду|ожида)'
              then 'primary_docs' end, 'req'),
        (case when text ~* '(первичн|первичк|акт[ыа]?\M|документ|накладн|счет-факт|счёт-факт)'
               and text ~* neg_done
              then 'primary_docs' end, 'neg'),
        (case when text ~* '(долг|задолженност|задолж)'
               and text ~* '(оплатил|оплатила|оплачен|оплачена|оплачено|оплата\s+прошла|выплатил|выплатила|погашен|погасил|закрыт|закрыта|нет\s+долга|нет\s+задолж)'
               and text !~* neg_paid
              then 'debts' end, 'paid'),
        (case when text ~* '(долг|задолженност)'
               and text ~* '(позвон|звонил|звонок|обзвон|перезвон|созвон)'
              then 'debts' end, 'call'),
        (case when text ~* '(долг|задолженност)'
               and text ~* '(написал|написала|напомина|уведомил|сообщил|написали|напомнил|прос(им|ьб)|оплатит[ьеё]|к\s+оплате)'
              then 'debts' end, 'req'),

        (case when text ~* '(հարկ|ԱԱՀ|հայտ|հռչ|հաշվետ)'
               and text ~* '(ուղարկ|ներկայաց|հանձնե|բեռնե|ներբեռն)'
               and text !~* neg_hy
              then 'main_taxes' end, 'done'),
        (case when text ~* '(հարկ|ԱԱՀ|հայտ|հռչ|հաշվետ)'
               and text ~* neg_hy
              then 'main_taxes' end, 'neg'),
        (case when text ~* '(աշխատավարձ|աշխ\.?\s*վ|ա/վ|ա\.վ\.|հաշվ\.?\s*ց|ռոճիկ)'
               and text ~* '(ստաց|ուղարկ|տրամ|ստ\.)'
               and text !~* neg_hy
              then 'salary' end, 'done'),
        (case when text ~* '(աշխատավարձ|աշխ\.?\s*վ|ա/վ|ա\.վ\.|հաշվ\.?\s*ց|ռոճիկ)'
               and text ~* '(տեղեկացն|հիշեցն)'
               and text !~* neg_send_hy
              then 'salary' end, 'done'),
        (case when text ~* '(աշխատավարձ|աշխ\.?\s*վ|ա/վ|ռոճիկ)'
               and text ~* '(խնդրե|կարիք|պե՞տք)'
              then 'salary' end, 'req'),
        (case when text ~* '(աշխատավարձ|աշխ\.?\s*վ|ա/վ|ա\.վ\.|հաշվ\.?\s*ց|ռոճիկ)'
               and text ~* neg_hy
              then 'salary' end, 'neg'),
        (case when text ~* '(փաստաթ|[աՈ][կք]տ|հաշիվ|[աՈ][կք]ներ|ն[եա]ր[կք]ա)'
               and text ~* '(ստաց|ուղարկ|հանձնե|ստ\.)'
               and text !~* neg_hy
              then 'primary_docs' end, 'done'),
        (case when text ~* '(փաստաթ|[աՈ][կք]տ|հաշիվ)'
               and text ~* '(խնդրե|կարիք|պետք)'
              then 'primary_docs' end, 'req'),
        (case when text ~* '(փաստաթ|[աՈ][կք]տ|հաշիվ|[աՈ][կք]ներ|ն[եա]ր[կք]ա)'
               and text ~* neg_hy
              then 'primary_docs' end, 'neg'),
        (case when text ~* '(պարտք|պարտաբ)'
               and text ~* '(վճար|մարե|փակե|չկա\s+պ|պարտք\s+չ)'
               and text !~* neg_hy
              then 'debts' end, 'paid'),
        (case when text ~* '(պարտք|պարտաբ)'
               and text ~* '(զանգ|զ\.)'
              then 'debts' end, 'call'),
        (case when text ~* '(պարտք|պարտաբ)'
               and text ~* '(գր[եէ]|հուշ|տեղեկ|ծանուց)'
              then 'debts' end, 'req')
    ) t(sig_cat, sig_type)
    where sig_cat is not null
  ),
  counts as (
    select agr_no, sig_cat as category, sig_type as stype,
           count(*)::int as n, max(created_at) as last_at
    from signals group by agr_no, sig_cat, sig_type
  ),
  pivoted as (
    select agr_no, category,
           coalesce(max(case when stype = 'done' then n end), 0) as done_n,
           coalesce(max(case when stype = 'req'  then n end), 0) as req_n,
           coalesce(max(case when stype = 'call' then n end), 0) as call_n,
           coalesce(max(case when stype = 'paid' then n end), 0) as paid_n,
           coalesce(max(case when stype = 'neg'  then n end), 0) as neg_n,
           greatest(
             max(case when stype = 'done' then last_at end),
             max(case when stype = 'req'  then last_at end),
             max(case when stype = 'call' then last_at end),
             max(case when stype = 'paid' then last_at end),
             max(case when stype = 'neg'  then last_at end)
           ) as detected_at
    from counts group by agr_no, category
  ),
  final as (
    select agr_no, category,
           case category
             when 'main_taxes' then
               case when done_n >= 1 then 'Отправил'
                    when neg_n  >= 1 then 'Не отправил' end
             when 'salary' then
               case when done_n >= 1 then 'Получил'
                    when req_n  >= 2 then 'Запросил 2, не получил'
                    when req_n  =  1 then 'Запросил 1, не получил'
                    when neg_n  >= 1 then 'Запросил 1, не получил' end
             when 'primary_docs' then
               case when done_n >= 1 then 'Получил'
                    when req_n  >= 2 then 'Запросил 2, не получил'
                    when req_n  =  1 then 'Запросил 1, не получил'
                    when neg_n  >= 1 then 'Запросил 1, не получил' end
             when 'debts' then
               case when paid_n >= 1 then 'Нет долга'
                    when call_n >= 1 then '1-й позвонил'
                    when req_n  >= 2 then '2-й написал'
                    when req_n  =  1 then '1-й написал' end
           end as status,
           detected_at
    from pivoted
  )
  insert into mqa_chat_mailings
         (agr_no, period, category, status, source, detected_at, updated_at)
  select  agr_no, period_ym, category, status, 'telegram', detected_at, now()
  from    final
  where   status is not null
  on conflict (agr_no, period, category) do update
    set status      = excluded.status,
        detected_at = excluded.detected_at,
        updated_at  = now()
    where mqa_chat_mailings.source <> 'manual';
end;
$function$;
