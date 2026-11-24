/**
 * plot.js — a small, safe function plotter
 *
 * Compiles "y = x^2 + 2x - 1" (or sin(x), 1/x, sqrt(x)…) into a JS function
 * without eval, then draws it on a canvas with axes and a grid. Used by the
 * maths tools in the study panel.
 */

const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

const TOKEN = /\s*(?:(\d+\.?\d*|\.\d+)|([a-zA-Z_][a-zA-Z0-9_]*)|([-+*/^(),]))/y;

function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < source.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(source);
    if (!match) {
      if (/^\s*$/.test(source.slice(index))) break;
      throw new Error(`Unexpected character “${source[index]}”.`);
    }
    if (match[1] !== undefined) tokens.push({ type: "num", value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: "name", value: match[2].toLowerCase() });
    else tokens.push({ type: "op", value: match[3] });
    index = TOKEN.lastIndex;
  }
  return tokens;
}

/**
 * Parses an expression into an AST.
 * Grammar: expression → term (('+'|'-') term)*
 *          term       → unary (('*'|'/') unary | implicit-multiply)*
 *          unary      → ('-'|'+') unary | power
 *          power      → atom ('^' unary)?
 *          atom       → number | x | constant | func '(' expression ')' | '(' expression ')'
 */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (value) => {
    const token = tokens[pos];
    if (!token) return false;
    if (value && token.value !== value) return false;
    pos += 1;
    return token;
  };

  function expression() {
    let node = term();
    while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = eat().value;
      node = { type: "binary", op, left: node, right: term() };
    }
    return node;
  }

  function startsAtom(token) {
    if (!token) return false;
    return token.type === "num" || token.type === "name" || token.value === "(";
  }

  function term() {
    let node = unary();
    for (;;) {
      const token = peek();
      if (token && token.type === "op" && (token.value === "*" || token.value === "/")) {
        const op = eat().value;
        node = { type: "binary", op, left: node, right: unary() };
        continue;
      }
      // Implicit multiplication: 2x, 3(x+1), x sin(x)
      if (startsAtom(token)) {
        node = { type: "binary", op: "*", left: node, right: unary() };
        continue;
      }
      return node;
    }
  }

  function unary() {
    const token = peek();
    if (token && token.type === "op" && (token.value === "-" || token.value === "+")) {
      eat();
      const inner = unary();
      return token.value === "-" ? { type: "neg", value: inner } : inner;
    }
    return power();
  }

  function power() {
    const base = atom();
    const token = peek();
    if (token && token.type === "op" && token.value === "^") {
      eat();
      return { type: "binary", op: "^", left: base, right: unary() };
    }
    return base;
  }

  function atom() {
    const token = eat();
    if (!token) throw new Error("The expression ends too early.");
    if (token.type === "num") return { type: "num", value: token.value };
    if (token.type === "name") {
      if (token.value === "x") return { type: "var" };
      if (token.value in CONSTANTS) return { type: "num", value: CONSTANTS[token.value] };
      if (token.value in FUNCTIONS) {
        if (!eat("(")) throw new Error(`Use ${token.value}(x) — a bracket is missing.`);
        const arg = expression();
        if (!eat(")")) throw new Error("A closing bracket is missing.");
        return { type: "call", name: token.value, arg };
      }
      throw new Error(`Unknown name “${token.value}”. Try x, pi, e, sin, cos, sqrt, log…`);
    }
    if (token.value === "(") {
      const inner = expression();
      if (!eat(")")) throw new Error("A closing bracket is missing.");
      return inner;
    }
    throw new Error(`Unexpected “${token.value}”.`);
  }

  const tree = expression();
  if (pos < tokens.length) throw new Error(`Unexpected “${tokens[pos].value}”.`);
  return tree;
}

