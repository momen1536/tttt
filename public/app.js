/**
 * app.js — chat UI controller
 *
 * Wires three layers together:
 *   store.js   conversations, per-chat model, favourites, persistence
 *   prompts.js the prompt library
 *   ai.js      provider settings + streaming completions
 *   engine.js  the offline fallback brain
 *
 * The DOM stays plain: no framework, no build step. Every mutation goes
 * through the store first, then the visible patch is rendered from it.
 */

// Versioned module URLs keep a returning browser from mixing an old cached
// stylesheet or module with new markup (the query only busts the cache).
import { createSession, respond, TOPICS } from "./engine.js?v=7";
import {
  AiError,
  DEFAULT_MODEL,
  GEMINI_MODELS,
  PROVIDERS,
  SYSTEM_PROMPT,
  checkKey,
  clearProvider,
  fetchModels,
  loadServerAi,
  loadSettings,
  looksLikeKey,
  maskKey,
  providerHasKey,
  providerInfo,
  serverHasProvider,
  saveSettings,
  shortModel,
  splitModelName,
  streamChat,
} from "./ai.js?v=15";
import { ChatStore, deriveTitle } from "./store.js?v=8";
import { CATEGORIES, PromptStore } from "./prompts.js?v=7";
import { SUBJECTS } from "./study.js?v=7";
import { initStudy } from "./study-ui.js?v=7";
import { escapeHtml, plainText, renderMarkdown } from "./markdown.js?v=7";

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const byId = (id) => document.getElementById(id);

const els = {
  app: byId("app"),
  sidebar: byId("sidebar"),
  sidebarToggle: byId("sidebar-toggle"),
  sidebarClose: byId("sidebar-close"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  newChat: byId("new-chat"),
  newChatTop: byId("new-chat-top"),
  chatSearch: byId("chat-search"),
  chatSearchClear: byId("chat-search-clear"),
  chatList: byId("chat-list"),
  chatEmpty: byId("chat-empty"),
  sideTopics: byId("side-topics"),
  topics: byId("topic-chips"),
  promptLibraryBtn: byId("prompt-library-btn"),
  footSettings: byId("foot-settings"),
  studyBtn: byId("study-btn"),
  studyHeadBtn: byId("study-head-btn"),
  tagSelect: byId("chat-tag"),

  micBtn: byId("mic-btn"),
  imageBtn: byId("image-btn"),
  imageFile: byId("image-file"),
  attachPreview: byId("attach-preview"),
  attachImg: byId("attach-img"),
  attachInfo: byId("attach-info"),
  attachRemove: byId("attach-remove"),

  messages: byId("messages"),
  composer: byId("composer"),
  input: byId("composer-input"),
  send: byId("send-btn"),
  counter: byId("counter"),
  promptBtn: byId("prompt-btn"),
  scrollBtn: byId("scroll-btn"),

  pill: byId("engine-pill"),
  engineLabel: byId("engine-label"),
  engineFoot: byId("engine-foot"),

  modelBtn: byId("model-btn"),
  modelBtnLabel: byId("model-btn-label"),
  modelBtnProvider: byId("model-btn-provider"),
  modelPopover: byId("model-popover"),
  modelSearch: byId("model-search"),
  modelTabs: byId("model-provider-tabs"),
  modelHint: byId("model-hint"),
  modelFavorites: byId("model-favorites"),
  modelList: byId("model-list"),
  modelEmpty: byId("model-empty"),
  modelLoading: byId("model-loading"),
  modelCount: byId("model-count"),
  modelSettingsLink: byId("model-settings-link"),

  promptQuick: byId("prompt-quick"),
  promptQuickSearch: byId("prompt-quick-search"),
  promptQuickCats: byId("prompt-quick-cats"),
  promptQuickList: byId("prompt-quick-list"),
  promptQuickLibrary: byId("prompt-quick-library"),

  exportBtn: byId("export-btn"),
  settingsBtn: byId("settings-btn"),
  theme: byId("theme-toggle"),
  chatHead: document.querySelector(".chat-head"),

  dialog: byId("ai-dialog"),
  form: byId("ai-form"),
  dialogProvider: byId("ai-provider"),
  keyField: byId("ai-key-field"),
  keyInput: byId("ai-key"),
  keyLabel: byId("ai-key-label"),
  keyHint: byId("ai-key-hint"),
  reveal: byId("ai-reveal"),
  baseField: byId("ai-base-field"),
  baseInput: byId("ai-base-url"),
  modelInput: byId("ai-model"),
  modelDatalist: byId("ai-models"),
  modelHintSettings: byId("ai-model-hint"),
  modelQuick: byId("model-quick"),
  dialogStatus: byId("ai-status"),
  test: byId("ai-test"),
  remove: byId("ai-remove"),
  stepsCheck: byId("ai-steps"),
  save: byId("ai-save"),
  modelSelect: byId("ai-model-select"),
  help: byId("ai-help"),
  closeSettings: byId("ai-close"),

  setupDialog: byId("setup-dialog"),
  setupForm: byId("setup-form"),
  setupKey: byId("setup-key"),
  setupReveal: byId("setup-reveal"),
  setupStatus: byId("setup-status"),
  setupSave: byId("setup-save"),
  setupSkip: byId("setup-skip"),
  setupClose: byId("setup-close"),

  promptDialog: byId("prompt-dialog"),
  promptLibraryView: byId("prompt-library-view"),
  promptEditorView: byId("prompt-editor-view"),
  promptClose: byId("prompt-close"),
  promptSearch: byId("prompt-search"),
  promptNew: byId("prompt-new"),
  promptCats: byId("prompt-cats"),
  promptList: byId("prompt-list"),
  promptEmpty: byId("prompt-empty"),
  promptCount: byId("prompt-count"),
  promptReset: byId("prompt-reset"),
  promptBack: byId("prompt-back"),
  promptEditorTitle: byId("prompt-editor-title"),
  promptTitle: byId("prompt-title"),
  promptCategory: byId("prompt-category"),
  promptDescription: byId("prompt-description"),
  promptBody: byId("prompt-body"),
  promptError: byId("prompt-error"),
  promptCancel: byId("prompt-cancel"),
  promptSave: byId("prompt-save"),

  confirmDialog: byId("confirm-dialog"),
  confirmTitle: byId("confirm-title"),
  confirmText: byId("confirm-text"),
  confirmCancel: byId("confirm-cancel"),
  confirmOk: byId("confirm-ok"),
  toast: byId("toast"),
};

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const THEME_KEY = "nova.theme.v1";
const MAX_INPUT = 1200;

const GREETING = {
  text:
    "Hi, I'm **Nova** — your study assistant. I can explain computer-science concepts, run calculations, convert units, and help you plan revision.\n\nWhat would you like to work on?",
  chips: ["What can you do?", "Explain machine learning", "Help me revise for exams", "Quiz me on a topic"],
  cards: [
    {
      title: "Explain a concept",
      hint: "Machine learning, deadlocks, TCP…",
      prompt: "Explain machine learning",
    },
    {
      title: "Revise for an exam",
      hint: "A realistic plan from today to exam day",
      prompt: "Help me revise for exams",
    },
    {
      title: "Check my understanding",
      hint: "Quiz me, then mark my answers",
      prompt: "Quiz me on a topic",
    },
    {
      title: "Work through a problem",
      hint: "Steps and reasoning, not just the answer",
      prompt: "Show me how to solve a problem step by step",
    },
  ],
};

const AI_FOLLOW_UPS = ["Explain that more simply", "Give me a concrete example", "Quiz me on this"];

/** Shown when a free tier's daily allowance is used up. */
const FREE_TIER_STEPS = [
  "Switch to another free model — each Gemini model has its own daily free allowance, so another one can still answer.",
  "Wait for the reset (it restarts at midnight Pacific time), or add a free key from another Google account in AI settings.",
  "Keep studying right now with the built-in engine — no key, no limit.",
];
const FEATURED = ["ai", "ds", "dbms", "os", "networks", "oop", "webdev", "security"];

const reduceMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const store = new ChatStore();

// Old photos are sacrificed before a conversation is ever lost to the quota.
store.onImageDropped = (count) => {
  toast(
    count === 1
      ? "Removed an old photo to keep this conversation saving"
      : `Removed ${count} old photos to keep conversations saving`
  );
};

const promptStore = new PromptStore();
let ai = loadSettings();

let busy = false;
let stream = null;
let streamChatId = "";
let activeToken = 0;
let msgSeq = 0;

const modelCache = {};
const modelErrors = {};
let modelLoading = null;
let modelPickProvider = PROVIDERS.gemini.id;

let quickCategory = "All";
let libraryCategory = "All";
let editingPromptId = null;
let confirmResolver = null;
let toastTimer = 0;
let speakingBtn = null;

// Study hub handle (set at boot), and the photo waiting to be sent.
let study = null;
let pendingImage = "";
let listening = null;

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function nextId() {
  msgSeq += 1;
  return msgSeq;
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fullDate(ts) {
  return new Date(ts).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

function groupLabel(ts) {
  const day = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (day.getTime() >= startOfToday) return "Today";
  if (day.getTime() >= startOfToday - 86_400_000) return "Yesterday";
  if (day.getTime() >= startOfToday - 7 * 86_400_000) return "Previous 7 days";
  if (day.getTime() >= startOfToday - 30 * 86_400_000) return "Previous 30 days";
  return "Older";
}

function toast(text) {
  if (!els.toast) return;
  els.toast.textContent = text;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
    window.setTimeout(() => {
      els.toast.hidden = true;
    }, 240);
  }, 2200);
}

async function copyText(text) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function nearBottom() {
  const box = els.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 150;
}

function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    els.messages.scrollTo({
      top: els.messages.scrollHeight,
      behavior: smooth && !reduceMotion ? "smooth" : "auto",
    });
  });
}

function refreshScrollButton() {
  if (!els.scrollBtn) return;
  const show = !nearBottom();
  els.scrollBtn.classList.toggle("is-visible", show);
  if (!show) els.scrollBtn.classList.remove("has-unread");
  if (els.chatHead) els.chatHead.classList.toggle("is-scrolled", els.messages.scrollTop > 4);
}

function markUnread() {
  if (!els.scrollBtn || !els.scrollBtn.classList.contains("is-visible")) return;
  els.scrollBtn.classList.add("has-unread");
}

function pulseSend() {
  if (reduceMotion || !els.send) return;
  els.send.classList.remove("is-sent");
  void els.send.offsetWidth;
  els.send.classList.add("is-sent");
  window.setTimeout(() => els.send.classList.remove("is-sent"), 360);
}

function spawnRipple(event, el) {
  if (reduceMotion || !el) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;
  dot.style.left = `${(event?.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2}px`;
  dot.style.top = `${(event?.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2}px`;
  el.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
}

function initPointerGlow() {
  if (!els.app || reduceMotion) return;
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  let frame = 0;
  els.app.addEventListener("pointermove", (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = els.app.getBoundingClientRect();
      els.app.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      els.app.style.setProperty("--my", `${event.clientY - rect.top}px`);
      els.app.classList.add("is-pointer");
    });
  });
  els.app.addEventListener("pointerleave", () => els.app.classList.remove("is-pointer"));
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/* ------------------------------------------------------------------ */
/* Chat model helpers                                                  */
/* ------------------------------------------------------------------ */

