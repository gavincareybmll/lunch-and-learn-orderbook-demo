// Drawing the depth ladder (REQ-7) and the queue view at the touch (REQ-8): asks above,
// bids below, the touch at the centre of both.
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
// QueueRow is { position, id, size, fraction } - its share of the largest order in its queue.

const LADDER_ROWS_PER_SIDE = 8;
const QUEUE_SLOTS_PER_SIDE = 6;

// Dark, high contrast, and legible from the back of a room (NFR-3). Sides are separated by
// position and by their labels as well as by colour, so nothing here is the only carrier of
// meaning. No web fonts: a font request would be a runtime network call (NFR-1).
const THEME = {
  text: '#e8eefc',
  muted: '#8fa0c4',
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
export const QUEUE_CAPTION = 'Each block is one order, waiting its turn in line at that price';

// One queue's view of itself: the orders that fit on screen, numbered from 1, each with its
// share of the largest order in the queue, plus what is left behind them.
//
// The scale is the largest order in the whole queue rather than the largest one shown, so a
// block's width means the same thing whether or not the queue happens to overflow.
export function queueRows(orders, { maxSlots = QUEUE_SLOTS_PER_SIDE } = {}) {
  const queue = Array.isArray(orders) ? orders : [];
  const slots = Math.max(0, Math.floor(maxSlots));

  const sizeOf = (order) => (Number.isFinite(order?.size) && order.size > 0 ? order.size : 0);
  const maxSize = queue.reduce((max, order) => Math.max(max, sizeOf(order)), 0);
  const volume = queue.reduce((total, order) => total + sizeOf(order), 0);

  // The earliest positions are the ones that trade next, so they are the ones kept when
  // there is not room for all of them.
  const shown = queue.slice(0, slots).map((order, index) => ({
    position: index + 1,
    id: order?.id,
    size: sizeOf(order),
    fraction: maxSize > 0 ? sizeOf(order) / maxSize : 0,
  }));

  const hiddenOrders = queue.slice(shown.length);

  return {
    shown,
    hidden: hiddenOrders.length,
    hiddenVolume: hiddenOrders.reduce((total, order) => total + sizeOf(order), 0),
    total: queue.length,
    volume,
    maxSize,
  };
}

// Place the two queues either side of the centre line, ask above and bid below, mirroring
// the ladder. Position 1 is against the line on each side, so "nearest the middle" and "next
// to trade" are the same thing on screen and the panel reads as a zoom into the two ladder
// rows either side of its touch.
//
// `y` is the top edge of the block; `maxSlots` is how many are reserved a side, which fixes
// the block height so blocks do not move as the queue lengthens.
export function queueLayout(model, { height, maxSlots = QUEUE_SLOTS_PER_SIDE, barSpace = 0 }) {
  const slots = Math.max(0, Math.floor(maxSlots));
  const centreY = height / 2;
  const rowHeight = slots > 0 ? height / (2 * slots) : 0;

  const place = (side, sideModel, towards) =>
    (sideModel?.shown ?? []).map((row) => ({
      ...row,
      side,
      y: towards === 'up' ? centreY - row.position * rowHeight : centreY + (row.position - 1) * rowHeight,
      barWidth: barWidth(row.size, sideModel.maxSize, barSpace),
    }));

  return {
    centreY,
    rowHeight,
    rows: [...place('ask', model?.ask, 'up'), ...place('bid', model?.bid, 'down')],
  };
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

// What is waiting behind the last block on screen. Empty when nothing is hidden, so the
// drawing has nothing to say rather than something to say about zero orders.
export function formatQueueOverflow(hidden, hiddenVolume) {
  if (!Number.isFinite(hidden) || hidden <= 0) return '';
  const count = Math.round(hidden);
  return `+ ${count} more order${count === 1 ? '' : 's'} behind, ${formatVolume(hiddenVolume)} in total`;
}

// The one sentence that carries the point of the panel: position in the queue is worth
// something. It sits under the caption rather than on any single block, so it is read once.
const QUEUE_RULE_CAPTION = 'The block nearest the middle line is the next one to trade';

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
// This is the same shape as the ladder on purpose: sellers above, buyers below, the touch on
// the centre line. Where a ladder row is one price with a total, a block here is one order,
// and the two panels line up so it reads as a zoom into the rows either side of the touch.
export function drawQueues(canvas, queues, { maxSlots = QUEUE_SLOTS_PER_SIDE } = {}) {
  const ctx = canvas.getContext('2d');
  const { width, height } = fitToDisplay(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  const { bid, ask } = queues ?? {};
  const model = {
    bid: queueRows(bid?.orders, { maxSlots }),
    ask: queueRows(ask?.orders, { maxSlots }),
  };

  const columns = queueColumnsFor(width);
  const type = {
    caption: Math.max(13, Math.min(19, width * 0.027)),
    header: Math.max(15, Math.min(22, width * 0.032)),
    note: Math.max(12, Math.min(17, width * 0.024)),
  };

  // Cursor down from the top: the two caption lines, then the seller heading, then a line of
  // room for the "more behind" note at the back of the ask queue.
  const pad = Math.max(14, Math.min(28, height * 0.035));
  let cursor = pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = `600 ${type.caption}px ${SANS}`;
  ctx.fillStyle = THEME.text;
  cursor += type.caption;
  ctx.fillText(QUEUE_CAPTION, columns.pad, cursor);

  ctx.font = `500 ${type.caption}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  cursor += type.caption * 1.45;
  ctx.fillText(QUEUE_RULE_CAPTION, columns.pad, cursor);

  cursor += type.header * 1.7;
  drawQueueHeading(ctx, columns, cursor, type, 'ask', ask?.price, model.ask, 'Sellers waiting');
  cursor += type.note * 1.9;

  const top = cursor;
  const bottomBand = pad + type.header * 1.5 + type.note * 1.9;
  const queueHeight = Math.max(0, height - top - bottomBand);
  const layout = queueLayout(model, { height: queueHeight, maxSlots, barSpace: columns.barSpace });

  drawQueueHeading(
    ctx,
    columns,
    height - pad,
    type,
    'bid',
    bid?.price,
    model.bid,
    'Buyers waiting',
  );

  if (layout.rows.length === 0) {
    ctx.fillStyle = THEME.muted;
    ctx.font = `500 ${Math.round(Math.min(22, width * 0.035))}px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No orders resting', width / 2, top + queueHeight / 2);
    return;
  }

  for (const row of layout.rows) drawQueueBlock(ctx, row, layout.rowHeight, columns, top, type);
  drawTouchRule(ctx, columns, top + layout.centreY);

  // The tail of each queue, at the back of it: above the topmost seller block, below the
  // lowest buyer block. Stated rather than dropped, so a long queue never looks like a short
  // one.
  const askTail = top + layout.centreY - model.ask.shown.length * layout.rowHeight;
  const bidTail = top + layout.centreY + model.bid.shown.length * layout.rowHeight;
  drawQueueOverflow(ctx, columns, askTail - type.note * 0.55, type, 'ask', model.ask);
  drawQueueOverflow(ctx, columns, bidTail + type.note * 1.25, type, 'bid', model.bid);
}

// --- drawing internals ------------------------------------------------------------------

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

// The queue's own columns: the position ordinal on the left, then the block, then the size
// of that one order on the right. Narrower than the ladder's - this panel holds three things
// per line, not four.
function queueColumnsFor(width) {
  const pad = Math.max(16, width * 0.04);
  const gap = Math.max(10, width * 0.022);
  const positionWidth = Math.max(52, width * 0.1);
  const sizeWidth = Math.max(62, width * 0.13);

  const barLeft = pad + positionWidth + gap;
  const barRight = width - pad - sizeWidth - gap;

  return {
    width,
    pad,
    positionX: pad,
    barLeft,
    barSpace: Math.max(0, barRight - barLeft),
    sizeRight: width - pad,
  };
}

// One order. A block rather than a bar: it has a left edge and a right edge, and the reader
// is meant to count them. The one at position 1 is drawn solid and in full colour, because
// being at the front of the queue is the property this panel exists to show.
function drawQueueBlock(ctx, row, rowHeight, columns, top, type) {
  const palette = THEME[row.side];
  const next = row.position === 1;
  const y = top + row.y;
  const middle = y + rowHeight / 2;
  const blockHeight = Math.max(8, Math.min(30, rowHeight * 0.66));
  const blockY = middle - blockHeight / 2;
  const fontSize = Math.max(13, Math.min(24, rowHeight * 0.56));

  // A minimum sliver of width, so that an order too small to see is still visibly an order.
  const drawn = row.barWidth > 0 ? Math.max(3, row.barWidth) : 0;
  if (drawn > 0) {
    ctx.fillStyle = next ? palette.edge : palette.bar;
    ctx.fillRect(columns.barLeft, blockY, drawn, blockHeight);
    if (!next) {
      ctx.strokeStyle = palette.edge;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(columns.barLeft + 0.75, blockY + 0.75, Math.max(1.5, drawn - 1.5), blockHeight - 1.5);
    }
  }

  ctx.textBaseline = 'middle';
  ctx.font = `${next ? 700 : 600} ${fontSize}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = next ? palette.text : THEME.muted;
  ctx.fillText(formatQueuePosition(row.position), columns.positionX, middle);

  ctx.textAlign = 'right';
  ctx.fillStyle = THEME.text;
  ctx.fillText(formatVolume(row.size), columns.sizeRight, middle);

  // Every block carries a bare number on the right, so the column is named once - on the
  // first block, where a reader looks first. The same word the ladder uses for the same
  // quantity, because the ladder's total for this price is these numbers added up.
  if (next) {
    ctx.font = `500 ${Math.max(10, type.note * 0.72)}px ${SANS}`;
    ctx.fillStyle = THEME.muted;
    ctx.textAlign = 'right';
    const offset = (row.side === 'ask' ? -1 : 1) * (blockHeight / 2 + type.note * 0.62);
    ctx.fillText('volume', columns.sizeRight, middle + offset);
  }
}

// Whose queue this is, at what price, and what it adds up to - the same two numbers the
// ladder row for that price shows, so the two panels can be read against each other.
function drawQueueHeading(ctx, columns, baseline, type, side, price, model, label) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // A filled square as well as the colour, so the sides are told apart in greyscale (NFR-3).
  const marker = type.header * 0.66;
  ctx.fillStyle = THEME[side].edge;
  ctx.fillRect(columns.pad, baseline - marker, marker, marker);

  ctx.font = `600 ${type.header}px ${SANS}`;
  ctx.fillStyle = THEME[side].text;
  const heading = model.total === 0 ? `${label} - none` : `${label} at ${formatPrice(price)}`;
  ctx.fillText(heading, columns.pad + marker + type.header * 0.5, baseline);

  if (model.total === 0) return;
  ctx.font = `500 ${type.note}px ${SANS}`;
  ctx.fillStyle = THEME.muted;
  ctx.textAlign = 'right';
  ctx.fillText(
    `${formatOrderCount(model.total)}, ${formatVolume(model.volume)} in all`,
    columns.sizeRight,
    baseline,
  );
}

function drawQueueOverflow(ctx, columns, baseline, type, side, model) {
  const text = formatQueueOverflow(model.hidden, model.hiddenVolume);
  if (text === '') return;

  ctx.font = `500 ${type.note}px ${SANS}`;
  ctx.fillStyle = THEME[side].text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, columns.barLeft, baseline);
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
