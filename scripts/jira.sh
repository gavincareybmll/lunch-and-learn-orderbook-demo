#!/usr/bin/env bash
# Jira toolkit for the software factory.
#
# Exists so the agent never hand-rolls curl and ADF JSON. Two things it gets right
# that are easy to get wrong:
#   - comments are built as proper ADF; a plain-text "@Name" renders as literal
#     text and notifies nobody, so mentions are real ADF mention nodes
#   - transitions are resolved by visible status name, not by numeric id
#
# Auth comes from the environment (CI secrets), falling back to ~/.config/factory
# for local use:
#   JIRA_BASE_URL   e.g. https://bmlltech.atlassian.net
#   JIRA_EMAIL      e.g. someone@bmlltech.com
#   JIRA_API_TOKEN  Atlassian API token
set -euo pipefail

: "${JIRA_BASE_URL:=https://bmlltech.atlassian.net}"
: "${JIRA_EMAIL:=gavincarey@bmlltech.com}"
if [ -z "${JIRA_API_TOKEN:-}" ] && [ -r "$HOME/.config/factory/atlassian_token.txt" ]; then
  JIRA_API_TOKEN=$(tr -d ' \t\n\r' < "$HOME/.config/factory/atlassian_token.txt")
fi
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN is not set}"

API="$JIRA_BASE_URL/rest/api/3"
AUTH="$JIRA_EMAIL:$JIRA_API_TOKEN"

die(){ echo "jira.sh: $*" >&2; exit 1; }

# call METHOD PATH [JSON_BODY] -> body on stdout; non-2xx is fatal with the response shown
call(){
  local method="$1" path="$2" body="${3:-}" out code
  if [ -n "$body" ]; then
    out=$(curl -sS -u "$AUTH" -X "$method" -H "Content-Type: application/json" -H "Accept: application/json" \
          --max-time 30 -w $'\n%{http_code}' "$API$path" -d "$body")
  else
    out=$(curl -sS -u "$AUTH" -X "$method" -H "Accept: application/json" \
          --max-time 30 -w $'\n%{http_code}' "$API$path")
  fi
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  case "$code" in
    2*) printf '%s' "$body" ;;
    *)  die "$method $path -> HTTP $code${body:+ :: ${body:0:400}}" ;;
  esac
}

# ---- ADF helpers -----------------------------------------------------------

# Flatten an ADF document to plain text (headings, paragraphs, lists, code).
adf_to_text(){
  python3 -c '
import json,sys
def walk(n,out,depth=0):
    t=n.get("type")
    if t=="text": out.append(n.get("text","")); return
    if t=="hardBreak": out.append("\n"); return
    if t=="mention": out.append("@"+n.get("attrs",{}).get("text","").lstrip("@")); return
    for c in n.get("content",[]) or []: walk(c,out,depth+1)
    if t in ("paragraph","heading","listItem","codeBlock","blockquote"): out.append("\n")
    if t in ("bulletList","orderedList"): out.append("\n")
d=json.load(sys.stdin)
if not isinstance(d,dict) or not d.get("type"): print(""); raise SystemExit
o=[]; walk(d,o)
txt="".join(o)
while "\n\n\n" in txt: txt=txt.replace("\n\n\n","\n\n")
print(txt.strip())
'
}

# Build an ADF doc from plain text, optionally prefixed with a real mention node.
# Blank lines separate paragraphs; everything else is literal.
#
# Every comment opens with an attribution line. The API token belongs to a real person,
# so without this the comment carries their name and avatar -- and an automated action
# reads as a human one. The line is cheap and makes the automation honest.
adf_from_text(){
  local text="$1" mention_id="${2:-}" mention_text="${3:-}"
  TEXT="$text" MID="$mention_id" MTEXT="$mention_text" python3 -c '
import json,os
text=os.environ["TEXT"]; mid=os.environ.get("MID",""); mtext=os.environ.get("MTEXT","") or "@PM"
content=[{"type":"paragraph","content":[
    {"type":"text","text":"Factory agent \u00b7 automated","marks":[{"type":"strong"}]}]}]
for i,p in enumerate(text.split("\n\n")):
    nodes=[]
    if i==0 and mid:
        nodes.append({"type":"mention","attrs":{"id":mid,"text":mtext if mtext.startswith("@") else "@"+mtext}})
        nodes.append({"type":"text","text":" "})
    if p: nodes.append({"type":"text","text":p})
    if nodes: content.append({"type":"paragraph","content":nodes})
print(json.dumps({"body":{"type":"doc","version":1,"content":content}}))
'
}

# ---- commands --------------------------------------------------------------

