// 18: Format the dashboard text.
// STAGE 1: adds a compact "⏱ Залогировано до HH:MM" line (day frontier),
// fed by the new 'day_frontier' row from node 16.

const ctx = $('01 Parse + Authorize + Plan').first().json;
const rows = $('16 Aggregate Totals + Goals').all().map(i => i.json);
const lastDashRows = $('17 Get Last Dashboard Msg').all().map(i => i.json);
const oldMsgId = lastDashRows.length ? lastDashRows[0].telegram_message_id : null;

let justAdded = [];
for (const sourceNode of ['11 Backfill Times', '14 Build Save SQL']) {
  if (justAdded.length > 0) break;
  try {
    const upstream = $(sourceNode).first()?.json;
    if (upstream && Array.isArray(upstream.slots)) justAdded = upstream.slots;
  } catch (_) { /* node didn't run in this execution path */ }
}

const todayTotals = new Map();
const weekTotals = new Map();
const dailyGoals = new Map();
const weeklyGoals = new Map();
const categoryNames = new Map();
let frontierMin = null; // minutes since midnight of the latest logged end_time today

for (const r of rows) {
  if (r.kind === 'day_frontier') { frontierMin = r.total_minutes; continue; }
  categoryNames.set(r.category_code, r.category_name);
  if (r.kind === 'today_total') todayTotals.set(r.category_code, r.total_minutes);
  else if (r.kind === 'week_total') weekTotals.set(r.category_code, r.total_minutes);
  else if (r.kind === 'goal_daily') dailyGoals.set(r.category_code, r.total_minutes);
  else if (r.kind === 'goal_weekly') weeklyGoals.set(r.category_code, r.total_minutes);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtH(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
}
function fmtHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function bar(done, goal) {
  const ratio = goal > 0 ? Math.max(0, Math.min(1, done / goal)) : 0;
  const filled = Math.round(ratio * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
function pct(done, goal) {
  if (goal <= 0) return '0.0%';
  return ((done / goal) * 100).toFixed(1) + '%';
}

const lines = [];

if (justAdded.length > 0) {
  lines.push('Добавлено:');
  for (const s of justAdded) {
    // Code-less 0-min markers (generic "^HH:MM") have no category — show the
    // activity with a clock instead of a bare "?".
    const name = categoryNames.get(s.category_code) || s.category_name || s.category_code
      || (s.activity ? `🕐 ${s.activity}` : 'отметка');
    lines.push(`  ${fmtH(s.duration_minutes)} → ${escapeHtml(name)}`);
  }
  lines.push('');
}

// Compact coverage line: up to when the day is logged.
if (frontierMin !== null && frontierMin > 0) {
  lines.push(`⏱ Залогировано до ${fmtHHMM(frontierMin)}`);
  lines.push('');
}

if (weeklyGoals.size > 0) {
  lines.push('Недельные цели:');
  for (const [code, goal] of weeklyGoals) {
    const done = weekTotals.get(code) || 0;
    const remaining = Math.max(0, goal - done);
    const name = categoryNames.get(code) || code;
    lines.push(`  ${escapeHtml(name)} [${escapeHtml(code)}]`);
    lines.push(`    ${bar(done, goal)} ${pct(done, goal)} — ${fmtH(done)} / ${fmtH(goal)}`);
    lines.push(`    Осталось: ${fmtH(remaining)}`);
  }
  lines.push('');
}

if (dailyGoals.size > 0) {
  lines.push('Дневные цели:');
  for (const [code, goal] of dailyGoals) {
    const done = todayTotals.get(code) || 0;
    const remaining = Math.max(0, goal - done);
    const name = categoryNames.get(code) || code;
    lines.push(`  ${escapeHtml(name)} [${escapeHtml(code)}]`);
    lines.push(`    ${bar(done, goal)} ${pct(done, goal)} — ${fmtH(done)} / ${fmtH(goal)}`);
    lines.push(`    Осталось сегодня: ${fmtH(remaining)}`);
  }
  lines.push('');
}

const maxCats = parseInt($env.DASHBOARD_MAX_CATEGORIES || '8', 10);
const rest = [];
for (const [code, mins] of todayTotals) {
  if (mins <= 0) continue;
  if (dailyGoals.has(code) || weeklyGoals.has(code)) continue;
  rest.push([code, mins]);
}
rest.sort((a, b) => b[1] - a[1]);
if (rest.length > 0) {
  lines.push('Остальные категории сегодня:');
  for (const [code, mins] of rest.slice(0, maxCats)) {
    const name = categoryNames.get(code) || code;
      lines.push(`  ${escapeHtml(name)} [${escapeHtml(code)}]: ${fmtH(mins)}`);
  }
  lines.push('');
}

const dashboardText = lines.join('\n');

return [{
  json: {
    chatId: ctx.chatId,
    oldMsgId,
    dashboardText,
  },
}];
