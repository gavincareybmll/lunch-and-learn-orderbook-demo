#!/usr/bin/env bash
# Create the tickets used in the live session, from templates.
#
# Every ticket created here is labelled 'live-demo' so reset-demo.sh can find and delete exactly
# these and nothing else. The Done column -- the evidence that the application was built by the
# factory -- is never touched.
#
# Rehearse by running this, walking the tickets through, then running reset-demo.sh --yes.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${JIRA_BASE_URL:=https://bmlltech.atlassian.net}"
: "${JIRA_EMAIL:=gavincarey@bmlltech.com}"
if [ -z "${JIRA_API_TOKEN:-}" ] && [ -r "$HOME/.config/factory/atlassian_token.txt" ]; then
  JIRA_API_TOKEN=$(tr -d ' \t\n\r' < "$HOME/.config/factory/atlassian_token.txt")
fi
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN is not set}"

create(){  # create <summary> <json-array-of-adf-nodes>
  local summary="$1" nodes="$2"
  local body
  body=$(SUMMARY="$summary" NODES="$nodes" python3 -c '
import json,os
print(json.dumps({"fields":{
  "project":{"key":"LLD"},
  "issuetype":{"name":"Story"},
  "summary":os.environ["SUMMARY"],
  "labels":["live-demo"],
  "description":{"type":"doc","version":1,"content":json.loads(os.environ["NODES"])},
}}))')
  curl -sS -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    "$JIRA_BASE_URL/rest/api/3/issue" --max-time 30 -d "$body" \
  | python3 -c '
import json,sys
d = json.load(sys.stdin)
key = d.get("key")
if not key:
    sys.stderr.write("FAILED to create issue: " + json.dumps(d)[:300] + "\n")
    sys.exit(1)
print(key)
'
}

h(){ python3 -c 'import json,sys;print(json.dumps({"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":sys.argv[1]}]}))' "$1"; }
p(){ python3 -c 'import json,sys;print(json.dumps({"type":"paragraph","content":[{"type":"text","text":sys.argv[1]}]}))' "$1"; }
ul(){ python3 -c '
import json,sys
print(json.dumps({"type":"bulletList","content":[
  {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":x}]}]} for x in sys.argv[1:]]}))' "$@"; }
join(){ local IFS=,; echo "[$*]"; }

# ---------------------------------------------------------------------------
# 1. THE COLD OPEN. Kicked off in the first three minutes and collected later.
#    Deliberately small, unmistakably visible, and specified tightly enough
#    that it cannot fail. This is the one that must work.
# ---------------------------------------------------------------------------
COLD=$(join \
  "$(h 'Outcome')" \
  "$(p 'The spread is shown in basis points beside the existing absolute figure, so its size can be judged without doing arithmetic.')" \
  "$(h 'Requirements')" \
  "$(p 'Extends REQ-10 (top-of-book readout). PRD section 8 lists this as headroom kept out of version 1.0 so that a later ticket could build it - this is that ticket, and it promotes the item into scope. Nothing else depends on it.')" \
  "$(h 'Acceptance criteria')" \
  "$(ul \
     'Given a best bid of 99 and a best ask of 101, when the spread in basis points is computed, then it is 200.0 - the quoted spread of 2, divided by the mid of 100, times 10000.' \
     'Given a book with one side empty, when the spread in basis points is computed, then it is reported as unavailable rather than as a number.' \
     'Given the readout, when it is viewed, then the basis points figure appears beside the absolute spread and is labelled bps.')" \
  "$(h 'Visual expectation')" \
  "$(p 'A second small figure next to the existing spread, clearly labelled. It must not compete with the mid price, which stays the most prominent number on screen.')" \
  "$(h 'Out of scope')" \
  "$(ul 'Any other item in PRD section 8' 'Changing the ladder, queue view, tape or chart')")

# ---------------------------------------------------------------------------
# 2. THE DECLINE. This one SHOULD be refused: no outcome, no testable
#    criterion, nothing visibly different. It is fixed live with the audience.
# ---------------------------------------------------------------------------
VAGUE=$(join \
  "$(p 'The order book display could be better. Please improve it and make it clearer for users.')" \
  "$(p 'Should look more professional.')")

# ---------------------------------------------------------------------------
# 3. THE FIX. What the vague ticket becomes once the room rewrites it against
#    the Definition of Ready. Seeded so the rehearsal can be run end to end;
#    on the day it is written live and this one stays in Idea as a fallback.
# ---------------------------------------------------------------------------
FIXED=$(join \
  "$(h 'Outcome')" \
  "$(p 'The best bid and best ask rows in the depth ladder are visually emphasised, so a viewer can see at a glance where the current price is without reading every row.')" \
  "$(h 'Requirements')" \
  "$(p 'Extends REQ-7 (depth ladder) and serves REQ-13 (legible without explanation).')" \
  "$(h 'Acceptance criteria')" \
  "$(ul \
     'Given a book with several levels a side, when the ladder is drawn, then the best bid row and the best ask row are emphasised more strongly than the rows behind them.' \
     'Given the emphasis, when it is inspected, then it does not rely on colour alone (NFR-3).' \
     'Given one side of the book is empty, when the ladder is drawn, then no row on that side is emphasised and no error occurs.')" \
  "$(h 'Visual expectation')" \
  "$(p 'The two rows either side of the centre line stand out from the rest. Everything else about the ladder is unchanged.')" \
  "$(h 'Out of scope')" \
  "$(ul 'Animating or flashing the touch when it moves - PRD section 8 holds that back' 'Any change to the queue view, tape, chart or readout')")

# ---------------------------------------------------------------------------
# 4. THE REAL OBSERVATION. Came from watching the finished app: the market is
#    unrealistically frantic and the price barely moves. A good audience
#    ticket precisely because nobody invented it for the demo.
# ---------------------------------------------------------------------------
SPEED=$(join \
  "$(h 'Outcome')" \
  "$(p 'The simulation runs at a pace a viewer can follow, and the price moves enough over a minute to be worth watching. At present it reads as an implausibly active market whose price barely changes.')" \
  "$(h 'Requirements')" \
  "$(p 'Tunes REQ-6 (plausible order flow) and REQ-11 (price chart). The generator stays seeded and reproducible - REQ-5 is not negotiable.')" \
  "$(h 'Acceptance criteria')" \
  "$(ul \
     'Given the simulation runs for one minute, when the events applied are counted, then there are meaningfully fewer than at the current rate.' \
     'Given the simulation runs for one minute, when the mid price at the start and end are compared, then it has moved by more than one tick on most runs.' \
     'Given the same seed twice, when both are run, then the sequences are still identical.' \
     'Given the six invariants, when they are checked over randomised flow, then all still hold.')" \
  "$(h 'Visual expectation')" \
  "$(p 'The ladder and queues change at a pace the eye can track. The price chart shows a visible trend over a minute rather than a flat line.')" \
  "$(h 'Out of scope')" \
  "$(ul 'A speed control - PRD section 8 holds that back' 'Any change to the matching engine')")

echo "seeding live-demo tickets..."
echo "  cold open : $(create 'Show the spread in basis points' "$COLD")"
echo "  vague     : $(create 'Make the order book display better' "$VAGUE")"
echo "  fixed     : $(create 'Emphasise the best bid and best ask in the ladder' "$FIXED")"
echo "  speed     : $(create 'Slow the market down so the price movement is visible' "$SPEED")"
echo
echo "All are in Idea and labelled 'live-demo'. reset-demo.sh deletes and recreates exactly these."
