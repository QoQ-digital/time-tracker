// Build the full INSERT SQL for the save path with all user-controlled
// values inlined as a single JSONB literal, single-quote-escaped.
//
// PR #4 added lookup_mode (last_confirmed | by_message_id) for /edit_last
// and edited Telegram messages. PR #5 adds an UNCONDITIONAL pending
// replacement: any open time_pending_clarifications for this chat is
// flipped to 'replaced' along with its slots and batch. This implements
// spec §22 — when the user answers the clarification with a new free-form
// message instead of a digit/[CODE] pick, the question is dropped without
// double-counting and the new message is saved fresh.

const ctx = $input.first().json;
const slots = ctx.slots || [];
if (slots.length === 0) {
  return [{ json: { ...ctx, skipSave: true } }];
}

const cap = parseInt($env.MAX_ACTIVE_EXAMPLES_PER_CATEGORY || '30', 10);

function jsonbLiteral(obj) {
  return `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;
}

const payload = {
  chat_id: ctx.chatId,
  user_id: ctx.userId,
  message_id: ctx.messageId,
  text: ctx.text,
  date: ctx.logDate || ctx.todayDate,
  slots,
  lookup_mode: ctx.lookup_mode || null,
  lookup_message_id: ctx.lookup_message_id || null,
};

// Stage-2: on a wake event compute approx sleep (= wake − last SL end, across
// midnight) and store a SLEEP slot. Best-effort: only added for wake events;
// if no SL found or duration out of [1h,16h], it inserts 0 rows (no error).
const sleepCte = (ctx.isWake
    && /^\d{4}-\d{2}-\d{2}$/.test(ctx.logDate || '')
    && /^\d{2}:\d{2}$/.test(ctx.wakeTime || ''))
  ? `,
sleep_src AS (
  SELECT (s.slot_date + s.end_time) AS sl_end_ts
  FROM time_slots s
  WHERE s.category_code = 'SL' AND s.status = 'confirmed' AND s.end_time IS NOT NULL
    AND (s.slot_date + s.end_time) <= (DATE '${ctx.logDate}' + TIME '${ctx.wakeTime}')
    AND (s.slot_date + s.end_time) >  (DATE '${ctx.logDate}' + TIME '${ctx.wakeTime}') - INTERVAL '18 hours'
  ORDER BY (s.slot_date + s.end_time) DESC
  LIMIT 1
),
sleep_ins AS (
  INSERT INTO time_slots (
    batch_id, slot_date, start_time, end_time, duration_minutes,
    activity, category_code, category_name, emotional_mark, confidence,
    classification_source, status
  )
  SELECT
    nb.id, DATE '${ctx.logDate}', src.sl_end_ts::time, TIME '${ctx.wakeTime}',
    (EXTRACT(EPOCH FROM ((DATE '${ctx.logDate}' + TIME '${ctx.wakeTime}') - src.sl_end_ts)) / 60)::int,
    'сон (авто)', 'SLEEP', 'Сон', 'N', 1, 'auto_sleep', 'confirmed'
  FROM new_batch nb CROSS JOIN sleep_src src
  WHERE (EXTRACT(EPOCH FROM ((DATE '${ctx.logDate}' + TIME '${ctx.wakeTime}') - src.sl_end_ts)) / 60) BETWEEN 60 AND 960
  RETURNING id
)`
  : '';

const saveSql = `
WITH input AS (SELECT ${jsonbLiteral(payload)} AS d),
old_batch_select AS (
  SELECT id FROM time_message_batches
  WHERE telegram_chat_id = (SELECT d->>'chat_id' FROM input)
    AND status = 'confirmed'
    AND (
      (SELECT d->>'lookup_mode' FROM input) = 'last_confirmed'
      OR (
        (SELECT d->>'lookup_mode' FROM input) = 'by_message_id'
        AND telegram_message_id = (SELECT d->>'lookup_message_id' FROM input)
      )
    )
  ORDER BY created_at DESC
  LIMIT 1
),
mark_old_batch AS (
  UPDATE time_message_batches
  SET status = 'replaced', updated_at = NOW()
  WHERE id IN (SELECT id FROM old_batch_select)
  RETURNING id
),
mark_old_slots AS (
  UPDATE time_slots
  SET status = 'replaced', updated_at = NOW()
  WHERE batch_id IN (SELECT id FROM old_batch_select)
  RETURNING id
),
pending_to_replace AS (
  SELECT id AS pending_id, batch_id
  FROM time_pending_clarifications
  WHERE telegram_chat_id = (SELECT d->>'chat_id' FROM input)
    AND status = 'pending'
),
mark_pending_batches AS (
  UPDATE time_message_batches
  SET status = 'replaced', updated_at = NOW()
  WHERE id IN (SELECT batch_id FROM pending_to_replace)
  RETURNING id
),
mark_pending_slots AS (
  UPDATE time_slots
  SET status = 'replaced', updated_at = NOW()
  WHERE batch_id IN (SELECT batch_id FROM pending_to_replace)
  RETURNING id
),
mark_pending_clars AS (
  UPDATE time_pending_clarifications
  SET status = 'replaced', resolved_at = NOW()
  WHERE id IN (SELECT pending_id FROM pending_to_replace)
  RETURNING id
),
new_batch AS (
  INSERT INTO time_message_batches (
    telegram_chat_id, telegram_user_id, telegram_message_id,
    raw_text, batch_date, status, parent_batch_id
  )
  SELECT
    d->>'chat_id',
    d->>'user_id',
    d->>'message_id',
    d->>'text',
    (d->>'date')::date,
    'confirmed',
    (SELECT id FROM old_batch_select)
  FROM input
  RETURNING id
),
slot_rows AS (
  SELECT
    (s ->> 'slot_date')::date              AS slot_date,
    NULLIF(s ->> 'start_time', '')::time   AS start_time,
    NULLIF(s ->> 'end_time', '')::time     AS end_time,
    (s ->> 'duration_minutes')::int        AS duration_minutes,
    s ->> 'activity'                       AS activity,
    s ->> 'category_code'                  AS category_code,
    s ->> 'category_name'                  AS category_name,
    COALESCE(s ->> 'emotional_mark', 'N')  AS emotional_mark,
    NULLIF(s ->> 'confidence', '')::numeric AS confidence,
    COALESCE(s ->> 'classification_source', 'ai') AS classification_source
  FROM input, jsonb_array_elements(input.d->'slots') AS s
  WHERE COALESCE((s ->> 'duration_minutes')::int, 0) >= 0
),
ins AS (
  INSERT INTO time_slots (
    batch_id, slot_date, start_time, end_time,
    duration_minutes, activity, category_code, category_name,
    emotional_mark, confidence, classification_source, status
  )
  SELECT
    nb.id, sr.slot_date, sr.start_time, sr.end_time,
    sr.duration_minutes, sr.activity, sr.category_code, sr.category_name,
    sr.emotional_mark, sr.confidence, sr.classification_source, 'confirmed'
  FROM new_batch nb CROSS JOIN slot_rows sr
  RETURNING category_code, activity, classification_source
)${sleepCte}
INSERT INTO time_category_examples (category_code, example_text, source)
SELECT
  ins.category_code,
  (SELECT d->>'text' FROM input),
  'explicit_user_code'
FROM ins
WHERE ins.classification_source = 'explicit_user_code'
  AND ins.category_code IS NOT NULL
  AND (
    SELECT COUNT(*) FROM time_category_examples
    WHERE category_code = ins.category_code AND is_active = TRUE
  ) < ${cap}
ON CONFLICT (category_code, example_text) DO NOTHING
RETURNING category_code;
`;

return [{ json: { ...ctx, saveSql } }];