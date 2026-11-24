/**
 * Cloudflare Worker entry point.
 *
 * Serves the static single-page app and proxies Google AI Studio (Gemini) so
 * the browser never needs a key: the key lives in the Worker secret
 * GEMINI_API_KEY (locally, .dev.vars) and is only added here, on the server.
 * A key saved in the browser is still respected and wins over the server key.
 *
 * Routes:
 *   GET  /api/ai/config         → { gemini } — whether the server key exists
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
const DAILY_REQUEST_LIMIT = 80;

const STEPS_RULE =
  "Show every step of the working, one line per step, and state the rule or formula used. Do not skip algebraic steps.";

/**
 * A free model quota is shared by every visitor, so each IP gets a daily
 * allowance. This is per Worker isolate (best effort), not a hard quota.
 */
const usage = new Map();

function dailyLimitReached(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}|${day}`;
  const used = (usage.get(key) || 0) + 1;
  usage.set(key, used);
  if (usage.size > 4000) {
    for (const entry of [...usage.keys()]) {
      if (!entry.endsWith(day)) usage.delete(entry);
      if (usage.size <= 2000) break;
    }
  }
  return used > DAILY_REQUEST_LIMIT;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function geminiHeaders(env, accept) {
  return {
    "x-goog-api-key": env.GEMINI_API_KEY,
    Accept: accept,
  };
}

async function upstreamError(res, fallback) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const detail = body?.error?.message || body?.message || "";
  // Google's error.details carries the quotaId (daily versus per-minute), so it
  // must survive the proxy for the page to explain a used-up free tier.
  return json({ error: { ...(body?.error || {}), message: detail || fallback } }, res.status);
}

/** Cross-site POSTs are refused so another page cannot spend this key. */
function crossOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin !== url.origin);
}

/* ------------------------------------------------------------------ */
/* Google AI Studio (Gemini)                                           */
/* ------------------------------------------------------------------ */

async function handleConfig(request) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);
  return json({ gemini: true });
}

async function handleGeminiModels(request, env) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=50`, {
      headers: geminiHeaders(env, "application/json"),
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
    },
  });
}

async function handleGeminiKey(request, env) {
  if (request.method !== "GET") return json({ error: { message: "Method not allowed." } }, 405);

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=1`, {
      headers: geminiHeaders(env, "application/json"),
    });
  } catch {
    return json({ error: { message: "Could not reach Google AI Studio." } }, 502);
  }

  if (!res.ok) return upstreamError(res, "Google rejected the server key.");

  return json({ verified: true, label: "server key" });
}

async function handleGeminiChat(request, env, url) {
  if (request.method !== "POST") return json({ error: { message: "Method not allowed." } }, 405);

  if (crossOrigin(request, url)) {
    return json({ error: { message: "Cross-origin requests are not allowed." } }, 403);
  }

  if (dailyLimitReached(request)) {
    return json(
      {
        error: {
          code: "quota_day",
          message:
            "This site has answered a lot of questions today. Try again tomorrow, or connect your own free Gemini key in AI settings.",
        },
      },
      429
    );
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

  const model = typeof payload?.model === "string" ? payload.model.trim() : "";
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(model)) {
    return json({ error: { message: "Choose a Gemini model before sending a message." } }, 400);
  }

  const contents = cleanGeminiContents(payload?.contents);
  if (!contents.length) return json({ error: { message: "The message list is empty." } }, 400);

  const maxTokens = Math.min(Math.max(Number(payload?.maxTokens) || 900, 1), 4000);
  const steps = payload?.steps === true;

  let upstream;
  try {
    upstream = await fetch(
      `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          ...geminiHeaders(env, "text/event-stream"),
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
  if (!env?.GEMINI_API_KEY) {
    if (url.pathname === "/api/ai/config") return json({ gemini: false });
    return json({ error: { message: "Gemini is not configured on this server." } }, 503);
  }

  switch (url.pathname) {
    case "/api/ai/config":
      return handleConfig(request);
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
