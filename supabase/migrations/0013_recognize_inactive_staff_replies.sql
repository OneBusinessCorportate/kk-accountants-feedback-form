-- Recognize replies from INACTIVE (former) employees as real staff answers.
--
-- Bug (N-3545 «ВНЖ Мария Кабаева язык RU», 2026-06-26): the chat was flagged
-- «Без ответа клиенту» (no_staff_reply_after_client_question) even though the
-- accountant Satenik answered the client's 13:55 question three minutes later
-- at 13:58 (and again the next morning).
--
-- Root cause: two things combined.
--   1. The source `messages` rows for Satenik's later replies are mislabeled
--      `sender_role = 'client'` (only her first message carries 'accountant'),
--      so role-based staff recognition misses them.
--   2. Satenik IS a registered employee (telegram_id 8704377479) but her row is
--      `is_active = FALSE` (she left / was deactivated). Every staff-recognition
--      CTE in qa_unanswered_chats / qa_answered_late_chats filters
--      `is_active = TRUE`, so her telegram_id was NOT in `known_employee_ids`.
--   With both the role tag AND the id-based recognition failing, the suppression
--   `NOT EXISTS (... staff reply after the client question ...)` saw no reply and
--   flagged the chat as unanswered — a false positive.
--
-- Product rule (extends 0009): "if ANY employee wrote ANYTHING after the client
-- message, it is an answer." An employee who has since been deactivated is still
-- an employee — a reply they sent still answered the client. Whether to ATTRIBUTE
-- / assign a current problem to someone is a separate question (that still uses
-- is_active = TRUE, via chat_staff_attrib here and the qa_* responder/accountant
-- name resolution), but recognising that a reply HAPPENED must not depend on the
-- replier still being active.
--
-- Fix: drop the `is_active = TRUE` filter from the numeric `known_employee_ids`
-- CTE (telegram_id / telegram_user_id) in BOTH detection functions. We broaden
-- ONLY the immutable, unique, exact-match Telegram user-id set — Telegram ids are
-- never reused, so this cannot collide with a client. The fuzzier username- and
-- display-name recognition tiers are deliberately left active-only to avoid
-- enlarging the name-collision surface.
--
-- These functions are otherwise reproduced verbatim from their live definitions
-- (which already carry the 0009 substantive-text/name fixes and the later
-- qa_is_employee_promise handling); only the two `AND is_active = TRUE` clauses
-- inside known_employee_ids are removed.