function modelForChat(chat) {
  const provider = chat && PROVIDERS[chat.provider] ? chat.provider : ai.provider;
  const fallbackModel = provider === ai.provider ? ai.model : "";
  const model = (chat && chat.model) || fallbackModel || PROVIDERS[provider]?.defaultModel || "";
  return {
    provider,
    model,
    key: ai.providers?.[provider]?.key || "",
    baseUrl: provider === "custom" ? ai.providers?.custom?.baseUrl || "" : "",
    ready: Boolean(model && providerHasKey(ai, provider)),
  };
}

/** Models known without a network round trip. */
function staticModels(provider) {
  return provider === "gemini" ? GEMINI_MODELS : [];
}

function providerModels(provider) {
  return modelCache[provider] || staticModels(provider);
}

function findModel(provider, id) {
  const cached = providerModels(provider).find((m) => m.id === id);
  if (cached) return cached;
  const favourite = store.favorites(provider).find((m) => m.id === id);
  if (favourite) return { ...favourite, provider };
  return null;
}

function modelLabel(provider, id) {
  const model = findModel(provider, id);
  const name = model?.name || id;
  return splitModelName(name, id).label || shortModel(id);
}

function modelVendor(provider, id) {
  const model = findModel(provider, id);
  const vendor = splitModelName(model?.name || "", id).vendor;
  return vendor || providerInfo(provider).label;
}

/* ------------------------------------------------------------------ */
/* Header + engine status                                              */
/* ------------------------------------------------------------------ */

function updateHeader() {
  const chat = store.active;
  const pick = modelForChat(chat);
  if (els.tagSelect) els.tagSelect.value = chat?.tag || "";

  if (pick.ready) {
    const conf = providerInfo(pick.provider);
    els.modelBtnLabel.textContent = modelLabel(pick.provider, pick.model);
    els.modelBtnProvider.textContent = conf.label;
    els.modelBtn.dataset.state = "ready";
    els.modelBtn.title = `${pick.model} · ${conf.label}`;
    els.engineLabel.textContent = conf.badge || `${conf.label} · connected`;
    els.pill.classList.add("is-live");
    els.pill.title = `${conf.badge || conf.label} — update or clear the key`;
    els.engineFoot.textContent = `Powered by ${modelLabel(pick.provider, pick.model)}`;
  } else {
    els.modelBtnLabel.textContent = pick.model ? modelLabel(pick.provider, pick.model) : "Built-in engine";
    els.modelBtnProvider.textContent = pick.model ? `no key · ${providerInfo(pick.provider).label}` : "offline";
    els.modelBtn.dataset.state = "offline";
    els.modelBtn.title = pick.model
      ? `${pick.model} — add an API key to use it`
      : "Connect a provider to use a live model";
    els.engineLabel.textContent = pick.provider === "gemini" ? "Google AI Studio · add key" : "Built-in engine";
    els.pill.classList.remove("is-live");
    els.pill.title = pick.provider === "gemini" ? "Add your free Gemini API key" : "AI settings";
    els.engineFoot.textContent = "On-device engine";
  }
}

function setBusy(value) {
  busy = value;
  const canStop = value && !!stream;
  els.send.disabled = !canStop && (value || !els.input.value.trim());
  els.send.classList.toggle("is-stop", canStop);
  els.send.setAttribute("aria-label", canStop ? "Stop generating" : "Send message");
  els.send.title = canStop ? "Stop generating" : "Send message";
  els.input.setAttribute("aria-busy", String(value));
  els.pill.classList.toggle("is-busy", value);
  refreshSendState();
}

function refreshSendState() {
  els.send.classList.toggle("is-ready", !busy && Boolean(els.input.value.trim()));
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function setSidebar(open) {
  els.app.classList.toggle("sidebar-open", open);
  els.sidebarToggle.setAttribute("aria-expanded", String(open));
}

function buildChatItem(hit) {
  const chat = hit.chat;
  const item = document.createElement("div");
  item.className = "chat-item";
  if (chat.id === store.activeId) item.classList.add("is-active");
  item.dataset.id = chat.id;
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.title = `${chat.title}\n${fullDate(chat.updatedAt)}`;

  const mark = document.createElement("span");
  mark.className = "chat-item-icon";
  mark.innerHTML = icon("message");

  const main = document.createElement("span");
  main.className = "chat-item-main";

  const title = document.createElement("span");
  title.className = "chat-item-title";
  title.textContent = chat.title;

  const meta = document.createElement("span");
  meta.className = "chat-item-meta";
  const count = chat.messages.filter((m) => !m.greeting).length;
  meta.textContent = `${relativeTime(chat.updatedAt)}${count ? ` · ${count} message${count === 1 ? "" : "s"}` : ""}`;

  main.append(title, meta);

  if (chat.tag) {
    const tag = document.createElement("span");
    tag.className = "chat-item-tag";
    tag.textContent = chat.tag;
    main.appendChild(tag);
  }

  if (hit.snippet) {
    const snippet = document.createElement("span");
    snippet.className = "chat-item-snippet";
    snippet.textContent = hit.snippet;
    main.appendChild(snippet);
  }

  const actions = document.createElement("span");
  actions.className = "chat-item-actions";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "chat-item-act";
  rename.dataset.act = "rename";
  rename.title = "Rename conversation";
  rename.setAttribute("aria-label", `Rename ${chat.title}`);
  rename.innerHTML = icon("pencil");

  const del = document.createElement("button");
  del.type = "button";
  del.className = "chat-item-act";
  del.dataset.act = "delete";
  del.title = "Delete conversation";
  del.setAttribute("aria-label", `Delete ${chat.title}`);
  del.innerHTML = icon("trash");

  actions.append(rename, del);
  item.append(mark, main, actions);

  item.addEventListener("click", (event) => {
    const action = event.target.closest("button[data-act]");
    if (action) {
      event.stopPropagation();
      if (action.dataset.act === "rename") beginRename(chat.id, item);
      else deleteChat(chat.id);
      return;
    }
    if (event.target.closest(".rename-input")) return;
    selectChat(chat.id);
  });

  item.addEventListener("keydown", (event) => {
    if (event.target !== item) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectChat(chat.id);
    }
  });

  return item;
}

function beginRename(id, item) {
  const chat = store.get(id);
  const titleEl = item.querySelector(".chat-item-title");
  if (!chat || !titleEl || item.querySelector(".rename-input")) return;

  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = chat.title;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Conversation name");
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) {
      store.rename(id, input.value);
      updateHeader();
      toast("Conversation renamed");
    }
    renderChatList();
  };

  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function renderChatList() {
  const query = els.chatSearch.value.trim();
  const hits = store.search(query);
  els.chatList.innerHTML = "";
  els.chatSearchClear.hidden = !query;

  const hasChats = hits.length > 0;
  els.chatEmpty.hidden = hasChats;
  if (!hasChats) {
    els.chatEmpty.querySelector(".side-empty-title").textContent = query
      ? "No conversations found"
      : "No conversations yet";
    els.chatEmpty.querySelector(".side-empty-text").textContent = query
      ? "Try a different search, or start a new chat."
      : "Start one with the button above.";
    return;
  }

  let lastGroup = "";
  for (const hit of hits) {
    const label = groupLabel(hit.chat.updatedAt);
    if (label !== lastGroup) {
      const heading = document.createElement("p");
      heading.className = "chat-group";
      heading.textContent = label;
      els.chatList.appendChild(heading);
      lastGroup = label;
    }
    els.chatList.appendChild(buildChatItem(hit));
  }
}

function selectChat(id) {
  if (!store.get(id)) return;
  stopSpeech();
  closeModelPopover();
  closePromptQuick();
  setSidebar(false);

  store.setActive(id);
  const chat = store.active;
  if (chat && !chat.messages.length) store.addMessage(chat.id, greetingMessage());

  els.input.value = "";
  resizeInput();
  updateCounter();
  renderChatList();
  renderMessages({ scroll: "bottom" });
  updateHeader();
  els.input.focus();
}

