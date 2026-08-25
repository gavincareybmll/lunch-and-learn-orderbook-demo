// Tests for the trade tape: REQ-9, NFR-3, NFR-4.
//
// Written first from the acceptance criteria of LLD-9 and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched back to a line
// in the ticket.
//
// The list on the page cannot be unit tested here, and adding a DOM would break NFR-2. So
// everything the tape depends on that could be silently wrong - which trades become entries,
// their order, what is discarded when the tape is full, and the text of a row - is required
// here as a pure exported function of render.js. The tape holds no state of its own:
// recordTrades takes the entries it is given and returns the new list, so the list lives in
// app.js with the rest of the simulation state.
//
// The surface these tests fix:
//
//   TAPE_LIMIT                                  -> the default bound on the tape
//   recordTrades(entries, trades, { limit, timeMs })
//                                               -> Entry[], newest first, at most `limit`
//   formatAggressor(side)                       -> string, which side caused the trade
//   formatTapeTime(timeMs)                      -> string, when it happened
//   tradeTape(state)                            -> Entry[] for the running page
//   FLOW.tapeEntries                            -> the bound the page runs with
//
// Entry is { price, size, aggressorSide, timeMs } - one executed trade, never a combination
// of several (REQ-9).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBook, addLimitOrder, submitMarketOrder } from '../public/src/engine.js';
import {
  TAPE_LIMIT,
  recordTrades,
  formatAggressor,
  formatTapeTime,
  formatPrice,
  formatVolume,
} from '../public/src/render.js';
import { FLOW, createSimulation, advance, tradeTape } from '../public/src/app.js';

const sizesOf = (entries) => entries.map((entry) => entry.size);

// --- acceptance criteria ---------------------------------------------------------------

test('Given a tape bounded to 50 entries, when 60 trades occur, then the tape holds 50 entries and the oldest 10 have been discarded', () => {
  let tape = [];
  for (let i = 1; i <= 60; i += 1) {
    // Size identifies the trade, so which ten were discarded is checkable.
    tape = recordTrades(tape, [{ price: 100, size: i, aggressorSide: 'bid' }], { limit: 50 });
  }

  assert.equal(tape.length, 50);

  // Newest first, so the tape runs 60 down to 11 and trades 1 to 10 have gone.
  assert.deepEqual(sizesOf(tape), Array.from({ length: 50 }, (unused, i) => 60 - i));
  for (let i = 1; i <= 10; i += 1) {
    assert.ok(!sizesOf(tape).includes(i), `trade ${i} has been discarded`);
  }
});

test('Given a single incoming order that fills against three resting orders, when the tape is read, then three separate trades are shown, not one combined entry', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'a1', side: 'ask', price: 101, size: 40 });
  addLimitOrder(book, { id: 'a2', side: 'ask', price: 101, size: 30 });
  addLimitOrder(book, { id: 'a3', side: 'ask', price: 101, size: 20 });

  const trades = addLimitOrder(book, { id: 'taker', side: 'bid', price: 101, size: 90 });
  assert.equal(trades.length, 3, 'the engine reports one trade per resting order taken');

  const tape = recordTrades([], trades, { limit: 50 });

  assert.equal(tape.length, 3, 'three entries, not one combined entry of 90');
  assert.deepEqual(sizesOf(tape), [20, 30, 40], 'each entry is one fill, newest first');
  assert.ok(!sizesOf(tape).includes(90), 'the three fills are not summed into one row');
});

test('Given a trade occurs, when the tape is read, then the newest trade is first', () => {
  const first = recordTrades([], [{ price: 100, size: 10, aggressorSide: 'bid' }], { limit: 50 });
  const second = recordTrades(first, [{ price: 101, size: 20, aggressorSide: 'ask' }], { limit: 50 });

  assert.deepEqual(sizesOf(second), [20, 10]);

  // ...including several trades from one event: the last to execute leads the tape.
  const batch = recordTrades([], [
    { price: 100, size: 1, aggressorSide: 'bid' },
    { price: 100, size: 2, aggressorSide: 'bid' },
    { price: 101, size: 3, aggressorSide: 'bid' },
  ], { limit: 50 });
  assert.deepEqual(sizesOf(batch), [3, 2, 1]);
});

