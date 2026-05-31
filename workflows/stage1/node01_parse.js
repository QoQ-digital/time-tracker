// 01: parse the Telegram update, run authorization, decide top-level action.
// Outputs ONE item with normalized fields and a chosen `action`:
//   denied | send_text | render_dashboard | save_explicit | ai_classify
//   command_categories | command_category_add | command_set_goal
//   command_delete_last | pending_reply_pick | todo
//
// STAGE 1 fixes:
//   - logDate + "вч"/"вчера" backdate prefix (Bug 1)
//   - point-in-time events: "^HH:MM ..." and wake words "проснулся/встал/подъём + время" (Bug 4)
//   NB: JS \b is ASCII-only and does NOT treat Cyrillic as word chars,
//       so all Cyrillic matching uses explicit separators/lookaheads.

const raw = $input.first().json;
const msg = raw.message || raw.edited_message;
if (!msg) return [];

const isEdit = !!raw.edited_message;
const chatId = String(msg.chat.id);
const userId = String(msg.from.id);
const messageId = String(msg.message_id);
const text = (msg.text || '').trim();

const nowLocal = new Date(
  new Date().toLocaleString('en-US', { timeZone: $env.GENERIC_TIMEZONE || 'Europe/Warsaw' })
);
const y = nowLocal.getFullYear();
const m = String(nowLocal.getMonth() + 1).padStart(2, '0');
const d = String(nowLocal.getDate()).padStart(2, '0');
const todayDate = `${y}-${m}-${d}`;

const allowedUsers = ($env.AUTHORIZED_TELEGRAM_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowedChats = ($env.AUTHORIZED_TELEGRAM_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const hasAllowlist = allowedUsers.length > 0 || allowedChats.length > 0;
const authorized = hasAllowlist
  && (allowedUsers.includes(userId) || allowedChats.includes(chatId));

// logDate defaults to today; overridden to yesterday by the "вч" prefix.
const base = { chatId, userId, messageId, text, isEdit, todayDate, logDate: todayDate, authorized };

if (!authorized) {
  return [{ json: { ...base, action: 'denied', replyText: 'Access denied.' } }];
}

if (text.startsWith('/')) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  const args = text.slice(parts[0].length).trim();

  if (cmd === '/help' || cmd === '/start') {
    return [{ json: { ...base, action: 'send_text', replyText:
`Time Tracker

Formats:
  0855-0955 [FRIENDS] разговор с другом
  1300-1400 интервью
  20 мин отвечал в Telegram
  до 23:40 [SL] готовлюсь ко сну   (конец слота, начало = конец прошлого)
  вч до 23:40 [SL] ...             (записать во вчера)
  проснулся 7:00 / ^7:00 отметка   (точка времени, не интервал)

Commands:
  /dashboard         show current dashboard
  /today /week       compact day/week view
  /categories        list active categories
  /category_add CODE | Name | Description
  /goal_week CODE | hours
  /goal_day CODE | hours
  /delete_last       delete last entry
  /edit_last <text>  replace last entry
  /dashboard_compact /dashboard_full
  /help              this message

When the bot asks a clarification question, reply with:
  1 / 2 / ... — pick the suggested option by number
  [CODE]      — pick by category code directly
  <new text>  — replace the question with a new detailed entry`,
    } }];
  }

  if (cmd === '/dashboard' || cmd === '/today' || cmd === '/week') {
    return [{ json: { ...base, action: 'render_dashboard', dashboardScope: cmd.slice(1) } }];
  }

  if (cmd === '/categories') {
    return [{ json: { ...base, action: 'command_categories' } }];
  }

  if (cmd === '/category_add') {
    const argParts = args.split('|').map(s => s.trim());
    const code = argParts[0] || '';
    const name = argParts[1] || '';
    const description = argParts[2] || null;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(code) || !name) {
      return [{ json: { ...base, action: 'send_text', replyText:
`Использование:
  /category_add CODE | Name | Description

CODE — заглавные буквы и подчёркивания, начинается с буквы или _.
Например: /category_add NEW_PROJECT | Новый проект | Работа над X` } }];
    }
    return [{ json: { ...base, action: 'command_category_add',
      catCode: code, catName: name, catDescription: description } }];
  }

  if (cmd === '/goal_week' || cmd === '/goal_day') {
    const argParts = args.split('|').map(s => s.trim());
    const code = argParts[0] || '';
    const hoursStr = argParts[1] || '';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(code) || !/^\d+(\.\d+)?$/.test(hoursStr)) {
      return [{ json: { ...base, action: 'send_text', replyText:
`Использование:
  ${cmd} CODE | hours

Пример: ${cmd} JOB_SEARCH | 20` } }];
    }
    const hours = parseFloat(hoursStr);
    if (!(hours > 0) || hours > 24 * 7) {
      return [{ json: { ...base, action: 'send_text',
        replyText: 'Hours must be > 0 and <= 168 (one week).' } }];
    }
    const goalMinutes = Math.round(hours * 60);
    const goalType = cmd === '/goal_week' ? 'weekly' : 'daily';
    let goalDateFrom, goalDateTo;
    const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    if (goalType === 'weekly') {
      const today = new Date(`${todayDate}T00:00:00`);
      const dow = today.getDay();
      const offsetToMonday = (dow + 6) % 7;
      const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetToMonday);
      const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
      goalDateFrom = fmt(monday);
      goalDateTo = fmt(sunday);
    } else {
      goalDateFrom = todayDate;
      goalDateTo = todayDate;
    }
    return [{ json: { ...base, action: 'command_set_goal',
      goalType, goalCode: code, goalMinutes, goalDateFrom, goalDateTo } }];
  }

  if (cmd === '/delete_last') {
    return [{ json: { ...base, action: 'command_delete_last' } }];
  }

  if (cmd === '/edit_last') {
    const editText = args.trim();
    if (!editText) {
      return [{ json: { ...base, action: 'send_text', replyText:
`Использование:
  /edit_last <new text>

Пример:
  /edit_last 0900-1000 [PROJECT_A] звонок по задаче` } }];
    }
    const bd = applyBackdate(editText, todayDate);
    const newBase = { ...base, text: bd.text, logDate: bd.logDate, lookup_mode: 'last_confirmed' };
    const explicit = parseExplicitRange(bd.text, bd.logDate);
    if (explicit) return [{ json: { ...newBase, action: 'save_explicit', slots: [explicit] } }];
    return [{ json: { ...newBase, action: 'ai_classify' } }];
  }

  return [{ json: { ...base, action: 'todo',
    replyText: `Command ${cmd} is recognized but not wired up in this workflow yet. See README "Next steps".` } }];
}

