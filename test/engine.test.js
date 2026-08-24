// Tests for LLD-3, written from the ticket's acceptance criteria and PRD REQ-1..4, REQ-7, REQ-8.
// Test names echo the acceptance criteria so each one can be matched back to a line in the ticket.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBook,
  addLimitOrder,
  submitMarketOrder,
  cancelOrder,
  bestBid,
  bestAsk,
  depth,
  queueAt,
} from '../public/src/engine.js';

// A trade compared as price and size only, for the criteria that state a sequence of fills.
const fills = (trades) => trades.map((t) => ({ price: t.price, size: t.size }));

const volumeOf = (book, side, price) =>
  queueAt(book, side, price).reduce((sum, order) => sum + order.size, 0);

// --- REQ-1: limit orders rest individually and join the back of the queue -------------

test('Given an empty book, when a buy limit order of 100 at 99 is submitted, then price level 99 holds one order of size 100 at queue position 1', () => {
  const book = createBook();

  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });

  const queue = queueAt(book, 'bid', 99);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, 'b1');
  assert.equal(queue[0].size, 100);
});

test('Given a bid of 100 at 99, when a second buy limit order of 50 at 99 is submitted, then price level 99 holds two orders totalling 150, and the newer order is at queue position 2', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });

  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 50, ts: 2 });

  const queue = queueAt(book, 'bid', 99);
  assert.equal(queue.length, 2);
  assert.equal(volumeOf(book, 'bid', 99), 150);
  assert.equal(queue[1].id, 'b2');
});

test('Given two orders resting at 99, when the depth ladder is read, then level 99 reports total resting volume 150 and a count of 2 resting orders', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 50, ts: 2 });

  const { bids } = depth(book, 5);

  assert.deepEqual(bids[0], { price: 99, volume: 150, orderCount: 2 });
});

// --- REQ-2: crossing limit orders execute against the queue in order ------------------

test('Given asks at 101 of 40 (queue position 1) and 60 (queue position 2), when a buy limit order of 70 at 101 is submitted, then two trades are produced - 40 then 30, both at 101 - and the remaining ask at 101 has size 30', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 60, ts: 2 });

  const trades = addLimitOrder(book, { id: 't1', side: 'bid', price: 101, size: 70, ts: 3 });

  assert.deepEqual(fills(trades), [
    { price: 101, size: 40 },
    { price: 101, size: 30 },
  ]);
  const queue = queueAt(book, 'ask', 101);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, 'a2');
  assert.equal(queue[0].size, 30);
});

test('Given a single ask of 40 at 101, when a buy limit order of 100 at 101 is submitted, then one trade of 40 at 101 is produced and the remainder of 60 rests as a bid at 101', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });

  const trades = addLimitOrder(book, { id: 't1', side: 'bid', price: 101, size: 100, ts: 2 });

  assert.deepEqual(fills(trades), [{ price: 101, size: 40 }]);
  assert.equal(bestAsk(book), null);
  assert.deepEqual(bestBid(book), { price: 101, volume: 60, orderCount: 1 });
  assert.equal(queueAt(book, 'bid', 101)[0].id, 't1');
});

test('Given asks at 101 of 40 and at 102 of 50, when a buy limit order of 70 at 102 is submitted, then trades of 40 at 101 and 30 at 102 are produced in that order', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 102, size: 50, ts: 2 });

  const trades = addLimitOrder(book, { id: 't1', side: 'bid', price: 102, size: 70, ts: 3 });

  assert.deepEqual(fills(trades), [
    { price: 101, size: 40 },
    { price: 102, size: 30 },
  ]);
});

// --- REQ-3: market orders consume available liquidity ---------------------------------

test('Given asks at 101 of 30 (position 1) and 20 (position 2), and at 102 of 50, when a buy market order of 80 is submitted, then trades of 30 at 101, 20 at 101 and 30 at 102 are produced in that order', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 30, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 20, ts: 2 });
  addLimitOrder(book, { id: 'a3', side: 'ask', price: 102, size: 50, ts: 3 });

  const trades = submitMarketOrder(book, { id: 'm1', side: 'bid', size: 80, ts: 4 });

  assert.deepEqual(fills(trades), [
    { price: 101, size: 30 },
    { price: 101, size: 20 },
    { price: 102, size: 30 },
  ]);
});

test('Given an empty ask side, when a buy market order of 10 is submitted, then no trade is produced and nothing rests on the book', () => {
  const book = createBook();

  const trades = submitMarketOrder(book, { id: 'm1', side: 'bid', size: 10, ts: 1 });

  assert.deepEqual(trades, []);
  assert.equal(bestBid(book), null);
  assert.equal(bestAsk(book), null);
});

test('Given total resting ask volume of 50, when a buy market order of 80 is submitted, then 50 trades away, the ask side is empty, and the unfilled 30 is discarded rather than rested', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 20, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 102, size: 30, ts: 2 });

  const trades = submitMarketOrder(book, { id: 'm1', side: 'bid', size: 80, ts: 3 });

  assert.equal(
    trades.reduce((sum, t) => sum + t.size, 0),
    50,
  );
  assert.equal(bestAsk(book), null);
  assert.equal(bestBid(book), null);
});

// --- REQ-4: individual orders can be cancelled ----------------------------------------