test('Given a trade, when its tape entry is built, then it carries price, size and the side of the order that caused it', () => {
  const book = createBook();
  addLimitOrder(book, { id: 'b1', side: 'bid', price: 99, size: 25 });
  const trades = submitMarketOrder(book, { id: 'seller', side: 'ask', size: 25 });

  const [entry] = recordTrades([], trades, { limit: 50, timeMs: 4000 });

  assert.equal(entry.price, 99);
  assert.equal(entry.size, 25);
  assert.equal(entry.aggressorSide, 'ask', 'the aggressor was the incoming sell order');
  assert.equal(entry.timeMs, 4000, 'and when it happened (REQ-9)');

  // A buy aggressor is carried the same way round.
  const buyBook = createBook();
  addLimitOrder(buyBook, { id: 'a1', side: 'ask', price: 101, size: 15 });
  const [buy] = recordTrades([], submitMarketOrder(buyBook, { id: 'buyer', side: 'bid', size: 15 }), {
    limit: 50,
  });
  assert.equal(buy.aggressorSide, 'bid');
  assert.equal(buy.price, 101);
  assert.equal(buy.size, 15);
});

test('Given the page has been open for a few seconds, when the tape is watched, then new trades appear at the top and older ones fall off the bottom', () => {
  const state = createSimulation();

  advance(state, 3000);
  const early = tradeTape(state);
  assert.ok(early.length > 0, 'trades print as they happen');
  assert.ok(early.length <= FLOW.tapeEntries);

  // Long enough for the tape to fill, so that something has to fall off the bottom.
  for (let i = 0; i < 60; i += 1) advance(state, 1000);
  const full = tradeTape(state);
  assert.equal(full.length, FLOW.tapeEntries, 'the tape fills to its bound and stops growing');

  const wasNewest = full[0];
  const wasOldest = full.at(-1);

  for (let i = 0; i < 60; i += 1) advance(state, 1000);
  const later = tradeTape(state);

  assert.equal(later.length, FLOW.tapeEntries, 'still bounded (NFR-4)');
  assert.notEqual(later[0], wasNewest, 'a newer trade has taken the top');
  assert.ok(!later.includes(wasOldest), 'the oldest entry has fallen off the bottom');
  assert.ok(
    !later.includes(wasNewest) || later.indexOf(wasNewest) > 0,
    'the entry that was at the top has moved down the tape',
  );

  // Newest first at all times: the times down the tape never increase.
  const times = later.map((entry) => entry.timeMs);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'the tape runs newest to oldest');
});

// --- NFR-3: distinguishable by aggressor, and not by colour alone -------------------------

test('Given a trade, when its row is written, then which side was the aggressor is said in words rather than by colour alone', () => {
  const buy = formatAggressor('bid');
  const sell = formatAggressor('ask');

  assert.ok(/[a-z]/i.test(buy), `expected a word, got ${JSON.stringify(buy)}`);
  assert.ok(/[a-z]/i.test(sell), `expected a word, got ${JSON.stringify(sell)}`);
  assert.notEqual(buy, sell, 'the two sides read differently');
  assert.equal(buy, 'Buy');
  assert.equal(sell, 'Sell');
});

test('Given a tape entry, when its row is written, then price, size and time are legible without jargon', () => {
  assert.equal(formatPrice(101), '101.00');
  assert.equal(formatVolume(1500), '1,500');

  assert.equal(formatTapeTime(0), '0:00');
  assert.equal(formatTapeTime(9000), '0:09');
  assert.equal(formatTapeTime(65000), '1:05');
  assert.equal(formatTapeTime(605000), '10:05');

  // Nothing to say rather than a misleading zero.
  assert.equal(formatTapeTime(undefined), '-');
  assert.equal(formatTapeTime(Number.NaN), '-');
});

// --- NFR-4: the tape cannot grow without limit --------------------------------------------

test('Given no bound is given, when trades are recorded, then the tape is still bounded by a stated default', () => {
  assert.ok(Number.isInteger(TAPE_LIMIT) && TAPE_LIMIT > 0, 'the default bound is stated');
  assert.ok(Number.isInteger(FLOW.tapeEntries) && FLOW.tapeEntries > 0, 'the page runs bounded');

  let tape = [];
  for (let i = 0; i < TAPE_LIMIT + 25; i += 1) {
    tape = recordTrades(tape, [{ price: 100, size: 10, aggressorSide: 'bid' }]);
  }

  assert.equal(tape.length, TAPE_LIMIT);
});

test('Given an event that traded nothing, when it is recorded, then the tape is unchanged', () => {
  const tape = recordTrades([], [{ price: 100, size: 10, aggressorSide: 'bid' }], { limit: 50 });

  assert.deepEqual(recordTrades(tape, [], { limit: 50 }), tape);
  assert.equal(recordTrades(tape, undefined, { limit: 50 }).length, 1);
});
