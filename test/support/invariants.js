// The six invariants of PRD section 5, as checks that can be run after any operation.
//
// Each check reads the book through the engine's public surface - depth, queueAt, bestBid,
// bestAsk - so it verifies the behaviour the specification describes rather than the shape of
// the data structure underneath. It returns null when the property holds, or a message
// describing the violation when it does not.
//
// The checks that compare an event against the state before it (INV-2, INV-3, INV-4) need the
// snapshot, the trades and the operation; when those are absent the check has nothing to say
// and returns null, so a single invariant can be run against a bare book.

import { bestBid, bestAsk, depth, queueAt } from '../../public/src/engine.js';

const OPPOSITE = { bid: 'ask', ask: 'bid' };
const SIDES = ['bid', 'ask'];

// Every populated level on a side, best-first, with the individual orders behind it. Taken
// before an operation, this is what the operation's effect is measured against.
export function snapshotBook(book) {
  const levels = depth(book);
  const bySide = (side) =>
    levels[side === 'bid' ? 'bids' : 'asks'].map((level) => ({
      price: level.price,
      volume: level.volume,
      orderCount: level.orderCount,
      queue: queueAt(book, side, level.price),
    }));

  return { bid: bySide('bid'), ask: bySide('ask') };
}

const restingVolume = (snapshot, side) =>
  snapshot[side].reduce((total, level) => total + level.volume, 0);

// The side the liquidity is taken from. A cancellation has no aggressor and no passive side.
const passiveSideOf = (operation) =>
  operation && (operation.type === 'limit' || operation.type === 'market')
    ? OPPOSITE[operation.side]
    : null;

// Every level on the book, best-first, paired with the side it sits on.
const eachLevel = function* (book) {
  const levels = depth(book);
  for (const side of SIDES) {
    for (const level of levels[side === 'bid' ? 'bids' : 'asks']) {
      yield { side, level, queue: queueAt(book, side, level.price) };
    }
  }
};

