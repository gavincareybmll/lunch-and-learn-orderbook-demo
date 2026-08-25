// Tests for LLD-45 - the spread in basis points - written from the ticket's acceptance
// criteria and from PRD REQ-10, REQ-13 and NFR-3, never by reading an implementation
// (NFR-5). Test names echo the criteria so each one can be matched back to a line in the
// ticket.
//
// Basis points are the readout's existing arithmetic said a second way: spread over mid,
// times 10000. So the same split as LLD-9's readout applies - the calculation and the text
// are pure exported functions of render.js, and the placement on screen is markup, checked
// here by reading index.html because there is no DOM to query (NFR-2).
//
// This extends the readout surface rather than changing it:
//
//   topOfBook({ bid, ask })   -> { bid, ask, mid, spread, spreadBps }
//   formatReadout(model)      -> { bid, ask, mid, spread, spreadBps }, all strings
//
// `spreadBps` is null - unavailable - wherever `spread` is, because it is computed from it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBook, addLimitOrder, bestBid, bestAsk } from '../public/src/engine.js';
import { topOfBook, formatReadout } from '../public/src/render.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const STYLE = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));

const level = (price, volume = 100, orderCount = 1) => ({ price, volume, orderCount });

// Same test as the readout's own: "unavailable" is a short sentence of English, not a dash,
// a zero, or any digit that could be misread as a figure (NFR-3).
function assertSaysSoInWords(text, what) {
  assert.equal(typeof text, 'string', `${what} is a string`);
  assert.ok(!/\d/.test(text), `${what} shows no number, got ${JSON.stringify(text)}`);
  assert.ok(text.trim() !== '-', `${what} is not a bare dash`);
  assert.ok(
    text.trim().split(/\s+/).filter((word) => /[a-z]/i.test(word)).length >= 2,
    `${what} says so in words, got ${JSON.stringify(text)}`,
  );
}

// Every font-size in the stylesheet with the selector it belongs to, compared at the top of
// its clamp in rem - the unit every one of them states its maximum in.
function typeSizes() {
  const sized = [];
  for (const chunk of STYLE.split('}')) {
    const [selector, ...declarations] = chunk.split('{');
    const rule = /font-size:([^;]+);/.exec(declarations.join('{'));
    if (!rule) continue;
    const rem = [...rule[1].matchAll(/([\d.]+)rem/g)].map((match) => Number(match[1]));
    if (rem.length > 0) sized.push({ selector: selector.trim(), size: Math.max(...rem) });
  }
  return sized;
}

// --- acceptance criteria ---------------------------------------------------------------

test('Given a best bid of 99 and a best ask of 101, when the spread in basis points is computed, then it is 200.0 - the quoted spread of 2, divided by the mid of 100, times 10000', () => {
  const model = topOfBook({ bid: level(99), ask: level(101) });

  assert.equal(model.spread, 2, 'the absolute spread is unchanged');
  assert.equal(model.mid, 100);
  assert.equal(model.spreadBps, 200);

  // ...and 200.0 is the figure put on the page, to a tenth of a basis point.
  assert.equal(formatReadout(model).spreadBps, '200.0');

  // The same arithmetic holds away from the round numbers: spread over mid, times 10000.
  for (const [bid, ask] of [[99.5, 100.5], [99, 100], [90, 110], [99.99, 100.01]]) {
    const wide = topOfBook({ bid: level(bid), ask: level(ask) });
    assert.ok(
      Math.abs(wide.spreadBps - ((ask - bid) / ((ask + bid) / 2)) * 10000) < 1e-9,
      `expected ${ask - bid} over a mid of ${(ask + bid) / 2} in basis points, got ${wide.spreadBps}`,
    );
  }
  assert.equal(formatReadout(topOfBook({ bid: level(99.5), ask: level(100.5) })).spreadBps, '100.0');
  assert.equal(formatReadout(topOfBook({ bid: level(99), ask: level(100) })).spreadBps, '100.5');
  assert.equal(formatReadout(topOfBook({ bid: level(90), ask: level(110) })).spreadBps, '2000.0');

  // A basis point is a ratio, so it is a plain figure with no currency in it.
  assert.ok(
    !/[%$£€]/.test(formatReadout(model).spreadBps),
    'the basis points figure carries no percentage or currency sign',
  );
});

test('Given a book with one side empty, when the spread in basis points is computed, then it is reported as unavailable rather than as a number', () => {
  const noAsks = topOfBook({ bid: level(99), ask: null });
  const noBids = topOfBook({ bid: null, ask: level(101) });
  const empty = topOfBook({ bid: null, ask: null });

  for (const model of [noAsks, noBids, empty]) {
    assert.equal(model.spread, null, 'no absolute spread without both sides');
    assert.equal(model.spreadBps, null, 'and so no spread in basis points either');
    assertSaysSoInWords(formatReadout(model).spreadBps, 'the spread in basis points');
  }
});

