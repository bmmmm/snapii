// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text's recognition over Chromium's capture: the viewport and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureViewportRegion, type ViewportCaptureDeps } from "../../../src/background/chromium/capture.ts";
import { type RecognizeDeps, recognize } from "../../../src/background/recognize.ts";
import { ocrInfo } from "../../../src/shared/ocr.ts";
import { readingExtent } from "../../../src/shared/recognized.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { DocRect, RecognizeRequest } from "../../../src/shared/types.ts";
import { visibleRect } from "../../../src/shared/viewport.ts";

const TAB = { id: 7, windowId: 3, active: true };
const PAGE = {
  viewport: { width: 1000, height: 713 },
  scroll: { x: 0, y: 1000 },
  devicePixelRatio: 3,
};

/** The handler over a stubbed browser whose viewport picture is 3000 × 2139. */
function deps() {
  const log: string[] = [];
  const browser: ViewportCaptureDeps = {
    async getTab() {
      return TAB;
    },
    async captureVisibleTab() {
      log.push("capture");
      return "data:viewport";
    },
    async getZoom() {
      return 1.5;
    },
    async getScroll() {
      return PAGE.scroll;
    },
    async crop(_dataURL, plan) {
      const crops = plan({ width: 3000, height: 2139 });
      for (const crop of crops) log.push(`crop:${JSON.stringify(crop.source)}`);
      return crops.map((planned, i) => ({ dataURL: `data:cropped${i}`, planned }));
    },
  };
  const d: RecognizeDeps = {
    loadSettings: async () => ({ ...DEFAULT_SETTINGS, ocr: true }),
    captureRegion: (tabId, windowId, region, settings, page) =>
      captureViewportRegion(tabId, windowId, region, settings, page, browser),
    async tellTab(_tabId, message) {
      log.push(`tell:${message.type}`);
    },
    async recognize(areas, tiles) {
      log.push(`ocr:${areas.length}:${JSON.stringify(tiles.map((t) => [t.width, t.height]))}`);
      return {
        runs: [],
        wordWidths: [],
        info: ocrInfo("ok", {
          areas: areas.length,
          recognized: areas.length,
          truncated: false,
          words: 0,
          ms: 1,
        }),
      };
    },
  };
  return { d, log };
}

const requestFor = (area: DocRect): RecognizeRequest => ({
  region: area,
  areas: [{ x: 0, y: 0, width: area.width, height: area.height, kind: "img" }],
  runs: [],
  page: PAGE,
});

test("recognize in Chromium: of an image that runs out of the viewport, the part in it is captured and read", async () => {
  // A selection near the viewport's lower edge (1713) on an image that ends 187 px below it.
  const selection = { x: 100, y: 1650, width: 300, height: 40 };
  const image = { x: 50, y: 1500, width: 600, height: 400 };
  const area = readingExtent(image, selection, visibleRect(PAGE), PAGE.devicePixelRatio);
  assert.deepEqual(area, { x: 50, y: 1500, width: 600, height: 213 });
  const { d, log } = deps();
  const reply = await recognize(requestFor(area as DocRect), TAB, d);
  assert.deepEqual(reply, { ok: true, runs: [] });
  assert.deepEqual(log, [
    "capture",
    'crop:{"x":150,"y":1500,"width":1800,"height":639}',
    "tell:captured",
    "ocr:1:[[600,213]]",
  ]);
});

test("recognize in Chromium: a request for more than the viewport is refused before any capture", async () => {
  // What the content script would send had it not cut the image to the viewport.
  const { d, log } = deps();
  const reply = await recognize(requestFor({ x: 50, y: 1500, width: 600, height: 400 }), TAB, d);
  assert.deepEqual([reply.ok, !reply.ok && reply.error], [false, "capture-failed"]);
  assert.deepEqual(log, []);
});
