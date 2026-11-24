/**
 * Waits for the local dev server to answer, so the launcher can open the
 * browser only once the page is really ready.
 *
 * Usage: node scripts/wait-for-port.mjs [port] [timeoutMs] [--open]
 *   --open  open the page in the default browser as soon as it answers
 *
 * Exit code 0 as soon as the server answers, 1 if it never does.
 */

import { exec } from "node:child_process";

const args = process.argv.slice(2);
const port = Number(args[0]) || 8787;
const timeoutMs = Number(args[1]) || 120000;
const shouldOpen = args.includes("--open");

const probeUrl = `http://127.0.0.1:${port}/`;
const browserUrl = `http://localhost:${port}/`;
const deadline = Date.now() + timeoutMs;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser() {
  if (!shouldOpen) return Promise.resolve();
  return new Promise((resolve) => {
    exec(`start "" "${browserUrl}"`, { windowsHide: true }, () => resolve());
  });
}

while (Date.now() < deadline) {
  try {
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(3000) });
    if (res.status >= 200 && res.status < 400) {
      await res.body?.cancel();
      await openBrowser();
      process.exit(0);
    }
    await res.body?.cancel();
  } catch {
    /* not up yet */
  }
  await sleep(400);
}

process.exit(1);