test('Given bids at 99 of 100 (position 1), 50 (position 2) and 25 (position 3), when the position 2 order is cancelled, then level 99 holds two orders totalling 125, and the order formerly at position 3 is now at position 2', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 50, ts: 2 });
  addLimitOrder(book, { id: 'b3', side: 'bid', price: 99, size: 25, ts: 3 });

  cancelOrder(book, 'b2');

  const queue = queueAt(book, 'bid', 99);
  assert.equal(queue.length, 2);
  assert.equal(volumeOf(book, 'bid', 99), 125);
  assert.equal(queue[0].id, 'b1');
  assert.equal(queue[1].id, 'b3');
});

test('Given a single bid of 100 at 99, when that order is cancelled, then cancellation reports success and price level 99 is absent from the book', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });

  const cancelled = cancelOrder(book, 'b1');

  assert.equal(cancelled, true);
  assert.equal(bestBid(book), null);
  assert.deepEqual(depth(book, 5).bids, []);
  assert.deepEqual(queueAt(book, 'bid', 99), []);
});

test('Given bids at 99 of 100 and 50, when the position 1 order is cancelled, then the remaining order is at position 1 and is next to fill', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 50, ts: 2 });

  cancelOrder(book, 'b1');

  assert.equal(queueAt(book, 'bid', 99)[0].id, 'b2');
  const trades = submitMarketOrder(book, { id: 'm1', side: 'ask', size: 10, ts: 3 });
  assert.equal(trades[0].makerOrderId, 'b2');
});

test('Given an empty book, when an unknown order id is cancelled, then cancellation reports failure and the book is unchanged', () => {
  const book = createBook();

  const cancelled = cancelOrder(book, 'nope');

  assert.equal(cancelled, false);
  assert.equal(bestBid(book), null);
  assert.equal(bestAsk(book), null);
  assert.deepEqual(depth(book, 5), { bids: [], asks: [] });
});

test('Given an order that has already been fully filled, when it is cancelled, then cancellation reports failure', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });
  submitMarketOrder(book, { id: 'm1', side: 'bid', size: 40, ts: 2 });

  assert.equal(cancelOrder(book, 'a1'), false);
});

// --- REQ-7: the aggregated read API the depth ladder needs ----------------------------

test('Given a book with five levels a side, when depth is requested for three levels, then exactly three bid levels and three ask levels are returned, best-first', () => {
  const book = createBook();
  for (let i = 0; i < 5; i += 1) {
    addLimitOrder(book, { id: `b${i}`, side: 'bid', price: 99 - i, size: 10, ts: i });
    addLimitOrder(book, { id: `a${i}`, side: 'ask', price: 101 + i, size: 10, ts: 100 + i });
  }

  const { bids, asks } = depth(book, 3);

  assert.equal(bids.length, 3);
  assert.equal(asks.length, 3);
  assert.deepEqual(
    bids.map((l) => l.price),
    [99, 98, 97],
  );
  assert.deepEqual(
    asks.map((l) => l.price),
    [101, 102, 103],
  );
});

test('Given a level holding three orders totalling 220, when depth is returned, then that level reports volume 220 and an order count of 3', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 70, ts: 2 });
  addLimitOrder(book, { id: 'b3', side: 'bid', price: 99, size: 50, ts: 3 });

  const level = depth(book, 5).bids[0];

  assert.equal(level.volume, 220);
  assert.equal(level.orderCount, 3);
});

test('Given fewer populated levels than requested, when depth is returned, then only the populated levels are returned rather than empty placeholders', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 10, ts: 1 });
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 10, ts: 2 });

  const { bids, asks } = depth(book, 10);

  assert.equal(bids.length, 1);
  assert.equal(asks.length, 1);
});

// --- REQ-8: the individual-order read API the queue view needs ------------------------

test('Given a best bid holding three orders, when the queue at that price is read, then three orders are returned in arrival order, position 1 first', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 10, ts: 1 });
  addLimitOrder(book, { id: 'b2', side: 'bid', price: 99, size: 20, ts: 2 });
  addLimitOrder(book, { id: 'b3', side: 'bid', price: 99, size: 30, ts: 3 });

  const queue = queueAt(book, 'bid', bestBid(book).price);

  assert.deepEqual(
    queue.map((o) => o.id),
    ['b1', 'b2', 'b3'],
  );
});

test('Given the order at position 1 of the best ask is fully filled, when the queue is read again, then the order formerly at position 2 is now at position 1', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 60, ts: 2 });

  submitMarketOrder(book, { id: 'm1', side: 'bid', size: 40, ts: 3 });

  assert.equal(queueAt(book, 'ask', 101)[0].id, 'a2');
});

test('Given a side of the book is empty, when the queue for that side is read, then an empty queue is returned rather than an error', () => {
  const book = createBook();

  assert.deepEqual(queueAt(book, 'bid', 99), []);
  assert.deepEqual(queueAt(book, 'ask', 101), []);
});

// --- Engine surface fixed by PRD section 6 --------------------------------------------

test('Given a trade occurs, when it is read, then it carries price, size, ts, aggressor side and the maker and taker order ids', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });

  const [trade] = addLimitOrder(book, { id: 't1', side: 'bid', price: 101, size: 40, ts: 2 });

  assert.equal(trade.price, 101);
  assert.equal(trade.size, 40);
  assert.equal(trade.aggressorSide, 'bid');
  assert.equal(trade.makerOrderId, 'a1');
  assert.equal(trade.takerOrderId, 't1');
  assert.equal(typeof trade.ts, 'number');
});

test('Given a non-crossing limit order, when it is submitted, then no trades are produced and it rests on the book', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40, ts: 1 });

  const trades = addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 50, ts: 2 });

  assert.deepEqual(trades, []);
  assert.deepEqual(bestBid(book), { price: 99, volume: 50, orderCount: 1 });
});
