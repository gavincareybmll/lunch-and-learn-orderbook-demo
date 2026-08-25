// Tests for the price chart: REQ-11, NFR-3, NFR-4.
//
// Written first from the acceptance criteria of LLD-10 and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched back to a line
// in the ticket.
//
// Two things about a chart can be wrong without anyone watching noticing: what the series
// remembers, and where a price lands in the plot. A line that is drawn flat because the scale
// divided by zero, or that quietly stopped extending, looks exactly like a quiet market. The
// ticket says as much - series trimming and coordinate mapping are pure exported functions
// with tests, and the drawing is verified on the preview - so those two are pinned here, and
// what is asked of the drawing is that it survives the degenerate cases without producing a
// coordinate that is not a number.
//
// The surface these tests fix:
//
//   CHART_LIMIT                        -> the default bound on the series (NFR-4)
//   CHART_WINDOW_MS                    -> the span of time the plot's width covers
//   recordMid(series, mid, { limit, timeMs })
//                                      -> Point[], oldest first, at most `limit`
//   chartPlot(series, { width, height, windowMs })
//                                      -> { points, min, max, plot, ticks, startMs, endMs }
//   chartPriceTicks(min, max, count)   -> number[], the prices the vertical scale is labelled with
//   drawChart(canvas, series, { windowMs })
//   formatChartAge(windowMs)           -> string, how far back the left-hand edge is
//   CHART_CAPTION                      -> what the panel is, said in words
//   midSeries(state)                   -> Point[] for the running page
//   FLOW.chartPoints / chartSampleMs / chartWindowMs
//
// Point is { price, timeMs } - one mid price and the moment it was taken. A plotted point is a
// Point plus { x, y }. The series is held oldest first, so the last point is the right-hand end
// of the line and the current price. `plot` is the rectangle the line is drawn in: y runs
// downwards, so plot.top is the highest price and plot.bottom the lowest.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHART_LIMIT,
  CHART_WINDOW_MS,
  CHART_CAPTION,
  recordMid,
  chartPlot,
  chartPriceTicks,
  drawChart,
  formatChartAge,
  formatPrice,
  topOfBook,
} from '../public/src/render.js';
import {
  FLOW,
  createSimulation,
  advance,
  midSeries,
  touchLevels,
} from '../public/src/app.js';
import { fakeCanvas, drawnText } from './support/canvas.js';

const PANEL = { width: 900, height: 320 };

const pricesOf = (series) => series.map((point) => point.price);
const timesOf = (series) => series.map((point) => point.timeMs);

// A series of `count` points at a fixed cadence, so the arithmetic of the time axis is checked
// against times that are easy to reason about rather than against a simulated run.
const seriesOf = (count, { price = 100, everyMs = 200, from = 0 } = {}) =>
  Array.from({ length: count }, (unused, i) => ({
    price: typeof price === 'function' ? price(i) : price,
    timeMs: from + i * everyMs,
  }));

// --- acceptance criteria ---------------------------------------------------------------

test('Given a series bounded to 300 points, when 400 mid prices are recorded, then the series holds the most recent 300', () => {
  let series = [];
  // The price identifies the point, so which hundred were discarded is checkable.
  for (let i = 1; i <= 400; i += 1) {
    series = recordMid(series, 100 + i, { limit: 300, timeMs: i * 200 });
  }

  assert.equal(series.length, 300);

  // Oldest first, so the series runs 201 up to 500 and the first hundred have gone.
  assert.deepEqual(pricesOf(series), Array.from({ length: 300 }, (unused, i) => 201 + i));
  assert.equal(series[0].price, 201, 'the oldest point kept is the 101st recorded');
  assert.equal(series.at(-1).price, 500, 'and the newest is the last recorded');
  for (let i = 1; i <= 100; i += 1) {
    assert.ok(!pricesOf(series).includes(100 + i), `the ${i}th mid has been discarded`);
  }
});

test('Given a period during which mid is unavailable, when the series is recorded, then those periods are omitted rather than recorded as zero', () => {
  let series = recordMid([], 100, { limit: 300, timeMs: 0 });

  // One side of the book empty: topOfBook reports no mid at all, so there is nothing to plot.
  for (const missing of [null, undefined, Number.NaN]) {
    const before = series;
    series = recordMid(series, missing, { limit: 300, timeMs: 1000 });
    assert.equal(series, before, `a mid of ${missing} records nothing and changes nothing`);
  }

  series = recordMid(series, 101, { limit: 300, timeMs: 2000 });

  assert.deepEqual(pricesOf(series), [100, 101], 'two prices recorded, not four points');
  assert.ok(series.every((point) => Number.isFinite(point.price)), 'every point is a real price');
  assert.ok(!pricesOf(series).includes(0), 'and none of them is a zero standing in for an absence');

  // The gap shows in the times rather than being filled in: nothing was invented for it.
  assert.deepEqual(timesOf(series), [0, 2000]);

  // ...and an absent mid read straight off a one-sided book is omitted the same way.
  const oneSided = topOfBook({ bid: { price: 99, volume: 10, orderCount: 1 }, ask: null });
  assert.equal(oneSided.mid, null, 'the readout has no mid to give the chart');
  assert.equal(recordMid(series, oneSided.mid, { limit: 300, timeMs: 3000 }), series);
});

