// SPDX-License-Identifier: GPL-3.0-or-later
// OCR in Chromium: a service worker cannot start the Tesseract worker (C1 in
// src/shared/spike.ts), so the pass runs in the offscreen document (C8). The
// fixture's images (an <img>, a CSS background, a photo under a DOM caption)
// are saved and the file shows what Tesseract added; Copy text takes the same
// words to the clipboard.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NON_SECURE_HOST, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/ocr.html";
// Document CSS px of #cap, see the fixture.
const CAP = { x: 40, y: 40, width: 900, height: 560 };
// A save with OCR waits for the engine as well.
const SAVE_MS = 60_000;

let g;
let reader;
before(async () => {
  g = await startGlue(4);
  reader = `${g.base}/fixtures/smoke.html`;
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

/**
 * Drags over `rect` on the fixture at `origin`, clicks Copy text and returns
 * the clipboard once the copy's last toast is up. Not a check that the write
 * needs no user activation: the click's (five seconds here, and no switch
 * shortens it) outlasts the pass on this page, and the grant the clipboard
 * helpers give the reader's origin covers the fixture on `g.base` too.
 */
async function copyRegion(rect, origin = g.base) {
  await g.writeClipboard(reader, "before the copy");
  await g.open(`${origin}${PAGE}`);
  await g.until(async () => (await g.content("return document.documentElement.dataset.ready;")) === "1", "images");
  await g.startOverlay();
  await g.drag(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  await g.clickToolbar("copy-text");
  const toasts = new Set();
  await g.until(
    async () => {
      const toast = await g.toast();
      if (toast) toasts.add(toast);
      return toast !== null && !toast.startsWith("Copying");
    },
    "the copy's toast",
    SAVE_MS,
  );
  return { clip: await g.readClipboard(reader), toasts: [...toasts] };
}

test("OCR on: Copy text puts the images' words on the clipboard with the DOM text, and the overlay is back", async () => {
  const { clip, toasts } = await copyRegion(CAP);
  const plain = clip["text/plain"] ?? "";
  const known = await g.content("return window.OCR_WORDS;");
  const expected = wordsOf([...known.img, ...known.banner, ...known.photo]);
  const got = wordsOf([plain]);
  const hits = expected.filter((w) => got.includes(w));
  console.log(
    `copy with ocr: ${hits.length}/${expected.length} known words; toasts ${JSON.stringify(toasts)}; text ${JSON.stringify(plain)}`,
  );
  assert.equal(toasts.at(-1), "Copied text");
  assert.ok(hits.length >= 0.8 * expected.length, `recognised ${hits.length} of ${expected.length}`);
  assert.ok(plain.includes("This paragraph is real DOM text next to the images."), plain);
  // DOM text wins: the caption over the photo is there once.
  assert.equal(got.filter((w) => w === "Hallstatt").length, 1, plain);
  assert.ok((clip["text/html"] ?? "").includes("Köln"), clip["text/html"]);
  // The overlay is back for a Save, nothing of snapii's is left over the page.
  assert.equal(await g.overlayPresent(), true);
  assert.equal(await g.content(`return document.querySelectorAll("snapii-shield").length;`), 0);
  await g.key("Escape");
  await g.until(async () => !(await g.offscreenOpen()), "the offscreen document to be closed");
});

test("OCR on: Copy text on a non-secure origin takes a cut word in an image whole; the pass and the write share the offscreen document", async () => {
  const origin = `http://${NON_SECURE_HOST}:${new URL(g.base).port}`;
  // "Willkommen in Köln", 16 px into #img (40, 40), baseline at y 80: from
  // the middle of Willkommen to the middle of Köln, the height of that line only.
  await g.open(`${origin}${PAGE}`);
  const [first, last] = await g.content(
    `const ctx = document.createElement("canvas").getContext("2d");
     ctx.font = "26px Helvetica, Arial, sans-serif";
     const at = (lead, word) => ({ x: 56 + ctx.measureText(lead).width, width: ctx.measureText(word).width });
     return [at("", "Willkommen"), at("Willkommen in ", "Köln")];`,
  );
  const from = first.x + first.width / 2;
  const { clip, toasts } = await copyRegion(
    { x: from, y: 64, width: last.x + last.width / 2 - from, height: 20 },
    origin,
  );
  const plain = clip["text/plain"] ?? "";
  console.log(`copy with ocr, cut words: ${JSON.stringify(plain)}; toasts ${JSON.stringify(toasts)}`);
  assert.equal(toasts.at(-1), "Copied text");
  const got = wordsOf([plain]);
  assert.ok(got.includes("Willkommen"), plain);
  assert.ok(got.includes("Köln"), plain);
  for (const w of ["Straßenbahn", "Quick", "Summer", "Hallstatt", "paragraph"]) assert.ok(!got.includes(w), plain);
  await g.key("Escape");
  await g.until(async () => !(await g.offscreenOpen()), "the offscreen document to be closed");
});

test("OCR off: Copy text copies the DOM text alone, without a capture or an offscreen document", async () => {
  await g.setSettings({ ocr: false });
  const { clip, toasts } = await copyRegion(CAP);
  assert.deepEqual(toasts, ["Copied text"]);
  assert.equal(
    clip["text/plain"],
    "Photo taken near Hallstatt\n\nThis paragraph is real DOM text next to the images.",
  );
  assert.equal(await g.offscreenOpen(), false);
  await g.key("Escape");
});

test("OCR off: no OCR layer, no offscreen document", async () => {
  await g.setSettings({ ocr: false });
  const save = await saveCap();
  const file = await save.file();
  assert.equal(file.svg.capture.ocr.status, "disabled");
  assert.deepEqual(layerRuns(file.text, "ocr"), []);
  assert.equal(await g.offscreenOpen(), false);
});
