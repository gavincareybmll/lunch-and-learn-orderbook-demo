// Tests for LLD-67 - the price at the touch drawn at a size set by how much is resting at
// it - written from the ticket's acceptance criteria and from PRD REQ-10, REQ-13 and NFR-3,
// never by reading an implementation (NFR-5). Test names echo the ticket so each can be
// matched back to a line in it.
//
// The ticket is scoped to the top of book: "Not needed for depth of book, only top of book".
// So the two prices this is about are the best bid and the best ask of the readout (REQ-10),
// and the depth ladder is required here to be left alone.
//
// A type size is something a viewer sees rather than something a test can look at, so what is
// required here is the calculation behind it as a pure exported function - which is the part
// that can be wrong in a way nobody watching would notice - plus evidence that the number it
// produces reaches the price on the page.
//
// The surface these tests fix:
//
//   QUOTE_SCALE_MIN / QUOTE_SCALE_MAX  -> the band a price may be drawn in, as a multiple of
//                                         its base size
//   quoteScale(volume, reference)      -> that multiple for one price, proportional to volume
//   quoteScales(model)                 -> { bid, ask } for the two prices of the readout
//   topOfBook(touch)                   -> carries the size resting at each of those prices
//   drawReadout(target, model)         -> writes each price's size onto its own slot

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  QUOTE_SCALE_MIN,
  QUOTE_SCALE_MAX,
  quoteScale,
  quoteScales,
  topOfBook,
  drawReadout,
  ladderRows,
} from '../public/src/render.js';
import { createSimulation, advance, touchLevels } from '../public/src/app.js';

const level = (price, volume = 100, orderCount = 1) => ({ price, volume, orderCount });