async function deleteChat(id) {
  const chat = store.get(id);
  if (!chat) return;
  const ok = await confirmAction({
    title: "Delete conversation?",
    message: `“${chat.title}” and its ${chat.messages.filter((m) => !m.greeting).length} messages will be removed from this browser. This cannot be undone.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;

  if (stream && streamChatId === id) stream.abort();
  store.remove(id);

  if (!store.chats.length) createChatWithGreeting();
  else {
    const active = store.active;
    if (active && !active.messages.length) store.addMessage(active.id, greetingMessage());
  }

  renderChatList();
  renderMessages({ scroll: "bottom" });
  updateHeader();
  toast("Conversation deleted");
}

function createChatWithGreeting(model = null) {
  const pick = model || defaultModelForNewChat();
  const chat = store.create({ model: pick.id, provider: pick.provider });
  store.addMessage(chat.id, greetingMessage());
  return chat;
}

function defaultModelForNewChat() {
  const active = store.active;
  if (active?.model) return { id: active.model, provider: active.provider || ai.provider };
  return { id: ai.model || DEFAULT_MODEL, provider: ai.provider };
}

function greetingMessage() {
  return {
    id: nextId(),
    role: "bot",
    text: GREETING.text,
    chips: GREETING.chips,
    cards: GREETING.cards,
    ts: Date.now(),
    greeting: true,
  };
}

/* ------------------------------------------------------------------ */
/* Message rendering                                                   */
/* ------------------------------------------------------------------ */

function messageById(chat, id) {
  return chat?.messages.find((m) => m.id === Number(id)) || null;
}

function actionButton(action, iconName, label, cls = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `msg-action ${cls}`.trim();
  btn.dataset.action = action;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = icon(iconName);
  return btn;
}

function canRegenerate(chat, msg) {
  if (!chat || msg.role !== "bot") return false;
  const index = chat.messages.indexOf(msg);
  return index > 0 && chat.messages.slice(0, index).some((m) => m.role === "user");
}

function buildActions(msg, chat) {
  if (msg.greeting) return null;
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  if (msg.role === "bot") {
    bar.append(actionButton("copy", "copy", "Copy reply"));
    if (canRegenerate(chat, msg)) bar.append(actionButton("regenerate", "refresh", "Regenerate reply"));
    if (speechSupported()) bar.append(actionButton("speak", "speaker", "Read aloud"));
    bar.append(actionButton("explain", "pencil", "Explain it back"));
    bar.append(actionButton("delete", "trash", "Delete message"));
  } else {
    bar.append(actionButton("copy", "copy", "Copy message"));
    bar.append(actionButton("edit", "pencil", "Edit and resend"));
    bar.append(actionButton("delete", "trash", "Delete message"));
  }
  return bar;
}

function buildStarterCards(cards) {
  const holder = document.createElement("div");
  holder.className = "starter-grid";
  for (const card of cards) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "starter-card";

    const title = document.createElement("strong");
    title.textContent = card.title;
    const hint = document.createElement("span");
    hint.textContent = card.hint || "";

    btn.append(title, hint);
    btn.title = card.prompt || card.title;
    btn.addEventListener("click", () => {
      if (busy) return;
      submitUser(card.prompt || card.title);
    });
    holder.appendChild(btn);
  }
  return holder;
}

function buildChips(chips) {
  const holder = document.createElement("div");
  holder.className = "chips";
  chips.forEach((label, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.style.animationDelay = `${Math.min(index * 45, 180)}ms`;
    btn.addEventListener("click", (event) => {
      if (busy) return;
      spawnRipple(event, btn);
      submitUser(label);
    });
    holder.appendChild(btn);
  });
  return holder;
}

function buildMessageEl(msg, chat) {
  const row = document.createElement("div");
  row.className = `msg msg-${msg.role}`;
  row.dataset.id = msg.id;
  if (msg.greeting) row.classList.add("is-greeting");

  const avatar = document.createElement("div");
  avatar.className = `avatar ${msg.role === "user" ? "avatar-user" : "avatar-bot"}`;
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = msg.role === "user" ? "You" : "N";

  const wrap = document.createElement("div");
  wrap.className = "msg-bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dir = "auto";

  if (msg.image) {
    const photo = document.createElement("img");
    photo.className = "msg-image";
    photo.src = msg.image;
    photo.alt = "Photo attached to this message";
    photo.loading = "lazy";
    bubble.appendChild(photo);
  }

  const content = document.createElement("div");
  content.className = "bubble-content";
  content.innerHTML = msg.text ? renderMarkdown(msg.text) : "";
  bubble.appendChild(content);
  wrap.appendChild(bubble);

  if (msg.error) {
    const note = document.createElement("p");
    note.className = "msg-note";
    note.textContent = msg.error;
    wrap.appendChild(note);
  }

  if (msg.imageDropped && !msg.image) {
    const note = document.createElement("p");
    note.className = "msg-note";
    note.textContent = "Photo removed to free space in this browser — the message itself is kept.";
    wrap.appendChild(note);
  }

  const foot = document.createElement("div");
  foot.className = "msg-foot";

  const meta = document.createElement("div");
  meta.className = "bubble-meta";

  if (msg.role === "bot" && msg.via === "ai" && msg.model) {
    const tag = document.createElement("span");
    tag.className = "via";
    tag.textContent = modelLabel(msg.provider, msg.model);
    tag.title = `${msg.model}${msg.provider ? ` · ${providerInfo(msg.provider).label}` : ""}`;
    meta.appendChild(tag);
  }

  const time = document.createElement("span");
  time.textContent = timeLabel(msg.ts);
  time.title = fullDate(msg.ts);
  meta.appendChild(time);

  foot.appendChild(meta);
  const actions = buildActions(msg, chat);
  if (actions) foot.appendChild(actions);
  wrap.appendChild(foot);

  if (msg.cards?.length) wrap.appendChild(buildStarterCards(msg.cards));
  else if (msg.chips?.length) wrap.appendChild(buildChips(msg.chips));

  row.append(avatar, wrap);
  return row;
}

function appendRow(msg, chat) {
  const row = buildMessageEl(msg, chat);
  const follow = nearBottom();
  els.messages.appendChild(row);
  if (follow) scrollToBottom();
  else markUnread();
  return row;
}

function renderMessages({ scroll = "bottom" } = {}) {
  const chat = store.active;
  els.messages.innerHTML = "";
  if (!chat) return;
  const fragment = document.createDocumentFragment();
  for (const msg of chat.messages) fragment.appendChild(buildMessageEl(msg, chat));
  els.messages.appendChild(fragment);
  if (scroll === "bottom") scrollToBottom(false);
  refreshScrollButton();
}

function showTyping(label = "Nova is typing") {
  if (streamChatId && store.activeId !== streamChatId) return null;
  const row = document.createElement("div");
  row.className = "msg msg-bot typing";
  row.id = "typing-indicator";
  row.innerHTML = `
    <div class="avatar avatar-bot" aria-hidden="true">N</div>
    <div class="msg-bubble-wrap">
      <div class="bubble" aria-label="${escapeHtml(label)}">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    </div>`;
  els.messages.appendChild(row);
  scrollToBottom();
  return row;
}

function addStreamStatus(row) {
  if (!row || row.querySelector(".msg-status")) return;
  const status = document.createElement("div");
  status.className = "msg-status";
  status.innerHTML = `<span class="gen-dot" aria-hidden="true"></span><span>Generating…</span>`;
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "stop-inline";
  stop.dataset.action = "stop";
  stop.textContent = "Stop";
  status.appendChild(stop);
  row.querySelector(".msg-bubble-wrap").appendChild(status);
}

/* ------------------------------------------------------------------ */
/* Message actions                                                     */
/* ------------------------------------------------------------------ */

function flashAction(btn, iconName) {
  if (!btn) return;
  const original = btn.innerHTML;
  btn.innerHTML = icon(iconName);
  btn.classList.add("is-done");
  window.setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove("is-done");
  }, 1500);
}

function beginEdit(msg, row, chat) {
  if (busy) {
    toast("Stop the current reply first");
    return;
  }
  const bubble = row.querySelector(".bubble");
  if (!bubble || bubble.querySelector(".msg-editor")) return;

  const content = bubble.querySelector(".bubble-content");
  const editor = document.createElement("div");
  editor.className = "msg-editor";
  editor.innerHTML = `
    <textarea class="msg-editor-input" rows="3" aria-label="Edit your message"></textarea>
    <div class="msg-editor-actions">
      <button class="text-btn" type="button" data-edit="cancel">Cancel</button>
      <button class="primary-btn" type="button" data-edit="save">Save &amp; resend</button>
    </div>`;

  const input = editor.querySelector("textarea");
  input.value = msg.text;
  content.replaceWith(editor);
  bubble.classList.add("is-editing");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const cancel = () => renderMessages({ scroll: "keep" });
  const save = () => {
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    const current = store.get(chat.id);
    if (!current) return;
    store.truncateFrom(chat.id, msg.id);
    renderMessages({ scroll: "keep" });
    submitUser(value);
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  editor.querySelector('[data-edit="cancel"]').addEventListener("click", cancel);
  editor.querySelector('[data-edit="save"]').addEventListener("click", save);
}

async function regenerateMessage(msg, chat) {
  if (busy) {
    toast("Stop the current reply first");
    return;
  }
  const index = chat.messages.findIndex((m) => m.id === msg.id);
  if (index < 0) return;

  let userIndex = index - 1;
  while (userIndex >= 0 && chat.messages[userIndex].role !== "user") userIndex -= 1;
  if (userIndex < 0) return;

  const after = chat.messages.length - index - 1;
  if (after > 0) {
    const ok = await confirmAction({
      title: "Regenerate this reply?",
      message: `${after} later message${after === 1 ? "" : "s"} will be removed so the conversation continues from here.`,
      confirmLabel: "Regenerate",
    });
    if (!ok) return;
  }

  stopSpeech();
  store.truncateFrom(chat.id, msg.id);
  renderMessages({ scroll: "keep" });
  renderChatList();
  await generateReply(chat.id);
}

function deleteMessage(msg, chat) {
  confirmAction({
    title: "Delete this message?",
    message: "It will be removed from the conversation in this browser. This cannot be undone.",
    confirmLabel: "Delete",
  }).then((ok) => {
    if (!ok) return;
    store.removeMessage(chat.id, msg.id);
    renderMessages({ scroll: "keep" });
    renderChatList();
    updateHeader();
    toast("Message deleted");
  });
}

els.messages.addEventListener("click", async (event) => {
  const codeBtn = event.target.closest(".code-copy");
  if (codeBtn) {
    const code = codeBtn.closest(".code-block")?.querySelector("pre")?.textContent || "";
    const ok = await copyText(code);
    codeBtn.textContent = ok ? "Copied" : "Failed";
    codeBtn.classList.add("is-copied");
    window.setTimeout(() => {
      codeBtn.textContent = "Copy";
      codeBtn.classList.remove("is-copied");
    }, 1600);
    if (ok) toast("Code copied");
    return;
  }

  const btn = event.target.closest("[data-action]");
  if (!btn) return;

  const row = btn.closest(".msg");
  const chat = store.active;
  if (!row || !chat) return;
  const msg = messageById(chat, row.dataset.id);
  if (!msg) return;

  switch (btn.dataset.action) {
    case "copy": {
      const ok = await copyText(msg.text);
      flashAction(btn, ok ? "check" : "close");
      toast(ok ? "Copied to clipboard" : "Could not copy");
      break;
    }
    case "edit":
      beginEdit(msg, row, chat);
      break;
    case "regenerate":
      regenerateMessage(msg, chat);
      break;
    case "delete":
      deleteMessage(msg, chat);
      break;
    case "speak":
      toggleSpeech(msg, btn);
      break;
    case "explain":
      explainBack(msg, row);
      break;
    case "stop":
      if (stream) stream.abort();
      break;
    default:
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Conversation flow                                                   */
/* ------------------------------------------------------------------ */

function buildHistory(chat) {
  // Ten messages is enough context for a study answer and keeps each request
  // inside the free tier's tokens-per-minute budget.
  const recent = chat.messages
    .filter((m) => !m.greeting && (m.text.trim() || m.image) && (m.role === "user" || m.role === "bot"))
    .slice(-10);

  const lastUser = [...recent].reverse().find((m) => m.role === "user");
  const notes = lastUser ? study?.contextFor?.(lastUser.text) || "" : "";

  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map((m) => {
      const text =
        notes && m === lastUser
          ? `Reference from my lecture notes (use only if it is relevant):\n${notes}\n\n---\n\n${m.text}`
          : m.text;

      if (m.role === "user" && m.image) {
        return {
          role: "user",
          content: [
            { type: "text", text: text || "Explain this question from my textbook, step by step." },
            { type: "image_url", image_url: { url: m.image } },
          ],
        };
      }
      return { role: m.role === "user" ? "user" : "assistant", content: text };
    }),
  ];
}

function engineSessionFor(chat) {
  const session = createSession();
  if (chat?.engine && typeof chat.engine === "object") {
    return Object.assign(session, {
      name: chat.engine.name ?? null,
      lastTopic: chat.engine.lastTopic ?? null,
      factIndex: chat.engine.factIndex ?? 0,
      turn: chat.engine.turn ?? 0,
      lastUserText: "",
    });
  }
  return session;
}

async function submitUser(text, image = "") {
  const typed = String(text || "").trim();
  const clean = typed || (image ? "Explain this question from my textbook, step by step." : "");
  if (!clean) return;
  if (busy) {
    toast("Stop the current reply first");
    return;
  }

  const chat = store.ensureActive();
  if (!chat.messages.length) store.addMessage(chat.id, greetingMessage());

  const userMsg = store.addMessage(chat.id, {
    id: nextId(),
    role: "user",
    text: clean,
    ts: Date.now(),
    image: image || "",
  });
  store.autoTitle(chat.id, clean);

  els.input.value = "";
  clearAttachment();
  resizeInput();
  updateCounter();
  pulseSend();
  closePromptQuick();

  if (store.activeId === chat.id) {
    appendRow(userMsg, chat);
    renderChatList();
  }

  await generateReply(chat.id);
  if (store.activeId === chat.id) els.input.focus();
}

async function generateReply(chatId) {
  const chat = store.get(chatId);
  if (!chat) return;
  const pick = modelForChat(chat);
  if (pick.ready) return askModel(chatId);
  return askEngine(chatId);
}

function askEngine(chatId) {
  return new Promise((resolve) => {
    const chat = store.get(chatId);
    const lastUser = [...(chat?.messages || [])].reverse().find((m) => m.role === "user");
    if (!chat || !lastUser) {
      resolve();
      return;
    }

    setBusy(true);
    streamChatId = chatId;
    const typing = showTyping();
    const delay = Math.min(420 + lastUser.text.length * 9, 1150);

    window.setTimeout(() => {
      typing?.remove();
      if (store.activeId === chatId) {
        document.getElementById("typing-indicator")?.remove();
      }

      let reply;
      const session = engineSessionFor(chat);
      try {
        reply = respond(lastUser.text, session);
      } catch (err) {
        console.error(err);
        reply = {
          text: "Something went wrong while composing that reply. Try rephrasing, or start a new chat.",
          chips: ["What can you do?"],
        };
      }

      store.setEngine(chatId, {
        name: session.name,
        lastTopic: session.lastTopic,
        factIndex: session.factIndex,
        turn: session.turn,
      });

      const saved = store.addMessage(chatId, {
        id: nextId(),
        role: "bot",
        text: reply.text,
        chips: reply.chips || [],
        ts: Date.now(),
        via: "engine",
      });

      if (store.activeId === chatId) {
        appendRow(saved, store.get(chatId));
        renderChatList();
      }
      study?.logAnswer?.();

      streamChatId = "";
      setBusy(false);
      resolve();
    }, delay);
  });
}

async function askModel(chatId) {
  const chat = store.get(chatId);
  if (!chat) return;
  const pick = modelForChat(chat);
  if (!pick.ready) return askEngine(chatId);

  stream = new AbortController();
  streamChatId = chatId;
  const controller = stream;
  const token = ++activeToken;
  setBusy(true);

  const typing = store.activeId === chatId ? showTyping("Nova is thinking") : null;

  let bot = {
    id: nextId(),
    role: "bot",
    text: "",
    chips: [],
    ts: Date.now(),
    via: "ai",
    model: pick.model,
    provider: pick.provider,
  };
  let row = null;
  let frame = 0;
  let queued = "";
  let persisted = false;
  let lastSave = 0;

  const paint = () => {
    frame = 0;
    if (!row || !row.isConnected) return;
    const content = row.querySelector(".bubble-content");
    if (content) content.innerHTML = renderMarkdown(queued, { streaming: true });
    scrollToBottom(false);
  };

  const ensureRow = () => {
    if (row || store.activeId !== chatId) return;
    typing?.remove();
    row = appendRow(bot, chat);
    row.classList.add("is-streaming");
    addStreamStatus(row);
    scrollToBottom();
  };

  try {
    const finalText = await streamChat({
      provider: pick.provider,
      baseUrl: pick.baseUrl,
      key: pick.key,
      model: pick.model,
      messages: buildHistory(chat),
      steps: study?.showSteps?.() || false,
      signal: controller.signal,
      onDelta: (full) => {
        queued = full;
        if (!persisted) {
          persisted = true;
          const saved = store.addMessage(chatId, { ...bot, text: full });
          if (saved) bot = saved;
        }
        ensureRow();
        if (!frame) frame = requestAnimationFrame(paint);
        const now = Date.now();
        if (now - lastSave > 700) {
          lastSave = now;
          store.updateMessage(chatId, bot.id, { text: full });
        }
      },
    });

    typing?.remove();
    if (frame) cancelAnimationFrame(frame);

    if (!persisted) {
      const saved = store.addMessage(chatId, { ...bot, text: "" });
      if (saved) bot = saved;
      ensureRow();
    }

    finishAi(chatId, bot, row, (finalText || "").trim());
  } catch (err) {
    typing?.remove();
    if (frame) cancelAnimationFrame(frame);

    if (err?.name === "AbortError") {
      if (bot.text.trim()) finishAi(chatId, bot, row, bot.text.trim());
      else cleanupEmpty(bot, row, chatId);
      return;
    }

    const failure = err instanceof AiError ? err : null;
    const message = failure?.message || "Something went wrong while contacting the model.";
    // A half-written answer keeps its text, so the way out goes in the note.
    const note =
      failure?.code === "quota_day"
        ? `${message} Switch to another free model, or keep going with the built-in engine.`
        : message;

    if (bot.text.trim()) {
      finishAi(chatId, bot, row, bot.text.trim(), note);
    } else {
      cleanupEmpty(bot, row, chatId);
      if (store.activeId === chatId && token === activeToken) showAiError(chatId, failure || message);
    }
  } finally {
    if (stream === controller) stream = null;
    if (streamChatId === chatId) streamChatId = "";
    setBusy(false);
  }
}

function cleanupEmpty(bot, row, chatId) {
  const chat = store.get(chatId);
  if (chat?.messages.some((m) => m.id === bot.id)) store.removeMessage(chatId, bot.id);
  row?.remove();
  if (store.activeId === chatId) renderChatList();
}

function finishAi(chatId, bot, row, text, error = "") {
  const chat = store.get(chatId);
  if (!chat) return;

  bot.text = text || "_(The model returned an empty reply.)_";
  bot.chips = error ? [] : AI_FOLLOW_UPS;
  bot.error = error;
  store.updateMessage(chatId, bot.id, { text: bot.text, chips: bot.chips, error });

  if (store.activeId === chatId) {
    const fresh = buildMessageEl(bot, chat);
    if (row && row.isConnected) row.replaceWith(fresh);
    else els.messages.appendChild(fresh);
    scrollToBottom();
    refreshScrollButton();
  }
  if (!error) study?.logAnswer?.();
  renderChatList();
}

function showAiError(chatId, failure) {
  const err = failure instanceof Error ? failure : null;
  const message = err?.message || String(failure || "Something went wrong while contacting the model.");
  const quotaDay = err?.code === "quota_day";

  const row = document.createElement("div");
  row.className = "msg msg-bot msg-error";

  const avatar = document.createElement("div");
  avatar.className = "avatar avatar-bot";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "N";

  const wrap = document.createElement("div");
  wrap.className = "msg-bubble-wrap";

  const box = document.createElement("div");
  box.className = "ai-error";
  const title = document.createElement("strong");
  title.textContent = quotaDay ? "Free tier ended for today" : "Couldn't get an answer";
  const para = document.createElement("p");
  para.textContent = message;
  box.append(title, para);

  if (quotaDay) {
    const help = document.createElement("ul");
    help.className = "ai-error-help";
    for (const line of FREE_TIER_STEPS) {
      const item = document.createElement("li");
      item.textContent = line;
      help.appendChild(item);
    }
    box.appendChild(help);
  }

  const actions = document.createElement("div");
  actions.className = "chips";

  const action = (label, run) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (busy) return;
      row.remove();
      // Let this click finish bubbling: opening the model popover here would
      // otherwise be closed at once by the document-level outside click.
      setTimeout(run, 0);
    });
    actions.appendChild(btn);
  };

  if (quotaDay) {
    action("Switch free model", () => openModelPopover());
  } else {
    action("Try again", () => generateReply(chatId));
  }
  action("Use built-in answer", () => askEngine(chatId));
  action("AI settings", () => openSettings());

  wrap.append(box, actions);
  row.append(avatar, wrap);
  els.messages.appendChild(row);
  scrollToBottom();
  toast(
    quotaDay
      ? "Free tier ended for today — pick an option to keep going"
      : "Reply failed — see the options below"
  );
}

/* ------------------------------------------------------------------ */
/* Read aloud                                                          */
/* ------------------------------------------------------------------ */

function speechSupported() {
  return "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

function setSpeaking(btn) {
  if (speakingBtn) {
    speakingBtn.classList.remove("is-speaking");
    speakingBtn.title = "Read aloud";
  }
  speakingBtn = btn || null;
  if (speakingBtn) {
    speakingBtn.classList.add("is-speaking");
    speakingBtn.title = "Stop reading";
  }
}

function stopSpeech() {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  setSpeaking(null);
}

function toggleSpeech(msg, btn) {
  if (!speechSupported()) return;
  if (speakingBtn === btn) {
    stopSpeech();
    return;
  }

  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(plainText(msg.text));
  utter.rate = 1.02;
  utter.onend = () => setSpeaking(null);
  utter.onerror = () => setSpeaking(null);
  setSpeaking(btn);
  window.speechSynthesis.speak(utter);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function exportChat() {
  const chat = store.active;
  if (!chat) return;
  const stamp = new Date();
  const lines = [`# ${chat.title}`, "", `_${stamp.toLocaleString()}_`, ""];

  for (const m of chat.messages) {
    const text = String(m.text || "").trim();
    if (!text) continue;
    const who =
      m.role === "user"
        ? "You"
        : m.via === "ai" && m.model
          ? `Nova (${m.model})`
          : "Nova";
    lines.push(`### ${who}`, "", text, "");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const safe = chat.title.replace(/[^\w\s-]/g, "").trim().slice(0, 40) || "chat";
  link.download = `nova-${safe.replace(/\s+/g, "-").toLowerCase()}-${stamp.toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);

  els.exportBtn.classList.add("is-done");
  els.exportBtn.title = "Saved to your downloads";
  window.setTimeout(() => {
    els.exportBtn.classList.remove("is-done");
    els.exportBtn.title = "Export conversation as Markdown";
  }, 1600);
  toast("Conversation exported");
}

/* ------------------------------------------------------------------ */
/* Study bridge: model calls for tools, explain-it-back                */
/* ------------------------------------------------------------------ */

async function askStudy(prompt, { maxTokens = 1400 } = {}) {
  const pick = modelForChat(store.active);
  if (!pick.ready) {
    throw new Error("Connect a model in AI settings first — this tool needs a live model.");
  }
  return streamChat({
    provider: pick.provider,
    baseUrl: pick.baseUrl,
    key: pick.key,
    model: pick.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    maxTokens,
    steps: study?.showSteps?.() || false,
  });
}

function currentChatText() {
  const chat = store.active;
  if (!chat) return { title: "New chat", text: "" };
  const text = chat.messages
    .filter((m) => !m.greeting && m.text.trim())
    .map((m) => `${m.role === "user" ? "Student" : "Nova"}: ${m.text}`)
    .join("\n\n");
  return { title: chat.title, text };
}

async function explainBack(msg, row) {
  const existing = row.querySelector(".explain-box");
  if (existing) {
    existing.remove();
    return;
  }
  const wrap = row.querySelector(".msg-bubble-wrap");
  if (!wrap) return;

  const box = document.createElement("div");
  box.className = "explain-box";
  box.innerHTML = `
    <p class="explain-title">Explain it back</p>
    <p class="explain-sub">Write the idea in your own words — Nova shows what is right, what is missing, and one question to try next.</p>
    <textarea rows="4" aria-label="Your explanation" placeholder="In my own words…"></textarea>
    <div class="explain-actions">
      <button class="primary-btn" type="button" data-explain="check">Check my explanation</button>
    </div>
    <div class="explain-result" hidden></div>`;

  const area = box.querySelector("textarea");
  const button = box.querySelector("[data-explain]");
  const result = box.querySelector(".explain-result");
  wrap.appendChild(box);
  area.focus();

  button.addEventListener("click", async () => {
    const answer = area.value.trim();
    if (answer.length < 15) {
      toast("Write a little more — at least a full sentence.");
      area.focus();
      return;
    }
    button.disabled = true;
    result.hidden = false;
    result.textContent = "Checking…";
    try {
      const feedback = await askStudy(
        [
          "The student was given this explanation:",
          msg.text,
          "",
          "They explained it back in their own words:",
          answer,
          "",
          "Mark it as a patient tutor: what is correct, what is missing or wrong, one correction, and one follow-up question. Be encouraging. Under 180 words.",
        ].join("\n"),
        { maxTokens: 700 }
      );
      result.innerHTML = renderMarkdown(feedback);
      study?.logAnswer?.();
    } catch (err) {
      result.textContent = err?.message || "Could not check that explanation.";
    } finally {
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Subject tags, dictation, photos                                     */
/* ------------------------------------------------------------------ */

function buildTagOptions() {
  if (!els.tagSelect) return;
  els.tagSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No subject";
  els.tagSelect.appendChild(none);
  for (const subject of SUBJECTS) {
    const option = document.createElement("option");
    option.value = subject;
    option.textContent = subject;
    els.tagSelect.appendChild(option);
  }
  els.tagSelect.addEventListener("change", () => {
    const chat = store.active;
    if (!chat) return;
    store.setTag(chat.id, els.tagSelect.value);
    renderChatList();
    toast(els.tagSelect.value ? `Tagged “${els.tagSelect.value}”` : "Subject tag removed");
  });
}

function initDictation() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition || !els.micBtn) return;
  els.micBtn.hidden = false;

  els.micBtn.addEventListener("click", () => {
    if (listening) {
      listening.stop();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const said = Array.from(event.results)
        .map((entry) => entry[0]?.transcript || "")
        .join(" ")
        .trim();
      if (!said) return;
      const at = els.input.selectionStart ?? els.input.value.length;
      const before = els.input.value.slice(0, at);
      const after = els.input.value.slice(at);
      const spacer = before && !/\s$/.test(before) ? " " : "";
      els.input.value = `${before}${spacer}${said}${after}`.slice(0, MAX_INPUT);
      resizeInput();
      updateCounter();
      els.input.focus();
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") {
        toast("Dictation stopped — check the microphone permission");
      }
    };
    recognition.onend = () => {
      listening = null;
      els.micBtn.classList.remove("is-listening");
      els.micBtn.setAttribute("aria-pressed", "false");
    };

    listening = recognition;
    els.micBtn.classList.add("is-listening");
    els.micBtn.setAttribute("aria-pressed", "true");
    try {
      recognition.start();
    } catch {
      listening = null;
      els.micBtn.classList.remove("is-listening");
    }
  });
}

function clearAttachment() {
  pendingImage = "";
  if (els.attachPreview) els.attachPreview.hidden = true;
  if (els.attachImg) els.attachImg.removeAttribute("src");
  if (els.imageFile) els.imageFile.value = "";
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be opened."));
    image.src = src;
  });
}

// One stored photo should stay well under 140 KB of base64. Photos are held
// inline in the chat blob, so this is what keeps several uploads from filling
// the browser's storage quota.
const PHOTO_TARGET_CHARS = 140_000;
const PHOTO_MAX_CHARS = 400_000;

async function shrinkPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
  const image = await loadImageElement(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  let smallest = "";
  // Try large-and-clean first, then step down until the photo fits.
  for (const maxSide of [1100, 900, 720, 560, 440]) {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.72, 0.62, 0.52, 0.42]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (!smallest || data.length < smallest.length) smallest = data;
      if (data.length <= PHOTO_TARGET_CHARS) return data;
    }
  }
  return smallest || dataUrl;
}

function initPhoto() {
  if (!els.imageBtn || !els.imageFile) return;
  els.imageBtn.addEventListener("click", () => els.imageFile.click());
  els.imageFile.addEventListener("change", async () => {
    const file = els.imageFile.files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast("That photo is too large (12 MB maximum)");
      clearAttachment();
      return;
    }
    try {
      const data = await shrinkPhoto(file);
      if (!data.startsWith("data:image/")) throw new Error("Choose an image file.");
      if (data.length > PHOTO_MAX_CHARS) {
        throw new Error("That photo is too detailed to store safely — try a screenshot or a smaller image.");
      }
      pendingImage = data;
      if (els.attachImg) els.attachImg.src = data;
      if (els.attachPreview) els.attachPreview.hidden = false;
      if (els.attachInfo) els.attachInfo.textContent = "Sent to a vision model with your message";
      els.input.focus();
      toast("Photo attached");
    } catch (err) {
      clearAttachment();
      toast(err?.message || "Could not attach that photo");
    }
  });
  els.attachRemove?.addEventListener("click", clearAttachment);
}

function openStudy(tab = "deck") {
  if (!study) {
    toast("Study tools are still loading");
    return;
  }
  closeModelPopover();
  closePromptQuick();
  study.open(tab);
}

els.studyBtn?.addEventListener("click", () => openStudy("deck"));
els.studyHeadBtn?.addEventListener("click", () => openStudy("deck"));
els.stepsCheck?.addEventListener("change", () => {
  study?.setShowSteps(els.stepsCheck.checked);
  toast(els.stepsCheck.checked ? "Showing every step" : "Step-by-step off");
});

/* ------------------------------------------------------------------ */
/* Confirm dialog + toast helpers                                      */
/* ------------------------------------------------------------------ */

function confirmAction({ title, message, confirmLabel = "Delete" }) {
  if (!els.confirmDialog) return Promise.resolve(false);
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = message;
  els.confirmOk.textContent = confirmLabel;
  els.confirmDialog.returnValue = "";

  return new Promise((resolve) => {
    confirmResolver = resolve;
    els.confirmDialog.showModal();
  });
}

els.confirmCancel.addEventListener("click", () => {
  els.confirmDialog.returnValue = "cancel";
  els.confirmDialog.close();
});

els.confirmOk.addEventListener("click", () => {
  els.confirmDialog.returnValue = "ok";
  els.confirmDialog.close();
});

els.confirmDialog.addEventListener("close", () => {
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(els.confirmDialog.returnValue === "ok");
});

/* ------------------------------------------------------------------ */
/* Prompt library                                                      */
/* ------------------------------------------------------------------ */

function categoryChips(container, active, onPick) {
  container.innerHTML = "";
  const values = ["All", ...CATEGORIES];
  for (const value of values) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-chip";
    btn.textContent = value;
    btn.setAttribute("aria-pressed", String(value === active));
    if (value === active) btn.classList.add("is-active");
    btn.addEventListener("click", () => onPick(value));
    container.appendChild(btn);
  }
}

function renderPromptQuick() {
  const query = els.promptQuickSearch.value.trim();
  let items = promptStore.filter({ query, category: quickCategory });

  if (!query && quickCategory === "All") {
    const recent = promptStore.recentItems();
    if (recent.length) {
      items = [...recent, ...items.filter((p) => !recent.some((r) => r.id === p.id))];
    }
  }

  els.promptQuickList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "pq-empty";
    empty.textContent = "No prompts match. Try another category or open the library.";
    els.promptQuickList.appendChild(empty);
    return;
  }

  for (const prompt of items.slice(0, 30)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pq-item";
    btn.innerHTML = `
      <span class="pq-item-top">
        <span class="pq-item-title"></span>
        <span class="cat-badge"></span>
      </span>
      <span class="pq-item-desc"></span>`;
    btn.querySelector(".pq-item-title").textContent = prompt.title;
    btn.querySelector(".cat-badge").textContent = prompt.category;
    btn.querySelector(".pq-item-desc").textContent = prompt.description || "";
    btn.title = prompt.body;
    btn.addEventListener("click", () => {
      promptStore.touch(prompt.id);
      insertPrompt(prompt.body);
      toast(`Inserted “${prompt.title}”`);
    });
    els.promptQuickList.appendChild(btn);
  }
}

function openPromptQuick() {
  if (!els.promptQuick.hidden) {
    closePromptQuick();
    return;
  }
  closeModelPopover();
  els.promptQuick.hidden = false;
  els.promptBtn.setAttribute("aria-expanded", "true");
  quickCategory = "All";
  els.promptQuickSearch.value = "";
  const pick = (value) => {
    quickCategory = value;
    categoryChips(els.promptQuickCats, quickCategory, pick);
    renderPromptQuick();
  };
  categoryChips(els.promptQuickCats, quickCategory, pick);
  renderPromptQuick();
  els.promptQuickSearch.focus();
}

function closePromptQuick() {
  if (!els.promptQuick) return;
  els.promptQuick.hidden = true;
  els.promptBtn.setAttribute("aria-expanded", "false");
}

function insertPrompt(body) {
  const input = els.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const spacer = before && !/\s$/.test(before) ? " " : "";
  const inserted = `${before}${spacer}${body}${after}`.slice(0, MAX_INPUT);
  input.value = inserted;
  const caret = Math.min((before + spacer + body).length, MAX_INPUT);
  input.focus();
  input.setSelectionRange(caret, caret);
  resizeInput();
  updateCounter();
  closePromptQuick();
  if (els.promptDialog.open) els.promptDialog.close();
  window.setTimeout(() => els.input.focus(), 40);
}

function renderPromptLibrary() {
  const query = els.promptSearch.value.trim();
  const items = promptStore.filter({ query, category: libraryCategory });

  categoryChips(els.promptCats, libraryCategory, (value) => {
    libraryCategory = value;
    renderPromptLibrary();
  });

  els.promptList.innerHTML = "";
  els.promptEmpty.hidden = items.length > 0;
  if (!items.length) {
    els.promptEmpty.querySelector(".empty-title").textContent = query
      ? "No prompts match"
      : "Nothing in this category";
    els.promptEmpty.querySelector(".empty-text").textContent = query
      ? "Try a different search, or save a new prompt."
      : "Save a prompt you use often.";
  }

  for (const prompt of items) {
    const card = document.createElement("article");
    card.className = "prompt-card";
    card.dataset.id = prompt.id;

    const top = document.createElement("div");
    top.className = "prompt-card-top";

    const badge = document.createElement("span");
    badge.className = "cat-badge";
    badge.textContent = prompt.category;

    const actions = document.createElement("div");
    actions.className = "prompt-card-actions";

    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "mini-btn";
    insert.dataset.action = "insert";
    insert.innerHTML = `${icon("plus")}<span>Insert</span>`;
    insert.title = "Insert into the chat input";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "mini-btn icon-only";
    edit.dataset.action = "edit";
    edit.title = "Edit prompt";
    edit.setAttribute("aria-label", `Edit ${prompt.title}`);
    edit.innerHTML = icon("pencil");

    const del = document.createElement("button");
    del.type = "button";
    del.className = "mini-btn icon-only";
    del.dataset.action = "delete";
    del.title = "Delete prompt";
    del.setAttribute("aria-label", `Delete ${prompt.title}`);
    del.innerHTML = icon("trash");

    actions.append(insert, edit, del);

    const title = document.createElement("h3");
    title.className = "prompt-card-title";
    title.textContent = prompt.title;

    const desc = document.createElement("p");
    desc.className = "prompt-card-desc";
    desc.textContent = prompt.description || "No description";

    const preview = document.createElement("p");
    preview.className = "prompt-card-body";
    preview.textContent = prompt.body;

    top.append(badge, actions);
    card.append(top, title, desc, preview);
    els.promptList.appendChild(card);
  }

  els.promptCount.textContent = `${promptStore.list().length} prompts saved`;
}

function openPromptLibrary() {
  closePromptQuick();
  closeModelPopover();
  showPromptLibraryView();
  renderPromptLibrary();
  els.promptDialog.showModal();
  setTimeout(() => els.promptSearch.focus(), 60);
}

function showPromptLibraryView() {
  els.promptEditorView.hidden = true;
  els.promptLibraryView.hidden = false;
  els.promptError.textContent = "";
}

function showPromptEditor(prompt) {
  editingPromptId = prompt?.id || null;
  els.promptEditorTitle.textContent = prompt ? "Edit prompt" : "New prompt";
  els.promptTitle.value = prompt?.title || "";
  els.promptDescription.value = prompt?.description || "";
  els.promptBody.value = prompt?.body || "";
  els.promptCategory.innerHTML = "";
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    els.promptCategory.appendChild(option);
  }
  const defaultCategory = libraryCategory === "All" ? "Productivity" : libraryCategory;
  els.promptCategory.value = prompt?.category || defaultCategory;
  els.promptError.textContent = "";

  els.promptLibraryView.hidden = true;
  els.promptEditorView.hidden = false;
  els.promptTitle.focus();
}

function savePromptEditor() {
  const title = els.promptTitle.value.trim();
  const body = els.promptBody.value.trim();
  const category = els.promptCategory.value;
  const description = els.promptDescription.value.trim();

  if (!title) {
    els.promptError.textContent = "Give the prompt a title.";
    els.promptTitle.focus();
    return;
  }
  if (!body) {
    els.promptError.textContent = "Write the prompt text.";
    els.promptBody.focus();
    return;
  }

  if (editingPromptId) promptStore.update(editingPromptId, { title, body, category, description });
  else promptStore.add({ title, body, category, description });

  showPromptLibraryView();
  renderPromptLibrary();
  renderPromptQuick();
  toast(editingPromptId ? "Prompt updated" : "Prompt saved");
  editingPromptId = null;
}

els.promptList.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const card = btn.closest(".prompt-card");
  const prompt = promptStore.get(card?.dataset.id);
  if (!prompt) return;

  if (btn.dataset.action === "insert") {
    promptStore.touch(prompt.id);
    insertPrompt(prompt.body);
    toast(`Inserted “${prompt.title}”`);
    return;
  }
  if (btn.dataset.action === "edit") {
    showPromptEditor(prompt);
    return;
  }
  if (btn.dataset.action === "delete") {
    const ok = await confirmAction({
      title: "Delete prompt?",
      message: `“${prompt.title}” will be removed from your library.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    promptStore.remove(prompt.id);
    renderPromptLibrary();
    renderPromptQuick();
    toast("Prompt deleted");
  }
});

els.promptCancel.addEventListener("click", showPromptLibraryView);
els.promptBack.addEventListener("click", showPromptLibraryView);
els.promptSave.addEventListener("click", savePromptEditor);
els.promptNew.addEventListener("click", () => showPromptEditor(null));
els.promptClose.addEventListener("click", () => els.promptDialog.close());
els.promptSearch.addEventListener("input", renderPromptLibrary);

els.promptReset.addEventListener("click", async () => {
  const ok = await confirmAction({
    title: "Restore default prompts?",
    message: "The built-in prompts are added back. Your own prompts are kept.",
    confirmLabel: "Restore",
  });
  if (!ok) return;
  promptStore.resetDefaults();
  renderPromptLibrary();
  renderPromptQuick();
  toast("Default prompts restored");
});

/* ------------------------------------------------------------------ */
/* Model selector                                                      */
/* ------------------------------------------------------------------ */

function modelRow(model, current) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "model-row";
  row.dataset.id = model.id;
  row.dataset.provider = model.provider || modelPickProvider;
  // modelForChat() describes the current pick as { provider, model }.
  const currentId = current?.model || current?.id;
  if (current && currentId === model.id && current.provider === (model.provider || modelPickProvider)) {
    row.classList.add("is-current");
  }
  row.title = model.id;

  const main = document.createElement("span");
  main.className = "model-row-main";

  const name = document.createElement("span");
  name.className = "model-row-name";
  name.textContent = splitModelName(model.name || model.id, model.id).label;

  const info = document.createElement("span");
  info.className = "model-row-info";
  const vendor = modelVendor(model.provider || modelPickProvider, model.id);
  const bits = [vendor];
  if (model.context) bits.push(`${Math.round(model.context / 1000)}k context`);
  if (model.free) bits.push("free");
  info.textContent = bits.join(" · ");

  main.append(name, info);

  const star = document.createElement("button");
  star.type = "button";
  star.className = "fav-btn";
  star.dataset.fav = "1";
  star.title = store.isFavorite(model) ? "Remove from favourites" : "Add to favourites";
  star.setAttribute("aria-label", star.title);
  star.setAttribute("aria-pressed", String(store.isFavorite(model)));
  star.innerHTML = icon("star");
  if (store.isFavorite(model)) star.classList.add("is-fav");

  row.append(main, star);
  return row;
}

