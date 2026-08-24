A human has reviewed **{{ISSUE_KEY}}** and moved it to "Ready for Deployment". Your job is to
ship it.

This is the one place in the factory where a human gate has already been passed. Respect it —
but do not treat it as permission to skip your own checks. The reviewer approved *the change*;
you are responsible for confirming it is *safe to merge*.

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
