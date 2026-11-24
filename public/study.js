/**
 * study.js — study data: flashcards, scheduling, notes, study log
 *
 * Pure data layer with no DOM access, so it can be tested in Node with a fake
 * storage object (see scripts/study.test.mjs). Everything lives in this
 * browser under `nova.study.v1`.
 *
 * Scheduling is a small Leitner/SM-2 hybrid: a card's interval grows with how
 * easily it was recalled, and "Again" puts it back in ten minutes.
 */

const STORE_KEY = "nova.study.v1";
const DAY = 86_400_000;
const MAX_CARDS = 2000;
const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 20_000;
const MAX_INTERVAL = 180;

export const SUBJECTS = [
  "Maths",
  "Physics",
  "Chemistry",
  "Biology",
  "Computer Science",
  "English",
  "History",
  "Economics",
  "Other",
];

export const GRADES = [
  { id: "again", label: "Again", hint: "10 min" },
  { id: "hard", label: "Hard", hint: "shorter" },
  { id: "good", label: "Good", hint: "normal" },
  { id: "easy", label: "Easy", hint: "longer" },
];

export function uid(prefix = "s") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function clampText(value, max) {
  return String(value ?? "").slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Model output parsing                                                */
/* ------------------------------------------------------------------ */

/** Pulls a JSON array out of a reply that may be wrapped in prose or fences. */
function jsonArray(text) {
  const raw = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Reply → [{ front, back, topic }], tolerant about the field names used. */
export function parseCards(text, fallbackTopic = "") {
  const list = jsonArray(text);
  const cards = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const front = item.front ?? item.question ?? item.q ?? item.term ?? "";
    const back = item.back ?? item.answer ?? item.a ?? item.definition ?? "";
    if (typeof front !== "string" || typeof back !== "string") continue;
    if (!front.trim() || !back.trim()) continue;
    cards.push({
      front: clampText(front.trim(), 400),
      back: clampText(back.trim(), 1200),
      topic: clampText(item.topic ?? fallbackTopic ?? "", 40).trim(),
    });
    if (cards.length >= 40) break;
  }
  return cards;
}

/** Reply → [{ question, marks, answer }] for a practice paper. */
export function parseExam(text, fallbackTopic = "") {
  const list = jsonArray(text);
  const questions = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const question = item.question ?? item.q ?? item.prompt ?? "";
    const answer = item.answer ?? item.markScheme ?? item.scheme ?? item.modelAnswer ?? "";
    if (typeof question !== "string" || !question.trim()) continue;
    const marks = Number(item.marks ?? item.mark ?? 0);
    questions.push({
      question: clampText(question.trim(), 2000),
      answer: clampText(typeof answer === "string" ? answer.trim() : "", 2500),
      marks: Number.isFinite(marks) && marks > 0 ? Math.min(Math.round(marks), 20) : 1,
      topic: clampText(item.topic ?? fallbackTopic ?? "", 40).trim(),
    });
    if (questions.length >= 20) break;
  }
  return questions;
}

/* ------------------------------------------------------------------ */
/* Formula + CSV helpers                                               */
/* ------------------------------------------------------------------ */

/** Every equation that appears in a chat, deduplicated, in source order. */
export function extractFormulas(text) {
  const source = String(text ?? "");
  const found = [];
  const seen = new Set();
  const push = (value) => {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (clean.length < 2 || clean.length > 300) return;
    if (!/[a-zA-Z0-9]/.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(clean);
  };

  const display = /\$\$([\s\S]{2,300}?)\$\$/g;
  let match;
  while ((match = display.exec(source))) push(match[1]);

  const bracket = /\\\[([\s\S]{2,300}?)\\\]/g;
  while ((match = bracket.exec(source))) push(match[1]);

  const inline = /(?<!\$)\$([^$\n]{2,200}?)\$(?!\$)/g;
  while ((match = inline.exec(source))) {
    const value = match[1];
    // Skip currency and prose: "$5 and $10" would otherwise look like maths.
    // Real inline maths carries an operator or is a single variable.
    const mathsy =
      /[\\^_=+\-*/{}]/.test(value) || /^[A-Za-z][A-Za-z0-9']*$/.test(value.trim());
    if (!mathsy) continue;
    push(value);
  }

  for (const line of source.split(/\n+/)) {
    const clean = line.replace(/^[-*>\d.\s]+/, "").trim();
    if (!clean || clean.length > 200) continue;
    if (!clean.includes("=")) continue;
    if (!/[a-zA-Z\u0370-\u03ff]/.test(clean)) continue;
    if (/^(let|const|var|if|for|while|return|case|http)/i.test(clean)) continue;
    if (/[{};]/.test(clean)) continue;
    push(clean);
  }

  return found;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

/** Anki/Quizlet-friendly CSV: front, back, tags. */
export function cardsToCsv(cards) {
  const rows = ['"Front","Back","Tags"'];
  for (const card of cards || []) {
    rows.push([csvCell(card.front), csvCell(card.back), csvCell(card.topic || "")].join(","));
  }
  return rows.join("\n");
}

function dayKey(date = new Date()) {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function normaliseCard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const front = typeof raw.front === "string" ? raw.front.trim() : "";
  const back = typeof raw.back === "string" ? raw.back.trim() : "";
  if (!front || !back) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid("c"),
    front: clampText(front, 400),
    back: clampText(back, 1200),
    topic: clampText(raw.topic ?? "", 40).trim(),
    due: Number.isFinite(raw.due) ? raw.due : Date.now(),
    interval: Number.isFinite(raw.interval) ? Math.max(0, raw.interval) : 0,
    reps: Number.isFinite(raw.reps) ? Math.max(0, raw.reps) : 0,
    lapses: Number.isFinite(raw.lapses) ? Math.max(0, raw.lapses) : 0,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    lastGrade: typeof raw.lastGrade === "string" ? raw.lastGrade : "",
  };
}

function normaliseNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!text.trim()) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid("n"),
    title: clampText(raw.title ?? "Untitled notes", 100).trim() || "Untitled notes",
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : "Other",
    text: clampText(text, MAX_NOTE_CHARS),
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
  };
}

