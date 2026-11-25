/**
 * Cloudflare Worker entry point.
 *
 * Serves the static single-page app and proxies Google AI Studio (Gemini) so
 * every visitor shares this site's key: the browser never sees it and never
 * asks for one. The key lives in the Worker secret GEMINI_API_KEY (locally in
 * .dev.vars) and is only added here, on the server.
 *
 * Routes:
 *   GET  /api/ai/config         → { gemini } — whether the shared key is set
 *   GET  /api/ai/gemini/models  → Gemini model catalogue
 *   GET  /api/ai/gemini/key     → Gemini key check (no tokens spent)
 *   POST /api/ai/gemini/chat    → Gemini streaming chat completion
 *
 * Every reply is given the study-assistant rules in public/study-prompt.js,
 * added here so the model cannot be talked out of them by the page.
 */

import { STUDY_RULES } from "../public/study-prompt.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_CHAT_BYTES = 4 * 1024 * 1024;
const MAX_GEMINI_TURNS = 40;
const MAX_TOTAL_CHARS = 120000;
const MAX_IMAGE_CHARS = 3_500_000;

/** Per-visitor allowances on the shared key. */
const CHAT_PER_MINUTE = 10;
const CHAT_PER_DAY = 80;
/** Safety net for the whole site, so the shared free quota is not drained. */
const SITE_CHAT_PER_DAY = 700;

const STEPS_RULE =
  "Show every step of the working, one line per step, and state the rule or formula used. Do not skip algebraic steps.";

/**
 * The shared free quota means one chatty visitor could use up the whole day
 * for everybody, so chat requests are counted here. This is per Worker
 * isolate (best effort), not a hard, globally consistent quota.
 */
const hits = new Map();

function clientIp(request) {
  const direct = request.headers.get("CF-Connecting-IP");
  if (direct) return direct;
  const forwarded = request.headers.get("X-Forwarded-For");
  return forwarded ? forwarded.split(",")[0].trim() : "local";
}

function countHit(key) {
  const used = (hits.get(key) || 0) + 1;
  hits.set(key, used);
  return used;
}

function pruneHits(minute, day) {
  if (hits.size <= 4000) return;
  for (const key of [...hits.keys()]) {
    if (!key.endsWith(minute) && !key.endsWith(day)) hits.delete(key);
    if (hits.size <= 1000) break;
  }
}

/**
 * Returns { limited, scope, retryAfter } for a chat request.
 * scope "minute" is a burst; "day" is the visitor's or the site's daily cap.
 */
function chatLimit(request) {
  const ip = clientIp(request);
  const now = new Date();
  const minute = now.toISOString().slice(0, 16);
  const day = now.toISOString().slice(0, 10);

  const minuteHits = countHit(`m|${ip}|${minute}`);
  const dayHits = countHit(`d|${ip}|${day}`);
  const siteHits = countHit(`s|site|${day}`);

  pruneHits(minute, day);

  if (minuteHits > CHAT_PER_MINUTE) return { limited: true, scope: "minute", retryAfter: 60 };
  if (dayHits > CHAT_PER_DAY) return { limited: true, scope: "day", retryAfter: 3600 };
  if (siteHits > SITE_CHAT_PER_DAY) return { limited: true, scope: "site", retryAfter: 3600 };
  return { limited: false };
}

/**
 * Gemini turns are { role: "user" | "model", parts: [...] }. Text and one
 * inline image are accepted; anything else is dropped rather than trusted.
 */
