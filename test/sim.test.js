// Tests for LLD-5, written from the ticket's acceptance criteria and PRD REQ-5, REQ-6 and
// section 5. Test names echo the acceptance criteria so each one can be matched back to a
// line in the ticket.
//
// PRD section 6 fixes two exports, createSim(seed, config) and step(sim, book), and step
// returns only trades. Several criteria are about the *events* rather than their trades -
// counting event types, comparing two sequences, checking that a cancellation names a
// resting order - so the sim must also make the event it has just applied observable. These
// tests require it as `sim.lastEvent`: an object carrying `type` ('limit' | 'market' |
// 'cancel') and `id`, plus `side` and `size` for orders and `price` for limit orders. That
// is the shape PRD section 5's invariant checks already describe an operation with.
//
// The statistical criteria are asserted over several seeds. A distribution property that
// holds only for the one seed it was tuned against is not the property the ticket asked for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBook, bestBid, bestAsk, depth, queueAt } from '../public/src/engine.js';
import { createSim, step } from '../public/src/sim.js';
import { checkInvariants, snapshotBook } from './support/invariants.js';

const EVENTS = 5000;
const SEEDS = [1, 20260824, 987654321];

// --- driving the generator -------------------------------------------------------------

// Run a fresh sim against a fresh book, handing each applied event to `onStep` along with
// the state it was applied to. `snapshot` is opt-in because only the invariant test needs
// the before-state, and taking it on every step is the expensive part.
function drive(seed, events, { config, onStep, snapshot = false } = {}) {
  const sim = createSim(seed, config);
  const book = createBook();

  for (let index = 0; index < events; index += 1) {
    const before = snapshot ? snapshotBook(book) : null;
    const restingBefore = restingIds(book);
    const trades = step(sim, book);
    onStep?.({ index, book, event: sim.lastEvent, trades, before, restingBefore });
  }
  return book;
}

// Every order resting anywhere on the book, read through the engine's public surface.
function restingIds(book) {
  const levels = depth(book);
  const ids = new Set();
  for (const [side, sideLevels] of [['bid', levels.bids], ['ask', levels.asks]]) {
    for (const level of sideLevels) {
      for (const order of queueAt(book, side, level.price)) ids.add(order.id);
    }
  }
  return ids;
}

const sequenceOf = (seed, events) => {
  const sequence = [];
  const book = drive(seed, events, { onStep: ({ event }) => sequence.push({ ...event }) });
  return { sequence, depth: depth(book) };
};

// --- REQ-5: reproducible ---------------------------------------------------------------

test('Given two generators created with the same seed, when each produces 1000 events, then the two sequences are identical', () => {
  const first = sequenceOf(4242, 1000);
  const second = sequenceOf(4242, 1000);

  assert.equal(first.sequence.length, 1000, 'one observable event per step');
  assert.deepEqual(second.sequence, first.sequence);
  // The same events applied in the same order must also leave the same book behind.
  assert.deepEqual(second.depth, first.depth);
});

test('Given two generators created with different seeds, when each produces 1000 events, then the two sequences differ', () => {
  const first = sequenceOf(4242, 1000);
  const second = sequenceOf(4243, 1000);

  assert.notDeepEqual(second.sequence, first.sequence);
});

// --- REQ-6: a plausible mix ------------------------------------------------------------

test('Given a generator run for 5000 events against a book, when the event types are counted, then all three of limit, cancel and market are present', () => {
  for (const seed of SEEDS) {
    const counts = new Map();
    drive(seed, EVENTS, {
      onStep: ({ event }) => counts.set(event.type, (counts.get(event.type) ?? 0) + 1),
    });

    for (const type of ['limit', 'cancel', 'market']) {
      assert.ok(counts.get(type) > 0, `seed ${seed}: no ${type} events in ${EVENTS} steps`);
    }
    assert.deepEqual([...counts.keys()].sort(), ['cancel', 'limit', 'market'], `seed ${seed}: no other event types`);
  }
});

test('Given a generator run for 5000 events, when the book is inspected at each step, then both sides are non-empty for at least 95 percent of steps', () => {
  for (const seed of SEEDS) {
    let populated = 0;
    drive(seed, EVENTS, {
      onStep: ({ book }) => {
        if (bestBid(book) && bestAsk(book)) populated += 1;
      },
    });

    const share = populated / EVENTS;
    assert.ok(share >= 0.95, `seed ${seed}: both sides populated on ${populated} of ${EVENTS} steps (${(share * 100).toFixed(1)}%)`);
  }
});

