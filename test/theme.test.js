// Tests for LLD-66: a light theme for the whole page, chosen by a toggle and remembered.
// NFR-3 is re-checked here, under the new palette rather than only the one it was written for.
//
// Written first from the ticket's acceptance criteria and from the PRD, never by reading an
// implementation (NFR-5). Test names echo the criteria so each can be matched to a line in
// the ticket.
//
// What a viewer can see - that the page is light - is checked on the deploy preview. What
// cannot be seen from the screen is checked here: that the panels are drawn in the palette
// they were asked for and in no other, that the stylesheet and the canvas agree about what
// each theme's colours are, that the remembered choice survives a reload, and that a storage
// that refuses to answer leaves the toggle working rather than throwing.
//
// The surface these tests fix:
//
//   DEFAULT_THEME                  -> 'dark'
//   THEME_NAMES                    -> ['dark', 'light']
//   themeName(value)               -> 'dark' | 'light', anything else being the default
//   themePalette(name)             -> the colours the canvases are drawn in
//   toggleTheme(name)              -> the other one
//   themeControl(name)             -> { theme, label, status }, all words, no numbers
//   drawLadder/drawQueues/drawChart(..., { theme })
//   THEME_STORAGE_KEY              -> where the choice is kept
//   readStoredTheme(storage)       -> the remembered choice, or the default
//   writeStoredTheme(storage, name)-> boolean, false when it could not be kept

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_THEME,
  THEME_NAMES,
  themeControl,
  themeName,
  themePalette,
  toggleTheme,
  drawChart,
  drawLadder,
  drawQueues,
  recordMid,
} from '../public/src/render.js';
import {
  THEME_STORAGE_KEY,
  readStoredTheme,
  writeStoredTheme,
  createSimulation,
  ladderDepth,
  midSeries,
  touchQueues,
  touchLevels,
  tradeTape,
} from '../public/src/app.js';
import { fakeCanvas, drawnColours, drawnText } from './support/canvas.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const STYLE = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));

// --- helpers ----------------------------------------------------------------------------

// A localStorage that works, and one that does not. Private browsing throws on access rather
// than returning nothing, which is the case the ticket calls out.
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function blockedStorage() {
  const refuse = () => {
    throw new Error('storage is blocked');
  };
  return { getItem: refuse, setItem: refuse };
}

// Every colour a palette contains, however deeply it is nested.
function paletteColours(palette) {
  if (typeof palette === 'string') return [palette];
  if (palette === null || typeof palette !== 'object') return [];
  return Object.values(palette).flatMap(paletteColours);
}

// The custom properties one theme sets, read out of the page's own stylesheet. Blocks are
// taken in document order so a later one overriding an earlier one is read the way a browser
// would read it.
function themeVariables(theme) {
  const found = new Map();

  for (const chunk of STYLE.split('}')) {
    const [selector, ...rest] = chunk.split('{');
    if (rest.length === 0) continue;

    const target = selector.trim();
    const light = target.includes('data-theme="light"');
    const dark = /^:root\s*(,|$)/.test(target) || target.includes('data-theme="dark"');
    if (!(theme === 'light' ? light : dark && !light)) continue;

    for (const [, name, value] of rest.join('{').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      found.set(name, value.trim());
    }
  }

  return found;
}

