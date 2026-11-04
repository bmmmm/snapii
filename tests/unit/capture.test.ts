// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CaptureDeps,
  capturePatches,
  captureRegion,
  captureTiles,
  imageDetails,
  TAB_CHANGED,
} from "../../src/background/capture.ts";
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

/**
 * The real `browser` and window globals, stubbed: a screen of devicePixelRatio
 * 2 and the page at 150 % zoom, so the planner works in 3 device px per CSS px
 * while captureVisibleTab is asked for scale 2 (it applies the zoom itself, S6).
 */
function stubBrowser() {
  const calls: { rect: { x: number; y: number; width: number; height: number }; scale: number }[] = [];
  Object.assign(globalThis, {
    devicePixelRatio: 2,
    browser: {
      tabs: {
        getZoom: async () => 1.5,
        get: async () => selected,
        captureVisibleTab: async (_windowId: number, details: (typeof calls)[number]) => {
          calls.push({ rect: details.rect, scale: details.scale });
          return "data:image/png;base64,AA==";
        },
      },
    },
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  });
  return calls;
}

// 300 device px wide at 3 device px per CSS px: a band of 90 000 px is 100 CSS px high.
const ZOOM_SETTINGS = { ...DEFAULT_SETTINGS, maxTilePixels: 90_000 };

test("captureRegion: at a page zoom the plan has scale × zoom device px per CSS px, the call gets scale", async () => {
  const calls = stubBrowser();
  const result = await captureRegion(TAB, WINDOW, { x: 0, y: 0, width: 100, height: 200 }, ZOOM_SETTINGS);
  assert.deepEqual(calls, [
    { rect: { x: 0, y: 0, width: 100, height: 100 }, scale: 2 },
    { rect: { x: 0, y: 100, width: 100, height: 100 }, scale: 2 },
  ]);
  assert.equal(result.scale, 2);
  assert.equal(result.zoom, 1.5);
});

test("capturePatches: at a page zoom each patch is planned in scale × zoom device px per CSS px", async () => {
  const calls = stubBrowser();
  const region = { x: 50, y: 400, width: 300, height: 300 };
  const result = await capturePatches(
    TAB,
    WINDOW,
    region,
    [{ x: 10, y: 20, width: 100, height: 200 }],
    ZOOM_SETTINGS,
  );
  assert.deepEqual(calls, [
    { rect: { x: 60, y: 420, width: 100, height: 100 }, scale: 2 },
    { rect: { x: 60, y: 520, width: 100, height: 100 }, scale: 2 },
  ]);
  assert.deepEqual(
    result.tiles.map((t) => [t.x, t.y, t.width, t.height]),
    [
      [10, 20, 100, 100],
      [10, 120, 100, 100],
    ],
  );
  assert.equal(result.scale, 2);
});

test("imageDetails: JPEG asks for the set quality in percent, PNG for none", () => {
  const [tile] = PLAN as [PlannedTile];
  assert.deepEqual(imageDetails(tile, 2, { ...DEFAULT_SETTINGS, format: "jpeg", jpegQuality: 0.856 }), {
    rect: tile.doc,
    scale: 2,
    format: "jpeg",
    quality: 86,
  });
  assert.deepEqual(imageDetails(tile, 2, { ...DEFAULT_SETTINGS, format: "png" }), {
    rect: tile.doc,
    scale: 2,
    format: "png",
  });
  assert.equal(imageDetails(tile, 1, { ...DEFAULT_SETTINGS, format: "jpeg", jpegQuality: 0.8 }).quality, 80);
});

test("captureRegion: a region of no CSS pixel is refused, nothing is captured", async () => {
  const calls = stubBrowser();
  await assert.rejects(
    captureRegion(TAB, WINDOW, { x: 5, y: 5, width: 0, height: 0 }, ZOOM_SETTINGS),
    /the selected region is empty/,
  );
  assert.deepEqual(calls, []);
});

test("capturePatches: no patches, no capture, and still the region's scale and zoom", async () => {
  const calls = stubBrowser();
  const result = await capturePatches(
    TAB,
    WINDOW,
    { x: 0, y: 0, width: 100, height: 100 },
    [],
    ZOOM_SETTINGS,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { tiles: [], scale: 2, zoom: 1.5 });
  // One patch of one tile is captured too.
  const one = await capturePatches(
    TAB,
    WINDOW,
    { x: 0, y: 0, width: 100, height: 100 },
    [{ x: 1, y: 2, width: 3, height: 4 }],
    ZOOM_SETTINGS,
  );
  assert.deepEqual(calls, [{ rect: { x: 1, y: 2, width: 3, height: 4 }, scale: 2 }]);
  assert.equal(one.tiles.length, 1);
});
