#!/usr/bin/env bash
# Post a short run-telemetry comment to Jira: model, wall-clock, turns, tokens, cost.
#
# The audience asked, in effect, "what did that cost?" -- and showing it turns an
# impressive-looking demo into a decision-making conversation. Reads the execution
# file claude-code-action writes; every field is optional, because a missing field
# should degrade the comment, not fail the run.
#
# usage: run-telemetry.sh <ISSUE-KEY> <execution-file> <started-epoch> <phase> [outcome]
#   phase is "build" or "deploy". On deploy, the earlier build cost is read back off the
#   ticket so the comment can report what the whole thing cost, which is the number that
#   actually lands with an audience.
set -uo pipefail
cd "$(dirname "$0")/.."

KEY="${1:?issue key required}"
FILE="${2:-}"
STARTED="${3:-0}"
PHASE="${4:-build}"
OUTCOME="${5:-completed}"

NOW=$(date +%s)
WALL=$(( NOW - STARTED ))
[ "$STARTED" -eq 0 ] && WALL=0

# On deploy, recover the build cost from the ticket's earlier telemetry comment.
PRIOR_COST=""
if [ "$PHASE" = "deploy" ]; then
  PRIOR_COST=$(./scripts/jira.sh get "$KEY" 2>/dev/null \
    | grep -oE 'Cost \(build\): \$[0-9]+\.[0-9]+' | head -1 | grep -oE '[0-9]+\.[0-9]+' || true)
fi

# Echo the raw usage object to the workflow log (never to Jira) so the field names and
# magnitudes can be checked against what we report.
python3 -c '
import json,sys
try:
    raw=json.load(open(sys.argv[1]))
    d=raw if isinstance(raw,dict) else next((e for e in reversed(raw) if isinstance(e,dict) and "total_cost_usd" in e), {})
    print("[telemetry] raw usage:", json.dumps(d.get("usage") or {}, indent=2))
    print("[telemetry] top-level keys:", sorted(d.keys()))
except Exception as e:
    print("[telemetry] could not read execution file:", e)
' "$FILE" || true

SUMMARY=$(FILE="$FILE" WALL="$WALL" OUTCOME="$OUTCOME" PHASE="$PHASE" PRIOR_COST="$PRIOR_COST" python3 - <<'PY'
import json, os

path, wall, outcome = os.environ["FILE"], int(os.environ["WALL"]), os.environ["OUTCOME"]
phase = os.environ.get("PHASE", "build")
prior = os.environ.get("PRIOR_COST", "")

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

lines = [f"Run telemetry \u00b7 {phase} phase"]

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

# Name each field for what it is. "input_tokens" counts only tokens that were neither
# read from nor written to the cache, so quoting it alone as "in" badly understates the
# real input -- most of it is cache traffic.
usage = d.get("usage") or {}
fresh  = usage.get("input_tokens") or 0
out    = usage.get("output_tokens") or 0
cread  = usage.get("cache_read_input_tokens") or 0
cwrite = usage.get("cache_creation_input_tokens") or 0
if fresh or out or cread or cwrite:
    total_in = fresh + cread + cwrite
    lines.append(f"Input tokens: {total_in:,} ({cread:,} read from cache, {cwrite:,} written to cache, {fresh:,} fresh)")
    thinking = ((usage.get("output_tokens_details") or {}).get("thinking_tokens")) or 0
    if thinking:
        pct = round(100 * thinking / out) if out else 0
        lines.append(f"Output tokens: {out:,} (of which {thinking:,} thinking, {pct}%)")
    else:
        lines.append(f"Output tokens: {out:,}")

cost = d.get("total_cost_usd")
if cost is not None:
    lines.append(f"Cost ({phase}): ${cost:.2f}")
    if phase == "deploy" and prior:
        try:
            lines.append(f"Total for this ticket: ${float(prior) + cost:.2f} (build ${float(prior):.2f} + deploy ${cost:.2f})")
        except ValueError:
            pass

if outcome != "completed":
    lines.append(f"Outcome: {outcome}")

print("\n".join(lines))
PY
)

[ -z "$SUMMARY" ] && exit 0
./scripts/jira.sh comment "$KEY" "$SUMMARY" || true
