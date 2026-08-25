// Tests for playback controls: REQ-12, and REQ-13 re-checked now that a control sits next to
// the readout. NFR-3 for the size of it.
//
// Written first from the acceptance criteria of LLD-11 and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched back to a line
// in the ticket.
//
// The control itself is a button on the page and is verified on the deploy preview. What can
// be wrong without a viewer noticing is the loop arithmetic behind it - in particular the
// catch-up burst on resume, which the ticket calls out as the standard bug in this feature -
// so pausing is required to be a property of the exported, DOM-free loop functions, and the
// words on the control a pure function of whether it is paused.
//
// The surface these tests fix:
//
//   isPaused(state)              -> boolean
//   setPaused(state, paused)     -> boolean, the state it is now in
//   togglePaused(state)          -> boolean, the state it is now in
//   advance(state, elapsedMs)    -> 0 while paused, and paused wall time is discarded
//   playbackControl(paused)      -> { paused, label, status }, all words, no numbers

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLOW,
  createSimulation,
  advance,
  isPaused,
  setPaused,
  togglePaused,
  ladderDepth,
  touchQueues,
  touchLevels,
  tradeTape,
} from '../public/src/app.js';
import * as app from '../public/src/app.js';
import { playbackControl, topOfBook, PAUSE_LABEL, RESUME_LABEL } from '../public/src/render.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// Everything the loop puts on screen, as one string: the ladder, the queue view, the readout
// and the tape. The chart is fed from the same event application (REQ-11, LLD-10) and is
// included here as soon as app.js exposes its series.
function display(state) {
  return JSON.stringify({
    ladder: ladderDepth(state),
    queues: touchQueues(state),
    readout: topOfBook(touchLevels(state)),
    tape: tradeTape(state),
    chart: typeof app.midSeries === 'function' ? app.midSeries(state) : null,
  });
}

// A frame's worth of wall time, at a rate the animation loop might plausibly run at.
const FRAME_MS = 16;

// --- acceptance criteria ---------------------------------------------------------------

test('Given a running simulation, when pause is activated, then no further events are applied to the book', () => {
  const state = createSimulation();
  advance(state, 2000);

  assert.equal(isPaused(state), false, 'the page opens running');
  assert.equal(setPaused(state, true), true);
  assert.equal(isPaused(state), true);

  const before = display(state);
  let applied = 0;
  for (let i = 0; i < 300; i += 1) applied += advance(state, FRAME_MS); // five seconds of frames

  assert.equal(applied, 0, 'no event is applied while paused');
  assert.equal(display(state), before, 'and so nothing on screen moved');
});

test('Given a paused simulation, when resume is activated, then events continue from the point at which it paused rather than restarting or skipping ahead', () => {
  const seed = 31415;

  // The same two seconds of wall time, run straight through.
  const straight = createSimulation(seed);
  let expected = 0;
  for (let i = 0; i < 20; i += 1) expected += advance(straight, 100);

  // ...and run with a pause in the middle of it.
  const interrupted = createSimulation(seed);
  let applied = 0;
  for (let i = 0; i < 10; i += 1) applied += advance(interrupted, 100);

  const atPause = display(interrupted);
  setPaused(interrupted, true);
  for (let i = 0; i < 30; i += 1) advance(interrupted, 100); // three seconds stopped
  assert.equal(display(interrupted), atPause, 'the book stayed where it was while paused');

  setPaused(interrupted, false);
  for (let i = 0; i < 10; i += 1) applied += advance(interrupted, 100);

  // Not restarted: the same flow carried on, so the two books are identical. Not skipped
  // ahead: the same number of events was applied, no more.
  assert.equal(applied, expected);
  assert.equal(display(interrupted), display(straight));
});

test('Given a paused simulation, when the page is left paused for a while and then resumed, then the number of events applied does not jump to catch up for the lost time', () => {
  const state = createSimulation();
  advance(state, 1000);

  setPaused(state, true);
  for (let i = 0; i < 100; i += 1) advance(state, 5000); // eight minutes stopped
  setPaused(state, false);

  // The first frame back is an ordinary frame, not a burst.
  const first = advance(state, FRAME_MS);
  const perFrame = Math.ceil((FLOW.eventsPerSecond * FRAME_MS) / 1000);
  assert.ok(
    first <= perFrame,
    `expected at most ${perFrame} events on the frame after resuming, got ${first}`,
  );

  // ...and the second after it is one second of flow, not eight minutes of it.
  let second = first;
  for (let i = 0; i < 62; i += 1) second += advance(state, FRAME_MS);
  assert.ok(second > 0, 'flow resumed');
  assert.ok(
    second <= FLOW.eventsPerSecond + 1,
    `expected about ${FLOW.eventsPerSecond} events in the second after resuming, got ${second}`,
  );
});

