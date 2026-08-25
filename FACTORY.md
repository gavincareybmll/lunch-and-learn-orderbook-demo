# How this factory works

A Jira ticket becomes a tested, reviewed, deployed change with no human writing code.

This document is for anyone wanting to copy or adapt the setup. It covers what each piece does,
**why it is that way**, and what we got wrong on the way — because the mistakes are more useful
than the finished state.

---

## The flow

```
Jira: "Ready for Engineering"
  → Jira Automation "Send web request" → POST /repos/OWNER/REPO/dispatches
  → factory-build.yml (repository_dispatch)
      → agent reads CLAUDE.md, the PRD, and the ticket
      → judges it against the Definition of Ready
          ├─ not ready → "Needs Info" + a comment saying exactly what is missing → stop
          └─ ready     → tests first, then code, then a PR and a preview URL
      → "In Review"

A HUMAN reviews the preview and decides.

Jira: "Ready for Deployment"
  → factory-deploy.yml (repository_dispatch)
      → depending on the ticket's labels, one of three things
```

### Three deployment modes, chosen by label

| Label | What happens |
|---|---|
| *(none)* | Ship this one ticket: check CI, merge, deploy, verify live, close it |
| `hold-for-release` | **Approved but not shipped.** Acknowledge, leave it in "Ready for Deployment", stop |
| `release` | **Batch release.** Sweep everything waiting, integrate, test, one production deploy |

The agent branches on the label, so all three modes work through **one** Jira rule, one status and
one workflow. Adding a mode means editing a prompt, not reconfiguring Jira.

`hold-for-release` exists because approved is not the same as shipped. Without it, a ticket has no
way to *wait*, and a release train cannot form.

---

## Design decisions, and why

### The prompt lives outside the workflow

`repository_dispatch` only fires workflow files on the **default branch**, so every workflow edit
costs a merge to `main`. The agent's instructions live in `.factory/*-prompt.md` and are read at
runtime, so the file you actually iterate on is not the one with the slow feedback loop.

### Tests are committed before the implementation, as their own commit

The risk in agentic development is **self-validation**: an agent that writes the code and then the
tests produces tests that confirm the code does what it already does. A misunderstanding gets
encoded twice and the suite goes green.

The defence is temporal — write the tests from the ticket before the implementation exists — but a
claim to have done so is not evidence. So the agent commits the tests alone and pushes. CI runs and
**goes red**. The implementation lands as a second commit and CI goes green.

The commit list is the proof. This is why `ci.yml` triggers on `feat/**` pushes, not only on
pull requests: a PR-level check would only ever show the final state.

Be honest about the limit: this is temporal and spec-derived separation, **not** agent separation.
The same agent still writes both in one context. Real independence needs a separate critic.

### Invariants, not just examples

Acceptance criteria check one case each. Invariants must hold for *every* input, and are checked
against randomised flow after every operation. They are what catches the defect nobody thought to
write a test for.

They also give you a fifteen-second demonstration that your tests mean something: break the code
on purpose and watch them fail.

### A batch release tests the combination before touching `main`

Each PR passed on its own. That does not mean they work together, and integration is where real
releases break. The agent builds an **integration branch**, merges each ticket into it, runs the
full suite after *every* merge, and only touches `main` once the whole set is green.

A ticket that conflicts or breaks the combination is dropped from the train and reported. A partial
release is a good outcome; shipping something broken is not.

This is not theoretical — it happened on our first release. Two tickets, both green alone,
conflicting with each other. One shipped, one held with a precise explanation, `main` never at risk.

### The preview URL is keyed on the ticket, and chosen rather than guessed

`netlify deploy --alias "$ISSUE_KEY"` gives `https://lld-12--site.netlify.app`. Because *we* choose
it, the URL the agent posts to Jira is correct by construction — there is nothing to guess and no
dead link. The agent also knows it before the PR exists, since the issue key arrives in the
dispatch payload.

### `github_token` is deliberately not passed to the action

Commits made with the default `GITHUB_TOKEN` do not trigger workflows. Pass it and the agent's
pushes produce no CI runs, so the PR shows zero checks — destroying the red-then-green evidence
above. Let the action authenticate as the Claude GitHub App instead.

### The model is pinned

Left unset, the action uses whatever the current default is — which can change between a rehearsal
and the day, altering behaviour and run time with no visible cause.

### Every run ends with the ticket transitioned and commented

A silent run is a failed run. The workflow has a failure step that moves the ticket to "Needs Info"
with a link to the run log, so a broken run never leaves a ticket stuck in "In Progress" with no
explanation.

---

## Guardrails

- The agent commits only to `feat/<ISSUE-KEY>`, never to `main`
- The deploy agent refuses to merge anything whose CI is not green
- The issue key is regex-validated before it reaches a shell or a URL
- Concurrency is keyed on the **issue**, so two tickets can run at once without cancelling
  each other
- Secrets live in GitHub Actions secrets; nothing is committed, and `*token*.txt` is gitignored

The human gate is the Jira transition to "Ready for Deployment". Note honestly what this means:
there is **no required-reviewer branch protection on `main`**, because the merge agent would be
blocked by it. The gate is real, it just lives in Jira rather than GitHub.

---

## What we got wrong

- **`--max-turns` too low.** Turn counts climb as the codebase grows — 21 on the first ticket, 61
  on the eighth. The cap bit twice and cost two runs. Set it generously; headroom is free when
  unused.
- **Netlify's Git integration never worked**, and failed in a way that *looked* configured.
  Deploying from CI with the Netlify CLI turned out better anyway.
- **Assumed the wrong resource was scarce.** We reasoned carefully about build minutes, which we
  never consume, and missed that the plan is credit-based: production deploys cost credits,
  previews are free. A billing alert caught it, not us. We then made the same mistake a second
  time in the other direction — the reset script's rollback was commented as free, when the
  evidence says a restore republishes the site and bills like a deploy. Both errors were confident
  reasoning about a billing model we had never actually read.
- **A retried release overstated what it had done**, describing work an earlier attempt had
  completed. The outcome was right but the record was not, and the record is what people check
  when they stop trusting the system.

---

## Adapting this

The parts that are specific to us and will need changing: the Jira project key and statuses, the
Netlify site, the `PM_ACCOUNT_ID` used for mentions, and `CLAUDE.md`.

The parts worth keeping: tests-before-code as a separate commit, the integration branch before
`main`, the label-driven deployment modes, reporting cost and tokens back to the ticket, and the
rule that every run ends with the ticket transitioned and commented.

The single most important part is none of the above. It is that **the specification is good
enough to build from.** Everything here is machinery around that; the machinery is the easy half.
