// Tests for LLD-4, written from the ticket's acceptance criteria and PRD section 5 (INV-1..INV-6).
// Test names echo the acceptance criteria so each one can be matched back to a line in the ticket.
//
// Two kinds of test live here:
//
//   - the harness runs: randomised flow through the engine, with all six invariants asserted
//     after every operation;
//   - the "the guard is real" tests: a book manipulated directly into a state that breaks an
//     invariant, proving the check fires. An invariant that never fires is indistinguishable
//     from one that cannot fire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBook, addLimitOrder } from '../public/src/engine.js';
import { INVARIANTS, invariant, checkInvariants, snapshotBook } from './support/invariants.js';
import { runRandomFlow } from './support/random-flow.js';

const IDS = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6'];

// A book with three asks queued at one price, used by the direct-manipulation tests.
const bookWithAskQueue = () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 10, ts: 1 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 20, ts: 2 });
  addLimitOrder(book, { id: 'a3', side: 'ask', price: 101, size: 30, ts: 3 });
  return book;
};

// --- the harness ----------------------------------------------------------------------

test('Given a seed, when the harness runs a randomised sequence of limit orders, market orders and cancellations against a book, then all six invariants are asserted after every single operation', () => {
  const run = runRandomFlow(20260824, { operations: 400 });

  const types = new Set(run.operations.map((op) => op.type));
  assert.deepEqual([...types].sort(), ['cancel', 'limit', 'market'], 'all three operation types occur');

  assert.equal(run.operations.length, 400);
  assert.equal(run.checks.length, run.operations.length, 'one set of checks per operation');
  for (const [index, checked] of run.checks.entries()) {
    assert.deepEqual(checked, IDS, `all six invariants asserted after operation ${index}`);
  }
});

test('Given the same seed run twice, when the operation sequences are compared, then they are identical', () => {
  const first = runRandomFlow(4242, { operations: 400 });
  const second = runRandomFlow(4242, { operations: 400 });

  assert.deepEqual(second.operations, first.operations);
});

test('Given two different seeds, when the operation sequences are compared, then they differ', () => {
  const first = runRandomFlow(4242, { operations: 400 });
  const second = runRandomFlow(4243, { operations: 400 });

  assert.notDeepEqual(second.operations, first.operations);
});

test('Given node --test is run, when the suite completes, then the invariant tests have run alongside the existing engine tests and all pass', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const run = runRandomFlow(seed, { operations: 300 });
    assert.equal(run.checks.length, 300, `seed ${seed} completed without an invariant failure`);
  }
});

// --- the guards are real: each invariant is shown to fire ------------------------------

test('Given a book manipulated directly so that the best bid is greater than or equal to the best ask, when INV-1 is checked, then it fails and the message names the crossed prices', () => {
  const crossedAt = (askPrice) => {
    const book = createBook();
    addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });
    addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 100, ts: 2 });

    // Move the resting ask under the bid without going through matching, which would
    // otherwise make this state unreachable.
    const [ask] = book.asks.get(101);
    ask.price = askPrice;
    book.asks.delete(101);
    book.asks.set(askPrice, [ask]);
    return book;
  };

  const strictlyCrossed = invariant('INV-1').check({ book: crossedAt(98) });
  assert.ok(strictlyCrossed, 'INV-1 fails when the best bid is above the best ask');
  assert.match(strictlyCrossed, /\b99\b/);
  assert.match(strictlyCrossed, /\b98\b/);

  const locked = invariant('INV-1').check({ book: crossedAt(99) });
  assert.ok(locked, 'INV-1 fails when the best bid equals the best ask');
  assert.match(locked, /\b99\b/);
});

test("Given a book manipulated directly so that a price level's queue positions have a gap, when INV-6 is checked, then it fails", () => {
  const book = bookWithAskQueue();

  // Position 2 vanishes, leaving positions 1 and 3 - the queue no longer runs contiguously.
  delete book.asks.get(101)[1];

  assert.ok(invariant('INV-6').check({ book }), 'INV-6 fails on a gap in the queue');
});

