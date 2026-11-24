/**
 * Storage-safety tests for the chat store.
 *
 * Photos live inline in the one chat blob, so these tests make sure a full
 * browser quota costs an old photo at worst — never the conversation.
 *
 *   node scripts/storage.test.mjs
 */

import assert from "node:assert/strict";
import { ChatStore } from "../public/store.js";

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

/** localStorage stand-in whose quota can be changed mid-test. */
function quotaStorage(limit = Infinity) {
  const map = new Map();
  const storage = {
    limit,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      if (text.length > storage.limit) {
        const error = new Error("QuotaExceededError");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(key, text);
    },
    removeItem: (key) => map.delete(key),
    raw: map,
  };
  return storage;
}

const IMAGE = (chars) => `data:image/jpeg;base64,${"A".repeat(chars)}`;

function seedChat(store, text = "Hello") {
  const chat = store.create({});
  store.addMessage(chat.id, { id: 1, role: "user", text, ts: Date.now() });
  return chat;
}

console.log("\nNormal saves");

check("a conversation round-trips", () => {
  const storage = quotaStorage();
  const store = new ChatStore(storage);
  seedChat(store, "Explain paging");
  const reopened = new ChatStore(storage);
  assert.equal(reopened.chats.length, 1);
  assert.equal(reopened.chats[0].messages[0].text, "Explain paging");
  assert.equal(reopened.available, true);
});

check("a photo round-trips", () => {
  const storage = quotaStorage();
  const store = new ChatStore(storage);
  const chat = seedChat(store);
  const photo = IMAGE(120_000);
  store.addMessage(chat.id, {
    id: 2,
    role: "user",
    text: "Look at this",
    image: photo,
    ts: Date.now(),
  });
  const reopened = new ChatStore(storage);
  assert.equal(reopened.chats[0].messages[1].image, photo);
});

console.log("\nPhoto budget");

check("the oldest photos are evicted past the budget", () => {
  const storage = quotaStorage();
  const store = new ChatStore(storage);
  const chat = seedChat(store);
  const texts = [];
  for (let i = 0; i < 4; i += 1) {
    texts.push(`photo message ${i}`);
    store.addMessage(chat.id, {
      id: 10 + i,
      role: "user",
      text: texts[i],
      image: IMAGE(450_000),
      ts: Date.now() + i,
    });
  }
  // Four 450k photos exceed the 1.5M character budget.
  assert.ok(store.imageChars() <= 1_500_000, `still ${store.imageChars()}`);
  const messages = store.chats[0].messages.filter((m) => m.text.startsWith("photo message"));
  assert.equal(messages.length, 4, "no message may be lost");
  for (const message of messages) assert.ok(message.text.trim(), "text survives");
  assert.ok(messages[0].imageDropped, "the oldest photo is the one dropped");
  assert.equal(messages[0].image, "");
  assert.ok(messages[3].image, "the newest photo is kept");
});

check("eviction is reported", () => {
  const storage = quotaStorage();
  const store = new ChatStore(storage);
  const chat = seedChat(store);
  let reported = 0;
  store.onImageDropped = (count) => {
    reported += count;
  };
  for (let i = 0; i < 4; i += 1) store.addMessage(chat.id, { id: 20 + i, role: "user", text: `p${i}`, image: IMAGE(450_000) });
  assert.ok(reported >= 1);
});

console.log("\nQuota failures");

check("a full quota drops the photo, not the chat", () => {
  const storage = quotaStorage(80_000);
  const store = new ChatStore(storage);
  const chat = seedChat(store, "Paging notes");
  store.addMessage(chat.id, { id: 2, role: "user", text: "What is this?", image: IMAGE(200_000) });

  const saved = JSON.parse(storage.getItem("nova.chats.v2"));
  const messages = saved.chats[0].messages;
  assert.equal(messages.length, 2, "both messages are stored");
  assert.equal(messages[0].text, "Paging notes");
  assert.equal(messages[1].text, "What is this?");
  assert.equal(messages[1].image, "", "the photo gave way");
  assert.equal(messages[1].imageDropped, true);
  assert.equal(store.available, true);
});

check("a quota too small for anything keeps the last good save", () => {
  const storage = quotaStorage(10_000);
  const store = new ChatStore(storage);
  seedChat(store, "Saved safely");
  const before = storage.getItem("nova.chats.v2");
  assert.ok(before.includes("Saved safely"));

  storage.limit = 400; // now nothing sizable fits
  const chat = store.active;
  store.addMessage(chat.id, { id: 99, role: "user", text: "x".repeat(2_000) });

  assert.equal(storage.getItem("nova.chats.v2"), before, "previous data untouched");
  assert.equal(store.available, false, "the UI is told persistence stopped");
  assert.equal(store.chats[0].messages.length, 2, "the chat still exists in memory");
});

check("save() returns false instead of throwing", () => {
  const storage = quotaStorage(100);
  const store = new ChatStore(storage);
  seedChat(store, "y".repeat(500));
  assert.equal(store.save(), false);
});

console.log("\nLoading existing data");

check("oversized stored photos are dropped on load", () => {
  const storage = quotaStorage();
  const huge = "A".repeat(700_000);
  storage.setItem(
    "nova.chats.v2",
    JSON.stringify({
      version: 2,
      activeId: "c1",
      chats: [
        {
          id: "c1",
          title: "With a huge photo",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 1, role: "user", text: "kept", ts: 1, image: `data:image/jpeg;base64,${huge}` },
          ],
        },
      ],
    })
  );

  const store = new ChatStore(storage);
  const message = store.chats[0].messages[0];
  assert.equal(message.text, "kept");
  assert.equal(message.image, "");
  assert.equal(message.imageDropped, true);
});

check("saving after load trims the oversized photo out of storage", () => {
  const storage = quotaStorage();
  storage.setItem(
    "nova.chats.v2",
    JSON.stringify({
      version: 2,
      activeId: "c1",
      chats: [
        {
          id: "c1",
          title: "With a huge photo",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 1, role: "user", text: "kept", ts: 1, image: `data:image/jpeg;base64,${"A".repeat(700_000)}` },
          ],
        },
      ],
    })
  );
  const store = new ChatStore(storage);
  store.save();
  const saved = JSON.parse(storage.getItem("nova.chats.v2"));
  assert.equal(saved.chats[0].messages[0].image, "");
  assert.ok(storage.getItem("nova.chats.v2").length < 5000);
});

console.log(
  failures ? `\n${failures} STORAGE TEST(S) FAILED` : "\nALL STORAGE TESTS PASSED"
);
process.exit(failures ? 1 : 0);
