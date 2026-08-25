// Tests for LLD-7, written from the ticket's acceptance criteria and PRD REQ-8, REQ-13,
// NFR-3. Test names echo the acceptance criteria so each one can be matched back to a line in
// the ticket.
//
// The ticket's testing note is the reason this file has the shape it does: the canvas and DOM
// drawing cannot be unit tested here, so every calculation the queue view depends on - which
// orders are shown, their queue positions, their display widths, the overflow behind them and
// the text of each element - is required here as a pure exported function of render.js. What
// is left in the drawing call is stroke-and-fill, verified on the deploy preview.
//
// The first three criteria are engine behaviour, which `queueAt` already provides; they are
// asserted here anyway because the queue view is only correct if they are, and because they
// are what the display is reading.
//
// These tests therefore fix the queue-view surface:
//
//   queueRows(orders, { maxSlots })   -> { shown: Row[], hidden, hiddenVolume, total, volume,
//                                          maxSize }
//   queueLayout({ bid, ask }, { height, maxSlots, barSpace })
//                                     -> { centreY, rowHeight, rows: Placement[] }
//   formatQueuePosition(position)     -> string, an ordinal rank
//   formatQueueOverflow(hidden, hiddenVolume) -> string, '' when nothing is hidden
//   QUEUE_CAPTION                     -> the plain-language label of REQ-13
//   touchQueues(state)                -> { bid: { price, orders }, ask: { price, orders } }
//
// Row is { position, id, size, fraction } - `fraction` being the order's share of the largest
// order in its queue - and Placement is a Row plus the { side, y, barWidth } the drawing
// needs. Position 1 is the order next to trade.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBook,
  addLimitOrder,
  submitMarketOrder,
  bestBid,
  bestAsk,
  queueAt,
} from '../public/src/engine.js';
import {
  queueRows,
  queueLayout,
  formatQueuePosition,
  formatQueueOverflow,
  QUEUE_CAPTION,
} from '../public/src/render.js';
import { FLOW, createSimulation, advance, touchQueues } from '../public/src/app.js';

const sizesOf = (orders) => orders.map((order) => order.size);
const idsOf = (orders) => orders.map((order) => order.id);

// A queue of plain orders, as queueAt returns them, with the sizes given in arrival order.
const queueOf = (...sizes) =>
  sizes.map((size, index) => ({ id: `o${index + 1}`, side: 'bid', price: 99, size, ts: index }));

// --- acceptance criteria ---------------------------------------------------------------

test('Given a best bid holding three orders, when the queue at that price is read, then three orders are returned in arrival order, position 1 first', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'first', side: 'bid', price: 99, size: 100 });
  addLimitOrder(book, { id: 'second', side: 'bid', price: 99, size: 50 });
  addLimitOrder(book, { id: 'third', side: 'bid', price: 99, size: 25 });

  const queue = queueAt(book, 'bid', bestBid(book).price);

  assert.equal(queue.length, 3);
  assert.deepEqual(idsOf(queue), ['first', 'second', 'third']);
  assert.deepEqual(sizesOf(queue), [100, 50, 25]);

  // ...and the view numbers them from 1, in that same order.
  const model = queueRows(queue, { maxSlots: 6 });
  assert.deepEqual(
    model.shown.map((row) => [row.position, row.id]),
    [
      [1, 'first'],
      [2, 'second'],
      [3, 'third'],
    ],
  );
});

test('Given the order at position 1 of the best ask is fully filled, when the queue is read again, then the order formerly at position 2 is now at position 1', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 60 });
  addLimitOrder(book, { id: 'a3', side: 'ask', price: 101, size: 30 });

  // Exactly the size of the order at position 1, so it fills and nothing behind it is touched.
  submitMarketOrder(book, { id: 'taker', side: 'bid', size: 40 });

  const queue = queueAt(book, 'ask', bestAsk(book).price);
  assert.deepEqual(idsOf(queue), ['a2', 'a3']);

  const model = queueRows(queue, { maxSlots: 6 });
  assert.equal(model.shown[0].position, 1);
  assert.equal(model.shown[0].id, 'a2');
  assert.equal(model.shown[1].position, 2);
  assert.equal(model.shown[1].id, 'a3');
});