test('Given the simulation is paused, when the display is inspected, then the ladder, queues, tape and chart all still show their last state rather than clearing', () => {
  const state = createSimulation();
  advance(state, 4000);

  const ladder = ladderDepth(state);
  const queues = touchQueues(state);
  const tape = tradeTape(state);
  const readout = topOfBook(touchLevels(state));

  setPaused(state, true);
  for (let i = 0; i < 120; i += 1) advance(state, FRAME_MS);

  // Held, not cleared: the same levels, the same queue, the same trades, the same price.
  assert.deepEqual(ladderDepth(state), ladder);
  assert.deepEqual(touchQueues(state), queues);
  assert.deepEqual(tradeTape(state), tape);
  assert.deepEqual(topOfBook(touchLevels(state)), readout);

  assert.ok(ladder.bids.length > 0 && ladder.asks.length > 0, 'the ladder still has levels on it');
  assert.ok(queues.bid.orders.length > 0, 'the queue view still has orders in it');
  assert.ok(tape.length > 0, 'the tape still has trades on it');
  assert.ok(Number.isFinite(readout.mid), 'the readout still has a mid price');

  // The chart is fed by the same event application, so it holds too (REQ-11, LLD-10).
  if (typeof app.midSeries === 'function') {
    const series = app.midSeries(state);
    assert.ok(series.length > 0, 'the chart still has a line on it');
    for (let i = 0; i < 120; i += 1) advance(state, FRAME_MS);
    assert.deepEqual(app.midSeries(state), series);
  }
});

test('Given the control, when it is inspected, then it says what it will do next in words - Pause while running, Resume while paused', () => {
  assert.equal(playbackControl(false).label, 'Pause');
  assert.equal(playbackControl(true).label, 'Resume');
  assert.equal(PAUSE_LABEL, 'Pause');
  assert.equal(RESUME_LABEL, 'Resume');

  // Words rather than a bare icon, and no digit anywhere on it: nothing on the control can be
  // mistaken for a price (NFR-3).
  for (const paused of [false, true]) {
    const control = playbackControl(paused);
    assert.equal(control.paused, paused);
    for (const [field, text] of Object.entries({ label: control.label, status: control.status })) {
      assert.equal(typeof text, 'string', `the ${field} is text`);
      assert.ok(/[a-z]/i.test(text), `the ${field} is words, got ${JSON.stringify(text)}`);
      assert.ok(!/\d/.test(text), `the ${field} shows no number, got ${JSON.stringify(text)}`);
    }
  }

  // A still screen and a broken one look the same, so being paused is said as well as shown.
  assert.match(playbackControl(true).status, /paused/i);
  assert.ok(
    !/paused/i.test(playbackControl(false).status),
    'a running simulation does not say it is paused',
  );

  // ...and the page carries a real button with the slots those words are written into.
  assert.match(INDEX, /<button[^>]*data-playback="toggle"/, 'the control is a button');
  assert.match(INDEX, /data-playback="status"/, 'the paused indication has a slot');
  assert.match(INDEX, /id="playback"/, 'the loop has a control to wire itself to');
});

test('Given the page at rest, when it is viewed, then the current mid price is still the most prominent number on screen', () => {
  const style = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));

  // Largest type wins the eye, so read every font-size in the stylesheet with the selector it
  // belongs to. Sizes are compared at the top of their clamp, in rem - the unit every one of
  // them states its maximum in.
  const sized = [];
  for (const chunk of style.split('}')) {
    const [selector, ...declarations] = chunk.split('{');
    const body = declarations.join('{');
    const rule = /font-size:([^;]+);/.exec(body);
    if (!rule) continue;

    const rem = [...rule[1].matchAll(/([\d.]+)rem/g)].map((match) => Number(match[1]));
    if (rem.length > 0) sized.push({ selector: selector.trim(), size: Math.max(...rem) });
  }

  assert.ok(sized.length > 1, 'the stylesheet sets type sizes');
  const largest = sized.reduce((a, b) => (b.size > a.size ? b : a));
  assert.match(
    largest.selector,
    /\.quote\.mid/,
    `the largest type on the page belongs to the mid price, not to ${largest.selector}`,
  );

  // The control is added next to it, not over it: nothing new is set anywhere near that size.
  const control = sized.filter((entry) => /playback/.test(entry.selector));
  assert.ok(control.length > 0, 'the control sets its own type size');
  for (const entry of control) {
    assert.ok(
      entry.size < largest.size / 2,
      `${entry.selector} is set at ${entry.size}rem against the mid at ${largest.size}rem`,
    );
  }
});

// --- the control is a toggle, and the page opens running ---------------------------------

test('Given the control, when it is activated twice, then the simulation pauses and then runs again', () => {
  const state = createSimulation();
  assert.equal(isPaused(state), false);

  assert.equal(togglePaused(state), true);
  assert.equal(isPaused(state), true);
  assert.equal(advance(state, 1000), 0);

  assert.equal(togglePaused(state), false);
  assert.equal(isPaused(state), false);
  assert.ok(advance(state, 1000) > 0, 'flow runs again after resuming');
});