// Pending-clarification picks (on the ORIGINAL text — never backdated):
if (/^[1-9]$/.test(text)) {
  return [{ json: { ...base, action: 'pending_reply_pick',
    pickKind: 'digit', pickIndex: parseInt(text, 10), pickCode: '' } }];
}
const codeOnly = /^\[([A-Z_][A-Z0-9_]*)\]$/.exec(text);
if (codeOnly) {
  return [{ json: { ...base, action: 'pending_reply_pick',
    pickKind: 'code', pickIndex: 0, pickCode: codeOnly[1] } }];
}

// Backdate: strip leading "вч"/"вчера" → shift logDate to yesterday.
const bd = applyBackdate(text, todayDate);
const logDate = bd.logDate;
const bodyText = bd.text;

const editLookup = isEdit ? {
  lookup_mode: 'by_message_id',
  lookup_message_id: messageId,
} : {};

// Point-in-time events: "^HH:MM ..." or wake words + time.
// Stored as a 0-duration marker at that instant → it sets the day cursor
// for following entries and never backfills the gap as activity.
const pt = detectPoint(bodyText);
if (pt) {
  return [{ json: { ...base, ...editLookup, logDate, text: bodyText,
    isPoint: true, isWake: pt.kind === 'wake', wakeTime: pt.time,
    action: 'save_explicit',
    slots: [{
      slot_date: logDate, start_time: pt.time, end_time: pt.time,
      duration_minutes: 0, activity: pt.activity,
      category_code: pt.code || null, category_name: null,
      emotional_mark: 'N', confidence: 1, classification_source: 'manual_command',
    }],
  } }];
}

// Голое ведущее число = ДЛИТЕЛЬНОСТЬ в минутах: "20 Емилия букет" → "20 мин Емилия букет",
// чтобы AI не прочитал "20" как время 20:00. Время указывается только HH:MM / HHMM / "до HH:MM".
// Пропускаем, если уже есть единица (мин/час) или дальше идёт число/двоеточие/диапазон.
let parseText = bodyText;
const bare = /^(\d{1,3})\s+(.+)$/.exec(bodyText);
if (bare && !/^(\d|мин|минут|м\s|час|часа|часов|ч\s)/i.test(bare[2])) {
  parseText = `${bare[1]} мин ${bare[2]}`;
}

const explicit = parseExplicitRange(parseText, logDate);
if (explicit) {
  return [{ json: { ...base, ...editLookup, logDate, text: parseText, action: 'save_explicit', slots: [explicit] } }];
}

return [{ json: { ...base, ...editLookup, logDate, text: parseText, action: 'ai_classify' } }];