test('Given a side of the book is empty, when the queue for that side is read, then an empty queue is returned rather than an error', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100 });

  // No asks at all: there is no best ask to ask about, and no price at which to look.
  assert.equal(bestAsk(book), null);
  assert.deepEqual(queueAt(book, 'ask', 101), []);

  // ...and the view of that empty side is an empty view, not a throw and not a NaN scale.
  const model = queueRows([], { maxSlots: 6 });
  assert.deepEqual(model.shown, []);
  assert.equal(model.hidden, 0);
  assert.equal(model.total, 0);
  assert.equal(model.volume, 0);
  assert.equal(model.maxSize, 0);

  const layout = queueLayout(
    { bid: queueRows(queueAt(book, 'bid', 99), { maxSlots: 6 }), ask: model },
    { height: 600, maxSlots: 6, barSpace: 300 },
  );
  assert.equal(layout.rows.filter((row) => row.side === 'ask').length, 0);
  assert.equal(layout.rows.filter((row) => row.side === 'bid').length, 1);

  // A missing queue altogether reads the same way.
  assert.deepEqual(queueRows(undefined, { maxSlots: 6 }).shown, []);
});

test('Given a queue of orders with differing sizes, when their display widths are computed, then each is proportional to the largest order in that queue and none is negative or NaN', () => {
  const model = queueRows(queueOf(50, 200, 100), { maxSlots: 6 });

  assert.equal(model.maxSize, 200);
  assert.deepEqual(
    model.shown.map((row) => row.fraction),
    [0.25, 1, 0.5],
  );

  const layout = queueLayout(
    { bid: model, ask: queueRows([], { maxSlots: 6 }) },
    { height: 600, maxSlots: 6, barSpace: 300 },
  );
  assert.deepEqual(
    layout.rows.map((row) => row.barWidth),
    [75, 300, 150],
  );

  // Nonsense sizes still have to draw something drawable: zero width, never negative, never
  // NaN, never wider than the space available.
  const odd = queueRows(
    [
      { id: 'z', size: 0 },
      { id: 'n', size: -40 },
      { id: 'x', size: Number.NaN },
      { id: 'ok', size: 80 },
    ],
    { maxSlots: 6 },
  );
  const oddLayout = queueLayout(
    { bid: odd, ask: queueRows([], { maxSlots: 6 }) },
    { height: 600, maxSlots: 6, barSpace: 300 },
  );
  for (const row of oddLayout.rows) {
    assert.ok(Number.isFinite(row.barWidth), `expected a finite width, got ${row.barWidth}`);
    assert.ok(row.barWidth >= 0, `expected a non-negative width, got ${row.barWidth}`);
    assert.ok(row.barWidth <= 300, `expected a width within the space, got ${row.barWidth}`);
    assert.ok(Number.isFinite(row.fraction), `expected a finite fraction, got ${row.fraction}`);
  }

  // A queue where nothing has a size has no scale to divide by, so no bar at all.
  const noScale = queueRows([{ id: 'z', size: 0 }], { maxSlots: 6 });
  assert.equal(noScale.maxSize, 0);
  assert.equal(noScale.shown[0].fraction, 0);
});

test('Given a queue longer than the number of slots available on screen, when it is rendered, then the earliest positions are shown and the overflow is indicated rather than silently dropped', () => {
  const model = queueRows(queueOf(10, 20, 30, 40, 50, 60, 70), { maxSlots: 4 });

  // The earliest positions - the ones that trade next - are the ones kept.
  assert.deepEqual(
    model.shown.map((row) => row.position),
    [1, 2, 3, 4],
  );
  assert.deepEqual(sizesOf(model.shown), [10, 20, 30, 40]);

  // ...and the rest are reported rather than dropped: everything is accounted for.
  assert.equal(model.total, 7);
  assert.equal(model.hidden, 3);
  assert.equal(model.shown.length + model.hidden, model.total);
  assert.equal(model.hiddenVolume, 180);
  assert.equal(model.volume, 280);

  // The scale spans the whole queue, so a shown bar stays proportional to the largest order
  // in the queue even when that order is one of the hidden ones.
  assert.equal(model.maxSize, 70);

  const overflow = formatQueueOverflow(model.hidden, model.hiddenVolume);
  assert.notEqual(overflow, '');
  assert.match(overflow, /3/, 'the number of hidden orders is stated');
  assert.match(overflow, /180/, 'the volume behind them is stated');
  // Nothing hidden means nothing to say.
  assert.equal(formatQueueOverflow(0, 0), '');

  // The layout reserves the slots it was given, and no more.
  const layout = queueLayout(
    { bid: model, ask: model },
    { height: 600, maxSlots: 4, barSpace: 300 },
  );
  assert.equal(layout.rows.length, 8);
});

test('Given the page has been open for a few seconds, when the queue view is watched, then its contents visibly change as orders arrive and fill', () => {
  const state = createSimulation();
  const view = () => JSON.stringify(touchQueues(state));
  const before = view();

  const applied = advance(state, 3000);

  assert.ok(applied > 0, `expected flow to be applied over three seconds, got ${applied} events`);
  assert.notEqual(view(), before);
});