// WCAG relative luminance and contrast, so "readable against the light background" is a number
// rather than an opinion. Hex only: a colour with an alpha channel sits over whatever is behind
// it and has no contrast of its own to measure.
function luminance(hex) {
  const channels = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  assert.ok(channels, `${hex} is not a plain hex colour`);

  const [r, g, b] = channels.slice(1).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Everything the loop reads out of the simulation, as one string - so a theme switch can be
// shown to have changed none of it.
function display(state) {
  return JSON.stringify({
    ladder: ladderDepth(state),
    queues: touchQueues(state),
    readout: touchLevels(state),
    tape: tradeTape(state),
    chart: midSeries(state),
  });
}

// The three canvases, drawn in one theme.
function drawPanels(theme) {
  const state = createSimulation(20260826);
  const series = [0, 1, 2, 3, 4, 5].reduce(
    (points, i) => recordMid(points, 100 + i * 0.25, { timeMs: i * 200 }),
    [],
  );

  const ladder = fakeCanvas({ width: 900, height: 620 });
  const queues = fakeCanvas({ width: 520, height: 620 });
  const chart = fakeCanvas({ width: 1200, height: 200 });

  drawLadder(ladder, ladderDepth(state), { maxLevels: 7, theme });
  drawQueues(queues, touchQueues(state), { maxSegments: 7, theme });
  drawChart(chart, series, { theme });

  return { ladder, queues, chart };
}

const PANELS = ['ladder', 'queues', 'chart'];

// --- acceptance criteria ---------------------------------------------------------------

test('Given the simulation is displayed in dark mode, when the viewer clicks the theme toggle, then the ladder, queue view, tape, chart and readout all redraw in the light theme without a page reload', () => {
  const dark = drawPanels('dark');
  const light = drawPanels('light');
  const lightColours = new Set(paletteColours(themePalette('light')));
  const darkColours = new Set(paletteColours(themePalette('dark')));

  for (const panel of PANELS) {
    const used = drawnColours(light[panel]);
    assert.ok(used.length > 0, `the ${panel} drew something`);
    for (const colour of used) {
      assert.ok(
        lightColours.has(colour),
        `the ${panel} drew ${colour}, which is not a light-theme colour`,
      );
    }

    // ...and it is genuinely a different picture, not the same one relabelled.
    assert.notDeepEqual(used, drawnColours(dark[panel]), `the ${panel} redrew in new colours`);
    for (const colour of drawnColours(dark[panel])) {
      assert.ok(darkColours.has(colour), `the ${panel} in dark drew ${colour}, off-palette`);
    }
  }

  // The tape and the readout are markup rather than canvas, so their colours are the page's
  // custom properties. Each theme declares the same set of them, and the canvases are drawn
  // in the values the stylesheet gives that theme - one palette, both halves of the page.
  const declared = { dark: themeVariables('dark'), light: themeVariables('light') };
  assert.deepEqual(
    [...declared.light.keys()].sort(),
    [...declared.dark.keys()].sort(),
    'the light theme sets every colour the dark theme sets',
  );

  for (const theme of THEME_NAMES) {
    const palette = themePalette(theme);
    const vars = declared[theme];
    for (const [name, colour] of Object.entries({
      '--paper': palette.paper,
      '--panel': palette.panel,
      '--ink': palette.text,
      '--muted': palette.muted,
      '--ask': palette.ask.text,
      '--bid': palette.bid.text,
    })) {
      assert.equal(
        vars.get(name)?.toLowerCase(),
        colour.toLowerCase(),
        `${name} in ${theme} agrees with the canvas palette`,
      );
    }
  }

  // Nothing outside those two blocks may state a colour of its own, or it would stay dark
  // when everything around it turned light.
  const themed = STYLE.replaceAll(/:root[^{]*\{[^}]*\}/g, '');
  for (const [declaration, value] of themed.matchAll(
    /(?:^|[\s;{])(?:color|background|background-color|border[\w-]*|outline[\w-]*|fill)\s*:\s*([^;}]+)/g,
  )) {
    assert.ok(
      !/#[\da-f]{3,8}\b|\brgba?\(/i.test(value),
      `a colour is hard-coded outside the theme blocks: ${declaration.trim()}`,
    );
  }

  // Redrawn, not reloaded: switching theme touches nothing the simulation holds.
  const state = createSimulation(11);
  const before = display(state);
  drawLadder(fakeCanvas(), ladderDepth(state), { theme: 'light' });
  assert.equal(display(state), before);
});

test('Given the page is in light mode, when the viewer activates the toggle again, then the page returns to the dark theme', () => {
  assert.equal(toggleTheme('dark'), 'light');
  assert.equal(toggleTheme('light'), 'dark');
  assert.equal(toggleTheme(toggleTheme('dark')), 'dark');
  assert.deepEqual([...THEME_NAMES].sort(), ['dark', 'light']);
});

test('Given the viewer has selected light mode, when the page is reloaded, then it opens directly in light mode without the viewer reselecting it', () => {
  const storage = fakeStorage();

  assert.equal(writeStoredTheme(storage, 'light'), true);
  // A reload is a fresh read of the same storage.
  assert.equal(readStoredTheme(storage), 'light');
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'light' })), 'light');

  assert.equal(writeStoredTheme(storage, 'dark'), true);
  assert.equal(readStoredTheme(storage), 'dark');
});

test('Given no theme has been saved before, when the page loads, then it opens in the existing default dark theme', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(readStoredTheme(fakeStorage()), 'dark');
  assert.equal(readStoredTheme(undefined), 'dark');

  // A stored value that is not a theme is no preference at all, not a third theme.
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' })), 'dark');
  assert.equal(themeName('sepia'), 'dark');
  assert.equal(themeName(undefined), 'dark');
  assert.equal(themeName('light'), 'light');
  assert.equal(themeName('dark'), 'dark');
});

test('Given localStorage is unavailable or blocked, when the viewer activates the toggle, then the theme still changes for the current session, and no error is shown', () => {
  const storage = blockedStorage();

  assert.equal(readStoredTheme(storage), 'dark', 'a storage that throws reads as no preference');
  assert.equal(writeStoredTheme(storage, 'light'), false, 'and reports that it could not keep it');

  // The choice itself is not storage's to make: the toggle still answers.
  assert.equal(toggleTheme(readStoredTheme(storage)), 'light');
  assert.equal(themeControl('light').theme, 'light');
  assert.ok(paletteColours(themePalette('light')).length > 0);
});