cmd_get(){
  local key="${1:?usage: jira.sh get <ISSUE-KEY>}"
  local issue; issue=$(call GET "/issue/$key?fields=summary,description,status,labels,issuetype,comment")

  printf '%s' "$issue" | python3 -c '
import json,sys
d=json.load(sys.stdin); f=d.get("fields",{})
print("KEY:     ", d.get("key"))
print("TYPE:    ", (f.get("issuetype") or {}).get("name"))
print("STATUS:  ", (f.get("status") or {}).get("name"))
print("LABELS:  ", ", ".join(f.get("labels") or []) or "(none)")
print("SUMMARY: ", f.get("summary"))
'
  echo
  echo "--- DESCRIPTION ---"
  printf '%s' "$issue" \
    | python3 -c 'import json,sys; print(json.dumps((json.load(sys.stdin).get("fields") or {}).get("description") or {}))' \
    | adf_to_text
  echo
  echo "--- COMMENTS ---"
  printf '%s' "$issue" | python3 -c '
import json,sys
def walk(n,out):
    t=n.get("type")
    if t=="text": out.append(n.get("text","")); return
    if t=="hardBreak": out.append("\n"); return
    if t=="mention": out.append("@"+(n.get("attrs",{}).get("text","") or "").lstrip("@")); return
    for c in n.get("content",[]) or []: walk(c,out)
    if t in ("paragraph","heading","listItem"): out.append("\n")
cs=((json.load(sys.stdin).get("fields") or {}).get("comment") or {}).get("comments") or []
if not cs: print("(none)")
for c in cs:
    o=[]; walk(c.get("body") or {},o)
    print("[" + ((c.get("author") or {}).get("displayName") or "?") + "] " + "".join(o).strip())
    print()
'
}

cmd_transitions(){
  local key="${1:?usage: jira.sh transitions <ISSUE-KEY>}"
  call GET "/issue/$key/transitions" | python3 -c '
import json,sys
for t in json.load(sys.stdin).get("transitions",[]):
    print(f'"'"'{t["id"]:>4}  -> {t["to"]["name"]}'"'"')
'
}

cmd_transition(){
  local key="${1:?usage: jira.sh transition <ISSUE-KEY> <STATUS NAME>}"
  local target="${2:?usage: jira.sh transition <ISSUE-KEY> <STATUS NAME>}"
  local tid
  tid=$(call GET "/issue/$key/transitions" | TARGET="$target" python3 -c '
import json,sys,os
want=os.environ["TARGET"].strip().lower()
ts=json.load(sys.stdin).get("transitions",[])
for t in ts:
    if t["to"]["name"].strip().lower()==want: print(t["id"]); break
else:
    sys.stderr.write("available: "+", ".join(t["to"]["name"] for t in ts)+"\n")
')
  [ -n "$tid" ] || die "no transition to '$target' from the current status of $key"
  call POST "/issue/$key/transitions" "{\"transition\":{\"id\":\"$tid\"}}" >/dev/null
  echo "$key -> $target"
}

cmd_comment(){
  local key="" text="" mid="" mtext=""
  key="${1:?usage: jira.sh comment <ISSUE-KEY> <text> [--mention <accountId> [--mention-name <name>]]}"; shift
  text="${1:?usage: jira.sh comment <ISSUE-KEY> <text> [--mention <accountId>]}"; shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --mention) mid="${2:?--mention needs an accountId}"; shift 2 ;;
      --mention-name) mtext="${2:?--mention-name needs a name}"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$mid" ] && [ -z "$mtext" ] && mtext="@PM"
  local body; body=$(adf_from_text "$text" "$mid" "$mtext")
  call POST "/issue/$key/comment" "$body" >/dev/null
  echo "commented on $key${mid:+ (mentioning $mid)}"
}

cmd_search(){
  local jql="${1:?usage: jira.sh search <JQL>}"
  local enc; enc=$(JQL="$jql" python3 -c 'import os,urllib.parse; print(urllib.parse.quote(os.environ["JQL"]))')
  call GET "/search/jql?jql=$enc&maxResults=50&fields=key,summary,status,labels" | python3 -c '
import json,sys
issues = json.load(sys.stdin).get("issues") or []
if not issues:
    print("(no matching issues)")
for i in issues:
    f = i.get("fields") or {}
    status = (f.get("status") or {}).get("name") or "?"
    labels = ",".join(f.get("labels") or []) or "-"
    print("\t".join([i.get("key",""), status, labels, f.get("summary") or ""]))
'
}

cmd_label(){
  local key="${1:?usage: jira.sh label <ISSUE-KEY> <label>}" lab="${2:?usage: jira.sh label <ISSUE-KEY> <label>}"
  call PUT "/issue/$key" "{\"update\":{\"labels\":[{\"add\":\"$lab\"}]}}" >/dev/null
  echo "$key labelled $lab"
}

usage(){ cat >&2 <<USG
usage: jira.sh <command>

  get <KEY>                              summary, description, status, comments
  search <JQL>                           key, status, labels, summary for matching issues
  transitions <KEY>                      statuses reachable from here
  transition <KEY> "<Status Name>"       move the ticket
  comment <KEY> "<text>" [--mention <accountId> [--mention-name "<name>"]]
  label <KEY> <label>                    add a label
USG
exit 2; }

case "${1:-}" in
  get)          shift; cmd_get "$@" ;;
  search)       shift; cmd_search "$@" ;;
  transitions)  shift; cmd_transitions "$@" ;;
  transition)   shift; cmd_transition "$@" ;;
  comment)      shift; cmd_comment "$@" ;;
  label)        shift; cmd_label "$@" ;;
  *)            usage ;;
esac
