// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptWords,
  cropPlan,
  cropSize,
  linesFromBlocks,
  lineToRuns,
  MAX_AREAS,
  MAX_CROP_PIXELS,
  MIN_CONFIDENCE,
  nativePxPerCss,
  type OcrEngine,
  type OcrWord,
  ocrScale,
  runBox,
  runOcrPass,
  type TessBlock,
  toRegion,
} from "../../src/shared/ocr.ts";
import type { DocRect, ImageArea } from "../../src/shared/types.ts";

const close = (a: number, b: number, what: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);

const word = (over: Partial<OcrWord>): OcrWord => ({
  text: "Wort",
  confidence: 90,
  x: 0,
  y: 0,
  width: 40,
  height: 20,
  baseline: 16,
  ...over,
});

test("ocrScale: the capture's own resolution, raised to 2 px per CSS px, capped by the pixel budget", () => {
  const small = { x: 0, y: 0, width: 300, height: 100 };
  assert.equal(ocrScale(small, 2), 2); // DPR 2, zoom 1: kept
  assert.equal(ocrScale(small, 1), 2); // DPR 1: upscaled 2×
  assert.equal(ocrScale(small, 0.8), 2); // DPR 1 × zoom 0.8: upscaled 2.5×
  assert.equal(ocrScale(small, 4.5), 4.5); // DPR 3 × zoom 1.5: kept
  const huge = { x: 0, y: 0, width: 4000, height: 3000 };
  const f = ocrScale(huge, 2);
  assert.ok(f < 2, `huge area scale ${f}`);
  close(huge.width * f * huge.height * f, MAX_CROP_PIXELS, "crop pixels");
});

test("nativePxPerCss: the tiles' pixel width over their CSS width (scale × zoom)", () => {
  assert.equal(nativePxPerCss([{ width: 500, pixelWidth: 1500 }]), 3);
  assert.equal(nativePxPerCss([]), 1);
});

test("crop + box mapping: DPR 2 × zoom 1.5 tiles in two bands, upscaled crop, boxes back in region CSS px", () => {
  // Two bands of one region captured at scale 2 × zoom 1.5 = 3 px per CSS
  // px; the browser floored the second band's height by one pixel.
  const tiles = [
    { x: 0, y: 0, width: 400, height: 100, pixelWidth: 1200, pixelHeight: 300 },
    { x: 0, y: 100, width: 400, height: 50, pixelWidth: 1200, pixelHeight: 149 },
  ];
  const area: DocRect = { x: 50, y: 80, width: 200, height: 60 };
  const f = 4; // upscaled past the capture's 3
  assert.deepEqual(cropSize(area, f), { width: 800, height: 240 });
  const plan = cropPlan(area, tiles, f);
  assert.equal(plan.length, 2);
  const [a, b] = plan;
  assert.ok(a && b);
  // Band 1: CSS y 80–100 of the area, tile pixels from y 240.
  assert.deepEqual(a, { tile: 0, sx: 150, sy: 240, sw: 600, sh: 60, dx: 0, dy: 0, dw: 800, dh: 80 });
  // Band 2: CSS y 100–140, the tile's own (floored) ratio 149/50.
  assert.equal(b.tile, 1);
  close(b.sy, 0, "band 2 sy");
  close(b.sh, 40 * (149 / 50), "band 2 sh");
  assert.deepEqual([b.dx, b.dy, b.dw, b.dh], [0, 80, 800, 160]);
  // A word Tesseract found at crop px (40,100)-(240,140) is 10,25 into the
  // area, 50 x 10 CSS px.
  assert.deepEqual(toRegion({ x0: 40, y0: 100, x1: 240, y1: 140 }, area, f), {
    x: 60,
    y: 105,
    width: 50,
    height: 10,
  });
});

