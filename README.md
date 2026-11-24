# Nova — AI Chatbot (single page)

A polished one-page chat app with **two brains**:

1. **Live models** — **Google AI Studio (Gemini)** on the free tier, with a built-in guide for getting a key; a Worker secret can hold the key so visitors need none. Any OpenAI-compatible endpoint can be added with its own key. Replies stream token by token, and you can switch models inside a conversation.
2. **Built-in offline engine** — with no key (or no internet), Nova answers from a hand-written intent engine covering computer-science topics, maths, unit conversion and study coaching.

Pure HTML, CSS and JavaScript. No framework, no build step, no backend required.

---

## Start it

### Windows (double-click)

- **`start-server.cmd`** — launches the local server in a minimised window and opens http://localhost:8787.
  If Nova is already being served, it just opens the page instead of starting a second copy.
- **`stop-server.cmd`** — stops whatever is serving on port 8787.

Both close themselves when finished; nothing stays running in the background beyond the server itself.

### Any OS (manual)

The app uses ES modules, so it must be served over HTTP — opening `index.html` by double-click (`file://`) will show a blank page.

```bash
python -m http.server 8787 --directory public     # Python
npx serve public -l 8787                          # Node
npx wrangler dev --port 8787                      # Cloudflare Worker (src/worker.js)
```

Then open **http://localhost:8787**.

---

## Connect a model

On first load, with no key configured, Nova opens a short setup guide. Gemini is preselected as the provider either way.

1. Open **AI settings** (the sliders icon, the engine pill under the title, or **Connect** in the sidebar). The panel keeps a collapsible **“How to get a free API key?”** guide.
2. Pick a provider:
   - **Google AI Studio (Gemini)** — free tier, no credit card. Create a key at <https://aistudio.google.com/apikey>, paste it, press **Save**. The key is checked against Google before it is stored.
   - **Custom OpenAI-compatible endpoint** — paste a base URL such as `https://api.example.com/v1` and its key. Any gateway that implements `/chat/completions` and `/models` works (Groq, Together, a local llama.cpp server, your own proxy…).
3. Press **Test key** to confirm the connection without spending tokens.
4. Choose a default model. Gemini offers a dropdown (`gemini-3.5-flash-lite` by default, plus `gemini-4-hydrogen` and the other free Flash models) and an **Other model ID…** option; other providers use a live, searchable catalogue.
5. **Save.** The header shows the model and provider, the chat input is focused, and replies stream in.

Use the **model selector** in the chat header to switch models mid-conversation. The choice is remembered per conversation; switching never clears messages or starts a new chat. Star a model to keep it in the favourites row.

### Where the key goes

The page checks the server first: `GET /api/ai/config` reports whether `GEMINI_API_KEY` exists on the Worker. With that key, `/api/ai/gemini/chat` adds it server-side and visitors need paste nothing; otherwise the app asks for a browser key and calls Google directly.

A key pasted into the Gemini setup screen or AI settings is saved in this browser (`nova.ai.v2`, mirrored to `gemini_api_key` for convenience) and sent only to Google.

The secret lives in `.dev.vars` locally (git-ignored, loaded by `wrangler dev`). On a deployed Worker set it with `wrangler secret put GEMINI_API_KEY`; on Freebuff Sites use **Sites → Secrets**. Without it, `/api/ai/config` reports `gemini: false` and the app asks for a browser key.

A key pasted into AI settings for a **custom endpoint** is stored in this browser's `localStorage` (`nova.ai.v2`) and sent only to that endpoint. Anyone with access to the browser can read it, so use a low-limit key.

---

## What you get

