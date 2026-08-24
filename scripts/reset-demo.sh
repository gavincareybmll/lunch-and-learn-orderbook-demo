#!/usr/bin/env bash
# Reset the demonstrator to a known-good state.
#
# Needed during the build as much as for rehearsals: when a bootstrap ticket goes
# wrong, this is how you get back to a clean baseline without unpicking it by hand.
#
# Three surfaces get reset:
#   git/GitHub  main -> the demo-baseline tag; feature branches and open PRs removed
#   Jira        issues labelled 'live-demo' deleted (the seeded Done column is untouched)
#   Netlify     production redeployed from the reset tree
#
# Dry run by default. Pass --yes to actually do it.
set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE_TAG="demo-baseline"
SITE_NAME="bmll-orderbook-factory-demo"
LIVE_DEMO_LABEL="live-demo"
APPLY=false
[ "${1:-}" = "--yes" ] && APPLY=true

say(){ printf '%s\n' "$*"; }
act(){ if $APPLY; then eval "$1"; else say "    would run: $1"; fi; }

if ! git rev-parse -q --verify "refs/tags/$BASELINE_TAG" >/dev/null; then
  say "ERROR: no '$BASELINE_TAG' tag. Create it at the known-good commit first:"
  say "    git tag $BASELINE_TAG <sha> && git push origin $BASELINE_TAG"
  exit 1
fi

$APPLY || say "=== DRY RUN — nothing will change. Re-run with --yes to apply. ==="
say

# ---------------------------------------------------------------- git / GitHub
say "git/GitHub"
BASE_SHA=$(git rev-parse --short "$BASELINE_TAG")
HEAD_SHA=$(git rev-parse --short origin/main 2>/dev/null || echo "?")
say "  main is at $HEAD_SHA, baseline is $BASE_SHA"

if [ "$BASE_SHA" != "$HEAD_SHA" ]; then
  act "git fetch -q origin"
  act "git checkout -q main"
  act "git reset --hard $BASELINE_TAG"
  act "git push --force-with-lease origin main"
else
  say "  main already at baseline — nothing to do"
fi

for PR in $(gh pr list --state open --json number --jq '.[].number' 2>/dev/null); do
  say "  closing PR #$PR"
  act "gh pr close $PR --delete-branch --comment 'Closed by reset-demo.sh'"
done

for B in $(git ls-remote --heads origin 'refs/heads/feat/*' 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||'); do
  say "  deleting remote branch $B"
  act "git push -q origin --delete '$B'"
done

# ------------------------------------------------------------------------ Jira
say
say "Jira"
JQL="project%3DLLD%20AND%20labels%3D$LIVE_DEMO_LABEL"
KEYS=$(JIRA_QUERY="$JQL" bash -c '
  TOK="${JIRA_API_TOKEN:-$(tr -d " \t\n\r" < "$HOME/.config/factory/atlassian_token.txt")}"
  curl -sS -u "${JIRA_EMAIL:-gavincarey@bmlltech.com}:$TOK" -H "Accept: application/json" --max-time 20 \
    "${JIRA_BASE_URL:-https://bmlltech.atlassian.net}/rest/api/3/search/jql?jql=$JIRA_QUERY&maxResults=50&fields=key" \
  | python3 -c "import json,sys;print(\" \".join(i[\"key\"] for i in (json.load(sys.stdin).get(\"issues\") or [])))"
' 2>/dev/null || true)

if [ -z "${KEYS// }" ]; then
  say "  no issues labelled '$LIVE_DEMO_LABEL' — nothing to delete"
  say "  (the seeded Done column is deliberately left alone)"
else
  for K in $KEYS; do
    say "  deleting $K"
    act "curl -sS -u \"\${JIRA_EMAIL:-gavincarey@bmlltech.com}:\$(tr -d ' \t\n\r' < ~/.config/factory/atlassian_token.txt)\" -X DELETE -o /dev/null '${JIRA_BASE_URL:-https://bmlltech.atlassian.net}/rest/api/3/issue/$K'"
  done
fi

# --------------------------------------------------------------------- Netlify
say
say "Netlify"
say "  redeploying production from the reset tree"
act "netlify deploy --dir=public --no-build --prod --site \"\${NETLIFY_SITE_ID:-}\" --auth \"\${NETLIFY_AUTH_TOKEN:-\$(tr -d ' \t\n\r' < ~/.config/factory/netlify_token.txt)}\""
say
say "  NOTE: for an emergency rollback mid-demo, do NOT use this script."
say "  Netlify keeps deploy history — 'Publish deploy' on an earlier deploy is near-instant,"
say "  where a rebuild is ~60s of dead air on stage."
say "    https://app.netlify.com/projects/$SITE_NAME/deploys"

say
$APPLY && say "=== reset complete ===" || say "=== dry run complete — re-run with --yes to apply ==="