test("linesFromBlocks: baseline from Tesseract's line segment, else the line box bottom minus a descent", () => {
  const area = { x: 100, y: 200, width: 300, height: 100 };
  const blocks: TessBlock[] = [
    {
      paragraphs: [
        {
          lines: [
            {
              bbox: { x0: 0, y0: 0, x1: 200, y1: 40 },
              // Slanted: y 30 at x 0, y 34 at x 200.
              baseline: { x0: 0, y0: 30, x1: 200, y1: 34 },
              words: [
                { text: "zwei", confidence: 91, bbox: { x0: 120, y0: 5, x1: 200, y1: 40 } },
                { text: "Eins", confidence: 95, bbox: { x0: 0, y0: 2, x1: 100, y1: 32 } },
                { text: "  ", confidence: 99, bbox: { x0: 100, y0: 2, x1: 110, y1: 32 } },
              ],
            },
            {
              bbox: { x0: 0, y0: 50, x1: 100, y1: 90 },
              baseline: null,
              words: [{ text: "drei", confidence: 80, bbox: { x0: 0, y0: 50, x1: 100, y1: 90 } }],
            },
          ],
        },
      ],
    },
  ];
  const lines = linesFromBlocks(blocks, area, 2);
  assert.equal(lines.length, 2);
  const [first, second] = lines;
  // Sorted left to right, blank words dropped.
  assert.deepEqual(
    first?.map((w) => w.text),
    ["Eins", "zwei"],
  );
  close(first?.[0]?.baseline ?? Number.NaN, 200 + 31 / 2, "baseline at x 50");
  close(first?.[1]?.baseline ?? Number.NaN, 200 + 33.2 / 2, "baseline at x 160");
  // No baseline: 90 - 0.2 * 40 = 82 crop px.
  close(second?.[0]?.baseline ?? Number.NaN, 200 + 41, "fallback baseline");
  assert.deepEqual(linesFromBlocks(null, area, 2), []);
});

test("acceptWords: words below the confidence threshold are dropped", () => {
  const sure = word({ text: "sure", confidence: MIN_CONFIDENCE });
  const unsure = word({ text: "unsure", x: 100, confidence: MIN_CONFIDENCE - 1 });
  assert.deepEqual(
    acceptWords([[sure, unsure]], []).map((l) => l.map((w) => w.text)),
    [["sure"]],
  );
  // A line of nothing but noise disappears as a line.
  assert.deepEqual(acceptWords([[unsure]], []), []);
});

test("acceptWords: words without a letter or digit are dropped, punctuation around letters stays", () => {
  const texts = ["—", "==", "®", "@", ".", "CO,", "39%", "4870", "Köln", "(M)"];
  const line = texts.map((text, i) => word({ text, x: i * 50 }));
  assert.deepEqual(
    acceptWords([line], []).map((l) => l.map((w) => w.text)),
    [["CO,", "39%", "4870", "Köln", "(M)"]],
  );
});

test("acceptWords: a single character alone on its line is dropped, one among other words stays", () => {
  const alone = (text: string, y: number) => [word({ text, y })];
  const kept = acceptWords(
    [
      alone("A", 0),
      alone("5", 30),
      alone("ü", 60),
      [word({ text: "Tag", y: 90 }), word({ text: "a", x: 50, y: 90 }), word({ text: "5", x: 70, y: 90 })],
      [word({ text: "x", y: 120 }), word({ text: "y", x: 50, y: 120 })],
      alone("km", 150),
      // The other words of the line are noise: the "N" is alone after all.
      [word({ text: "N", y: 180 }), word({ text: "—", x: 50, y: 180 })],
    ],
    [],
  );
  assert.deepEqual(
    kept.map((l) => l.map((w) => w.text)),
    [["Tag", "a", "5"], ["x", "y"], ["km"]],
  );
});

test("acceptWords: a dropped single character does not occupy its place", () => {
  const occupied: DocRect[] = [];
  acceptWords([[word({ text: "A" })]], occupied);
  assert.deepEqual(occupied, []);
});

test("acceptWords: DOM text wins: an OCR word on a DOM run is dropped, one beside it is kept", () => {
  // A caption run lying over the image.
  const dom = [runBox({ x: 0, top: 100, width: 300, height: 30 })];
  const onCaption = word({ text: "Hallstatt", x: 200, y: 105, width: 60, height: 20 }); // fully inside
  const grazing = word({ text: "Lake", x: 0, y: 125, width: 40, height: 20 }); // 5 of 20 px tall inside: 25 %
  const beside = word({ text: "Mountain", x: 0, y: 40, width: 80, height: 20 });
  const touching = word({ text: "Panorama", x: 0, y: 128, width: 40, height: 20 }); // 2 of 20 px: 10 %
  const kept = acceptWords([[onCaption, grazing], [beside], [touching]], dom.slice());
  assert.deepEqual(
    kept.map((l) => l.map((w) => w.text)),
    [["Mountain"], ["Panorama"]],
  );
});

test("acceptWords: the same word from two overlapping image areas goes in once", () => {
  const occupied: DocRect[] = [];
  const outer = acceptWords([[word({ text: "Sale", x: 10, y: 10 })]], occupied);
  const inner = acceptWords([[word({ text: "Sale", x: 11, y: 10 })]], occupied);
  assert.equal(outer.length, 1);
  assert.deepEqual(inner, []);
});

