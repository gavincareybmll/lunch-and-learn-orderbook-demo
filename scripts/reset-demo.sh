#!/usr/bin/env bash
# Reset the demonstrator to the state recorded by scripts/set-baseline.sh.
#
# Needed during the build as much as for rehearsals: when a ticket goes wrong, this is how you
# get back to a clean baseline without unpicking it by hand.
#
#   git/GitHub  main -> the baseline commit; feature branches and open PRs removed
#   Jira        issues labelled 'live-demo' deleted, then re-seeded from templates
#   Netlify     the baseline deploy is RESTORED (free and instant), not rebuilt
#
# Restoring rather than redeploying matters twice over: a production deploy costs 15 credits on
# the free plan, and a rebuild is ~60s of dead air if you ever need this mid-session.
#
# Dry run by default. Pass --yes to actually do it.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE=".factory/demo-baseline.json"
SITE_ID="${NETLIFY_SITE_ID:-3ad0d238-fea0-4f6e-9078-bc5eb184aeeb}"
LIVE_DEMO_LABEL="live-demo"
APPLY=false
[ "${1:-}" = "--yes" ] && APPLY=true

say(){ printf '%s\n' "$*"; }
act(){ if $APPLY; then eval "$1"; else say "    would run: $1"; fi; }

[ -f "$BASELINE_FILE" ] || { say "ERROR: no $BASELINE_FILE — run scripts/set-baseline.sh first"; exit 1; }
BASE_SHA=$(python3 -c 'import json;print(json.load(open(".factory/demo-baseline.json"))["commit"])')
BASE_DEPLOY=$(python3 -c 'import json;print(json.load(open(".factory/demo-baseline.json"))["netlify_deploy_id"])')

$APPLY || say "=== DRY RUN — nothing will change. Re-run with --yes to apply. ==="
say

# ---------------------------------------------------------------- git / GitHub
say "git/GitHub"
git fetch -q origin --tags
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
say
say "Jira"
KEYS=$(./scripts/jira.sh search "project=LLD AND labels=$LIVE_DEMO_LABEL" 2>/dev/null | awk -F'\t' '/^[A-Z]+-[0-9]+/{print $1}')
if [ -z "${KEYS// }" ]; then
  say "  no issues labelled '$LIVE_DEMO_LABEL'"
else
  for K in $KEYS; do
    say "  deleting $K"
    act "curl -sS -u \"\${JIRA_EMAIL:-gavincarey@bmlltech.com}:\$(tr -d ' \t\n\r' < ~/.config/factory/atlassian_token.txt)\" -X DELETE -o /dev/null \"\${JIRA_BASE_URL:-https://bmlltech.atlassian.net}/rest/api/3/issue/$K\""
  done
fi
say "  re-seeding the demo tickets"
act "./scripts/seed-demo-tickets.sh"
say "  (tickets NOT labelled '$LIVE_DEMO_LABEL' are left alone — the Done column is the demo's evidence)"

# --------------------------------------------------------------------- Netlify
say
say "Netlify"
say "  restoring baseline deploy $BASE_DEPLOY (free — a fresh production deploy costs 15 credits)"
act "curl -sS -X POST -H \"Authorization: Bearer \$(tr -d ' \t\n\r' < ~/.config/factory/netlify_token.txt)\" -o /dev/null \"https://api.netlify.com/api/v1/sites/$SITE_ID/deploys/$BASE_DEPLOY/restore\""

say
if $APPLY; then
  sleep 3
  printf "  production now: "
  curl -sS -o /dev/null -w "HTTP:%{http_code}\n" "https://bmll-orderbook-factory-demo.netlify.app/?cb=$RANDOM"
  say "=== reset complete ==="
else
  say "=== dry run complete — re-run with --yes to apply ==="
fi
