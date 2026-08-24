// Drawing the depth ladder (REQ-7): asks above, bids below, the touch at the centre.
//
// Holds no simulation state and imports nothing. Every function here takes a target and a
// plain data structure - the { bids, asks } that engine.depth() returns - and reads it once.
//
// The split in this file is deliberate. Everything that is a *calculation* - level ordering,
// the volume scale, bar widths, where a row sits relative to the touch, the text of a row -
// is a pure exported function, because that is the part that can be wrong in a way a person
// looking at the screen would not notice. What is left in drawLadder is stroke-and-fill,
// which is checked by looking at it.
//
// Level is { price, volume, orderCount }, as the ladder receives it.
// Row is a Level plus { side, fraction } - its share of the largest level on screen.
// Placement is a Row plus { y, barWidth } - where and how wide it is drawn.

const LADDER_ROWS_PER_SIDE = 8;

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

// Where the two sides meet. The best bid is immediately below this line and the best ask
// immediately above it, which is the whole point of the ladder being centred.
function drawTouchRule(ctx, columns, y) {
  ctx.strokeStyle = THEME.centre;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(columns.pad, Math.round(y));
  ctx.lineTo(columns.ordersRight, Math.round(y));
  ctx.stroke();
}