CREATE OR REPLACE FUNCTION public.qa_unanswered_chats(
    p_since           timestamptz,
    p_threshold_hours numeric
)
RETURNS json
LANGUAGE sql
STABLE
AS $func$
    WITH
    force_review AS (SELECT public.qa_force_review_mode() AS fr),
    known_employee_ids AS (
        -- FIX (0013): no is_active filter — a former employee's reply is still a reply.
        SELECT telegram_id AS tid FROM public.employees
        WHERE telegram_id IS NOT NULL
        UNION
        SELECT telegram_user_id FROM public.employees
        WHERE telegram_user_id IS NOT NULL
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
    -- Only real (non-promise) staff messages advance the SLA timer.
    -- A promise ("I'll answer in X min") is NOT a real answer.
    last_staff AS (
        SELECT chat_id, MAX(last_at) AS last_staff_at
        FROM (
            SELECT chat_id, created_at AS last_at FROM messages
            WHERE public.qa_is_staff_role(sender_role)
              AND created_at >= NOW() - INTERVAL '120 hours'
              AND public.qa_is_substantive_staff_text(text)
              AND NOT public.qa_is_employee_promise(COALESCE(text, ''))
            UNION ALL
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.sender_id IS NOT NULL
              AND m.created_at >= NOW() - INTERVAL '120 hours'
              AND m.sender_id IN (SELECT tid FROM known_employee_ids)
              AND public.qa_is_substantive_staff_text(m.text)
              AND NOT public.qa_is_employee_promise(COALESCE(m.text, ''))
            UNION ALL
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.created_at >= NOW() - INTERVAL '120 hours'
              AND NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NOT NULL
              AND LOWER(m.raw_payload->'from_user'->>'username') IN (SELECT uname FROM known_employee_usernames)
              AND public.qa_is_substantive_staff_text(m.text)
              AND NOT public.qa_is_employee_promise(COALESCE(m.text, ''))
            UNION ALL
            SELECT m.chat_id, m.created_at FROM messages m
            WHERE m.created_at >= NOW() - INTERVAL '120 hours'
              AND m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
              AND public.qa_is_substantive_staff_text(m.text)
              AND NOT public.qa_is_employee_promise(COALESCE(m.text, ''))
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
        -- A promise ("I'll answer in X min") is NOT a real answer; only a genuine
        -- staff reply clears the chat from the unanswered queue.
        WHERE NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.chat_id = p.chat_id
              AND m.created_at > p.oldest_pending_at
              AND NOT public.qa_is_employee_promise(COALESCE(m.text, ''))
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

CREATE OR REPLACE FUNCTION public.qa_answered_late_chats(
    p_since   timestamptz,
    p_sla_hours numeric DEFAULT 2
)
RETURNS json
LANGUAGE sql
STABLE
AS $func$
    WITH
    known_employee_ids AS (
        -- FIX (0013): no is_active filter — a former employee's reply is still a reply.
        SELECT telegram_id AS tid FROM public.employees
        WHERE telegram_id IS NOT NULL
        UNION
        SELECT telegram_user_id AS tid FROM public.employees
        WHERE telegram_user_id IS NOT NULL
    ),
    known_employee_usernames AS (
        SELECT LOWER(REPLACE(COALESCE(telegram_username,''),'@','')) AS uname
        FROM public.employees
        WHERE is_active = TRUE AND NULLIF(TRIM(telegram_username),'') IS NOT NULL
    ),
    known_employee_names AS (
        SELECT LOWER(TRIM(full_name)) AS ename
        FROM public.employees
        WHERE is_active = TRUE AND NULLIF(TRIM(full_name),'') IS NOT NULL
        UNION
        SELECT LOWER(TRIM(split_part(full_name,' ',1))) AS ename
        FROM public.employees
        WHERE is_active = TRUE
          AND LENGTH(TRIM(split_part(full_name,' ',1))) > 2
        UNION
        SELECT LOWER(TRIM(alias)) AS ename
        FROM public.employees, UNNEST(COALESCE(display_aliases, ARRAY[]::text[])) AS alias
        WHERE is_active = TRUE AND LENGTH(TRIM(alias)) > 2
    ),
    eligible AS (
        SELECT chat_id FROM chats
        WHERE is_active = TRUE
          AND chat_type IN ('group', 'supergroup')
          AND chat_name NOT ILIKE 'test%'
          AND (excluded_from_qa IS NULL OR excluded_from_qa = FALSE)
    ),
    client_requests AS (
        SELECT
            m.chat_id,
            m.created_at  AS req_time,
            m.text        AS req_text,
            m.sender_name AS client_name
        FROM messages m
        JOIN eligible e ON e.chat_id = m.chat_id
        WHERE public.qa_is_client_role(m.sender_role)
          AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT tid FROM known_employee_ids))
          AND (m.sender_id IS NULL OR m.sender_id NOT IN (1087968824, 136817688))
          AND (
            NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NULL
            OR LOWER(m.raw_payload->'from_user'->>'username')
               NOT IN (SELECT uname FROM known_employee_usernames)
          )
          AND NOT (
            m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
            AND (
              LOWER(TRIM(m.sender_name)) IN (SELECT ename FROM known_employee_names)
              OR m.sender_name ILIKE '%Accounting%'
              OR m.sender_name ILIKE '%OneBusiness%'
              OR m.sender_name ILIKE '%ВанБизнес%'
              OR m.sender_name ILIKE '%бухгалтер%'
              OR m.sender_name ILIKE '%менеджер%'
            )
          )
          AND m.text IS NOT NULL AND TRIM(m.text) <> ''
          AND COALESCE(m.qa_is_meaningful, public.qa_is_meaningful_client_text(m.text))
          AND m.created_at >= NOW() - INTERVAL '50 hours'
          -- Recent-engagement guard: skip requests that arrived within 2 business
          -- hours AFTER a staff reply (active back-and-forth). Per product rule
          -- such follow-ups are 'needs review', not a hard late breach (Ермаков).
          AND NOT EXISTS (
              SELECT 1 FROM messages s
              WHERE s.chat_id = m.chat_id
                AND s.created_at < m.created_at
                AND s.created_at >= m.created_at - INTERVAL '24 hours'
                AND (
                    public.qa_is_staff_role(s.sender_role)
                    OR (s.sender_id IS NOT NULL AND s.sender_id IN (SELECT tid FROM known_employee_ids))
                    OR (NULLIF(TRIM(LOWER(COALESCE(s.raw_payload->'from_user'->>'username',''))), '') IS NOT NULL
                        AND LOWER(s.raw_payload->'from_user'->>'username') IN (SELECT uname FROM known_employee_usernames))
                )
                AND public.qa_business_hours_elapsed(s.created_at, m.created_at) <= 2
          )
    ),
    sla_pairs AS (
        SELECT
            cr.chat_id,
            cr.req_time,
            cr.req_text,
            cr.client_name,
            emp.emp_time  AS reply_time,
            emp.emp_name  AS responder_name,
            public.qa_business_hours_elapsed(cr.req_time, emp.emp_time) AS biz_hours
        FROM client_requests cr
        LEFT JOIN LATERAL (
            SELECT
                m.created_at                                    AS emp_time,
                COALESCE(m.sender_name, m.sender_role, '?')    AS emp_name
            FROM messages m
            WHERE m.chat_id = cr.chat_id
              AND m.created_at > cr.req_time
              AND (
                public.qa_is_staff_role(m.sender_role)
                OR (m.sender_id IS NOT NULL
                    AND m.sender_id IN (SELECT tid FROM known_employee_ids))
                OR (NULLIF(TRIM(LOWER(COALESCE(m.raw_payload->'from_user'->>'username',''))), '') IS NOT NULL
                    AND LOWER(m.raw_payload->'from_user'->>'username')
                        IN (SELECT uname FROM known_employee_usernames))
                OR (m.sender_name IS NOT NULL AND LENGTH(TRIM(m.sender_name)) > 2
                    AND (
                        LOWER(TRIM(m.sender_name)) IN (SELECT ename FROM known_employee_names)
                        OR m.sender_name ILIKE '%Accounting%'
                        OR m.sender_name ILIKE '%OneBusiness%'
                        OR m.sender_name ILIKE '%ВанБизнес%'
                        OR m.sender_name ILIKE '%бухгалтер%'
                        OR m.sender_name ILIKE '%менеджер%'
                    ))
              )
            ORDER BY m.created_at ASC
            LIMIT 1
        ) emp ON TRUE
        WHERE emp.emp_time IS NOT NULL
          AND public.qa_business_hours_elapsed(cr.req_time, emp.emp_time) > p_sla_hours
          -- p_since is vestigial: the reply is bounded to a FIXED 24h window so
          -- every consumer (report / dashboards) sees the same late set, and a
          -- long-resolved late episode stops rendering as a CURRENT problem
          -- days later (СТАЙЛРР N-740, 2026-06-12 feedback).
          AND emp.emp_time >= NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
              SELECT 1 FROM messages ack
              WHERE ack.chat_id = cr.chat_id
                AND ack.created_at > cr.req_time
                AND ack.created_at < emp.emp_time
                AND public.qa_is_client_role(ack.sender_role)
                AND (ack.sender_id IS NULL
                     OR ack.sender_id NOT IN (SELECT tid FROM known_employee_ids))
                AND (
                  NULLIF(TRIM(LOWER(COALESCE(ack.raw_payload->'from_user'->>'username',''))), '') IS NULL
                  OR LOWER(ack.raw_payload->'from_user'->>'username')
                     NOT IN (SELECT uname FROM known_employee_usernames)
                )
                AND COALESCE(ack.qa_is_closing, public.qa_is_client_closing_signal(ack.text))
          )
    ),
    best AS (
        SELECT DISTINCT ON (chat_id)
            chat_id, req_time, req_text, client_name, reply_time, responder_name, biz_hours
        FROM sla_pairs
        ORDER BY chat_id, biz_hours DESC, req_time ASC
    )
    SELECT COALESCE(json_agg(json_build_object(
        'chat_id',             b.chat_id,
        'chat_name',           c.chat_name,
        'oldest_pending_text', b.req_text,
        'client_name',         b.client_name,
        'hours_ago',           ROUND(b.biz_hours::numeric, 1),
        'responder_name',      b.responder_name,
        'reply_time',          b.reply_time,
        'request_time',        b.req_time,
        'flag_reason',         'answered_but_after_sla'
    ) ORDER BY b.biz_hours DESC), '[]'::json)
    FROM best b
    JOIN chats c ON c.chat_id = b.chat_id;
$func$;
