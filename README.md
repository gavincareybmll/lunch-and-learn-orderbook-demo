# Lunch & Learn Orderbook Demo

A demonstration of an agentic "software factory": a Jira ticket becomes a tested, reviewed,
deployed change with no human writing code.

**This is a demonstrator, not a product.** It is not affiliated with any BMLL product, and
every number it displays is synthetically generated in the browser. There is no market data
here — no licensed feed, no real venue, no real instrument.

## Status

Complete and live: **https://bmll-orderbook-factory-demo.netlify.app**

Every line of the application was written by an AI agent responding to a Jira ticket. Ten tickets,
114 tests, five modules, built from [`public/prd.html`](public/prd.html) — the specification came
first and the code follows from it, not the other way round.

The scaffolding — workflows, agent prompts, the Jira toolkit — was written by hand.
**How it works and why:** [`FACTORY.md`](FACTORY.md).
**How to build the same thing yourself, step by step:** [`SETUP.md`](SETUP.md).

## How it gets built

The scaffolding in this repository — the workflows, the agent prompts, the Jira toolkit — is
written by hand. **The application itself is written by the agent**, ticket by ticket, through
the pipeline below. The Jira board's Done column is the record.

```
Jira "Ready for Engineering"
  → repository_dispatch → factory-build.yml
  → agent assesses the ticket against the Definition of Ready
      → insufficient? transition to "Needs Info" and ask for specifics
      → sufficient?   implement, test, open a PR, report back to Jira
  → human reviews the Netlify deploy preview
  → Jira "Ready for Deployment" → agent merges → live
```

## Rehearsing and resetting

```bash
./scripts/reset-demo.sh            # dry run: shows what it would change
./scripts/reset-demo.sh --yes      # reset git, Jira and the deployment to the baseline
```

See [`SETUP.md`](SETUP.md) for the full rehearsal loop. **Commit before resetting** — it
hard-resets the working tree.

## Running locally

No dependencies and no build step, by design. Node 20+ for the tests.

```bash
node --test
```

```bash
python3 -m http.server -d public 8000
```

## Layout

| Path | Purpose |
|---|---|
| `public/` | Everything Netlify serves — the entire published surface |
| `public/prd.html` | Product Requirements Document — the source specification |
| `public/slides/` | Presentation material (hand-written, not factory-built) |
| `test/` | Unit tests, run with `node --test` |
| `.factory/` | Agent prompts — read at runtime, so they can be iterated without touching a workflow |
| `scripts/jira.sh` | Read, comment (with real @mentions), transition, search, label |
| `scripts/reset-demo.sh` | Reset git, Jira and the deployment to the baseline |
| `scripts/set-baseline.sh` | Record the state reset returns to |
| `scripts/seed-demo-tickets.sh` | Create the session's tickets |
| `scripts/run-telemetry.sh` | Post model, time, tokens and cost back to the ticket |
| `FACTORY.md` | How the factory works and why |
| `SETUP.md` | Step-by-step guide to standing up your own |

Application source lives under `public/src/`, with the module boundaries fixed by §6 of the PRD
rather than chosen during implementation — so each ticket extended a known structure instead of
inventing one.
