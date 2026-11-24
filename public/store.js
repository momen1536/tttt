/**
 * store.js — conversation persistence
 *
 * Nova keeps everything in this browser. This module owns the shape of that
 * data: many independent chats, each with its own message list, model and
 * activity timestamp. Nothing here touches the DOM, so it can be unit tested
 * in Node with a fake storage object.
 */

const CHATS_KEY = "nova.chats.v2";
const PREFS_KEY = "nova.prefs.v2";
const LEGACY_KEY = "nova.chat.v1";

const MAX_CHATS = 120;
const MAX_MESSAGES = 400;
const TITLE_LIMIT = 48;

/**
 * Photos are base64 data URLs inside the one chat blob, so they are the only
 * thing here that can realistically fill localStorage (usually ~5 MB).
 * Budget them separately and evict the oldest photo when the budget or the
 * browser quota is reached — a chat must never be lost because of an image.
 */
const IMAGE_BUDGET = 1_500_000; // characters across all stored photos
const MAX_IMAGE_CHARS = 600_000; // hard cap for a single stored photo

/** Short, collision-safe id. */
export function uid(prefix = "c") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** First user message → a readable conversation title. */
export function deriveTitle(text) {
  const clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "New chat";

  const words = clean.split(" ");
  let title = "";
  for (const word of words) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > TITLE_LIMIT) break;
    title = next;
  }
  if (!title) title = clean.slice(0, TITLE_LIMIT);
  return title.length < clean.length ? `${title}…` : title;
}

/** Guarantees a message list we can render without crashing. */
function normaliseMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "user" ? "user" : "bot";
  return {
    id: Number.isFinite(raw.id) ? raw.id : Math.floor(Math.random() * 1e9),
    role,
    text: typeof raw.text === "string" ? raw.text : "",
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    via: raw.via === "ai" ? "ai" : raw.via === "engine" ? "engine" : "",
    model: typeof raw.model === "string" ? raw.model : "",
    provider: typeof raw.provider === "string" ? raw.provider : "",
    chips: Array.isArray(raw.chips) ? raw.chips.filter((c) => typeof c === "string") : [],
    // Starter cards shown under the greeting (title, hint, prompt).
    cards: Array.isArray(raw.cards)
      ? raw.cards
          .filter((card) => card && typeof card.title === "string" && card.title.trim())
          .map((card) => ({
            title: String(card.title).slice(0, 60),
            hint: typeof card.hint === "string" ? card.hint.slice(0, 100) : "",
            prompt:
              typeof card.prompt === "string" && card.prompt.trim()
                ? card.prompt.slice(0, 300)
                : String(card.title).slice(0, 300),
          }))
          .slice(0, 4)
      : [],
    greeting: !!raw.greeting,
    error: typeof raw.error === "string" ? raw.error : "",
    // A downscaled data-URL image attached to a user message (vision models).
    image:
      typeof raw.image === "string" &&
      raw.image.startsWith("data:image/") &&
      raw.image.length <= MAX_IMAGE_CHARS
        ? raw.image
        : "",
    // True when a photo was dropped to keep the conversation saving.
    imageDropped:
      Boolean(raw.imageDropped) ||
      (typeof raw.image === "string" && raw.image.length > MAX_IMAGE_CHARS),
  };
}

function normaliseChat(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normaliseMessage).filter(Boolean).slice(-MAX_MESSAGES)
    : [];
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "New chat",
    titleAuto: raw.titleAuto !== false,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    model: typeof raw.model === "string" ? raw.model : "",
    provider: typeof raw.provider === "string" ? raw.provider : "",
    // Optional subject tag used by the sidebar filter and study tools.
    tag: typeof raw.tag === "string" ? raw.tag.slice(0, 40) : "",
    engine: raw.engine && typeof raw.engine === "object" ? raw.engine : null,
    messages,
  };
}

