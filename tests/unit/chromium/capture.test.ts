// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { OutsideViewportError, TAB_CHANGED } from "../../../src/background/capture.ts";
import { captureViewportRegion, type ViewportCaptureDeps } from "../../../src/background/chromium/capture.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";

const TAB = 7;
const WINDOW = 3;
const PAGE = {
  viewport: { width: 1000, height: 713 },
  scroll: { x: 0, y: 1000 },
  devicePixelRatio: 3,
};
const selected = { active: true, windowId: WINDOW };

/** Stubbed browser: a 3000 × 2139 picture of the viewport (device scale factor 2 at zoom 1.5). */
function deps(tabAt: (n: number) => { active: boolean; windowId?: number } = () => selected) {
  const log: string[] = [];
  let gets = 0;
  const d: ViewportCaptureDeps = {
    async getTab(tabId) {
      assert.equal(tabId, TAB);
      const tab = tabAt(gets++);
      log.push(`get:${tab.active && tab.windowId === WINDOW ? "ok" : "changed"}`);
      return tab;
    },
    async captureVisibleTab(windowId) {
      assert.equal(windowId, WINDOW);
      log.push("capture");
      return "data:viewport";
    },
    async getZoom() {
      return 1.5;
    },
    async crop(dataURL, plan, settings) {
      assert.equal(dataURL, "data:viewport");
      const crop = plan({ width: 3000, height: 2139 });
      log.push(`crop:${settings.format}:${JSON.stringify(crop.source)}`);
      return { dataURL: "data:cropped", crop };
    },
  };
  return { d, log };
}

test("captureViewportRegion: one capture of the viewport, cropped to the region", async () => {
  const { d, log } = deps();
  const region = { x: 100, y: 1200, width: 300, height: 200 };
  const result = await captureViewportRegion(TAB, WINDOW, region, DEFAULT_SETTINGS, PAGE, d);
  assert.deepEqual(log, [
    "get:ok",
    "capture",
    "get:ok",
    'crop:png:{"x":300,"y":600,"width":900,"height":600}',
  ]);
  assert.deepEqual(result.tiles, [
    {
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      dataURL: "data:cropped",
      pixelWidth: 900,
      pixelHeight: 600,
      format: "png",
    },
  ]);
  // 3 device px per CSS px, of which 1.5 is the zoom: the record's scale is the rest.
  assert.equal(result.zoom, 1.5);
  assert.equal(result.scale, 2);
});

test("captureViewportRegion: a region reaching beyond the viewport is refused before any capture", async () => {
  const { d, log } = deps();
  const region = { x: 100, y: 1600, width: 300, height: 200 };
  await assert.rejects(
    captureViewportRegion(TAB, WINDOW, region, DEFAULT_SETTINGS, PAGE, d),
    OutsideViewportError,
  );
  assert.deepEqual(log, []);
});

test("captureViewportRegion: a tab switch during the capture fails it", async () => {
  const { d, log } = deps((n) => (n >= 1 ? { active: false, windowId: WINDOW } : selected));
  const region = { x: 100, y: 1200, width: 300, height: 200 };
  await assert.rejects(
    captureViewportRegion(TAB, WINDOW, region, DEFAULT_SETTINGS, PAGE, d),
    new Error(TAB_CHANGED),
  );
  assert.deepEqual(log, ["get:ok", "capture", "get:changed"]);
});

test("captureViewportRegion: the JPEG setting reaches the crop, which encodes the tile", async () => {
  const { d, log } = deps();
  const region = { x: 0, y: 1000, width: 10, height: 10 };
  const result = await captureViewportRegion(
    TAB,
    WINDOW,
    region,
    { ...DEFAULT_SETTINGS, format: "jpeg" },
    PAGE,
    d,
  );
  assert.equal(result.tiles[0]?.format, "jpeg");
  assert.match(log.at(-1) ?? "", /^crop:jpeg:/);
});