// --- visual expectation ------------------------------------------------------------------

test('Given the queue view, when it is laid out, then the ask queue sits above the centre line and the bid queue below it, with position 1 nearest the touch', () => {
  const bid = queueRows(queueOf(100, 50, 25), { maxSlots: 4 });
  const ask = queueRows(queueOf(40, 60), { maxSlots: 4 });

  const { centreY, rowHeight, rows } = queueLayout(
    { bid, ask },
    { height: 600, maxSlots: 4, barSpace: 300 },
  );

  assert.equal(centreY, 300);
  assert.ok(rowHeight > 0);

  const asks = rows.filter((row) => row.side === 'ask');
  const bids = rows.filter((row) => row.side === 'bid');
  assert.equal(asks.length, 2);
  assert.equal(bids.length, 3);

  assert.ok(
    asks.every((row) => row.y + rowHeight <= centreY),
    'every ask order is drawn above the centre line',
  );
  assert.ok(
    bids.every((row) => row.y >= centreY),
    'every bid order is drawn below the centre line',
  );

  // Position 1 - the one that trades next - is the one against the centre line on each side,
  // which is what makes this read as a zoom into the two rows either side of the ladder's
  // touch. Positions then step away from it in order.
  assert.equal(asks.find((row) => row.position === 1).y, centreY - rowHeight);
  assert.equal(bids.find((row) => row.position === 1).y, centreY);
  assert.deepEqual(
    asks.sort((a, b) => b.y - a.y).map((row) => row.position),
    [1, 2],
  );
  assert.deepEqual(
    bids.sort((a, b) => a.y - b.y).map((row) => row.position),
    [1, 2, 3],
  );
});

test('Given the queue view, when it is viewed, then it carries a plain-language label explaining that these are individual orders waiting their turn (REQ-13)', () => {
  assert.equal(typeof QUEUE_CAPTION, 'string');
  assert.ok(QUEUE_CAPTION.length > 0);
  assert.match(QUEUE_CAPTION, /order/i, 'the label says these are orders');
  assert.match(QUEUE_CAPTION, /turn|waiting|line/i, 'the label says they are waiting their turn');

  // No jargon: the label has to teach a reader with no market-structure background (REQ-13).
  for (const jargon of ['level 3', 'priority', 'liquidity', 'aggregate', 'touch', 'passive']) {
    assert.ok(
      !QUEUE_CAPTION.toLowerCase().includes(jargon),
      `the label should not use the word "${jargon}"`,
    );
  }
});

test('Given a queue position, when it is labelled, then it reads as a rank rather than as another size', () => {
  assert.equal(formatQueuePosition(1), '1st');
  assert.equal(formatQueuePosition(2), '2nd');
  assert.equal(formatQueuePosition(3), '3rd');
  assert.equal(formatQueuePosition(4), '4th');
  assert.equal(formatQueuePosition(11), '11th');
  assert.equal(formatQueuePosition(21), '21st');
});

// --- wiring ------------------------------------------------------------------------------

test('Given the page is loaded, when the queue view is first drawn, then it shows the individual orders resting at the best bid and the best ask', () => {
  const state = createSimulation();
  const queues = touchQueues(state);

  assert.equal(queues.bid.price, bestBid(state.book).price);
  assert.equal(queues.ask.price, bestAsk(state.book).price);
  assert.deepEqual(queues.bid.orders, queueAt(state.book, 'bid', queues.bid.price));
  assert.deepEqual(queues.ask.orders, queueAt(state.book, 'ask', queues.ask.price));
  assert.ok(queues.bid.orders.length > 0, 'the view opens with orders at the best bid');
  assert.ok(queues.ask.orders.length > 0, 'the view opens with orders at the best ask');

  // Every order shown is a separate order at that one price - this is the Level 3 view, not
  // an aggregate (REQ-8).
  for (const order of [...queues.bid.orders, ...queues.ask.orders]) {
    assert.ok(order.id !== undefined && order.id !== null);
    assert.ok(order.size > 0);
  }
  assert.equal(new Set(queues.bid.orders.map((order) => order.id)).size, queues.bid.orders.length);

  assert.ok(Number.isFinite(FLOW.queueSlots) && FLOW.queueSlots > 0);
});

test('Given an empty book, when the touch queues are read, then both sides read as empty rather than raising', () => {
  const state = { book: createBook(), sim: null, clockMs: 0, scheduled: 0 };

  const queues = touchQueues(state);

  assert.equal(queues.bid.price, null);
  assert.equal(queues.ask.price, null);
  assert.deepEqual(queues.bid.orders, []);
  assert.deepEqual(queues.ask.orders, []);
});
