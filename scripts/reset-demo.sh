#!/usr/bin/env bash
# Reset the demonstrator to the state recorded by scripts/set-baseline.sh.
#
# Needed during the build as much as for rehearsals: when a ticket goes wrong, this is how you
# get back to a clean baseline without unpicking it by hand.
#
#   git/GitHub  main -> the baseline commit; feature branches and open PRs removed
#   Jira        everything NOT labelled 'baseline' is deleted, then the demo tickets re-seeded
#   Netlify     the baseline deploy is RESTORED, not rebuilt -- and only if production has
#               actually moved off it
#
# Restoring beats redeploying because a rebuild is ~60s of dead air if you ever need this
# mid-session. It is NOT free: a restore republishes the site and bills as a production deploy
# (15 credits on the free plan), which an earlier version of this script wrongly claimed was
# free. Six resets during a model comparison spent ~90 credits restoring a deploy that was
# already live. Hence the check below: if production is already at the baseline, do nothing.
#
# Dry run by default. Pass --yes to actually do it.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE=".factory/demo-baseline.json"
SITE_ID="${NETLIFY_SITE_ID:-3ad0d238-fea0-4f6e-9078-bc5eb184aeeb}"
BASELINE_LABEL="baseline"
APPLY=false
SKIP_NETLIFY=false
for ARG in "$@"; do
  case "$ARG" in
    --yes)         APPLY=true ;;
    --no-netlify)  SKIP_NETLIFY=true ;;
    *) echo "unknown argument: $ARG (expected --yes and/or --no-netlify)" >&2; exit 1 ;;
  esac
done

say(){ printf '%s\n' "$*"; }
act(){ if $APPLY; then eval "$1"; else say "    would run: $1"; fi; }

[ -f "$BASELINE_FILE" ] || { say "ERROR: no $BASELINE_FILE — run scripts/set-baseline.sh first"; exit 1; }
git rev-parse -q --verify refs/tags/demo-baseline >/dev/null \
  || { say "ERROR: no demo-baseline tag — run scripts/set-baseline.sh first"; exit 1; }
BASE_SHA=$(git rev-parse demo-baseline)
BASE_DEPLOY=$(python3 -c 'import json;print(json.load(open(".factory/demo-baseline.json"))["netlify_deploy_id"])')

if ! git diff --quiet || ! git diff --cached --quiet; then
  say "⚠️  You have uncommitted changes. This script hard-resets the working tree and they"
  say "    WILL be destroyed — including any edit to this script itself."
  git status --short | sed 's/^/      /'
  say ""
  if $APPLY; then
    printf "    Commit or stash first. Type 'discard' to throw them away: "
    read -r C; [ "$C" = "discard" ] || { say "    aborted"; exit 1; }
  fi
fi

$APPLY || say "=== DRY RUN — nothing will change. Re-run with --yes to apply. ==="
say

# ---------------------------------------------------------------- git / GitHub
say "git/GitHub"
git fetch -q origin --tags --force
AHEAD=$(git log --oneline "$BASE_SHA"..origin/main 2>/dev/null | wc -l)
if [ "$AHEAD" -gt 0 ]; then
  say ""
  say "  ⚠️  main is $AHEAD commit(s) AHEAD of the baseline. Resetting DISCARDS them:"
  git log --oneline "$BASE_SHA"..origin/main | sed 's/^/       /'
  say ""
  say "  If you meant to keep this work, stop now and run scripts/set-baseline.sh instead."
  if $APPLY; then
    printf "  Type 'discard' to continue: "
    read -r CONFIRM
    [ "$CONFIRM" = "discard" ] || { say "  aborted"; exit 1; }
  fi
else
  say "  main is at the baseline — nothing to roll back"
fi

act "git checkout -q main"
act "git reset -q --hard $BASE_SHA"
act "git push -q --force-with-lease origin main"

for PR in $(gh pr list --state open --json number --jq '.[].number' 2>/dev/null); do
  say "  closing PR #$PR"
  act "gh pr close $PR --delete-branch --comment 'Closed by reset-demo.sh' >/dev/null"
