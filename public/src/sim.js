// Seeded synthetic order flow (REQ-5, REQ-6).
//
// Everything here is generated from a seed and the state of the book in front of it, so the
// same seed replays the same sequence of events exactly - which is what makes a failing run
// reproducible (REQ-5) and is why the PRNG is written out rather than taken from a library
// (NFR-2). No real, recorded or derived market data is involved (NFR-1).
//
// No DOM and no timers: step() applies exactly one event and returns whatever it traded, and
// the caller decides when to call it. Surface fixed by PRD section 6.
//
// Event is { index, type, id } plus { side, size } for orders and { price } for limit orders.
// The event just applied is left on the sim as `sim.lastEvent`, so a caller - a test, or the
// trade tape later - can see what happened rather than infer it from the book.
//
// Shape of the flow, and why: an order book is only worth looking at while it is two-sided
// and its price levels hold queues. Uniformly scattered orders would give a book that is
// technically valid and visually pointless - almost every level holding exactly one order,
// which is a Level 2 ladder wearing a Level 3 costume. So limit orders mostly join the back
// of the queue at the current best price, cancellations never take the last order off a
// side, and market orders never take more than the touch level holds.

import {
  addLimitOrder,
  submitMarketOrder,
  cancelOrder,
  bestBid,
  bestAsk,
  depth,
  queueAt,
} from './engine.js';

const DEFAULTS = {
  referencePrice: 100, // where the book opens, and what it is pulled gently back towards
  tick: 1,
  lotSize: 10,
  maxLots: 10, // limit order size, in lots
  maxMarketLots: 6, // market order size before it is capped at the touch
  sweepShare: 0.2, // market orders that take the whole touch level instead of part of it

  // Event mix at a book of the target size. Away from it the first two are re-weighted -
  // see chooseType - so the resting population settles instead of growing without limit.
  targetResting: 60,
  limitShare: 0.6,
  cancelShare: 0.25,
  marketShare: 0.15,

  // Where a limit order goes, given the side it is on. The remainder after these three
  // crosses the spread: a marketable limit that trades and rests whatever is left.
  joinShare: 0.55, // join the back of the queue at the current best price
  deepenShare: 0.25, // rest behind the touch
  improveShare: 0.12, // better the touch by one tick
  depthLevels: 5, // how far behind the touch a passive order may rest

  // Pull back towards referencePrice, so a walk of thousands of events does not wander off
  // the scale. A convenience for the display; not a claim about how prices behave.
  reversionRange: 20, // ticks of distance at which the pull is at full strength
  reversionStrength: 0.25, // most it may shift the even odds of buyer against seller
};

export function createSim(seed = 1, config = {}) {
  return {
    seed,
    config: { ...DEFAULTS, ...config },
    rng: createRng(seed),
    eventCount: 0,
    lastEvent: null,
  };
}

export function step(sim, book) {
  const event = nextEvent(sim, book);

  sim.lastEvent = event;
  sim.eventCount += 1;
  return apply(book, event);
}

// --- internals ------------------------------------------------------------------------

// mulberry32: a 32-bit PRNG small enough to write out, with a long enough period for this.
// Math.random cannot be seeded and a dependency is not an option (NFR-2).
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intBetween = (rng, low, high) => low + Math.floor(rng() * (high - low + 1));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Prices live on the tick grid so that orders meet at the same level rather than at values
// that only look equal.
const onTick = (price, tick) => Math.round(price / tick) * tick;

function apply(book, event) {
  if (event.type === 'limit') {
    const { id, side, price, size } = event;
    return addLimitOrder(book, { id, side, price, size });
  }
  if (event.type === 'market') {
    const { id, side, size } = event;
    return submitMarketOrder(book, { id, side, size });
  }
  cancelOrder(book, event.id);
  return [];
}

function nextEvent(sim, book) {
  const index = sim.eventCount;
  const resting = restingBySide(book);
  const candidates = cancellableIds(resting);
  const type = chooseType(sim, resting.bid.length + resting.ask.length, candidates.length);

  if (type === 'cancel') {
    return { index, type: 'cancel', id: candidates[Math.floor(sim.rng() * candidates.length)] };
  }
  if (type === 'market') {
    const market = marketEvent(sim, book, index);
    // Nothing safe to take from: replenish the book instead of emptying a side of it.
    if (market) return market;
  }
  return limitEvent(sim, book, index);
}

// Every resting order id, kept by side and in best-first, then queue, order. A deterministic
// enumeration, so which order a cancellation names depends only on the seed and the book.
function restingBySide(book) {
  const levels = depth(book);
  const ids = (side, sideLevels) =>
    sideLevels.flatMap((level) => queueAt(book, side, level.price).map((order) => order.id));

  return { bid: ids('bid', levels.bids), ask: ids('ask', levels.asks) };
}

