// Level 3 limit order book: state and matching.
//
// A price level is a queue of individual orders, not an aggregate size. Each order keeps its
// identity and its place in that queue from arrival until it is filled or cancelled, which is
// what makes price-time priority (INV-3) a real property rather than a formality.
//
// Pure logic: no timers, no DOM, no imports. Surface fixed by PRD section 6.
//
// Side  is 'bid' | 'ask'.
// Order is { id, side, price, size, ts } - price omitted for market orders.
// Level is { price, volume, orderCount } - the aggregated view used by the ladder.
// Trade is { price, size, ts, aggressorSide, makerOrderId, takerOrderId }.

const OPPOSITE = { bid: 'ask', ask: 'bid' };

export function createBook() {
  return {
    // price -> Order[] in arrival order; index 0 is queue position 1, next to fill
    bids: new Map(),
    asks: new Map(),
    // id -> the resting order, so a cancellation is a lookup rather than a scan of the book
    orders: new Map(),
    // Monotonic stand-in for a clock. The engine holds no timers, so an order that arrives
    // without a timestamp is stamped from here; it only ever has to increase.
    seq: 0,
  };
}

export function addLimitOrder(book, order) {
  const taker = accept(book, order, { needsPrice: true });

  const { trades, remaining } = match(book, taker, taker.price);

  // Whatever could not execute rests at the limit price, at the back of that queue (REQ-2).
  if (remaining > 0) {
    taker.size = remaining;
    rest(book, taker);
  }
  return trades;
}

export function submitMarketOrder(book, order) {
  const taker = accept(book, order, { needsPrice: false });

  // No limit price, so matching stops only when the order is filled or the book is exhausted.
  // A market order never rests: any unfilled remainder is discarded (REQ-3).
  return match(book, taker, null).trades;
}

export function cancelOrder(book, orderId) {
  const order = book.orders.get(orderId);
  // Unknown or already-filled orders are reported as unsuccessful, not raised (REQ-4).
  if (!order) return false;

  const levels = sideLevels(book, order.side);
  const queue = levels.get(order.price);
  // Splicing preserves the relative order of everything behind it, closing the gap (INV-6).
  queue.splice(queue.indexOf(order), 1);
  if (queue.length === 0) levels.delete(order.price);
  book.orders.delete(orderId);
  return true;
}

export function bestBid(book) {
  return levelAt(book, 'bid', bestPrice(book, 'bid'));
}

export function bestAsk(book) {
  return levelAt(book, 'ask', bestPrice(book, 'ask'));
}

export function depth(book, maxLevels = Infinity) {
  const side = (s) =>
    sortedPrices(book, s)
      .slice(0, Math.max(0, maxLevels))
      .map((price) => levelAt(book, s, price));

  // Only populated levels are returned - no empty placeholders (REQ-7).
  return { bids: side('bid'), asks: side('ask') };
}

export function queueAt(book, side, price) {
  const queue = sideLevels(book, side).get(price);
  // An empty or absent level reads as an empty queue rather than an error (REQ-8).
  if (!queue) return [];
  return queue.map(snapshot);
}

// --- internals ------------------------------------------------------------------------

const sideLevels = (book, side) => {
  if (side === 'bid') return book.bids;
  if (side === 'ask') return book.asks;
  throw new TypeError(`side must be 'bid' or 'ask', got ${JSON.stringify(side)}`);
};

// Copy on the way out so that a reader - the ladder, the queue view - cannot reach in and
// change resting state by accident.
const snapshot = (order) => ({
  id: order.id,
  side: order.side,
  price: order.price,
  size: order.size,
  ts: order.ts,
});

// Validate an incoming order and take our own copy of it. Malformed input is a programming
// error in the caller, and failing loudly here is cheaper than a book that quietly breaks
// an invariant later.
function accept(book, order, { needsPrice }) {
  const { id, side, size } = order ?? {};
  sideLevels(book, side);
  if (!Number.isFinite(size) || size <= 0) {
    throw new TypeError(`order size must be a positive number, got ${JSON.stringify(size)}`);
  }
  if (needsPrice && !Number.isFinite(order.price)) {
    throw new TypeError(`limit order price must be a number, got ${JSON.stringify(order.price)}`);
  }
  if (id === undefined || id === null) throw new TypeError('order must carry an id');
  if (book.orders.has(id)) throw new Error(`order id ${id} is already resting on the book`);

  const ts = Number.isFinite(order.ts) ? order.ts : book.seq;
  book.seq = Math.max(book.seq, ts) + 1;
  return { id, side, price: needsPrice ? order.price : undefined, size, ts };
}

function rest(book, order) {
  const levels = sideLevels(book, order.side);
  const queue = levels.get(order.price);
  if (queue) {
    queue.push(order); // back of the queue: last in, last to fill (REQ-1)
  } else {
    levels.set(order.price, [order]);
  }
  book.orders.set(order.id, order);
}

// Best price on a side: highest bid, lowest ask. Undefined when the side is empty.
function bestPrice(book, side) {
  let best;
  for (const price of sideLevels(book, side).keys()) {
    if (best === undefined || (side === 'bid' ? price > best : price < best)) best = price;
  }
  return best;
}

const sortedPrices = (book, side) =>
  [...sideLevels(book, side).keys()].sort((a, b) => (side === 'bid' ? b - a : a - b));

function levelAt(book, side, price) {
  const queue = price === undefined ? undefined : sideLevels(book, side).get(price);
  if (!queue) return null;
  return {
    price,
    volume: queue.reduce((total, order) => total + order.size, 0),
    orderCount: queue.length,
  };
}

// A limit price of null means "no limit" - a market order takes whatever is there.
const crosses = (takerSide, limitPrice, restingPrice) =>
  limitPrice === null || (takerSide === 'bid' ? limitPrice >= restingPrice : limitPrice <= restingPrice);

// Execute `taker` against the opposite side, best price first and within a price in queue
// order (INV-4, INV-3). Returns the trades and whatever quantity is left unexecuted.
function match(book, taker, limitPrice) {
  const passiveSide = OPPOSITE[taker.side];
  const levels = sideLevels(book, passiveSide);
  const trades = [];
  let remaining = taker.size;

  while (remaining > 0) {
    // Re-read the best price each time round: the level just consumed may have gone.
    const price = bestPrice(book, passiveSide);
    if (price === undefined || !crosses(taker.side, limitPrice, price)) break;

    const queue = levels.get(price);
    while (remaining > 0 && queue.length > 0) {
      const maker = queue[queue.length-1]; // position 1 is next to fill, always    // here 0->queue.length-1
      const size = Math.min(remaining, maker.size);
      maker.size -= size;
      remaining -= size;
      trades.push({
        price,
        size,
        ts: taker.ts,
        aggressorSide: taker.side,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
      });
      // A fully-filled order leaves the book entirely: nothing zero-sized rests (INV-5).
      if (maker.size === 0) {
        queue.pop(); // Here shift->pop
        book.orders.delete(maker.id);
      }
    }
    if (queue.length === 0) levels.delete(price);
  }

  return { trades, remaining };
}
