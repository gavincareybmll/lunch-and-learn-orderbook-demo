# Lunch & Learn Orderbook Demo

A demonstration of an agentic "software factory": a Jira ticket becomes a tested, reviewed,
deployed change with no human writing code.

**This is a demonstrator, not a product.** It is not affiliated with any BMLL product, and
every number it displays is synthetically generated in the browser. There is no market data
here — no licensed feed, no real venue, no real instrument.

## Status

Scaffolding only. The specification has not been written yet, and no application code exists.

Once `public/prd.html` is agreed, the application will be built from it — by the agent, one
ticket at a time. The structure of the code will follow from the specification, not precede it.

**How the factory itself works — and how to adapt it for your own project — is in
[`FACTORY.md`](FACTORY.md).**

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
| `.factory/` | Agent prompts |
| `scripts/` | Jira toolkit and demo reset tooling |

Application source will live under `public/src/`. Its module layout is deliberately left
undefined here — see the PRD.
