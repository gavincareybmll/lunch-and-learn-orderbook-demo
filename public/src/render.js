// Drawing the depth ladder (REQ-7), the queue view at the touch (REQ-8), the trade tape
// (REQ-9) and the top-of-book readout (REQ-10): asks above, bids below, the touch at the
// centre of both, what the price is, and what just happened.
//
// Holds no simulation state and imports nothing. Every function here takes a target and a
// plain data structure - the { bids, asks } that engine.depth() returns, or the individual
// orders that engine.queueAt() returns - and reads it once.
//
// The split in this file is deliberate. Everything that is a *calculation* - level ordering,
// the volume scale, bar widths, where a row sits relative to the touch, the text of a row -
// is a pure exported function, because that is the part that can be wrong in a way a person
// looking at the screen would not notice. What is left in drawLadder and drawQueues is
// stroke-and-fill, which is checked by looking at it.
//
// Level is { price, volume, orderCount }, as the ladder receives it.
// Row is a Level plus { side, fraction } - its share of the largest level on screen.
// Placement is a Row plus { y, barWidth } - where and how wide it is drawn.
//
// Order is { id, side, price, size, ts }, as the queue view receives it.
// Segment is { position, id, size, orders, x, width, fraction, combined, leading } - one
// order's share of the single bar that is its price level.
//
// Trade is { price, size, aggressorSide, ... }, as the engine returns it.
// Entry is { price, size, aggressorSide, timeMs } - one line of the tape, always one trade.

const LADDER_ROWS_PER_SIDE = 8;

