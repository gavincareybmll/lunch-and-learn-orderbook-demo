// Tests for LLD-68 - cumulative traded volume and VWAP in the readout, extending REQ-10.
// Written first from the ticket's acceptance criteria and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched back to a line
// in the ticket.
//
// The readout so far says what the price is now; these two figures say what has happened.
// That difference is where the defects live: a running total has to accumulate rather than be
// recomputed from a bounded tape, it has to survive a pause, and before anything has traded it
// has no answer at all - 0/0 is NaN, and a zero in that slot is a lie rather than an absence.
// So the arithmetic is required here as pure exported functions of render.js, and the wiring
// that keeps the total running is required of app.js. Placement and size are checked against
// the markup and the stylesheet, as the mid's prominence already is.
//
// The surface these tests fix:
//
//   EMPTY_SESSION                  -> Session, nothing traded yet
//   recordSession(session, trades) -> Session, the running totals with those trades added
//   sessionTotals(session)         -> { volume, vwap }, numbers or null
//   formatReadout(model)           -> { ..., volume, vwap }, all strings
//   sessionTraded(state)           -> { volume, vwap } for the running simulation (app.js)
//
// `volume` and `vwap` are null - unavailable - until something has traded, exactly as `mid`
// and `spread` are null while a side is empty.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBook, addLimitOrder, submitMarketOrder } from '../public/src/engine.js';
import {
  EMPTY_SESSION,
  recordSession,
  sessionTotals,
  formatReadout,
} from '../public/src/render.js';
import {
  createSimulation,
  advance,
  setPaused,
  sessionTraded,
} from '../public/src/app.js';
import { runRandomFlow } from './support/random-flow.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// A trade as the engine returns it; only price and size matter to a volume-weighted average.
const trade = (size, price) => ({
  price,
  size,
  ts: 0,
  aggressorSide: 'bid',
  makerOrderId: 'm',
  takerOrderId: 't',
});

// Unavailable is said in words, as the rest of the readout says it: no digit that could be
// read as a figure, and enough English that it reads as an absence rather than a dash (NFR-3).
function assertSaysSoInWords(text, what) {
  assert.equal(typeof text, 'string', `${what} is a string`);
  assert.ok(!/\d/.test(text), `${what} shows no number, got ${JSON.stringify(text)}`);
  assert.ok(text.trim() !== '-', `${what} is not a bare dash`);
  assert.ok(
    text.trim().split(/\s+/).filter((word) => /[a-z]/i.test(word)).length >= 2,
    `${what} says so in words, got ${JSON.stringify(text)}`,
  );
}

// The readout as it appears in the markup - the section the loop writes every slot into.
function readoutMarkup() {
  const start = INDEX.indexOf('<section class="readout"');
  assert.ok(start >= 0, 'the page has a readout section');
  const end = INDEX.indexOf('</section>', start);
  return INDEX.slice(start, end);
}

// The opening tag of one readout slot, so what it is marked with can be read off it.
function slotTag(field, markup = readoutMarkup()) {
  const tag = new RegExp(`<[^>]*data-readout="${field}"[^>]*>`).exec(markup);
  assert.ok(tag, `the readout has a slot for ${field}`);
  return tag[0];
}

const classesOf = (tag) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);

// Every font-size in the page's stylesheet, with the selector it belongs to, compared at the
// top of its clamp in rem - the unit every one of them states its maximum in.
function typeSizes() {
  const style = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));
  const sized = [];
  for (const chunk of style.split('}')) {
    const [selector, ...declarations] = chunk.split('{');
    const rule = /font-size:([^;]+);/.exec(declarations.join('{'));
    if (!rule) continue;
    const rem = [...rule[1].matchAll(/([\d.]+)rem/g)].map((match) => Number(match[1]));
    if (rem.length > 0) sized.push({ selector: selector.trim(), size: Math.max(...rem) });
  }
  return sized;
}

// --- acceptance criteria ---------------------------------------------------------------

test('Given trades of size 10 at 100 and 20 at 103, when cumulative volume is computed, then it is 30', () => {
  const session = recordSession(EMPTY_SESSION, [trade(10, 100), trade(20, 103)]);

  assert.equal(sessionTotals(session).volume, 30);

  // The same two trades arriving as two separate events rather than one, which is how the
  // flow actually delivers them: the total is cumulative, not per-event.
  const stepwise = recordSession(recordSession(EMPTY_SESSION, [trade(10, 100)]), [trade(20, 103)]);
  assert.equal(sessionTotals(stepwise).volume, 30);

  // ...and that is the figure put on the page.
  assert.equal(formatReadout(sessionTotals(session)).volume, '30');
});

test('Given trades of size 10 at 100 and 20 at 103, when VWAP is computed, then it is 102.0 - (10x100 + 20x103) / 30', () => {
  const session = recordSession(EMPTY_SESSION, [trade(10, 100), trade(20, 103)]);
  const { volume, vwap } = sessionTotals(session);

  assert.equal(vwap, 102);
  assert.equal(vwap, (10 * 100 + 20 * 103) / volume);

  // Weighted by size, so it is not the average of the two prices - which would be 101.5.
  assert.notEqual(vwap, (100 + 103) / 2);

  assert.equal(formatReadout(sessionTotals(session)).vwap, '102.00');
});

