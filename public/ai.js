/**
 * ai.js — model client
 *
 * Google AI Studio (Gemini) runs on this site's shared key, held by the
 * Worker, so a visitor never sees it and never pastes one. An optional custom
 * OpenAI-compatible endpoint keeps its own key in this browser.
 */

import { STUDY_RULES } from "./study-prompt.js";

const STORE_KEY = "nova.ai.v2";

/**
 * Server-side key. GEMINI_API_KEY on the Worker is the only Gemini credential
 * this app uses; the browser never holds one.
 */
const SERVER = { checked: false, gemini: false };

export async function loadServerAi() {
  try {
    const res = await fetch("/api/ai/config", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    SERVER.gemini = Boolean(body?.gemini);
  } catch {
    SERVER.gemini = false;
  }
  SERVER.checked = true;
  return { ...SERVER };
}

/** True when this site's server holds the Gemini key, so none is needed here. */
export function serverHasProvider(providerId = "gemini") {
  return providerId === "gemini" && SERVER.gemini;
}

function viaServer(provider) {
  return provider === "gemini" && SERVER.gemini;
}

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Google AI Studio",
    short: "Gemini",
    badge: "Google AI Studio (Free Tier)",
    baseUrl: GEMINI_BASE,
    defaultModel: "gemini-3.5-flash-lite",
    modelsQuery: "?pageSize=50",
    free: true,
  },
  custom: {
    id: "custom",
    label: "Custom endpoint",
    short: "Custom",
    baseUrl: "",
    keyHint: "your API key",
    defaultModel: "",
    modelsQuery: "",
  },
};

/** The provider a first-time visitor starts on. */
export const DEFAULT_PROVIDER = "gemini";
export const DEFAULT_MODEL = PROVIDERS.gemini.defaultModel;

/**
 * Gemini models on the free tier, best first. Used for the picker before the
 * live catalogue arrives (and when the key cannot reach Google).
 */
export const GEMINI_MODELS = [
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", provider: "gemini", free: true },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", provider: "gemini", free: true },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", provider: "gemini", free: true },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", provider: "gemini", free: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "gemini", free: true },
];

/**
 * The study-assistant rules (see study-prompt.js). The Worker prepends the
 * same text on the server, so a reply follows them even without this client.
 */
export const SYSTEM_PROMPT = STUDY_RULES;

export const STEPS_RULE =
  "Show every step of the working, one line per step, and state the rule or formula used. Do not skip algebraic steps.";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class AiError extends Error {
  constructor(message, { status = 0, code = "", retryable = false } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const STATUS_HELP = {
  400: "The request was rejected. The model ID may be invalid for this provider.",
  401: "The provider rejected the API key. Check it in AI settings.",
  402: "This account is out of credit for the selected model.",
  403: "This key is not allowed to use that model.",
  404: "That model is not available. Pick a different one.",
  408: "The request timed out. Try again.",
  413: "The conversation is too long for this model. Start a new chat or pick a model with a larger context.",
  429: "Rate limited by the provider. Wait a moment and try again.",
  502: "The provider could not reach the model. Try again.",
  503: "The model is busy right now. Try again or pick another model.",
};

/**
 * Gemini runs on this site's key, so a visitor can only retry, pick another
 * model, or use the built-in engine — there is no key of theirs to fix.
 */
const GEMINI_STATUS_HELP = {
  400: "That request could not be processed. Try another Gemini model.",
  401: "Nova's AI service refused that request. Try again later, or keep going with the built-in engine.",
  403: "That model is not available with this site's access right now. Pick another Gemini model.",
  404: "That Gemini model is not available right now. Pick another model from the list.",
  408: "Nova's AI service timed out. Try again.",
  413: "The conversation is too long for this model. Start a new chat or pick a model with a larger context.",
  429: "Nova's AI service is rate limited right now. Wait a few seconds and try again.",
  502: "Live AI is temporarily unavailable. Try again, or keep going with the built-in engine.",
  503: "Gemini is busy right now. Try again or pick another model.",
};

function friendly(label, status, detail, providerId = "") {
  if (providerId === "gemini") {
    const geminiHelp =
      GEMINI_STATUS_HELP[status] ||
      (status >= 500 ? "Nova's AI service is having trouble. Try again shortly." : "");
    return geminiHelp || "Something went wrong while getting that answer. Try again, or use the built-in engine.";
  }
  const base = STATUS_HELP[status] || (status >= 500 ? `${label} is having trouble. Try again shortly.` : "");
  if (base) return detail ? `${base} (${detail})` : base;
  return detail || `Something went wrong while talking to ${label}.`;
}

function parseDelay(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value || "").trim());
  return match ? Math.ceil(Number(match[1])) : 0;
}