/** Free models first, then the order that suits free-tier users best. */
function sortModelsForFree(provider, list) {
  if (provider !== "gemini") return list;
  const rank = new Map(GEMINI_MODELS.map((model, index) => [model.id, index]));
  const position = (model) => (rank.has(model.id) ? rank.get(model.id) : 99);
  return [...list].sort((a, b) => {
    const free = Number(Boolean(b.free)) - Number(Boolean(a.free));
    if (free) return free;
    if (position(a) !== position(b)) return position(a) - position(b);
    return String(a.id).localeCompare(String(b.id));
  });
}

function renderModelPopover() {
  const chat = store.active;
  const currentPick = modelForChat(chat);
  const provider = modelPickProvider;
  const conf = providerInfo(provider);

  // provider tabs when more than one provider is usable
  const usable = ["gemini", "custom"].filter(
    (id) => id !== "custom" || providerHasKey(ai, "custom")
  );
  els.modelTabs.hidden = usable.length < 2;
  els.modelTabs.innerHTML = "";
  if (usable.length > 1) {
    for (const id of usable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "provider-tab";
      btn.textContent = providerInfo(id).label;
      btn.setAttribute("aria-selected", String(id === provider));
      btn.classList.toggle("is-active", id === provider);
      btn.addEventListener("click", () => {
        modelPickProvider = id;
        ensureModels(id);
        renderModelPopover();
      });
      els.modelTabs.appendChild(btn);
    }
  }

  const hasKey = providerHasKey(ai, provider);
  els.modelHint.hidden = hasKey;
  els.modelHint.textContent = hasKey
    ? ""
    : `No ${conf.label} key yet — Nova answers with its built-in engine until you connect one.`;

  const models = sortModelsForFree(provider, providerModels(provider));
  const query = els.modelSearch.value.trim().toLowerCase();
  const filtered = query
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(query) ||
          (m.name || "").toLowerCase().includes(query) ||
          modelVendor(provider, m.id).toLowerCase().includes(query)
      )
    : models;

  // favourites
  const favourites = store.favorites(provider);
  els.modelFavorites.hidden = favourites.length === 0;
  els.modelFavorites.innerHTML = "";
  if (favourites.length) {
    const label = document.createElement("p");
    label.className = "pop-section";
    label.textContent = "Favourites";
    els.modelFavorites.appendChild(label);
    const list = document.createElement("div");
    list.className = "model-list";
    for (const fav of favourites) {
      list.appendChild(modelRow({ ...fav, provider }, currentPick));
    }
    els.modelFavorites.appendChild(list);
  }

  els.modelList.innerHTML = "";
  if (!query) {
    const label = document.createElement("p");
    label.className = "pop-section";
    label.textContent = favourites.length ? "All models" : "Models";
    els.modelList.appendChild(label);
  }

  const capped = filtered.slice(0, 80);
  const wrapping = document.createElement("div");
  wrapping.className = "model-list";
  for (const model of capped) wrapping.appendChild(modelRow(model, currentPick));
  els.modelList.appendChild(wrapping);

  // A failed model list already explains itself in the counter; do not also
  // claim that the search matched nothing.
  els.modelEmpty.hidden = filtered.length > 0 || Boolean(modelErrors[provider]);
  els.modelLoading.hidden = modelLoading !== provider;
  const freeCount = models.filter((model) => model.free).length;
  els.modelCount.textContent = modelErrors[provider]
    ? modelErrors[provider]
    : models.length
      ? provider === "gemini" && freeCount
        ? `${freeCount} free models · best first`
        : `${models.length} models`
      : "";

  els.modelPopover.querySelectorAll(".model-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest('[data-fav="1"]')) return;
      chooseModel({
        id: row.dataset.id,
        provider: row.dataset.provider,
        name: row.querySelector(".model-row-name")?.textContent || row.dataset.id,
      });
    });
  });

  els.modelPopover.querySelectorAll(".fav-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = btn.closest(".model-row");
      const model = { id: row.dataset.id, provider: row.dataset.provider, name: row.querySelector(".model-row-name")?.textContent || row.dataset.id };
      const added = store.toggleFavorite(findModel(model.provider, model.id) || model);
      btn.classList.toggle("is-fav", added);
      btn.setAttribute("aria-pressed", String(added));
      btn.title = added ? "Remove from favourites" : "Add to favourites";
      renderModelPopover();
      toast(added ? "Added to favourites" : "Removed from favourites");
    });
  });
}

