// Tests for LLD-6, written from the ticket's acceptance criteria and PRD REQ-7, NFR-3.
// Test names echo the acceptance criteria so each one can be matched back to a line in the
// ticket.
//
// The ticket's testing note is the reason this file has the shape it does: canvas and DOM
// output cannot be unit tested here, and adding a DOM would break NFR-2. So every
// calculation the ladder depends on - level ordering, scaling, bar widths, the placement of
// rows either side of the touch, and the text of each row - is required here as a pure
// exported function of render.js. What is left in the drawing call is the drawing itself,
// which is verified on the deploy preview.
//
// These tests therefore fix the render surface:
//
//   ladderRows({ bids, asks })                 -> { bids: Row[], asks: Row[], maxVolume }
//   barWidth(volume, maxVolume, available)     -> number, 0 <= n <= available
//   ladderLayout(model, { height, maxLevels, barSpace })
//                                              -> { centreY, rowHeight, rows: Placement[] }
//   formatPrice / formatVolume / formatOrderCount -> string
//
// Row is { side, price, volume, orderCount, fraction } and Placement is a Row plus the
// { y, barWidth } the drawing needs. Both sides are held best-first, as depth() returns
// them; ladderLayout is what turns that into asks-above, bids-below.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBook, addLimitOrder, depth } from '../public/src/engine.js';
import {
  ladderRows,
  barWidth,
  ladderLayout,
  formatPrice,
  formatVolume,
  formatOrderCount,
} from '../public/src/render.js';

// A book with `count` populated levels a side, one order each, stepping away from the touch.
function bookWithLevels(count) {
  const book = createBook();
  for (let i = 0; i < count; i += 1) {
    addLimitOrder(book, { id: `b${i}`, side: 'bid', price: 99 - i, size: 10 * (i + 1) });
    addLimitOrder(book, { id: `a${i}`, side: 'ask', price: 101 + i, size: 10 * (i + 1) });
  }
  return book;
}

const pricesOf = (rows) => rows.map((row) => row.price);

// --- acceptance criteria ---------------------------------------------------------------

test('Given a book with five levels a side, when depth is requested for three levels, then exactly three bid levels and three ask levels are returned, best-first', () => {
  const book = bookWithLevels(5);

  const { bids, asks } = depth(book, 3);

  assert.equal(bids.length, 3);
  assert.equal(asks.length, 3);
  assert.deepEqual(pricesOf(bids), [99, 98, 97]);
  assert.deepEqual(pricesOf(asks), [101, 102, 103]);

  // The ladder model keeps that ordering rather than re-sorting it.
  const model = ladderRows(depth(book, 3));
  assert.deepEqual(pricesOf(model.bids), [99, 98, 97]);
  assert.deepEqual(pricesOf(model.asks), [101, 102, 103]);
});

test('Given a level holding three orders totalling 220, when it is rendered, then that level shows volume 220 and an order count of 3', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 70 });
  addLimitOrder(book, { id: 'b3', side: 'bid', price: 99, size: 50 });

  const model = ladderRows(depth(book, 5));
  const level = model.bids[0];

  assert.equal(level.price, 99);
  assert.equal(level.volume, 220);
  assert.equal(level.orderCount, 3);

  // ...and shows them: what is drawn on the row is these two strings.
  assert.equal(formatVolume(level.volume), '220');
  assert.equal(formatOrderCount(level.orderCount), '3 orders');
});

test('Given fewer populated levels than requested, when depth is returned, then only the populated levels are returned rather than empty placeholders', () => {
  const book = bookWithLevels(2);

  const { bids, asks } = depth(book, 6);
  assert.equal(bids.length, 2);
  assert.equal(asks.length, 2);

  const model = ladderRows(depth(book, 6));
  assert.equal(model.bids.length, 2);
  assert.equal(model.asks.length, 2);
  assert.ok(
    [...model.bids, ...model.asks].every((row) => Number.isFinite(row.price)),
    'every row returned is a populated level',
  );

  // ...and the layout places two rows a side, not six.
  const layout = ladderLayout(model, { height: 600, maxLevels: 6, barSpace: 300 });
  assert.equal(layout.rows.length, 4);
});

test('Given a set of levels with differing volumes, when bar widths are computed, then the largest volume maps to the full available width and every other bar is proportional to it', () => {
  assert.equal(barWidth(400, 400, 300), 300);
  assert.equal(barWidth(200, 400, 300), 150);
  assert.equal(barWidth(100, 400, 300), 75);

  // The scale is the largest level on screen, across both sides together.
  const model = ladderRows({
    bids: [
      { price: 99, volume: 200, orderCount: 2 },
      { price: 98, volume: 100, orderCount: 1 },
    ],
    asks: [{ price: 101, volume: 400, orderCount: 4 }],
  });
  assert.equal(model.maxVolume, 400);

  const layout = ladderLayout(model, { height: 600, maxLevels: 3, barSpace: 300 });
  const widthAt = (price) => layout.rows.find((row) => row.price === price).barWidth;
  assert.equal(widthAt(101), 300);
  assert.equal(widthAt(99), 150);
  assert.equal(widthAt(98), 75);
});

