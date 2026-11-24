/**
 * Feature tests for the v2 layer: renderer, conversation store, prompt store.
 * Runs in Node with a fake localStorage — no browser required.
 *
 *   node scripts/features.test.mjs
 */

import assert from "node:assert/strict";
import { renderMarkdown, highlightCode, plainText } from "../public/markdown.js";
import { ChatStore, deriveTitle } from "../public/store.js";
import { PromptStore, CATEGORIES } from "../public/prompts.js";

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
    dump: () => [...map.keys()],
  };
}

console.log("\nMarkdown rendering");

const doc = [
  "# Heading one",
  "",
  "Some **bold**, *italic*, ~~gone~~ and `inline code`.",
  "",
  "- first",
  "- second",
  "  - nested",
  "",
  "1. one",
  "2. two",
  "",
  "> A quoted line",
  "",
  "| Name | Score |",
  "| :--- | ---: |",
  "| Ada | 10 |",
  "| Linus | 9 |",
  "",
  "---",
  "",
  "[OpenRouter](https://openrouter.ai/keys)",
  "",
  "```js",
  'const x = "<script>alert(1)</script>";',
  "```",
  "",
  "Inline $E=mc^2$ maths.",
  "",
  "$$",
  "\\frac{1}{2}",
  "$$",
].join("\n");

const html = renderMarkdown(doc);

check("headings render", () => assert.match(html, /<h1 dir="auto">Heading one<\/h1>/));
check("bold renders", () => assert.match(html, /<strong>bold<\/strong>/));
check("italic renders", () => assert.match(html, /<em>italic<\/em>/));
check("strikethrough renders", () => assert.match(html, /<del>gone<\/del>/));
check("inline code renders", () => assert.match(html, /<code class="inline-code">inline code<\/code>/));
check("unordered list renders", () => assert.match(html, /<ul><li dir="auto">first/));
check("nested list renders", () => assert.match(html, /<li dir="auto">second<ul>/));
check("ordered list renders", () => assert.match(html, /<ol><li dir="auto">one/));
check("blockquote renders", () => assert.match(html, /<blockquote dir="auto"><p dir="auto">A quoted line/));
check("tables render", () => assert.match(html, /<table dir="auto">/));
check("table alignment kept", () => assert.match(html, /text-align:right/));
check("horizontal rule renders", () => assert.match(html, /<hr \/>/));
check("links render", () => assert.match(html, /href="https:\/\/openrouter\.ai\/keys"/));
check("code block renders", () => assert.match(html, /class="code-block"/));
check("code language label", () => assert.match(html, /class="code-lang">JavaScript/));
check("code copy button", () => assert.match(html, /class="code-copy"/));
check("code is escaped", () => {
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});
check("inline maths falls back without KaTeX", () => assert.match(html, /class="math-raw" dir="ltr">E=mc\^2/));
check("block maths renders", () => assert.match(html, /class="math-block" dir="ltr"><code class="math-raw"/));

check("javascript: links are rejected", () => {
  const bad = renderMarkdown("[click](javascript:alert(1))");
  assert.doesNotMatch(bad, /href="javascript/i);
});

check("raw HTML is escaped", () => {
  const bad = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(bad, /<img/i);
  assert.match(bad, /&lt;img/);
});

check("currency is not mistaken for maths", () => {
  const money = renderMarkdown("It costs $5 and $10 total.");
  assert.doesNotMatch(money, /math-raw/);
  assert.match(money, /\$5 and \$10/);
});

check("unclosed fence still renders while streaming", () => {
  const partial = renderMarkdown("Here:\n\n```py\nprint('hi'", { streaming: true });
  assert.match(partial, /class="code-block"/);
  assert.match(partial, /print/);
});

check("half-written emphasis does not throw", () => {
  const partial = renderMarkdown("A **strong start and `code", { streaming: true });
  assert.match(partial, /strong start/);
});

check("Arabic text is marked dir=auto", () => {
  const rtl = renderMarkdown("مرحبا بالعالم، كيف حالك؟");
  assert.match(rtl, /dir="auto"/);
  assert.match(rtl, /مرحبا بالعالم/);
});

check("syntax highlighting colours comments and strings", () => {
  const code = highlightCode("// note\nconst a = \"hi\";", "javascript");
  assert.match(code, /tok-com/);
  assert.match(code, /tok-str/);
  assert.match(code, /tok-kw/);
});

check("highlighting escapes HTML", () => {
  const code = highlightCode('<div class="x">hi</div>', "html");
  assert.doesNotMatch(code, /<div/);
  assert.match(code, /&lt;/);
  assert.match(code, /tok-tag">div/);
});

check("plainText removes markdown noise", () => {
  const text = plainText("## Title\n\n**bold** and `code` and [link](https://x.dev)\n\n- item");
  assert.equal(text, "Title\n\nbold and code and link\n\nitem");
});

console.log("\nConversation store");

const storage = fakeStorage();
const store = new ChatStore(storage);

const first = store.create({ model: "openai/gpt-x", provider: "openrouter" });
check("create makes the active chat", () => assert.equal(store.activeId, first.id));
check("create remembers model", () => assert.equal(store.get(first.id).model, "openai/gpt-x"));

store.addMessage(first.id, { id: 1, role: "user", text: "Explain binary search trees in detail" });
store.autoTitle(first.id, "Explain binary search trees in detail");
check(
  "title derives from first user message",
  () => assert.equal(store.get(first.id).title, "Explain binary search trees in detail")
);

const second = store.create({ model: "openrouter/auto", provider: "openrouter" });
store.addMessage(second.id, {
  id: 2,
  role: "user",
  text: "Write an essay about TCP congestion control and retransmission timers",
});
store.autoTitle(second.id, "Write an essay about TCP congestion control");
check("second chat is independent", () => assert.equal(store.get(second.id).messages.length, 1));
check("first chat keeps its messages", () => assert.equal(store.get(first.id).messages.length, 1));
check("active chat is the newest", () => assert.equal(store.activeId, second.id));

check("search finds by title", () => {
  const hits = store.search("binary");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chat.id, first.id);
});

check("search finds by message body", () => {
  const hits = store.search("retransmission");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chat.id, second.id);
  assert.match(hits[0].snippet, /retransmission/);
});

