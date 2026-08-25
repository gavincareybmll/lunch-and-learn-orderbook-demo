// A stand-in for a canvas and its 2d context, so that a drawing function can be called under
// the test runner. Not a DOM: a headless browser would be a dependency (NFR-2).
//
// The drawings in render.js are verified by looking at the deploy preview, and that is the
// right place for "does it look right". What a person looking at the screen cannot see is a
// coordinate that arrived as NaN - the stroke simply does not appear, and an empty panel looks
// like a quiet market. So this refuses any non-finite number and turns a divide-by-zero into a
// failing test.
//
// It also records what it was asked to draw: `calls` is every call in order and `text` every
// string drawn, which is enough to assert that a panel said something rather than nothing.

const METHODS = [
  'arc', 'beginPath', 'clearRect', 'clip', 'closePath', 'fill', 'fillRect', 'fillText',
  'lineTo', 'moveTo', 'rect', 'restore', 'save', 'setLineDash', 'setTransform', 'stroke',
  'strokeRect',
];

export function fakeContext() {
  const calls = [];
  const text = [];
  const ctx = {
    calls,
    text,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };

  for (const method of METHODS) {
    ctx[method] = (...args) => {
      for (const [index, arg] of args.entries()) {
        if (typeof arg === 'number' && !Number.isFinite(arg)) {
          throw new Error(`ctx.${method} was given ${arg} as argument ${index}`);
        }
      }
      calls.push({ method, args });
      if (method === 'fillText') text.push(args[0]);
      return undefined;
    };
  }

  // Close enough to exercise the fits-or-not decisions a drawing makes; real widths are a
  // browser's business, and are what the preview is for.
  ctx.measureText = (value) => {
    const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '10');
    return { width: String(value).length * size * 0.6 };
  };

  return ctx;
}

export function fakeCanvas({ width = 900, height = 320 } = {}) {
  const context = fakeContext();
  return {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    context,
    getContext: () => context,
  };
}

// Every number a drawing put on screen, for asserting that a label a reader needs is there.
export const drawnText = (canvas) => canvas.context.text;

export const callsTo = (canvas, method) =>
  canvas.context.calls.filter((call) => call.method === method);
