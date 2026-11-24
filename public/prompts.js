/**
 * prompts.js — the Prompt Library
 *
 * A small, dependency-free store for reusable prompts. Default prompts are
 * seeded once, then live in localStorage like user-created ones, so edits and
 * deletions stick across reloads. Every entry has a title, a description, a
 * category and the prompt body that gets inserted into the composer.
 */

const STORE_KEY = "nova.prompts.v2";
const MAX_PROMPTS = 300;

export const CATEGORIES = [
  "Programming",
  "Writing",
  "Learning",
  "Translation",
  "Productivity",
  "Research",
];

export const DEFAULT_PROMPTS = [
  {
    id: "p_builtin_review",
    title: "Review my code",
    description: "Find bugs, unclear names and risky edge cases in a snippet.",
    category: "Programming",
    body: "Review the following code as a senior engineer. Point out bugs, unclear names and risky edge cases, then give an improved version.\n\n```\n// paste your code here\n```",
    builtin: true,
  },
  {
    id: "p_builtin_debug",
    title: "Explain this error",
    description: "Turn a stack trace into a cause and a concrete fix.",
    category: "Programming",
    body: "Explain this error in plain language. What caused it, how do I confirm that, and what is the smallest fix? Then show the corrected code.\n\n```\n// paste the error and stack trace here\n```",
    builtin: true,
  },
  {
    id: "p_builtin_algorithm",
    title: "Walk through an algorithm",
    description: "Step-by-step trace with complexity analysis.",
    category: "Programming",
    body: "Walk me through this algorithm step by step using a small example. Show the trace, explain why it is correct, and give its time and space complexity in Big-O notation.",
    builtin: true,
  },
  {
    id: "p_builtin_rewrite",
    title: "Rewrite for clarity",
    description: "Tighten wording without losing meaning.",
    category: "Writing",
    body: "Rewrite the text below so it is clearer and shorter without losing meaning. Keep the tone professional and conversational, remove filler, and keep it under 150 words.\n\n---\n\n",
    builtin: true,
  },
  {
    id: "p_builtin_email",
    title: "Draft an email",
    description: "Purpose, context and a specific ask in four short paragraphs.",
    category: "Writing",
    body: "Draft a short, polite email. Context: [who you are writing to and why]. Goal: [what you want them to do]. Keep it under 150 words, one idea per paragraph, and end with a clear ask.",
    builtin: true,
  },
  {
    id: "p_builtin_summary",
    title: "Summarise notes",
    description: "Key points, definitions and exam-ready takeaways.",
    category: "Learning",
    body: "Summarise these notes into: 1) five key points, 2) any definitions I must memorise, 3) three likely exam questions with short answers.\n\n---\n\n",
    builtin: true,
  },
  {
    id: "p_builtin_teach",
    title: "Teach me from scratch",
    description: "A beginner explanation with an analogy and a check.",
    category: "Learning",
    body: "Teach me [topic] as if I have never seen it before. Use one everyday analogy, then the precise definition, then a small worked example. Finish with two questions to check my understanding.",
    builtin: true,
  },
  {
    id: "p_builtin_quiz",
    title: "Quiz me",
    description: "Five questions, answers hidden at the end.",
    category: "Learning",
    body: "Quiz me on [topic] with five questions of increasing difficulty. Do not show the answers until I reply. After I answer, mark each one and explain what I missed.",
    builtin: true,
  },
  {
    id: "p_builtin_translate",
    title: "Translate naturally",
    description: "Idiomatic translation that keeps the original tone.",
    category: "Translation",
    body: "Translate the text below into [language]. Keep the tone and formatting, use natural phrasing rather than literal word-for-word translation, and list any idiom you had to adapt.\n\n---\n\n",
    builtin: true,
  },
  {
    id: "p_builtin_bilingual",
    title: "Explain bilingually",
    description: "English explanation with an Arabic summary.",
    category: "Translation",
    body: "Explain [topic] in clear English, then give a short Arabic summary (الملخص بالعربية) of the main points. Keep the technical terms in English with an Arabic gloss.",
    builtin: true,
  },
  {
    id: "p_builtin_plan",
    title: "Plan my week",
    description: "Turn a messy task list into a realistic schedule.",
    category: "Productivity",
    body: "Turn this task list into a realistic one-week plan. Estimate each task, protect two hours of deep work per day, and flag anything that will not fit.\n\nTasks:\n- \n- \n- ",
    builtin: true,
  },
  {
    id: "p_builtin_prioritise",
    title: "Prioritise ruthlessly",
    description: "Sort tasks by impact and effort, then pick three.",
    category: "Productivity",
    body: "Here is everything on my plate:\n\n- \n- \n- \n\nSort it by impact and effort, tell me what to do first, what to defer and what to drop, then pick the three things I should finish today.",
    builtin: true,
  },
  {
    id: "p_builtin_compare",
    title: "Compare sources",
    description: "A balanced comparison table with trade-offs.",
    category: "Research",
    body: "Compare [option A] and [option B] for [use case]. Give a table of the key differences, the trade-offs that actually matter, and a recommendation with the reasoning. Say clearly where you are uncertain.",
    builtin: true,
  },
  {
    id: "p_builtin_research_plan",
    title: "Research plan",
    description: "Questions, sources and a note-taking structure.",
    category: "Research",
    body: "I am researching [topic]. Give me: the three questions worth answering, the kinds of sources to trust, search terms to try, and a note-taking structure that will make the write-up easy.",
    builtin: true,
  },
];