export const INVARIANTS = [
  {
    id: 'INV-1',
    title: 'the book never crosses',
    check({ book }) {
      const bid = bestBid(book);
      const ask = bestAsk(book);
      if (!bid || !ask) return null;
      if (bid.price < ask.price) return null;
      return `best bid ${bid.price} is not below best ask ${ask.price}: the book is crossed at ${bid.price}/${ask.price}`;
    },
  },

  {
    id: 'INV-2',
    title: 'volume is conserved',
    check({ book, before, trades, operation, sizes, fills }) {
      if (before && trades && operation) {
        const passive = passiveSideOf(operation);
        if (passive) {
          const traded = trades.reduce((total, trade) => total + trade.size, 0);
          const given = restingVolume(before, passive) - restingVolume(snapshotBook(book), passive);
          if (traded !== given) {
            return `${traded} traded but resting ${passive} volume fell by ${given}`;
          }
        }
      }

      if (!sizes || !fills) return null;

      for (const [id, filled] of fills) {
        const original = sizes.get(id);
        if (filled > original) {
          return `order ${id} filled ${filled} against an original size of ${original}`;
        }
      }
      // A resting order is whatever is left of what arrived: nothing is created on the way.
      for (const { queue } of eachLevel(book)) {
        for (const order of queue.filter(Boolean)) {
          if (!sizes.has(order.id)) continue;
          const filled = fills.get(order.id) ?? 0;
          if (order.size + filled !== sizes.get(order.id)) {
            return `order ${order.id} rests at ${order.size} with ${filled} filled, against an original size of ${sizes.get(order.id)}`;
          }
        }
      }
      return null;
    },
  },

  {
    id: 'INV-3',
    title: 'price-time priority is respected',
    check({ before, trades, operation }) {
      if (!before || !trades || !operation) return null;
      const passive = passiveSideOf(operation);
      if (!passive) return null;

      // Replay the event against the queues as they stood. Each fill must take the order at
      // the front of its price: anything else means an older order was skipped.
      const queues = new Map(
        before[passive].map((level) => [level.price, level.queue.map((order) => ({ ...order }))]),
      );

      for (const trade of trades) {
        const queue = queues.get(trade.price) ?? [];
        const head = queue[0];
        if (!head) {
          return `fill of ${trade.size} at ${trade.price} has no resting order to take`;
        }
        if (head.id !== trade.makerOrderId) {
          return `filled ${trade.makerOrderId} at ${trade.price} while older order ${head.id} (ts ${head.ts}) was still resting there`;
        }
        head.size -= trade.size;
        if (head.size <= 0) queue.shift();
      }
      return null;
    },
  },

  {
    id: 'INV-4',
    title: 'no trade-through',
    check({ before, trades, operation }) {
      if (!before || !trades || !operation) return null;
      const passive = passiveSideOf(operation);
      if (!passive) return null;

      // before[side] is best-first, so the first level with volume left is the best available.
      const remaining = before[passive].map((level) => ({ price: level.price, volume: level.volume }));

      for (const trade of trades) {
        const best = remaining.find((level) => level.volume > 0);
        if (!best) {
          return `executed ${trade.size} at ${trade.price} with no ${passive} liquidity left`;
        }
        if (trade.price !== best.price) {
          return `executed ${trade.size} at ${trade.price} while ${best.price} was available on the ${passive} side`;
        }
        best.volume -= trade.size;
      }
      return null;
    },
  },

  {
    id: 'INV-5',
    title: 'the book is well-formed',
    check({ book, removedIds }) {
      for (const { side, level, queue } of eachLevel(book)) {
        if (queue.length === 0) {
          return `${side} level ${level.price} exists with no orders on it`;
        }
        if (queue.length !== level.orderCount) {
          return `${side} level ${level.price} reports ${level.orderCount} orders but holds ${queue.length}`;
        }
        // A missing entry is a queue defect, and INV-6 names it; here only the orders that are
        // present are judged, so that the two failures stay distinguishable.
        const present = queue.filter(Boolean);
        const volume = present.reduce((total, order) => total + order.size, 0);
        if (volume !== level.volume) {
          return `${side} level ${level.price} reports volume ${level.volume} but its orders total ${volume}`;
        }
        for (const order of present) {
          if (!Number.isFinite(order.size) || order.size <= 0) {
            return `order ${order.id} rests at ${side} ${level.price} with size ${order.size}`;
          }
          if (order.side !== side || order.price !== level.price) {
            return `order ${order.id} rests at ${side} ${level.price} but carries ${order.side} ${order.price}`;
          }
          if (removedIds?.has(order.id)) {
            return `order ${order.id} was cancelled or fully filled but is still resting at ${side} ${level.price}`;
          }
        }
      }
      return null;
    },
  },

  {
    id: 'INV-6',
    title: 'queue integrity',
    check({ book }) {
      const seen = new Map();

      for (const { side, level, queue } of eachLevel(book)) {
        let previousTs = -Infinity;

        for (let index = 0; index < queue.length; index += 1) {
          const position = index + 1;
          const order = queue[index];
          if (!order) {
            return `${side} level ${level.price} has no order at queue position ${position} of ${queue.length}: positions must run contiguously from 1`;
          }
          const where = seen.get(order.id);
          if (where) {
            return `order ${order.id} appears at ${where} and again at ${side} ${level.price} position ${position}`;
          }
          seen.set(order.id, `${side} ${level.price} position ${position}`);

          if (order.ts < previousTs) {
            return `order ${order.id} at ${side} ${level.price} position ${position} arrived at ts ${order.ts}, behind an order at ts ${previousTs}: the queue does not reflect arrival order`;
          }
          previousTs = order.ts;
        }
      }
      return null;
    },
  },
];

export const invariant = (id) => {
  const found = INVARIANTS.find((inv) => inv.id === id);
  if (!found) throw new Error(`no such invariant: ${id}`);
  return found;
};

// Run all six against one state. Throws on the first violation, with the seed and operation
// index in the message: re-running the harness with that seed reproduces it exactly (REQ-5),
// which is why the harness does no shrinking.
export function checkInvariants(state) {
  const checked = [];

  for (const inv of INVARIANTS) {
    checked.push(inv.id);
    const failure = inv.check(state);
    if (failure) {
      const where = state.operation ? ` (${describe(state.operation)})` : '';
      throw new Error(
        `${inv.id} violated - ${inv.title}: ${failure}\n` +
          `  reproduce with seed ${state.seed} at operation ${state.opIndex}${where}`,
      );
    }
  }
  return checked;
}

const describe = (operation) =>
  operation.type === 'cancel'
    ? `cancel ${operation.id}`
    : `${operation.type} ${operation.side} ${operation.size}` +
      (operation.price === undefined ? '' : ` @ ${operation.price}`);