// A side holding a single order is left alone: cancelling it would leave the book one-sided,
// and a one-sided book has no touch, no spread and nothing much to look at.
const cancellableIds = (resting) => [
  ...(resting.bid.length > 1 ? resting.bid : []),
  ...(resting.ask.length > 1 ? resting.ask : []),
];

function chooseType(sim, restingCount, cancellableCount) {
  const cfg = sim.config;
  // Arrivals outnumber departures while the book is thin and the reverse while it is
  // crowded, so the resting population settles around targetResting over a long run.
  const crowding = clamp(restingCount / cfg.targetResting, 0, 2);

  const weights = [
    ['limit', cfg.limitShare * (2 - crowding)],
    ['cancel', cancellableCount > 0 ? cfg.cancelShare * crowding : 0],
    ['market', cfg.marketShare],
  ];

  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = sim.rng() * total;
  for (const [type, weight] of weights) {
    roll -= weight;
    if (roll < 0) return type;
  }
  return 'limit';
}

// Which way the next order leans. Even odds, tilted against the prevailing price: dearer
// books attract sellers, cheaper ones buyers.
function pickSide(sim, book) {
  const cfg = sim.config;
  const drift = clamp((reference(sim, book) - cfg.referencePrice) / (cfg.reversionRange * cfg.tick), -1, 1);
  return sim.rng() < 0.5 - drift * cfg.reversionStrength ? 'bid' : 'ask';
}

// Mid of the touch; the best price on whichever side exists, or the opening price, until
// both do.
function reference(sim, book) {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid && ask) return (bid.price + ask.price) / 2;
  if (bid) return bid.price;
  if (ask) return ask.price;
  return sim.config.referencePrice;
}

function marketEvent(sim, book, index) {
  const cfg = sim.config;
  const side = pickSide(sim, book);
  const passive = depth(book, 2)[side === 'bid' ? 'asks' : 'bids'];

  // Taking from a side that has only one price level would empty it. Let it be replenished.
  if (passive.length < 2) return null;

  // Capped at what rests at the touch, so a market order sweeps at most one price level and
  // the side it takes from keeps at least one. A minority take the level in full: clearing
  // the touch is how the best price moves, and without it a queue this deep would pin the
  // price where it opened.
  const drawn = cfg.lotSize * intBetween(sim.rng, 1, cfg.maxMarketLots);
  const size = sim.rng() < cfg.sweepShare ? passive[0].volume : Math.min(drawn, passive[0].volume);
  return { index, type: 'market', side, size, id: `s${index}` };
}

function limitEvent(sim, book, index) {
  const cfg = sim.config;
  const bid = bestBid(book);
  const ask = bestAsk(book);

  // An empty side is replenished before anything else: both sides populated is the point
  // (REQ-6), and the first two events of a run are how the book opens at all.
  const side = !bid ? 'bid' : !ask ? 'ask' : pickSide(sim, book);
  const near = side === 'bid' ? bid : ask;
  const far = side === 'bid' ? ask : bid;

  return {
    index,
    type: 'limit',
    side,
    price: limitPrice(sim, side, near, far),
    size: cfg.lotSize * intBetween(sim.rng, 1, cfg.maxLots),
    id: `s${index}`,
  };
}

function limitPrice(sim, side, near, far) {
  const { tick, joinShare, deepenShare, improveShare, depthLevels } = sim.config;
  // Away from the touch is down for a bid and up for an ask; inwards is the other way.
  const away = side === 'bid' ? -tick : tick;

  // First order on this side: a tick off the other side, or off the opening price if the
  // book is empty altogether.
  if (!near) {
    const anchor = far ? far.price : sim.config.referencePrice;
    return positive(onTick(anchor + away, tick), tick);
  }

  const roll = sim.rng();

  // Joining is the common case, and it is what puts more than one order on a price level
  // so that queue position is visible rather than theoretical (REQ-6, REQ-8).
  if (roll < joinShare) return near.price;

  if (roll < joinShare + deepenShare) {
    return positive(onTick(near.price + away * intBetween(sim.rng, 1, depthLevels), tick), tick);
  }

  if (roll < joinShare + deepenShare + improveShare) {
    const improved = onTick(near.price - away, tick);
    // An improvement only while it stays inside the other side; a tick that would cross
    // belongs in the branch below, so join the queue instead.
    const inside = !far || (side === 'bid' ? improved < far.price : improved > far.price);
    return inside ? positive(improved, tick) : near.price;
  }

  // The remainder crosses: priced at the far touch, it trades against what rests there and
  // any remainder rests as the new best price on this side.
  return far ? far.price : positive(onTick(near.price - away, tick), tick);
}

// Prices are a scale, not a market model, but a non-positive one would still be nonsense.
const positive = (price, tick) => Math.max(tick, price);