test('Given either theme is active, when the toggle control is inspected, then it is labelled in words, not a bare icon, and legible from the back of a room', () => {
  for (const theme of THEME_NAMES) {
    const control = themeControl(theme);
    assert.equal(control.theme, theme);

    for (const [field, text] of Object.entries({ label: control.label, status: control.status })) {
      assert.equal(typeof text, 'string', `the ${field} is text`);
      assert.ok(/[a-z]{3}/i.test(text), `the ${field} is words, got ${JSON.stringify(text)}`);
      assert.ok(!/\d/.test(text), `the ${field} shows no number, got ${JSON.stringify(text)}`);
    }
  }

  // It says what it will do next, not which theme is on: a control labelled with its own state
  // is read as a description by half a room and as an action by the other half.
  assert.match(themeControl('dark').label, /light/i);
  assert.match(themeControl('light').label, /dark/i);
  assert.notEqual(themeControl('dark').label, themeControl('light').label);
  assert.notEqual(themeControl('dark').status, themeControl('light').status);

  // ...and the page carries a real button with the slots those words are written into.
  assert.match(INDEX, /<button[^>]*data-theme-control="toggle"/, 'the control is a button');
  assert.match(INDEX, /data-theme-control="status"/, 'the current theme has a slot');
  assert.match(INDEX, /id="theme"/, 'the loop has a control to wire itself to');

  // Set at the size of the control beside it, and nowhere near the size of the mid price:
  // readable at the back of the room without competing with the number that matters (REQ-13).
  const sizeOf = (selector) => {
    const rule = new RegExp(`${selector}\\s*\\{[^}]*font-size:([^;]+);`).exec(STYLE);
    assert.ok(rule, `${selector} sets its own type size`);
    return Math.max(...[...rule[1].matchAll(/([\d.]+)rem/g)].map((match) => Number(match[1])));
  };

  const theme = sizeOf('\\.theme-button');
  assert.ok(theme >= sizeOf('\\.playback-button'), 'the toggle is set no smaller than the button beside it');
  assert.ok(theme < sizeOf('\\.quote\\.mid \\.quote-price') / 2, 'and nowhere near the mid price');
});

test('Given rapid toggling between themes, when the display is redrawn, then there is no flash of unstyled content or broken partial redraw', () => {
  // The theme is settled before the first paint rather than by the module that draws: a
  // deferred module runs after the page has been painted, which is the flash. So the page
  // itself sets the attribute, from the same key the wiring uses.
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.match(head, /<script(?![^>]*type="module")[^>]*>/, 'the page settles the theme before it paints');
  assert.ok(head.includes(THEME_STORAGE_KEY), 'and reads the same key the wiring writes');
  assert.match(head, /try\s*\{/, 'and cannot throw where storage is blocked');
  assert.ok(
    head.indexOf('<script') < head.indexOf('<style'),
    'the attribute is set before the stylesheet that reads it',
  );

  // Toggling is a pure change of name, so a hundred of them in a row leave one theme rather
  // than a half-applied mixture of two.
  let theme = DEFAULT_THEME;
  for (let i = 0; i < 100; i += 1) theme = toggleTheme(theme);
  assert.equal(theme, DEFAULT_THEME);

  // ...and every redraw in between is a whole panel: the same words, the same shapes, only
  // the colours differ.
  const dark = drawPanels('dark');
  const light = drawPanels('light');
  for (const panel of PANELS) {
    assert.deepEqual(drawnText(light[panel]), drawnText(dark[panel]), `the ${panel} says the same`);
    assert.equal(
      light[panel].context.calls.length,
      dark[panel].context.calls.length,
      `the ${panel} draws the same shapes`,
    );
  }
});

// --- NFR-3 under the light palette ------------------------------------------------------

test('Given the light palette, when the bid and ask sides are distinguished, then it is not by colour alone', () => {
  const { ladder, queues } = drawPanels('light');

  // The words are still there, on both panels, and so are the markers beside them.
  const said = drawnText(ladder).join(' ');
  assert.match(said, /Asks/);
  assert.match(said, /Bids/);
  assert.match(drawnText(queues).join(' '), /Sellers waiting|Buyers waiting/);

  const palette = themePalette('light');
  assert.notEqual(palette.bid.text, palette.ask.text, 'the two sides are still told apart by colour too');
  assert.ok(
    contrast(palette.bid.text, palette.ask.text) > 1.2,
    'and the two side colours are not the same tone in greyscale',
  );
});

test('Given the light background, when the chart line and the ladder bars are drawn, then they remain readable against it', () => {
  for (const theme of THEME_NAMES) {
    const palette = themePalette(theme);
    const surface = palette.panel;

    for (const [name, colour] of Object.entries({
      text: palette.text,
      muted: palette.muted,
      'ask.text': palette.ask.text,
      'bid.text': palette.bid.text,
      'ask.edge': palette.ask.edge,
      'bid.edge': palette.bid.edge,
      'price.line': palette.price.line,
      'price.tag': palette.price.tag,
    })) {
      const ratio = contrast(colour, surface);
      assert.ok(
        ratio >= 4.5,
        `${theme} ${name} (${colour}) is ${ratio.toFixed(2)}:1 against the panel, under 4.5:1`,
      );
    }

    // The label inside a filled segment sits on the side's own colour, not on the panel.
    for (const side of ['ask', 'bid']) {
      const ratio = contrast(palette.solidInk, palette[side].edge);
      assert.ok(
        ratio >= 4.5,
        `${theme} ink on a filled ${side} segment is ${ratio.toFixed(2)}:1, under 4.5:1`,
      );
    }
  }
});
