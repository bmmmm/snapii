// SPDX-License-Identifier: GPL-3.0-or-later
// OCR of text inside images (opt-in): the switch is flipped in the real
// options page, the fixture's images (an <img>, a CSS background, a photo
// under a DOM caption) are saved through the toolbar/overlay path, and the
// file shows what Tesseract added. Copy text takes the same words to the
// clipboard. Timings are logged, not asserted.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { clearClipboard, readClipboard } from "../../tools/marionette/helpers.mjs";
import { ADDON_ID, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/ocr.html";
// Document CSS px of #cap and #img, see the fixture.
const CAP = { x: 40, y: 40, width: 900, height: 560 };
const IMG = { x: 40, y: 40, width: 420, height: 150 };
// A save with OCR waits for the engine as well.
const SAVE_MS = 60_000;

let g;
let optionsUrl;
before(async () => {
  g = await startGlue(4);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
});
after(async () => {
  await g?.close();
});

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Sets the OCR checkbox in the options page by clicking it, as a user would. */
async function setOcr(on) {
  await g.open(optionsUrl);
  await g.until(
    async () => (await g.content(`return document.querySelector('input[name="format"]:checked')?.value;`)) != null,
    "the form to load",
  );
  if ((await g.content(`return document.querySelector('input[name="ocr"]').checked;`)) !== on) {
    const c = center(await g.rect('input[name="ocr"]'));
    await g.click(c.x, c.y);
    await g.until(
      async () => (await g.content(`return document.getElementById("status").textContent;`)) === "Saved",
      "the Saved status",
    );
  }
  const stored = await g.system(
    `return (async () => (await window.wrappedJSObject.browser.storage.sync.get("ocr")).ocr)();`,
  );
  assert.equal(stored ?? false, on);
}

/**
 * Page-side clock for the save: when Enter went in, when the hover shield
 * came and went (the page blocked, then given back), and every click that
 * reached #note.
 */
const PROBE = `
  const p = (window.__probe = { enter: null, shieldUp: null, free: null, clicks: [] });
  addEventListener("keydown", (e) => { if (e.key === "Enter" && p.enter === null) p.enter = performance.now(); }, true);
  new MutationObserver(() => {
    const up = document.querySelector("snapii-shield") !== null;
    if (up && p.shieldUp === null) p.shieldUp = performance.now();
    if (!up && p.shieldUp !== null && p.free === null) p.free = performance.now();
  }).observe(document.documentElement, { childList: true });
  document.getElementById("note").addEventListener("click", () => p.clicks.push(performance.now()));
`;

/**
 * Drags over `rect` (document = client coordinates, the page does not scroll)
 * and saves. With `whileSaving`, that runs once the page is given back and
 * before the file exists.
 */
async function saveRegion(rect, whileSaving) {
  await g.open(PAGE);
  await g.until(async () => (await g.content("return document.documentElement.dataset.ready;")) === "1", "images");
  await g.content(PROBE);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.drag(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  const t0 = Date.now();
  await g.key("Enter");
  const during = whileSaving ? await whileSaving(before) : undefined;
  const file = await g.newDownload(before, SAVE_MS);
  return { file, wallMs: Date.now() - t0, during };
}

/**
 * While OCR runs: the "recognizing" toast is up, the shield is gone, and a
 * real click on the page's paragraph reaches it before the file is written.
 */
async function clickDuringOcr(before) {
  const toast = await g.until(() => g.toast(), "the recognizing toast", SAVE_MS);
  const probe = await g.content("return window.__probe;");
  const note = await g.rect("#note");
  await g.click(note.x + 20, note.y + 10);
  const clicks = (await g.content("return window.__probe.clicks;")).length;
  const fileYet = g.svgFiles().some((f) => !before.includes(f));
  return {
    toast,
    clicks,
    fileYet,
    shieldUp: probe.shieldUp !== null,
    freeAfterEnterMs: probe.free === null ? null : Math.round(probe.free - probe.enter),
  };
}

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

test("OCR on: the image words are selectable text in <g id=ocr>, the DOM caption over the photo is there once", async () => {
  await setOcr(true);
  const { file, wallMs, during } = await saveRegion(CAP, clickDuringOcr);
  const known = await g.content("return window.OCR_WORDS;");
  const expected = wordsOf([...known.img, ...known.banner, ...known.photo]);
  const ocrRuns = layerRuns(file.text, "ocr");
  const got = new Set(wordsOf(ocrRuns));
  const hits = expected.filter((w) => got.has(w));
  const ocr = file.svg.capture.ocr;
  console.log(
    `ocr: ${hits.length}/${expected.length} known words (${((100 * hits.length) / expected.length).toFixed(1)} %); ` +
      `missed: ${expected.filter((w) => !got.has(w)).join(" ") || "none"}; ` +
      `extra: ${[...got].filter((w) => !expected.includes(w)).join(" ") || "none"}; ` +
      `record ${JSON.stringify(ocr)}; save wall time ${wallMs} ms; ` +
      `page given back ${during.freeAfterEnterMs} ms after Enter`,
  );
  // The page is usable while Tesseract runs: shield gone, a click lands, the file comes later.
  assert.equal(during.toast, "Saving… (recognizing text)");
  assert.ok(during.shieldUp, "guard: the shield was up during the capture");
  assert.notEqual(during.freeAfterEnterMs, null, "the shield went away before the file existed");
  assert.equal(during.clicks, 1, "the click on #note reached the page");
  assert.equal(during.fileYet, false, "guard: the click happened while the save was still running");
  assert.equal(ocr.status, "ok");
  assert.equal(ocr.engine, "tesseract.js 7.0.0");
  assert.deepEqual(ocr.langs, ["deu", "eng"]);
  assert.equal(ocr.areas, 3);
  assert.equal(ocr.recognized, 3);
  assert.equal(ocr.truncated, false);
  assert.equal(ocr.words, ocrRuns.length);
  assert.ok(hits.length >= 0.8 * expected.length, `recognised ${hits.length} of ${expected.length}`);

  // DOM text wins: the caption lies over the photo's pixels, OCR must not add it again.
  const all = wordsOf(file.svg.tspans);
  assert.equal(all.filter((w) => w === "Hallstatt").length, 1, `all words: ${all.join(" ")}`);
  for (const w of ["Photo", "taken", "near", "Hallstatt", "paragraph"]) assert.ok(!got.has(w), `OCR added ${w}`);
  assert.ok(wordsOf(layerRuns(file.text, "text")).includes("Hallstatt"), "the caption is in the DOM layer");

  // Selectable: select-all in the opened file reaches the OCR words.
  await g.open(pathToFileURL(file.path).href);
  await g.key("a", ["Meta"]);
  const selected = (await g.content("return getSelection().toString();")).replace(/\s+/g, " ");
  assert.ok(selected.includes("Straßenbahn"), `select-all text: ${selected}`);
});

test("OCR on: one image alone (latency of one area)", async () => {
  const { file, wallMs } = await saveRegion(IMG);
  const ocr = file.svg.capture.ocr;
  console.log(`ocr one area: record ${JSON.stringify(ocr)}; save wall time ${wallMs} ms`);
  assert.equal(ocr.status, "ok");
  assert.equal(ocr.areas, 1);
  assert.equal(ocr.recognized, 1);
  assert.ok(wordsOf(layerRuns(file.text, "ocr")).includes("Köln"));
});

/** Drags over `rect`, clicks Copy text and returns the clipboard once the copy's last toast is up. */
async function copyRegion(rect) {
  await g.open(PAGE);
  await g.until(async () => (await g.content("return document.documentElement.dataset.ready;")) === "1", "images");
  await clearClipboard(g.s);
  await g.startOverlay();
  await g.drag(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  const t0 = Date.now();
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
  const clip = await readClipboard(g.s);
  return { clip, toasts: [...toasts], wallMs: Date.now() - t0 };
}

/** Left edge and width (document px) of `word` after `lead` in #img's first line: 16 px into the picture, baseline at y 80. */
function inFirstLine(lead, word) {
  return g.content(
    `const ctx = document.createElement("canvas").getContext("2d");
     ctx.font = "26px Helvetica, Arial, sans-serif";
     return { x: 40 + 16 + ctx.measureText(arguments[0]).width, width: ctx.measureText(arguments[1]).width };`,
    lead,
    word,
  );
}

test("OCR on: Copy text puts the images' words on the clipboard with the DOM text, seconds after the click, and the overlay is back", async () => {
  const { clip, toasts, wallMs } = await copyRegion(CAP);
  const plain = clip["text/plain"] ?? "";
  const known = await g.content("return window.OCR_WORDS;");
  const expected = wordsOf([...known.img, ...known.banner, ...known.photo]);
  const got = wordsOf([plain]);
  const hits = expected.filter((w) => got.includes(w));
  console.log(
    `copy with ocr: ${hits.length}/${expected.length} known words; toasts ${JSON.stringify(toasts)}; ` +
      `wall time ${wallMs} ms; text ${JSON.stringify(plain)}`,
  );
  // The write happens long after the click: no user activation is left by then.
  assert.equal(toasts.at(-1), "Copied text");
  assert.ok(hits.length >= 0.8 * expected.length, `recognised ${hits.length} of ${expected.length}`);
  // The DOM text is there, the caption over the photo once (DOM text wins).
  assert.ok(plain.includes("This paragraph is real DOM text next to the images."), plain);
  assert.equal(got.filter((w) => w === "Hallstatt").length, 1, plain);
  // The same words in the HTML flavour.
  assert.ok((clip["text/html"] ?? "").includes("Köln"), clip["text/html"]);
  assert.ok((clip["text/html"] ?? "").includes("Hallstatt"), clip["text/html"]);
  // Nothing of snapii's is left over the page, and the overlay is there for a Save.
  assert.equal(await g.overlayPresent(), 1);
  assert.equal(await g.content(`return document.querySelectorAll("snapii-shield").length;`), 0);
  await g.clickToolbar("cancel");
});

test("OCR on: Copy text takes a word in an image whole when the selection's edge cuts it, and no other line", async () => {
  // "Willkommen in Köln": from the middle of Willkommen to the middle of Köln, the height of that line only.
  const first = await inFirstLine("", "Willkommen");
  const last = await inFirstLine("Willkommen in ", "Köln");
  const from = first.x + first.width / 2;
  const { clip, toasts } = await copyRegion({ x: from, y: 64, width: last.x + last.width / 2 - from, height: 20 });
  const plain = clip["text/plain"] ?? "";
  console.log(`copy with ocr, cut words: ${JSON.stringify(plain)}; toasts ${JSON.stringify(toasts)}`);
  assert.equal(toasts.at(-1), "Copied text");
  const got = wordsOf([plain]);
  assert.ok(got.includes("Willkommen"), plain);
  assert.ok(got.includes("Köln"), plain);
  for (const w of ["Straßenbahn", "Quick", "Summer", "Hallstatt", "paragraph"]) assert.ok(!got.includes(w), plain);
  await g.key("Escape");
});

test("OCR off (the default): Copy text copies the DOM text alone and never hides the overlay", async () => {
  await setOcr(false);
  await g.open(PAGE);
  await g.until(async () => (await g.content("return document.documentElement.dataset.ready;")) === "1", "images");
  await clearClipboard(g.s);
  await g.content(`
    window.__hidden = false;
    new MutationObserver(() => {
      if (document.querySelector("snapii-shield")) window.__hidden = true;
    }).observe(document.documentElement, { childList: true });
  `);
  await g.startOverlay();
  await g.drag(CAP.x, CAP.y, CAP.x + CAP.width, CAP.y + CAP.height);
  await g.clickToolbar("copy-text");
  assert.equal(await g.until(() => g.toast(), "the toast"), "Copied text");
  const clip = await readClipboard(g.s);
  assert.equal(
    clip["text/plain"],
    "Photo taken near Hallstatt\n\nThis paragraph is real DOM text next to the images.",
  );
  assert.equal(await g.content("return window.__hidden;"), false, "no capture: no shield went up");
  await g.key("Escape");
});

test("OCR off (the default): no OCR layer, the record says disabled", async () => {
  await setOcr(false);
  const { file, wallMs } = await saveRegion(CAP);
  console.log(`ocr off: save wall time ${wallMs} ms`);
  assert.deepEqual(file.svg.capture.ocr, {
    engine: "tesseract.js 7.0.0",
    langs: ["deu", "eng"],
    areas: 0,
    recognized: 0,
    truncated: false,
    words: 0,
    ms: 0,
    status: "disabled",
  });
  assert.ok(!file.text.includes('<g id="ocr"'));
  assert.ok(!wordsOf(file.svg.tspans).includes("Straßenbahn"));
  assert.equal(wordsOf(file.svg.tspans).filter((w) => w === "Hallstatt").length, 1);
});