// Dark, high contrast, and legible from the back of a room (NFR-3). Sides are separated by
// position and by their labels as well as by colour, so nothing here is the only carrier of
// meaning. No web fonts: a font request would be a runtime network call (NFR-1).
const THEME = {
  text: '#e8eefc',
  muted: '#8fa0c4',
  // For text sitting on a solid fill, where the light ink above would disappear.
  solidInk: '#08101f',
  rule: 'rgba(140,165,220,0.14)',
  centre: 'rgba(200,218,255,0.8)',
  ask: { text: '#ff9a90', bar: 'rgba(255,107,98,0.30)', edge: '#ff6b62' },
  bid: { text: '#59d69f', bar: 'rgba(46,199,133,0.28)', edge: '#2ec785' },
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// --- pure calculation ------------------------------------------------------------------

// The ladder's view of a depth snapshot: both sides best-first, as depth() returns them,
// each level carrying its share of the largest level on screen. The scale spans both sides
// so that a bid and an ask of the same size draw the same width.
export function ladderRows(data) {
  const { bids = [], asks = [] } = data ?? {};

  const volumeOf = (level) => (Number.isFinite(level?.volume) ? level.volume : 0);
  const maxVolume = [...bids, ...asks].reduce((max, level) => Math.max(max, volumeOf(level)), 0);

  const rows = (side, levels) =>
    levels.map((level) => ({
      side,
      price: level.price,
      volume: volumeOf(level),
      orderCount: Number.isFinite(level?.orderCount) ? level.orderCount : 0,
      fraction: maxVolume > 0 ? Math.max(0, volumeOf(level)) / maxVolume : 0,
    }));

  return { bids: rows('bid', bids), asks: rows('ask', asks), maxVolume };
}

// The largest volume on screen fills the available width and everything else is drawn in
// proportion to it. Degenerate inputs - an empty book, so no scale to divide by; a level
// with nothing resting on it; no room to draw in - are zero width rather than NaN or a bar
// drawn backwards.
export function barWidth(volume, maxVolume, availableWidth) {
  const room = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 0;
  const scale = Number.isFinite(maxVolume) && maxVolume > 0 ? maxVolume : 0;
  const size = Number.isFinite(volume) && volume > 0 ? volume : 0;
  if (room === 0 || scale === 0 || size === 0) return 0;

  return Math.min(room, (size / scale) * room);
}

// Place the rows either side of the touch. Rows are anchored outwards from the centre line
// rather than packed from the edges, so the best bid and best ask always meet in the middle
// of the ladder however many levels happen to be populated on each side.
//
// `y` is the top edge of the row; `maxLevels` is how many slots are reserved a side, which
// is what fixes the row height and so keeps rows from moving as the book deepens.
export function ladderLayout(model, { height, maxLevels = LADDER_ROWS_PER_SIDE, barSpace = 0 }) {
  const slots = Math.max(0, Math.floor(maxLevels));
  const centreY = height / 2;
  const rowHeight = slots > 0 ? height / (2 * slots) : 0;

  const place = (rows, towards) =>
    rows.slice(0, slots).map((row, index) => ({
      ...row,
      y: towards === 'up' ? centreY - (index + 1) * rowHeight : centreY + index * rowHeight,
      barWidth: barWidth(row.volume, model.maxVolume, barSpace),
    }));

  return {
    centreY,
    rowHeight,
    rows: [...place(model.asks, 'up'), ...place(model.bids, 'down')],
  };
}

// Two decimals: a price, not a count. Written out rather than left to toLocaleString so that
// the same number reads the same on every machine the demonstration might run on.
export function formatPrice(price) {
  return Number.isFinite(price) ? price.toFixed(2) : '-';
}

export function formatVolume(volume) {
  if (!Number.isFinite(volume)) return '-';
  const rounded = Math.round(volume);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rounded < 0 ? `-${grouped}` : grouped;
}

// The count is said in words because it sits next to a volume, and two bare numbers on one
// row are two numbers a reader has to work out (NFR-3).
export function formatOrderCount(count) {
  return `${Number.isFinite(count) ? count : 0} order${count === 1 ? '' : 's'}`;
}

// --- the queue at the touch (REQ-8) -----------------------------------------------------

// Said in words, without jargon, because the whole point of this panel is that a reader with
// no market-structure background understands it unaided (REQ-13).
export const QUEUE_CAPTION = 'Each part of the bar is one order, waiting its turn in line at that price';

// And what the bar itself is, said explicitly: the ladder on the left gives this price one
// row, and this is that one row opened up. Without this line the panel is a second picture;
// with it, it is a closer look at the first.
export const QUEUE_LEVEL_CAPTION =
  'One bar is one price - everything resting there, split into the separate orders it is made of';

// A segment narrower than this is a hairline nobody can count, so it is widened to here and
// the room comes off the segments that can spare it. Stated once, so the same sliver is the
// same width in both bars. A couple of pixels of it go to the join with the segment in front,
// which is why it is not smaller.
export const QUEUE_MIN_SEGMENT_WIDTH = 10;

// How many orders a bar shows one by one. Beyond this the joins are closer together than the
// gaps that separate them, so the rest are gathered into one trailing segment that says how
// many it stands for.
export const QUEUE_MAX_SEGMENTS = 8;

// One price level as a single bar, cut into one segment per resting order.
//
// Widths are shares of the level's total volume, so a segment's width is what that order is
// worth *of this price* - which is the thing the ladder cannot show. The bar is always full:
// the segments are the level, not a sample of it.
//
// A queue longer than `maxSegments` keeps its earliest orders - the ones that trade next -
// as segments of their own and gathers the rest into a trailing segment carrying their count
// and their volume, so a long queue never draws as a short one.
export function queueSegments(orders, {
  barWidth: room = 0,
  maxSegments = QUEUE_MAX_SEGMENTS,
  minSegmentWidth = QUEUE_MIN_SEGMENT_WIDTH,
} = {}) {
  const queue = Array.isArray(orders) ? orders : [];
  const width = Number.isFinite(room) && room > 0 ? room : 0;
  const slots = Math.max(1, Math.floor(maxSegments));
  const minWidth = Number.isFinite(minSegmentWidth) && minSegmentWidth > 0 ? minSegmentWidth : 0;

  const sizeOf = (order) => (Number.isFinite(order?.size) && order.size > 0 ? order.size : 0);
  const volume = queue.reduce((total, order) => total + sizeOf(order), 0);

  // The last slot is spent on the tail when the tail exists, so a bar never shows more
  // segments than it was given room for.
  const distinct = queue.length > slots ? slots - 1 : queue.length;
  const parts = queue.slice(0, distinct).map((order, index) => ({
    position: index + 1,
    id: order?.id ?? null,
    size: sizeOf(order),
    orders: 1,
    combined: false,
    leading: index === 0,
  }));

  const tail = queue.slice(distinct);
  if (tail.length > 0) {
    parts.push({
      position: distinct + 1,
      // Several orders, so no one order's id: the segment stands for all of them.
      id: null,
      size: tail.reduce((total, order) => total + sizeOf(order), 0),
      orders: tail.length,
      combined: true,
      leading: parts.length === 0,
    });
  }

  const widths = segmentWidths(parts.map((part) => part.size), width, minWidth);

  let x = 0;
  const segments = parts.map((part, index) => {
    const segment = {
      ...part,
      x,
      width: widths[index],
      fraction: volume > 0 ? part.size / volume : 0,
    };
    x += widths[index];
    return segment;
  });

  return { segments, total: queue.length, volume, combined: tail.length, barWidth: width };
}

// Share `room` between segments in proportion to their sizes, with nothing below `minWidth`
// and the whole of it used.
function segmentWidths(sizes, room, minWidth) {
  const count = sizes.length;
  if (count === 0) return [];

  const volume = sizes.reduce((total, size) => total + size, 0);

  // Nothing to be in proportion to, or not enough room to give every segment its minimum: an
  // equal share is the most an honest bar can say, and it still fills exactly.
  if (volume <= 0 || room < count * minWidth) return sizes.map(() => room / count);

  // Multiplied before divided, so a size that is an exact share of the bar gets an exact
  // width rather than one a rounding away from it.
  const widths = sizes.map((size) => (size * room) / volume);
  const pinned = sizes.map(() => false);

  // Widening one sliver takes room from the rest, which can push another below the minimum,
  // so this repeats until everything left is above it. It terminates because each pass pins
  // one more segment.
  for (;;) {
    const index = widths.findIndex((width, i) => !pinned[i] && width < minWidth);
    if (index === -1) break;

    pinned[index] = true;
    widths[index] = minWidth;

    const free = room - pinned.filter(Boolean).length * minWidth;
    const freeVolume = sizes.reduce((total, size, i) => (pinned[i] ? total : total + size), 0);
    const freeCount = pinned.filter((isPinned) => !isPinned).length;
    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) continue;
      widths[i] = freeVolume > 0 ? (sizes[i] * free) / freeVolume : free / freeCount;
    }
  }

  // Floating point leaves the odd fraction of a pixel over. It goes to the widest segment,
  // which is the one that can absorb it invisibly - and never to a pinned sliver, which is at
  // its stated minimum for a reason.
  const residual = room - widths.reduce((total, width) => total + width, 0);
  if (residual !== 0) {
    const widest = widths.reduce((best, width, i) => (width > widths[best] ? i : best), 0);
    widths[widest] += residual;
  }

  return widths;
}

