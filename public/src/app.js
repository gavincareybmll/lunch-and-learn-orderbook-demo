// Wiring: the book, the flow generator, the animation loop, and the canvas they are drawn
// into. No matching logic and no drawing lives here.
//
// Flow is paced by the wall clock rather than by frames (NFR-4): each frame applies however
// many events the elapsed time is owed, so a frame that takes too long delays the picture on
// screen and never the book underneath. The arithmetic that does it is exported and pure,
// because a loop that quietly stops advancing looks exactly like a quiet market.
//
// The browser loop starts only when there is a document to draw into, so that importing this
// module under the test runner needs no DOM (NFR-2).

import { createBook, depth, bestBid, bestAsk, queueAt } from './engine.js';
import { createSim, step } from './sim.js';
import {
  drawLadder,
  drawQueues,
  drawReadout,
  drawTape,
  recordTrades,
  topOfBook,
  TAPE_LIMIT,
} from './render.js';

export const FLOW = {
  seed: 20260824,

  // Fast enough that the ladder is visibly alive, slow enough to follow a single level
  // changing from the back of a room (NFR-3).
  eventsPerSecond: 30,

  // The page opens on a book that has already been trading, rather than on two lonely
  // orders finding each other.
  warmupEvents: 400,

  // A hidden tab is not given animation frames, so the first frame back can be owed minutes
  // of flow. Beyond this the backlog is abandoned rather than replayed: catching up is not
  // worth a frozen page, and the book stays correct either way.
  maxBurstEvents: 300,

  // Deep enough to show the shape of the book, few enough that each row is a readable band
  // of the screen rather than a line in a spreadsheet (NFR-3).
  ladderLevels: 7,

  // Segments a queue bar is cut into. The touch routinely holds more orders than this, which
  // is the point: the rest are gathered into the last segment and counted there, so the bar
  // never pretends the tail is not behind it.
  queueSegments: 7,

  // Trades the tape keeps before the oldest falls off (NFR-4). The bound is render.js's own
  // default: it is the module that does the trimming, and one number is harder to disagree
  // with than two.
  tapeEntries: TAPE_LIMIT,
};

export function createSimulation(seed = FLOW.seed) {
  const state = {
    book: createBook(),
    sim: createSim(seed),
    clockMs: 0,
    scheduled: 0,
    // Every event ever applied, warmup included. The tape's clock is counted from this
    // rather than from the wall clock, so the same seed prints the same tape (REQ-5).
    events: 0,
    tape: [],
  };

  for (let i = 0; i < FLOW.warmupEvents; i += 1) apply(state);
  return state;
}

// Apply one event and print whatever it traded to the tape. A trade's time is the point in
// the flow at which it happened, at the rate the flow is paced: the simulation's own clock,
// which is the only clock there is here (NFR-1).
function apply(state) {
  const trades = step(state.sim, state.book);
  state.events += 1;
  if (trades.length === 0) return;

  state.tape = recordTrades(state.tape, trades, {
    limit: FLOW.tapeEntries,
    timeMs: (state.events * 1000) / FLOW.eventsPerSecond,
  });
}

// Apply the events that `elapsedMs` of wall time is owed, and report how many were applied.
// The schedule is kept against the total elapsed time rather than accumulated per frame, so
// a run of short frames and one long one advance the book by exactly the same amount.
export function advance(state, elapsedMs) {
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) state.clockMs += elapsedMs;

  const due = Math.floor((state.clockMs * FLOW.eventsPerSecond) / 1000) - state.scheduled;
  if (due <= 0) return 0;

  const applied = Math.min(due, FLOW.maxBurstEvents);
  for (let i = 0; i < applied; i += 1) apply(state);

  // The whole backlog counts as scheduled, including any part of it dropped: the clock is
  // not rewound to replay it on the next frame.
  state.scheduled += due;
  return applied;
}

export function ladderDepth(state) {
  return depth(state.book, FLOW.ladderLevels);
}

// The individual orders resting at the best bid and the best ask, in queue order (REQ-8).
// A side with nothing on it has no best price to read a queue at, and reads as an empty
// queue rather than as an error.
export function touchQueues(state) {
  const side = (best, name) => {
    const price = best ? best.price : null;
    return { price, orders: price === null ? [] : queueAt(state.book, name, price) };
  };

  return {
    bid: side(bestBid(state.book), 'bid'),
    ask: side(bestAsk(state.book), 'ask'),
  };
}

// The two touch levels the readout is computed from (REQ-10). A side with nothing resting on
// it is null, which is what makes mid and spread unavailable rather than zero.
export function touchLevels(state) {
  return { bid: bestBid(state.book), ask: bestAsk(state.book) };
}

// The trades printed so far, newest first and bounded (REQ-9).
export function tradeTape(state) {
  return state.tape ?? [];
}

// --- browser ----------------------------------------------------------------------------

function start() {
  const ladder = document.getElementById('ladder');
  const queues = document.getElementById('queues');
  const readout = document.getElementById('readout');
  const tape = document.getElementById('tape');
  if (!ladder) return;

  const state = createSimulation();
  let previous = null;
  let printed = null;

  const frame = (now) => {
    advance(state, previous === null ? 0 : now - previous);
    previous = now;
    drawLadder(ladder, ladderDepth(state), { maxLevels: FLOW.ladderLevels });
    if (queues) drawQueues(queues, touchQueues(state), { maxSegments: FLOW.queueSegments });
    if (readout) drawReadout(readout, topOfBook(touchLevels(state)));

    // The tape only changes when something traded, and recordTrades returns the same list
    // when nothing did - so identity is enough to skip rewriting the rows on the frames in
    // between (NFR-4).
    if (tape && state.tape !== printed) {
      drawTape(tape, state.tape);
      printed = state.tape;
    }
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') start();
