// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { OutsideViewportError, TooLargeError } from "../../src/background/capture.ts";
import { type RecognizeDeps, recognize } from "../../src/background/recognize.ts";
import { lineToRuns, ocrInfo } from "../../src/shared/ocr.ts";
import { recognizedIn } from "../../src/shared/recognized.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { OcrOutput, OcrStatus, RasterTile, RecognizeRequest, Settings } from "../../src/shared/types.ts";

const TAB = { id: 7, windowId: 3, active: true };

const TILE: RasterTile = {
  x: 0,
  y: 0,
  width: 320,
  height: 90,
  dataURL: "data:image/png;base64,AAAA",
  pixelWidth: 640,
  pixelHeight: 180,
  format: "png",
};

const request = (): RecognizeRequest => ({
  region: { x: 40, y: 300, width: 320, height: 90 },
  areas: [{ x: 0, y: 0, width: 320, height: 90, kind: "img" }],
  runs: [],
  page: { viewport: { width: 1280, height: 715 }, scroll: { x: 0, y: 120 }, devicePixelRatio: 2 },
});

const word = (text: string, x: number, width: number) => ({
  text,
  confidence: 90,
  x,
  y: 30,
  width,
  height: 20,
  baseline: 46,
});

/** A pass that read "Summer Sale" with a wide gap between the words. */
function read(status: OcrStatus = "ok"): OcrOutput {
  const words = [word("Summer", 10, 100), word("Sale", 200, 60)];
  const ok = status === "ok";
  return {
    runs: ok ? lineToRuns(words, 0, 0) : [],
    ...(ok ? { wordWidths: words.map((w) => w.width) } : {}),
    info: ocrInfo(status, { areas: 1, recognized: ok ? 1 : 0, truncated: false, words: ok ? 2 : 0, ms: 1 }),
  };
}

/** Stubbed browser calls, each logged in the order they start. */
function deps(settings: Partial<Settings> = { ocr: true }, o: { capture?: Error; pass?: OcrOutput } = {}) {
  const log: string[] = [];
  const d: RecognizeDeps = {
    async loadSettings() {
      log.push("settings");
      return { ...DEFAULT_SETTINGS, ...settings };
    },
    async captureRegion(tabId, windowId, region, _settings, page) {
      log.push(`capture:${tabId}:${windowId}:${JSON.stringify(region)}:${JSON.stringify(page.scroll)}`);
      await Promise.resolve();
      if (o.capture) throw o.capture;
      log.push("capture:last-tile");
      return { tiles: [TILE], scale: 2, zoom: 1 };
    },
    async tellTab(tabId, message) {
      log.push(`tell:${tabId}:${JSON.stringify(message)}`);
    },
    async recognize(areas, tiles, runs) {
      log.push(`ocr:${areas.length}:${tiles.length}:${runs.length}`);
      return o.pass ?? read();
    },
  };
  return { d, log };
}

test("recognize: the request's region is captured, the tab hears `captured`, then the areas are read", async () => {
  const { d, log } = deps();
  const reply = await recognize(request(), TAB, d);
  assert.deepEqual(log, [
    "settings",
    'capture:7:3:{"x":40,"y":300,"width":320,"height":90}:{"x":0,"y":120}',
    "capture:last-tile",
    'tell:7:{"type":"captured","ocr":true}',
    "ocr:1:1:0",
  ]);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.ok && reply.runs.map((r) => r.text), ["Summer ", "Sale"]);
});

test("recognize: the DOM text on the images goes to the pass, which drops the words lying on it", async () => {
  const { d, log } = deps();
  const [onImage] = lineToRuns([word("Caption", 10, 80)], 0, 0);
  assert.ok(onImage);
  await recognize({ ...request(), runs: [onImage] }, TAB, d);
  assert.equal(log.at(-1), "ocr:1:1:1");
});

test("recognize: each run comes back as wide as its word, not as its hit area in a saved file", async () => {
  const { d } = deps();
  const reply = await recognize(request(), TAB, d);
  assert.ok(reply.ok);
  // In the pass's runs "Summer" reaches on to where "Sale" starts (190 px).
  assert.deepEqual(
    read().runs.map((r) => r.width),
    [190, 60],
  );
  assert.deepEqual(
    reply.runs.map((r) => [r.x, r.width]),
    [
      [10, 100],
      [200, 60],
    ],
  );
  // A selection that starts in the gap takes "Sale" alone.
  const inGap = { x: 150, y: 0, width: 200, height: 90 };
  assert.deepEqual(
    recognizedIn(reply.runs, inGap).map((r) => r.text),
    ["Sale"],
  );
  assert.deepEqual(
    recognizedIn(read().runs, inGap).map((r) => r.text),
    ["Summer ", "Sale"],
  );
});

test("recognize: a pass without word widths keeps its runs' widths", async () => {
  const { runs, info } = read();
  const { d } = deps({ ocr: true }, { pass: { runs, info } });
  const reply = await recognize(request(), TAB, d);
  assert.deepEqual(reply.ok && reply.runs.map((r) => r.width), [190, 60]);
});

test("recognize: with the setting off nothing is captured and nothing read", async () => {
  const { d, log } = deps({ ocr: false });
  assert.deepEqual(await recognize(request(), TAB, d), { ok: false, error: "disabled" });
  assert.deepEqual(log, ["settings"]);
});

test("recognize: a failed capture is the reply, without `captured` and without a pass", async () => {
  for (const error of [
    new Error("tab changed during capture"),
    new TooLargeError("too big"),
    new OutsideViewportError(),
  ]) {
    const { d, log } = deps({ ocr: true }, { capture: error });
    const reply = await recognize(request(), TAB, d);
    assert.deepEqual(reply, { ok: false, error: "capture-failed", detail: error.message });
    assert.equal(log.length, 2, log.join(" "));
  }
});

test("recognize: a pass that ran out of time or failed says so, after `captured`", async () => {
  for (const status of ["timeout", "failed"] as const) {
    const { d, log } = deps({ ocr: true }, { pass: read(status) });
    assert.deepEqual(await recognize(request(), TAB, d), { ok: false, error: status });
    assert.ok(log.includes('tell:7:{"type":"captured","ocr":true}'), log.join(" "));
  }
});

test("recognize: an image without words is an empty answer, not a failure", async () => {
  const none = { runs: [], wordWidths: [], info: read().info };
  const { d } = deps({ ocr: true }, { pass: none });
  assert.deepEqual(await recognize(request(), TAB, d), { ok: true, runs: [] });
});

test("recognize: only the selected tab of a known window is captured", async () => {
  for (const tab of [
    undefined,
    { windowId: 3, active: true },
    { id: 7, active: true },
    { ...TAB, active: false },
  ]) {
    const { d, log } = deps();
    const reply = await recognize(request(), tab, d);
    assert.deepEqual([reply.ok, !reply.ok && reply.error], [false, "capture-failed"]);
    assert.deepEqual(log, []);
  }
});

test("recognize: a tab that went away before `captured` could be told does not fail the reply", async () => {
  const { d } = deps();
  d.tellTab = async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  };
  assert.equal((await recognize(request(), TAB, d)).ok, true);
});