// Place the two bars either side of the centre line, sellers above and buyers below, so the
// panel keeps the ladder's arrangement while being a different kind of picture: one bar a
// side rather than one row an order.
//
// `queues` is { bid: { price, orders }, ask: { price, orders } } - the two touch queues as
// the engine returns them. A side with nothing resting on it contributes no bar.
export function queueBarLayout(queues, {
  height = 0,
  barSpace = 0,
  maxSegments = QUEUE_MAX_SEGMENTS,
  minSegmentWidth = QUEUE_MIN_SEGMENT_WIDTH,
  gap = 0,
} = {}) {
  const room = Number.isFinite(height) && height > 0 ? height : 0;
  const centreY = room / 2;
  const width = Number.isFinite(barSpace) && barSpace > 0 ? barSpace : 0;

  // Tall enough to hold a label inside a segment, short enough that both bars and their
  // headings sit either side of the touch without crowding it.
  const barHeight = Math.max(0, Math.min(112, Math.max(0, centreY - gap) * 0.62));

  const bar = (side, queue, towards) => {
    const model = queueSegments(queue?.orders, { barWidth: width, maxSegments, minSegmentWidth });
    if (model.segments.length === 0) return [];

    return [{
      ...model,
      side,
      price: queue?.price ?? null,
      y: towards === 'up' ? centreY - gap - barHeight : centreY + gap,
      height: barHeight,
      width,
    }];
  };

  return {
    centreY,
    barHeight,
    bars: [...bar('ask', queues?.ask, 'up'), ...bar('bid', queues?.bid, 'down')],
  };
}

// What one segment says inside itself: a volume for a single order, and a count for the
// trailing segment that stands for several.
export function formatQueueSegmentLabel(segment) {
  if (!segment) return '';
  if (segment.combined) {
    const count = Math.max(0, Math.round(segment.orders ?? 0));
    return `+${count} ${count === 1 ? 'order' : 'orders'}`;
  }
  return formatVolume(segment.size);
}

