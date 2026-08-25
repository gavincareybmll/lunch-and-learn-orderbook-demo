// Tests for the top-of-book readout: REQ-10, REQ-13, NFR-3.
//
// Written first from the acceptance criteria of LLD-9 and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched back to a line
// in the ticket.
//
// The readout is text on the page, so what can be wrong without a viewer noticing is the
// arithmetic and the wording: mid, spread, and what is said when there is no mid to say. Both
// are required here as pure exported functions of render.js. The placement and the type size -
// that the mid is the number a viewer's eye lands on first - are verified on the preview.
//
// The surface these tests fix:
//
//   topOfBook({ bid, ask })   -> { bid, ask, mid, spread }, prices or null
//   formatReadout(model)      -> { bid, ask, mid, spread }, all strings
//   touchLevels(state)        -> { bid: Level|null, ask: Level|null } for the readout
//
// `bid` and `ask` in are Levels as bestBid()/bestAsk() return them, or null for an empty
// side; `mid` and `spread` out are null - unavailable - rather than a number whenever either
// side is missing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBook, addLimitOrder, bestBid, bestAsk } from '../public/src/engine.js';
import { topOfBook, formatReadout } from '../public/src/render.js';
import { createSimulation, advance, touchLevels } from '../public/src/app.js';

const level = (price, volume = 100, orderCount = 1) => ({ price, volume, orderCount });

// "In words rather than a dash or a zero": at least two words of English, and no digit that
// could be read as a price.
function assertSaysSoInWords(text, what) {
  assert.equal(typeof text, 'string', `${what} is a string`);
  assert.ok(!/\d/.test(text), `${what} shows no number, got ${JSON.stringify(text)}`);
  assert.ok(text.trim() !== '-', `${what} is not a bare dash`);
  assert.ok(
    text.trim().split(/\s+/).filter((word) => /[a-z]/i.test(word)).length >= 2,
    `${what} says so in words, got ${JSON.stringify(text)}`,
  );
}

// --- acceptance criteria ---------------------------------------------------------------

test('Given a best bid of 99 and a best ask of 101, when the readout is computed, then mid is 100 and spread is 2', () => {
  const model = topOfBook({ bid: level(99), ask: level(101) });

  assert.equal(model.bid, 99);
  assert.equal(model.ask, 101);
  assert.equal(model.mid, 100);
  assert.equal(model.spread, 2);

  // ...and those are the numbers put on the page.
  const text = formatReadout(model);
  assert.equal(text.bid, '99.00');
  assert.equal(text.ask, '101.00');
  assert.equal(text.mid, '100.00');
  assert.equal(text.spread, '2.00');
});

test('Given a book with one side empty, when the readout is computed, then mid and spread are reported as unavailable rather than as a number', () => {
  const noAsks = topOfBook({ bid: level(99), ask: null });
  assert.equal(noAsks.bid, 99);
  assert.equal(noAsks.ask, null);
  assert.equal(noAsks.mid, null, 'no mid price without both sides');
  assert.equal(noAsks.spread, null, 'no spread without both sides');

  const noBids = topOfBook({ bid: null, ask: level(101) });
  assert.equal(noBids.mid, null);
  assert.equal(noBids.spread, null);

  const empty = topOfBook({ bid: null, ask: null });
  assert.equal(empty.bid, null);
  assert.equal(empty.ask, null);
  assert.equal(empty.mid, null);
  assert.equal(empty.spread, null);

  // Unavailable is not zero, and it is not a dash: the readout says so (NFR-3).
  for (const model of [noAsks, noBids, empty]) {
    const text = formatReadout(model);
    assertSaysSoInWords(text.mid, 'the mid price');
    assertSaysSoInWords(text.spread, 'the spread');
  }

  // The side that is missing says so too; the side that is there still shows its price.
  assert.equal(formatReadout(noAsks).bid, '99.00');
  assertSaysSoInWords(formatReadout(noAsks).ask, 'the best ask');
  assert.equal(formatReadout(noBids).ask, '101.00');
  assertSaysSoInWords(formatReadout(noBids).bid, 'the best bid');
});