const closeTo = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`,
  );

// The readout as drawReadout writes into it: four slots marked with data-readout, each of
// which can hold text, an availability flag and a custom property. A stub rather than a DOM -
// a DOM would be a dependency, and NFR-2 does not allow one.
function fakeReadout() {
  const slot = () => ({
    textContent: '',
    dataset: {},
    style: {
      properties: new Map(),
      setProperty(name, value) {
        this.properties.set(name, String(value));
      },
      removeProperty(name) {
        this.properties.delete(name);
      },
      getPropertyValue(name) {
        return this.properties.get(name) ?? '';
      },
    },
  });

  const slots = { bid: slot(), ask: slot(), mid: slot(), spread: slot() };
  return {
    slots,
    querySelector: (selector) => slots[selector.match(/"([^"]+)"/)?.[1]] ?? null,
  };
}

const scaleWritten = (slot) => Number.parseFloat(slot.style.getPropertyValue('--quote-scale'));

// --- acceptance criterion ----------------------------------------------------------------

test('The display sizes of the prices are proportional to the sizes represented at each price', () => {
  // The largest quote on screen is drawn at the top of the band, and everything else in
  // proportion to it - the same rule the ladder's bars follow, so a size means the same thing
  // in both places.
  assert.equal(quoteScale(1000, 1000), QUOTE_SCALE_MAX);

  // Proportional: a quote of four fifths the size is drawn at four fifths the size.
  closeTo(quoteScale(800, 1000), QUOTE_SCALE_MAX * 0.8, 'four fifths of the largest quote');
  closeTo(quoteScale(600, 1000), QUOTE_SCALE_MAX * 0.6, 'three fifths of the largest quote');

  // ...and so a quote with a third more resting on it than another is drawn a third larger.
  closeTo(
    quoteScale(800, 1000) / quoteScale(600, 1000),
    800 / 600,
    'the ratio of two display sizes is the ratio of the two quote sizes',
  );

  // The two prices of the readout, taken together: the bigger quote sets the scale and the
  // other is proportional to it.
  const model = topOfBook({ bid: level(99, 900), ask: level(101, 600) });
  const scales = quoteScales(model);
  assert.equal(scales.bid, QUOTE_SCALE_MAX);
  closeTo(scales.ask / scales.bid, 600 / 900, 'the ask price against the bid price');
});

test('Given the touch, when the readout is written, then each price carries the display size its own quote size gives it', () => {
  const target = fakeReadout();

  drawReadout(target, topOfBook({ bid: level(99, 900), ask: level(101, 600) }));

  closeTo(scaleWritten(target.slots.bid), QUOTE_SCALE_MAX, 'the size written on the bid price');
  closeTo(
    scaleWritten(target.slots.ask),
    QUOTE_SCALE_MAX * (600 / 900),
    'the size written on the ask price',
  );

  // The prices are still the prices: sizing them changes nothing about what they say.
  assert.equal(target.slots.bid.textContent, '99.00');
  assert.equal(target.slots.ask.textContent, '101.00');
  assert.equal(target.slots.mid.textContent, '100.00');
});

// --- visual expectation ------------------------------------------------------------------

test('User sees different size prices based on the sizes of the quotes at each price', () => {
  const lopsided = quoteScales(topOfBook({ bid: level(99, 800), ask: level(101, 200) }));
  assert.ok(
    lopsided.bid > lopsided.ask,
    `the side with more resting on it is drawn larger, got ${lopsided.bid} against ${lopsided.ask}`,
  );

  // Different enough to be seen from the back of a room rather than different in arithmetic
  // only (NFR-3): the band spans a doubling of size at least.
  assert.ok(
    QUOTE_SCALE_MAX / QUOTE_SCALE_MIN >= 2,
    `expected a visible range of sizes, got ${QUOTE_SCALE_MIN} to ${QUOTE_SCALE_MAX}`,
  );
  assert.ok(QUOTE_SCALE_MIN < 1 && QUOTE_SCALE_MAX > 1, 'the base size sits inside the band');

  // Two quotes of the same size are drawn the same size - the display says something about
  // the book rather than about which side it is.
  const even = quoteScales(topOfBook({ bid: level(99, 500), ask: level(101, 500) }));
  assert.equal(even.bid, even.ask);
  assert.equal(even.bid, QUOTE_SCALE_MAX);

  // And the difference is on the page, not only in the model.
  const target = fakeReadout();
  drawReadout(target, topOfBook({ bid: level(99, 800), ask: level(101, 200) }));
  assert.ok(
    scaleWritten(target.slots.bid) > scaleWritten(target.slots.ask),
    'the two prices are written at different sizes',
  );
});

test('Given a quote so much larger than the other that its price would not fit, when the prices are sized, then both stay within a legible band', () => {
  for (const [volume, reference] of [[1, 100000], [100000, 1], [0, 900], [900, 900]]) {
    const scale = quoteScale(volume, reference);
    assert.ok(Number.isFinite(scale), `expected a finite size, got ${scale}`);
    assert.ok(
      scale >= QUOTE_SCALE_MIN && scale <= QUOTE_SCALE_MAX,
      `expected ${QUOTE_SCALE_MIN}..${QUOTE_SCALE_MAX}, got ${scale} for ${volume} of ${reference}`,
    );
  }
});

// --- out of scope: "not needed for depth of book, only top of book" ----------------------

test('Given the depth ladder, when it is drawn, then its prices are not sized by volume - this is top of book only', () => {
  const model = ladderRows({
    bids: [
      { price: 99, volume: 900, orderCount: 3 },
      { price: 98, volume: 20, orderCount: 1 },
    ],
    asks: [{ price: 101, volume: 300, orderCount: 2 }],
  });

  for (const row of [...model.bids, ...model.asks]) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['fraction', 'orderCount', 'price', 'side', 'volume'],
      'a ladder row carries no type size: the ladder is unchanged by this ticket',
    );
  }
});

// --- REQ-13: the mid price is still the most prominent number on screen ------------------

test('Given the prices at the touch are sized, when the page is viewed, then the mid price is still the most prominent number on screen', () => {
  // The mid is not one of the sized prices: nothing rests at the mid, so there is no size for
  // it to be relative to.
  const scales = quoteScales(topOfBook({ bid: level(99, 900), ask: level(101, 600) }));
  assert.deepEqual(Object.keys(scales).sort(), ['ask', 'bid']);

  const target = fakeReadout();
  drawReadout(target, topOfBook({ bid: level(99, 900), ask: level(101, 600) }));
  assert.equal(
    target.slots.mid.style.getPropertyValue('--quote-scale'),
    '',
    'the mid price is never scaled by a quote size',
  );

  // ...and the ceiling of the band is low enough that the largest a price at the touch can be
  // drawn is still smaller than the mid, at every width the stylesheet sets a size for.
  const quote = declaredFontSize('.quote-price');
  const mid = declaredFontSize('.quote.mid .quote-price');
  assert.equal(quote.length, mid.length, 'the two type sizes are declared the same way');
  for (const [index, stop] of quote.entries()) {
    assert.equal(stop.unit, mid[index].unit, 'compared in the same unit');
    assert.ok(
      stop.value * QUOTE_SCALE_MAX < mid[index].value,
      `a price at the touch grown to ${QUOTE_SCALE_MAX}x is ${stop.value * QUOTE_SCALE_MAX}${stop.unit}, which is not smaller than the mid at ${mid[index].value}${mid[index].unit}`,
    );
  }
});

// The lengths a stylesheet rule sets font-size to, in declaration order - the three stops of a
// clamp(), or the single value of a plain one. Read from the page rather than restated here,
// because the point of the check is that the two sizes on the page agree with each other.
function declaredFontSize(selector) {
  const css = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Rules are single-selector and single-line in this stylesheet, so the last line before the
  // brace is the selector.
  const body = css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length === 2)
    .find((parts) => parts[0].split('\n').at(-1).trim() === selector)?.[1];

  assert.ok(body !== undefined, `expected a ${selector} rule in the stylesheet`);

  const declaration = body.match(/font-size:\s*([^;]+);/)?.[1];
  assert.ok(declaration !== undefined, `expected ${selector} to set a font-size`);

  return [...declaration.matchAll(/(-?[\d.]+)(rem|em|px|vw|vh)/g)].map((match) => ({
    value: Number.parseFloat(match[1]),
    unit: match[2],
  }));
}

// --- over randomised flow ----------------------------------------------------------------

test('Given a running book, when the touch is sized on every event, then the sizes stay in band and follow the volumes', () => {
  const seed = 20260826;
  const state = createSimulation(seed);

  for (let i = 0; i < 400; i += 1) {
    advance(state, 100);
    const model = topOfBook(touchLevels(state));
    const scales = quoteScales(model);

    for (const side of ['bid', 'ask']) {
      assert.ok(
        Number.isFinite(scales[side]) &&
          scales[side] >= QUOTE_SCALE_MIN &&
          scales[side] <= QUOTE_SCALE_MAX,
        `seed ${seed}: ${side} size ${scales[side]} out of band after ${i} frames`,
      );
    }

    // Ordered by what is resting: never the smaller quote drawn larger.
    if (Number.isFinite(model.bidVolume) && Number.isFinite(model.askVolume)) {
      const bigger = model.bidVolume >= model.askVolume ? 'bid' : 'ask';
      const smaller = bigger === 'bid' ? 'ask' : 'bid';
      assert.ok(
        scales[bigger] >= scales[smaller],
        `seed ${seed}: ${smaller} (${model[`${smaller}Volume`]}) drawn larger than ${bigger} (${model[`${bigger}Volume`]}) after ${i} frames`,
      );
    }
  }
});

test('Given the touch, when it is read for the readout, then the size resting at each price comes with it', () => {
  const model = topOfBook({ bid: level(99, 900, 3), ask: level(101, 600, 2) });

  assert.equal(model.bidVolume, 900);
  assert.equal(model.askVolume, 600);

  // A side with nothing resting on it has no size, and its price is drawn at its base size
  // rather than at nothing.
  const oneSided = topOfBook({ bid: level(99, 900), ask: null });
  assert.equal(oneSided.askVolume, null);
  assert.equal(quoteScales(oneSided).ask, 1);

  const empty = quoteScales(topOfBook({ bid: null, ask: null }));
  assert.equal(empty.bid, 1);
  assert.equal(empty.ask, 1);
});