test('Given a series of prices, when plot coordinates are computed, then the highest price maps to the top of the plot area and the lowest to the bottom', () => {
  const series = [
    { price: 100, timeMs: 0 },
    { price: 104, timeMs: 1000 },
    { price: 98, timeMs: 2000 },
    { price: 101, timeMs: 3000 },
  ];

  const model = chartPlot(series, { ...PANEL, windowMs: CHART_WINDOW_MS });

  assert.equal(model.max, 104, 'the scale spans the range actually present');
  assert.equal(model.min, 98);
  assert.ok(model.plot.height > 0, 'there is a plot area to map into');

  const at = (price) => model.points.find((point) => point.price === price);
  assert.equal(at(104).y, model.plot.top, 'the highest price is at the top of the plot area');
  assert.equal(at(98).y, model.plot.bottom, 'the lowest is at the bottom');

  // ...and everything between the two in proportion, so a small move is a visible one.
  assert.equal(at(101).y, model.plot.top + model.plot.height * ((104 - 101) / (104 - 98)));
  assert.equal(at(100).y, model.plot.top + model.plot.height * ((104 - 100) / (104 - 98)));

  for (const point of model.points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'no point is off the numbers');
    assert.ok(point.y >= model.plot.top && point.y <= model.plot.bottom, 'inside the plot area');
    assert.ok(point.x >= model.plot.left && point.x <= model.plot.right);
  }
});

test('Given a series in which every price is identical, when plot coordinates are computed, then the line is drawn level and centred rather than producing a divide-by-zero or NaN', () => {
  const model = chartPlot(seriesOf(6, { price: 100 }), PANEL);

  const ys = model.points.map((point) => point.y);
  assert.equal(ys.length, 6);
  assert.ok(ys.every(Number.isFinite), `expected numbers, got ${JSON.stringify(ys)}`);
  assert.equal(new Set(ys).size, 1, 'the line is level');
  assert.equal(ys[0], model.plot.top + model.plot.height / 2, 'and centred in the plot area');
  assert.equal(model.min, 100);
  assert.equal(model.max, 100);

  // The scale still has something to say, and it says the one price rather than a range.
  assert.ok(model.ticks.length >= 1);
  assert.ok(model.ticks.every((tick) => tick.price === 100 && Number.isFinite(tick.y)));

  // And it draws: a flat series is the ordinary state of a quiet book, not an error.
  const canvas = fakeCanvas(PANEL);
  assert.doesNotThrow(() => drawChart(canvas, seriesOf(6, { price: 100 })));
});

test('Given a series with fewer than two points, when the chart is drawn, then it renders an empty plot without error', () => {
  for (const series of [undefined, [], [{ price: 100, timeMs: 0 }]]) {
    const canvas = fakeCanvas(PANEL);

    // The stand-in refuses any non-finite coordinate, so this fails on a NaN as well as a throw.
    assert.doesNotThrow(
      () => drawChart(canvas, series),
      `drawing a series of ${series?.length ?? 'no'} points`,
    );
    assert.ok(canvas.context.calls.length > 0, 'the panel is drawn rather than left blank');
    assert.ok(
      drawnText(canvas).some((line) => /[a-z]/i.test(String(line))),
      'and still says in words what it is',
    );
  }

  // The geometry of those series is finite too, rather than an empty plot papering over a NaN.
  const none = chartPlot([], PANEL);
  assert.deepEqual(none.points, []);
  assert.equal(none.min, null, 'no prices, so no range');
  assert.equal(none.max, null);
  assert.deepEqual(none.ticks, []);

  const one = chartPlot([{ price: 100, timeMs: 0 }], PANEL);
  assert.equal(one.points.length, 1);
  assert.ok(Number.isFinite(one.points[0].x) && Number.isFinite(one.points[0].y));
});