function evaluate(node, x) {
  switch (node.type) {
    case "num":
      return node.value;
    case "var":
      return x;
    case "neg":
      return -evaluate(node.value, x);
    case "call":
      return FUNCTIONS[node.name](evaluate(node.arg, x));
    case "binary": {
      const a = evaluate(node.left, x);
      const b = evaluate(node.right, x);
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (node.op === "/") return a / b;
      if (node.op === "^") return a ** b;
      return NaN;
    }
    default:
      return NaN;
  }
}

/**
 * Compiles an expression. Returns { ok: true, fn } or { ok: false, error }.
 * The function returns null where the curve is undefined (NaN/Infinity).
 */
export function compile(expression) {
  const source = String(expression || "")
    .trim()
    .replace(/^y\s*=\s*/i, "")
    .replace(/^f\s*\(\s*x\s*\)\s*=\s*/i, "");
  if (!source) return { ok: false, error: "Type a function of x, for example x^2 - 1." };
  if (source.length > 160) return { ok: false, error: "That expression is too long." };

  let tree;
  try {
    tree = parse(tokenize(source));
  } catch (err) {
    return { ok: false, error: err.message || "That expression could not be read." };
  }

  const fn = (x) => {
    try {
      const value = evaluate(tree, Number(x));
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  // A quick sanity sample stops things like sqrt(-x) rendering as an empty box.
  const probe = fn(1);
  return { ok: true, fn, sample: probe };
}

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Draws a compiled function. Returns { ok, error } so callers can show a
 * message instead of a blank canvas.
 */
export function draw(canvas, expression, { xMin = -10, xMax = 10 } = {}) {
  if (!canvas) return { ok: false, error: "No canvas to draw on." };
  const compiled = compile(expression);
  if (!compiled.ok) return compiled;

  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: "This browser cannot draw on a canvas." };

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 360;
  const height = canvas.clientHeight || 220;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const span = xMax - xMin;
  const samples = Math.max(120, Math.floor(width));
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = xMin + (span * i) / samples;
    points.push({ x, y: compiled.fn(x) });
  }
  const finite = points.filter((p) => p.y !== null);
  if (!finite.length) return { ok: false, error: "That function has no real values in this range." };

  // Robust y-range: ignore the extreme tails so one asymptote does not flatten
  // the whole curve.
  const ys = finite.map((p) => p.y).sort((a, b) => a - b);
  const low = ys[Math.floor(ys.length * 0.03)];
  const high = ys[Math.floor(ys.length * 0.97)];
  let yMin = Math.min(low, 0);
  let yMax = Math.max(high, 0);
  if (yMax - yMin < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;

  const toX = (x) => ((x - xMin) / span) * width;
  const toY = (y) => height - ((y - yMin) / (yMax - yMin)) * height;

  const grid = cssVar("--border", "rgba(255,255,255,0.1)");
  const ink = cssVar("--muted", "#8792ab");
  const accent = cssVar("--accent", "#6d5efc");

  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.beginPath();
  for (let i = 1; i < 10; i += 1) {
    const gx = (width * i) / 10;
    const gy = (height * i) / 10;
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
  }
  ctx.stroke();

  // Axes
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (yMin <= 0 && yMax >= 0) {
    ctx.moveTo(0, toY(0));
    ctx.lineTo(width, toY(0));
  }
  if (xMin <= 0 && xMax >= 0) {
    ctx.moveTo(toX(0), 0);
    ctx.lineTo(toX(0), height);
  }
  ctx.stroke();

  // Curve, split into segments so asymptotes are not joined across the gap.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let drawing = false;
  let previous = null;
  for (const point of points) {
    if (point.y === null) {
      drawing = false;
      previous = null;
      continue;
    }
    const px = toX(point.x);
    const py = toY(point.y);
    const gap = previous && Math.abs(py - previous.y) > height * 1.5;
    if (!drawing || gap) {
      ctx.moveTo(px, py);
      drawing = true;
    } else {
      ctx.lineTo(px, py);
    }
    previous = { y: py };
  }
  ctx.stroke();

  return {
    ok: true,
    error: "",
    range: { xMin, xMax, yMin: Number(yMin.toFixed(2)), yMax: Number(yMax.toFixed(2)) },
  };
}
