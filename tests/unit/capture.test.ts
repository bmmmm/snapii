// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CaptureDeps, captureTiles, TAB_CHANGED } from "../../src/background/capture.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import { type PlannedTile, planTiles } from "../../src/shared/tiles.ts";

const TAB = 7;
const WINDOW = 3;
const target = { tabId: TAB, windowId: WINDOW };
// Three bands: the tab can change between any two of them.
const PLAN: PlannedTile[] = planTiles({ x: 0, y: 0, width: 100, height: 300 }, 1, {
  maxSide: 100,
  maxArea: 1e9,
  maxTilePixels: 1e9,
});

type Tab = { active: boolean; windowId?: number };

/**
 * Stubbed browser; `tabAt(n)` is the tab state the n-th tabs.get sees, so a
 * test can switch tabs at any point of the capture.
 */
function deps(tabAt: (n: number) => Tab) {
  const log: string[] = [];
  let gets = 0;
  const d: CaptureDeps = {
    async getTab(tabId) {
      assert.equal(tabId, TAB);
      const tab = tabAt(gets++);
      log.push(`get:${tab.active && tab.windowId === WINDOW ? "ok" : "changed"}`);
      return tab;
    },
    async captureVisibleTab(windowId, details) {
      assert.equal(windowId, WINDOW);
      log.push(`capture:${details.rect.y}`);
      return `data:${details.rect.y}`;
    },
    async pixelSize() {
      return { width: 100, height: 100 };
    },
  };
  return { d, log };
}

const selected: Tab = { active: true, windowId: WINDOW };

test("captureTiles: checks the tab before every capture and after the last", async () => {
  assert.equal(PLAN.length, 3);
  const { d, log } = deps(() => selected);
  const tiles = await captureTiles(target, PLAN, 1, DEFAULT_SETTINGS, d);
  assert.deepEqual(
    tiles.map((t) => t.dataURL),
    ["data:0", "data:100", "data:200"],
  );
  assert.deepEqual(log, ["get:ok", "capture:0", "get:ok", "capture:100", "get:ok", "capture:200", "get:ok"]);
});

test("captureTiles: a tab switch mid-capture aborts before the next tile", async () => {
  // Switched away after the first tile (another tab of the same window is selected).
  const { d, log } = deps((n) => (n >= 1 ? { active: false, windowId: WINDOW } : selected));
  await assert.rejects(captureTiles(target, PLAN, 1, DEFAULT_SETTINGS, d), new Error(TAB_CHANGED));
  assert.deepEqual(log, ["get:ok", "capture:0", "get:changed"]);
});

test("captureTiles: a tab switch during the last tile fails the capture", async () => {
  const { d, log } = deps((n) => (n >= 3 ? { active: false, windowId: WINDOW } : selected));
  await assert.rejects(captureTiles(target, PLAN, 1, DEFAULT_SETTINGS, d), new Error(TAB_CHANGED));
  assert.deepEqual(log.at(-1), "get:changed");
  assert.equal(log.filter((l) => l.startsWith("capture")).length, 3);
});

test("captureTiles: the tab moved to another window aborts too", async () => {
  // Still active, but in another window: captureVisibleTab(WINDOW) would take
  // whatever is now selected in the old one.
  const { d, log } = deps((n) => (n >= 2 ? { active: true, windowId: WINDOW + 1 } : selected));
  await assert.rejects(captureTiles(target, PLAN, 1, DEFAULT_SETTINGS, d), new Error(TAB_CHANGED));
  assert.deepEqual(log, ["get:ok", "capture:0", "get:ok", "capture:100", "get:changed"]);
});

test("captureTiles: a tab not selected at the start captures nothing", async () => {
  const { d, log } = deps(() => ({ active: false, windowId: WINDOW }));
  await assert.rejects(captureTiles(target, PLAN, 1, DEFAULT_SETTINGS, d), new Error(TAB_CHANGED));
  assert.deepEqual(log, ["get:changed"]);
});
