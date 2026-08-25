// Wiring: the book, the flow generator, the animation loop, and the canvas they are drawn
// into. No matching logic and no drawing lives here.
//
// Flow is paced by the wall clock rather than by frames (NFR-4): each frame applies however
// many events the elapsed time is owed, so a frame that takes too long delays the picture on
// screen and never the book underneath. The arithmetic that does it is exported and pure,
// because a loop that quietly stops advancing looks exactly like a quiet market.
//
// Pausing is a property of that loop rather than of the book (REQ-12), and the whole of it is
// one rule: wall time that passes while paused never reaches the clock. Banking it instead -
// the obvious way to write this - leaves the loop owing the length of the pause the moment it
// resumes, and it pays it back as a single burst of events that on a projector is
// indistinguishable from a crash.
//
// The browser loop starts only when there is a document to draw into, so that importing this
// module under the test runner needs no DOM (NFR-2).

import { createBook, depth, bestBid, bestAsk, queueAt } from './engine.js';
import { createSim, step } from './sim.js';
import {
  drawChart,
  drawLadder,
  drawPlayback,
  drawQueues,
  drawReadout,
  drawTape,
  playbackControl,
  recordMid,
  recordTrades,
  topOfBook,
  CHART_LIMIT,
  CHART_WINDOW_MS,
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

  // The chart, and why these three numbers: 300 points taken every 200ms is exactly the minute
  // of price the plot covers, so the window fills and then rolls. A bound shorter than the
  // window would draw as a chart that never finishes filling; a longer one would remember
  // price nothing ever plots (REQ-11, NFR-4).
  chartPoints: CHART_LIMIT,
  chartSampleMs: 200,
  chartWindowMs: CHART_WINDOW_MS,
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
    // The mid prices the chart plots, and when the next one is due. The warmup fills part of
    // the window, so the page opens on a line with some history behind it rather than on an
    // empty plot (REQ-11).
    series: [],
    nextSampleMs: 0,
    // The page opens on a running market: a still one would have to be started before there
    // was anything to look at.
    paused: false,
  };

  for (let i = 0; i < FLOW.warmupEvents; i += 1) apply(state);
  return state;
}

// Apply one event, print whatever it traded to the tape, and take the mid for the chart if one
// is due. Both are stamped with the point in the flow at which they happened, at the rate the
// flow is paced: the simulation's own clock, which is the only clock there is here (NFR-1).
function apply(state) {
  const trades = step(state.sim, state.book);
  state.events += 1;
  const flowMs = (state.events * 1000) / FLOW.eventsPerSecond;

  sampleMid(state, flowMs);
  if (trades.length === 0) return;

  state.tape = recordTrades(state.tape, trades, { limit: FLOW.tapeEntries, timeMs: flowMs });
}

// Take the mid on a fixed cadence rather than on every event, so that a bounded series covers
// a stated span of time (REQ-11) and the same seed draws the same chart (REQ-5).
//
// Sampled on the first event past each boundary, with the next boundary read off the clock
// rather than counted from this one, so the cadence cannot drift over a long session. A mid
// that is unavailable - one side of the book empty - records nothing, which is what leaves a
// gap in the line rather than a price of zero in it.
function sampleMid(state, flowMs) {
  if (flowMs < state.nextSampleMs) return;
  state.nextSampleMs =
    Math.floor(flowMs / FLOW.chartSampleMs) * FLOW.chartSampleMs + FLOW.chartSampleMs;

  const { mid } = topOfBook(touchLevels(state));
  state.series = recordMid(state.series, mid, { limit: FLOW.chartPoints, timeMs: flowMs });
}

// --- playback (REQ-12) ------------------------------------------------------------------

export function isPaused(state) {
  return state?.paused === true;
}

// Stop or start the flow, and report the state it is now in - so a caller that toggles has
// the answer without asking a second question.
export function setPaused(state, paused) {
  state.paused = paused === true;
  return state.paused;
}

export function togglePaused(state) {
  return setPaused(state, !isPaused(state));
}

// Apply the events that `elapsedMs` of wall time is owed, and report how many were applied.
// The schedule is kept against the total elapsed time rather than accumulated per frame, so
// a run of short frames and one long one advance the book by exactly the same amount.
export function advance(state, elapsedMs) {
  // Paused: the elapsed time is dropped here, before it can reach the clock, so the flow
  // resumes owing exactly what it owed when it stopped rather than the length of the pause
  // as well (REQ-12). This one line is the whole of the catch-up bug the ticket warns about.
  if (isPaused(state)) return 0;

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

// The mid prices recorded so far, oldest first and bounded (REQ-11). The last of them is the
// right-hand end of the line, and the price the readout is showing.
export function midSeries(state) {
  return state.series ?? [];
}

// --- browser ----------------------------------------------------------------------------

function start() {
  const ladder = document.getElementById('ladder');
  const queues = document.getElementById('queues');
  const readout = document.getElementById('readout');
  const tape = document.getElementById('tape');
  const chart = document.getElementById('chart');
  const playback = document.getElementById('playback');
  if (!ladder) return;

  const state = createSimulation();
  let previous = null;
  let printed = null;
  // What the panels were last drawn at, so a pause can tell a still screen from a resized one.
  let measured = null;
  let held = false;

  const showControl = () => drawPlayback(playback, playbackControl(isPaused(state)));
  playback?.querySelector('[data-playback="toggle"]')?.addEventListener('click', () => {
    togglePaused(state);
    showControl();
  });
  showControl();

  const frame = (now) => {
    advance(state, previous === null ? 0 : now - previous);
    previous = now;

    // While paused nothing can have changed, so nothing is redrawn: the pause costs no work
    // beyond noticing that the window has been resized under it, which is the one thing that
    // alters what a still book should look like (NFR-4).
    const size = `${ladder.clientWidth}x${ladder.clientHeight}`;
    const still = held && isPaused(state) && size === measured;
    measured = size;
    held = isPaused(state);
    if (still) {
      requestAnimationFrame(frame);
      return;
    }

    drawLadder(ladder, ladderDepth(state), { maxLevels: FLOW.ladderLevels });
    if (queues) drawQueues(queues, touchQueues(state), { maxSegments: FLOW.queueSegments });
    if (readout) drawReadout(readout, topOfBook(touchLevels(state)));
    if (chart) drawChart(chart, midSeries(state), { windowMs: FLOW.chartWindowMs });

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
