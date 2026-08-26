# Hibernating the factory, and waking it up again

The demonstrator was run on 26 August 2026 and then put to sleep. This is what was switched off,
why, and what to do to bring it back.

**There are no credentials in this file, and there must never be any.** It names the secrets by
name only. Where a value is needed, it says where to get a fresh one — a token in a document is a
token in every clone of the repository, forever.

---

## Why it needed switching off at all

The demonstration ends with a room full of people who now know that moving a Jira ticket into
**Ready for Engineering** causes an AI agent to spend money. That is the whole point of the
session, and it is exactly why it cannot be left running.

The risk is not malice. It is a colleague who enjoyed the demo, remembers the board, and moves a
ticket a fortnight later to see what happens — plus anyone who does that four times in a row
because nothing appeared to happen the first time. A build costs a few dollars. A board anyone can
drag a card on, wired to an unattended agent with no budget cap, is an uncapped liability.

---

## What was switched off

Two things, at two different layers. Both are reversible in about a minute.

| # | What | Effect |
|---|---|---|
| 1 | `Factory Build` and `Factory Deploy` workflows **disabled** | A dispatch is still accepted by GitHub, but no run starts |
| 2 | The `CLAUDE_CODE_OAUTH_TOKEN` repository secret **deleted** | Even if a workflow were re-enabled, the agent step cannot authenticate |

```bash
gh workflow disable "Factory Build" && gh workflow disable "Factory Deploy"
```

```bash
gh secret delete CLAUDE_CODE_OAUTH_TOKEN
```

**Both, not either.** Disabling the workflows alone leaves a live credential one toggle away from
spending. Deleting the secret alone leaves every ticket move producing a loud red failure, which
trains people to ignore red failures. Belt and braces, and neither costs anything to keep.

**Verified rather than assumed.** After switching both off, a `repository_dispatch` was sent by
hand. GitHub returned `204 No Content` — accepted — and no run appeared. That is the check worth
repeating if you ever change this: *the absence of an error is not evidence that nothing happened.*

### What was deliberately left alone

| Left running | Why it is safe |
|---|---|
| The `CI` workflow | Runs `node --test` on pushes. No agent, no API key, and public repositories get unlimited free runner minutes |
| The live site, the PRD and the deck | Static files already deployed. Serving them costs a fraction of a Netlify credit per month |
| `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` | Only ever used *by* the factory workflows, which are disabled. Nothing else can reach them |
| `JIRA_*` and `PM_ACCOUNT_ID` secrets | Same — only reachable from the disabled workflows |
| The `FACTORY_MODEL` variable | A setting, not a credential. Currently `claude-opus-5` |
| The Jira board, tickets and history | The record of what was built. Worth keeping |

---

## The layers between a ticket and a bill

Useful to have written down, because when you wake this up you are re-arming them in order.

```
someone drags a Jira card
   │
   1. Jira automation rule  ── "Send web request" to GitHub   [still enabled]
   │
   2. GitHub workflow       ── Factory Build                   [DISABLED]
   │
   3. Anthropic credential  ── CLAUDE_CODE_OAUTH_TOKEN         [DELETED]
   │
   4. the agent runs and spends money
```

Layer 1 is still enabled and that is fine: it fires into a workflow that no longer starts. If you
want belt, braces *and* a third layer — say the repository is going to sit untouched for a year —
disable the automation rule in Jira as well: **Project settings → Automation → the rule that fires
on "Ready for Engineering" → toggle off.** It is a UI action; there is no reliable API for it.

---

## Waking it up

Work down the layers in reverse. **Do not skip step 0.**

### 0 · Decide the budget first

The factory has no internal cap. It will spend whatever the tickets it is given require, and a
ticket that is hard to reason about costs more than one that is merely long — see
`MODEL-CHOICE.md`. Before re-arming anything, decide the ceiling and set it where it is actually
enforced: an Anthropic spend limit on the account, not a note in a document.

This was the one honest gap in the original build. Everything else has a guardrail; spend did not.