check("rename overrides auto title", () => {
  store.rename(second.id, "Networking revision");
  store.autoTitle(second.id, "ignored text");
  assert.equal(store.get(second.id).title, "Networking revision");
});

check("per-chat model switch keeps messages", () => {
  store.setModel(second.id, "anthropic/claude-x", "openrouter");
  assert.equal(store.get(second.id).model, "anthropic/claude-x");
  assert.equal(store.get(second.id).messages.length, 1);
});

check("favourites toggle", () => {
  const model = { id: "x/y", name: "Y", provider: "openrouter" };
  assert.equal(store.toggleFavorite(model), true);
  assert.equal(store.isFavorite(model), true);
  assert.equal(store.toggleFavorite(model), false);
  assert.equal(store.isFavorite(model), false);
});

check("store persists across reloads", () => {
  const reloaded = new ChatStore(storage);
  assert.equal(reloaded.chats.length, 2);
  assert.equal(reloaded.activeId, second.id);
  assert.equal(reloaded.get(first.id).title, "Explain binary search trees in detail");
  assert.equal(reloaded.get(second.id).model, "anthropic/claude-x");
});

check("delete removes only that chat", () => {
  const copy = new ChatStore(storage);
  copy.remove(first.id);
  assert.equal(copy.chats.length, 1);
  assert.equal(copy.get(second.id).title, "Networking revision");
});

check("deleting the active chat picks a neighbour", () => {
  const copy = new ChatStore(storage);
  copy.setActive(first.id);
  copy.remove(first.id);
  assert.equal(copy.activeId, second.id);
});

check("deriveTitle trims long prompts at a word boundary", () => {
  const title = deriveTitle("Explain the difference between TCP and UDP with as much detail as you can give me please");
  assert.ok(title.length <= 49);
  assert.match(title, /…$/);
});

check("legacy single-chat state migrates", () => {
  const legacy = fakeStorage();
  legacy.setItem(
    "nova.chat.v1",
    JSON.stringify({
      messages: [
        { id: 1, role: "bot", text: "Hi", greeting: true, ts: 1 },
        { id: 2, role: "user", text: "Explain DNS", ts: 2 },
      ],
    })
  );
  const migrated = new ChatStore(legacy);
  assert.equal(migrated.chats.length, 1);
  assert.equal(migrated.chats[0].title, "Explain DNS");
  assert.equal(migrated.chats[0].messages.length, 2);
});

console.log("\nPrompt library");

const promptStorage = fakeStorage();
const prompts = new PromptStore(promptStorage);
const seeded = prompts.list().length;

check("default prompts are seeded", () => assert.ok(seeded >= 12));
check("every category has a default prompt", () => {
  const used = new Set(prompts.list().map((p) => p.category));
  for (const category of CATEGORIES) assert.ok(used.has(category), `missing ${category}`);
});

check("prompts can be added", () => {
  const added = prompts.add({
    title: "Explain like I am five",
    description: "Simplest possible explanation",
    category: "Learning",
    body: "Explain [topic] like I am five.",
  });
  assert.ok(added?.id);
  assert.equal(prompts.list().length, seeded + 1);
});

check("prompts can be edited", () => {
  const target = prompts.list().find((p) => p.title === "Explain like I am five");
  const updated = prompts.update(target.id, { title: "ELI5" });
  assert.equal(updated.title, "ELI5");
});

check("prompts filter by category", () => {
  const list = prompts.filter({ category: "Programming" });
  assert.ok(list.length >= 2);
  assert.ok(list.every((p) => p.category === "Programming"));
});

check("prompts search across fields", () => {
  const list = prompts.filter({ query: "stack trace" });
  assert.equal(list.length, 1);
});

check("prompts persist and can be removed", () => {
  const target = prompts.list().find((p) => p.title === "ELI5");
  prompts.remove(target.id);
  const reloaded = new PromptStore(promptStorage);
  assert.equal(reloaded.list().length, seeded);
  assert.ok(!reloaded.get(target.id));
});

check("empty prompts are rejected", () => {
  assert.equal(prompts.add({ title: "", body: "" }), null);
});

if (failures) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}

console.log("\nALL FEATURE TESTS PASSED");
