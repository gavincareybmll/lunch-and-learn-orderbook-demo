// Tests for LLD-61 - the spread in basis points, extending REQ-10. Written first from the
// ticket's acceptance criteria and from the PRD, never by reading an implementation (NFR-5).
// Test names echo the criteria so each can be matched back to a line in the ticket.
//
// Basis points are a ratio, so what can be wrong without a viewer noticing is the arithmetic
// and what is said when there is no ratio to state. Both are required here as pure exported
// functions of render.js, alongside the absolute figure they sit next to. The placement - that
// the new figure is beside the spread and does not compete with the mid - is checked against
// the markup and the stylesheet, as the mid's prominence already is.
//
// The surface these tests fix:
//
//   topOfBook({ bid, ask })   -> { bid, ask, mid, spread, spreadBps }, numbers or null
//   formatReadout(model)      -> { bid, ask, mid, spread, spreadBps }, all strings
//   formatBasisPoints(bps)    -> string
//
// `spreadBps` is null - unavailable - rather than a number whenever either side is missing,
// exactly as `mid` and `spread` already are.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBook, addLimitOrder, bestBid, bestAsk } from '../public/src/engine.js';
import { topOfBook, formatReadout, formatBasisPoints } from '../public/src/render.js';
import { createSimulation, advance, touchLevels } from '../public/src/app.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const level = (price, volume = 100, orderCount = 1) => ({ price, volume, orderCount });

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

// The element of the readout that carries the spread, as it appears in the markup.
function spreadNote() {
  const notes = [...INDEX.matchAll(/<p class="quote-note"[\s\S]*?<\/p>/g)].map((m) => m[0]);
  const note = notes.find((text) => text.includes('data-readout="spread"'));
  assert.ok(note, 'the readout has a slot for the absolute spread');
  return note;
}

// --- acceptance criteria ---------------------------------------------------------------

test('Given a best bid of 99 and a best ask of 101, when the spread in basis points is computed, then it is 200.0 - the quoted spread of 2, divided by the mid of 100, times 10000', () => {
  const model = topOfBook({ bid: level(99), ask: level(101) });

  assert.equal(model.spread, 2, 'the absolute spread is unchanged');
  assert.equal(model.mid, 100);
  assert.equal(model.spreadBps, 200);
  assert.equal(model.spreadBps, (model.spread / model.mid) * 10000);

  // ...and that is the figure put on the page, to a tenth of a basis point.
  assert.equal(formatReadout(model).spreadBps, '200.0');
  assert.equal(formatBasisPoints(200), '200.0');
});

test('Given a book with one side empty, when the spread in basis points is computed, then it is reported as unavailable rather than as a number', () => {
  const noAsks = topOfBook({ bid: level(99), ask: null });
  const noBids = topOfBook({ bid: null, ask: level(101) });
  const empty = topOfBook({ bid: null, ask: null });

  for (const model of [noAsks, noBids, empty]) {
    assert.equal(model.spreadBps, null, 'no basis points without both sides');
    assertSaysSoInWords(formatReadout(model).spreadBps, 'the spread in basis points');
  }
});

test('Given the readout, when it is viewed, then the basis points figure appears beside the absolute spread and is labelled bps', () => {
  const note = spreadNote();

  assert.match(note, /data-readout="spreadBps"/, 'the basis points figure sits beside the spread');
  assert.match(note, /\bbps\b/, 'and is labelled bps');

  // Beside, not instead of: the absolute figure is still there and still absolute.
  assert.match(note, /data-readout="spread"/);
  assert.equal(formatReadout(topOfBook({ bid: level(99), ask: level(101) })).spread, '2.00');

  // The loop has to write into the new slot as it writes into the others.
  assert.equal(formatReadout(topOfBook(touchLevels(createSimulation()))).spreadBps.includes('-'), false);
});

// --- visual expectation: it must not compete with the mid price -------------------------