### 1 · Mint a fresh Anthropic token

```bash
claude setup-token
```

Run it on a machine that is already signed in. It prints a token; do not save it to a file, do not
paste it into a chat, and do not commit it. Pipe it straight into the secret:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

That prompts for the value and reads it without echoing. Confirm with `gh secret list` — which
shows names and dates, never values.

**Mint a new one rather than reusing the old.** The old token's history is unknown: it lived in a
CI secret store and in a local file for the duration of a public demonstration.

### 2 · Check the other secrets are still valid

They were left in place, but Atlassian API tokens expire and Netlify tokens can be revoked.

```bash
gh secret list
```

Expected: `JIRA_API_TOKEN`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `NETLIFY_AUTH_TOKEN`,
`NETLIFY_SITE_ID`, `PM_ACCOUNT_ID`. If any are missing or stale, `SETUP.md` says where each comes
from and what it is for.

The local copies used by the scripts on a developer machine live in `~/.config/factory/` — see
`SETUP.md`. They are gitignored by the `*token*.txt` rule and are not in the repository.

### 3 · Re-enable the workflows

```bash
gh workflow enable "Factory Build" && gh workflow enable "Factory Deploy"
```

### 4 · Confirm the model, and that it is the one you meant

```bash
gh variable list
```

`FACTORY_MODEL` should be `claude-opus-5` unless you are deliberately experimenting. An unset or
misspelled variable falls back silently, and a fallback run looks exactly like an intended one —
which is why the workflow echoes the resolved model into its log. Read that line on the first run.

### 5 · Re-arm and test the Jira rule

If it was disabled, re-enable it: **Project settings → Automation**.

Then prove the whole chain end to end before trusting it, because the Jira rule is the flakiest
link and the only one that fails invisibly:

```bash
./scripts/reset-demo.sh --yes
```

Move the seeded cold-open ticket to **Ready for Engineering** and watch a run appear under
**Actions**. If nothing appears within ~30 seconds, the Jira rule is the suspect; the break-glass
is **Actions → Factory Build → Run workflow → issue key**, which skips only the Jira leg.

### 6 · Re-record the baseline

Anything you commit that you want to survive a reset needs this, or `reset-demo.sh` will offer to
throw it away:

```bash
./scripts/set-baseline.sh
```

---

## What the session left on the board

Left in place deliberately — it is the record of what happened, and none of it costs anything.

| | |
|---|---|
| `LLD-61` | The cold-open ticket, built and in review |
| `LLD-62` | The deliberately vague ticket, declined and then rewritten with the room |
| `LLD-65`–`LLD-70` | Audience tickets. Three of the four that were dispatched cleared the Definition of Ready and built |
| 4 open PRs, 4 `feat/*` branches | Never merged. `main` never moved, so the live site is exactly what was presented |

`./scripts/reset-demo.sh` (dry run first) clears all of it and re-seeds the demo tickets whenever
you want a clean board. It deletes everything not labelled `baseline`, so anything worth keeping
should be labelled or exported first.

---

## If you are decommissioning rather than hibernating

Hibernating keeps the tokens. If the demonstrator is finished for good, revoke rather than merely
delete — a deleted secret is removed from the repository, but **the credential itself remains
valid** until it is revoked at the place that issued it.

- **Anthropic** — revoke the token in the Claude account that minted it
- **Atlassian** — revoke the API token at `id.atlassian.com` → Security → API tokens
- **Netlify** — revoke the personal access token in User settings → Applications
- **Locally** — `rm ~/.config/factory/*token*.txt` on any machine that ran the scripts

Then delete the remaining repository secrets:

```bash
for s in JIRA_API_TOKEN JIRA_BASE_URL JIRA_EMAIL NETLIFY_AUTH_TOKEN NETLIFY_SITE_ID PM_ACCOUNT_ID; do gh secret delete "$s"; done
```

The repository, the site, the PRD and the deck can all stay up afterwards. They are static, they
cost nothing, and they are the useful part of the artifact.