/**
 * Reads a 429 body so a used-up daily allowance is not reported as a burst.
 * Google marks a daily quota with a quotaId such as
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier"; the Worker adds
 * code: "quota_day" for this site's own daily cap.
 */
function quotaFromBody(body) {
  const code = typeof body?.error?.code === "string" ? body.error.code : "";
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  let ids = "";
  let retryAfter = 0;
  for (const detail of details) {
    for (const violation of Array.isArray(detail?.violations) ? detail.violations : []) {
      ids += ` ${violation?.quotaId || ""} ${violation?.quotaMetric || ""}`;
    }
    if (detail?.retryDelay) retryAfter = Math.max(retryAfter, parseDelay(detail.retryDelay));
  }
  const text = `${code} ${ids}`;
  return { daily: code === "quota_day" || /per.?day|perday|daily/i.test(text), retryAfter };
}

async function errorFromResponse(res, label, providerId = "") {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const detail = body?.error?.message || body?.message || "";
  const badKey = res.status === 401 || res.status === 403;
  const quota = res.status === 429 ? quotaFromBody(body) : { daily: false, retryAfter: 0 };

  let message = friendly(label, res.status, detail, providerId);
  let code = providerId === "custom" && badKey ? "invalid_key" : "";

  if (res.status === 429) {
    code = quota.daily ? "quota_day" : "quota_minute";
    if (quota.daily) {
      // This site's own caps already explain themselves precisely.
      const own = body?.error?.code === "quota_day";
      message = own
        ? detail || "Today's questions on this site are used up. The built-in engine still works."
        : providerId === "gemini"
          ? "Google's free tier has ended for today — this model's daily free requests are used up. It resets at midnight Pacific time."
          : detail || "Today's free allowance for this endpoint is used up.";
    } else if (providerId === "gemini") {
      message = "Nova's AI service is rate limited right now — wait a few seconds, then send again.";
    } else {
      message = detail ? `Rate limited: ${detail}` : "Rate limited by the provider. Wait a moment and try again.";
    }
  }

  const err = new AiError(message, {
    status: res.status,
    code,
    retryable: res.status === 429 || res.status >= 500 || res.status === 408,
  });
  err.retryAfter = quota.retryAfter;
  return err;
}

/* ------------------------------------------------------------------ */
/* Settings (localStorage)                                             */
/* ------------------------------------------------------------------ */

function normaliseBase(value) {
  return String(value || "")
    .trim()
    .replace(/\/(chat\/completions|models)\/?$/i, "")
    .replace(/\/+$/, "");
}

const PROVIDER_IDS = ["gemini", "custom"];

export function normaliseProviderId(value) {
  return PROVIDER_IDS.includes(value) ? value : DEFAULT_PROVIDER;
}

function normaliseSettings(raw) {
  const provider = normaliseProviderId(raw?.provider);
  const savedModel = typeof raw?.model === "string" ? raw.model.trim() : "";
  // A model remembered for a provider that is gone must not travel to Gemini,
  // and a custom endpoint must never inherit Gemini's default model id.
  const usableModel = provider === "gemini" ? /^gemini[-.]/i.test(savedModel) : Boolean(savedModel);
  return {
    provider,
    model: usableModel ? savedModel : provider === "gemini" ? DEFAULT_MODEL : "",
    providers: {
      // Gemini uses this site's shared key. A key left in an older install is
      // dropped rather than kept in the browser.
      gemini: { key: "" },
      custom: {
        key: typeof raw?.providers?.custom?.key === "string" ? raw.providers.custom.key.trim() : "",
        baseUrl: normaliseBase(raw?.providers?.custom?.baseUrl),
      },
    },
  };
}

export function loadSettings() {
  let settings = null;

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) settings = normaliseSettings(JSON.parse(raw));
  } catch {
    /* fall through to the v1 shape */
  }

  if (!settings) settings = normaliseSettings(null);
  return settings;
}

export function saveSettings(next) {
  const settings = normaliseSettings(next);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    throw new AiError("This browser blocked local storage, so the settings cannot be saved.");
  }
  return settings;
}