export class ChatStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.chats = [];
    this.activeId = "";
    this.prefs = { favorites: [], lastModel: {} };
    this.available = true;
    this.load();
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                      */
  /* ---------------------------------------------------------------- */

  read(key) {
    try {
      return this.storage ? this.storage.getItem(key) : null;
    } catch {
      this.available = false;
      return null;
    }
  }

  write(key, value) {
    try {
      this.storage?.setItem(key, value);
      return true;
    } catch {
      // Private mode or a full quota. Callers decide what to do next; save()
      // retries without photos instead of failing silently.
      return false;
    }
  }

  load() {
    this.loadPrefs();

    const raw = this.read(CHATS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.chats = (Array.isArray(parsed?.chats) ? parsed.chats : [])
          .map(normaliseChat)
          .filter(Boolean);
        this.activeId = typeof parsed?.activeId === "string" ? parsed.activeId : "";
      } catch {
        this.chats = [];
      }
    }

    if (!this.chats.length) this.migrateLegacy();

    this.sortChats();
    if (!this.chats.some((c) => c.id === this.activeId)) {
      this.activeId = this.chats[0]?.id || "";
    }
    return this;
  }

  /** Imports the single-conversation format used by Nova v1. */
  migrateLegacy() {
    const raw = this.read(LEGACY_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const messages = (Array.isArray(parsed?.messages) ? parsed.messages : [])
        .map(normaliseMessage)
        .filter(Boolean);
      if (!messages.length) return;

      const firstUser = messages.find((m) => m.role === "user");
      const created = messages[0]?.ts || Date.now();
      const chat = {
        id: uid(),
        title: firstUser ? deriveTitle(firstUser.text) : "New chat",
        titleAuto: true,
        createdAt: created,
        updatedAt: messages[messages.length - 1]?.ts || created,
        model: "",
        provider: "",
        engine: null,
        messages,
      };
      this.chats = [chat];
      this.activeId = chat.id;
      this.save();
    } catch {
      /* unreadable legacy state — start clean */
    }
  }

  serialize() {
    return JSON.stringify({
      version: 2,
      activeId: this.activeId,
      chats: this.chats,
    });
  }

  /** Total base64 characters used by every stored photo. */
  imageChars() {
    let total = 0;
    for (const chat of this.chats) {
      for (const message of chat.messages) total += message.image ? message.image.length : 0;
    }
    return total;
  }

  /** Drops the oldest photo (text and everything else is kept). */
  dropOldestImage() {
    let oldest = null;
    for (const chat of this.chats) {
      for (const message of chat.messages) {
        if (!message.image) continue;
        if (!oldest || (message.ts || 0) < (oldest.ts || 0)) oldest = message;
      }
    }
    if (!oldest) return false;
    oldest.image = "";
    oldest.imageDropped = true;
    return true;
  }

  notifyDropped(count) {
    if (!count) return;
    try {
      this.onImageDropped?.(count);
    } catch {
      /* a listener must never break saving */
    }
  }

  /**
   * Writes the chat blob, giving up old photos rather than the conversation.
   * The last successful value in storage is never overwritten with a failure.
   */
  save() {
    let dropped = 0;

    while (this.imageChars() > IMAGE_BUDGET && this.dropOldestImage()) dropped += 1;

    if (this.write(CHATS_KEY, this.serialize())) {
      this.available = true;
      this.notifyDropped(dropped);
      return true;
    }

    // Quota exceeded: hand back photos oldest-first, retrying after each one.
    while (this.dropOldestImage()) {
      dropped += 1;
      if (this.write(CHATS_KEY, this.serialize())) {
        this.available = true;
        this.notifyDropped(dropped);
        return true;
      }
    }

    // Last resort: drop every remaining photo in one pass.
    for (const chat of this.chats) {
      for (const message of chat.messages) {
        if (!message.image) continue;
        message.image = "";
        message.imageDropped = true;
        dropped += 1;
      }
    }
    if (this.write(CHATS_KEY, this.serialize())) {
      this.available = true;
      this.notifyDropped(dropped);
      return true;
    }

    // Even text will not fit (private mode or another key filled the quota).
    // Keep working in memory; the previous saved conversation stays intact.
    this.available = false;
    return false;
  }

  loadPrefs() {
    const raw = this.read(PREFS_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.prefs = {
        favorites: (Array.isArray(parsed?.favorites) ? parsed.favorites : [])
          .filter((f) => f && typeof f.id === "string")
          .map((f) => ({
            id: f.id,
            provider: typeof f.provider === "string" ? f.provider : "gemini",
            name: typeof f.name === "string" ? f.name : f.id,
            context: Number.isFinite(f.context) ? f.context : 0,
          }))
          .slice(0, 40),
        lastModel: parsed?.lastModel && typeof parsed.lastModel === "object" ? parsed.lastModel : {},
      };
    } catch {
      this.prefs = { favorites: [], lastModel: {} };
    }
  }

  savePrefs() {
    this.write(PREFS_KEY, JSON.stringify(this.prefs));
  }

  /* ---------------------------------------------------------------- */
  /* Chat collection                                                  */
  /* ---------------------------------------------------------------- */

  sortChats() {
    this.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  list() {
    return this.chats;
  }

  get(id) {
    return this.chats.find((c) => c.id === id) || null;
  }

  get active() {
    return this.get(this.activeId);
  }

  setActive(id) {
    if (!this.get(id)) return null;
    this.activeId = id;
    this.save();
    return this.active;
  }

  create({ model = "", provider = "", tag = "" } = {}) {
    const chat = {
      id: uid(),
      title: "New chat",
      titleAuto: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      provider,
      tag: typeof tag === "string" ? tag.slice(0, 40) : "",
      engine: null,
      messages: [],
    };
    this.chats.unshift(chat);
    this.activeId = chat.id;
    this.prune();
    this.save();
    return chat;
  }

  /** Creates a chat only when there is no usable active one. */
  ensureActive(options = {}) {
    return this.active || this.create(options);
  }

  remove(id) {
    const index = this.chats.findIndex((c) => c.id === id);
    if (index < 0) return false;
    this.chats.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = this.chats[Math.min(index, this.chats.length - 1)]?.id || "";
    }
    this.save();
    return true;
  }

  rename(id, title) {
    const chat = this.get(id);
    if (!chat) return false;
    const clean = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean) return false;
    chat.title = clean;
    chat.titleAuto = false;
    this.save();
    return true;
  }

  /** Titles follow the first user message until the user renames the chat. */
  autoTitle(id, text) {
    const chat = this.get(id);
    if (!chat || !chat.titleAuto) return;
    const firstUser = chat.messages.find((m) => m.role === "user" && !m.greeting);
    chat.title = deriveTitle(firstUser?.text || text);
    this.save();
  }

  /** Subject tag: "Maths", "Physics"… or "" for untagged. */
  setTag(id, tag) {
    const chat = this.get(id);
    if (!chat) return false;
    chat.tag = typeof tag === "string" ? tag.slice(0, 40) : "";
    this.save();
    return true;
  }

  /** Keeps the offline engine's memory (name recall, follow-ups) per chat. */
  setEngine(id, engine) {
    const chat = this.get(id);
    if (!chat) return;
    chat.engine = engine && typeof engine === "object" ? engine : null;
    this.save();
  }

  touch(id) {
    const chat = this.get(id);
    if (!chat) return;
    chat.updatedAt = Date.now();
    this.sortChats();
    this.save();
  }

  setModel(id, model, provider) {
    const chat = this.get(id);
    if (!chat) return false;
    chat.model = String(model || "");
    chat.provider = String(provider || "");
    this.save();
    if (provider) this.setLastModel(provider, model);
    return true;
  }

  prune() {
    while (this.chats.length > MAX_CHATS) {
      const index = [...this.chats]
        .map((chat, i) => ({ chat, i }))
        .filter(({ chat }) => chat.id !== this.activeId)
        .sort((a, b) => (a.chat.updatedAt || 0) - (b.chat.updatedAt || 0))[0];
      if (!index) break;
      this.chats.splice(index.i, 1);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                         */
  /* ---------------------------------------------------------------- */

  addMessage(chatId, message) {
    const chat = this.get(chatId);
    if (!chat) return null;
    const msg = normaliseMessage(message);
    chat.messages.push(msg);
    if (chat.messages.length > MAX_MESSAGES) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
    }
    chat.updatedAt = Date.now();
    this.sortChats();
    this.save();
    return msg;
  }

  updateMessage(chatId, messageId, patch) {
    const chat = this.get(chatId);
    if (!chat) return null;
    const msg = chat.messages.find((m) => m.id === messageId);
    if (!msg) return null;
    Object.assign(msg, patch);
    this.save();
    return msg;
  }

  removeMessage(chatId, messageId) {
    const chat = this.get(chatId);
    if (!chat) return false;
    const index = chat.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    chat.messages.splice(index, 1);
    chat.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** Removes a message and everything after it (used by edit + regenerate). */
  truncateFrom(chatId, messageId) {
    const chat = this.get(chatId);
    if (!chat) return 0;
    const index = chat.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return 0;
    const removed = chat.messages.length - index;
    chat.messages.splice(index);
    chat.updatedAt = Date.now();
    this.save();
    return removed;
  }

  /* ---------------------------------------------------------------- */
  /* Search                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Finds chats whose title or messages contain the query.
   * Returns [{ chat, snippet, inTitle }] newest first.
   */
  search(query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return this.chats.map((chat) => ({ chat, snippet: "", inTitle: false }));

    const hits = [];
    for (const chat of this.chats) {
      const inTitle =
        chat.title.toLowerCase().includes(needle) ||
        Boolean(chat.tag && chat.tag.toLowerCase().includes(needle));
      let snippet = "";
      if (!inTitle) {
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          const text = chat.messages[i].text;
          const at = text.toLowerCase().indexOf(needle);
          if (at >= 0) {
            const start = Math.max(0, at - 34);
            const end = Math.min(text.length, at + needle.length + 46);
            snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
            break;
          }
        }
      }
      if (inTitle || snippet) hits.push({ chat, snippet, inTitle });
    }
    return hits;
  }

  /* ---------------------------------------------------------------- */
  /* Preferences: favourite models, last model per provider           */
  /* ---------------------------------------------------------------- */

  isFavorite(model) {
    if (!model?.id) return false;
    return this.prefs.favorites.some(
      (f) => f.id === model.id && f.provider === (model.provider || "gemini")
    );
  }

  toggleFavorite(model) {
    if (!model?.id) return false;
    const provider = model.provider || "gemini";
    const at = this.prefs.favorites.findIndex(
      (f) => f.id === model.id && f.provider === provider
    );
    let added;
    if (at >= 0) {
      this.prefs.favorites.splice(at, 1);
      added = false;
    } else {
      this.prefs.favorites.push({
        id: model.id,
        provider,
        name: model.name || model.id,
        context: Number.isFinite(model.context) ? model.context : 0,
      });
      added = true;
    }
    this.savePrefs();
    return added;
  }

  favorites(provider) {
    return provider
      ? this.prefs.favorites.filter((f) => f.provider === provider)
      : this.prefs.favorites;
  }

  setLastModel(provider, model) {
    if (!provider || !model) return;
    this.prefs.lastModel[provider] = model;
    this.savePrefs();
  }

  getLastModel(provider) {
    return this.prefs.lastModel?.[provider] || "";
  }
}