export class StudyStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.cards = [];
    this.notes = [];
    this.stats = { days: {}, totals: { answers: 0, cards: 0, exams: 0 } };
    this.prefs = { showSteps: false, useNotes: false };
    this.available = true;
    this.load();
  }

  read() {
    try {
      return this.storage ? this.storage.getItem(STORE_KEY) : null;
    } catch {
      this.available = false;
      return null;
    }
  }

  load() {
    const raw = this.read();
    if (!raw) return this;
    try {
      const parsed = JSON.parse(raw);
      this.cards = (Array.isArray(parsed?.cards) ? parsed.cards : [])
        .map(normaliseCard)
        .filter(Boolean)
        .slice(0, MAX_CARDS);
      this.notes = (Array.isArray(parsed?.notes) ? parsed.notes : [])
        .map(normaliseNote)
        .filter(Boolean)
        .slice(0, MAX_NOTES);
      const days = parsed?.stats?.days && typeof parsed.stats.days === "object" ? parsed.stats.days : {};
      this.stats = {
        days,
        totals: {
          answers: Math.max(0, Number(parsed?.stats?.totals?.answers) || 0),
          cards: Math.max(0, Number(parsed?.stats?.totals?.cards) || 0),
          exams: Math.max(0, Number(parsed?.stats?.totals?.exams) || 0),
        },
      };
      this.prefs = {
        showSteps: Boolean(parsed?.prefs?.showSteps),
        useNotes: Boolean(parsed?.prefs?.useNotes),
      };
    } catch {
      /* unreadable state — start clean in memory */
    }
    return this;
  }

  save() {
    try {
      this.storage?.setItem(
        STORE_KEY,
        JSON.stringify({
          version: 1,
          cards: this.cards,
          notes: this.notes,
          stats: this.stats,
          prefs: this.prefs,
        })
      );
      return true;
    } catch {
      // Quota or private mode: the session keeps working in memory.
      this.available = false;
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cards                                                             */
  /* ---------------------------------------------------------------- */

  addCards(list, topic = "") {
    const added = [];
    for (const item of list || []) {
      const card = normaliseCard({
        ...item,
        topic: item?.topic || topic,
        due: Date.now(),
      });
      if (!card) continue;
      // Skip duplicates of the same question in the same topic.
      const exists = this.cards.some(
        (c) => c.front.toLowerCase() === card.front.toLowerCase() && c.topic === card.topic
      );
      if (exists) continue;
      this.cards.unshift(card);
      added.push(card);
      if (this.cards.length >= MAX_CARDS) break;
    }
    if (added.length) this.save();
    return added;
  }

  addCard(front, back, topic = "") {
    return this.addCards([{ front, back, topic }], topic)[0] || null;
  }

  removeCard(id) {
    const at = this.cards.findIndex((c) => c.id === id);
    if (at < 0) return false;
    this.cards.splice(at, 1);
    this.save();
    return true;
  }

  card(id) {
    return this.cards.find((c) => c.id === id) || null;
  }

  dueCards(now = Date.now()) {
    return this.cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
  }

  counts(now = Date.now()) {
    const due = this.cards.filter((c) => c.due <= now).length;
    const learning = this.cards.filter((c) => c.reps === 0).length;
    return { total: this.cards.length, due, learning, learned: this.cards.length - learning };
  }

  topics() {
    const set = new Set();
    for (const card of this.cards) if (card.topic) set.add(card.topic);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  grade(id, grade = "good") {
    const card = this.card(id);
    if (!card) return null;
    if (grade === "again") {
      card.interval = 0;
      card.reps = 0;
      card.lapses += 1;
      card.due = Date.now() + 10 * 60_000;
    } else {
      card.reps += 1;
      if (grade === "hard") card.interval = Math.max(1, Math.round((card.interval || 0) * 1.2));
      else if (grade === "easy") card.interval = Math.max(2, Math.round((card.interval || 0) * 3.2) || 2);
      else card.interval = Math.max(1, Math.round((card.interval || 0) * 2.4) || 1);
      card.interval = Math.min(card.interval, MAX_INTERVAL);
      card.due = Date.now() + card.interval * DAY;
    }
    card.lastGrade = grade;
    this.save();
    return card;
  }

  /* ---------------------------------------------------------------- */
  /* Notes                                                             */
  /* ---------------------------------------------------------------- */

  addNote({ title = "", subject = "Other", text = "" } = {}) {
    const note = normaliseNote({
      title,
      subject,
      text: clampText(text, MAX_NOTE_CHARS),
      addedAt: Date.now(),
    });
    if (!note) return null;
    this.notes.unshift(note);
    if (this.notes.length > MAX_NOTES) this.notes.length = MAX_NOTES;
    this.save();
    return note;
  }

  removeNote(id) {
    const at = this.notes.findIndex((n) => n.id === id);
    if (at < 0) return false;
    this.notes.splice(at, 1);
    this.save();
    return true;
  }

  note(id) {
    return this.notes.find((n) => n.id === id) || null;
  }

  /**
   * Best-matching excerpts from the imported notes for a question. Keyword
   * scoring is enough at this size and needs no model call.
   */
  contextFor(query, limit = 2) {
    const words = [...new Set(String(query || "").toLowerCase().match(/[a-z\u0600-\u06ff]{4,}/g) || [])];
    if (!words.length || !this.notes.length) return "";
    const scored = this.notes.map((note) => {
      const haystack = `${note.title} ${note.subject} ${note.text}`.toLowerCase();
      const score = words.reduce((sum, word) => {
        let count = 0;
        let at = haystack.indexOf(word);
        while (at >= 0 && count < 12) {
          count += 1;
          at = haystack.indexOf(word, at + word.length);
        }
        return sum + count;
      }, 0);
      return { note, score };
    });
    const best = scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (!best.length) return "";
    return best
      .map(({ note }) => {
        const snippet = note.text.length > 1400 ? `${note.text.slice(0, 1400)}…` : note.text;
        return `From “${note.title}” (${note.subject}):\n${snippet}`;
      })
      .join("\n\n");
  }

  /* ---------------------------------------------------------------- */
  /* Preferences                                                       */
  /* ---------------------------------------------------------------- */

  pref(key) {
    return Boolean(this.prefs[key]);
  }

  setPref(key, value) {
    if (!(key in this.prefs)) return false;
    this.prefs[key] = Boolean(value);
    this.save();
    return this.prefs[key];
  }

  /* ---------------------------------------------------------------- */
  /* Study log                                                         */
  /* ---------------------------------------------------------------- */

  log(kind, amount = 1) {
    const count = Math.max(0, Math.floor(Number(amount) || 0));
    if (!count) return;
    const key = dayKey();
    const day = this.stats.days[key] || { answers: 0, cards: 0, exams: 0 };
    const field = kind === "card" ? "cards" : kind === "exam" ? "exams" : "answers";
    day[field] = (day[field] || 0) + count;
    this.stats.days[key] = day;
    this.stats.totals[field] = (this.stats.totals[field] || 0) + count;
    this.save();
  }

  today() {
    const day = this.stats.days[dayKey()] || {};
    return { answers: day.answers || 0, cards: day.cards || 0, exams: day.exams || 0 };
  }

  /** Consecutive active days, counting back from today (or yesterday). */
  streak(now = new Date()) {
    const day = new Date(now);
    const active = (date) => {
      const entry = this.stats.days[dayKey(date)];
      return Boolean(entry && (entry.answers || entry.cards || entry.exams));
    };
    if (!active(day)) {
      day.setDate(day.getDate() - 1);
      if (!active(day)) return 0;
    }
    let count = 0;
    while (active(day) && count < 3650) {
      count += 1;
      day.setDate(day.getDate() - 1);
    }
    return count;
  }

  week(now = new Date()) {
    const out = [];
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let back = 6; back >= 0; back -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      const key = dayKey(d);
      const entry = this.stats.days[key] || {};
      out.push({
        key,
        label: labels[d.getDay()],
        answers: entry.answers || 0,
        cards: entry.cards || 0,
        exams: entry.exams || 0,
        total: (entry.answers || 0) + (entry.cards || 0) + (entry.exams || 0),
      });
    }
    return out;
  }

  totals() {
    return { ...this.stats.totals };
  }

  resetStats() {
    this.stats = { days: {}, totals: { answers: 0, cards: 0, exams: 0 } };
    this.save();
  }
}
