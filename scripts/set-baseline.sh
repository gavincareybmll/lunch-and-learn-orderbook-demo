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

SHA=$(git rev-parse HEAD)
DEPLOY_ID=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys?per_page=20" --max-time 20 \
  | python3 -c '
import json,sys
for d in json.load(sys.stdin):
    if d.get("context")=="production" and d.get("state")=="ready":
        print(d["id"]); break
')

[ -n "$DEPLOY_ID" ] || { echo "could not find a live production deploy" >&2; exit 1; }

python3 - "$SHA" "$DEPLOY_ID" <<'PY'
import json,sys
json.dump({"commit": sys.argv[1], "netlify_deploy_id": sys.argv[2]},
          open(".factory/demo-baseline.json","w"), indent=2)
open(".factory/demo-baseline.json","a").write("\n")
PY

git tag -f demo-baseline >/dev/null
git push -q -f origin demo-baseline

echo "baseline set:"
echo "  commit         $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo "  netlify deploy $DEPLOY_ID"
echo
echo "Commit .factory/demo-baseline.json and push, then the baseline is complete."