/** Removes a provider's key (and, for a custom endpoint, its base URL). */
export function clearProvider(settings, providerId) {
  const next = normaliseSettings(settings);
  const id = normaliseProviderId(providerId);
  next.providers[id] = { key: "", ...(id === "custom" ? { baseUrl: "" } : {}) };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** Short, safe display form of a key — never render the whole thing. */
export function maskKey(key) {
  if (!key) return "";
  const text = String(key);
  if (text.length <= 10) return "•••••";
  return `${text.slice(0, 7)}…${text.slice(-4)}`;
}

export function shortModel(id) {
  const name = String(id || "").replace(/^~/, "");
  return name.length > 34 ? `${name.slice(0, 33)}…` : name || "Auto";
}

/** "OpenAI: GPT-6 Luna" → vendor "OpenAI", label "GPT-6 Luna". */
export function splitModelName(name, id) {
  const raw = String(name || id || "");
  const match = /^([^:]{2,28}):\s*(.+)$/.exec(raw);
  if (match) return { vendor: match[1].trim(), label: match[2].trim() };
  const slash = String(id || "").indexOf("/");
  const vendor = slash > 0 ? String(id).slice(0, slash) : "";
  return { vendor, label: raw };
}

export function providerInfo(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/** Merges stored provider settings with the provider definition. */
export function resolveProvider(settings) {
  const id = normaliseProviderId(settings?.provider);
  const base = PROVIDERS[id];
  const saved = settings?.providers?.[id] || {};
  return {
    ...base,
    key: saved.key || "",
    baseUrl: id === "custom" ? normaliseBase(saved.baseUrl) : base.baseUrl,
  };
}

export function providerHasKey(settings, providerId) {
  // Gemini only ever uses the Worker's key; a custom endpoint needs its own.
  if (providerId === "gemini") return serverHasProvider("gemini");
  const conf = settings?.providers?.custom;
  return Boolean(conf?.key && normaliseBase(conf?.baseUrl));
}

export function looksLikeKey(providerId, key) {
  const value = String(key || "").trim();
  if (!value) return false;
  // New AI Studio keys are auth keys starting with "AQ." (AIza is the legacy
  // traffic-key format). Google validates the key itself; this is only a
  // sanity check so a stray paste is caught before a network round trip.
  if (providerId === "gemini") {
    return /^(AIza|AQ)[0-9A-Za-z._-]{8,}$/.test(value) || /^[A-Za-z0-9._-]{24,}$/.test(value);
  }
  return value.length >= 4;
}

/* ------------------------------------------------------------------ */
/* Model catalogue                                                     */
/* ------------------------------------------------------------------ */

function unreachable(conf) {
  // A custom endpoint usually fails here because the browser blocked it
  // (CORS or a bad URL), not because the network is down.
  return conf.id === "custom"
    ? `Could not reach ${conf.label}. Check the base URL and that it allows requests from this site.`
    : `Could not reach Nova's AI service. Check your internet connection.`;
}

function modelsUrl(conf) {
  const base = conf.baseUrl || PROVIDERS[conf.id]?.baseUrl || "";
  if (!base) throw new AiError("Add a base URL for your custom endpoint first.");
  return `${base}/models${conf.modelsQuery || ""}`;
}

function providerConf(provider, baseUrl = "") {
  if (provider === "custom") return { ...PROVIDERS.custom, baseUrl: normaliseBase(baseUrl) };
  return PROVIDERS.gemini;
}

/**
 * Loads the provider's model list. Gemini uses the Worker's catalogue; a
 * custom endpoint needs its own key.
 */
export async function fetchModels({ provider = DEFAULT_PROVIDER, baseUrl = "", key = "", signal } = {}) {
  const conf = providerConf(provider, baseUrl);
  if (provider === "custom" && !conf.baseUrl) {
    throw new AiError("Add a base URL for your custom endpoint first.");
  }
  if (provider === "gemini") {
    if (!viaServer("gemini")) {
      throw new AiError("Live AI is unavailable right now. Nova answers with its built-in study engine.");
    }
  } else if (!key) {
    throw new AiError("Add your endpoint's API key in AI settings first.");
  }

  const headers = { Accept: "application/json" };
  if (provider === "custom") headers.Authorization = `Bearer ${key}`;

  const url = provider === "gemini" ? "/api/ai/gemini/models" : modelsUrl(conf);

  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new AiError(unreachable(conf));
  }

  if (!res.ok) throw await errorFromResponse(res, conf.label, provider);

  const body = await res.json().catch(() => null);

  if (provider === "gemini") {
    const geminiList = Array.isArray(body?.models) ? body.models : [];
    return geminiList
      .filter((model) => {
        const name = typeof model?.name === "string" ? model.name : "";
        if (!/^models\/gemini-/.test(name)) return false;
        const methods = model.supportedGenerationMethods;
        return Array.isArray(methods) ? methods.includes("generateContent") : true;
      })
      .map((model) => {
        const id = model.name.replace(/^models\//, "");
        return {
          id,
          name: typeof model.displayName === "string" && model.displayName ? model.displayName : id,
          provider: "gemini",
          providerLabel: conf.label,
          context: typeof model.inputTokenLimit === "number" ? model.inputTokenLimit : 0,
          free: /flash|hydrogen|gemma/i.test(id),
        };
      });
  }

  // An OpenAI-compatible gateway answers with { data: [ { id, … } ] }.
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];

  return list
    .filter((model) => model && typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      provider,
      providerLabel: conf.label,
      context: typeof model.context_length === "number" ? model.context_length : 0,
      free: /:free$/.test(model.id),
    }));
}