test('Given no trades have occurred yet, when cumulative volume and VWAP are computed, then both are reported as unavailable rather than as zero or NaN', () => {
  const untouched = [
    sessionTotals(EMPTY_SESSION),
    // An event that traded nothing leaves it exactly as it was.
    sessionTotals(recordSession(EMPTY_SESSION, [])),
    sessionTotals(recordSession(EMPTY_SESSION, undefined)),
  ];

  for (const totals of untouched) {
    assert.equal(totals.volume, null, 'no volume before anything has traded');
    assert.equal(totals.vwap, null, 'no average price before anything has traded');
    assert.ok(!Number.isNaN(totals.volume), 'unavailable is null, never NaN');
    assert.ok(!Number.isNaN(totals.vwap), 'unavailable is null, never NaN');

    // Not zero, and not a dash: the readout says so, as it does for an absent mid (NFR-3).
    const text = formatReadout(totals);
    assertSaysSoInWords(text.volume, 'the traded volume');
    assertSaysSoInWords(text.vwap, 'the volume-weighted average price');
  }
});

test('Given the simulation is paused, when the readout is inspected, then cumulative volume and VWAP hold their last value rather than resetting', () => {
  const state = createSimulation();
  advance(state, 2000);

  const held = sessionTraded(state);
  assert.ok(Number.isFinite(held.volume) && held.volume > 0, 'something has traded by now');
  assert.ok(Number.isFinite(held.vwap) && held.vwap > 0, 'and so there is an average price');

  assert.equal(setPaused(state, true), true);
  for (let i = 0; i < 300; i += 1) advance(state, 16); // five seconds of frames, held still

  assert.deepEqual(sessionTraded(state), held, 'the totals are held, not reset and not zeroed');

  // ...and resuming carries on from that total rather than starting again.
  setPaused(state, false);
  advance(state, 2000);
  const after = sessionTraded(state);
  assert.ok(
    after.volume > held.volume,
    `expected the total to carry on past ${held.volume}, got ${after.volume}`,
  );
});

test('Given the readout, when it is viewed, then cumulative volume and VWAP appear beside the existing mid/spread figures and are clearly labelled', () => {
  const markup = readoutMarkup();

  // Beside: in the same readout, alongside the slots that were already there.
  for (const field of ['bid', 'ask', 'mid', 'spread', 'volume', 'vwap']) slotTag(field, markup);

  assert.match(markup, /Volume/, 'the traded volume is labelled Volume');
  assert.match(markup, /VWAP/, 'the average price is labelled VWAP');

  // The loop has to write a figure into both new slots, not leave them at their placeholder.
  const state = createSimulation();
  const text = formatReadout(sessionTraded(state));
  assert.ok(/\d/.test(text.volume), `expected a figure for volume, got ${text.volume}`);
  assert.ok(/\d/.test(text.vwap), `expected a figure for VWAP, got ${text.vwap}`);
});

// --- visual expectation: neither may compete with the mid price -------------------------

test('Given the page at rest, when it is viewed, then the mid price is still the most prominent number on screen and the two new figures are small ones beside it', () => {
  const sized = typeSizes();
  assert.ok(sized.length > 1, 'the stylesheet sets type sizes');

  const largest = sized.reduce((a, b) => (b.size > a.size ? b : a));
  assert.match(
    largest.selector,
    /\.quote\.mid/,
    `the largest type on the page belongs to the mid price, not to ${largest.selector}`,
  );

  // Whatever the new figures are marked with, it is not the class that sets the big prices,
  // and every rule that sizes them is set well under the mid.
  for (const field of ['volume', 'vwap']) {
    const classes = classesOf(slotTag(field));
    assert.ok(
      !classes.includes('quote-price'),
      `the ${field} figure is not set at the size of a top-of-book price`,
    );

    for (const entry of sized.filter((e) => classes.some((c) => e.selector.includes(`.${c}`)))) {
      assert.ok(
        entry.size < largest.size / 2,
        `${entry.selector} is set at ${entry.size}rem against the mid at ${largest.size}rem`,
      );
    }
  }

  // The mid itself is untouched: still the big number, still in the readout.
  assert.ok(classesOf(slotTag('mid')).includes('quote-price'));
});

// --- the arithmetic, over more than the one worked example -------------------------------

test('Given trades at one price, when VWAP is computed, then it is that price whatever the sizes', () => {
  const session = recordSession(EMPTY_SESSION, [trade(3, 99.5), trade(140, 99.5), trade(7, 99.5)]);
  const { volume, vwap } = sessionTotals(session);

  assert.equal(volume, 150);
  assert.ok(Math.abs(vwap - 99.5) < 1e-9, `expected 99.5, got ${vwap}`);
});

