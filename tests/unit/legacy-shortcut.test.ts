// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LegacyShortcutDeps, moveLegacyShortcut } from "../../src/background/legacy-shortcut.ts";

const DEFAULT_KEY = "Alt+Shift+S";

/** Stubbed browser calls, each logged in the order they start. */
function deps(state: { done?: boolean; menu?: string; capture?: string }, failAt?: "set" | "reset") {
  const log: string[] = [];
  const d: LegacyShortcutDeps = {
    async isDone() {
      log.push("isDone");
      return state.done ?? false;
    },
    async markDone() {
      log.push("markDone");
    },
    async menuShortcut() {
      log.push("menuShortcut");
      return state.menu ?? "";
    },
    async captureShortcut() {
      log.push("captureShortcut");
      return state.capture ?? DEFAULT_KEY;
    },
    captureDefault: DEFAULT_KEY,
    async setCaptureShortcut(shortcut) {
      log.push(`setCapture:${shortcut}`);
      if (failAt === "set") throw new Error("refused");
    },
    async resetMenuShortcut() {
      log.push("resetMenu");
      if (failAt === "reset") throw new Error("refused");
    },
  };
  return { d, log };
}

test("moveLegacyShortcut: a key left on the menu command moves to the capture command, then the menu is reset", async () => {
  const { d, log } = deps({ menu: "Alt+Shift+Y" });
  assert.equal(await moveLegacyShortcut(d), true);
  assert.deepEqual(log, [
    "isDone",
    "menuShortcut",
    "captureShortcut",
    "setCapture:Alt+Shift+Y",
    "resetMenu",
    "markDone",
  ]);
});

test("moveLegacyShortcut: a capture command without any key takes the legacy key too", async () => {
  const { d, log } = deps({ menu: "Alt+Shift+Y", capture: "" });
  await moveLegacyShortcut(d);
  assert.ok(log.includes("setCapture:Alt+Shift+Y"), log.join(" "));
});

test("moveLegacyShortcut: a capture key the user chose is kept; the stale menu key is still taken away", async () => {
  const { d, log } = deps({ menu: "Alt+Shift+Y", capture: "Alt+Shift+K" });
  assert.equal(await moveLegacyShortcut(d), true);
  assert.deepEqual(log, ["isDone", "menuShortcut", "captureShortcut", "resetMenu", "markDone"]);
});

test("moveLegacyShortcut: no key on the menu command changes nothing, and is remembered", async () => {
  const { d, log } = deps({ menu: "" });
  assert.equal(await moveLegacyShortcut(d), false);
  assert.deepEqual(log, ["isDone", "menuShortcut", "markDone"]);
});

test("moveLegacyShortcut: once done it reads nothing and touches nothing (a key bound later on purpose stays)", async () => {
  const { d, log } = deps({ done: true, menu: "Alt+Shift+Y" });
  assert.equal(await moveLegacyShortcut(d), false);
  assert.deepEqual(log, ["isDone"]);
});

test("moveLegacyShortcut: Firefox refusing the capture key leaves the menu key and the work open", async () => {
  const { d, log } = deps({ menu: "Alt+Shift+Y" }, "set");
  await assert.rejects(moveLegacyShortcut(d), /refused/);
  assert.deepEqual(log, ["isDone", "menuShortcut", "captureShortcut", "setCapture:Alt+Shift+Y"]);
});

test("moveLegacyShortcut: a failed reset is not marked done, so the next start repeats it", async () => {
  const { d, log } = deps({ menu: "Alt+Shift+Y" }, "reset");
  await assert.rejects(moveLegacyShortcut(d), /refused/);
  assert.deepEqual(log, ["isDone", "menuShortcut", "captureShortcut", "setCapture:Alt+Shift+Y", "resetMenu"]);
});