test('Given a book manipulated directly so that one order rests at two price levels, when INV-6 is checked, then it fails', () => {
  const book = bookWithAskQueue();

  const [a1] = book.asks.get(101);
  book.asks.set(102, [a1]);

  assert.ok(invariant('INV-6').check({ book }), 'INV-6 fails when an order appears twice');
});

test('Given a trade that fills against a resting order while an older order at the same price is still resting, when INV-3 is checked, then it fails', () => {
  const book = bookWithAskQueue();
  const before = snapshotBook(book);

  // a2 filled ahead of a1, which arrived earlier at the same price.
  const trades = [
    { price: 101, size: 20, ts: 4, aggressorSide: 'bid', makerOrderId: 'a2', takerOrderId: 't1' },
  ];

  assert.ok(
    invariant('INV-3').check({
      book,
      before,
      trades,
      operation: { type: 'market', side: 'bid', size: 20, id: 't1' },
    }),
    'INV-3 fails when queue order is not respected',
  );
});

test('Given a trade at a price worse than the best available on the passive side, when INV-4 is checked, then it fails', () => {
  const book = bookWithAskQueue();
  addLimitOrder(book, { id: 'a4', side: 'ask', price: 102, size: 50, ts: 4 });
  const before = snapshotBook(book);

  // 101 was available, so executing at 102 is a trade-through.
  const trades = [
    { price: 102, size: 50, ts: 5, aggressorSide: 'bid', makerOrderId: 'a4', takerOrderId: 't1' },
  ];

  assert.ok(
    invariant('INV-4').check({
      book,
      before,
      trades,
      operation: { type: 'market', side: 'bid', size: 50, id: 't1' },
    }),
    'INV-4 fails on a trade-through',
  );
});

test('Given trades reporting size that the passive side did not give up, when INV-2 is checked, then it fails', () => {
  const book = bookWithAskQueue();
  const before = snapshotBook(book);

  // The book is untouched, so no resting size was consumed - the reported fill is invented.
  const trades = [
    { price: 101, size: 10, ts: 4, aggressorSide: 'bid', makerOrderId: 'a1', takerOrderId: 't1' },
  ];

  assert.ok(
    invariant('INV-2').check({
      book,
      before,
      trades,
      operation: { type: 'market', side: 'bid', size: 10, id: 't1' },
    }),
    'INV-2 fails when traded size does not match the reduction in resting size',
  );
});

test('Given a resting order whose size has been driven to zero, when INV-5 is checked, then it fails', () => {
  const book = bookWithAskQueue();

  book.asks.get(101)[0].size = 0;

  assert.ok(invariant('INV-5').check({ book }), 'INV-5 fails on a zero-sized resting order');
});

// --- reporting ------------------------------------------------------------------------

test('Given any invariant failure, when it is reported, then the message contains the seed and the operation index needed to reproduce it', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 100, ts: 1 });

  const [bid] = book.bids.get(99);
  book.asks.set(98, [{ ...bid, id: 'a1', side: 'ask', price: 98 }]);

  assert.throws(
    () => checkInvariants({ book, seed: 987654, opIndex: 41 }),
    (error) => {
      assert.match(error.message, /INV-1/);
      assert.match(error.message, /\b987654\b/, 'the message carries the seed');
      assert.match(error.message, /\b41\b/, 'the message carries the operation index');
      return true;
    },
  );
});

test('Given the six invariants of PRD section 5, when the harness is inspected, then each one is defined and checked', () => {
  assert.deepEqual(INVARIANTS.map((inv) => inv.id), IDS);
  for (const inv of INVARIANTS) {
    assert.equal(typeof inv.check, 'function');
    assert.ok(inv.title, `${inv.id} carries a title`);
  }
});