function openModelPopover() {
  if (!els.modelPopover.hidden) {
    closeModelPopover();
    return;
  }
  closePromptQuick();
  const pick = modelForChat(store.active);
  modelPickProvider = pick.provider;
  els.modelSearch.value = "";
  els.modelPopover.hidden = false;
  els.modelBtn.setAttribute("aria-expanded", "true");
  renderModelPopover();
  ensureModels(pick.provider);
  setTimeout(() => els.modelSearch.focus(), 40);
}

function closeModelPopover() {
  if (!els.modelPopover || els.modelPopover.hidden) return;
  els.modelPopover.hidden = true;
  els.modelBtn.setAttribute("aria-expanded", "false");
}

function ensureModels(provider) {
  if (modelCache[provider] || modelLoading === provider) return;
  if (provider === "custom" && !ai.providers?.custom?.baseUrl) {
    modelErrors[provider] = "Set a base URL in AI settings to load models.";
    return;
  }
  // Without a key there is nothing to ask Google for; the static list shows.
  if (provider === "gemini" && !providerHasKey(ai, "gemini")) return;

  modelLoading = provider;
  renderModelPopover();

  fetchModels({
    provider,
    key: ai.providers?.[provider]?.key || "",
    baseUrl: ai.providers?.[provider]?.baseUrl || "",
  })
    .then((models) => {
      modelCache[provider] = models;
      delete modelErrors[provider];
      populateModelDatalist(provider);
    })
    .catch((err) => {
      modelCache[provider] = staticModels(provider).slice();
      modelErrors[provider] = err instanceof AiError ? err.message : "Could not load models.";
    })
    .finally(() => {
      modelLoading = null;
      renderModelPopover();
    });
}