test('Given the page has been open for a minute, when the chart is watched, then the line extends and older points leave the left-hand edge', () => {
  const state = createSimulation();

  const opening = midSeries(state);
  assert.ok(opening.length > 0, 'the chart opens with the history the warmup already produced');
  assert.ok(opening.length < FLOW.chartPoints, 'and with room left in the window to extend into');
  const wasLeftEdge = opening[0];

  // A minute of wall clock, a second at a time, as the animation loop would.
  for (let i = 0; i < 60; i += 1) advance(state, 1000);
  const later = midSeries(state);

  assert.ok(later.length > opening.length, 'the line has extended');
  assert.equal(later.length, FLOW.chartPoints, 'up to its bound, where it stops growing (NFR-4)');
  assert.ok(!later.includes(wasLeftEdge), 'the point that was at the left-hand edge has left it');
  assert.ok(
    later.at(-1).timeMs > opening.at(-1).timeMs,
    'and the right-hand end of the line has moved on',
  );

  // Another minute: still bounded, and the left-hand edge has moved on again.
  const leftEdge = later[0];
  for (let i = 0; i < 60; i += 1) advance(state, 1000);
  const latest = midSeries(state);

  assert.equal(latest.length, FLOW.chartPoints, 'still bounded (NFR-4)');
  assert.ok(!latest.includes(leftEdge), 'older points keep leaving the left-hand edge');

  // Oldest first at all times, so the newest point is the right-hand end of the line.
  const times = timesOf(latest);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the series runs oldest to newest');

  // And what is on the chart is the price the readout is showing.
  assert.ok(pricesOf(latest).every(Number.isFinite), 'every plotted price is a number');

  // A window this full reaches the right-hand edge, within the one sample it is short of it.
  const model = chartPlot(latest, PANEL);
  assert.ok(
    model.plot.right - model.points.at(-1).x <= model.plot.width / 100,
    'the newest point is at the right-hand end of the plot',
  );
});

// --- the line extends rightwards while the window fills -----------------------------------

test('Given a window not yet full, when the plot is computed, then the line starts at the left-hand edge and extends towards the right as points arrive', () => {
  const size = { ...PANEL, windowMs: 60000 };

  const early = chartPlot(seriesOf(60), size); // 11.8s of a 60s window
  const later = chartPlot(seriesOf(120), size); // 23.8s of it

  assert.equal(early.points[0].x, early.plot.left, 'the line begins at the left-hand edge');
  assert.ok(early.points.at(-1).x < early.plot.right, 'and stops short of the right-hand one');
  assert.ok(later.points.at(-1).x > early.points.at(-1).x, 'the line has extended to the right');
  assert.equal(later.points[0].x, later.plot.left, 'still anchored at the left-hand edge');

  // The horizontal scale is the window, not the data: a second of flow is the same number of
  // pixels whether the window is a third full or completely full.
  const perMs = (model) =>
    (model.points.at(-1).x - model.points[0].x) / (model.points.at(-1).timeMs - model.points[0].timeMs);
  assert.ok(Math.abs(perMs(early) - perMs(later)) < 1e-9, 'the same pixels per second throughout');
  assert.equal(early.endMs - early.startMs, 60000, 'the axis always spans the whole window');
});

test('Given a window that is full, when a newer point is recorded, then the window moves on and the oldest point is no longer plotted', () => {
  const size = { ...PANEL, windowMs: 60000 };
  const full = seriesOf(300, { price: (i) => 100 + (i % 5) });

  const before = chartPlot(full, size);
  const after = chartPlot(
    recordMid(full, 102, { limit: 300, timeMs: 300 * 200 }),
    size,
  );

  assert.ok(after.startMs > before.startMs, 'the left-hand edge is a later moment than it was');
  assert.equal(after.points.length, before.points.length, 'the window holds as much as it did');
  assert.ok(
    !after.points.some((point) => point.timeMs === before.points[0].timeMs),
    'the point that was at the left-hand edge is no longer on the chart',
  );
});

// --- the vertical scale adapts to what is present -----------------------------------------

test('Given a series whose prices move only a little, when it is plotted, then the scale adapts so the move is visible rather than flattened', () => {
  const wide = chartPlot(seriesOf(50, { price: (i) => 100 + (i % 2) * 10 }), PANEL);
  const narrow = chartPlot(seriesOf(50, { price: (i) => 100 + (i % 2) * 0.5 }), PANEL);

  const spread = (model) => {
    const ys = model.points.map((point) => point.y);
    return Math.max(...ys) - Math.min(...ys);
  };

  assert.equal(spread(narrow), spread(wide), 'a small move fills the plot as a large one does');
  assert.equal(spread(narrow), narrow.plot.height);
  assert.equal(narrow.min, 100);
  assert.equal(narrow.max, 100.5);
});

// --- enough labelling to read a price off it, and no more (NFR-3) -------------------------

