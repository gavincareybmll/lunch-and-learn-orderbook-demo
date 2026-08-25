# Build this yourself

A step-by-step for standing up the same factory on your own project. Roughly two hours if nothing
fights you, and the verification gates below are there so that when something does fight you, you
find out immediately rather than three steps later.

**Deployment is the one part you will certainly replace.** We use Netlify because it is free and
takes one command; you will use whatever you already use. That seam is marked clearly in step 8 —
everything before it is the same wherever you deploy.

Each step ends with a **✅ Prove it** check. Do not move on until it passes. Almost every hour we
lost was spent building on top of a link we had assumed worked.

---

## What you need first

| | |
|---|---|
| **Jira** | A Standard plan or above — *Send web request* is not available on Free. Permission to create a project |
| **GitHub** | A repository you can admin, and `gh` CLI authenticated |
| **Anthropic** | A Claude subscription (Pro/Max/Team/Enterprise) or a Console API key |
| **Hosting** | Anything you can deploy to from a shell command |

Check the Jira plan before anything else — it is the one prerequisite that cannot be worked
around:

```bash
curl -s -u "you@example.com:$JIRA_TOKEN" \
  "https://YOURSITE.atlassian.net/rest/api/3/instance/license"
```

`jira-software` must not be `FREE`.

---

## 1. The repository

```bash
gh auth refresh -h github.com -s workflow   # pushing .github/workflows/ needs this scope
gh repo create my-factory --public --clone
```

> **Trap:** without the `workflow` scope every push touching `.github/workflows/` is rejected, and
> the error does not mention scopes.

**✅ Prove it:** `gh api user -i | grep -i x-oauth-scopes` includes `workflow`.

---

## 2. Install the Claude GitHub App

Install **https://github.com/apps/claude** on the repository.

> **Trap:** this is not optional and its absence surfaces late. The action authenticates as this
> app, and without it every run dies with
> `App token exchange failed: 401 — Claude Code is not installed on this repository`.

---

## 3. Anthropic credentials

Either mint a subscription token:

```bash
claude setup-token          # gives sk-ant-oat01-...
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO
```

…or use a Console API key as `ANTHROPIC_API_KEY`. The workflow accepts either — swapping is a
one-line change, which is worth knowing if you ever need to fail over under pressure.

---

## 4. The Jira project

Create a **team-managed** project. Team-managed matters: transitions default to any-to-any, so the
agent can move a ticket from anywhere to anywhere. Company-managed workflows will block
transitions you have not explicitly allowed.

> **Trap:** you cannot create the project through the REST API without site-admin. Use the UI —
> `CREATE_PROJECT` permission is not enough for the API, which reports
> *"You must have global administrator rights"*.

Set the board columns to exactly these names — the toolkit resolves transitions by visible name:

```
Idea · Refining · Ready for Engineering · In Progress · Needs Info · In Review · Ready for Deployment · Done
```

**✅ Prove it:** create a scratch issue and walk the whole path, especially
`In Progress → Needs Info` — the refusal route. If that transition is unavailable, the agent's
ability to decline fails *silently*.

```bash
./scripts/jira.sh transitions SCRATCH-1
```

---

## 5. Jira credentials, and your own account id

Create an API token at **id.atlassian.com → Security → API tokens**, then:

```bash
gh secret set JIRA_API_TOKEN --repo OWNER/REPO
gh secret set JIRA_EMAIL     --repo OWNER/REPO   # you@example.com
gh secret set JIRA_BASE_URL  --repo OWNER/REPO   # https://YOURSITE.atlassian.net
```

You also need the account id of whoever should be @-mentioned when the agent declines a ticket:

```bash
curl -s -u "you@example.com:$JIRA_TOKEN" \
  "https://YOURSITE.atlassian.net/rest/api/3/myself" | grep accountId
gh secret set PM_ACCOUNT_ID --repo OWNER/REPO
```

> **Trap:** Jira comments are ADF. A plain-text `@Name` renders as literal text and notifies
> nobody. Real mentions need a `mention` node carrying the account id — `scripts/jira.sh` builds
> these for you, which is most of why it exists.

---

## 6. A GitHub token for Jira to call with

**Settings → Developer settings → Fine-grained personal access tokens.** Scope it to this one
repository, with **Contents: read and write** — that is what `repository_dispatch` requires. Give
it an expiry beyond your demo date.

**✅ Prove it** before going near Jira, so that when the rule fails you know it is the rule:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $PAT" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{"event_type":"jira-build","client_payload":{"issue_key":"TEST-1"}}'
```

`204` is success.

---

## 7. The Jira automation rules

**Project settings → Automation → Create rule.**

- **Trigger:** *Issue transitioned* → To status: `Ready for Engineering`. Leave *From* empty
- **Action:** *Send web request*
  - URL `https://api.github.com/repos/OWNER/REPO/dispatches`
  - Method **POST**, body type **Custom data**
  - Header — **Name:** `Authorization`  **Value:** `Bearer ` + your token
  - Body:

```json
{"event_type":"jira-build","client_payload":{"issue_key":"{{issue.key}}"}}
```

Duplicate it for deployment: trigger on `Ready for Deployment`, `"event_type":"jira-deploy"`.

> **Trap, and it cost us an evening.** The headers table has *Name* and *Value* columns, and the
> instruction "add `Authorization: Bearer <token>`" maps onto them badly. The word **Bearer**
> belongs in the **Value** field, before the token — not in the Name field. A bare token with no
> scheme returns `401 {"message":"Requires authentication"}`, which is byte-identical to sending
> no header at all. A *wrong* token says `Bad credentials`; "Requires authentication" means
> **no credential arrived**.
>
> Also: Jira masks secret header values after saving. Reopening a rule to check can save the value
> back as empty, and duplicating a rule does not copy it. If it stops working after an edit,
> delete the header row and re-add it.

**✅ Prove it:** move a scratch ticket to `Ready for Engineering` and confirm a run appears under
Actions within about five seconds. Jira's **Audit log** on the rule shows exactly what it sent.

---

## 8. Deployment — the seam you replace

Ours is two commands, and only these two lines are Netlify-specific:

```bash
# per-ticket preview, keyed on the issue so the URL is known before the run starts
netlify deploy --dir=public --no-build --alias "$ISSUE_KEY"

# production
netlify deploy --dir=public --no-build --prod
```

Whatever you use, keep these three properties — they are what make the demo persuasive and the
loop trustworthy:

1. **A per-ticket preview URL that is chosen, not guessed.** The agent posts it to Jira, so it must
   be correct by construction. Guessing a URL scheme means eventually posting a dead link
2. **A one-command deploy**, so the agent needs no bespoke knowledge
3. **A cheap way to verify it is actually live** — fetch it and check for 200 before claiming success

> **Trap (Netlify specifically):** the free plan is credit-based, not build-minute based.
> **Production deploys cost 15 credits; previews are free.** We reasoned carefully about build
> minutes — which we genuinely never consume — and missed this entirely until a billing alert
> arrived. Also check **Team settings → SSO**: sites can be gated so that only logged-in team
> members can view them, which you will not notice because *you* are logged in.

---

## 9. Copy the factory itself

From this repository:

| Path | What it is |
|---|---|
| `.github/workflows/factory-build.yml` | Triggered by `jira-build` |
| `.github/workflows/factory-deploy.yml` | Triggered by `jira-deploy` |
| `.github/workflows/ci.yml` | Tests. **Must trigger on `feat/**` pushes, not just PRs** |
| `.factory/build-prompt.md` | What the agent does with a ticket |
| `.factory/deploy-prompt.md` | Single ticket, hold-for-release, and batch release |
| `scripts/jira.sh` | Read, comment with real mentions, transition, search, label |
| `scripts/run-telemetry.sh` | Posts model, time, tokens and cost back to the ticket |
| `scripts/reset-demo.sh` | Resets git, Jira and the deployment to a known baseline |
| `CLAUDE.md` | Project context the agent reads on every run |

Then edit for your project: the Jira key and statuses, the deploy commands, and `CLAUDE.md`.

Two settings worth getting right immediately, because both cost us runs:

- **`--max-turns`.** Ours climbed from 21 on the first ticket to 61 on the eighth as the codebase
  grew. We had it at 60 and lost two runs. Start at 120
- **Do not pass `github_token` to the action.** Commits made with the default `GITHUB_TOKEN` do not
  trigger workflows, so the PR shows zero checks and you lose the red-then-green evidence

---

## 10. The end-to-end test

Write one deliberately vague ticket — *"make the app better"* — and move it to
`Ready for Engineering`.

**A decline is the pass condition.** You want to see it move to `Needs Info` with a comment saying
specifically what is missing. That proves the whole chain works *and* that the agent's judgement is
live, and it is much cheaper to debug than a full build.

Then write a small, precisely-specified ticket and watch it produce a PR.

---

## When it breaks

| Symptom | Cause |
|---|---|
| Nothing happens on transition | Rule disabled, a *From status* constraint, or the header (step 7) |
| `401 Requires authentication` | No credential arrived — missing `Bearer `, or a blanked header value |
| `401 Bad credentials` | The token is genuinely wrong or expired |
| `Claude Code is not installed on this repository` | Step 2 |
| `error_max_turns` | Raise `--max-turns` |
| PR shows zero CI checks | You passed `github_token`, or CI does not trigger on `feat/**` |
| Workflow edits have no effect | `repository_dispatch` only fires workflow files on the **default branch**. Merge to `main` |
| Agent runs but the ticket never moves | Check the transition is reachable from the current status (step 4) |

That last row is worth internalising as a habit rather than a fix: **prove each link before
building on it.** Everything above is a checklist derived from getting that wrong.
