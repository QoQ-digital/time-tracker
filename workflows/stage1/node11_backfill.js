// 11: Fill missing start_time/end_time for duration-only / "до HH:MM" slots,
// then build the pending-clarification SQL. All user values inline as JSONB.
//
// STAGE 1 fixes:
//   - RX reflection guard: ALWAYS 0 min, never consumes the time cursor (Bug 3)
//   - anti-AI defence: model returned start==end for a "до X" → treat as end-only (Bug 2)
//   - missing-anchor → ask for clarification instead of silently saving 0 min (Bug 2)

const ctx = $('09 Process AI Response').first().json;
const lastEndRow = $input.first().json;
const lastEnd = lastEndRow && lastEndRow.last_end ? lastEndRow.last_end : null;

function toMinutes(t) {
  if (!t) return null;
  const m = /^([0-2]?\d):([0-5]\d)/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function fromMinutes(total) {
  const norm = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function nowHHMM() {
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: $env.GENERIC_TIMEZONE || 'Europe/Warsaw' })
  );
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

let cursor = toMinutes(lastEnd);
let anchorMissing = false;
let anchorAt = null;    // конец последней записи дня, если «до X» упёрлось в него
let badEnd = null;      // запрошенное время, давшее подозрительный разрыв
let anchorRolled = false; // true = «до X» РАНЬШЕ конца дня (через полночь); false = разрыв вперёд >8ч

for (const s of ctx.slots) {
  // RX reflection — always a 0-min marker, never consumes the cursor.
  if (s.category_code === 'RX') {
    const t = nowHHMM();
    s.start_time = t; s.end_time = t; s.duration_minutes = 0;
    continue;
  }

  // Anti-AI: model returned start==end for a "до X" (forbidden by the
  // prompt but gpt-4o-mini sometimes does it) → reinterpret as end-only.
  if (s.start_time && s.end_time && s.start_time === s.end_time
      && (!s.duration_minutes || s.duration_minutes === 0)) {
    s.end_time = s.start_time;
    s.start_time = null;
  }

  // Случай 1: только длительность — цепляем от cursor
  if (!s.start_time && s.duration_minutes > 0) {
    if (cursor === null) { anchorMissing = true; continue; }
    s.start_time = fromMinutes(cursor);
    s.end_time = fromMinutes(cursor + s.duration_minutes);
    cursor += s.duration_minutes;
  }
  // Случай 2: только end_time ("до HH:MM") — start = cursor, через полночь ок
  else if (!s.start_time && s.end_time && (!s.duration_minutes || s.duration_minutes === 0)) {
    if (cursor === null) { anchorMissing = true; continue; }
    const endMin = toMinutes(s.end_time);
    if (endMin === null) continue;
    let adjustedEnd = endMin;
    if (endMin <= cursor) adjustedEnd = endMin + 24 * 60;   // через полночь
    if (adjustedEnd - cursor > 8 * 60) {                   // >8ч — подозрительный разрыв
      anchorMissing = true; anchorAt = cursor; badEnd = s.end_time;
      anchorRolled = (endMin <= cursor);                   // раньше конца дня (полночь) vs разрыв вперёд
      continue;
    }
    s.start_time = fromMinutes(cursor);
    s.duration_minutes = adjustedEnd - cursor;
    cursor = endMin;                                        // новый «день» от полуночи
  }
  // Случай 3: без времени и без RX (редкая заметка) — маркер «сейчас»
  else if (!s.start_time && !s.end_time && (!s.duration_minutes || s.duration_minutes === 0)) {
    const t = nowHHMM();
    s.start_time = t; s.end_time = t; s.duration_minutes = 0;
  }
  // Случай 4: полный слот — обновляем cursor
  else if (s.start_time && s.end_time) {
    cursor = toMinutes(s.end_time);
  }
}

// If a "до"/duration slot couldn't be anchored, ask instead of saving 0 minutes.
if (anchorMissing) {
  ctx.needsClarification = true;
  if (anchorAt !== null && anchorRolled) {
    // «до X» оказалось раньше уже залогированного конца дня (трактуется как полночь)
    ctx.clarificationText =
      `Последняя запись за этот день — до ${fromMinutes(anchorAt)}, ` +
      `а «${badEnd}» раньше неё — слот не посчитать. ` +
      `Пришли диапазон HH:MM-HH:MM, либо проверь время.`;
  } else if (anchorAt !== null) {
    // разрыв вперёд >8ч — скорее всего число приняли за время (напр. «20» = 20:00)
    ctx.clarificationText =
      `От последней записи (до ${fromMinutes(anchorAt)}) до «${badEnd}» больше 8 часов — ` +
      `не похоже на один слот. Если это длительность — добавь «мин» (напр. «20 мин ...»); ` +
      `если время — пришли диапазон HH:MM-HH:MM.`;
  } else {
    // нет ни одной записи за день, не от чего считать
    ctx.clarificationText =
      'Не вижу, от какого времени считать («до HH:MM» или «N мин»). ' +
      'Пришли диапазон HH:MM-HH:MM, либо добавь «вч», если это вчера.';
  }
}

function jsonbLiteral(obj) {
  return `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;
}

const pendingPayload = {
  chat_id: ctx.chatId,
  user_id: ctx.userId,
  message_id: ctx.messageId,
  text: ctx.text,
  date: ctx.logDate || ctx.todayDate,
  question: ctx.clarificationText || '',
  suggested_categories: ctx.suggestedCategories || [],
  slots: ctx.slots || [],
};

const pendingSql = `
WITH input AS (SELECT ${jsonbLiteral(pendingPayload)} AS d),
new_batch AS (
  INSERT INTO time_message_batches (
    telegram_chat_id, telegram_user_id, telegram_message_id,
    raw_text, batch_date, status
  )
  SELECT
    d->>'chat_id', d->>'user_id', d->>'message_id',
    d->>'text', (d->>'date')::date,
    'pending_clarification'
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
    s -> 'suggested_categories'            AS suggested_categories
  FROM input, jsonb_array_elements(input.d->'slots') AS s
  WHERE COALESCE((s ->> 'duration_minutes')::int, 0) >= 0
),
ins_slots AS (
  INSERT INTO time_slots (
    batch_id, slot_date, start_time, end_time,
    duration_minutes, activity, category_code, category_name,
    emotional_mark, confidence, classification_source,
    status, needs_clarification, suggested_categories
  )
  SELECT
    nb.id, sr.slot_date, sr.start_time, sr.end_time,
    sr.duration_minutes, sr.activity, sr.category_code, sr.category_name,
    sr.emotional_mark, sr.confidence, 'ai',
    'pending_clarification', TRUE, sr.suggested_categories
  FROM new_batch nb CROSS JOIN slot_rows sr
  RETURNING id
)
INSERT INTO time_pending_clarifications (
  batch_id, telegram_chat_id, telegram_user_id,
  original_text, question_text, suggested_categories, status
)
SELECT
  nb.id,
  (SELECT d->>'chat_id' FROM input),
  (SELECT d->>'user_id' FROM input),
  (SELECT d->>'text' FROM input),
  (SELECT d->>'question' FROM input),
  (SELECT d->'suggested_categories' FROM input),
  'pending'
FROM new_batch nb
RETURNING batch_id;
`;

return [{ json: { ...ctx, pendingSql } }];
