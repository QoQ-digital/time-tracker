#!/usr/bin/env python3
"""Stage-1.1 patch — накладывается поверх уже задеплоенного Stage-1.
Меняет ДВЕ вещи, идемпотентно:
  - node 09: slot_date ВСЕГДА = logDate (а не «только если AI не вернул»).
             Иначе AI возвращает slot_date=todayDate и бэкдейт «вч» теряется.
  - node 11: полное тело из node11_backfill.js (понятное сообщение, когда
             «до X» раньше уже залогированного конца дня).
Остальные Stage-1 правки уже живые — их не трогаем.

Usage: patch_stage11.py <input.json> <output.json>
"""
import json, sys, pathlib

STAGE1 = pathlib.Path("/Users/kermanych/дело/Quince/enotebot/time-tracker/workflows/stage1")
inp, outp = sys.argv[1], sys.argv[2]
doc = json.loads(pathlib.Path(inp).read_text())
wf = doc[0] if isinstance(doc, list) else doc
nodes = {n["name"]: n for n in wf["nodes"]}
changed = []

# --- nodes 01 / 14 / 18: full body (idempotent) ---
#   01 = bare-number→minutes + detectPoint wake-in-"^"; 14 = Stage-2 sleep CTE;
#   18 = dashboard marker label + 😴 sleep line.
for name, fname in [("01 Parse + Authorize + Plan", "node01_parse.js"),
                    ("14 Build Save SQL", "node14_build_save.js"),
                    ("18 Format Dashboard", "node18_format_dashboard.js")]:
    body = (STAGE1 / fname).read_text()
    if nodes[name]["parameters"].get("jsCode") != body:
        nodes[name]["parameters"]["jsCode"] = body
        changed.append(name)
    else:
        print(f"= {name} уже актуальна — пропускаю")

# --- node 09: force slot_date = logDate (idempotent) ---
js09 = nodes["09 Process AI Response"]["parameters"]["jsCode"]
FORCED = "s.slot_date = ctx.logDate || ctx.todayDate;"
STAGE1_LINE = "if (!s.slot_date) s.slot_date = ctx.logDate || ctx.todayDate;"
if FORCED in js09 and STAGE1_LINE not in js09:
    print("= node 09 уже Stage-1.1 (slot_date форсирован) — пропускаю")
elif STAGE1_LINE in js09:
    nodes["09 Process AI Response"]["parameters"]["jsCode"] = js09.replace(STAGE1_LINE, FORCED, 1)
    changed.append("09 Process AI Response")
else:
    sys.exit("[node 09] не найден ожидаемый Stage-1 фрагмент slot_date — стоп (дрейф?)")

# --- node 10: exclude the batch being EDITED from the anchor (edit-anchor fix) ---
#   Без этого правка «до X» упирается в собственную старую (ещё confirmed) версию
#   → endMin == frontier → ложный «через полночь» → отказ. $2 = lookup_message_id.
NEW_Q10 = (
    "-- Last confirmed slot end for the date.\n"
    "-- Stage-1: no time-of-day filter. Stage-1.4: exclude the batch being edited\n"
    "-- ($2 = lookup_message_id) so editing a \"до X\" re-anchors to the PREVIOUS slot.\n"
    "SELECT MAX(s.end_time) AS last_end\n"
    "FROM time_slots s\n"
    "JOIN time_message_batches b ON b.id = s.batch_id\n"
    "WHERE s.slot_date = $1::date\n"
    "  AND s.status = 'confirmed'\n"
    "  AND s.end_time IS NOT NULL\n"
    "  AND ($2 = '' OR b.telegram_message_id IS DISTINCT FROM $2);"
)
n10 = nodes["10 Find Last Slot End"]["parameters"]
if n10.get("query") != NEW_Q10:
    n10["query"] = NEW_Q10
    n10.setdefault("options", {})["queryReplacement"] = \
        "={{ $json.logDate || $json.todayDate }}, {{ $json.lookup_message_id || '' }}"
    changed.append("10 Find Last Slot End")
else:
    print("= node 10 уже актуальна — пропускаю")

# --- node 11: full body (idempotent) ---
new11 = (STAGE1 / "node11_backfill.js").read_text()
if nodes["11 Backfill Times"]["parameters"].get("jsCode") != new11:
    nodes["11 Backfill Times"]["parameters"]["jsCode"] = new11
    changed.append("11 Backfill Times")
else:
    print("= node 11 уже актуальна — пропускаю")

pathlib.Path(outp).write_text(json.dumps(doc, ensure_ascii=False, indent=2))
print("Stage-1.1 пропатчено нод:", len(changed), changed or "(нечего менять)")
print("Всего нод (без изменений кол-ва):", len(wf["nodes"]))