| Area | Detail |
| --- | --- |
| Conversations | Multiple independent chats, created from the sidebar; stored in `localStorage` (`nova.chats.v2`) and restored on reload |
| Titles | Auto-generated from the first user message; rename inline from the sidebar |
| Sidebar | Recency groups (Today, Yesterday, Previous 7 days…), last-activity time, message counts, search across titles and message text |
| Deleting | Confirmation dialog before a conversation, message or saved prompt is removed |
| Models | Header selector with live catalogue, search, provider info, context size, free marker and favourites; per-conversation model memory |
| Providers | Google AI Studio (Gemini) plus any OpenAI-compatible base URL; both streaming and plain JSON responses are accepted |
| Message controls | Copy, edit-and-resend, delete, read aloud (AI); copy, edit, delete (user); regenerate any AI reply; Stop while streaming; inline copied confirmation |
| Streaming | Server-sent events parsed incrementally; partial replies are kept if you stop or the connection drops |
| Rendering | Headings, bold/italic/strikethrough, lists, tables, blockquotes, links, rules; fenced code with language labels, syntax highlighting and a Copy button; inline and display LaTeX through bundled KaTeX |
| RTL | Every text block uses `dir="auto"`, so Arabic and Hebrew read right-to-left inside bubbles, lists and tables |
| Prompt library | 14 built-in prompts across Programming, Writing, Learning, Translation, Productivity and Research; create, edit, delete; search and category filters; insert into the composer; quick picker beside the input |
| Study hub | One dialog with five tabs: Deck, Review, Exam, Notes and Progress |
| Flashcards | Generate cards from a conversation or a topic, or add them by hand; topic filters; per-card delete; CSV export for Anki/Quizlet |
| Spaced repetition | Again/Hard/Good/Easy scheduling (10 minutes up to 180 days), a due-today badge and a review session |
| Practice exams | Timed paper with hidden mark schemes, then “mark my answers” feedback and a total |
| Notes | Turn a chat into revision notes, import lecture notes, and optionally include the best-matching notes in replies |
| Formula sheet | Extract every equation from a conversation, deduplicated, with copy and Markdown download |
| Progress | Day streak, replies and cards today, deck size, last seven days as a bar chart |
| Maths plotter | Plot `y = f(x)` on a canvas — powers, implicit multiplication, `sin`, `sqrt`, `log`, `pi`, `e` |
| Explain it back | Ask Nova to mark your own explanation of a reply: what is right, what is missing, one follow-up question |
| Subject tags | Tag a conversation with a subject, filter by it in search, and see the tag in the sidebar |
| Dictation + photos | Voice input through the Web Speech API, and a photo attachment (downscaled) sent to a vision model |
| Step-by-step | A setting that asks every reply to show its working line by line |
| Study tools | Export the conversation as Markdown, read a reply aloud, offline engine fallback |
| UI | Two-panel desktop layout, off-canvas sidebar on mobile, light/dark theme, typing indicator, suggestion chips, character counter, toast confirmations |
| Shortcuts | `Ctrl/⌘ + K` new chat, `/` focus the composer, `Esc` stop streaming or close a popover |

---

## Project structure

```
.
├── start-server.cmd        # Windows: launch the local server + browser
├── stop-server.cmd         # Windows: stop it again
├── public/                 # everything the browser loads
│   ├── index.html          # markup, icon sprite, dialogs
│   ├── styles.css          # tokens, layout, themes, components, responsive rules
│   ├── app.js              # UI controller: sessions, streaming, actions, dialogs
│   ├── store.js            # conversation store: chats, messages, search, prefs
│   ├── prompts.js          # prompt library: defaults + CRUD
│   ├── study.js            # flashcards, scheduling, notes, study log, formulas
│   ├── study-ui.js         # the study hub: deck, review, exam, notes, progress
│   ├── plot.js             # safe expression parser + canvas plotter
│   ├── study.css           # study hub, tags, attachments, explain-it-back
│   ├── theme.css           # design tokens (palette, radius, type), loaded last
│   ├── markdown.js         # markdown, syntax highlighting, KaTeX wiring
│   ├── ai.js               # Gemini + custom-endpoint settings and streaming
│   ├── engine.js           # offline intent engine + knowledge base
│   └── vendor/katex/       # bundled KaTeX (JS, CSS, woff2 fonts) for offline maths
├── src/worker.js           # Cloudflare Worker: static assets + Gemini proxy
├── scripts/smoke.mjs       # offline-engine regression tests
├── scripts/features.test.mjs # renderer, store and prompt-library tests
├── scripts/study.test.mjs    # flashcards, scheduling, notes, formulas, plotter
├── deploy.json             # hosting manifest
├── wrangler.toml
└── package.json
```

### Storage keys

| Key | Contents |
| --- | --- |
| `nova.chats.v2` | Every conversation, its messages, model, timestamps and active id |
| `nova.prefs.v2` | Favourite models and the last model used per provider |
| `nova.ai.v2` | Provider, default model, keys and custom base URL |
| `gemini_api_key` | Mirror of the Gemini key, so it can also be set by hand |
| `nova.prompts.v2` | Saved prompts (defaults are seeded on first run) |
| `nova.study.v1` | Flashcards and their due dates, imported notes, study log, study preferences |
| `nova.theme.v1` | Light/dark preference |

The look and feel lives in `public/theme.css`: the palette for both themes, the radius and type scales, and overrides that keep every surface flat. Change a colour or a step there rather than in the component stylesheets; the rest of the CSS reads those tokens.

The old single-conversation `nova.chat.v1` and `nova.ai.v1` values are migrated automatically the first time the new version loads.

---

## Study tools

Open the **Study** button in the sidebar footer (or the stack icon in the chat header).