// An ordinal, so a rank is never read as another size sitting next to one (NFR-3).
export function formatQueuePosition(position) {
  if (!Number.isFinite(position)) return '-';
  const n = Math.round(position);
  const teens = Math.abs(n) % 100;
  const suffix =
    teens >= 11 && teens <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(n) % 10] ?? 'th';
  return `${n}${suffix}`;
}

// What the trailing segment stands for, spelled out in a sentence for a segment too narrow to
// hold its own label. Empty when nothing was combined, so the drawing has nothing to say
// rather than something to say about zero orders.
export function formatQueueOverflow(hidden, hiddenVolume) {
  if (!Number.isFinite(hidden) || hidden <= 0) return '';
  const count = Math.round(hidden);
  return `The last part is ${count} more order${count === 1 ? '' : 's'}, ${formatVolume(hiddenVolume)} in total`;
}

// The one sentence that carries the point of the panel: position in the queue is worth
// something. It sits under the caption rather than on any single segment, so it is read once.
const QUEUE_RULE_CAPTION = 'The part at the left-hand end of each bar is the next order to trade';

// --- the top-of-book readout (REQ-10) ---------------------------------------------------

// What the price is, read from the two touch levels. `touch` is { bid, ask } - Levels as
// bestBid() and bestAsk() return them, or null for a side with nothing resting on it.
//
// Mid and spread need both sides. With one side empty there is no mid price at all - not a
// mid of zero, and not the price of the side that is there - so both are null and the
// readout says so in words. A number in that position would be an invention.
export function topOfBook(touch) {
  const priceOf = (level) => (Number.isFinite(level?.price) ? level.price : null);
  const bid = priceOf(touch?.bid);
  const ask = priceOf(touch?.ask);
  const twoSided = bid !== null && ask !== null;

  return {
    bid,
    ask,
    // Absolute, in the same units as the prices either side of it. Basis points are held
    // back by PRD section 8.
    spread: twoSided ? ask - bid : null,
    mid: twoSided ? (bid + ask) / 2 : null,
  };
}

// Said in words, because a dash or a zero in place of a price reads as a price of nothing
// rather than as an absence (NFR-3).
export const NO_BIDS = 'No buyers waiting';
export const NO_ASKS = 'No sellers waiting';
export const NO_MID = 'No mid price while one side is empty';
// Reads after the word "Spread", which is where it appears.
export const NO_SPREAD = 'unavailable while one side is empty';

const READOUT_FIELDS = ['bid', 'ask', 'mid', 'spread'];

// The four numbers of the readout as the strings that go on the page.
export function formatReadout(model) {
  const { bid = null, ask = null, mid = null, spread = null } = model ?? {};

  return {
    bid: bid === null ? NO_BIDS : formatPrice(bid),
    ask: ask === null ? NO_ASKS : formatPrice(ask),
    mid: mid === null ? NO_MID : formatPrice(mid),
    spread: spread === null ? NO_SPREAD : formatPrice(spread),
  };
}

// --- the trade tape (REQ-9) -------------------------------------------------------------

// How many trades the tape keeps. Bounded because the page is left open for the length of a
// session, and an unbounded list is an unbounded amount of DOM (NFR-4). Enough of them that
// the tape reads as a run of trades rather than as one line flickering.
export const TAPE_LIMIT = 36;

// Said in words: what this list is, and which end of it is new.
export const TAPE_CAPTION = 'Every trade as it happens, newest at the top';

// Add the trades of one event to the tape, newest first, and return the new list trimmed to
// `limit`. The list belongs to the caller - this module holds no state - and a new array is
// returned only when something was recorded, so a caller can tell by identity whether the
// tape changed.
//
// One line per trade, never a combination of several: an order that fills against three
// resting orders prints three times, because three separate orders were on the other side of
// it (REQ-9). The engine returns those in execution order, so the last of them is the newest.
export function recordTrades(entries, trades, { limit = TAPE_LIMIT, timeMs = null } = {}) {
  const tape = Array.isArray(entries) ? entries : [];
  const batch = Array.isArray(trades) ? trades : [];
  if (batch.length === 0) return tape;

  const bound = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const printed = batch
    .map((trade) => ({
      price: Number.isFinite(trade?.price) ? trade.price : null,
      size: Number.isFinite(trade?.size) ? trade.size : null,
      aggressorSide: trade?.aggressorSide ?? null,
      timeMs,
    }))
    .reverse();

  return [...printed, ...tape].slice(0, bound);
}

