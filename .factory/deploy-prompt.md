A human has reviewed **{{ISSUE_KEY}}** and moved it to "Ready for Deployment". Your job is to
ship it.

This is the one place in the factory where a human gate has already been passed. Respect it —
but do not treat it as permission to skip your own checks. The reviewer approved *the change*;
you are responsible for confirming it is *safe to merge*.

## Step 0 — Which kind of deployment is this?

Read the ticket first: `./scripts/jira.sh get {{ISSUE_KEY}}`

- **If it carries the label `release`**, this is a *batch release*. Follow "Release" below and
  ignore the single-ticket steps.
- **Otherwise** it is a single ticket. Follow "Single ticket" below.

---

# Single ticket

## Step 1 — Find and check the pull request

```
gh pr list --head feat/{{ISSUE_KEY}} --state open --json number,title,url,mergeable,headRefOid
```

Before merging, confirm all of the following:

1. **A single open PR exists** for `feat/{{ISSUE_KEY}}`. If there are none or several, stop.
2. **CI is green on the head commit**: `gh pr checks <number>`. A failing or still-running check
   means you do not merge.
3. **There are no merge conflicts** (`mergeable` is not `CONFLICTING`).

**If any check fails, do not merge.** Transition the ticket to "Needs Info" and comment saying
exactly which check failed and what would need to happen. A refusal to ship a broken change is a
correct outcome, not a failure.

## Step 2 — Merge

```
gh pr merge <number> --squash --delete-branch
```

## Step 3 — Deploy to production

```
git checkout main && git pull
netlify deploy --dir=public --no-build --prod --site "$NETLIFY_SITE_ID" --auth "$NETLIFY_AUTH_TOKEN"
```

Then **verify it is actually live** before you claim it is. Fetch
`https://bmll-orderbook-factory-demo.netlify.app` and confirm it returns 200. If the deploy
failed, say so — do not report a success you have not checked.

## Step 4 — Close the ticket

```
./scripts/jira.sh transition {{ISSUE_KEY}} "Done"
./scripts/jira.sh comment {{ISSUE_KEY}} "<your report>"
```

**Keep it short — under 100 words.** It must contain:
- one sentence saying what is now live
- the live URL
- what to look at to see the change

## Rules

- Never merge a PR whose checks are not green.
- Never force-push, never rewrite `main`'s history, never merge anything other than the PR for
  this ticket.
- If anything fails, transition to "Needs Info" and explain — with the run log link if relevant.

**Every run ends with the ticket transitioned and commented, whether you shipped it or not.**

---

# Release

A batch release ships every ticket that has been approved and is waiting. This is how software
is normally shipped: many reviewed changes go out together, and the risk that matters is not in
any one of them but in their *combination*.

## R1 — Find what is waiting

```
./scripts/jira.sh search 'project=LLD AND status="Ready for Deployment"'
```

Exclude this release ticket itself. For each remaining ticket, find its open PR:

```
gh pr list --head feat/<KEY> --state open --json number,url,mergeable,headRefOid
```

Skip, and note, any ticket that has no open PR. If nothing is waiting, comment saying so, move
this ticket to Done, and stop.

## R2 — Check each one individually

For every ticket in the release: CI green on the head commit (`gh pr checks <n>`), and no merge
conflict. **Drop any ticket that fails these checks from the release** — do not abandon the whole
release for one bad ticket. Record which you dropped and why; you will report it.

## R3 — Test the combination BEFORE touching main

Each PR passed on its own. That does not mean they work together — this is where real releases
break, and checking it is the entire point of batching deliberately rather than by accident.

```
git checkout main && git pull
git checkout -b integration-{{ISSUE_KEY}}
```

Merge each surviving branch into the integration branch in ticket order. After **each** merge,
run `node --test`.

- **On a merge conflict:** drop that ticket from the release, reset the integration branch to its
  previous state, and carry on with the rest.
- **On a test failure after a merge:** the ticket just merged is the one that broke the
  combination. Drop it the same way and carry on.

`main` is untouched throughout. Nothing has shipped yet.

## R4 — Ship

Only once the integration branch is green with every surviving ticket in it:

```
gh pr merge <n> --squash --delete-branch     # for each surviving ticket, in the same order
git checkout main && git pull
node --test                                   # main must be green before it goes anywhere
netlify deploy --dir=public --no-build --prod --site "$NETLIFY_SITE_ID" --auth "$NETLIFY_AUTH_TOKEN"
```

Delete the integration branch afterwards; it was scaffolding.

Then **verify production is actually live** — fetch `https://bmll-orderbook-factory-demo.netlify.app`
and confirm 200 before claiming success.

## R5 — Close the loop on every ticket

For **each** ticket that shipped:

```
./scripts/jira.sh transition <KEY> "Done"
./scripts/jira.sh comment <KEY> "<one or two sentences: shipped as part of release {{ISSUE_KEY}}, the live URL, what to look at>"
```

For each ticket **dropped**: leave it in "Ready for Deployment", and comment saying it was held
back from this release, why, and what needs to happen. Do not move it to Needs Info — it was
approved; it just did not make this train.

Finally, on this release ticket: comment a short manifest — what shipped, what was held back and
why, the live URL — then move it to Done. **Under 150 words.**

## Rules for a release

- **Never** merge anything to `main` until the integration branch is green with everything in it.
- One production deploy per release. That is the point.
- A partial release is a good outcome. Shipping four of five tickets and saying clearly why the
  fifth was held is better than shipping nothing, and far better than shipping something broken.
