// Tests for the queue view at the touch: REQ-8, REQ-13, NFR-3.
//
// Written first from the acceptance criteria of LLD-7 and then of LLD-8, which changed the
// shape of this view without changing what it has to say: a queue is no longer a column of
// separate blocks but ONE bar per price level, broken into a segment per resting order. Test
// names echo the criteria so each can be matched back to a line in the ticket. The tests that
// still describe correct behaviour - the engine's queue, the plain-language label, the
// ordinal, the wiring - are carried over unchanged in intent and re-pointed at the new shape.
//
// The canvas cannot be unit tested here, so all of the segment geometry - which orders get a
// segment, how wide each one is, where it starts, what is combined into the tail, and the text
// of each label - is required to be a pure exported function of render.js. What is left in the
// drawing call is stroke-and-fill, verified on the deploy preview.
//
// The surface these tests fix:
//
//   queueSegments(orders, { barWidth, maxSegments, minSegmentWidth })
//                                     -> { segments: Segment[], total, volume, combined,
//                                          barWidth }
//   queueBarLayout({ bid, ask }, { height, barSpace, maxSegments, minSegmentWidth })
//                                     -> { centreY, barHeight, bars: Bar[] }
//   QUEUE_MIN_SEGMENT_WIDTH           -> the stated minimum width of a segment, in px
//   QUEUE_MAX_SEGMENTS                -> how many distinct segments a bar can show
//   formatQueueSegmentLabel(segment)  -> string, the text drawn in one segment
//   formatQueuePosition(position)     -> string, an ordinal rank
//   formatQueueOverflow(hidden, hiddenVolume) -> string, '' when nothing is combined
//   QUEUE_CAPTION                     -> the plain-language label of REQ-13
//   QUEUE_LEVEL_CAPTION               -> the label saying what one bar is
//   touchQueues(state)                -> { bid: { price, orders }, ask: { price, orders } }
//
// Segment is { position, id, size, orders, x, width, fraction, combined, leading } - `orders`
// being how many resting orders that one segment stands for, 1 for all but the combined tail.
// Position 1 is the order next to trade, and its segment leads the bar.

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
  queueSegments,
  queueBarLayout,
  formatQueueSegmentLabel,
  formatQueuePosition,
  formatQueueOverflow,
  QUEUE_CAPTION,
  QUEUE_LEVEL_CAPTION,
  QUEUE_MIN_SEGMENT_WIDTH,
  QUEUE_MAX_SEGMENTS,
} from '../public/src/render.js';
import { FLOW, createSimulation, advance, touchQueues } from '../public/src/app.js';

const sizesOf = (orders) => orders.map((order) => order.size);
const idsOf = (orders) => orders.map((order) => order.id);
const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);

// A queue of plain orders, as queueAt returns them, with the sizes given in arrival order.
const queueOf = (...sizes) =>
  sizes.map((size, index) => ({ id: `o${index + 1}`, side: 'bid', price: 99, size, ts: index }));