function cleanGeminiContents(raw) {
  if (!Array.isArray(raw)) return [];

  const turns = [];
  let chars = 0;
  let images = 0;

  for (const turn of raw.slice(-MAX_GEMINI_TURNS)) {
    if (!turn || typeof turn !== "object") continue;
    const role = turn.role === "model" ? "model" : "user";
    const parts = [];

    for (const part of Array.isArray(turn.parts) ? turn.parts.slice(0, 4) : []) {
      if (!part || typeof part !== "object") continue;

      if (typeof part.text === "string" && part.text.trim()) {
        chars += part.text.length;
        if (chars > MAX_TOTAL_CHARS) return [];
        parts.push({ text: part.text });
        continue;
      }

      if (images < 1 && part.inlineData && typeof part.inlineData === "object") {
        const mimeType = String(part.inlineData.mimeType || "");
        const data = String(part.inlineData.data || "");
        if (
          /^image\/(png|jpe?g|webp|gif)$/i.test(mimeType) &&
          data.length > 0 &&
          data.length <= MAX_IMAGE_CHARS
        ) {
          parts.push({ inlineData: { mimeType, data } });
          images += 1;
        }
      }
    }

    if (parts.length) turns.push({ role, parts });
  }

  return turns;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** The secret, trimmed. Never returned to the browser. */
function geminiKey(env) {
  const key = typeof env?.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY.trim() : "";
  return key.length >= 10 ? key : "";
}

function geminiHeaders(key, accept) {
  return {
    "x-goog-api-key": key,
    Accept: accept,
  };
}

/** Reads Google's RetryInfo delay (e.g. "17s") from a 429 body. */
function retryAfterSeconds(body) {
  let seconds = 0;
  for (const detail of Array.isArray(body?.error?.details) ? body.error.details : []) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(String(detail?.retryDelay || "").trim());
    if (match) seconds = Math.max(seconds, Math.ceil(Number(match[1])));
  }
  return seconds;
}

/**
 * Turns a Google error into something a student can act on. A used-up quota
 * keeps Google's own body (with `details`) so the page can tell a daily cap
 * from a per-minute burst. Other failures get plain wording: the browser
 * cannot fix a server key, so it must not be told to try.
 */
async function upstreamError(res, fallback, keyMessage = "") {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }

  const upstream = body?.error || {};
  const detail = typeof upstream.message === "string" ? upstream.message : "";

  if (res.status === 429) {
    const headers = {};
    const retryAfter = retryAfterSeconds(body);
    if (retryAfter) headers["Retry-After"] = String(retryAfter);
    return json({ error: { ...upstream, message: detail || fallback } }, 429, headers);
  }

  // Google reports a bad key as 400 API_KEY_INVALID, not only 401/403. A
  // visitor cannot fix the shared key, so they get a plain retry message.
  const keyRejected =
    res.status === 401 || res.status === 403 || /api[_ ]?key[_ ]?(not valid|invalid|expired)|API_KEY_INVALID/i.test(detail);
  if (keyRejected) {
    return json(
      {
        error: {
          code: "server_key",
          status: res.status,
          message:
            keyMessage || "Live AI is unavailable right now. The built-in study engine still works.",
        },
      },
      502
    );
  }

  const messages = {
    400: "That request could not be processed. Try another Gemini model.",
    401: "The shared Gemini key was refused by Google.",
    403: "The shared Gemini key is not allowed to use this model.",
    404: "That Gemini model is not available right now. Pick another model from the list.",
    408: "Google AI Studio timed out. Try again.",
    500: "Google AI Studio had a problem answering. Try again.",
    502: "Google AI Studio could not be reached. Try again.",
    503: "Gemini is busy right now. Try again, or pick another model.",
  };

  return json(
    {
      error: {
        code: res.status === 404 ? "model_unavailable" : res.status >= 500 ? "upstream" : "request_failed",
        status: res.status,
        message: messages[res.status] || fallback,
      },
    },
    res.status
  );
}

/** Cross-site POSTs are refused so another page cannot spend this key. */
function crossOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin !== url.origin);
}

/* ------------------------------------------------------------------ */
/* Google AI Studio (Gemini)                                           */
/* ------------------------------------------------------------------ */

function handleConfig(request, env) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);
  return json({ gemini: Boolean(geminiKey(env)) });
}