test('Given the readout, when it is viewed, then the basis points figure appears beside the absolute spread and is labelled bps', () => {
  const spreadAt = INDEX.indexOf('data-readout="spread"');
  const bpsAt = INDEX.indexOf('data-readout="spreadBps"');

  assert.ok(spreadAt > -1, 'the absolute spread still has its slot');
  assert.ok(bpsAt > -1, 'the basis points figure has a slot of its own on the readout');
  assert.ok(bpsAt > spreadAt, 'the basis points figure follows the absolute spread');

  // Beside it, not somewhere else on the page: the two sit in the same line of the readout,
  // with nothing between them.
  const between = INDEX.slice(spreadAt, bpsAt);
  assert.ok(
    !/<\/p>|<p[\s>]|<section/.test(between),
    'the basis points figure shares the spread\'s line rather than starting a new block',
  );

  // Labelled, so the figure is never read as a second price.
  assert.match(
    INDEX.slice(spreadAt, bpsAt + 160),
    /[\s>]bps\b/,
    'the basis points figure is labelled bps',
  );

  // Every slot the readout markup offers is a field the readout model fills, so the new one
  // is written by the same loop as the other four rather than left showing its placeholder.
  const slots = [...INDEX.matchAll(/data-readout="([^"]+)"/g)].map((match) => match[1]);
  const fields = Object.keys(formatReadout(topOfBook({ bid: level(99), ask: level(101) })));
  assert.ok(slots.includes('spreadBps'));
  for (const slot of slots) {
    assert.ok(fields.includes(slot), `the readout model has a value for the ${slot} slot`);
  }
});

// --- visual expectation: it must not compete with the mid price (REQ-13) -----------------

test('Given the readout, when it is viewed, then the mid price is still the most prominent number on screen and the basis points figure does not compete with it', () => {
  const sized = typeSizes();
  assert.ok(sized.length > 1, 'the stylesheet sets type sizes');

  const largest = sized.reduce((a, b) => (b.size > a.size ? b : a));
  assert.match(
    largest.selector,
    /\.quote\.mid/,
    `the largest type on the page belongs to the mid price, not to ${largest.selector}`,
  );

  // The figure is added into the small-print line the absolute spread already lives on, which
  // the stylesheet sets far below the mid - so whatever it is styled with, it cannot shout.
  const bpsTag = /<[^>]*data-readout="spreadBps"[^>]*>/.exec(INDEX);
  assert.ok(bpsTag, 'the basis points figure has an element of its own');
  const classes = (/class="([^"]*)"/.exec(bpsTag[0])?.[1] ?? '').split(/\s+/).filter(Boolean);
  assert.ok(classes.length > 0, 'that element carries a class the stylesheet can size');

  const applies = sized.filter((entry) =>
    classes.some((name) => entry.selector.includes(`.${name}`)),
  );
  assert.ok(applies.length > 0, 'the stylesheet sets a type size for the basis points figure');
  for (const entry of applies) {
    assert.ok(
      entry.size < largest.size / 2,
      `${entry.selector} is set at ${entry.size}rem against the mid at ${largest.size}rem`,
    );
  }
});

// --- the figure follows the running book ------------------------------------------------

test('Given a populated book, when the spread in basis points is read from it, then it is computed from the touch the engine reports', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 40 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 98, size: 40 });
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40 });

  const model = topOfBook({ bid: bestBid(book), ask: bestAsk(book) });
  assert.equal(model.spreadBps, 200);

  // The touch narrows, so the figure does: a bid of 100 against the same ask is a quarter of
  // the spread and, near enough, a quarter of the basis points.
  addLimitOrder(book, { id: 'b3', side: 'bid', price: 100.5, size: 40 });
  const tighter = topOfBook({ bid: bestBid(book), ask: bestAsk(book) });
  assert.equal(tighter.spread, 0.5);
  assert.ok(
    tighter.spreadBps < model.spreadBps,
    `expected a narrower spread to read fewer basis points, got ${tighter.spreadBps}`,
  );
  assert.ok(Math.abs(tighter.spreadBps - (0.5 / 100.75) * 10000) < 1e-9);
});

test('Given a touch with no mid to divide by, when the spread in basis points is computed, then it is unavailable rather than infinite', () => {
  // Not reachable from the simulator's flow, but a ratio has a denominator and a readout must
  // never print Infinity or NaN where a figure goes (NFR-3).
  for (const [bid, ask] of [[0, 0], [-1, 1]]) {
    const model = topOfBook({ bid: level(bid), ask: level(ask) });
    assert.equal(model.spreadBps, null, `a mid of ${(ask + bid) / 2} has no basis points`);
    assertSaysSoInWords(formatReadout(model).spreadBps, 'the spread in basis points');
  }
});

test('Given a book that is not crossed, when the spread in basis points is computed, then it is never negative', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99.99, size: 10 });
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 100, size: 10 });

  const model = topOfBook({ bid: bestBid(book), ask: bestAsk(book) });
  assert.ok(model.spreadBps > 0, `expected a positive figure, got ${model.spreadBps}`);
  assert.equal(formatReadout(model).spreadBps, '1.0');
});