function populateModelDatalist(provider) {
  if (els.dialogProvider.value !== provider) return;
  const models = providerModels(provider);
  els.modelDatalist.innerHTML = "";
  for (const model of models.slice(0, 300)) {
    const option = document.createElement("option");
    option.value = model.id;
    option.label = `${model.name}${model.free ? " · free" : ""}`;
    els.modelDatalist.appendChild(option);
  }
}

function chooseModel(model) {
  const chat = store.ensureActive();
  store.setModel(chat.id, model.id, model.provider);
  // When the provider changes, its model must change with it: a Gemini model
  // id sent to a custom endpoint (or the reverse) is never valid.
  if (ai.provider !== model.provider) {
    ai = { ...ai, provider: model.provider, model: model.id };
    try {
      ai = saveSettings(ai);
    } catch {
      /* keep the per-chat choice even if global defaults cannot be saved */
    }
  }
  updateHeader();
  closeModelPopover();
  toast(`Model set to ${modelLabel(model.provider, model.id)} for this chat`);
}

/* ------------------------------------------------------------------ */
/* AI settings                                                         */
/* ------------------------------------------------------------------ */

function setDialogStatus(text, tone = "") {
  els.dialogStatus.textContent = text;
  els.dialogStatus.className = `ai-status${tone ? ` ${tone}` : ""}`;
}

