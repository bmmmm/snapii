// SPDX-License-Identifier: GPL-3.0-or-later
// The event page's top level, bundled like scripts/build.mjs does and run
// against a stub `browser`: which listeners it registers. Firefox for Android
// has no `commands` API (the manifest does not declare it, but a profile
// could still run it there); a top-level
// throw there would leave the page without its message and download listeners.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..", "..");

const bundle = (async () => {
  const out = await build({
    entryPoints: [join(ROOT, "src/background/main.ts")],
    bundle: true,
    format: "iife",
    target: "firefox140",
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0]?.text ?? "";
})();

interface Run {
  /** Listener registrations, sorted. */
  seen: string[];
  /** Calls the event page made to the commands API and to storage.local, in order. */
  calls: string[];
  /** What it passed to console.warn. */
  warnings: string[];
}

/**
 * Runs the bundle with a `browser` that has every API the event page uses, minus `without`.
 * `menuShortcut` is the key Firefox reports for the toolbar-action command.
 */
async function run(
  without: string[],
  menuShortcut = "",
  refuseUpdate = false,
  store: Record<string, unknown> = {},
): Promise<Run> {
  const seen: string[] = [];
  const calls: string[] = [];
  const warnings: string[] = [];
  const event = (name: string) => ({ addListener: () => seen.push(name) });
  const browser: Record<string, unknown> = {
    runtime: {
      getURL: (p: string) => `moz-extension://uuid/${p}`,
      getManifest: () => ({
        version: "0.0.0",
        commands: { "start-capture": { suggested_key: { default: "Alt+Shift+S" } } },
      }),
      onMessage: event("runtime.onMessage"),
    },
    commands: {
      onCommand: event("commands.onCommand"),
      getAll: async () => [
        { name: "start-capture", shortcut: "Alt+Shift+S" },
        { name: "_execute_action", shortcut: menuShortcut },
      ],
      update: async (c: { name: string; shortcut: string }) => {
        if (refuseUpdate) throw new Error("Shortcut already in use");
        calls.push(`update:${c.name}:${c.shortcut}`);
      },
      reset: async (name: string) => void calls.push(`reset:${name}`),
    },
    downloads: { onChanged: event("downloads.onChanged") },
    storage: {
      local: {
        // A real store: what one start of the event page sets, the next one reads.
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (items: object) => {
          Object.assign(store, items);
          calls.push(`store:${JSON.stringify(items)}`);
        },
      },
    },
  };
  for (const api of without) delete browser[api];
  const console = { warn: (message: string) => warnings.push(message) };
  runInNewContext(await bundle, { browser, console, setTimeout, clearTimeout, URL });
  // The shortcut move is asynchronous; its stubs settle within microtasks.
  await new Promise((resolve) => setImmediate(resolve));
  return { seen: seen.sort(), calls, warnings };
}

test("background: desktop registers commands, messages and downloads listeners", async () => {
  const { seen } = await run([]);
  assert.deepEqual(seen, ["commands.onCommand", "downloads.onChanged", "runtime.onMessage"]);
});

test("background: without the commands API (Firefox for Android) the other listeners still register", async () => {
  const { seen, calls, warnings } = await run(["commands"]);
  assert.deepEqual(seen, ["downloads.onChanged", "runtime.onMessage"]);
  // Nothing to move there, and no warning on every start of the event page.
  assert.deepEqual(calls, []);
  assert.deepEqual(warnings, []);
});

test("background: a key left on the toolbar-action command moves to the capture command at startup", async () => {
  const { calls } = await run([], "Alt+Shift+Y");
  assert.deepEqual(calls, [
    "update:start-capture:Alt+Shift+Y",
    "reset:_execute_action",
    'store:{"legacyShortcutMoved":true}',
  ]);
});

test("background: with no key on the toolbar-action command no shortcut is touched", async () => {
  const { calls } = await run([]);
  assert.deepEqual(calls, ['store:{"legacyShortcutMoved":true}']);
});

test("background: a refused shortcut move is reported and costs no listener", async () => {
  const { seen, calls, warnings } = await run([], "Alt+Shift+Y", true);
  assert.deepEqual(seen, ["commands.onCommand", "downloads.onChanged", "runtime.onMessage"]);
  // Not marked done, so the next start tries again.
  assert.deepEqual(calls, []);
  // (The error comes from outside the bundle's realm, so it is not an `instanceof Error` there.)
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /^snapii: legacy shortcut not moved: .*Shortcut already in use$/);
});

test("background: the next start after the move reads the flag and touches nothing", async () => {
  const store: Record<string, unknown> = {};
  const first = await run([], "Alt+Shift+Y", false, store);
  assert.equal(first.calls.length, 3);
  // The same profile, the event page woken again, the menu command still reporting its key.
  const second = await run([], "Alt+Shift+Y", false, store);
  assert.deepEqual(second.calls, []);
});