done
for B in $(git ls-remote --heads origin 'refs/heads/feat/*' 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||'); do
  say "  deleting remote branch $B"
  act "git push -q origin --delete '$B'"
done

# ------------------------------------------------------------------------ Jira
#
# Deliberately an ALLOWLIST, not a denylist. Anything labelled 'baseline' survives; everything
# else is deleted. Deleting things carrying a 'demo' label instead would require every ticket to
# be labelled correctly at creation, which fails the moment an audience member creates one. The
# set to protect is small, known and static; the set to discard is unbounded.
say
say "Jira"
ALL=$(./scripts/jira.sh search "project=LLD ORDER BY created ASC" 2>/dev/null | awk -F'\t' '/^[A-Z]+-[0-9]+/{print $1"|"$2"|"$3"|"$4}')
KEEP=""; DROP=""
while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  K="${LINE%%|*}"; REST="${LINE#*|}"; STATUS="${REST%%|*}"
  REST="${REST#*|}"; LABELS="${REST%%|*}"; SUMMARY="${REST#*|}"
  case ",$LABELS," in
    *",$BASELINE_LABEL,"*) KEEP="$KEEP $K" ;;
    *)                     DROP="$DROP $K"; say "  DELETE  $K  [$STATUS]  ${SUMMARY:0:52}" ;;
  esac
done <<< "$ALL"

KEEP_N=$(echo $KEEP | wc -w); DROP_N=$(echo $DROP | wc -w)
say "  keeping $KEEP_N ticket(s) labelled '$BASELINE_LABEL'; deleting $DROP_N"

if [ "$KEEP_N" -eq 0 ]; then
  say ""
  say "  ⚠️  NOTHING is labelled '$BASELINE_LABEL'. That would delete the entire board."
  say "     Refusing. Label the tickets you want to keep first."
  say "     (Jira's search index lags by a few seconds after labelling — wait, then retry.)"
  exit 1
fi

if $APPLY && [ "$DROP_N" -gt 0 ]; then
  printf "  Delete these %s ticket(s)? Type 'delete' to continue: " "$DROP_N"
  read -r CONFIRM
  [ "$CONFIRM" = "delete" ] || { say "  aborted"; exit 1; }
fi

for K in $DROP; do
  act "curl -sS -u \"\${JIRA_EMAIL:-gavincarey@bmlltech.com}:\$(tr -d ' \t\n\r' < ~/.config/factory/atlassian_token.txt)\" -X DELETE -o /dev/null \"\${JIRA_BASE_URL:-https://bmlltech.atlassian.net}/rest/api/3/issue/$K\""
done

say "  re-seeding the demo tickets"
act "./scripts/seed-demo-tickets.sh"

# --------------------------------------------------------------------- Netlify
say
say "Netlify"
NETLIFY_TOKEN=$(tr -d ' \t\n\r' < ~/.config/factory/netlify_token.txt 2>/dev/null || true)
LIVE=$(curl -sS -H "Authorization: Bearer $NETLIFY_TOKEN" --max-time 20 \
  "https://api.netlify.com/api/v1/sites/$SITE_ID" 2>/dev/null \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("published_deploy") or {}).get("id",""))' 2>/dev/null || true)

if $SKIP_NETLIFY; then
  say "  --no-netlify given; leaving production alone (currently ${LIVE:-unknown})"
elif [ -z "$LIVE" ]; then
  say "  ⚠️  could not read the live deploy; NOT restoring blind (a restore costs 15 credits)"
  say "     check the site by hand, then re-run with the restore if production has moved"
elif [ "$LIVE" = "$BASE_DEPLOY" ]; then
  say "  production is already at the baseline deploy — nothing to restore"
else
  say "  production is at $LIVE, baseline is $BASE_DEPLOY — restoring (costs 15 credits)"
  act "curl -sS -X POST -H \"Authorization: Bearer \$(tr -d ' \t\n\r' < ~/.config/factory/netlify_token.txt)\" -o /dev/null \"https://api.netlify.com/api/v1/sites/$SITE_ID/deploys/$BASE_DEPLOY/restore\""
fi

say
if $APPLY; then
  sleep 3
  printf "  production now: "
  curl -sS -o /dev/null -w "HTTP:%{http_code}\n" "https://bmll-orderbook-factory-demo.netlify.app/?cb=$RANDOM"
  say "=== reset complete ==="
else
  say "=== dry run complete — re-run with --yes to apply ==="
fi
