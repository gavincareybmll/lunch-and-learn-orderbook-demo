#!/usr/bin/env bash
# Record the current state as the demo baseline: the git commit AND the live production deploy.
#
# Run this whenever the state you want to return to changes. Forgetting to is the obvious
# footgun -- a stale baseline means reset-demo.sh quietly deletes work you meant to keep.
# reset-demo.sh warns loudly if the baseline is behind main.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_ID="${NETLIFY_SITE_ID:-3ad0d238-fea0-4f6e-9078-bc5eb184aeeb}"
TOKEN="${NETLIFY_AUTH_TOKEN:-$(tr -d ' \t\n\r' < "$HOME/.config/factory/netlify_token.txt" 2>/dev/null || true)}"

# The commit is recorded by the git TAG, not in the JSON. Storing it in a file that is itself
# committed is circular -- the file would always name the commit before the one containing it.
# The JSON holds only what git cannot: which Netlify deploy is live.
DEPLOY_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys?per_page=20" --max-time 20 \
  | python3 -c '
import json,sys
for d in json.load(sys.stdin):
    if d.get("context")=="production" and d.get("state")=="ready":
        print(d["id"]); break
')

[ -n "$DEPLOY_ID" ] || { echo "could not find a live production deploy" >&2; exit 1; }

python3 - "$DEPLOY_ID" <<'PY'
import json,sys
json.dump({"netlify_deploy_id": sys.argv[1]}, open(".factory/demo-baseline.json","w"), indent=2)
open(".factory/demo-baseline.json","a").write("\n")
PY

# Commit the file FIRST, then tag -- so the tag names a commit that contains its own baseline file.
if ! git diff --quiet .factory/demo-baseline.json; then
  git add .factory/demo-baseline.json
  git commit -q -m "Record demo baseline

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  git push -q origin HEAD
fi

git tag -f demo-baseline >/dev/null
git push -q -f origin demo-baseline

echo "baseline set:"
echo "  commit         $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo "  netlify deploy $DEPLOY_ID"