test("lineToRuns: one run per word, the gap and a space belong to the word before", () => {
  const runs = lineToRuns(
    [
      word({ text: "Summer", x: 10, y: 20, width: 100, height: 30, baseline: 44 }),
      word({ text: "Sale", x: 125, y: 22, width: 60, height: 28, baseline: 44 }),
    ],
    3,
    1,
  );
  assert.deepEqual(
    runs.map((r) => [r.text, r.x, r.width, r.y, r.top, r.line, r.block, r.href, r.dir]),
    [
      ["Summer ", 10, 115, 44, 20, 3, 1, null, "ltr"],
      ["Sale", 125, 60, 44, 22, 3, 1, null, "ltr"],
    ],
  );
  // Ascent 24 px at 0.72 em: a 33.3 px font, the same for the whole line.
  close(runs[0]?.fontSize ?? 0, 24 / 0.72, "font size");
  assert.equal(runs[1]?.fontSize, runs[0]?.fontSize);
  assert.deepEqual(lineToRuns([], 0, 0), []);
});

class Late extends Error {}

/**
 * A fake engine: each area (100 px apart) yields one line with one word;
 * the area at index `stopAt` rejects (`late` for a timeout).
 */
function engine(o: { stopAt?: number; late?: boolean; startFails?: boolean } = {}) {
  const seen: number[] = [];
  const e: OcrEngine = {
    async start() {
      if (o.startFails) throw new Error("no engine");
    },
    async recognize(area) {
      const i = area.x / 100;
      seen.push(i);
      if (i === o.stopAt) throw o.late ? new Late() : new Error("worker died");
      return [[word({ text: `w${i}`, x: area.x, y: 100 })]];
    },
  };
  return { e, seen };
}

const areasOf = (n: number): ImageArea[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * 100, y: 0, width: 50, height: 30, kind: "img" as const }));

let clock = 0;
const opts = { isTimeout: (e: unknown) => e instanceof Late, now: () => (clock += 10) };

test("runOcrPass: all areas done: planned = recognized, words counted, not truncated", async () => {
  const { e } = engine();
  const out = await runOcrPass(areasOf(3), [], e, opts);
  assert.deepEqual(
    out.runs.map((r) => r.text),
    ["w0", "w1", "w2"],
  );
  assert.deepEqual(
    { ...out.info, ms: 0 },
    {
      engine: "tesseract.js 7.0.0",
      langs: ["deu", "eng"],
      areas: 3,
      recognized: 3,
      truncated: false,
      words: 3,
      ms: 0,
      status: "ok",
    },
  );
});

test("runOcrPass: a timeout records the planned areas and the ones done before it, no runs", async () => {
  const { e } = engine({ stopAt: 2, late: true });
  const out = await runOcrPass(areasOf(4), [], e, opts);
  assert.deepEqual(out.runs, []);
  assert.deepEqual(
    [out.info.status, out.info.areas, out.info.recognized, out.info.words, out.info.truncated],
    ["timeout", 4, 2, 0, false],
  );
});

test("runOcrPass: a failure is 'failed'; one at engine start has recognised nothing", async () => {
  const mid = await runOcrPass(areasOf(3), [], engine({ stopAt: 1 }).e, opts);
  assert.deepEqual([mid.info.status, mid.info.areas, mid.info.recognized], ["failed", 3, 1]);
  const start = await runOcrPass(areasOf(3), [], engine({ startFails: true }).e, opts);
  assert.deepEqual([start.info.status, start.info.areas, start.info.recognized], ["failed", 3, 0]);
});

test("runOcrPass: past MAX_AREAS the rest is not looked at, and the record says so", async () => {
  const { e, seen } = engine();
  const out = await runOcrPass(areasOf(MAX_AREAS + 6), [], e, opts);
  assert.equal(seen.length, MAX_AREAS);
  assert.deepEqual(
    [out.info.status, out.info.areas, out.info.recognized, out.info.truncated],
    ["ok", MAX_AREAS, MAX_AREAS, true],
  );
  const exact = await runOcrPass(areasOf(MAX_AREAS), [], engine().e, opts);
  assert.equal(exact.info.truncated, false);
});

test("runOcrPass: no areas, no engine start", async () => {
  let started = false;
  const out = await runOcrPass(
    [],
    [],
    {
      async start() {
        started = true;
      },
      async recognize() {
        return [];
      },
    },
    opts,
  );
  assert.equal(started, false);
  assert.deepEqual(
    [out.info.status, out.info.areas, out.info.recognized, out.info.ms],
    ["no-areas", 0, 0, 0],
  );
});