// ---------------------------------------------------------------------
// Helpers (function declarations are hoisted, so usable above).
// ---------------------------------------------------------------------
function shiftDate(isoDate, days) {
  const dt = new Date(`${isoDate}T00:00:00`);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

// Strip a leading "вч"/"вчера" token; returns {logDate, text}.
function applyBackdate(rawText, today) {
  const mm = /^(вчера|вч)(?:\s+|[,:;.\-]+)/i.exec(rawText);
  if (mm) return { logDate: shiftDate(today, -1), text: rawText.slice(mm[0].length).trim() };
  return { logDate: today, text: rawText };
}

// "14"→14:00, "14"+"30"→14:30, "1430"→14:30, "915"→9:15, "9"→9:00
function parseTimeNumber(numStr, minStr) {
  if (minStr !== undefined && minStr !== null && minStr !== '') {
    return { h: parseInt(numStr, 10), m: parseInt(minStr, 10) };
  }
  const n = numStr.length;
  if (n <= 2) return { h: parseInt(numStr, 10), m: 0 };
  if (n === 3) return { h: parseInt(numStr.slice(0, 1), 10), m: parseInt(numStr.slice(1), 10) };
  if (n === 4) return { h: parseInt(numStr.slice(0, 2), 10), m: parseInt(numStr.slice(2), 10) };
  return null;
}
function hhmm(h, m) { return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function parsePointTime(numStr, minStr) {
  const t = parseTimeNumber(numStr, minStr);
  if (!t || t.h > 23 || t.m > 59) return null;
  return hhmm(t.h, t.m);
}

// Detect a point-in-time event. Returns {kind:'point'|'wake', time, code, activity} or null.
// Two entry forms: "^HH:MM rest" (generic marker) OR wake-word + time (any order).
// A wake word ("встал/проснулся/подъём") makes it kind='wake' (category MO) even
// inside the "^" form, so "^07:00 встал" → MO (not a code-less "?").
function detectPoint(t) {
  const WAKE_RE = /(просыпаю|проснул|встал|подъ[ёе]м|подь[ёе]м)/i;
  let time = null, rest = '';
  const mm = /^\^\s*(\d{1,4})(?:[:.,]\s*(\d{1,2}))?\s*(.*)$/.exec(t);
  if (mm) {
    time = parsePointTime(mm[1], mm[2]);
    rest = (mm[3] || '').trim();
  } else if (WAKE_RE.test(t)) {
    const tm = /(?:^|\s)(\d{1,4})(?:[:.,]\s*(\d{1,2}))?(?=\s|$)/.exec(' ' + t + ' ');
    if (tm) { time = parsePointTime(tm[1], tm[2]); rest = t.trim(); }
  }
  if (!time) return null;
  const explicitCode = (/\[([A-Z_][A-Z0-9_]*)\]/.exec(rest) || [])[1] || null;
  const isWake = WAKE_RE.test(rest);
  const code = explicitCode || (isWake ? 'MO' : null);
  const activity = rest.replace(/\[[A-Z_][A-Z0-9_]*\]/, '').trim() || (isWake ? 'проснулся' : 'отметка');
  return { kind: isWake ? 'wake' : 'point', time, code, activity };
}

function parseExplicitRange(rawText, today) {
  const codeRe = /\[([A-Z_][A-Z0-9_]*)\]/;
  const codeMatch = codeRe.exec(rawText);
  if (!codeMatch) return null;
  const code = codeMatch[1];
  const stripped = rawText.replace(codeMatch[0], ' ').replace(/\s+/g, ' ').trim();
  const rangeRe = /(?:^|\s)(\d{1,4})(?:\s*[:.,]\s*(\d{1,2}))?\s*-\s*(\d{1,4})(?:\s*[:.,]\s*(\d{1,2}))?(?=\s|$)/;
  const rm = rangeRe.exec(' ' + stripped + ' ');
  if (!rm) return null;
  const startT = parseTimeNumber(rm[1], rm[2]);
  const endT = parseTimeNumber(rm[3], rm[4]);
  if (!startT || !endT) return null;
  const sH = startT.h, sM = startT.m, eH = endT.h, eM = endT.m;
  if (sH > 23 || sM > 59 || eH > 23 || eM > 59) return null;
  if (eH * 60 + eM <= sH * 60 + sM) return null;
  const activity = stripped.replace(rm[0].trim(), '').replace(/\s+/g, ' ').trim() || code;
  return {
    slot_date: today,
    start_time: `${String(sH).padStart(2,'0')}:${String(sM).padStart(2,'0')}`,
    end_time: `${String(eH).padStart(2,'0')}:${String(eM).padStart(2,'0')}`,
    duration_minutes: (eH*60+eM) - (sH*60+sM),
    activity, category_code: code, category_name: null,
    emotional_mark: 'N', confidence: 1, classification_source: 'explicit_user_code',
  };
}