test('Given the page at rest, when it is viewed, then the mid price is still the most prominent number on screen and the basis points figure is a small one beside the spread', () => {
  const sized = typeSizes();
  assert.ok(sized.length > 1, 'the stylesheet sets type sizes');

  const largest = sized.reduce((a, b) => (b.size > a.size ? b : a));
  assert.match(
    largest.selector,
    /\.quote\.mid/,
    `the largest type on the page belongs to the mid price, not to ${largest.selector}`,
  );

  // The new figure lives in the note under the mid, which is set small - nothing about this
  // ticket is allowed anywhere near the mid's size.
  const notes = sized.filter((entry) => /\.quote-note|\.quote-figure|bps/.test(entry.selector));
  assert.ok(notes.length > 0, 'the line carrying the spread sets its own type size');
  for (const entry of notes) {
    assert.ok(
      entry.size < largest.size / 2,
      `${entry.selector} is set at ${entry.size}rem against the mid at ${largest.size}rem`,
    );
  }
});

// --- the arithmetic, over more than the one worked example -------------------------------

test('Given a spread and a mid, when basis points are computed, then they are the spread as ten-thousandths of the mid', () => {
  // A tighter spread on a higher price: 0.02 over a mid of 200 is one basis point. Compared
  // to a tolerance because two decimal prices do not subtract exactly in binary.
  const tight = topOfBook({ bid: level(199.99), ask: level(200.01) });
  assert.ok(Math.abs(tight.spreadBps - 1) < 1e-6, `expected about 1 bp, got ${tight.spreadBps}`);
  assert.equal(formatBasisPoints(tight.spreadBps), '1.0');

  // The same absolute spread is a different ratio at a different price level, which is the
  // whole point of quoting it this way.
  const cheap = topOfBook({ bid: level(9.5), ask: level(10.5) });
  const dear = topOfBook({ bid: level(999.5), ask: level(1000.5) });
  assert.equal(cheap.spread, dear.spread);
  assert.ok(cheap.spreadBps > dear.spreadBps, 'a pound is wider on a ten than on a thousand');
  assert.equal(cheap.spreadBps, 1000);
  assert.equal(dear.spreadBps, 10);
});

test('Given a populated book, when the readout is read from it, then the basis points figure follows the book as the absolute spread does', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 40 });
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101.5, size: 40 });

  const model = topOfBook({ bid: bestBid(book), ask: bestAsk(book) });
  assert.equal(model.spread, 2.5);
  assert.equal(model.mid, 100.25);
  assert.ok(Math.abs(model.spreadBps - 249.376558) < 1e-4, `got ${model.spreadBps}`);
  assert.equal(formatReadout(model).spreadBps, '249.4');
});

test('Given the page has been open for a few seconds, when the basis points figure is watched, then it has changed as the book changed', () => {
  const state = createSimulation();
  const opening = topOfBook(touchLevels(state));
  assert.ok(Number.isFinite(opening.spreadBps), 'the readout opens with a figure in basis points');
  assert.ok(opening.spreadBps > 0, `expected a positive spread, got ${opening.spreadBps}`);

  let changed = false;
  for (let i = 0; i < 20 && !changed; i += 1) {
    advance(state, 500);
    changed = topOfBook(touchLevels(state)).spreadBps !== opening.spreadBps;
  }

  assert.ok(changed, 'the figure follows the book rather than holding its first value');
});

test('Given a figure in basis points, when it is formatted, then it is a plain number to one decimal place with no percent sign', () => {
  assert.equal(formatBasisPoints(0), '0.0');
  assert.equal(formatBasisPoints(1), '1.0');
  assert.equal(formatBasisPoints(249.376558704), '249.4');
  assert.equal(formatBasisPoints(1000), '1000.0');

  for (const value of [0, 1, 200, 1000]) {
    assert.ok(!formatBasisPoints(value).includes('%'), 'basis points are not a percentage');
  }
});