test('Given a plotted series, when the vertical scale is labelled, then a price can be read off it from a few labels rather than a dense grid', () => {
  const ticks = chartPriceTicks(98, 104, 3);

  assert.deepEqual(ticks, [104, 101, 98], 'the range and its middle, highest first');
  assert.ok(ticks.every(Number.isFinite));

  const model = chartPlot(seriesOf(50, { price: (i) => 98 + (i % 7) }), PANEL);
  assert.ok(model.ticks.length >= 2, 'the scale is labelled');
  assert.ok(model.ticks.length <= 4, 'glanceable, not an analysis tool');
  assert.equal(model.ticks[0].y, model.plot.top, 'the top label is the top of the plot area');
  assert.equal(model.ticks.at(-1).y, model.plot.bottom, 'and the bottom label the bottom of it');
  for (const tick of model.ticks) {
    assert.ok(tick.price >= model.min && tick.price <= model.max, 'no label outside the range');
    assert.ok(Number.isFinite(tick.y));
    assert.equal(formatPrice(tick.price), tick.price.toFixed(2), 'labelled as a price');
  }

  // A range of nothing is one label, not three of the same number.
  assert.deepEqual(chartPriceTicks(100, 100, 3), [100]);
});

test('Given the chart, when it is read, then it says in words what it shows and how far back the left-hand edge is', () => {
  assert.ok(/[a-z]/i.test(CHART_CAPTION), `expected words, got ${JSON.stringify(CHART_CAPTION)}`);
  assert.ok(CHART_CAPTION.trim().split(/\s+/).length >= 3, 'a sentence rather than a heading');

  assert.equal(formatChartAge(60000), '60 seconds ago');
  assert.equal(formatChartAge(30000), '30 seconds ago');
  assert.equal(formatChartAge(180000), '3 minutes ago');
  assert.equal(formatChartAge(Number.NaN), '', 'nothing to say rather than something wrong');
});

test('Given a running page, when the chart is drawn from it, then it draws without error and marks the current price', () => {
  const state = createSimulation();
  advance(state, 5000);
  const series = midSeries(state);
  const canvas = fakeCanvas(PANEL);

  assert.doesNotThrow(() => drawChart(canvas, series, { windowMs: FLOW.chartWindowMs }));

  const current = formatPrice(series.at(-1).price);
  assert.ok(
    drawnText(canvas).includes(current),
    `expected the current price ${current} on the chart, drew ${JSON.stringify(drawnText(canvas))}`,
  );
  assert.ok(drawnText(canvas).includes(formatChartAge(FLOW.chartWindowMs)), 'and the time axis');
});

// --- NFR-4: the series cannot grow without limit ------------------------------------------

test('Given no bound is given, when mid prices are recorded, then the series is still bounded by a stated default', () => {
  assert.ok(Number.isInteger(CHART_LIMIT) && CHART_LIMIT > 0, 'the default bound is stated');
  assert.ok(Number.isInteger(FLOW.chartPoints) && FLOW.chartPoints > 0, 'the page runs bounded');

  let series = [];
  for (let i = 0; i < CHART_LIMIT + 50; i += 1) {
    series = recordMid(series, 100 + (i % 3), { timeMs: i * 200 });
  }

  assert.equal(series.length, CHART_LIMIT);
});

test('Given the page runs, when its window and its bound are compared, then what it remembers covers the window it plots', () => {
  assert.ok(FLOW.chartSampleMs > 0, 'the mid is sampled on a stated cadence');
  assert.ok(FLOW.chartWindowMs > 0);
  assert.ok(
    Math.abs(FLOW.chartPoints * FLOW.chartSampleMs - FLOW.chartWindowMs) <= FLOW.chartSampleMs,
    `${FLOW.chartPoints} points every ${FLOW.chartSampleMs}ms does not cover a ${FLOW.chartWindowMs}ms window`,
  );
  assert.equal(CHART_WINDOW_MS, FLOW.chartWindowMs, 'the page runs the stated window');
});

// --- REQ-5: the same seed draws the same chart ---------------------------------------------

test('Given the same seed, when the page is loaded twice, then the chart plots the same series both times', () => {
  const a = createSimulation(4242);
  const b = createSimulation(4242);
  advance(a, 4000);
  advance(b, 4000);

  assert.deepEqual(midSeries(a), midSeries(b));
  assert.ok(midSeries(a).length > 0);
});

test('Given the mid price the readout shows, when the chart samples it, then the two agree', () => {
  const state = createSimulation();
  advance(state, 2000);
  const before = midSeries(state);

  // In steps small enough to carry at most one event each, so that the mid read once a point
  // has appeared is the mid at the moment that point was taken.
  let series = before;
  for (let i = 0; i < 500 && series.length === before.length; i += 1) {
    advance(state, 20);
    series = midSeries(state);
  }

  assert.equal(series.length, before.length + 1, 'one more point has been sampled');
  assert.equal(series.at(-1).price, topOfBook(touchLevels(state)).mid);
});
