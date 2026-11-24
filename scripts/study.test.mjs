/**
 * Tests for the study layer: flashcards and scheduling, notes retrieval,
 * the study log, formula extraction, CSV export and the function plotter.
 *
 *   node scripts/study.test.mjs
 */

import assert from "node:assert/strict";
import {
  StudyStore,
  cardsToCsv,
  extractFormulas,
  parseCards,
  parseExam,
} from "../public/study.js";
import { compile } from "../public/plot.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    size: () => map.size,
  };
}

const DAY = 86_400_000;

console.log("\nModel output parsing");

check("cards parse from fenced JSON", () => {
  const cards = parseCards(
    '```json\n[{"front":"What is a deadlock?","back":"Two processes waiting on each other."}]\n```'
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].front, "What is a deadlock?");
});

check("cards accept question/answer keys", () => {
  const cards = parseCards('[{"question":"Q1","answer":"A1","topic":"OS"}]');
  assert.deepEqual(cards[0], { front: "Q1", back: "A1", topic: "OS" });
});

check("cards survive prose around the array", () => {
  const cards = parseCards('Here you go:\n[{"q":"Q","a":"A"}]\nHope that helps!');
  assert.equal(cards.length, 1);
});

check("broken JSON gives an empty list, not a crash", () => {
  assert.deepEqual(parseCards("sorry, I cannot do that"), []);
  assert.deepEqual(parseCards(null), []);
});

check("cards are capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ front: `Q${i}`, back: `A${i}` }));
  assert.equal(parseCards(JSON.stringify(many)).length, 40);
});

check("exam parsing keeps marks and mark scheme", () => {
  const paper = parseExam(
    '[{"question":"Explain paging.","marks":6,"answer":"Pages, frames, page table"}]'
  );
  assert.equal(paper.length, 1);
  assert.equal(paper[0].marks, 6);
  assert.match(paper[0].answer, /page table/);
});

console.log("\nCards and scheduling");

const storage = fakeStorage();
const store = new StudyStore(storage);

check("cards can be added", () => {
  const added = store.addCards([
    { front: "What is a lock?", back: "A synchronisation primitive." },
    { front: "What is a semaphore?", back: "A counter with wait/signal." },
  ], "OS");
  assert.equal(added.length, 2);
  assert.equal(store.counts().total, 2);
  assert.equal(store.counts().due, 2);
});

check("duplicate cards are skipped", () => {
  const again = store.addCards([{ front: "What is a lock?", back: "Same question." }], "OS");
  assert.equal(again.length, 0);
  assert.equal(store.counts().total, 2);
});

check("a new card is due immediately", () => {
  assert.equal(store.dueCards().length, 2);
});

check("good pushes a card a day out", () => {
  const card = store.cards[0];
  store.grade(card.id, "good");
  assert.equal(card.interval, 1);
  assert.ok(card.due > Date.now() + DAY - 5000);
  assert.equal(store.dueCards().length, 1);
});

check("easy spaces further than good", () => {
  const card = store.cards[1];
  store.grade(card.id, "easy");
  assert.ok(card.interval >= 2);
});

check("interval keeps growing then caps", () => {
  const card = store.cards[0];
  for (let i = 0; i < 20; i += 1) store.grade(card.id, "easy");
  assert.ok(card.interval <= 180);
});

check("again brings a card back in ten minutes", () => {
  const card = store.cards[0];
  store.grade(card.id, "again");
  assert.equal(card.interval, 0);
  assert.equal(card.reps, 0);
  assert.ok(card.lapses >= 1);
  const dueIn = card.due - Date.now();
  assert.ok(dueIn > 8 * 60_000 && dueIn <= 10 * 60_000 + 2000);
});

check("deck state survives a reload", () => {
  const reopened = new StudyStore(storage);
  assert.equal(reopened.counts().total, 2);
  assert.equal(reopened.cards[0].front, store.cards[0].front);
});

check("topics list is unique", () => {
  assert.deepEqual(store.topics(), ["OS"]);
});

console.log("\nNotes");

check("notes can be saved and listed", () => {
  const note = store.addNote({
    title: "Week 4 — memory",
    subject: "Computer Science",
    text: "Paging divides memory into fixed-size pages and frames. A page table maps pages to frames.",
  });
  assert.ok(note);
  assert.equal(store.notes.length, 1);
});