- **Deck** — `Cards from this chat` asks the model for a JSON array of cards and validates every item before saving; the topic box and card count control the request. `Generate from topic` works without a conversation. Duplicates in the same topic are skipped, and `Export CSV` produces the `Front,Back,Tags` layout both Anki and Quizlet import.
- **Review** — only cards whose due date has passed are queued. `Again` returns the card in ten minutes; `Hard`, `Good` and `Easy` grow the interval by roughly 1.2×, 2.4× and 3.2×, capped at 180 days. Reviewing a card counts towards the daily log.
- **Exam** — the model writes a JSON paper with marks and a mark scheme. The timer runs from generation; `Show mark scheme` reveals the answers, and `Mark my answers` sends the questions plus your answers back for marked feedback and a total.
- **Notes** — `Make revision notes` condenses the conversation into Markdown you can copy, download or save. Imported notes can be included in replies (`Use in replies`): the two best keyword matches are added as context to the latest question, so answers come from your own material.
- **Progress** — a study log of replies, cards reviewed and papers generated, with the streak and a seven-day chart. `Reset progress` clears the log but keeps cards and notes.

Everything is stored in this browser (`nova.study.v1`); nothing new is sent anywhere except the model calls you trigger.

Photos are the one thing big enough to fill `localStorage`, so they are budgeted: each one is resized (1100px down to 440px) with the JPEG quality stepped down until it is under ~140 KB of base64, and the whole chat store keeps at most 1.5 MB of photos. When that budget or the browser quota is reached, the **oldest** photos are removed (the message text stays and the bubble notes that the photo was removed) and the save is retried. If even text cannot be written, the previous saved conversation is left untouched and the app keeps working in memory rather than reporting a false save. The Worker accepts at most one inline image per message.

The Worker also enforces a generous daily request allowance per IP (80 calls) so one visitor cannot drain the shared free-model quota, and it rejects cross-origin `POST`s.

## How the AI path works

`public/ai.js` is the whole integration:

- **Providers** — `gemini` (`https://generativelanguage.googleapis.com/v1beta`) or a user-supplied OpenAI-compatible base URL. Gemini uses `streamGenerateContent?alt=sse` with `x-goog-api-key`; a custom endpoint uses `GET /models` and `POST /chat/completions`.
- **Streaming** — `stream: true`, SSE frames parsed incrementally; `[DONE]`, keep-alive comments, mid-stream `error` frames and non-streaming JSON bodies are all handled.
- **Context** — a system prompt plus the last **10 messages** of *that conversation*, which keeps each request inside the free tier's tokens-per-minute budget. Switching models reuses the same history.
- **Errors** — status codes map to actionable messages, including a dedicated explanation for Gemini's `429` free-tier rate limit; abandoned streams keep whatever text already arrived.
- **Abort** — the send button becomes Stop while a reply streams, and `Esc` does the same.

Without a usable key, `app.js` calls `respond()` from `engine.js` exactly as before, so the project still works offline and in a viva with no internet.

### Adding a topic to the offline engine

Append an object to the `KB` array in `public/engine.js`:

```js
{
  id: "my-topic",
  title: "My topic",
  keys: ["keyword", "another keyword"],
  summary: "One-paragraph explanation.",
  points: ["Detail one.", "Detail two."],
  chips: ["A follow-up question"],
}
```

---

## Tests

```bash
npm test        # engine smoke tests + renderer/store/prompt tests
```

- `scripts/smoke.mjs` — greetings, memory, follow-ups, maths, conversions, fallbacks and reachability of every knowledge-base topic.
- `scripts/features.test.mjs` — Markdown (tables, code escaping, streaming tolerance, currency vs maths), syntax highlighting, RTL attributes, conversation store (titles, search, per-chat model, persistence, deletion, legacy migration) and the prompt library.

Browser behaviour was also checked against a temporary local mock of an OpenAI-compatible stream: markdown/table/code/KaTeX rendering, Arabic RTL, stop, regenerate, edit-and-resend, model switching, favourites, prompt insertion, persistence after reload and the mobile sidebar.

---

## Deploy

Deploy the Worker (not just `public/`) so the `/api/ai/*` proxy exists:

```bash
npx wrangler secret put GEMINI_API_KEY   # optional: free Gemini key server-side
npx wrangler deploy                     # uses deploy.json / wrangler.toml
```

On Freebuff Sites, deploy from `deploy.json` and add `GEMINI_API_KEY` under **Sites → Secrets** after the first deploy. A plain static host (GitHub Pages, Netlify, Vercel) still serves the UI, but visitors must then paste their own Gemini key.

---

## Limitations

- The offline engine is curated, not generative: outside CS, study skills and small talk it says so rather than inventing an answer.
- Model quality, speed and price depend on the model you pick; free models are slower and rate-limited.
- A Gemini key held as a Worker secret can be spent by anyone who opens the site, so watch the project's quota in AI Studio.
- Conversation history is local to one browser profile; there is no account or sync.
