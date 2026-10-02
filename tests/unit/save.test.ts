// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { TooLargeError } from "../../src/background/capture.ts";
import { type SaveDeps, save } from "../../src/background/save.ts";
import { makeFilename } from "../../src/shared/filename.ts";
import { OCR_DISABLED, ocrInfo } from "../../src/shared/ocr.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { CaptureModel, ImageArea, Settings } from "../../src/shared/types.ts";

const TAB = { id: 7, windowId: 3, active: true };

const model = (imageAreas?: ImageArea[]): CaptureModel => ({
  region: { x: 0, y: 0, width: 100, height: 50 },
  runs: [],
  links: [],
  page: {
    url: "https://example.com/",
    title: "Example",
    lang: null,
    textFragmentURL: null,
    textFragmentStatus: "DISABLED",
    viewport: { width: 1280, height: 715 },
    scroll: { x: 0, y: 0 },
    devicePixelRatio: 2,
    capturedAt: "2026-10-01T12:00:00.000Z",
    mode: "drag",
    skippedFrames: 0,
    skippedVertical: 0,
  },
  ...(imageAreas ? { imageAreas } : {}),
});

const AREA: ImageArea = { x: 0, y: 0, width: 50, height: 30, kind: "img" };

/** Stubbed browser calls, each logged in the order they start. */
function deps(settings: Partial<Settings> = {}, fail: { capture?: Error; download?: Error } = {}) {
  const log: string[] = [];
  const d: SaveDeps = {
    async loadSettings() {
      return { ...DEFAULT_SETTINGS, ...settings };
    },
    async captureRegion() {
      log.push("capture:start");
      await Promise.resolve();
      if (fail.capture) throw fail.capture;
      log.push("capture:last-tile");
      return { tiles: [], scale: 1, zoom: 1 };
    },
    async tellTab(tabId, message) {
      log.push(`tell:${tabId}:${JSON.stringify(message)}`);
    },
    async recognize() {
      log.push("ocr");
      return {
        runs: [],
        info: ocrInfo("ok", { areas: 1, recognized: 1, truncated: false, words: 0, ms: 1 }),
      };
    },
    render(input) {
      log.push(`render:${input.ocr?.info.status}`);
      return "<svg/>";
    },
    async saveSvg() {
      log.push("download");
      if (fail.download) throw fail.download;
    },
    extensionVersion: "0.1.0",
  };
  return { d, log };
}

test("save: the tab hears `captured` after the last tile and before OCR, rendering and download", async () => {
  const { d, log } = deps({ ocr: true });
  const reply = await save(model([AREA]), TAB, d);
  assert.equal(reply.ok, true);
  assert.deepEqual(log, [
    "capture:start",
    "capture:last-tile",
    'tell:7:{"type":"captured","ocr":true}',
    "ocr",
    "render:ok",
    "download",
  ]);
});

test("save: `captured` says ocr:false when no recognition runs (setting off, or no image areas)", async () => {
  const off = deps({ ocr: false });
  await save(model([AREA]), TAB, off.d);
  assert.deepEqual(off.log, [
    "capture:start",
    "capture:last-tile",
    'tell:7:{"type":"captured","ocr":false}',
    "render:disabled",
    "download",
  ]);
  const noAreas = deps({ ocr: true });
  await save(model([]), TAB, noAreas.d);
  assert.ok(noAreas.log.includes('tell:7:{"type":"captured","ocr":false}'), noAreas.log.join(" "));
});

test("save: a failed capture sends no `captured` (the overlay comes back for a retry)", async () => {
  for (const error of [new Error("tab changed during capture"), new TooLargeError("too big")]) {
    const { d, log } = deps({ ocr: true }, { capture: error });
    const reply = await save(model([AREA]), TAB, d);
    assert.equal(reply.ok, false);
    assert.deepEqual(log, ["capture:start"]);
  }
});

test("save: a failed download after `captured` is still reported", async () => {
  const { d, log } = deps({}, { download: new Error("Download canceled by the user") });
  const reply = await save(model(), TAB, d);
  assert.deepEqual(reply, { ok: false, error: "download-failed", detail: "Download canceled by the user" });
  assert.ok(log.some((l) => l.startsWith("tell:")));
});

test("save: the file goes into the folder setting, or straight into the download folder when it is empty", async () => {
  // Local time goes into the name, so the expectation is built, not typed.
  const name = makeFilename(model().page);
  for (const [saveFolder, path] of [
    ["", name],
    ["Pages/snapii", `Pages/snapii/${name}`],
  ] as const) {
    const { d } = deps({ saveFolder, saveAs: true });
    const calls: unknown[][] = [];
    d.saveSvg = async (...args) => void calls.push(args);
    const reply = await save(model(), TAB, d);
    // The path carries the folder; the name the page and toast know does not.
    assert.deepEqual(calls, [["<svg/>", path, true]]);
    assert.equal(reply.ok && reply.filename, name);
  }
});

test("save: a tab the window does not show is refused before anything is captured", async () => {
  const { d, log } = deps();
  const reply = await save(model(), { ...TAB, active: false }, d);
  assert.equal(reply.ok, false);
  assert.deepEqual(log, []);
  assert.equal(OCR_DISABLED.info.status, "disabled");
});

test("save: a tab that no longer listens does not fail the save", async () => {
  const { d } = deps();
  d.tellTab = () => Promise.reject(new Error("Could not establish connection"));
  assert.equal((await save(model(), TAB, d)).ok, true);
});