/* ------------------------------------------------------------------ */
/* Key check                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cheap validation that does not spend tokens: Gemini's model list, or the
 * model list of a custom gateway.
 * Returns { verified, label, limit, usage } or throws AiError on a bad key.
 */
export async function checkKey({ provider = DEFAULT_PROVIDER, key, baseUrl = "" } = {}) {
  const conf = providerConf(provider, baseUrl);

  if (provider === "gemini") {
    if (!viaServer("gemini")) {
      throw new AiError("Live AI is unavailable right now: this site has no Gemini key configured.", {
        code: "server_key",
      });
    }

    let res;
    try {
      res = await fetch("/api/ai/gemini/key", { headers: { Accept: "application/json" } });
    } catch {
      throw new AiError("Could not reach Nova's AI service. Check your internet connection.");
    }

    if (!res.ok) throw await errorFromResponse(res, conf.label, "gemini");

    return { verified: true, label: "shared key", limit: null, usage: null };
  }

  if (!key) throw new AiError(`Add an API key for ${conf.label} in AI settings first.`);
  if (!conf.baseUrl) throw new AiError("Add the endpoint's base URL first.");

  let res;
  try {
    res = await fetch(modelsUrl(conf), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  } catch {
    throw new AiError(unreachable(conf));
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError(`${conf.label} rejected that key. Copy it again from your provider dashboard.`, {
      status: res.status,
      code: "invalid_key",
    });
  }
  if (!res.ok) return { verified: false, label: null, limit: null, usage: null };

  const body = await res.json().catch(() => null);
  const count = Array.isArray(body?.data) ? body.data.length : 0;
  return { verified: true, label: `${conf.label} · ${count} models`, limit: null, usage: null };
}

/* ------------------------------------------------------------------ */
/* Google AI Studio (Gemini)                                           */
/* ------------------------------------------------------------------ */

/**
 * Google's REST API does not use OpenAI's message shape: a turn is
 * { role: "user" | "model", parts: [...] } and images travel as inlineData.
 */
export function geminiContents(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];
    const content = message.content;

    if (typeof content === "string") {
      if (content.trim()) parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          parts.push({ text: part.text });
        } else if (part?.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url || "");
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2].replace(/\s+/g, "") } });
          }
        }
      }
    }

    if (parts.length) out.push({ role, parts });
  }
  return out;
}

/** Text of one streamed Gemini chunk (thinking parts are dropped). */
function geminiChunkText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (part && typeof part.text === "string" && !part.thought) text += part.text;
  }
  return text;
}

/**
 * Streams a Gemini reply through the Worker, which adds the shared key and the
 * study rules. The browser never calls Google directly.
 */