test('Given a large trade away from the rest, when VWAP is computed, then it is pulled towards the price that traded the most size', () => {
  const session = recordSession(EMPTY_SESSION, [trade(1, 100), trade(999, 110)]);
  const { vwap } = sessionTotals(session);

  assert.ok(vwap > 109.9, `size weighting should dominate, got ${vwap}`);
  assert.ok(vwap < 110, 'but the small trade still counts for something');
});

test('Given trades produced by the engine, when they are recorded, then the totals are of what actually executed', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 102, size: 60 });

  // Takes all 40 at 101 and 20 of the 60 at 102: 60 traded, for 40x101 + 20x102 = 6080.
  const trades = submitMarketOrder(book, { id: 't1', side: 'bid', size: 60 });
  const { volume, vwap } = sessionTotals(recordSession(EMPTY_SESSION, trades));

  assert.equal(volume, 60);
  assert.equal(trades.length, 2, 'two resting orders were taken, so two trades');
  assert.ok(Math.abs(vwap - 6080 / 60) < 1e-9, `expected ${6080 / 60}, got ${vwap}`);
  assert.ok(vwap > 101 && vwap < 102, 'mostly filled at 101, topped up at 102');
});

test('Given randomised flow, when the totals are kept as it runs, then volume only ever grows and VWAP stays within the prices that traded', () => {
  for (const seed of [1, 20260826, 987654]) {
    const { trades } = runRandomFlow(seed, { operations: 400 });

    let session = EMPTY_SESSION;
    let expectedVolume = 0;
    let expectedNotional = 0;
    let low = Infinity;
    let high = -Infinity;
    let previousVolume = 0;

    for (const [index, batch] of trades.entries()) {
      session = recordSession(session, batch);
      for (const executed of batch) {
        expectedVolume += executed.size;
        expectedNotional += executed.size * executed.price;
        low = Math.min(low, executed.price);
        high = Math.max(high, executed.price);
      }

      const { volume, vwap } = sessionTotals(session);
      if (expectedVolume === 0) {
        assert.equal(volume, null, `seed ${seed}, event ${index}: nothing has traded yet`);
        assert.equal(vwap, null, `seed ${seed}, event ${index}: nothing has traded yet`);
        continue;
      }

      assert.equal(volume, expectedVolume, `seed ${seed}, event ${index}: cumulative volume`);
      assert.ok(volume >= previousVolume, `seed ${seed}, event ${index}: volume never falls`);
      previousVolume = volume;

      assert.ok(
        Math.abs(vwap - expectedNotional / expectedVolume) < 1e-6,
        `seed ${seed}, event ${index}: expected ${expectedNotional / expectedVolume}, got ${vwap}`,
      );
      assert.ok(
        vwap >= low - 1e-9 && vwap <= high + 1e-9,
        `seed ${seed}, event ${index}: VWAP ${vwap} outside the traded range ${low}..${high}`,
      );
    }

    assert.ok(expectedVolume > 0, `seed ${seed}: the flow traded something`);
  }
});

// --- wiring: the totals are fed from the running simulation -------------------------------

test('Given the page is loaded, when the readout is first drawn, then it already shows what has traded', () => {
  const totals = sessionTraded(createSimulation());

  assert.ok(Number.isFinite(totals.volume), 'the readout opens with a traded volume');
  assert.ok(totals.volume > 0);
  assert.ok(Number.isFinite(totals.vwap), 'the readout opens with a VWAP');
  assert.ok(totals.vwap > 0);
});

test('Given the page has been open for a few seconds, when the totals are watched, then volume has grown as trades printed', () => {
  const state = createSimulation();
  const opening = sessionTraded(state);

  let grown = false;
  for (let i = 0; i < 20 && !grown; i += 1) {
    advance(state, 500);
    grown = sessionTraded(state).volume > opening.volume;
  }

  assert.ok(grown, 'the total follows the flow rather than holding its first value');
});

test('Given the same seed, when the page is loaded twice, then the same totals are reported both times (REQ-5)', () => {
  const a = createSimulation(4242);
  const b = createSimulation(4242);
  advance(a, 1000);
  advance(b, 1000);

  assert.deepEqual(sessionTraded(a), sessionTraded(b));
});

test('Given an event that traded nothing, when it is recorded, then the running totals are unchanged', () => {
  const session = recordSession(EMPTY_SESSION, [trade(10, 100)]);
  const before = sessionTotals(session);

  assert.deepEqual(sessionTotals(recordSession(session, [])), before);
  assert.deepEqual(sessionTotals(recordSession(session, undefined)), before);
});

test('Given the totals are formatted, then volume reads as a count and VWAP reads as a price', () => {
  const text = formatReadout({ volume: 12345, vwap: 99.5 });

  assert.equal(text.volume, '12,345', 'a volume is a whole count, grouped as the ladder groups it');
  assert.equal(text.vwap, '99.50', 'a VWAP is a price, to the same two decimals as every other');
  assert.ok(!text.volume.includes('.'), 'a volume is not quoted to a fraction of a share');
});
