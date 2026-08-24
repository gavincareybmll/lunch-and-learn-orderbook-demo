// Tests for LLD-6's last acceptance criterion - that the page is live - and for the
// constraint behind it (NFR-4).
//
// The criterion is about a running page, which cannot be opened here. What can be tested is
// the thing that makes it true: the wiring applies flow on a wall clock, and the ladder read
// from the book after a few seconds of it differs from the one read at the start. So app.js
// is required to keep its loop's arithmetic in pure exported functions, and to start the
// browser loop only when there is a document to draw into - importing it under the test
// runner must not need a DOM.
//
// This fixes the app surface:
//
//   FLOW                        -> { seed, eventsPerSecond, warmupEvents, maxBurstEvents, ladderLevels }
//   createSimulation(seed?)     -> state, a book with flow already applied to it
//   advance(state, elapsedMs)   -> number of events applied for that much wall time
//   ladderDepth(state)          -> { bids, asks } for the ladder

import test from 'node:test';
import assert from 'node:assert/strict';

import { FLOW, createSimulation, advance, ladderDepth } from '../public/src/app.js';
import { ladderRows } from '../public/src/render.js';

const ladder = (state) => JSON.stringify(ladderRows(ladderDepth(state)));

test('Given the page is loaded, when it has been open for a few seconds, then the ladder has visibly changed at least once because flow is being applied', () => {
  const state = createSimulation();
  const before = ladder(state);

  const applied = advance(state, 3000);

  assert.ok(applied > 0, `expected flow to be applied over three seconds, got ${applied} events`);
  assert.notEqual(ladder(state), before);
});

test('Given the page is loaded, when the ladder is first drawn, then it already shows levels on both sides', () => {
  const { bids, asks } = ladderDepth(createSimulation());

  assert.ok(bids.length > 0, 'the ladder opens with bids on it');
  assert.ok(asks.length > 0, 'the ladder opens with asks on it');
  assert.ok(bids.length <= FLOW.ladderLevels);
  assert.ok(asks.length <= FLOW.ladderLevels);
});

test('Given the same seed, when the page is loaded twice, then the same flow is applied both times (REQ-5)', () => {
  const a = createSimulation(4242);
  const b = createSimulation(4242);
  advance(a, 1000);
  advance(b, 1000);

  assert.equal(ladder(a), ladder(b));
});

// --- NFR-4: a slow frame delays the display, never the book -----------------------------

test('Given a slow frame, when flow is advanced, then the book has kept up with the wall clock rather than with the frame rate', () => {
  const smooth = createSimulation(7);
  let smoothTotal = 0;
  for (let i = 0; i < 50; i += 1) smoothTotal += advance(smooth, 20); // 50 frames, one second

  const stuttering = createSimulation(7);
  const stutterTotal = advance(stuttering, 1000); // the same second in a single slow frame

  assert.equal(smoothTotal, FLOW.eventsPerSecond);
  assert.equal(stutterTotal, smoothTotal);
  // Same events applied, so the same book underneath: only the display was delayed.
  assert.equal(ladder(stuttering), ladder(smooth));
});

test('Given a very long gap between frames, when flow is advanced, then the catch-up is bounded rather than replaying the whole gap at once', () => {
  const state = createSimulation();

  const applied = advance(state, 10 * 60 * 1000);

  assert.ok(applied > 0);
  assert.ok(
    applied <= FLOW.maxBurstEvents,
    `expected at most ${FLOW.maxBurstEvents} events in one frame, got ${applied}`,
  );
});

test('Given no time has passed, when flow is advanced, then no events are applied', () => {
  const state = createSimulation();
  const before = ladder(state);

  assert.equal(advance(state, 0), 0);
  assert.equal(ladder(state), before);
});