test('Given a level with zero volume would be drawn, when bar widths are computed, then the result is zero width rather than a negative or NaN width', () => {
  const cases = [
    barWidth(0, 400, 300), // an empty level against a populated scale
    barWidth(0, 0, 300), // nothing on screen at all, so no scale to divide by
    barWidth(-50, 400, 300), // nonsense input still has to draw something drawable
    barWidth(100, 400, 0), // no room to draw in
  ];

  for (const width of cases) {
    assert.ok(Number.isFinite(width), `expected a finite width, got ${width}`);
    assert.ok(width >= 0, `expected a non-negative width, got ${width}`);
  }
  assert.equal(barWidth(0, 400, 300), 0);
  assert.equal(barWidth(0, 0, 300), 0);

  // The same through the model: an empty book has no scale and no rows to draw.
  const empty = ladderRows({ bids: [], asks: [] });
  assert.equal(empty.maxVolume, 0);
  const layout = ladderLayout(empty, { height: 600, maxLevels: 5, barSpace: 300 });
  assert.deepEqual(layout.rows, []);

  // ...and a zero-volume level handed to the renderer draws a zero-width bar, not a gap in
  // the arithmetic.
  const zeroed = ladderRows({ bids: [{ price: 99, volume: 0, orderCount: 0 }], asks: [] });
  const zeroLayout = ladderLayout(zeroed, { height: 600, maxLevels: 5, barSpace: 300 });
  assert.equal(zeroLayout.rows[0].barWidth, 0);
});

// --- visual expectation: asks above, bids below, touch at the vertical centre ------------

test('Given a populated book, when the ladder is laid out, then asks sit above the vertical centre and bids below it, with the touch at the centre', () => {
  const model = ladderRows(depth(bookWithLevels(3), 3));
  const { centreY, rowHeight, rows } = ladderLayout(model, {
    height: 600,
    maxLevels: 3,
    barSpace: 300,
  });

  assert.equal(centreY, 300);
  assert.ok(rowHeight > 0);

  const asks = rows.filter((row) => row.side === 'ask');
  const bids = rows.filter((row) => row.side === 'bid');
  assert.ok(
    asks.every((row) => row.y + rowHeight <= centreY),
    'every ask row is drawn above the centre line',
  );
  assert.ok(
    bids.every((row) => row.y >= centreY),
    'every bid row is drawn below the centre line',
  );

  // The touch is what meets at the centre: best ask immediately above, best bid immediately
  // below, whatever else is on screen.
  const nearestAbove = asks.reduce((a, b) => (b.y > a.y ? b : a));
  const nearestBelow = bids.reduce((a, b) => (b.y < a.y ? b : a));
  assert.equal(nearestAbove.price, 101);
  assert.equal(nearestBelow.price, 99);

  // Rows step away from the touch in best-first order and do not overlap.
  assert.deepEqual(
    asks.sort((a, b) => b.y - a.y).map((row) => row.price),
    [101, 102, 103],
  );
  assert.deepEqual(
    bids.sort((a, b) => a.y - b.y).map((row) => row.price),
    [99, 98, 97],
  );
});

test('Given fewer levels on one side than the other, when the ladder is laid out, then the touch stays at the vertical centre', () => {
  const model = ladderRows({
    bids: [{ price: 99, volume: 10, orderCount: 1 }],
    asks: [
      { price: 101, volume: 10, orderCount: 1 },
      { price: 102, volume: 10, orderCount: 1 },
      { price: 103, volume: 10, orderCount: 1 },
    ],
  });

  const { centreY, rowHeight, rows } = ladderLayout(model, {
    height: 600,
    maxLevels: 4,
    barSpace: 300,
  });

  // Rows are anchored to the centre rather than packed into whatever space they need, so an
  // uneven book does not slide the touch up or down the screen.
  assert.equal(rows.find((row) => row.price === 101).y, centreY - rowHeight);
  assert.equal(rows.find((row) => row.price === 99).y, centreY);
});

// --- row text (per the testing note: formatting is a calculation and is tested here) -----

test('Given a level, when its row text is formatted, then price, volume and order count are legible without units or jargon', () => {
  assert.equal(formatPrice(100), '100.00');
  assert.equal(formatPrice(99.5), '99.50');

  assert.equal(formatVolume(220), '220');
  assert.equal(formatVolume(12500), '12,500');
  assert.equal(formatVolume(0), '0');

  // Counted in words, so the number is never mistaken for another volume (NFR-3).
  assert.equal(formatOrderCount(1), '1 order');
  assert.equal(formatOrderCount(3), '3 orders');
  assert.equal(formatOrderCount(0), '0 orders');
});