check("empty notes are rejected", () => {
  assert.equal(store.addNote({ title: "Empty", text: "   " }), null);
});

check("context is found by keyword", () => {
  const context = store.contextFor("How does paging map pages to frames?");
  assert.match(context, /Paging/);
  assert.match(context, /Week 4/);
});

check("unrelated questions get no context", () => {
  assert.equal(store.contextFor("photosynthesis chlorophyll"), "");
});

check("notes can be removed", () => {
  assert.equal(store.removeNote(store.notes[0].id), true);
  assert.equal(store.notes.length, 0);
});

console.log("\nStudy log");

check("answers and cards are logged per day", () => {
  store.log("answer");
  store.log("answer", 2);
  store.log("card", 3);
  const today = store.today();
  assert.equal(today.answers, 3);
  assert.equal(today.cards, 3);
});

check("streak counts today", () => {
  assert.equal(store.streak(), 1);
});

check("week chart always has seven days", () => {
  const week = store.week();
  assert.equal(week.length, 7);
  assert.equal(week[6].answers, 3);
});

check("totals accumulate", () => {
  assert.equal(store.totals().answers, 3);
});

check("prefs round-trip", () => {
  store.setPref("showSteps", true);
  const reopened = new StudyStore(storage);
  assert.equal(reopened.pref("showSteps"), true);
  assert.equal(reopened.pref("useNotes"), false);
});

check("stats reset leaves cards alone", () => {
  store.resetStats();
  assert.equal(store.today().answers, 0);
  assert.equal(store.cards.length, 2);
});

console.log("\nFormulas and CSV");

check("display, inline and line formulas are found", () => {
  const formulas = extractFormulas(
    "Use $$F = ma$$ here, and $v = u + at$ inline.\nE = mc^2\nAlso 2 + 2 = 4."
  );
  assert.ok(formulas.some((f) => f.includes("F = ma")));
  assert.ok(formulas.some((f) => f.includes("v = u + at")));
  assert.ok(formulas.some((f) => f.includes("E = mc^2")));
});

check("currency is not treated as a formula", () => {
  const formulas = extractFormulas("It costs $5 and $10.");
  assert.equal(formulas.length, 0);
});

check("duplicate formulas collapse", () => {
  const formulas = extractFormulas("$x^2$ and again $x^2$");
  assert.equal(formulas.filter((f) => f === "x^2").length, 1);
});

check("CSV quotes and escapes", () => {
  const csv = cardsToCsv([
    { front: 'What is "paging"?', back: "Fixed pages, fixed frames", topic: "OS" },
  ]);
  assert.match(csv, /^"Front","Back","Tags"/);
  assert.match(csv, /""paging""/);
});

console.log("\nPlotter");

check("quadratic compiles", () => {
  const result = compile("y = x^2 - 1");
  assert.equal(result.ok, true);
  assert.equal(result.fn(3), 8);
  assert.equal(result.fn(-3), 8);
});

check("implicit multiplication works", () => {
  assert.equal(compile("2x").fn(4), 8);
  assert.equal(compile("3(x+1)").fn(2), 9);
  assert.equal(compile("2sin(0)").fn(0), 0);
});

check("constants and functions work", () => {
  assert.ok(Math.abs(compile("sin(pi/2)").fn(0) - 1) < 1e-9);
  assert.equal(compile("sqrt(x)").fn(9), 3);
  assert.ok(Math.abs(compile("ln(e)").fn(0) - 1) < 1e-9);
});

check("undefined points return null", () => {
  assert.equal(compile("1/x").fn(0), null);
  assert.equal(compile("sqrt(x)").fn(-4), null);
});

check("bad input reports a readable error", () => {
  const bad = compile("x +");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ends too early/i);
  assert.equal(compile("").ok, false);
  assert.equal(compile("foo(x)").ok, false);
  assert.equal(compile("(x+1").ok, false);
});

check("unary minus and powers bind correctly", () => {
  assert.equal(compile("-x^2").fn(3), -9);
  assert.equal(compile("2^3^2").fn(0), 512);
});

console.log(
  failures
    ? `\n${failures} STUDY TEST(S) FAILED`
    : "\nALL STUDY TESTS PASSED"
);
process.exit(failures ? 1 : 0);