// --- the readout reads the touch the engine reports --------------------------------------

test('Given a populated book, when the readout is read from it, then it reports the best bid and the best ask the engine reports', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 40 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 98, size: 40 });
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101.5, size: 40 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 103, size: 40 });

  const model = topOfBook({ bid: bestBid(book), ask: bestAsk(book) });

  assert.equal(model.bid, 99);
  assert.equal(model.ask, 101.5);
  assert.equal(model.mid, 100.25);
  assert.equal(model.spread, 2.5);
});

test('Given the spread, when it is shown, then it is an absolute number of price rather than a ratio or a percentage', () => {
  const text = formatReadout(topOfBook({ bid: level(99.5), ask: level(100.5) }));

  assert.equal(text.spread, '1.00');
  assert.ok(!text.spread.includes('%'), 'the spread is not a percentage');
});

// --- LLD-53: the spread in basis points, promoted out of PRD section 8 headroom -----------

test('Given a best bid of 99 and a best ask of 101, when the spread in basis points is computed, then it is 200.0 - the quoted spread of 2, divided by the mid of 100, times 10000', () => {
  const model = topOfBook({ bid: level(99), ask: level(101) });

  assert.equal(model.spread, 2);
  assert.equal(model.mid, 100);
  assert.equal(model.spreadBps, 200);

  const text = formatReadout(model);
  assert.match(text.spreadBps, /200\.0/, 'the bps figure is shown to one decimal place');
});

test('Given a book with one side empty, when the spread in basis points is computed, then it is reported as unavailable rather than as a number', () => {
  const noAsks = topOfBook({ bid: level(99), ask: null });
  assert.equal(noAsks.spreadBps, null);

  const noBids = topOfBook({ bid: null, ask: level(101) });
  assert.equal(noBids.spreadBps, null);

  const empty = topOfBook({ bid: null, ask: null });
  assert.equal(empty.spreadBps, null);

  for (const model of [noAsks, noBids, empty]) {
    assertSaysSoInWords(formatReadout(model).spreadBps, 'the spread in basis points');
  }
});

test('Given the readout, when it is viewed, then the basis points figure appears beside the absolute spread and is labelled bps', () => {
  const model = topOfBook({ bid: level(99), ask: level(101) });
  const text = formatReadout(model);

  assert.ok('spreadBps' in text, 'the readout carries a bps figure alongside the absolute spread');
  assert.notEqual(text.spreadBps, text.spread, 'the bps figure is a distinct figure from the absolute spread');
  assert.match(text.spreadBps, /bps/, 'the figure is labelled bps');
});

// --- wiring: the readout is fed from the running book ------------------------------------

test('Given the page is loaded, when the readout is first drawn, then it shows a mid price from a two-sided book', () => {
  const state = createSimulation();

  const model = topOfBook(touchLevels(state));

  assert.ok(Number.isFinite(model.bid), 'the readout opens with a best bid');
  assert.ok(Number.isFinite(model.ask), 'the readout opens with a best ask');
  assert.ok(Number.isFinite(model.mid), 'the readout opens with a mid price');
  assert.ok(model.spread > 0, `expected a positive spread, got ${model.spread}`);
  assert.equal(model.mid, (model.bid + model.ask) / 2);
});

test('Given the page has been open for a few seconds, when the readout is watched, then it has changed as the book changed (REQ-10)', () => {
  const state = createSimulation();
  const before = JSON.stringify(topOfBook(touchLevels(state)));

  let changed = false;
  for (let i = 0; i < 20 && !changed; i += 1) {
    advance(state, 500);
    changed = JSON.stringify(topOfBook(touchLevels(state))) !== before;
  }

  assert.ok(changed, 'the readout follows the book rather than holding its first value');
});

test('Given an empty book, when the touch levels are read, then both sides read as absent rather than raising', () => {
  const state = { book: createBook() };

  const levels = touchLevels(state);

  assert.equal(levels.bid, null);
  assert.equal(levels.ask, null);
  assert.equal(topOfBook(levels).mid, null);
});
