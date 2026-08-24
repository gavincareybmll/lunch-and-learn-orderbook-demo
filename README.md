# Lunch & Learn Orderbook Demo

A demonstration of an agentic "software factory": a Jira ticket becomes a tested, reviewed,
deployed change with no human writing code.

**This is a demonstrator, not a product.** It is not affiliated with any BMLL product, and
every number it displays is synthetically generated in the browser. There is no market data
here — no licensed feed, no real venue, no real instrument.

## What it is

A synthetic Level 3 limit order book simulator: a depth-of-book ladder, a trade tape, and a
rolling price chart, all driven by a seeded pseudo-random order flow generator.

The specification it was built from is [`public/prd.html`](public/prd.html), served live at
`/prd.html`.

## How it was built

The scaffolding in this repository — the workflows, the agent prompts, the Jira toolkit — was
written by hand. **The application itself was written by the agent**, ticket by ticket, through
the pipeline described below. The Jira board's Done column is the record.

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

No dependencies, no build step. Node 20+ for the tests.

```bash
node --test
```

```bash
python3 -m http.server -d public 8000
```

## Layout

| Path | Purpose |
|---|---|
| `public/prd.html` | Product Requirements Document — the source spec |
| `public/src/engine.js` | Order book data structure and matching logic |
| `public/src/sim.js` | Synthetic order flow generator (seeded) |
| `public/src/render.js` | Canvas rendering |
| `public/` | Everything Netlify serves — the whole published surface |
| `test/` | Unit tests, run with `node --test` |
| `public/slides/` | Presentation material (hand-written, not factory-built) |
| `.factory/` | Agent prompts |
| `scripts/` | Jira toolkit and demo reset tooling |
