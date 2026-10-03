// SPDX-License-Identifier: GPL-3.0-or-later
// OCR in Chromium: a service worker cannot start the Tesseract worker (C1 in
// src/shared/spike.ts), so the pass runs in the offscreen document (C8). The
// fixture's images (an <img>, a CSS background, a photo under a DOM caption)
// are saved and the file shows what Tesseract added.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/ocr.html";
// Document CSS px of #cap, see the fixture.
const CAP = { x: 40, y: 40, width: 900, height: 560 };
// A save with OCR waits for the engine as well.
const SAVE_MS = 60_000;

let g;
before(async () => {
  g = await startGlue(4);
});
after(async () => {
  await g?.close();
});

/** Texts of the runs inside <g id="..."> (one line in the file). */
function layerRuns(text, id) {
  const m = new RegExp(`<g id="${id}"[^>]*>(.*)</g>$`, "m").exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/<text [^>]*font-size[^>]*>([^<]*)<\/text>/g)].map((r) =>
    r[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
  );
}

const wordsOf = (strings) =>
  strings
    .join(" ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);

async function saveCap() {
  await g.open(PAGE);
  await g.until(async () => (await g.content("return document.documentElement.dataset.ready;")) === "1", "images");
  const before = g.svgFiles();
  await g.startOverlay();
  await g.drag(CAP.x, CAP.y, CAP.x + CAP.width, CAP.y + CAP.height);
  await g.key("Enter");
  return { before, file: () => g.newDownload(before, SAVE_MS) };
}

test("OCR on: the image words are selectable text in <g id=ocr>, recognised in the offscreen document", async () => {
  await g.setSettings({ ocr: true });
  const save = await saveCap();
  // The page is given back while Tesseract runs.
  assert.equal(await g.until(() => g.toast(), "the recognizing toast", SAVE_MS), "Saving… (recognizing text)");
  const file = await save.file();
  const known = await g.content("return window.OCR_WORDS;");
  const expected = wordsOf([...known.img, ...known.banner, ...known.photo]);
  const ocrRuns = layerRuns(file.text, "ocr");
  const got = new Set(wordsOf(ocrRuns));
  const hits = expected.filter((w) => got.has(w));
  const ocr = file.svg.capture.ocr;
  console.log(
    `ocr: ${hits.length}/${expected.length} known words; missed: ${expected.filter((w) => !got.has(w)).join(" ") || "none"}; ` +
      `record ${JSON.stringify(ocr)}`,
  );
  assert.equal(ocr.status, "ok");
  assert.equal(ocr.engine, "tesseract.js 7.0.0");
  assert.equal(ocr.areas, 3);
  assert.equal(ocr.recognized, 3);
  assert.equal(ocr.words, ocrRuns.length);
  assert.ok(hits.length >= 0.8 * expected.length, `recognised ${hits.length} of ${expected.length}`);
  // DOM text wins: the caption lies over the photo's pixels, OCR must not add it again.
  const all = wordsOf(file.svg.tspans);
  assert.equal(all.filter((w) => w === "Hallstatt").length, 1, `all words: ${all.join(" ")}`);
  // The document was only there for the pass.
  await g.until(async () => !(await g.offscreenOpen()), "the offscreen document to be closed");
});

test("OCR off: no OCR layer, no offscreen document", async () => {
  await g.setSettings({ ocr: false });
  const save = await saveCap();
  const file = await save.file();
  assert.equal(file.svg.capture.ocr.status, "disabled");
  assert.deepEqual(layerRuns(file.text, "ocr"), []);
  assert.equal(await g.offscreenOpen(), false);
});
