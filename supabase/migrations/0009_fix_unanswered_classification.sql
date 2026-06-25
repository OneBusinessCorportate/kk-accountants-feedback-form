-- Fix false "Без ответа" classifications in qa_unanswered_chats.
--
-- Two bugs fixed:
--
-- Bug 1 (substantive-text gate): the NOT EXISTS check in pending_validated
-- required qa_is_substantive_staff_text(text), which returns FALSE for
-- pure-emoji messages ("✅", "👍", etc.). So a staff member replying with
-- just an emoji was invisible to the suppression check, leaving the chat
-- in "без ответа" even though the client DID receive a reply.
-- Fix: remove the substantive-text requirement from the NOT EXISTS check.
-- Any message from a recognized staff member after the client question
-- counts as "answered", regardless of content.
--
-- Bug 2 (sender_id IS NULL gate): the name-based employee recognition in
-- pending_validated required BOTH sender_id IS NULL AND username IS NULL
-- before matching by display name. Since every Telegram message carries a
-- sender_id, this condition was almost never true, making employees whose
-- telegram_id is not in the employees table effectively invisible as staff.
-- qa_answered_late_chats has NO such restriction (inconsistency). Result:
-- a chat where staff replied was classified "без ответа" rather than
-- "поздний ответ клиенту".
-- Fix: drop the sender_id/username IS NULL prerequisite from name matching
-- in pending_validated and in last_staff, matching the late-answer function.
--
-- Product rule (2026-06-25): if ANY employee wrote ANYTHING after the
-- client message, it is an answer. If the answer was late, classify it
-- as "Поздний ответ клиенту", not "Без ответа клиенту".