// Which side crossed the spread to make this trade happen, in the plainest word there is.
// Said rather than coloured, so the tape is still readable in greyscale (NFR-3).
export function formatAggressor(side) {
  if (side === 'bid') return 'Buy';
  if (side === 'ask') return 'Sell';
  return '-';
}

// Minutes and seconds since the book opened. Elapsed rather than a wall clock because the
// only clock this application has is its own - the flow is generated here, not received
// (NFR-1) - and written out rather than left to a locale so the same trade reads the same on
// every machine the demonstration might run on.
export function formatTapeTime(timeMs) {
  if (!Number.isFinite(timeMs)) return '-';
  const total = Math.max(0, Math.floor(timeMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// --- drawing ---------------------------------------------------------------------------

// Draw a depth snapshot into a canvas. Reads the data and returns nothing; called once per
// frame, and safe to call with an empty book.
export function drawLadder(canvas, data, { maxLevels = LADDER_ROWS_PER_SIDE } = {}) {
  const ctx = canvas.getContext('2d');
  const { width, height } = fitToDisplay(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  const model = ladderRows(data);
  const columns = columnsFor(width);
  // The bands top and bottom carry the side labels, so the ladder itself gets what is left.
  const band = Math.min(88, Math.max(52, height * 0.12));
  const ladderHeight = Math.max(0, height - 2 * band);
  const layout = ladderLayout(model, { height: ladderHeight, maxLevels, barSpace: columns.barSpace });
  const top = band;

  drawSideLabel(ctx, columns, band * 0.34, 'ask', 'Asks - sellers, lowest price first');
  drawColumnHeadings(ctx, columns, band - 12);
  drawSideLabel(ctx, columns, height - band * 0.5, 'bid', 'Bids - buyers, highest price first');

  if (layout.rows.length === 0) {
    ctx.fillStyle = THEME.muted;
    ctx.font = `500 ${Math.round(Math.min(24, width * 0.03))}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for orders', width / 2, height / 2);
    return;
  }

  for (const row of layout.rows) drawRow(ctx, row, layout.rowHeight, columns, top);
  drawTouchRule(ctx, columns, top + layout.centreY);
}

// Draw the individual orders resting at the best bid and the best ask (REQ-8). `queues` is
// { bid: { price, orders }, ask: { price, orders } } - the two touch queues as the engine
// returns them. Safe to call with either side empty.
//
// One bar a side, broken into a segment per resting order: the ladder gives this price a
// single row, and this is that row opened up. Sellers above the centre line and buyers below,
// so the two panels still agree about which side is which - but a bar cut into parts is a
// different kind of picture from a column of rows, which is what stops this reading as the
// ladder drawn twice.
export function drawQueues(canvas, queues, { maxSegments = QUEUE_MAX_SEGMENTS } = {}) {
  const ctx = canvas.getContext('2d');
  const { width, height } = fitToDisplay(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  const { bid, ask } = queues ?? {};
  const columns = queueColumnsFor(width);
  const type = {
    caption: Math.max(13, Math.min(19, width * 0.027)),
    header: Math.max(15, Math.min(22, width * 0.032)),
    note: Math.max(12, Math.min(17, width * 0.024)),
  };

  // Cursor down from the top: what the panel is, then what one bar is, then which end of it
  // trades next. Wrapped rather than clipped, so a narrow panel loses none of the sentence.
  const pad = Math.max(14, Math.min(28, height * 0.035));
  let cursor = pad + type.caption;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = `600 ${type.caption}px ${SANS}`;
  ctx.fillStyle = THEME.text;
  cursor = drawWrapped(ctx, QUEUE_CAPTION, columns, cursor, type.caption * 1.35);

  ctx.font = `500 ${type.note}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  cursor += type.note * 0.5;
  cursor = drawWrapped(ctx, QUEUE_LEVEL_CAPTION, columns, cursor, type.note * 1.35);
  cursor = drawWrapped(ctx, QUEUE_RULE_CAPTION, columns, cursor, type.note * 1.35);

  const top = cursor + type.note;
  const queueHeight = Math.max(0, height - top - pad);
  const layout = queueBarLayout(
    { bid, ask },
    { height: queueHeight, barSpace: columns.barSpace, maxSegments, gap: type.note * 0.5 },
  );

  if (layout.bars.length === 0) {
    ctx.fillStyle = THEME.muted;
    ctx.font = `500 ${Math.round(Math.min(22, width * 0.035))}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No orders resting', width / 2, top + queueHeight / 2);
    return;
  }

  drawTouchRule(ctx, columns, top + layout.centreY);

  for (const side of ['ask', 'bid']) {
    const bar = layout.bars.find((candidate) => candidate.side === side);
    const label = side === 'ask' ? 'Sellers waiting' : 'Buyers waiting';
    const price = side === 'ask' ? ask?.price : bid?.price;

    // An empty side has no bar to hang its heading off, so it is said where the bar would
    // have been - the panel still names both sides (REQ-13).
    if (!bar) {
      const away = side === 'ask' ? -1 : 1;
      const baseline = top + layout.centreY + away * (layout.barHeight * 0.5);
      drawQueueHeading(ctx, columns, baseline, type, side, price, null, label);
      continue;
    }

    drawQueueBar(ctx, bar, columns, top);

    const barTop = top + bar.y;
    const heading = side === 'ask' ? barTop - type.note * 1.9 : barTop + bar.height + type.header * 1.05;
    drawQueueHeading(ctx, columns, heading, type, side, price, bar, label);

    // What the trailing segment stands for, next to the end of the bar it belongs to: above
    // the sellers' bar, below the buyers'. Stated rather than dropped, so a long queue never
    // looks like a short one.
    const note = side === 'ask' ? heading - type.header * 1.15 : heading + type.note * 1.6;
    drawQueueOverflow(ctx, columns, note, type, side, bar);
  }
}

// Write the top-of-book readout into the page (REQ-10). `target` is the element holding the
// four slots, each marked with `data-readout`; the markup and its type sizes live in the
// stylesheet, and this only ever puts text in them.
//
// Each slot is also marked available or not, because an absent price is a sentence where a
// number would be and cannot be set at the size of one. That is a presentational fact about
// the value, so it is stated here and answered in CSS.
export function drawReadout(target, model) {
  if (!target) return;
  const text = formatReadout(model);

  for (const field of READOUT_FIELDS) {
    const node = target.querySelector(`[data-readout="${field}"]`);
    if (!node) continue;

    if (node.textContent !== text[field]) node.textContent = text[field];
    const available = Number.isFinite(model?.[field]) ? 'true' : 'false';
    if (node.dataset.available !== available) node.dataset.available = available;
  }
}

// Print the tape into a list element (REQ-9). Rows are reused rather than rebuilt: the tape
// is redrawn every time something trades, which is many times a second, and replacing three
// dozen elements that often is work the animation loop cannot spare (NFR-4).
export function drawTape(target, entries) {
  if (!target) return;
  const tape = Array.isArray(entries) ? entries : [];

  while (target.children.length > tape.length) target.lastElementChild.remove();
  while (target.children.length < tape.length) target.append(tapeRow(target.ownerDocument));

  for (const [index, entry] of tape.entries()) fillTapeRow(target.children[index], entry);
}

// --- drawing internals ------------------------------------------------------------------

// One row of the tape: which side took, how much, at what price, when. The cells are created
// empty and filled by fillTapeRow, so a row is written once and then only updated.
function tapeRow(doc) {
  const row = doc.createElement('li');
  row.className = 'tape-row';
  for (const field of ['side', 'size', 'price', 'time']) {
    const cell = doc.createElement('span');
    cell.className = `tape-${field}`;
    row.append(cell);
  }
  return row;
}

function fillTapeRow(row, entry) {
  const [side, size, price, time] = row.children;
  const write = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };

  // The side is on the row as well as in it: the word says which it was, and the attribute
  // lets the stylesheet colour it. Neither carries the meaning alone (NFR-3).
  const aggressor = entry?.aggressorSide === 'bid' || entry?.aggressorSide === 'ask'
    ? entry.aggressorSide
    : 'none';
  if (row.dataset.side !== aggressor) row.dataset.side = aggressor;

  write(side, formatAggressor(entry?.aggressorSide));
  write(size, formatVolume(entry?.size));
  write(price, formatPrice(entry?.price));
  write(time, formatTapeTime(entry?.timeMs));
}


// Match the backing store to the element's size in device pixels and work in CSS pixels
// thereafter, so text stays sharp on a high-density display and the layout arithmetic above
// stays in one unit.
function fitToDisplay(canvas, ctx) {
  const ratio = Math.min(3, globalThis.devicePixelRatio || 1);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const backingWidth = Math.round(width * ratio);
  const backingHeight = Math.round(height * ratio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width, height };
}

// Price on the left, then the bar, then volume and the order count on the right. Widths
// scale with the canvas so the same layout works on a laptop and on a projector.
function columnsFor(width) {
  const pad = Math.max(18, width * 0.025);
  const gap = Math.max(12, width * 0.015);
  const priceWidth = Math.max(84, width * 0.12);
  const volumeWidth = Math.max(76, width * 0.11);
  const ordersWidth = Math.max(104, width * 0.14);

  const barLeft = pad + priceWidth + gap;
  const barRight = width - pad - ordersWidth - gap - volumeWidth - gap;

  return {
    width,
    pad,
    priceX: pad,
    barLeft,
    barSpace: Math.max(0, barRight - barLeft),
    volumeRight: width - pad - ordersWidth - gap,
    ordersRight: width - pad,
  };
}

function drawRow(ctx, row, rowHeight, columns, top) {
  const palette = THEME[row.side];
  const y = top + row.y;
  const middle = y + rowHeight / 2;
  const fontSize = Math.max(14, Math.min(30, rowHeight * 0.62));

  ctx.strokeStyle = THEME.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(columns.pad, Math.round(y) + 0.5);
  ctx.lineTo(columns.ordersRight, Math.round(y) + 0.5);
  ctx.stroke();

  if (row.barWidth > 0) {
    const barHeight = Math.max(10, Math.min(34, rowHeight * 0.62));
    const barY = middle - barHeight / 2;
    ctx.fillStyle = palette.bar;
    ctx.fillRect(columns.barLeft, barY, row.barWidth, barHeight);
    ctx.fillStyle = palette.edge;
    ctx.fillRect(columns.barLeft, barY, Math.min(3, row.barWidth), barHeight);
  }

  ctx.textBaseline = 'middle';
  ctx.font = `600 ${fontSize}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = palette.text;
  ctx.fillText(formatPrice(row.price), columns.priceX, middle);

  ctx.textAlign = 'right';
  ctx.fillStyle = THEME.text;
  ctx.fillText(formatVolume(row.volume), columns.volumeRight, middle);

  ctx.font = `500 ${Math.max(12, fontSize * 0.82)}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  ctx.fillText(formatOrderCount(row.orderCount), columns.ordersRight, middle);
}

function drawSideLabel(ctx, columns, y, side, label) {
  const fontSize = Math.max(15, Math.min(22, columns.width * 0.018));
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // A filled square as well as the colour, so the two sides are still told apart in
  // greyscale or by a colour-blind reader (NFR-3).
  const marker = fontSize * 0.72;
  ctx.fillStyle = THEME[side].edge;
  ctx.fillRect(columns.pad, y - marker / 2, marker, marker);

  ctx.font = `600 ${fontSize}px ${SANS}`;
  ctx.fillStyle = THEME[side].text;
  ctx.fillText(label, columns.pad + marker + fontSize * 0.6, y);
}

function drawColumnHeadings(ctx, columns, y) {
  ctx.font = `500 ${Math.max(11, Math.min(15, columns.width * 0.012))}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left';
  ctx.fillText('Price', columns.priceX, y);
  ctx.textAlign = 'right';
  ctx.fillText('Volume resting', columns.volumeRight, y);
  ctx.fillText('Separate orders', columns.ordersRight, y);
}

// The queue's own columns: one bar across the full width of the panel, because the bar is the
// price level and nothing shares a line with it. Everything else - which side, which price,
// what it adds up to - is said above or below it.
function queueColumnsFor(width) {
  const pad = Math.max(16, width * 0.04);

  return {
    width,
    pad,
    barLeft: pad,
    barSpace: Math.max(0, width - 2 * pad),
    sizeRight: width - pad,
  };
}

// One price level: a single outlined bar, cut into a segment per resting order. The joins are
// what make it a Level 3 picture, so they are drawn as gaps in the fill as well as edges -
// countable in greyscale, and countable at the back of a room (NFR-3).
function drawQueueBar(ctx, bar, columns, top) {
  const palette = THEME[bar.side];
  const y = top + bar.y;
  if (bar.height <= 0 || bar.width <= 0) return;

  // The join between two segments. Narrow enough that the bar still reads as one object,
  // wide enough to be a visible break rather than a smudge.
  const join = Math.max(2, Math.min(4, bar.width * 0.006));
  const fontSize = Math.max(11, Math.min(20, bar.height * 0.4));

  for (const segment of bar.segments) {
    const isFirst = segment.x === 0;
    const left = columns.barLeft + segment.x + (isFirst ? 0 : join);
    const drawn = Math.max(1, segment.width - (isFirst ? 0 : join));

    // The leading segment is the one that trades next, so it is the only solid one: emphasis
    // that survives greyscale, on top of its position at the head of the bar.
    ctx.fillStyle = segment.leading ? palette.edge : palette.bar;
    ctx.fillRect(left, y, drawn, bar.height);

    if (!segment.leading) {
      ctx.strokeStyle = palette.edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, y + 0.5, Math.max(1, drawn - 1), bar.height - 1);
    }

    // A label only where it fits: a segment too narrow for its own number is accounted for by
    // the totals above the bar and, at the tail, by the note beside it.
    const text = segment.leading
      ? `${formatQueuePosition(segment.position)}  ${formatQueueSegmentLabel(segment)}`
      : formatQueueSegmentLabel(segment);
    ctx.font = `${segment.leading ? 700 : 500} ${fontSize}px ${segment.combined ? SANS : MONO}`;
    if (ctx.measureText(text).width + fontSize <= drawn) {
      ctx.fillStyle = segment.leading ? THEME.solidInk : THEME.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + drawn / 2, y + bar.height / 2);
    }
  }

  // The level, outlined once around all of it: the segments are parts of this one thing.
  ctx.strokeStyle = palette.edge;
  ctx.lineWidth = 2;
  ctx.strokeRect(columns.barLeft + 1, y + 1, bar.width - 2, bar.height - 2);
}

// Whose bar this is, at what price, and what it adds up to - the same two numbers the ladder
// row for that price shows, so the two panels can be read against each other.
function drawQueueHeading(ctx, columns, baseline, type, side, price, bar, label) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // A filled square as well as the colour, so the sides are told apart in greyscale (NFR-3).
  const marker = type.header * 0.66;
  ctx.fillStyle = THEME[side].edge;
  ctx.fillRect(columns.pad, baseline - marker, marker, marker);

  ctx.font = `600 ${type.header}px ${SANS}`;
  ctx.fillStyle = THEME[side].text;
  const heading = bar === null ? `${label} - none` : `${label} at ${formatPrice(price)}`;
  ctx.fillText(heading, columns.pad + marker + type.header * 0.5, baseline);

  if (bar === null) return;
  ctx.font = `500 ${type.note}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  ctx.textAlign = 'right';
  ctx.fillText(
    `${formatOrderCount(bar.total)} in this bar, ${formatVolume(bar.volume)} altogether`,
    columns.sizeRight,
    baseline,
  );
}

function drawQueueOverflow(ctx, columns, baseline, type, side, bar) {
  const tail = bar.segments.at(-1);
  const text = formatQueueOverflow(bar.combined, tail?.size);
  if (text === '') return;

  ctx.font = `500 ${type.note}px ${SANS}`;
  ctx.fillStyle = THEME[side].text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, columns.sizeRight, baseline);
}

// Draw `text` at the panel's left margin, broken on words to fit the width, and return the
// baseline the next line would use. The captions are the panel's whole explanation (REQ-13),
// so a narrow panel wraps them rather than running them off the edge.
function drawWrapped(ctx, text, columns, baseline, lineHeight) {
  const room = columns.width - 2 * columns.pad;
  let line = '';
  let y = baseline;

  for (const word of String(text).split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && ctx.measureText(candidate).width > room) {
      ctx.fillText(line, columns.pad, y);
      y += lineHeight;
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line !== '') {
    ctx.fillText(line, columns.pad, y);
    y += lineHeight;
  }
  return y;
}

// Where the two sides meet. The best bid is immediately below this line and the best ask
// immediately above it, which is the whole point of the ladder being centred.
// Shared by both panels, so the line means the same thing in each: the right edge is taken
// from the canvas rather than from a named column.
function drawTouchRule(ctx, columns, y) {
  ctx.strokeStyle = THEME.centre;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(columns.pad, Math.round(y));
  ctx.lineTo(columns.width - columns.pad, Math.round(y));
  ctx.stroke();
}