export function promptId() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalise(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  if (!title || !body.trim()) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : promptId(),
    title,
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, 160) : "",
    category: CATEGORIES.includes(raw.category) ? raw.category : "Productivity",
    body,
    builtin: !!raw.builtin,
  };
}

export class PromptStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.items = [];
    this.recent = [];
    this.load();
  }

  read(key) {
    try {
      return this.storage ? this.storage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  load() {
    const raw = this.read(STORE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.items = (Array.isArray(parsed?.items) ? parsed.items : []).map(normalise).filter(Boolean);
        this.recent = Array.isArray(parsed?.recent)
          ? parsed.recent.filter((id) => typeof id === "string").slice(0, 12)
          : [];
      } catch {
        this.items = [];
      }
    }

    if (!this.items.length) {
      this.items = DEFAULT_PROMPTS.map((p) => ({ ...p }));
      this.save();
    }
    return this;
  }

  save() {
    try {
      this.storage?.setItem(
        STORE_KEY,
        JSON.stringify({ version: 2, items: this.items.slice(0, MAX_PROMPTS), recent: this.recent })
      );
    } catch {
      /* storage full or unavailable — the library still works this session */
    }
  }

  list() {
    return this.items;
  }

  get(id) {
    return this.items.find((p) => p.id === id) || null;
  }

  add({ title, description = "", category = "Productivity", body }) {
    const item = normalise({
      id: promptId(),
      title,
      description,
      category,
      body,
      builtin: false,
    });
    if (!item) return null;
    this.items.unshift(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    const next = normalise({ ...item, ...patch });
    if (!next) return null;
    Object.assign(item, next, { builtin: item.builtin });
    this.save();
    return item;
  }

  remove(id) {
    const at = this.items.findIndex((p) => p.id === id);
    if (at < 0) return false;
    this.items.splice(at, 1);
    this.recent = this.recent.filter((r) => r !== id);
    this.save();
    return true;
  }

  /** Most recently inserted prompts, for the quick picker's first row. */
  touch(id) {
    if (!this.get(id)) return;
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 8);
    this.save();
  }

  recentItems() {
    return this.recent.map((id) => this.get(id)).filter(Boolean);
  }

  categories() {
    const used = new Set(this.items.map((p) => p.category));
    return CATEGORIES.filter((c) => used.has(c));
  }

  filter({ query = "", category = "All" } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    return this.items.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (!needle) return true;
      return (
        p.title.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle) ||
        p.body.toLowerCase().includes(needle) ||
        p.category.toLowerCase().includes(needle)
      );
    });
  }

  /** Restores the shipped prompts without removing the user's own. */
  resetDefaults() {
    const custom = this.items.filter((p) => !p.builtin);
    this.items = [...DEFAULT_PROMPTS.map((p) => ({ ...p })), ...custom];
    this.save();
  }
}