CREATE OR REPLACE FUNCTION public.qa_unanswered_chats(
    p_since          timestamptz,
    p_threshold_hours numeric
)
RETURNS json
LANGUAGE sql
STABLE
AS $func$
    WITH
    force_review AS (SELECT public.qa_force_review_mode() AS fr),
    known_employee_ids AS (
        SELECT telegram_id AS tid FROM public.employees
        WHERE telegram_id IS NOT NULL AND is_active = TRUE
        UNION
        SELECT telegram_user_id FROM public.employees
        WHERE telegram_user_id IS NOT NULL AND is_active = TRUE
    ),
    known_employee_usernames AS (
        SELECT LOWER(REPLACE(COALESCE(telegram_username,''),'@','')) AS uname
        FROM public.employees
        WHERE is_active = TRUE AND NULLIF(TRIM(telegram_username),'') IS NOT NULL
    ),
    known_employee_names AS (
        SELECT LOWER(TRIM(full_name)) AS ename FROM public.employees
        WHERE is_active = TRUE AND NULLIF(TRIM(full_name),'') IS NOT NULL
        UNION SELECT LOWER(TRIM(split_part(full_name,' ',1))) FROM public.employees
        WHERE is_active = TRUE AND LENGTH(TRIM(split_part(full_name,' ',1))) > 2
        UNION SELECT LOWER(TRIM(alias)) FROM public.employees,
              UNNEST(COALESCE(display_aliases, ARRAY[]::text[])) AS alias
        WHERE is_active = TRUE AND LENGTH(TRIM(alias)) > 2
    ),
    global_frontier AS (SELECT MAX(created_at) AS f FROM messages),
    chat_frontier   AS (SELECT chat_id, MAX(created_at) AS cmax FROM messages GROUP BY chat_id),
    last_staff AS (
        SELECT chat_id, MAX(last_at) AS last_staff_at
        FROM (
            SELECT chat_id, created_at AS last_at FROM messages
            WHERE public.qa_is_staff_role(sender_role)
              AND created_at >= NOW() - INTERVAL '120 hours'
              AND public.qa_is_substantive_staff_text(text)
            UNION ALL
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.sender_id IS NOT NULL
              AND m.created_at >= NOW() - INTERVAL '120 hours'
              AND m.sender_id IN (SELECT tid FROM known_employee_ids)
              AND public.qa_is_substantive_staff_text(m.text)
            UNION ALL
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.created_at >= NOW() - INTERVAL '120 hours'
              AND NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NOT NULL
              AND LOWER(m.raw_payload->'from_user'->>'username') IN (SELECT uname FROM known_employee_usernames)
              AND public.qa_is_substantive_staff_text(m.text)
            UNION ALL
            -- FIX: removed (sender_id IS NULL AND username IS NULL) prerequisite so employees
            -- recognised by display name count as recently-active staff even when they have a
            -- telegram_id recorded in the messages table.
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.created_at >= NOW() - INTERVAL '120 hours'
              AND m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
              AND public.qa_is_substantive_staff_text(m.text)
              AND (m.sender_name ILIKE '%Accounting%'
                OR m.sender_name ILIKE '%OneBusiness%'
                OR m.sender_name ILIKE '%ВанБизнес%'
                OR m.sender_name ILIKE '%бухгалтер%'
                OR m.sender_name ILIKE '%менеджер%'
                OR LOWER(TRIM(m.sender_name)) IN (SELECT ename FROM known_employee_names))
        ) combined GROUP BY chat_id
    ),
    client_msgs AS (
        SELECT m.chat_id, m.created_at, m.text, m.sender_name,
            COALESCE(m.qa_is_meaningful, public.qa_is_meaningful_client_text(m.text)) AS is_meaningful,
            (COALESCE(m.qa_is_closing, FALSE) OR public.qa_is_client_closing_signal(m.text)) AS is_closing,
            public.qa_is_directed_client_request(m.text) AS is_directed
        FROM messages m
        WHERE public.qa_is_client_role(m.sender_role)
          AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT tid FROM known_employee_ids))
          AND (m.sender_id IS NULL OR m.sender_id NOT IN (1087968824, 136817688))
          AND (NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NULL
            OR LOWER(m.raw_payload->'from_user'->>'username') NOT IN (SELECT uname FROM known_employee_usernames))
          AND m.text IS NOT NULL AND TRIM(m.text) <> ''
          AND m.created_at >= NOW() - INTERVAL '120 hours'
          AND NOT (m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
            AND (m.sender_name ILIKE '%Accounting%'
              OR m.sender_name ILIKE '%OneBusiness%'
              OR m.sender_name ILIKE '%ВанБизнес%'
              OR m.sender_name ILIKE '%бухгалтер%'
              OR m.sender_name ILIKE '%менеджер%'
              OR (m.sender_id IS NULL
                  AND NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NULL
                  AND LOWER(TRIM(m.sender_name)) IN (SELECT ename FROM known_employee_names))))
    ),
    peer_burst AS (
        SELECT cm.chat_id
        FROM client_msgs cm
        LEFT JOIN last_staff ls ON ls.chat_id = cm.chat_id
        WHERE (ls.last_staff_at IS NULL OR cm.created_at > ls.last_staff_at)
        GROUP BY cm.chat_id
        HAVING COUNT(DISTINCT cm.sender_name) >= 2
           AND bool_or(cm.text ~* '\m(ты|тебя|тебе|тобой|твой|тво[яёе]|твои|твоих|твоим|твоего|твоей)\M')
    ),
    client_agg AS (
        SELECT cm.chat_id, ls.last_staff_at,
            MAX(cm.created_at) AS latest_any_text_at,
            MAX(cm.created_at) FILTER (WHERE NOT cm.is_closing) AS latest_nontrivial_at,
            MIN(cm.created_at) FILTER (WHERE cm.is_meaningful
                AND (ls.last_staff_at IS NULL OR cm.created_at > ls.last_staff_at)
                AND (pb.chat_id IS NULL OR cm.is_directed)) AS sla_start_at,
            (ARRAY_AGG(cm.text ORDER BY cm.created_at ASC NULLS LAST)
                FILTER (WHERE cm.is_meaningful
                    AND (ls.last_staff_at IS NULL OR cm.created_at > ls.last_staff_at)
                    AND (pb.chat_id IS NULL OR cm.is_directed)))[1] AS sla_start_text,
            (ARRAY_AGG(cm.sender_name ORDER BY cm.created_at ASC NULLS LAST)
                FILTER (WHERE cm.is_meaningful
                    AND (ls.last_staff_at IS NULL OR cm.created_at > ls.last_staff_at)
                    AND (pb.chat_id IS NULL OR cm.is_directed)))[1] AS sla_start_sender
        FROM client_msgs cm
        LEFT JOIN last_staff ls ON ls.chat_id = cm.chat_id
        LEFT JOIN peer_burst pb ON pb.chat_id = cm.chat_id
        GROUP BY cm.chat_id, ls.last_staff_at
    ),
    pending AS (
        SELECT ca.chat_id,
               ca.sla_start_at      AS oldest_pending_at,
               ca.sla_start_sender  AS sender_name,
               ca.sla_start_text    AS oldest_pending_text,
               ca.last_staff_at,
               (ca.last_staff_at IS NOT NULL
                AND public.qa_business_hours_elapsed(ca.last_staff_at, NOW()) <= 2) AS staff_recent,
               CASE
                   WHEN gf.f IS NULL OR cf.cmax IS NULL THEN NULL
                   WHEN public.qa_business_hours_elapsed(cf.cmax, gf.f) > 18  THEN 'import_stale'
                   WHEN public.qa_business_hours_elapsed(cf.cmax, gf.f) > 8   THEN 'possible_dropped_reply'
                   ELSE NULL
               END AS data_incomplete_reason,
               fr.fr AS force_review
        FROM client_agg ca
        CROSS JOIN global_frontier gf
        CROSS JOIN force_review fr
        LEFT JOIN chat_frontier cf ON cf.chat_id = ca.chat_id
        WHERE ca.sla_start_at IS NOT NULL
          AND ca.latest_any_text_at = ca.latest_nontrivial_at
    ),
    pending_validated AS (
        SELECT p.chat_id, p.oldest_pending_at, p.sender_name, p.oldest_pending_text,
               (p.data_incomplete_reason IS NOT NULL) AS data_incomplete,
               (p.staff_recent OR p.data_incomplete_reason IS NOT NULL OR p.force_review) AS low_confidence,
               p.data_incomplete_reason, p.force_review,
               NULL::text AS last_employee_reply_text
        FROM pending p
        -- FIX 1: removed qa_is_substantive_staff_text — any staff message (including
        -- emoji-only "✅", "👍", stickers) counts as "answered". Only the sender identity
        -- matters, not the message content.
        -- FIX 2: removed (sender_id IS NULL AND username IS NULL) prerequisite from the
        -- name-based match, consistent with qa_answered_late_chats. Employees known by
        -- display name are now correctly recognised even when sender_id is present.
        WHERE NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.chat_id = p.chat_id
              AND m.created_at > p.oldest_pending_at
              AND (public.qa_is_staff_role(m.sender_role)
                OR (m.sender_id IS NOT NULL
                    AND m.sender_id IN (SELECT tid FROM known_employee_ids))
                OR (NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NOT NULL
                    AND LOWER(m.raw_payload->'from_user'->>'username') IN (SELECT uname FROM known_employee_usernames))
                OR (m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
                    AND (m.sender_name ILIKE '%Accounting%'
                      OR m.sender_name ILIKE '%OneBusiness%'
                      OR m.sender_name ILIKE '%ВанБизнес%'
                      OR m.sender_name ILIKE '%бухгалтер%'
                      OR m.sender_name ILIKE '%менеджер%'
                      OR LOWER(TRIM(m.sender_name)) IN (SELECT ename FROM known_employee_names))))
        )
        AND NOT EXISTS (
            SELECT 1 FROM staff_reactions sr
            JOIN messages rm ON rm.chat_id = sr.chat_id AND rm.message_id = sr.reacted_message_id
            WHERE sr.chat_id = p.chat_id
              AND rm.created_at >= p.oldest_pending_at
              AND public.qa_is_meaningful_client_text(rm.text)
              AND (sr.reactor_id IN (SELECT tid FROM known_employee_ids)
                   OR public.qa_is_staff_role(sr.reactor_role))
        )
    ),
    eligible AS (
        SELECT chat_id FROM chats
        WHERE is_active = TRUE
          AND chat_type IN ('group','supergroup')
          AND chat_name NOT ILIKE 'test%'
          AND (excluded_from_qa IS NULL OR excluded_from_qa = FALSE)
          AND chat_name !~* 'аналитика данных'
          AND chat_name !~* 'отдел продаж'
          AND chat_name !~* 'accounting dd'
          AND chat_name !~* 'chattestaagh'
    ),
    chat_staff_attrib AS (
        SELECT cep.chat_id, e.role, e.full_name FROM chat_employee_presence cep
        JOIN employees e ON e.id = cep.employee_id AND e.is_active = TRUE
        WHERE cep.is_present = TRUE AND cep.chat_id IN (SELECT chat_id FROM pending_validated)
        UNION
        SELECT m.chat_id, e.role, e.full_name FROM messages m
        JOIN employees e ON e.is_active = TRUE AND (
            (m.sender_id IS NOT NULL
                AND (e.telegram_id = m.sender_id OR e.telegram_user_id = m.sender_id))
            OR (NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))),'') IS NOT NULL
                AND NULLIF(TRIM(e.telegram_username),'') IS NOT NULL
                AND LOWER(REPLACE(e.telegram_username,'@','')) = LOWER(m.raw_payload->'from_user'->>'username'))
            OR (m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
                AND (LOWER(TRIM(m.sender_name)) = LOWER(TRIM(e.full_name))
                  OR LOWER(TRIM(m.sender_name)) = ANY(
                       SELECT LOWER(TRIM(a))
                       FROM UNNEST(COALESCE(e.display_aliases, ARRAY[]::text[])) a))))
        WHERE m.chat_id IN (SELECT chat_id FROM pending_validated)
    ),
    staff_per_chat AS (
        SELECT chat_id,
            STRING_AGG(DISTINCT full_name, ', ') FILTER (WHERE role = 'accountant')           AS accountant_names,
            STRING_AGG(DISTINCT full_name, ', ') FILTER (WHERE role = 'head_accountant')      AS head_accountant_names,
            STRING_AGG(DISTINCT full_name, ', ') FILTER (WHERE role IN (
                'manager','sales_manager','admin','support','lawyer','ceo'))                   AS manager_names,
            STRING_AGG(DISTINCT full_name, ', ')                                              AS staff_names,
            STRING_AGG(DISTINCT role,      ', ')                                              AS staff_roles
        FROM chat_staff_attrib GROUP BY chat_id
    )
    SELECT COALESCE(json_agg(json_build_object(
        'chat_id',                        pv.chat_id,
        'chat_name',                      c.chat_name,
        'oldest_pending_at',              pv.oldest_pending_at,
        'oldest_pending_text',            pv.oldest_pending_text,
        'sender_name',                    pv.sender_name,
        'accountant_names',               sp.accountant_names,
        'head_accountant_names',          sp.head_accountant_names,
        'manager_names',                  sp.manager_names,
        'staff_names',                    sp.staff_names,
        'staff_roles',                    sp.staff_roles,
        'hours_ago',                      ROUND(public.qa_business_hours_elapsed(pv.oldest_pending_at, NOW())::numeric, 1),
        'problematic_client_message',     pv.oldest_pending_text,
        'problematic_client_message_time',pv.oldest_pending_at,
        'last_employee_message_after_it', pv.last_employee_reply_text,
        'confidence',    CASE WHEN pv.low_confidence THEN 'low' ELSE 'high' END,
        'needs_review',  COALESCE(pv.low_confidence, FALSE),
        'data_incomplete', COALESCE(pv.data_incomplete OR pv.force_review, FALSE),
        'severity',      CASE WHEN public.qa_is_strong_client_request(pv.oldest_pending_text)
                              THEN 'critical' ELSE 'minor' END,
        'flag_reason',   CASE
                            WHEN pv.force_review THEN 'data_incomplete_global_safe_mode'
                            WHEN pv.data_incomplete_reason = 'import_stale'           THEN 'data_incomplete_import_stale'
                            WHEN pv.data_incomplete_reason = 'possible_dropped_reply' THEN 'data_incomplete_possible_dropped_reply'
                            WHEN pv.low_confidence THEN 'unanswered_but_staff_recently_active'
                            ELSE 'no_staff_reply_after_client_question'
                         END
    ) ORDER BY public.qa_business_hours_elapsed(pv.oldest_pending_at, NOW()) DESC), '[]'::json)
    FROM pending_validated pv
    JOIN eligible e  ON e.chat_id  = pv.chat_id
    JOIN chats    c  ON c.chat_id  = pv.chat_id
    LEFT JOIN staff_per_chat sp ON sp.chat_id = pv.chat_id
    WHERE public.qa_business_hours_elapsed(pv.oldest_pending_at, NOW()) >= p_threshold_hours;
$func$;
