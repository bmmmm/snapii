// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { OutsideViewportError, TAB_CHANGED } from "../../../src/background/capture.ts";
import {
  captureViewportPatches,
  captureViewportRegion,
  type ViewportCaptureDeps,
} from "../../../src/background/chromium/capture.ts";
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
function deps(
  tabAt: (n: number) => { active: boolean; windowId?: number } = () => selected,
  scrollAfter = PAGE.scroll,
) {
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
    async getScroll() {
      log.push("scroll");
      return scrollAfter;
    },
    async crop(dataURL, plan, settings) {
      assert.equal(dataURL, "data:viewport");
      const crops = plan({ width: 3000, height: 2139 });
      for (const crop of crops) log.push(`crop:${settings.format}:${JSON.stringify(crop.source)}`);
      return crops.map((planned, i) => ({ dataURL: `data:cropped${i}`, planned }));
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
    "scroll",
    'crop:png:{"x":300,"y":600,"width":900,"height":600}',
  ]);
  assert.deepEqual(result.tiles, [
    {
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      dataURL: "data:cropped0",
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

test("captureViewportRegion: a page that scrolled between its measurement and the capture fails the capture", async () => {
  // The crop would cut the pixels of another place out of the picture.
  const { d, log } = deps(() => selected, { x: 0, y: 1040 });
  const region = { x: 100, y: 1200, width: 300, height: 200 };
  await assert.rejects(
    captureViewportRegion(TAB, WINDOW, region, DEFAULT_SETTINGS, PAGE, d),
    /the page scrolled during the capture/,
  );
  assert.equal(
    log.some((l) => l.startsWith("crop")),
    false,
  );
});

// A vector capture's patches, region-relative; the region starts in the viewport.
const VREGION = { x: 100, y: 1200, width: 600, height: 2000 };

test("captureViewportPatches: one capture for all patches, each cut out and placed region-relative", async () => {
  const { d, log } = deps();
  const patches = [
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 200, y: 100, width: 50, height: 20 },
  ];
  const result = await captureViewportPatches(TAB, WINDOW, VREGION, patches, DEFAULT_SETTINGS, PAGE, d);
  assert.deepEqual(log, [
    "get:ok",
    "capture",
    "get:ok",
    "scroll",
    'crop:png:{"x":300,"y":600,"width":300,"height":150}',
    'crop:png:{"x":900,"y":900,"width":150,"height":60}',
  ]);
  assert.deepEqual(
    result.tiles.map(({ x, y, width, height, dataURL }) => ({ x, y, width, height, dataURL })),
    [
      { x: 0, y: 0, width: 100, height: 50, dataURL: "data:cropped0" },
      { x: 200, y: 100, width: 50, height: 20, dataURL: "data:cropped1" },
    ],
  );
  assert.equal(result.scale, 2);
  assert.equal(result.zoom, 1.5);
});

test("captureViewportPatches: over the pixel budget, every patch shrinks by the same factor", async () => {
  const { d } = deps();
  const patches = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 0, width: 100, height: 50 },
  ];
  // 300x300 + 300x150 device px = 135 000; a quarter of that budget halves each side.
  const settings = { ...DEFAULT_SETTINGS, maxTotalPixels: 135_000 / 4 };
  const result = await captureViewportPatches(TAB, WINDOW, VREGION, patches, settings, PAGE, d);
  const factors = result.tiles.map((t) => t.pixelWidth / (t.width * PAGE.devicePixelRatio));
  assert.deepEqual(factors, [0.5, 0.5]);
});

test("captureViewportPatches: the recorded scale is the shared shrink, not that of a one-pixel crop", async () => {
  const { d } = deps();
  const patches = [
    // One device px wide at dpr 3: it keeps its pixel whatever the shrink.
    { x: 0, y: 0, width: 1 / 3, height: 100 },
    { x: 200, y: 0, width: 100, height: 100 },
  ];
  const settings = { ...DEFAULT_SETTINGS, maxTotalPixels: (300 + 90_000) / 4 };
  const result = await captureViewportPatches(TAB, WINDOW, VREGION, patches, settings, PAGE, d);
  // Half of 3 device px per CSS px, of which 1.5 is zoom.
  assert.equal(result.scale, 1);
});

test("captureViewportPatches: a patch beyond the viewport is refused before any capture", async () => {
  const { d, log } = deps();
  const patches = [
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 0, y: 600, width: 100, height: 50 },
  ];
  await assert.rejects(
    captureViewportPatches(TAB, WINDOW, VREGION, patches, DEFAULT_SETTINGS, PAGE, d),
    OutsideViewportError,
  );
  assert.deepEqual(log, []);
});

test("captureViewportPatches: a patch of no device pixel (rounding noise at a zoom) is left out, not a failed save", async () => {
  const { d } = deps();
  const patches = [
    { x: 0, y: 0, width: 100, height: 50 },
    // At the region's right edge, as the scene builder leaves a neighbour's 1-ulp overlap.
    { x: 300, y: 0, width: 2.8e-14, height: 50 },
    // And one along an edge below.
    { x: 0, y: 300, width: 50, height: 3e-14 },
  ];
  const result = await captureViewportPatches(TAB, WINDOW, VREGION, patches, DEFAULT_SETTINGS, PAGE, d);
  assert.deepEqual(
    result.tiles.map(({ x, y, width, height }) => ({ x, y, width, height })),
    [{ x: 0, y: 0, width: 100, height: 50 }],
  );
});

test("captureViewportPatches: no patches, no capture, and still a finite scale (the region may leave the viewport)", async () => {
  const { d, log } = deps();
  const result = await captureViewportPatches(TAB, WINDOW, VREGION, [], DEFAULT_SETTINGS, PAGE, d);
  assert.deepEqual(log, []);
  assert.deepEqual(result.tiles, []);
  assert.equal(result.zoom, 1.5);
  assert.equal(result.scale, 2);
});
