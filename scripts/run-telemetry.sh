#!/usr/bin/env bash
# Post a short run-telemetry comment to Jira: model, wall-clock, turns, tokens, cost.
#
# The audience asked, in effect, "what did that cost?" -- and showing it turns an
# impressive-looking demo into a decision-making conversation. Reads the execution
# file claude-code-action writes; every field is optional, because a missing field
# should degrade the comment, not fail the run.
#
# usage: run-telemetry.sh <ISSUE-KEY> <execution-file> <started-epoch> [outcome]
set -uo pipefail
cd "$(dirname "$0")/.."

KEY="${1:?issue key required}"
FILE="${2:-}"
STARTED="${3:-0}"
OUTCOME="${4:-completed}"

NOW=$(date +%s)
WALL=$(( NOW - STARTED ))
[ "$STARTED" -eq 0 ] && WALL=0

SUMMARY=$(FILE="$FILE" WALL="$WALL" OUTCOME="$OUTCOME" python3 - <<'PY'
import json, os

path, wall, outcome = os.environ["FILE"], int(os.environ["WALL"]), os.environ["OUTCOME"]

def hms(s):
    s = int(s)
    return f"{s//60}m {s%60}s" if s >= 60 else f"{s}s"

d = {}
try:
    with open(path) as fh:
        raw = json.load(fh)
    # The file is either the result object or a transcript list ending in one.
    if isinstance(raw, list):
        for entry in reversed(raw):
            if isinstance(entry, dict) and ("total_cost_usd" in entry or "duration_ms" in entry):
                d = entry
                break
    elif isinstance(raw, dict):
        d = raw
except Exception:
    pass

lines = ["Run telemetry"]

models = [m for m in (d.get("modelUsage") or {})]
main = [m for m in models if "haiku" not in m.lower()]
if main:
    extra = [m for m in models if m not in main]
    line = f"Model: {', '.join(main)}"
    if extra:
        line += f" (plus {', '.join(extra)} for routine sub-tasks)"
    lines.append(line)

lines.append(f"Wall clock: {hms(wall)}" if wall else "Wall clock: unavailable")
if d.get("duration_ms"):
    lines.append(f"Agent time: {hms(d['duration_ms']/1000)}")
if d.get("num_turns"):
    lines.append(f"Turns: {d['num_turns']}")

usage = d.get("usage") or {}
tin = usage.get("input_tokens")
tout = usage.get("output_tokens")
cache = usage.get("cache_read_input_tokens")
if tin or tout:
    bits = []
    if tin:   bits.append(f"{tin:,} in")
    if tout:  bits.append(f"{tout:,} out")
    if cache: bits.append(f"{cache:,} cached")
    lines.append("Tokens: " + ", ".join(bits))

if d.get("total_cost_usd") is not None:
    lines.append(f"Cost: ${d['total_cost_usd']:.2f}")

if outcome != "completed":
    lines.append(f"Outcome: {outcome}")

print("\n".join(lines))
PY
)

[ -z "$SUMMARY" ] && exit 0
./scripts/jira.sh comment "$KEY" "$SUMMARY" || true
