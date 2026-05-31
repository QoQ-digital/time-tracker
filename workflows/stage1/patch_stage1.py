#!/usr/bin/env python3
"""Patch Stage-1 fixes into an exported n8n workflow JSON.
Surgical: only replaces parameters.jsCode / parameters.query / queryReplacement
of the 7 target nodes. Everything else (ids, credentials, connections,
positions, webhook) is left byte-for-byte intact.

Usage: patch_stage1.py <input.json> <output.json>
Fails loudly if any expected source fragment is missing (drift guard).
"""
import json, sys, pathlib

STAGE1 = pathlib.Path("/Users/kermanych/дело/Quince/enotebot/time-tracker/workflows/stage1")

def load(p): return pathlib.Path(p).read_text()

inp, outp = sys.argv[1], sys.argv[2]
doc = json.loads(pathlib.Path(inp).read_text())
wf = doc[0] if isinstance(doc, list) else doc
nodes = {n["name"]: n for n in wf["nodes"]}
changed = []

def set_js(name, file):
    n = nodes[name]
    n["parameters"]["jsCode"] = load(STAGE1 / file)
    changed.append(name)

def replace_in_js(name, old, new):
    n = nodes[name]; js = n["parameters"]["jsCode"]
    assert old in js, f"[{name}] fragment not found: {old!r}"
    n["parameters"]["jsCode"] = js.replace(old, new, 1)

def set_query(name, query):
    nodes[name]["parameters"]["query"] = query

# --- full-body code nodes ---
set_js("01 Parse + Authorize + Plan", "node01_parse.js")
set_js("11 Backfill Times",           "node11_backfill.js")
set_js("18 Format Dashboard",         "node18_format_dashboard.js")

# --- node 09: logDate + RX guard ---
replace_in_js("09 Process AI Response",
    "if (!s.slot_date) s.slot_date = ctx.todayDate;",
    "if (!s.slot_date) s.slot_date = ctx.logDate || ctx.todayDate;")
replace_in_js("09 Process AI Response",
    "  s.duration_minutes = parseInt(s.duration_minutes, 10) || 0;\n}",
    "  s.duration_minutes = parseInt(s.duration_minutes, 10) || 0;\n"
    "  if (s.category_code === 'RX') { s.start_time = null; s.end_time = null; s.duration_minutes = 0; }\n}")
changed.append("09 Process AI Response")

# --- node 10: anchor by logDate, drop midnight-broken NOW() filter ---
set_query("10 Find Last Slot End",
    "-- Find the end_time of the last confirmed slot for this date.\n"
    "-- Stage 1: dropped the time-of-day filter that broke across midnight.\n"
    "SELECT MAX(end_time) AS last_end\n"
    "FROM time_slots\n"
    "WHERE slot_date = $1::date\n"
    "  AND status = 'confirmed'\n"
    "  AND end_time IS NOT NULL;")
nodes["10 Find Last Slot End"]["parameters"].setdefault("options", {})["queryReplacement"] = \
    "={{ $json.logDate || $json.todayDate }}"
changed.append("10 Find Last Slot End")

# --- node 14: backdate batch_date ---
replace_in_js("14 Build Save SQL",
    "date: ctx.todayDate,",
    "date: ctx.logDate || ctx.todayDate,")
changed.append("14 Build Save SQL")

# --- node 16: add day_frontier UNION before the final ; ---
FRONTIER = (
    "\nUNION ALL\n"
    "SELECT 'day_frontier' AS kind, NULL::text AS category_code, NULL::text AS category_name,\n"
    "       COALESCE(EXTRACT(EPOCH FROM MAX(end_time))::int / 60, 0) AS total_minutes,\n"
    "       NULL::date AS period_start, NULL::date AS period_end\n"
    "FROM time_slots\n"
    "WHERE status = 'confirmed' AND slot_date = $1::date AND end_time IS NOT NULL\n")
q16 = nodes["16 Aggregate Totals + Goals"]["parameters"]["query"].rstrip()
assert q16.endswith(";"), "node 16 query does not end with ';'"
assert "day_frontier" not in q16, "node 16 already patched"
nodes["16 Aggregate Totals + Goals"]["parameters"]["query"] = q16[:-1] + FRONTIER + ";"
changed.append("16 Aggregate Totals + Goals")

# --- write ---
pathlib.Path(outp).write_text(json.dumps(doc, ensure_ascii=False, indent=2))
print("Patched nodes:", len(set(changed)))
for c in sorted(set(changed)): print("  ✓", c)
print("Total nodes (unchanged count):", len(wf["nodes"]))
print("Output:", outp)
