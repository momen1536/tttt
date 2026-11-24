import { createSession, respond } from "../public/engine.js";

const s = createSession();
const cases = [
  "hi",
  "my name is Aditi",
  "what is my name",
  "Explain machine learning",
  "what is the time complexity of binary search",
  "what time is it",
  "what is today's date",
  "(48/6) + sqrt(81) * 2",
  "20% of 250",
  "convert 12 km to miles",
  "30 c to f",
  "5 kg in lb",
  "how do I revise for exams",
  "i'm stressed about my project",
  "tell me a joke",
  "another joke",
  "another joke",
  "what can you do?",
  "who are you",
  "what is quantum chromodynamics",
  "asdkjh qwe zxc",
  "how are you?",
  "explain tcp vs udp",
  "bye",
];

let failures = 0;
for (const c of cases) {
  const r = respond(c, s);
  if (!r.text || typeof r.text !== "string" || !r.text.trim()) {
    console.error("EMPTY RESPONSE:", c);
    failures++;
  }
  console.log(`\n>>> ${c}\n${r.text.slice(0, 160).replace(/\n/g, " | ")}`);
}

console.log("\n--- follow-up rotation ---");
const s2 = createSession();
["explain ai", "more", "more", "more"].forEach((q) => {
  const r = respond(q, s2);
  console.log(`[${q}]`, r.text.split("\n").slice(0, 3).join(" ").slice(0, 150));
});

console.log("\n--- no-topic follow-up should not crash ---");
console.log(respond("more", createSession()).text.slice(0, 80));

console.log("\n--- all KB topics reachable ---");
import { TOPICS } from "../public/engine.js";
for (const t of TOPICS) {
  const r = respond(`explain ${t.title}`, createSession());
  if (r.text.startsWith("I don't have a detailed note")) {
    console.error("MISS:", t.title);
    failures++;
  }
}
console.log(`topics: ${TOPICS.length}`);

if (failures) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL ENGINE CASES OK");