test('Given a generator run for 5000 events, when the best bid and best ask are inspected at each step, then at least one of them holds two or more resting orders for at least half of those steps', () => {
  for (const seed of SEEDS) {
    let queued = 0;
    drive(seed, EVENTS, {
      onStep: ({ book }) => {
        const bid = bestBid(book);
        const ask = bestAsk(book);
        if ((bid?.orderCount ?? 0) >= 2 || (ask?.orderCount ?? 0) >= 2) queued += 1;
      },
    });

    const share = queued / EVENTS;
    assert.ok(share >= 0.5, `seed ${seed}: the touch held a queue on ${queued} of ${EVENTS} steps (${(share * 100).toFixed(1)}%)`);
  }
});

// --- section 5: the invariants hold under generated flow --------------------------------

test('Given a generator run for 5000 events, when the six invariants from PRD section 5 are checked after every step, then all of them hold', () => {
  const IDS = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6'];

  for (const seed of [7, 20260824]) {
    // Ledger built from what the engine reports, never from a sweep of the book, so the
    // invariants are checked against an independent account of what should have happened.
    const sizes = new Map(); // order id -> size on arrival
    const fills = new Map(); // order id -> cumulative size filled
    const removedIds = new Set(); // cancelled, or filled in full

    drive(seed, EVENTS, {
      snapshot: true,
      onStep: ({ index, book, event, trades, before, restingBefore }) => {
        if (event.type !== 'cancel') sizes.set(event.id, event.size);
        for (const trade of trades) {
          fills.set(trade.makerOrderId, (fills.get(trade.makerOrderId) ?? 0) + trade.size);
          fills.set(trade.takerOrderId, (fills.get(trade.takerOrderId) ?? 0) + trade.size);
        }
        for (const id of new Set(trades.flatMap((trade) => [trade.makerOrderId, trade.takerOrderId]))) {
          if (fills.get(id) === sizes.get(id)) removedIds.add(id);
        }
        // A market order never rests, so any unfilled remainder leaves the book too (REQ-3).
        if (event.type === 'market') removedIds.add(event.id);
        if (event.type === 'cancel' && restingBefore.has(event.id)) removedIds.add(event.id);

        const checked = checkInvariants({
          book,
          seed,
          opIndex: index,
          operation: event,
          trades,
          before,
          sizes,
          fills,
          removedIds,
        });
        assert.deepEqual(checked, IDS, `all six invariants asserted after step ${index}`);
      },
    });
  }
});

// --- cancellations name real orders -----------------------------------------------------

test('Given a cancellation is generated, when it is applied, then it names an order actually resting on the book rather than a random identifier', () => {
  for (const seed of SEEDS) {
    let cancels = 0;
    drive(seed, EVENTS, {
      onStep: ({ index, book, event, restingBefore }) => {
        if (event.type !== 'cancel') return;
        cancels += 1;
        assert.ok(
          restingBefore.has(event.id),
          `seed ${seed}: step ${index} cancelled ${event.id}, which was not resting on the book`,
        );
        assert.ok(
          !restingIds(book).has(event.id),
          `seed ${seed}: step ${index} cancelled ${event.id} but it is still resting`,
        );
      },
    });

    assert.ok(cancels > 0, `seed ${seed}: no cancellations were generated`);
  }
});

// --- module boundaries ------------------------------------------------------------------

test('Given the module boundaries of PRD section 6, when the sources are inspected, then sim.js imports only engine.js and the invariant harness does not import sim.js', () => {
  const source = readFileSync(new URL('../public/src/sim.js', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imported)], ['./engine.js'], 'sim.js imports engine.js and nothing else');

  // The two generators exist for different reasons; coupling them would let a bug in one
  // hide a bug in the other.
  for (const name of ['invariants.js', 'random-flow.js']) {
    const harness = readFileSync(new URL(`./support/${name}`, import.meta.url), 'utf8');
    assert.ok(!/from\s*['"].*sim\.js['"]/.test(harness), `support/${name} does not import sim.js`);
  }
});