// Widths are floating point, so "sums to the bar width" is asserted to within a pixel's
// millionth rather than bit-for-bit.
const closeTo = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message}: expected ${expected}, got ${actual}`,
  );

// --- acceptance criteria -----------------------------------------------------------------

test('Given a best bid holding four orders, when the queue bar is laid out, then it produces four adjacent segments whose widths sum to the full bar width', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'first', side: 'bid', price: 99, size: 40 });
  addLimitOrder(book, { id: 'second', side: 'bid', price: 99, size: 30 });
  addLimitOrder(book, { id: 'third', side: 'bid', price: 99, size: 20 });
  addLimitOrder(book, { id: 'fourth', side: 'bid', price: 99, size: 10 });

  const queue = queueAt(book, 'bid', bestBid(book).price);
  const { segments } = queueSegments(queue, { barWidth: 400, maxSegments: 8 });

  assert.equal(segments.length, 4);
  assert.deepEqual(
    segments.map((segment) => [segment.position, segment.id]),
    [
      [1, 'first'],
      [2, 'second'],
      [3, 'third'],
      [4, 'fourth'],
    ],
  );

  // Adjacent: each segment starts exactly where the one in front of it ends, no gaps and no
  // overlaps in the geometry. Any visible gap between them is drawn inside the segment.
  assert.equal(segments[0].x, 0);
  for (let i = 1; i < segments.length; i += 1) {
    closeTo(segments[i].x, segments[i - 1].x + segments[i - 1].width, `segment ${i} joins the one before it`);
  }

  // ...and together they are the whole bar: the level is one bar, not four bars.
  closeTo(sum(segments.map((segment) => segment.width)), 400, 'the segments fill the bar');
  closeTo(segments.at(-1).x + segments.at(-1).width, 400, 'the last segment ends at the bar edge');
});

test("Given a queue of orders with differing sizes, when segment widths are computed, then each segment's width is proportional to its order's share of the level's total volume", () => {
  // 50 + 200 + 100 = 350, drawn across 350px, so a unit of volume is a pixel and the expected
  // widths can be read straight off the sizes.
  const { segments, volume } = queueSegments(queueOf(50, 200, 100), { barWidth: 350, maxSegments: 8 });

  assert.equal(volume, 350);
  assert.deepEqual(segments.map((segment) => segment.width), [50, 200, 100]);
  assert.deepEqual(segments.map((segment) => segment.x), [0, 50, 250]);
  assert.deepEqual(segments.map((segment) => segment.fraction), [50 / 350, 200 / 350, 100 / 350]);

  // The share is of the level's total, not of the largest order in it, so the same queue drawn
  // in half the room is the same picture at half the size.
  const narrow = queueSegments(queueOf(50, 200, 100), { barWidth: 175, maxSegments: 8 });
  assert.deepEqual(narrow.segments.map((segment) => segment.width), [25, 100, 50]);
  closeTo(sum(narrow.segments.map((segment) => segment.width)), 175, 'the narrow bar is still full');

  // Sizes that are not sizes still have to draw something drawable: never negative, never NaN,
  // never wider than the bar.
  const odd = queueSegments(
    [{ id: 'z', size: 0 }, { id: 'n', size: -40 }, { id: 'x', size: Number.NaN }, { id: 'ok', size: 80 }],
    { barWidth: 300, maxSegments: 8 },
  );
  for (const segment of odd.segments) {
    assert.ok(Number.isFinite(segment.width), `expected a finite width, got ${segment.width}`);
    assert.ok(segment.width >= 0, `expected a non-negative width, got ${segment.width}`);
    assert.ok(segment.width <= 300, `expected a width within the bar, got ${segment.width}`);
    assert.ok(Number.isFinite(segment.x) && segment.x >= 0, `expected a finite start, got ${segment.x}`);
  }
  closeTo(sum(odd.segments.map((segment) => segment.width)), 300, 'odd sizes still fill the bar');

  // A queue whose orders all have no size has no proportions to divide by, so the bar is
  // shared equally rather than collapsing to nothing or to NaN.
  const noVolume = queueSegments(queueOf(0, 0), { barWidth: 300, maxSegments: 8 });
  assert.deepEqual(noVolume.segments.map((segment) => segment.width), [150, 150]);

  // No bar to lay out is not an error either.
  const noRoom = queueSegments(queueOf(10, 20), { barWidth: 0, maxSegments: 8 });
  assert.deepEqual(noRoom.segments.map((segment) => segment.width), [0, 0]);
});

test('Given an empty queue, when the bar is laid out, then it produces no segments and no error', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100 });

  // No asks at all: there is no best ask to ask about, and no price at which to look.
  assert.equal(bestAsk(book), null);
  assert.deepEqual(queueAt(book, 'ask', 101), []);

  const model = queueSegments([], { barWidth: 300, maxSegments: 8 });
  assert.deepEqual(model.segments, []);
  assert.equal(model.total, 0);
  assert.equal(model.volume, 0);
  assert.equal(model.combined, 0);

  // A missing queue altogether reads the same way.
  assert.deepEqual(queueSegments(undefined, { barWidth: 300, maxSegments: 8 }).segments, []);

  // ...and the empty side contributes no bar, while the populated one still does.
  const layout = queueBarLayout(
    { bid: { price: 99, orders: queueAt(book, 'bid', 99) }, ask: { price: null, orders: [] } },
    { height: 600, barSpace: 300, maxSegments: 8 },
  );
  assert.equal(layout.bars.filter((bar) => bar.side === 'ask').length, 0);
  assert.equal(layout.bars.filter((bar) => bar.side === 'bid').length, 1);

  // And no queues at all is still a drawable layout rather than a throw.
  assert.deepEqual(queueBarLayout(undefined, { height: 600, barSpace: 300 }).bars, []);
});

test('Given a queue containing an order too small to be visible at the current bar width, when segments are computed, then that segment is given a stated minimum width and the remaining segments still sum to the full bar width', () => {
  // The minimum is stated by the module rather than chosen by the caller, so the same sliver
  // is the same width in every bar on screen.
  assert.ok(
    Number.isFinite(QUEUE_MIN_SEGMENT_WIDTH) && QUEUE_MIN_SEGMENT_WIDTH > 0,
    'the minimum segment width is a stated positive number',
  );

  // One order of 1 against three of 1000: its true share of a 300px bar is a third of a pixel.
  const { segments } = queueSegments(queueOf(1000, 1000, 1000, 1), {
    barWidth: 300,
    maxSegments: 8,
    minSegmentWidth: 8,
  });

  assert.equal(segments.length, 4);
  assert.equal(segments[3].width, 8, 'the sliver is widened to the stated minimum');
  for (const segment of segments) {
    assert.ok(segment.width >= 8, `every segment is at least the minimum, got ${segment.width}`);
  }

  // The room it was given comes off the others in proportion; the bar is still exactly full.
  closeTo(sum(segments.map((segment) => segment.width)), 300, 'the bar is still full');
  closeTo(segments[0].width, 292 / 3, 'the big segments give up the room in proportion');
  closeTo(segments.at(-1).x + segments.at(-1).width, 300, 'the last segment ends at the bar edge');

  // With no default given, the stated minimum is the one that applies.
  const stated = queueSegments(queueOf(1000, 1), { barWidth: 300, maxSegments: 8 });
  assert.equal(stated.segments[1].width, QUEUE_MIN_SEGMENT_WIDTH);
  closeTo(sum(stated.segments.map((segment) => segment.width)), 300, 'the bar is still full');

  // A bar with no room for every segment at its minimum shares what there is equally, rather
  // than drawing segments off the end of it.
  const cramped = queueSegments(queueOf(100, 1, 1, 1, 1), { barWidth: 20, minSegmentWidth: 8 });
  closeTo(sum(cramped.segments.map((segment) => segment.width)), 20, 'the cramped bar is still full');
  for (const segment of cramped.segments) {
    assert.ok(segment.width > 0, 'a cramped segment is still drawn');
    assert.ok(segment.x + segment.width <= 20 + 1e-6, 'no segment runs off the end of the bar');
  }
});

test('Given more orders than can be shown as distinct segments, when the bar is laid out, then the earliest orders get their own segments and the remainder is combined into a single trailing segment labelled with how many orders it represents', () => {
  const model = queueSegments(queueOf(10, 20, 30, 40, 50, 60, 70), { barWidth: 280, maxSegments: 4 });

  assert.equal(model.segments.length, 4);
  assert.equal(model.total, 7);

  // The earliest orders - the ones that trade next - are the ones that keep their own segment.
  const distinct = model.segments.filter((segment) => !segment.combined);
  assert.deepEqual(distinct.map((segment) => segment.position), [1, 2, 3]);
  assert.deepEqual(distinct.map((segment) => segment.id), ['o1', 'o2', 'o3']);
  assert.deepEqual(distinct.map((segment) => segment.orders), [1, 1, 1]);

  // The rest are one segment, at the back of the bar, and nothing is dropped: the combined
  // segment carries the count and the volume of everything behind it.
  const tail = model.segments.at(-1);
  assert.equal(tail.combined, true);
  assert.equal(tail.orders, 4);
  assert.equal(tail.size, 220);
  assert.equal(tail.position, 4);
  assert.equal(model.combined, 4);
  assert.equal(sum(model.segments.map((segment) => segment.orders)), model.total);
  assert.equal(model.volume, 280);

  // It is labelled with how many orders it stands for.
  const label = formatQueueSegmentLabel(tail);
  assert.match(label, /4/, 'the combined segment says how many orders it represents');
  assert.match(label, /order/i, 'the combined segment says they are orders');

  // A segment that is one order is labelled with that order's volume instead.
  assert.equal(formatQueueSegmentLabel(model.segments[1]), '20');

  // Everything is still proportional and the bar is still exactly full.
  assert.deepEqual(model.segments.map((segment) => segment.width), [10, 20, 30, 220]);
  closeTo(sum(model.segments.map((segment) => segment.width)), 280, 'the bar is still full');

  // A queue that fits keeps every order distinct, with no combined tail at all.
  const fits = queueSegments(queueOf(10, 20, 30, 40), { barWidth: 100, maxSegments: 4 });
  assert.equal(fits.combined, 0);
  assert.ok(fits.segments.every((segment) => segment.combined === false));
  assert.equal(formatQueueOverflow(fits.combined, 0), '', 'nothing combined means nothing to say');

  // The note under the bar says the same thing in a sentence, for a segment too narrow to hold
  // its own label.
  const note = formatQueueOverflow(model.combined, tail.size);
  assert.match(note, /4/, 'the number of combined orders is stated');
  assert.match(note, /220/, 'the volume behind them is stated');

  // How many segments a bar shows is stated by the module, and is more than one.
  assert.ok(Number.isFinite(QUEUE_MAX_SEGMENTS) && QUEUE_MAX_SEGMENTS > 1);
});

test('Given the page has been open for a few seconds, when the queue bars are watched, then segments visibly disappear as orders fill and new ones appear at the far end', () => {
  const state = createSimulation();
  const segmentIds = () => {
    const queues = touchQueues(state);
    return ['bid', 'ask'].flatMap((side) =>
      queueSegments(queues[side].orders, { barWidth: 400 }).segments.map(
        (segment) => `${side}:${segment.id}`,
      ),
    );
  };

  const before = segmentIds();
  assert.ok(before.length > 0, 'the view opens with segments to watch');

  const applied = advance(state, 3000);
  assert.ok(applied > 0, `expected flow to be applied over three seconds, got ${applied} events`);

  const after = segmentIds();
  assert.ok(
    before.some((id) => !after.includes(id)),
    'orders that were resting have gone, so segments have disappeared',
  );
  assert.ok(
    after.some((id) => !before.includes(id)),
    'orders that were not resting have arrived, so new segments have appeared',
  );
});

// --- visual expectation ------------------------------------------------------------------

test('Given the queue view, when it is laid out, then the best ask is one bar above the centre line and the best bid one bar below it', () => {
  const layout = queueBarLayout(
    { bid: { price: 99, orders: queueOf(100, 50, 25) }, ask: { price: 101, orders: queueOf(40, 60) } },
    { height: 600, barSpace: 300, maxSegments: 8 },
  );

  assert.equal(layout.centreY, 300);
  assert.ok(layout.barHeight > 0);
  assert.equal(layout.bars.length, 2, 'one bar a side, not one bar an order');

  const ask = layout.bars.find((bar) => bar.side === 'ask');
  const bid = layout.bars.find((bar) => bar.side === 'bid');

  assert.ok(ask.y + ask.height <= layout.centreY, 'the sellers bar is drawn above the centre line');
  assert.ok(bid.y >= layout.centreY, 'the buyers bar is drawn below the centre line');

  assert.equal(ask.price, 101);
  assert.equal(bid.price, 99);
  assert.equal(ask.segments.length, 2);
  assert.equal(bid.segments.length, 3);
  assert.equal(ask.width, 300);
  closeTo(sum(bid.segments.map((segment) => segment.width)), 300, 'the bid bar is full');
});

test('Given a queue bar, when it is drawn, then the segment that trades next is the leading one', () => {
  const { segments } = queueSegments(queueOf(100, 50, 25), { barWidth: 300, maxSegments: 8 });

  // By position: it starts the bar, so both bars lead from the same edge and "first in line"
  // is somewhere a reader can look rather than something they have to work out.
  assert.equal(segments[0].position, 1);
  assert.equal(segments[0].x, 0);

  // ...and it is flagged, so the drawing can give it emphasis as well as position (NFR-3).
  assert.equal(segments[0].leading, true);
  assert.ok(segments.slice(1).every((segment) => segment.leading === false));
});

test('Given the queue view, when it is viewed, then it carries a plain-language label explaining that these are individual orders waiting their turn (REQ-13)', () => {
  assert.equal(typeof QUEUE_CAPTION, 'string');
  assert.ok(QUEUE_CAPTION.length > 0);
  assert.match(QUEUE_CAPTION, /order/i, 'the label says these are orders');
  assert.match(QUEUE_CAPTION, /turn|waiting|line/i, 'the label says they are waiting their turn');

  // No jargon: the label has to teach a reader with no market-structure background (REQ-13).
  for (const caption of [QUEUE_CAPTION, QUEUE_LEVEL_CAPTION]) {
    for (const jargon of ['level 3', 'priority', 'liquidity', 'aggregate', 'touch', 'passive']) {
      assert.ok(
        !caption.toLowerCase().includes(jargon),
        `the label should not use the word "${jargon}"`,
      );
    }
  }
});

test('Given the queue view, when it is viewed, then a plain-language label makes the relationship explicit - this is what one price level is made of', () => {
  assert.equal(typeof QUEUE_LEVEL_CAPTION, 'string');
  assert.ok(QUEUE_LEVEL_CAPTION.length > 0);
  assert.match(QUEUE_LEVEL_CAPTION, /price/i, 'the label says the bar is one price');
  assert.match(QUEUE_LEVEL_CAPTION, /made (up )?of|each part|every part|split|divided/i,
    'the label says what the bar is made of');
});

test('Given a queue position, when it is labelled, then it reads as a rank rather than as another size', () => {
  assert.equal(formatQueuePosition(1), '1st');
  assert.equal(formatQueuePosition(2), '2nd');
  assert.equal(formatQueuePosition(3), '3rd');
  assert.equal(formatQueuePosition(4), '4th');
  assert.equal(formatQueuePosition(11), '11th');
  assert.equal(formatQueuePosition(21), '21st');
});

// --- engine behaviour the view reads (REQ-8) ---------------------------------------------

test('Given a best bid holding three orders, when the queue at that price is read, then three orders are returned in arrival order, position 1 first', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'first', side: 'bid', price: 99, size: 100 });
  addLimitOrder(book, { id: 'second', side: 'bid', price: 99, size: 50 });
  addLimitOrder(book, { id: 'third', side: 'bid', price: 99, size: 25 });

  const queue = queueAt(book, 'bid', bestBid(book).price);

  assert.equal(queue.length, 3);
  assert.deepEqual(idsOf(queue), ['first', 'second', 'third']);
  assert.deepEqual(sizesOf(queue), [100, 50, 25]);

  // ...and the bar numbers them from 1, in that same order, along its length.
  const { segments } = queueSegments(queue, { barWidth: 350, maxSegments: 8 });
  assert.deepEqual(
    segments.map((segment) => [segment.position, segment.id]),
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

  const { segments } = queueSegments(queue, { barWidth: 300, maxSegments: 8 });
  assert.equal(segments[0].position, 1);
  assert.equal(segments[0].id, 'a2');
  assert.equal(segments[0].leading, true);
  assert.equal(segments[1].position, 2);
  assert.equal(segments[1].id, 'a3');
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

  assert.ok(Number.isFinite(FLOW.queueSegments) && FLOW.queueSegments > 1);
});

test('Given an empty book, when the touch queues are read, then both sides read as empty rather than raising', () => {
  const state = { book: createBook(), sim: null, clockMs: 0, scheduled: 0 };

  const queues = touchQueues(state);

  assert.equal(queues.bid.price, null);
  assert.equal(queues.ask.price, null);
  assert.deepEqual(queues.bid.orders, []);
  assert.deepEqual(queues.ask.orders, []);
});
