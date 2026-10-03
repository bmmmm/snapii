// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium's service worker, bundled like scripts/build.mjs does and run
// against a stub `browser`: which listeners its top level registers. A worker
// is started for each event and dispatches it only to listeners registered
// synchronously at the top level; a throw there loses them all.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { MINIMUM_CHROME_VERSION } from "../../../src/shared/manifest.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const bundle = (async () => {
  const out = await build({
    entryPoints: [join(ROOT, "src/background/chromium/main.ts")],
    bundle: true,
    format: "iife",
    target: `chrome${MINIMUM_CHROME_VERSION}`,
    define: { SNAPII_TARGET: JSON.stringify("chromium") },
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0]?.text ?? "";
})();

/** Runs the bundle with a `browser` that has every API the worker uses, minus `without`. */
async function run(without: string[] = []): Promise<{ seen: string[]; calls: string[] }> {
  const seen: string[] = [];
  const calls: string[] = [];
  const event = (name: string) => ({ addListener: () => seen.push(name) });
  const call = (name: string) => async () => void calls.push(name);
  const browser: Record<string, unknown> = {
    runtime: {
      getURL: (p: string) => `chrome-extension://id/${p}`,
      getManifest: () => ({ version: "0.0.0", action: { default_title: "snapii" } }),
      getContexts: async () => [],
      sendMessage: call("runtime.sendMessage"),
      onMessage: event("runtime.onMessage"),
    },
    commands: { onCommand: event("commands.onCommand") },
    action: { setTitle: call("action.setTitle"), setBadgeText: call("action.setBadgeText") },
    offscreen: {
      createDocument: call("offscreen.createDocument"),
      closeDocument: call("offscreen.closeDocument"),
    },
    downloads: { onChanged: event("downloads.onChanged") },
  };
  for (const api of without) delete browser[api];
  runInNewContext(await bundle, { browser, console, setTimeout, clearTimeout, URL });
  await new Promise((resolve) => setImmediate(resolve));
  return { seen: seen.sort(), calls };
}

test("chromium worker: registers the message and command listeners, and no download listener", async () => {
  const { seen } = await run();
  // The download's outcome is polled (src/background/chromium/download.ts), not listened for.
  assert.deepEqual(seen, ["commands.onCommand", "runtime.onMessage"]);
});

test("chromium worker: starting it calls no browser API, and creates no offscreen document", async () => {
  const { calls } = await run();
  assert.deepEqual(calls, []);
});

test("chromium worker: without the commands API the message listener still registers", async () => {
  const { seen } = await run(["commands"]);
  assert.deepEqual(seen, ["runtime.onMessage"]);
});
