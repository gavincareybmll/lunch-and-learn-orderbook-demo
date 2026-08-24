// A small seeded property runner: randomised limit orders, market orders and cancellations
// driven through the engine, with all six invariants asserted after every single operation.
//
// It generates its own operations rather than using sim.js - the harness that guards the
// engine must not depend on the flow generator it is also there to guard, and sim.js is a
// separate ticket besides.
//
// There is no shrinking. On failure the message carries the seed and the operation index,
// and re-running the same seed replays the same sequence exactly (REQ-5), which is enough to
// reproduce it under a debugger.

import {
  createBook,
  addLimitOrder,
  submitMarketOrder,
  cancelOrder,
  bestBid,
  bestAsk,
  depth,
  queueAt,
} from '../../public/src/engine.js';
import { checkInvariants, snapshotBook } from './invariants.js';

// mulberry32: a 32-bit PRNG small enough to write out, with a long enough period for this.
// Node's Math.random cannot be seeded, and a dependency is not an option (NFR-2).
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REFERENCE_PRICE = 100;

// Weighted so the book stays populated and active: more arrivals than departures, and enough
// crossing prices that matching - the part most worth guarding - is exercised throughout.
const LIMIT_SHARE = 0.6;
const CANCEL_SHARE = 0.8;

export function runRandomFlow(seed, { operations = 300 } = {}) {
  const rng = createRng(seed);
  const intBetween = (low, high) => low + Math.floor(rng() * (high - low + 1));
  const pickSide = () => (rng() < 0.5 ? 'bid' : 'ask');

  const book = createBook();
  const applied = [];
  const checks = [];
  const tradesByOperation = [];

  // Ledger kept from what the engine returns, never from a sweep of the book, so that the
  // invariants are checked against an independent account of what should have happened.
  const sizes = new Map(); // order id -> size on arrival
  const fills = new Map(); // order id -> cumulative size filled
  const removedIds = new Set(); // cancelled, or filled in full

  for (let opIndex = 0; opIndex < operations; opIndex += 1) {
    const before = snapshotBook(book);
    const operation = nextOperation({ book, rng, intBetween, pickSide, opIndex });

    const { trades, cancelled } = apply(book, operation);

    if (operation.type !== 'cancel') {
      sizes.set(operation.id, operation.size);
    }
    for (const trade of trades) {
      record(fills, trade.makerOrderId, trade.size);
      record(fills, trade.takerOrderId, trade.size);
    }
    for (const id of [...new Set(trades.flatMap((t) => [t.makerOrderId, t.takerOrderId]))]) {
      if (fills.get(id) === sizes.get(id)) removedIds.add(id);
    }
    // A market order never rests, so an unfilled remainder leaves the book too (REQ-3).
    if (operation.type === 'market') removedIds.add(operation.id);
    if (cancelled) removedIds.add(operation.id);

    applied.push(operation);
    tradesByOperation.push(trades);
    checks.push(
      checkInvariants({ book, seed, opIndex, operation, trades, before, sizes, fills, removedIds }),
    );
  }

  return { seed, operations: applied, checks, trades: tradesByOperation };
}

const record = (map, id, size) => map.set(id, (map.get(id) ?? 0) + size);

// Apply one operation. A cancellation produces no trades, so its boolean result is returned
// alongside for the ledger above.
function apply(book, operation) {
  if (operation.type === 'limit') {
    const { id, side, price, size } = operation;
    return { trades: addLimitOrder(book, { id, side, price, size }), cancelled: false };
  }
  if (operation.type === 'market') {
    const { id, side, size } = operation;
    return { trades: submitMarketOrder(book, { id, side, size }), cancelled: false };
  }
  return { trades: [], cancelled: cancelOrder(book, operation.id) };
}

// The operation for this step. Choice depends on the rng and on the book, both of which are a
// pure function of the seed, so the whole sequence replays identically (acceptance criterion 2).
function nextOperation({ book, rng, intBetween, pickSide, opIndex }) {
  const roll = rng();
  const resting = restingIds(book);

  if (roll < LIMIT_SHARE || (roll < CANCEL_SHARE && resting.length === 0)) {
    const side = pickSide();
    // Clustered on the touch, and deliberately allowed to cross it: an offset either side of
    // the reference produces passive orders, aggressive ones, and everything between.
    const offset = intBetween(-3, 3);
    return {
      index: opIndex,
      type: 'limit',
      side,
      price: reference(book) + (side === 'bid' ? -offset : offset),
      size: intBetween(1, 100),
      id: `o${opIndex}`,
    };
  }

  if (roll < CANCEL_SHARE) {
    return { index: opIndex, type: 'cancel', id: resting[Math.floor(rng() * resting.length)] };
  }

  return { index: opIndex, type: 'market', side: pickSide(), size: intBetween(1, 60), id: `o${opIndex}` };
}

// Mid of the touch, rounded to a whole tick; the reference price while a side is empty.
function reference(book) {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid && ask) return Math.round((bid.price + ask.price) / 2);
  if (bid) return bid.price;
  if (ask) return ask.price;
  return REFERENCE_PRICE;
}

// Best-first, then queue order: a deterministic enumeration, so the order chosen for
// cancellation depends only on the seed.
function restingIds(book) {
  const levels = depth(book);
  const ids = [];
  for (const [side, sideLevels] of [['bid', levels.bids], ['ask', levels.asks]]) {
    for (const level of sideLevels) {
      for (const order of queueAt(book, side, level.price)) ids.push(order.id);
    }
  }
  return ids;
}