function hydrateSettingsFields(provider) {
  const conf = providerInfo(provider);
  const saved = ai.providers?.[provider] || {};
  const chat = store.active;
  const chatModel = chat?.provider === provider ? chat.model : "";

  const managed = serverHasProvider(provider);

  els.dialogProvider.value = provider;
  els.keyInput.value = saved.key || "";
  els.baseInput.value = provider === "custom" ? saved.baseUrl || "" : "";
  els.baseField.hidden = provider !== "custom";
  els.keyField.hidden = managed;
  els.help.hidden = provider !== "gemini";
  els.keyLabel.textContent =
    provider === "custom" ? "API key" : `${conf.label} API key`;
  els.keyInput.placeholder = conf.keyHint || "your API key";
  els.remove.hidden = managed && !saved.key;

  if (provider === "gemini") {
    els.keyHint.innerHTML = managed
      ? "This site's server already holds a Gemini key — nothing to paste. Add your own key to use your own free quota."
      : 'Free, no credit card. Create one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>. It is saved only in this browser and sent only to Google.';
    els.modelInput.placeholder = PROVIDERS.gemini.defaultModel;
    els.modelHintSettings.textContent =
      "The free tier allows a limited number of requests per minute. 3.5 Flash-Lite is the fastest; 4 Hydrogen is the strongest free model.";
  } else if (provider === "custom") {
    els.keyHint.innerHTML =
      "Sent to your endpoint as a <code>Bearer</code> token. Stored only in this browser.";
    els.modelInput.placeholder = "e.g. llama-3.3-70b";
    els.modelHintSettings.textContent =
      "Use the exact model ID your endpoint expects, or load the list from its /models route.";
  }

  const preferred =
    chatModel || (provider === ai.provider ? ai.model : store.getLastModel(provider)) || conf.defaultModel;
  els.modelInput.value = preferred || "";

  els.keyInput.type = "password";
  els.reveal.textContent = "Show";
  els.reveal.setAttribute("aria-pressed", "false");
  els.dialogStatus.textContent = saved.key
    ? `Saved key ${maskKey(saved.key)}`
    : managed
      ? `Connected with this site's ${conf.label} key.`
      : "";
  els.dialogStatus.className = "ai-status";
  if (els.stepsCheck) els.stepsCheck.checked = study?.showSteps?.() || false;

  renderQuickPicks(provider);
  populateModelDatalist(provider);
  populateModelSelect(provider, els.modelInput.value);
}

const OTHER_MODEL = "__other__";

/**
 * Gemini models come from a dropdown; every other provider keeps the free-text
 * field and its quick picks. The text input stays the value that is saved.
 */
function populateModelSelect(provider, current) {
  if (!els.modelSelect) return;
  const isGemini = provider === "gemini";
  els.modelSelect.hidden = !isGemini;
  if (!isGemini) {
    els.modelInput.hidden = false;
    return;
  }

  const models = sortModelsForFree("gemini", providerModels("gemini"));
  const ids = new Set(models.map((model) => model.id));
  els.modelSelect.innerHTML = "";

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${splitModelName(model.name || model.id, model.id).label}${model.free ? " · free" : ""}`;
    els.modelSelect.appendChild(option);
  }

  const other = document.createElement("option");
  other.value = OTHER_MODEL;
  other.textContent = "Other model ID…";
  els.modelSelect.appendChild(other);

  if (current && !ids.has(current)) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = current;
    els.modelSelect.insertBefore(option, other);
  }

  els.modelSelect.value = current || PROVIDERS.gemini.defaultModel;
  els.modelInput.hidden = true;
}

els.modelSelect?.addEventListener("change", () => {
  const value = els.modelSelect.value;
  if (value === OTHER_MODEL) {
    els.modelInput.hidden = false;
    els.modelInput.value = "";
    els.modelInput.focus();
    return;
  }
  els.modelInput.value = value;
  els.modelInput.hidden = true;
});

function renderQuickPicks(provider) {
  const models = providerModels(provider);
  const picks = models;
  els.modelQuick.hidden = provider === "gemini";
  els.modelQuick.innerHTML = "";

  for (const model of picks.slice(0, 5)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-pick";
    btn.dataset.model = model.id;
    btn.textContent = splitModelName(model.name || model.id, model.id).label;
    btn.title = model.id;
    if (els.modelInput.value === model.id) btn.classList.add("is-selected");
    btn.addEventListener("click", () => {
      els.modelInput.value = model.id;
      els.modelQuick.querySelectorAll(".model-pick").forEach((b) => {
        b.classList.toggle("is-selected", b.dataset.model === model.id);
      });
    });
    els.modelQuick.appendChild(btn);
  }
}

function openSettings(provider) {
  const target = provider === "custom" ? provider : ai.provider;
  closeModelPopover();
  closePromptQuick();
  hydrateSettingsFields(target);
  if (!els.dialog.open) els.dialog.showModal();
  ensureModels(target);
  setTimeout(
    () => (ai.providers?.[target]?.key || serverHasProvider(target) ? els.modelInput : els.keyInput).focus(),
    70
  );
}

function closeSettings() {
  els.dialog.close();
}

function validBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

els.dialogProvider.addEventListener("change", () => {
  hydrateSettingsFields(els.dialogProvider.value);
  ensureModels(els.dialogProvider.value);
});

els.reveal.addEventListener("click", () => {
  const show = els.keyInput.type === "password";
  els.keyInput.type = show ? "text" : "password";
  els.reveal.textContent = show ? "Hide" : "Show";
  els.reveal.setAttribute("aria-pressed", String(show));
});

els.modelInput.addEventListener("input", () => {
  const value = els.modelInput.value;
  els.modelQuick.querySelectorAll(".model-pick").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.model === value);
  });
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = els.dialogProvider.value;
  const key = els.keyInput.value.trim();
  const baseUrl = els.baseInput.value.trim();
  const model = els.modelInput.value.trim() || providerInfo(provider).defaultModel;
  const managed = serverHasProvider(provider);

  // A custom endpoint cannot work without its key. Gemini can still store a
  // default model before the key is pasted; the header keeps saying "no key".
  if (!key && !managed && provider === "custom") {
    setDialogStatus("Paste the endpoint's API key first.", "err");
    els.keyInput.focus();
    return;
  }
  if (key && !looksLikeKey(provider, key)) {
    setDialogStatus(
      provider === "gemini"
        ? "That doesn't look like a Google API key — new ones start with AQ., older ones with AIza."
        : "That key looks too short.",
      "err"
    );
    els.keyInput.focus();
    return;
  }
  if (provider === "custom" && !validBaseUrl(baseUrl)) {
    setDialogStatus("Add a base URL such as https://api.example.com/v1.", "err");
    els.baseInput.focus();
    return;
  }

  // A newly pasted key is checked before it is trusted, so a bad paste cannot
  // sit there looking connected until the first message fails.
  if (key && key !== (ai.providers?.[provider]?.key || "")) {
    els.save.disabled = true;
    els.test.disabled = true;
    setDialogStatus(`Checking your key with ${providerInfo(provider).label}…`);
    try {
      await checkKey({ provider, key, baseUrl });
      setDialogStatus("Key accepted.", "ok");
    } catch (err) {
      if (err?.code === "invalid_key") {
        setDialogStatus(err.message, "err");
        els.save.disabled = false;
        els.test.disabled = false;
        els.keyInput.focus();
        return;
      }
      // Offline, or the provider had a hiccup: keep the key and let a reply test it.
      setDialogStatus("Saved without a live check — your first reply will test it.", "warn");
    } finally {
      els.save.disabled = false;
      els.test.disabled = false;
    }
  }

  const next = {
    ...ai,
    provider,
    model,
    providers: {
      ...ai.providers,
      [provider]: {
        ...(key ? { key } : {}),
        ...(provider === "custom" ? { baseUrl } : {}),
      },
    },
  };

  try {
    ai = saveSettings(next);
  } catch (err) {
    setDialogStatus(err.message, "err");
    return;
  }

  // Saving AI settings is an explicit choice of model, so the open
  // conversation follows it as well as the default for new conversations.
  const chat = store.active;
  if (chat) store.setModel(chat.id, model, provider);

  updateHeader();
  renderModelPopover();
  els.dialog.close();

  const connected = Boolean(key || managed);
  toast(
    provider === "gemini"
      ? connected
        ? "Google AI Studio connected — free tier active"
        : "Model saved — add a Gemini key to start chatting"
      : model
        ? `${providerInfo(provider).label} connected`
        : "Endpoint saved — add a model ID to use it"
  );
  els.input.focus();
});

els.test.addEventListener("click", async () => {
  const provider = els.dialogProvider.value;
  const key = els.keyInput.value.trim();
  const baseUrl = els.baseInput.value.trim();
  const managed = serverHasProvider(provider);

  if (!key && !managed) {
    setDialogStatus("Paste a key to test it.", "err");
    return;
  }
  if (provider === "custom" && !validBaseUrl(baseUrl)) {
    setDialogStatus("Add a valid base URL first.", "err");
    return;
  }

  els.test.disabled = true;
  setDialogStatus(
    managed && !key
      ? `Checking this site's ${providerInfo(provider).label} connection…`
      : `Checking key with ${providerInfo(provider).label}…`
  );
  try {
    const info = await checkKey({ provider, key, baseUrl });
    if (info.verified) {
      const bits = ["Key accepted"];
      if (info.limit !== null && info.limit !== undefined) {
        bits.push(`$${Math.max(0, info.limit - (info.usage || 0)).toFixed(2)} credit left`);
      }
      if (info.label) bits.push(info.label);
      setDialogStatus(bits.join(" · "), "ok");
    } else {
      setDialogStatus("Key saved locally — the provider didn't return limit details.", "ok");
    }
  } catch (err) {
    setDialogStatus(err.message, "err");
  } finally {
    els.test.disabled = false;
  }
});

els.remove.addEventListener("click", async () => {
  const provider = els.dialogProvider.value;
  const conf = providerInfo(provider);
  const managed = serverHasProvider(provider);
  const ok = await confirmAction({
    title: `Remove ${conf.label} key?`,
    message: managed
      ? `Messages already in your conversations stay. Nova will use this site's ${conf.label} key instead of the one saved here.`
      : "Messages already in your conversations stay. New replies will use the built-in engine until you connect a key again.",
    confirmLabel: "Remove key",
  });
  if (!ok) return;

  ai = clearProvider(ai, provider);
  delete modelCache[provider];
  hydrateSettingsFields(provider);
  updateHeader();
  setDialogStatus(
    managed
      ? `${conf.label} key removed — Nova is using this site's key again.`
      : `${conf.label} key removed — Nova is using the built-in engine again.`,
    "ok"
  );
});

/* ------------------------------------------------------------------ */
/* First-run setup: the free Gemini key                                */
/* ------------------------------------------------------------------ */

const SETUP_SEEN_KEY = "nova.gemini.setup.seen";

function setSetupStatus(text, tone = "") {
  els.setupStatus.textContent = text;
  els.setupStatus.className = `ai-status${tone ? ` ${tone}` : ""}`;
}

function openSetup() {
  if (!els.setupDialog || els.setupDialog.open) return;
  els.setupKey.value = ai.providers?.gemini?.key || "";
  els.setupKey.type = "password";
  els.setupReveal.textContent = "Show";
  els.setupReveal.setAttribute("aria-pressed", "false");
  setSetupStatus("");
  els.setupDialog.showModal();
  window.setTimeout(() => els.setupKey.focus(), 80);
}