async function handleGeminiModels(request, env) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=50`, {
      headers: geminiHeaders(geminiKey(env), "application/json"),
    });
  } catch {
    return json({ error: { message: "Could not reach Google AI Studio." } }, 502);
  }

  if (!res.ok) return upstreamError(res, "Google AI Studio could not list its models.");

  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleGeminiKey(request, env) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=1`, {
      headers: geminiHeaders(geminiKey(env), "application/json"),
    });
  } catch {
    return json({ error: { message: "Could not reach Google AI Studio." } }, 502);
  }

  if (!res.ok) {
    return upstreamError(
      res,
      "Google rejected the shared key.",
      "Google rejected this site's Gemini key. Check the GEMINI_API_KEY secret."
    );
  }

  return json({ verified: true, label: "shared key" });
}

async function handleGeminiChat(request, env, url) {
  if (request.method !== "POST") return json({ error: { message: "Method not allowed." } }, 405);

  if (crossOrigin(request, url)) {
    return json({ error: { message: "Cross-origin requests are not allowed." } }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_CHAT_BYTES) {
    return json({ error: { message: "That conversation is too long to send." } }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: { message: "Invalid JSON body." } }, 400);
  }

  // Only Gemini chat models are proxied, so the shared key cannot be spent on
  // an unrelated model id.
  const model = typeof payload?.model === "string" ? payload.model.trim() : "";
  if (!/^gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(model)) {
    return json(
      { error: { code: "model_unavailable", message: "Choose a Gemini model before sending a message." } },
      400
    );
  }

  const contents = cleanGeminiContents(payload?.contents);
  if (!contents.length) return json({ error: { message: "The message list is empty." } }, 400);

  const limit = chatLimit(request);
  if (limit.limited) {
    const headers = { "Retry-After": String(limit.retryAfter) };
    const burst = limit.scope === "minute";
    const message = burst
      ? "That is a lot of questions in one minute. Wait a few seconds, then send again."
      : limit.scope === "site"
        ? "Nova has answered a lot of questions today. The shared free allowance resets tomorrow — the built-in study engine works right now."
        : "You have used today's questions on this site. It resets tomorrow — the built-in study engine works right now.";
    return json({ error: { code: burst ? "quota_minute" : "quota_day", message } }, 429, headers);
  }

  const maxTokens = Math.min(Math.max(Number(payload?.maxTokens) || 900, 1), 4000);
  const steps = payload?.steps === true;

  let upstream;
  try {
    upstream = await fetch(
      `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          ...geminiHeaders(geminiKey(env), "text/event-stream"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents,
          // The rules are added here, on the server, so a reply follows them
          // no matter what the page sends.
          systemInstruction: {
            parts: [{ text: steps ? `${STUDY_RULES}\n\n${STEPS_RULE}` : STUDY_RULES }],
          },
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      }
    );
  } catch {
    return json({ error: { message: "Could not reach Google AI Studio." } }, 502);
  }

  if (!upstream.ok) return upstreamError(upstream, "Google AI Studio refused the request.");

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ------------------------------------------------------------------ */

async function handleAi(request, env, url) {
  if (!geminiKey(env)) {
    if (url.pathname === "/api/ai/config") return json({ gemini: false });
    return json(
      {
        error: {
          code: "server_key",
          message: "Live AI is not configured on this server. The built-in study engine still works.",
        },
      },
      503
    );
  }

  switch (url.pathname) {
    case "/api/ai/config":
      return handleConfig(request, env);
    case "/api/ai/gemini/models":
      return handleGeminiModels(request, env);
    case "/api/ai/gemini/key":
      return handleGeminiKey(request, env);
    case "/api/ai/gemini/chat":
      return handleGeminiChat(request, env, url);
    default:
      return json({ error: { message: "Unknown API route." } }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/ai/")) {
      return handleAi(request, env || {}, url);
    }

    if (!env || !env.ASSETS) {
      return new Response("Static assets binding is not configured.", { status: 500 });
    }
    return env.ASSETS.fetch(request);
  },
};