async function streamGemini({ model, messages, signal, onDelta, maxTokens = 900, steps = false }) {
  const conf = PROVIDERS.gemini;
  if (!viaServer("gemini")) {
    throw new AiError("Live AI is unavailable right now. Nova can answer with its built-in study engine.", {
      code: "unavailable",
    });
  }
  if (!model) throw new AiError("Choose a Gemini model before sending a message.");

  const contents = geminiContents(messages);
  if (!contents.length) throw new AiError("Write a message first.");

  const body = { model, contents, maxTokens, steps: steps || undefined };
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };

  let res;
  try {
    res = await fetch("/api/ai/gemini/chat", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new AiError("Could not reach Nova's AI service. Check your internet connection.");
  }

  if (!res.ok) throw await errorFromResponse(res, conf.label, "gemini");

  // Google streams SSE, but a proxy can collapse it into one JSON body.
  if (/application\/json/i.test(res.headers.get("content-type") || "")) {
    const payload = await res.json().catch(() => null);
    let text = "";
    for (const chunk of Array.isArray(payload) ? payload : [payload]) text += geminiChunkText(chunk);
    if (text.trim()) {
      if (onDelta) onDelta(text);
      return text;
    }
    throw new AiError("Gemini returned an unexpected response.");
  }

  if (!res.body) throw new AiError("This browser cannot stream replies. Try Chrome, Edge or Firefox.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let blocked = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(raw);
        } catch {
          continue;
        }

        if (chunk?.error) {
          const status = Number(chunk.error.code) || 0;
          const quota = status === 429 ? quotaFromBody(chunk) : { daily: false };
          throw new AiError(
            status === 429
              ? quota.daily
                ? "Google's free tier has ended for today — this model's daily free requests are used up. It resets at midnight Pacific time."
                : "Google's free tier is rate limited right now. Wait a few seconds and try again."
              : chunk.error.message || "Gemini returned an error mid-reply.",
            {
              status,
              code: status === 429 ? (quota.daily ? "quota_day" : "quota_minute") : "",
              retryable: status === 429 || status >= 500,
            }
          );
        }

        if (chunk?.promptFeedback?.blockReason && !text) blocked = chunk.promptFeedback.blockReason;

        const delta = geminiChunkText(chunk);
        if (delta) {
          text += delta;
          if (onDelta) onDelta(text);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!text) {
    throw new AiError(
      blocked
        ? "Gemini blocked that request. Try rephrasing it without personal or sensitive content."
        : "Gemini sent an empty reply. Try again, or pick a different Gemini model."
    );
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Streaming chat completion                                           */
/* ------------------------------------------------------------------ */

/**
 * Streams a completion, calling onDelta(fullTextSoFar) as tokens arrive.
 * Resolves with the final text. Throws AiError (or a DOMException for aborts).
 *
 * Accepts both SSE streams and a plain JSON body (some compatible gateways
 * ignore stream:true), so a provider that does not stream still works.
 */
export async function streamChat(options) {
  if (options?.provider === "gemini") return streamGemini(options);

  const {
    provider = "custom",
    baseUrl = "",
    key,
    model,
    messages,
    signal,
    onDelta,
    maxTokens = 900,
    steps = false,
  } = options || {};
  const conf = providerConf(provider, baseUrl);

  if (!key) throw new AiError(`Add an API key for ${conf.label} in AI settings first.`);
  if (!conf.baseUrl) {
    throw new AiError("Add a base URL for your custom endpoint in AI settings.");
  }
  if (!model) throw new AiError("Choose a model before sending a message.");

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const endpoint = `${conf.baseUrl}/chat/completions`;

  // A custom endpoint does not get the Worker's study-rules injection, so the
  // "show every step" rule is added to its system message here.
  const outgoing = steps
    ? messages.map((message, index) =>
        index === 0 && message.role === "system"
          ? { ...message, content: `${message.content}\n\n${STEPS_RULE}` }
          : message
      )
    : messages;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: outgoing,
        stream: true,
        max_tokens: maxTokens,
      }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new AiError(unreachable(conf));
  }

  if (!res.ok) throw await errorFromResponse(res, conf.label, provider);

  const contentType = res.headers.get("content-type") || "";
  if (/application\/json/i.test(contentType) && !res.body) {
    const body = await res.json().catch(() => null);
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text === "string") {
      if (onDelta) onDelta(text);
      return text;
    }
    throw new AiError("The provider returned an unexpected response.");
  }

  if (!res.body) throw new AiError("This browser cannot stream replies. Try Chrome, Edge or Firefox.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawFrame = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return text;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        sawFrame = true;

        if (chunk?.error) {
          const detail = typeof chunk.error === "string" ? chunk.error : chunk.error?.message;
          throw new AiError(detail || "The model returned an error mid-reply.", {
            status: typeof chunk.error?.code === "number" ? chunk.error.code : 0,
            retryable: true,
          });
        }

        const choice = chunk?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
          if (onDelta) onDelta(text);
          continue;
        }

        // Some OpenAI-compatible servers send full messages instead of deltas.
        const full = choice?.message?.content;
        if (typeof full === "string" && full && !text) {
          text = full;
          if (onDelta) onDelta(text);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!sawFrame && !text) {
    throw new AiError("The provider sent an empty response. Try another model.");
  }

  return text;
}