function skipSetup() {
  try {
    sessionStorage.setItem(SETUP_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
  els.setupDialog.close();
  els.input.focus();
}

/** Opens the guide when there is no Gemini key yet (once per tab session). */
function maybeOpenSetup({ force = false } = {}) {
  if (providerHasKey(ai, "gemini")) return;
  if (!force) {
    try {
      if (sessionStorage.getItem(SETUP_SEEN_KEY) === "1") return;
    } catch {
      /* ignore */
    }
  }
  openSetup();
}

/** Gemini is primary: keep a stored provider only while its key still works. */
function syncDefaultProvider() {
  if (ai.provider === "gemini") return;
  if (providerHasKey(ai, ai.provider)) return;
  ai.provider = "gemini";
  ai.model = PROVIDERS.gemini.defaultModel;
  try {
    ai = saveSettings(ai);
  } catch {
    /* the in-memory default still applies */
  }
}

els.setupReveal?.addEventListener("click", () => {
  const show = els.setupKey.type === "password";
  els.setupKey.type = show ? "text" : "password";
  els.setupReveal.textContent = show ? "Hide" : "Show";
  els.setupReveal.setAttribute("aria-pressed", String(show));
});

els.setupClose?.addEventListener("click", skipSetup);
els.setupSkip?.addEventListener("click", skipSetup);
els.setupDialog?.addEventListener("close", () => {
  if (store.activeId) els.input.focus();
});

els.setupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = els.setupKey.value.trim();

  if (!key) {
    setSetupStatus("Paste the API key from Google AI Studio first.", "err");
    els.setupKey.focus();
    return;
  }
  if (!looksLikeKey("gemini", key)) {
    setSetupStatus("That does not look like a Google API key — new ones start with AQ., older ones with AIza.", "err");
    els.setupKey.focus();
    return;
  }

  els.setupSave.disabled = true;
  setSetupStatus("Checking your key with Google…");

  try {
    await checkKey({ provider: "gemini", key });
    setSetupStatus("Key accepted — starting Gemini.", "ok");
  } catch (err) {
    if (err?.code === "invalid_key") {
      setSetupStatus(err.message, "err");
      els.setupSave.disabled = false;
      return;
    }
    // Offline, or Google had a hiccup: keep the key and let the first reply try it.
    setSetupStatus("Saved without a live check — your first reply will test it.", "warn");
  }

  try {
    ai = saveSettings({
      ...ai,
      provider: "gemini",
      model: ai.provider === "gemini" && ai.model ? ai.model : PROVIDERS.gemini.defaultModel,
      providers: { ...ai.providers, gemini: { key } },
    });
  } catch (err) {
    setSetupStatus(err.message, "err");
    els.setupSave.disabled = false;
    return;
  }

  const chat = store.ensureActive();
  if (chat) store.setModel(chat.id, ai.model, "gemini");

  try {
    sessionStorage.setItem(SETUP_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }

  updateHeader();
  if (!els.modelPopover.hidden) renderModelPopover();
  els.setupSave.disabled = false;
  els.setupDialog.close();
  toast("Gemini connected — free tier active");
  els.input.focus();
});

els.closeSettings.addEventListener("click", closeSettings);
els.dialog.addEventListener("click", (event) => {
  if (event.target === els.dialog) closeSettings();
});

els.settingsBtn.addEventListener("click", () => openSettings());
els.pill.addEventListener("click", () => openSettings());
els.footSettings.addEventListener("click", () => openSettings());
els.modelSettingsLink.addEventListener("click", () => openSettings(modelPickProvider));
els.modelBtn.addEventListener("click", openModelPopover);
els.modelSearch.addEventListener("input", renderModelPopover);

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

function resizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function updateCounter() {
  const len = els.input.value.length;
  els.counter.textContent = `${len}/${MAX_INPUT}`;
  els.counter.classList.toggle("warn", len > MAX_INPUT * 0.9);
  refreshSendState();
}

els.input.addEventListener("input", () => {
  resizeInput();
  updateCounter();
  if (!busy) els.send.disabled = !els.input.value.trim();
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitUser(els.input.value, pendingImage);
  }
});

els.send.addEventListener("click", () => {
  if (stream) {
    stream.abort();
    return;
  }
  submitUser(els.input.value, pendingImage);
});

els.promptBtn.addEventListener("click", openPromptQuick);
els.promptQuickSearch.addEventListener("input", renderPromptQuick);
els.promptQuickLibrary.addEventListener("click", () => {
  closePromptQuick();
  openPromptLibrary();
});
els.promptLibraryBtn.addEventListener("click", openPromptLibrary);

els.newChat.addEventListener("click", startNewChat);
els.newChatTop.addEventListener("click", startNewChat);
els.chatSearch.addEventListener("input", renderChatList);
els.chatSearchClear.addEventListener("click", () => {
  els.chatSearch.value = "";
  renderChatList();
  els.chatSearch.focus();
});

function startNewChat() {
  stopSpeech();
  if (busy) {
    toast("Stop the current reply first");
    return;
  }
  closeModelPopover();
  closePromptQuick();
  setSidebar(false);

  const active = store.active;
  const alreadyEmpty = active && active.messages.every((m) => m.greeting);
  if (!alreadyEmpty) {
    const chat = createChatWithGreeting();
    store.setActive(chat.id);
  }

  if (!reduceMotion) {
    els.messages.classList.add("is-clearing");
    window.setTimeout(() => {
      els.messages.classList.remove("is-clearing");
      renderMessages({ scroll: "bottom" });
    }, 130);
  } else {
    renderMessages({ scroll: "bottom" });
  }

  els.input.value = "";
  clearAttachment();
  resizeInput();
  updateCounter();
  renderChatList();
  updateHeader();
  els.input.focus();
  if (window.matchMedia("(max-width: 980px)").matches) els.input.blur();
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

const prefersLight =
  window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
let storedTheme = null;
try {
  storedTheme = localStorage.getItem(THEME_KEY);
} catch {
  /* ignore */
}
applyTheme(storedTheme || (prefersLight ? "light" : "dark"));

els.theme.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  document.documentElement.classList.add("theme-anim");
  applyTheme(current === "dark" ? "light" : "dark");
  window.setTimeout(() => document.documentElement.classList.remove("theme-anim"), 520);
});

/* ------------------------------------------------------------------ */
/* Side panel topics + sidebar toggles                                 */
/* ------------------------------------------------------------------ */

function renderTopics() {
  if (!els.topics) return;
  const picks = FEATURED.map((id) => TOPICS.find((t) => t.id === id)).filter(Boolean);
  for (const topic of picks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = topic.title;
    btn.addEventListener("click", () => {
      if (busy) return;
      submitUser(`Explain ${topic.title}`);
      els.input.focus();
    });
    els.topics.appendChild(btn);
  }
}

els.sidebarToggle.addEventListener("click", () => {
  setSidebar(!els.app.classList.contains("sidebar-open"));
});
els.sidebarClose.addEventListener("click", () => setSidebar(false));
els.sidebarBackdrop.addEventListener("click", () => setSidebar(false));

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!busy) startNewChat();
    return;
  }

  if (event.key === "Escape") {
    if (!els.modelPopover.hidden) {
      closeModelPopover();
      return;
    }
    if (!els.promptQuick.hidden) {
      closePromptQuick();
      return;
    }
    // Let an open dialog handle Escape itself (native close).
    if (anyDialogOpen()) return;
    if (stream) {
      stream.abort();
      return;
    }
    if (els.app.classList.contains("sidebar-open")) setSidebar(false);
    return;
  }

  if (event.key === "/" && !isEditable(event.target) && !anyDialogOpen()) {
    event.preventDefault();
    els.input.focus();
  }
});

function anyDialogOpen() {
  return [els.dialog, els.setupDialog, els.promptDialog, els.confirmDialog, byId("study-dialog")].some(
    (dialog) => dialog?.open
  );
}

document.addEventListener("click", (event) => {
  if (
    !els.modelPopover.hidden &&
    !els.modelPopover.contains(event.target) &&
    !els.modelBtn.contains(event.target)
  ) {
    closeModelPopover();
  }
  if (
    !els.promptQuick.hidden &&
    !els.promptQuick.contains(event.target) &&
    !els.promptBtn.contains(event.target)
  ) {
    closePromptQuick();
  }
});

/* ------------------------------------------------------------------ */
/* Miscellaneous                                                       */
/* ------------------------------------------------------------------ */

els.exportBtn.addEventListener("click", exportChat);
els.scrollBtn?.addEventListener("click", () => {
  scrollToBottom();
  els.scrollBtn.classList.remove("has-unread");
});
els.messages.addEventListener("scroll", refreshScrollButton, { passive: true });

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

buildTagOptions();
initDictation();
initPhoto();
study = initStudy({
  ask: askStudy,
  currentChat: currentChatText,
  toast,
  confirm: confirmAction,
});

renderTopics();
initPointerGlow();

// Seed ids above anything already persisted, so messages stay unique.
msgSeq = store.chats
  .flatMap((chat) => chat.messages.map((m) => m.id))
  .reduce((max, id) => (Number.isFinite(id) && id > max ? id : max), Date.now() - 1e6);

// Older chats kept the pre-board greeting with its old chip row. Upgrade the
// stored greeting in place so every conversation shows the starter board.
let upgradedGreeting = false;
for (const chat of store.chats) {
  const greet = chat.messages.find((m) => m.greeting);
  if (!greet) continue;
  const stale = !greet.cards?.length || greet.chips?.includes("Tell me a joke");
  if (!stale) continue;
  greet.cards = GREETING.cards;
  greet.chips = GREETING.chips;
  upgradedGreeting = true;
}
if (upgradedGreeting) store.save();

if (!store.chats.length) {
  createChatWithGreeting();
} else {
  const active = store.ensureActive();
  if (active && !active.messages.length) store.addMessage(active.id, greetingMessage());
}

renderChatList();
renderMessages({ scroll: "bottom" });
updateHeader();

// A server-held Gemini key makes the provider usable with no key here.
loadServerAi().then(() => {
  syncDefaultProvider();

  // Write the normalised settings back, which also drops a retired provider
  // (OpenRouter) and any model that belonged to it.
  try {
    ai = saveSettings(ai);
  } catch {
    /* in-memory settings still work */
  }

  // OpenRouter is no longer part of the app, so conversations that used it
  // move to Gemini instead of pointing at a provider that does not exist.
  for (const chat of store.chats) {
    if (chat.provider && !PROVIDERS[chat.provider]) store.setModel(chat.id, ai.model, "gemini");
  }

  // A chat that has not been used yet should start on the default provider.
  const active = store.active;
  if (active && active.messages.every((m) => m.greeting) && active.provider !== ai.provider) {
    store.setModel(active.id, ai.model, ai.provider);
  }

  updateHeader();
  if (!els.modelPopover.hidden) renderModelPopover();
  if (els.dialog.open) hydrateSettingsFields(els.dialogProvider.value);
  maybeOpenSetup();
});

resizeInput();
updateCounter();
setBusy(false);
refreshScrollButton();
els.input.focus();

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => scrollToBottom(false));
}

// Expose a tiny handle for smoke-testing in the console without a build step.
window.nova = { store, promptStore, renderMarkdown, deriveTitle, study };
