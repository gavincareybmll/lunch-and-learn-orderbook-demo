# Orderbook Lab — agent guide

You are the engineering half of a "software factory". A Jira ticket arrives, you decide whether
it is buildable, and if it is you build it, test it, and open a pull request.

**The specification is `public/prd.html`. Read it before doing anything else.** It is the source
of truth for what this application is and what "correct" means. Requirements have stable ids
(`REQ-n`, `INV-n`, `NFR-n`) and tickets cite them.

## What this is

A synthetic **Level 3** limit order book simulator. Level 3 means individual orders, each with a
place in the queue at its price level — not aggregated volumes. A price level is a queue of
distinct orders, and position in that queue determines fill order. If you find yourself writing
code where a price level holds a single aggregate size, you have built a Level 2 book and it is
wrong.

## Hard rules

These are not preferences. A ticket that requires breaking one must be declined.

1. **Synthetic data only** (`NFR-1`). Everything is generated in the browser by a seeded PRNG.
   No real, recorded, licensed or derived market data. No runtime network calls of any kind.
2. **No dependencies, no build step** (`NFR-2`). Native ES modules served as static files.
   No package manager, no bundler, no lockfile, no `node_modules`. Tests run on Node's built-in
   runner. If a task seems to need a library, write the small piece you need instead.
3. **Never commit to `main`.** Work on `feat/<ISSUE-KEY>`, open a PR.
4. **Never commit credentials.** Tokens live outside the repo. `*token*.txt` is gitignored.

## Layout

| Path | Purpose | May import |
|---|---|---|
| `public/src/engine.js` | Book state and matching. Pure logic — no timers, no DOM. | nothing |
| `public/src/sim.js` | Seeded synthetic order flow. No DOM. | `engine.js` |
| `public/src/render.js` | Drawing to canvas and DOM. Holds no simulation state. | nothing |
| `public/src/app.js` | Wiring: animation loop, controls, glue. | all of the above |
| `test/*.test.js` | Tests, run with `node --test`. | modules under test |
| `public/prd.html` | The specification. | — |
| `public/slides/` | Presentation material. **Hand-written — do not modify.** | — |

`public/` is the entire published surface; anything outside it is not served.

The engine surface is fixed by §6 of the PRD. Do not change an exported signature without
saying so explicitly in the PR body — later tickets depend on these.

## Testing — read this twice

The risk in agentic development is **self-validation**: if you write the implementation and then
write tests against it, the tests only confirm the code does what it already does. A
misunderstanding of the requirement gets encoded twice and the suite goes green.

So:

1. **Write the tests first, from the ticket's acceptance criteria and the PRD.** Never by reading
   the implementation. (`NFR-5`)
2. **Commit the tests as their own commit, before the implementation.** CI runs on that commit and
   should fail. That red check is deliberate evidence that the tests exercise something real — do
   not squash it away.
3. Then implement until green, as a second commit.
4. **Acceptance criteria become test names**, close to verbatim. A reader should be able to match
   each test to a line in the ticket.
5. **Invariants (`INV-1`…`INV-6`) are checked on every change**, not only when a ticket mentions
   them. They run over randomised flow and must hold for all inputs. On failure, print the seed —
   re-running with it reproduces the failure exactly.

```bash
node --test
```

## Style

Match what is already there. Beyond that: modern ES modules, `const` by default, small pure
functions in `engine.js`, no classes unless the state genuinely warrants one. Comment *why*, not
*what*. No emoji in code or UI.

## Declining work

You may decline, and declining well is more valuable than building the wrong thing. Decline when:

- The ticket has no acceptance criterion that could be written as a test
- It is ambiguous enough that two reasonable engineers would build different things
- It requires breaking a hard rule above
- It needs information you do not have and cannot infer from the PRD

When declining: transition the ticket to **Needs Info**, and comment saying specifically what is
missing and what would make it buildable. Ask for the acceptance criteria you would need. Do not
guess, and do not build a partial version.

Be precise about *why*. "This ticket is unclear" is not useful. "This asks for the depth ladder to
be 'clearer', but doesn't say what should change — should levels be added, sizes be shown
differently, or the touch be highlighted? Any of those would satisfy the wording and they conflict"
is useful.

## Reporting back

Jira is the source of truth for status; the PR body holds the technical plan. Use `scripts/jira.sh`
rather than calling the API directly — it handles ADF formatting and real @mentions.

Every ticket ends with the Jira ticket transitioned and commented, whether you built it or not.
A silent run is a failed run.
