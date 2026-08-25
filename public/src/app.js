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
import { drawLadder, drawQueues } from './render.js';

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
};

export function createSimulation(seed = FLOW.seed) {
  const state = { book: createBook(), sim: createSim(seed), clockMs: 0, scheduled: 0 };

  for (let i = 0; i < FLOW.warmupEvents; i += 1) step(state.sim, state.book);
  return state;
}

// Apply the events that `elapsedMs` of wall time is owed, and report how many were applied.
// The schedule is kept against the total elapsed time rather than accumulated per frame, so
// a run of short frames and one long one advance the book by exactly the same amount.
export function advance(state, elapsedMs) {
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) state.clockMs += elapsedMs;

  const due = Math.floor((state.clockMs * FLOW.eventsPerSecond) / 1000) - state.scheduled;
  if (due <= 0) return 0;

  const applied = Math.min(due, FLOW.maxBurstEvents);
  for (let i = 0; i < applied; i += 1) step(state.sim, state.book);

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

// --- browser ----------------------------------------------------------------------------

function start() {
  const ladder = document.getElementById('ladder');
  const queues = document.getElementById('queues');
  if (!ladder) return;

  const state = createSimulation();
  let previous = null;

  const frame = (now) => {
    advance(state, previous === null ? 0 : now - previous);
    previous = now;
    drawLadder(ladder, ladderDepth(state), { maxLevels: FLOW.ladderLevels });
    if (queues) drawQueues(queues, touchQueues(state), { maxSegments: FLOW.queueSegments });
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

if (typeof document !== 'undefined') start();
