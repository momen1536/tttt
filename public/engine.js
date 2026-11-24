/**
 * Nova — conversational intent engine
 * ------------------------------------------------------------------
 * A dependency-free NLU + response engine that runs entirely in the
 * browser (or any JS runtime). Pipeline:
 *
 *   1. normalise      — lowercase, expand contractions, collapse space
 *   2. memory rules   — name capture / recall, follow-up tracking
 *   3. precise rules  — greetings, smalltalk, tools (math, units, time)
 *   4. retrieval      — score every knowledge-base entry by keyword hits
 *   5. fallback       — a graceful, useful answer instead of a dead end
 *
 * Every response carries optional `chips`: suggested next questions that
 * keep the conversation moving without the user having to guess.
 */

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

export function createSession() {
  return {
    name: null,
    lastTopic: null,
    factIndex: 0,
    turn: 0,
    lastUserText: "",
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const STOP_NAMES = new Set([
  "a", "an", "the", "not", "so", "very", "really", "just", "still", "also",
  "tired", "sad", "happy", "fine", "good", "okay", "ok", "bored", "confused",
  "lost", "hungry", "sleepy", "angry", "stressed", "busy", "free", "here",
  "sorry", "from", "in", "at", "on", "doing", "trying", "learning", "studying",
  "working", "new", "back", "done", "ready", "curious", "excited", "nervous",
  "later", "now", "please", "still", "always", "never", "thinking",
]);

const TITLES = ["what", "who", "why", "how", "when", "where", "which"];

function normalise(input) {
  let s = String(input || "").toLowerCase().trim();
  s = s
    .replace(/[’‘]/g, "'")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/\bwhats\b/g, "what is")
    .replace(/\bwho's\b/g, "who is")
    .replace(/\bwhere's\b/g, "where is")
    .replace(/\bhow's\b/g, "how is")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\bi've\b/g, "i have")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bdoesn't\b/g, "does not")
    .replace(/\bisn't\b/g, "is not")
    .replace(/\baren't\b/g, "are not")
    .replace(/\bdidn't\b/g, "did not")
    .replace(/\bit's\b/g, "it is")
    .replace(/\blet's\b/g, "let us")
    .replace(/\bu\b/g, "you")
    .replace(/\bur\b/g, "your")
    .replace(/\br\b/g, "are")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

function titleCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pick(list, seed) {
  if (!list.length) return "";
  const i = Math.abs(seed) % list.length;
  return list[i];
}

function fmtNumber(n) {
  if (!Number.isFinite(n)) return "undefined";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString("en-US");
  const rounded = Math.round(n * 1e6) / 1e6;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("en-US");
  return String(rounded);
}

/** Conversions read better with a sane number of decimals. */
function fmtMeasure(n) {
  if (!Number.isFinite(n)) return "undefined";
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 3 : 4;
  const factor = Math.pow(10, dp);
  const rounded = Math.round(n * factor) / factor;
  return fmtNumber(rounded);
}

/* ------------------------------------------------------------------ */
/* Safe arithmetic evaluator (no eval, no Function constructor)        */
/* ------------------------------------------------------------------ */

function applyFn(name, v) {
  switch (name) {
    case "sqrt": return Math.sqrt(v);
    case "sin": return Math.sin(v);
    case "cos": return Math.cos(v);
    case "tan": return Math.tan(v);
    case "log": return Math.log10(v);
    case "ln": return Math.log(v);
    case "abs": return Math.abs(v);
    case "round": return Math.round(v);
    case "floor": return Math.floor(v);
    case "ceil": return Math.ceil(v);
    default: throw new Error("unknown function");
  }
}

export function evaluateExpression(raw) {
  const src = String(raw || "")
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/,/g, "")
    .toLowerCase();

  let i = 0;
  const peek = () => src[i];

  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  function term() {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[i++];
      const r = power();
      if (op === "*") v = v * r;
      else if (op === "/") v = v / r;
      else v = v % r;
    }
    return v;
  }

  function power() {
    const base = unary();
    if (peek() === "^") {
      i++;
      return Math.pow(base, power());
    }
    return base;
  }

  function unary() {
    if (peek() === "-") { i++; return -unary(); }
    if (peek() === "+") { i++; return unary(); }
    return atom();
  }

  function atom() {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() === ")") i++;
      return v;
    }
    const fn = /^(sqrt|sin|cos|tan|log|ln|abs|round|floor|ceil)/.exec(src.slice(i));
    if (fn) {
      i += fn[1].length;
      if (peek() === "(") {
        i++;
        const v = expr();
        if (peek() === ")") i++;
        return applyFn(fn[1], v);
      }
      throw new Error("bad function");
    }
    if (src.startsWith("pi", i)) { i += 2; return Math.PI; }
    const num = /^\d*\.?\d+(?:e[+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    if (peek() === "e") { i++; return Math.E; }
    throw new Error("unexpected token");
  }

  const result = expr();
  if (i !== src.length) throw new Error("trailing input");
  if (!Number.isFinite(result)) throw new Error("not finite");
  return result;
}

function looksLikeMath(raw) {
  const s = String(raw).replace(/[,\s]/g, "");
  if (!/\d/.test(s)) return false;
  if (!/[+\-*/^%x×÷]|sqrt|sin|cos|tan|log|ln|\(/.test(s)) return false;
  return /^[-+*/^%().\d\sa-z×÷,]+$/i.test(String(raw));
}

/* ------------------------------------------------------------------ */
/* Unit conversion                                                     */
/* ------------------------------------------------------------------ */

const UNIT_ALIASES = {
  km: "km", kilometer: "km", kilometers: "km", kilometre: "km", kilometres: "km",
  m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  cm: "cm", centimeter: "cm", centimeters: "cm",
  mm: "mm", millimeter: "mm", millimeters: "mm",
  mi: "mi", mile: "mi", miles: "mi",
  ft: "ft", foot: "ft", feet: "ft",
  in: "in", inch: "in", inches: "in",
  yd: "yd", yard: "yd", yards: "yd",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g",
  mg: "mg", milligram: "mg", milligrams: "mg",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  ml: "ml", milliliter: "ml", milliliters: "ml",
  gal: "gal", gallon: "gal", gallons: "gal",
  c: "c", celsius: "c", centigrade: "c",
  f: "f", fahrenheit: "f",
  k: "k", kelvin: "k",
  kmh: "kmh", kph: "kmh", mph: "mph", ms: "ms",
};

const LENGTH = { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 };
const MASS = { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523125 };
const VOLUME = { l: 1, ml: 0.001, gal: 3.785411784 };
const SPEED = { ms: 1, kmh: 0.277777778, mph: 0.44704 };

const UNIT_TABLE = { ...LENGTH, ...MASS, ...VOLUME, ...SPEED };
const UNIT_LABEL = {
  km: "km", m: "m", cm: "cm", mm: "mm", mi: "miles", ft: "ft", in: "in", yd: "yd",
  kg: "kg", g: "g", mg: "mg", lb: "lb", oz: "oz", l: "L", ml: "mL", gal: "gal",
  ms: "m/s", kmh: "km/h", mph: "mph", c: "°C", f: "°F", k: "K",
};

function convert(value, from, to) {
  const temp = ["c", "f", "k"];
  if (temp.includes(from) && temp.includes(to)) {
    let c;
    if (from === "c") c = value;
    else if (from === "f") c = (value - 32) * (5 / 9);
    else c = value - 273.15;
    if (to === "c") return c;
    if (to === "f") return c * (9 / 5) + 32;
    return c + 273.15;
  }
  const f = UNIT_TABLE[from];
  const t = UNIT_TABLE[to];
  if (f == null || t == null) return null;
  return (value * f) / t;
}

function tryConversion(raw) {
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?([a-z°]+)\s*(?:to|in|into|=|as)\s*(?:degrees?\s*)?([a-z°]+)$/i.exec(
    raw.trim().replace(/[?]/g, "")
  );
  if (!m) return null;
  const value = parseFloat(m[1]);
  const from = UNIT_ALIASES[m[2].toLowerCase().replace("°", "")];
  const to = UNIT_ALIASES[m[3].toLowerCase().replace("°", "")];
  if (!from || !to) return null;
  const out = convert(value, from, to);
  if (out == null) return null;
  return { value, from, to, out };
}

/* ------------------------------------------------------------------ */
/* Knowledge base                                                      */
/* ------------------------------------------------------------------ */

const KB = [
  {
    id: "ai",
    title: "AI & machine learning",
    keys: ["ai", "artificial intelligence", "machine learning", "ml", "deep learning", "neural network", "neural networks", "llm", "transformer", "model training", "supervised", "unsupervised"],
    summary:
      "Artificial intelligence is the field of building systems that perform tasks which normally need human intelligence — understanding language, recognising images, and making decisions.",
    points: [
      "**Machine learning** is a subset of AI where a model learns patterns from data instead of following hand-written rules.",
      "**Supervised learning** trains on labelled examples (input → correct answer). **Unsupervised** learning finds structure in unlabelled data. **Reinforcement learning** learns from reward signals.",
      "**Deep learning** stacks many neural-network layers. Modern language models are built on the *transformer* architecture, which uses attention to weigh relationships between words.",
      "A practical ML workflow is: collect data → clean it → split train/validation/test → train → evaluate → deploy → monitor for drift.",
      "The biggest risks are usually data quality and bias, not the algorithm — a model is only as fair as the data it learned from.",
    ],
    chips: ["Supervised vs unsupervised learning", "What is a neural network?", "How do I start an ML project?"],
  },
  {
    id: "ds",
    title: "Data structures",
    keys: ["data structure", "data structures", "array", "arrays", "linked list", "stack", "queue", "hash table", "hashmap", "tree", "binary tree", "bst", "graph", "heap", "dsa"],
    summary:
      "A data structure is a way of organising data in memory so that common operations — search, insert, delete — stay fast as the data grows.",
    points: [
      "**Arrays** give O(1) random access but costly middle insertions. **Linked lists** insert and delete in O(1) once you hold the node, but lose random access.",
      "**Stacks** (LIFO) power undo, recursion and expression parsing. **Queues** (FIFO) power scheduling and breadth-first search.",
      "**Hash tables** average O(1) lookup by mapping keys to buckets; collisions are handled with chaining or open addressing.",
      "**Trees** model hierarchy. A balanced binary search tree gives O(log n) search, insert and delete; a heap gives O(log n) priority-queue operations.",
      "**Graphs** model relationships — social networks, maps, dependency trees. BFS explores level by level; DFS dives deep and is natural for cycle detection.",
    ],
    chips: ["Array vs linked list", "Explain Big-O notation", "How does a hash table work?"],
  },
  {
    id: "complexity",
    title: "Algorithms & Big-O",
    keys: ["algorithm", "algorithms", "big o", "big-o", "complexity", "time complexity", "space complexity", "sorting", "binary search", "recursion", "dynamic programming"],
    summary:
      "Big-O describes how an algorithm's cost grows with input size n. It ignores constants and focuses on the shape of the growth curve.",
    points: [
      "Common classes from fast to slow: O(1) → O(log n) → O(n) → O(n log n) → O(n²) → O(2ⁿ) → O(n!).",
      "**Binary search** halves a *sorted* array each step, so it runs in O(log n) — 1,000,000 items need about 20 comparisons.",
      "Good comparison sorts (merge sort, heap sort) run in O(n log n); naive bubble/insertion sort is O(n²).",
      "**Recursion** solves a problem by calling itself on a smaller input; every recursive solution needs a base case or it will overflow the stack.",
      "**Dynamic programming** stores answers to overlapping sub-problems (memoisation or tabulation) and turns exponential brute force into polynomial time.",
    ],
    chips: ["Merge sort vs quick sort", "Explain dynamic programming", "What is space complexity?"],
  },
  {
    id: "dbms",
    title: "Databases & SQL",
    keys: ["dbms", "database", "databases", "sql", "mysql", "postgres", "normalization", "normalisation", "acid", "primary key", "foreign key", "join", "index", "nosql", "query"],
    summary:
      "A database management system stores structured data, enforces integrity rules, and lets many users query it safely at the same time.",
    points: [
      "A **primary key** uniquely identifies a row; a **foreign key** points at another table's key and prevents orphaned records.",
      "**Normalisation** removes redundancy: 1NF = atomic values, 2NF = no partial dependency on part of a composite key, 3NF = no transitive dependency between non-key columns.",
      "**ACID** — Atomicity, Consistency, Isolation, Durability — is the guarantee set that makes transactions safe.",
      "An **index** is a sorted side structure (usually a B-tree) that turns a full table scan into a logarithmic lookup, at the cost of extra writes and storage.",
      "`JOIN` combines rows from related tables: `INNER` keeps matches, `LEFT` keeps all left rows, `RIGHT` the mirror, `FULL` keeps both sides.",
    ],
    chips: ["Explain the types of JOIN", "What is database normalisation?", "SQL vs NoSQL"],
  },
  {
    id: "os",
    title: "Operating systems",
    keys: ["operating system", "operating systems", "os", "process", "thread", "deadlock", "scheduling", "paging", "virtual memory", "kernel", "semaphore", "mutex", "context switch"],
    summary:
      "An operating system is the layer between hardware and applications. It manages CPU time, memory, files, devices and security.",
    points: [
      "A **process** is a running program with its own memory space; a **thread** is a lighter unit of execution that shares that memory with sibling threads.",
      "**Scheduling** decides which ready process runs next — First Come First Served, Shortest Job First, Round Robin (good for interactivity), or priority scheduling.",
      "**Deadlock** needs four simultaneous conditions: mutual exclusion, hold-and-wait, no preemption, circular wait. Breaking any one of them prevents it.",
      "**Virtual memory** gives each process the illusion of a large contiguous address space; pages are mapped to physical frames and swapped to disk when memory is tight.",
      "A **mutex** is a lock for mutual exclusion; a **semaphore** is a counter that also allows signalling between threads.",
    ],
    chips: ["Process vs thread", "How does deadlock happen?", "Explain paging and virtual memory"],
  },
  {
    id: "networks",
    title: "Computer networks",
    keys: ["network", "networks", "networking", "tcp", "udp", "ip", "dns", "http", "https", "osi", "router", "subnet", "packet", "port", "latency"],
    summary:
      "Networking is about moving data between machines through agreed protocols, from the physical wire up to the application you are using.",
    points: [
      "The **TCP/IP** model has four layers: Link, Internet (IP), Transport (TCP/UDP), and Application (HTTP, DNS, SMTP).",
      "**TCP** is reliable and ordered, with handshakes, acknowledgements and retransmission. **UDP** is fire-and-forget: lower latency, no delivery guarantee — good for video and games.",
      "**DNS** translates names like `example.com` into IP addresses. **DHCP** hands out addresses. **NAT** lets many private devices share one public IP.",
      "HTTPS is HTTP carried inside **TLS**: certificates prove the server's identity, and the handshake negotiates keys for encryption.",
      "Common status codes: 200 OK, 301 Moved Permanently, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 500 Internal Server Error.",
    ],
    chips: ["TCP vs UDP", "What happens when I open a website?", "Explain the OSI model"],
  },
  {
    id: "oop",
    title: "Object-oriented programming",
    keys: ["oop", "object oriented", "object-oriented", "class", "classes", "inheritance", "polymorphism", "encapsulation", "abstraction", "interface", "solid"],
    summary:
      "OOP models a program as interacting objects: bundles of data (fields) and behaviour (methods) defined by a class.",
    points: [
      "The four pillars: **encapsulation** (hide internals behind a public surface), **abstraction** (expose what, hide how), **inheritance** (reuse via an is-a relationship), **polymorphism** (one interface, many implementations).",
      "**Overloading** is compile-time (same name, different parameters); **overriding** is runtime (a subclass replaces a superclass method).",
      "Prefer **composition** over deep inheritance trees — 'has-a' is usually more flexible than 'is-a'.",
      "**SOLID**: single responsibility, open/closed, Liskov substitution, interface segregation, dependency inversion.",
      "A class is the blueprint; an object is an instance of it with its own state.",
    ],
    chips: ["Explain the four pillars of OOP", "Inheritance vs composition", "What is SOLID?"],
  },
  {
    id: "webdev",
    title: "Web development",
    keys: ["web development", "web dev", "html", "css", "javascript", "frontend", "front end", "backend", "responsive", "dom", "react", "api", "rest"],
    summary:
      "A web page is HTML for structure, CSS for presentation, and JavaScript for behaviour. The browser requests assets over HTTP and renders them into the DOM.",
    points: [
      "**HTML** provides semantic structure (`header`, `main`, `button`). Meaningful tags help screen readers and search engines as much as they help you.",
      "**CSS** handles layout and style. Flexbox is one-dimensional; Grid is two-dimensional. Media queries adapt the layout to viewport size.",
      "**JavaScript** manipulates the DOM, reacts to events (`addEventListener`) and fetches data with `fetch()`, which returns a Promise resolving to a Response.",
      "A **REST API** exposes resources over HTTP verbs: GET reads, POST creates, PUT/PATCH updates, DELETE removes. JSON is the usual payload format.",
      "**React** builds UIs from components with state; it re-renders when state changes. Keys in lists, and stable component identity, matter for correctness and speed.",
    ],
    chips: ["Explain the DOM", "Flexbox vs CSS Grid", "How does fetch and async work?"],
  },
  {
    id: "python",
    title: "Python",
    keys: ["python", "pip", "django", "flask", "pandas", "numpy", "list comprehension", "virtualenv"],
    summary:
      "Python is a readable, dynamically typed language with a huge standard library and the dominant ecosystem for data work and scripting.",
    points: [
      "Indentation defines blocks — mixing tabs and spaces raises `IndentationError`, so configure your editor to use four spaces.",
      "Core containers: `list` (ordered, mutable), `tuple` (ordered, immutable), `dict` (key → value), `set` (unique, unordered).",
      "List comprehensions replace simple loops: `[x * 2 for x in items if x > 0]`.",
      "`with open(...) as f:` closes files safely even if an exception is raised — always prefer context managers for resources.",
      "Use a **virtual environment** (`python -m venv .venv`) per project so dependency versions do not collide globally.",
    ],
    chips: ["List vs tuple vs set", "What is a virtual environment?", "How do I read a file safely?"],
  },
  {
    id: "js",
    title: "JavaScript & async",
    keys: ["async", "promise", "promises", "await", "event loop", "closure", "hoisting", "callback", "json", "node"],
    summary:
      "JavaScript runs on a single thread with an event loop: synchronous code runs to completion, then queued callbacks and promise reactions are processed.",
    points: [
      "`let` and `const` are block-scoped; `var` is function-scoped and hoisted. Prefer `const` unless reassignment is genuinely needed.",
      "A **Promise** is a placeholder for a future value with three states: pending, fulfilled, rejected. `async`/`await` is syntax sugar over promises.",
      "`await` pauses only the enclosing async function, never the whole thread — other work continues while it waits.",
      "A **closure** is a function that remembers the variables from the scope where it was created, even after that scope has returned.",
      "Always use `===` (strict equality); `==` performs type coercion and produces surprising results like `'' == 0` being true.",
    ],
    chips: ["Explain the event loop", "Promises vs callbacks", "What is a closure?"],
  },
  {
    id: "cloud",
    title: "Cloud computing",
    keys: ["cloud", "cloud computing", "aws", "azure", "gcp", "serverless", "iaas", "paas", "saas", "docker", "kubernetes", "container", "cdn"],
    summary:
      "Cloud computing rents compute, storage and services on demand over the internet, paying for what you use instead of owning hardware.",
    points: [
      "**IaaS** gives raw infrastructure (virtual machines, networks). **PaaS** gives a managed runtime. **SaaS** gives a finished application.",
      "**Serverless** (functions, edge workers) scales automatically and bills per request; you trade control over the runtime for zero idle cost.",
      "**Containers** package an app with its dependencies; **Kubernetes** orchestrates many containers across machines.",
      "A **CDN** caches content at edge locations close to users, cutting latency and origin load.",
      "Design for failure: assume instances die, replicate state, and keep secrets out of code and images.",
    ],
    chips: ["IaaS vs PaaS vs SaaS", "What is serverless?", "How do containers work?"],
  },
  {
    id: "security",
    title: "Cyber security",
    keys: ["security", "cyber", "cybersecurity", "encryption", "hashing", "phishing", "sql injection", "xss", "https", "tls", "password", "authentication", "authorization", "2fa"],
    summary:
      "Security is about protecting confidentiality, integrity and availability (the CIA triad) against attackers with realistic capabilities.",
    points: [
      "**Encryption** is reversible with a key; **hashing** is one-way and used for storing passwords (with a salt and a slow algorithm like bcrypt or Argon2).",
      "**Phishing** targets people, not servers — verify sender domains, avoid unexpected links, and enable 2FA.",
      "**SQL injection** happens when user input is concatenated into queries. Fix it with parameterised queries, never string building.",
      "**XSS** injects scripts into pages other users view. Escape output, use a Content-Security-Policy, and avoid `innerHTML` with untrusted data.",
      "**Authentication** proves who you are; **authorization** decides what you may do. Check both server-side — never trust the client.",
    ],
    chips: ["Hashing vs encryption", "What is SQL injection?", "Explain authentication vs authorization"],
  },
  {
    id: "sdlc",
    title: "Software engineering",
    keys: ["sdlc", "software engineering", "agile", "scrum", "waterfall", "git", "version control", "testing", "unit test", "requirements", "sprint"],
    summary:
      "Software engineering applies a repeatable process — requirements, design, implementation, testing, deployment, maintenance — to build reliable software in a team.",
    points: [
      "**Waterfall** is sequential and documentation-heavy. **Agile** delivers in short iterations with continuous feedback; Scrum adds sprints, roles and ceremonies.",
      "**Git** records snapshots. Branches isolate work, commits are local, and pull requests review changes before merging into main.",
      "Testing levels: unit (one function), integration (modules together), system (whole product), acceptance (does it meet the requirement).",
      "A good bug report states steps to reproduce, expected vs actual behaviour, and environment details.",
      "Requirements should be testable: 'the page loads in under 2 seconds' beats 'the page should be fast'.",
    ],
    chips: ["Agile vs waterfall", "Explain Git branching", "What makes a good test?"],
  },
  {
    id: "datascience",
    title: "Data science",
    keys: ["data science", "data analysis", "statistics", "probability", "regression", "overfitting", "visualisation", "visualization", "dataset", "correlation"],
    summary:
      "Data science turns raw data into decisions: clean and explore it, model it statistically, then communicate what it means.",
    points: [
      "The pipeline: collect → clean → explore (EDA) → model → evaluate → communicate. Cleaning usually takes the largest share of the time.",
      "**Correlation does not imply causation** — a third variable or coincidence can explain a strong correlation.",
      "**Overfitting** means memorising the training set; it shows up as high training accuracy but poor validation accuracy. Fix it with more data, regularisation or simpler models.",
      "Choose metrics by problem: accuracy for balanced classes, precision/recall or F1 when one class matters more, RMSE/MAE for regression.",
      "A visualisation should answer one question — clear axes, honest scales, and no chart junk.",
    ],
    chips: ["What is overfitting?", "Precision vs recall", "How do I explore a dataset?"],
  },
  {
    id: "blockchain",
    title: "Blockchain",
    keys: ["blockchain", "bitcoin", "ethereum", "smart contract", "smart contracts", "crypto", "cryptocurrency", "distributed ledger", "consensus", "nft"],
    summary:
      "A blockchain is an append-only distributed ledger where each block contains a hash of the previous one, making history tamper-evident.",
    points: [
      "Because each block commits to its predecessor's hash, changing an old block breaks every later hash — that is what makes it tamper-evident, not unbreakable.",
      "**Proof of Work** spends computation to earn the right to add a block; **Proof of Stake** selects validators weighted by staked value.",
      "**Smart contracts** are programs deployed on-chain that execute automatically when conditions are met.",
      "Real trade-offs: throughput, energy use, storage growth, and the irreversibility of mistakes.",
      "Good fits are cases needing shared, auditable history between parties who do not fully trust each other — supply chains, provenance, settlement.",
    ],
    chips: ["How does a block get added?", "Proof of work vs proof of stake", "What is a smart contract?"],
  },
  {
    id: "iot",
    title: "Internet of Things",
    keys: ["iot", "internet of things", "sensor", "sensors", "arduino", "raspberry pi", "mqtt", "embedded", "actuator", "edge computing"],
    summary:
      "IoT connects physical devices — sensors and actuators — to networks so they can report state and be controlled remotely.",
    points: [
      "A typical stack: device → gateway → broker/cloud → dashboard. **MQTT** is popular because it is lightweight and publish/subscribe.",
      "**Edge computing** processes data near the device to cut latency and bandwidth when the round trip to the cloud is too slow.",
      "Power is the hard constraint for battery devices — radio transmission usually dominates the energy budget.",
      "Security is the weak point: default passwords, unencrypted traffic and missing update paths have enabled large botnets.",
      "Start with a single sensor and a clear question ('is the room too hot?') rather than collecting everything.",
    ],
    chips: ["How does MQTT work?", "What is edge computing?", "How do I secure an IoT device?"],
  },
  {
    id: "maths",
    title: "Mathematics",
    keys: ["math", "maths", "mathematics", "algebra", "geometry", "trigonometry", "calculus", "derivative", "derivatives", "integral", "integrals", "limit", "limits", "matrix", "matrices", "linear algebra", "probability", "permutation", "combination", "equation"],
    summary:
      "Calculus studies change: derivatives measure instantaneous rate, integrals accumulate quantity. Linear algebra studies vectors and the transformations between them.",
    points: [
      "A **derivative** is the slope of the tangent line: `d/dx xⁿ = n·xⁿ⁻¹`. It answers 'how fast is this changing right now?'",
      "An **integral** is accumulated area under a curve; differentiation and integration are inverse operations (Fundamental Theorem of Calculus).",
      "A **limit** describes the value a function approaches — the foundation for both derivatives and continuity.",
      "A **matrix** represents a linear transformation. Determinants, inverses and eigenvalues encode its geometry.",
      "**Probability** of independent events multiplies; mutually exclusive events add. `P(A|B) = P(A∩B) / P(B)` is conditional probability.",
    ],
    chips: ["Explain derivatives simply", "What is an eigenvalue?", "Combinations vs permutations"],
  },
  {
    id: "career",
    title: "Careers & placements",
    keys: ["internship", "internships", "placement", "placements", "resume", "cv", "interview", "job", "career", "portfolio", "github", "linkedin"],
    summary:
      "For placements, evidence beats claims: two or three finished projects with a live link and a readable README outperform a long list of technologies.",
    points: [
      "Structure a resume as: contact → education → projects (with impact) → skills → achievements. One page for a student.",
      "Prepare the fundamentals you will actually be asked: arrays/strings/hash maps, complexity, DBMS basics, OOP, and one language deeply.",
      "For behavioural rounds use **STAR**: Situation, Task, Action, Result — and end with a measurable result.",
      "A portfolio project should have a problem statement, screenshots, a demo link, and an honest 'what I would improve' section.",
      "Ask questions at the end: what the team is building, how success is measured, what the first three months look like.",
    ],
    chips: ["How should I structure my resume?", "Common interview questions", "How do I prepare for placements?"],
  },
];

/* ------------------------------------------------------------------ */
/* Smalltalk assets                                                    */
/* ------------------------------------------------------------------ */

const OPENERS = [
  "Good question.",
  "Let me break that down.",
  "Here is the short version.",
  "Happy to help with that.",
];

const DEFAULT_CHIPS = [
  "What can you do?",
  "Explain machine learning",
  "Help me revise for exams",
  "Quiz me on a topic",
];

/* ------------------------------------------------------------------ */
/* Rule helpers                                                        */
/* ------------------------------------------------------------------ */

function kbAnswer(entry, state, deeper) {
  const first = state.lastTopic !== entry.id;
  state.lastTopic = entry.id;
  if (deeper || !first) {
    state.factIndex = first ? 0 : (state.factIndex + 1) % entry.points.length;
    const point = entry.points[state.factIndex];
    return {
      text: `**${entry.title} — more detail**\n\n${point}\n\nAsk for more again, or pick a related thread below.`,
      chips: entry.chips,
    };
  }
  state.factIndex = 0;
  const bullets = entry.points.slice(0, 3).map((p) => `- ${p}`).join("\n");
  return {
    text: `**${entry.title}**\n\n${entry.summary}\n\n${bullets}`,
    chips: entry.chips,
  };
}

function scoreEntry(entry, text) {
  let score = 0;
  for (const key of entry.keys) {
    if (key.length <= 3) {
      if (new RegExp(`\\b${key}\\b`).test(text)) score += 3;
    } else if (text.includes(key)) {
      score += key.includes(" ") ? 3 : 2;
    }
  }
  return score;
}

function findTopic(text) {
  let best = null;
  let bestScore = 0;
  for (const entry of KB) {
    const score = scoreEntry(entry, text);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

export function respond(rawInput, state = createSession()) {
  const raw = String(rawInput || "").trim();
  const s = normalise(raw);
  state.turn += 1;

  if (!s) {
    return { text: "I'm listening — type a question and I'll take it from there.", chips: DEFAULT_CHIPS };
  }

  /* --- 1. identity / memory ------------------------------------- */
  const nameMatch = /\b(?:my name is|call me|i am|i'm)\s+([a-z][a-z'-]{1,20}(?:\s+[a-z][a-z'-]{1,20})?)/.exec(s);
  if (nameMatch) {
    const candidate = nameMatch[1].trim();
    const firstWord = candidate.split(" ")[0];
    if (!STOP_NAMES.has(firstWord) && candidate.split(" ").length <= 2) {
      state.name = titleCase(candidate);
      return {
        text: `Nice to meet you, ${state.name}. I'm Nova — I can explain concepts, do quick calculations, convert units, and help you study.\n\nWhat are we working on?`,
        chips: DEFAULT_CHIPS,
      };
    }
  }

  if (/\b(what is my name|do you (remember|know) my name|who am i)\b/.test(s)) {
    return state.name
      ? { text: `You're **${state.name}** — I remember from earlier in this conversation.`, chips: DEFAULT_CHIPS }
      : { text: "You haven't told me yet. Say *my name is …* and I'll remember it for this conversation.", chips: ["My name is …"] };
  }

  /* --- 2. follow-ups on the current topic ----------------------- */
  if (
    /^(more|tell me more|explain (that |it )?more|go on|continue|elaborate|in more detail|expand on that)\b/.test(s) ||
    /^(why|why not|how so)\??$/.test(s)
  ) {
    const entry = KB.find((e) => e.id === state.lastTopic);
    if (entry) return kbAnswer(entry, state, true);
  }

  /* --- 3. off-topic chat (studying only, so decline and redirect) - */
  if (/\b(another joke|one more joke|tell me a joke|make me laugh|something funny|a joke|joke|pun)\b/.test(s)) {
    return {
      text: "I'm a study assistant, so jokes are outside what I can help with — sorry! I can explain a concept, work through a problem with you, or quiz you on a topic.\n\nWhat are you studying right now?",
      chips: ["Explain machine learning", "Help me revise for exams", "Quiz me on a topic"],
    };
  }

  /* --- 4. smalltalk --------------------------------------------- */
  if (/^(hi|hey|hello|yo|hiya|howdy|good (morning|afternoon|evening)|sup|greetings)\b/.test(s) || s === "hi") {
    return {
      text: state.name
        ? `Hey ${state.name} — good to see you again. What would you like to look at?`
        : "Hey there. I'm **Nova**, your study assistant. Ask me about a topic, drop a calculation, or just say hello back.",
      chips: DEFAULT_CHIPS,
    };
  }

  if (/\b(how are you|how is it going|how are things|you ok|you okay)\b/.test(s)) {
    return {
      text: "Running smoothly, thanks — no lag on my side. More importantly: how's your project going? I can help with the concept, the code, or the write-up.",
      chips: DEFAULT_CHIPS,
    };
  }

  if (/\b(who are you|what are you|your name|introduce yourself|tell me about yourself)\b/.test(s)) {
    return {
      text: "I'm **Nova**, a rule-based conversational assistant built for this project. I classify your intent, retrieve relevant knowledge, and compose a reply — no external API keys required.\n\nI'm good at explaining CS concepts, doing arithmetic, converting units, and study coaching.",
      chips: ["What can you do?", "How do you work?", "Quiz me on a topic"],
    };
  }

  if (/\b(who (made|built|created) you|who is your (creator|developer)|your creator)\b/.test(s)) {
    return {
      text: "I was built as a self-contained HTML/CSS/JavaScript project: a hand-written intent classifier and knowledge base on top of a small vanilla-JS chat interface. Everything runs locally — no server or API key needed.",
      chips: ["What can you do?", "How do you work?"],
    };
  }

  if (/\b(are you (human|real|alive)|do you (have feelings|sleep|eat)|are you a (robot|bot|ai))\b/.test(s)) {
    return {
      text: "I'm software — no feelings, no sleep, no lunch breaks. I match patterns in what you type against a curated knowledge base, then build a reply from the result.",
      chips: ["How do you work?", "What can you do?"],
    };
  }

  if (/\b(what can you do|how can you help|your (abilities|features|skills)|help me|^help$|commands)\b/.test(s)) {
    return {
      text: "**Here's what I can do**\n\n- **Explain concepts** — AI, data structures, DBMS, OS, networks, OOP, web dev, cloud, security, and more\n- **Do maths** — try `(48/6) + sqrt(81) * 2`\n- **Convert units** — `12 km to miles`, `30 c to f`\n- **Study coaching** — revision plans, focus techniques, exam prep\n- **Check understanding** — ask me to quiz you on any topic\n\nAsk naturally; there's no command syntax to memorise.",
      chips: DEFAULT_CHIPS,
    };
  }

  if (/\b(thank you|thanks|thx|appreciate it|cheers)\b/.test(s)) {
    return {
      text: pick(["Any time — that's what I'm here for.", "Glad it helped. Want to go deeper?", "You're welcome. What's next?"], state.turn),
      chips: ["Explain machine learning", "Help me revise for exams", "Quiz me on a topic"],
    };
  }

  if (/\b(bye|goodbye|see you|good night|that is all|i am done)\b/.test(s)) {
    return {
      text: `Goodbye${state.name ? `, ${state.name}` : ""} — good luck with the project. I'll be here when you come back.`,
      chips: [],
    };
  }

  /* --- 5. utilities --------------------------------------------- */
  if (/^(what time is it|what is the time|current time|time now|got the time)\??$/.test(s)) {
    const now = new Date();
    return {
      text: `It's **${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}** on your device right now.`,
      chips: ["What is today's date?", "What can you do?"],
    };
  }

  if (/\b(what is (the |today's )?date|what day is it|today's date|what is today)\b/.test(s)) {
    const now = new Date();
    return {
      text: `Today is **${now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}**.`,
      chips: ["What time is it?", "What can you do?"],
    };
  }

  const pct = /^(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (pct) {
    const v = (parseFloat(pct[1]) / 100) * parseFloat(pct[2]);
    return {
      text: `**${pct[1]}% of ${pct[2]} = ${fmtNumber(v)}**\n\nThat's ${pct[1]}/100 × ${pct[2]}.`,
      chips: ["What can you do?", "Convert 10 km to miles"],
    };
  }

  const conversion = tryConversion(
    raw.replace(/^(convert|change|how many \w+ (?:is|are) (?:in )?)\s*/i, "").trim()
  );
  if (conversion && /(to|in|into|=|as)\b/i.test(raw)) {
    const { value, from, to, out } = conversion;
    return {
      text: `**${fmtMeasure(value)} ${UNIT_LABEL[from]} = ${fmtMeasure(out)} ${UNIT_LABEL[to]}**`,
      chips: ["Convert 10 km to miles", "Convert 30 c to f", "What can you do?"],
    };
  }

  if (looksLikeMath(raw) || /^(calculate|compute|solve|evaluate|what is|how much is)\b/.test(s)) {
    const expr = raw.replace(/^(calculate|compute|solve|evaluate|what is|what's|how much is|how many is)\s*/i, "");
    try {
      const result = evaluateExpression(expr);
      return {
        text: `**${expr.trim()} = ${fmtNumber(result)}**`,
        chips: ["What can you do?", "Convert 5 kg to lb"],
      };
    } catch {
      /* fall through to conversational handling */
    }
  }

  /* --- 6. writing / study coaching ------------------------------ */
  if (/\b(study|studying|revise|revision|exam|exams|test|focus|concentrate|procrastinat|pomodoro|time management|schedule|timetable)\b/.test(s)) {
    return {
      text: "**A revision plan that actually works**\n\n- **Active recall first** — close the notes and write what you remember, then check. Rereading feels productive but fades fast.\n- **Spaced repetition** — revisit after 1 day, 3 days, 1 week, 2 weeks. Spacing beats cramming for retention.\n- **Pomodoro** — 25 minutes focused, 5 minutes off, and a longer break every 4 rounds. Protect the 25 minutes from your phone.\n- **Interleave subjects** instead of blocking one topic for hours; it builds discrimination between problem types.\n- **Teach it out loud** to an empty room. If you stall, that is exactly the gap to study next.",
      chips: ["How do I stop procrastinating?", "Explain spaced repetition", "Help with time management"],
    };
  }

  if (/\b(procrastinat|motivat|lazy|give up|keep going|i am stressed|stressed|anxious|overwhelmed|burnt out|burned out)\b/.test(s)) {
    return {
      text: "That's a normal place to be, especially mid-project. Two things usually help more than willpower:\n\n- **Shrink the first step** until it is almost too easy — open the file, write one function, run it. Momentum follows action, not the other way round.\n- **Make progress visible** with a three-item list. Cross things off. Unfinished lists drain more energy than unfinished work.\n\nIf stress is affecting sleep or health, please talk to someone you trust or your campus counselling service — that matters more than any deadline.",
      chips: ["Help me build a revision plan", "What can you do?"],
    };
  }

  if (/\b(write|draft|compose)\b.*\b(email|letter|paragraph|essay|application|report|summary)\b/.test(s)) {
    return {
      text: "**Here's a structure you can adapt**\n\n**Subject:** specific and scannable — e.g. *Request for project deadline extension*\n\n1. **Purpose** — one sentence saying why you are writing.\n2. **Context** — the minimum background the reader needs.\n3. **Ask** — exactly what you want, with a date or owner.\n4. **Close** — thanks and your name.\n\nKeep it under 150 words, one idea per paragraph, no filler. Tell me the topic and audience and I'll draft the actual text.",
      chips: ["Draft an email to my professor", "What can you do?"],
    };
  }

  /* --- 7. knowledge retrieval ---------------------------------- */
  const entry = findTopic(s);
  if (entry) return kbAnswer(entry, state, false);

  /* --- 8. "explain X" without a known topic -------------------- */
  const explainMatch = /^(?:explain|define|describe|what is|what are|tell me about|meaning of)\s+(.{2,60})$/.exec(s);
  if (explainMatch) {
    const subject = explainMatch[1].replace(/\b(please|for me|in simple terms|simply)\b/g, "").trim();
    return {
      text: `I don't have a detailed note on **${subject}** yet — that's outside my knowledge base.\n\nWhat I can do is work from what I do know. Try reframing it with one of these angles:\n\n- **Definition** — what category does it belong to, and what distinguishes it?\n- **Mechanism** — how does it actually work, step by step?\n- **Trade-off** — what does it cost, and when is it the wrong choice?\n\nOr ask me about one of the topics I cover in depth: AI, data structures, algorithms, DBMS, operating systems, networks, OOP, web development, cloud, security, software engineering, data science, blockchain, IoT, maths, or placements.`,
      chips: ["What topics do you cover?", "Explain machine learning", "Explain database normalisation"],
    };
  }

  /* --- 9. fallback --------------------------------------------- */
  const opener = pick(OPENERS, state.turn);
  return {
    text: `${opener} I'm not certain I caught the intent behind *"${raw.slice(0, 80)}"*.\n\nI work best with:\n\n- **Concept questions** — "explain TCP vs UDP"\n- **Quick maths** — "48/6 + 2^5"\n- **Conversions** — "12 km to miles"\n- **Study help** — "how do I revise for exams"\n\nTry one of those, or rephrase with a topic keyword and I'll dig in.`,
    chips: DEFAULT_CHIPS,
  };
}

export const TOPICS = KB.map((k) => ({ id: k.id, title: k.title }));
export const SUGGESTIONS = DEFAULT_CHIPS;
