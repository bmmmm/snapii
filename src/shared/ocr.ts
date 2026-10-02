// SPDX-License-Identifier: GPL-3.0-or-later
// The DOM-free half of OCR: where to crop an image area from the captured
// tiles, at which scale, and how Tesseract's word boxes become text runs in
// region CSS px. The browser half (worker, canvas) is background/ocr.ts.
import { intersect } from "./geometry.ts";
import type { DocRect, ImageArea, OcrOutput, OcrStatus, RasterTile, TextRun } from "./types.ts";

export const OCR_ENGINE = "tesseract.js 7.0.0";
export const OCR_LANGS = ["deu", "eng"];

/** A page can claim any number of areas; more than this are not recognised. */
export const MAX_AREAS = 24;

type Counts = Pick<OcrOutput["info"], "areas" | "recognized" | "truncated" | "words" | "ms">;

/** The metadata record of one OCR pass. */
export const ocrInfo = (status: OcrStatus, c: Counts): OcrOutput["info"] => ({
  engine: OCR_ENGINE,
  langs: [...OCR_LANGS],
  areas: c.areas,
  recognized: c.recognized,
  truncated: c.truncated,
  words: c.words,
  ms: Math.round(c.ms),
  status,
});

const NOTHING: Counts = { areas: 0, recognized: 0, truncated: false, words: 0, ms: 0 };

/** The record for a save with the setting off. */
export const OCR_DISABLED: OcrOutput = { runs: [], info: ocrInfo("disabled", NOTHING) };

/** Smaller image areas (CSS px) are skipped: icons, bullets, avatars. */
export const MIN_AREA = { width: 24, height: 12 };

/**
 * Words Tesseract is less sure of than this (0–100) are dropped: on photos
 * and textures it reports noise words, mostly below 50.
 */
export const MIN_CONFIDENCE = 60;

/**
 * Crop resolution: at least this many device px per CSS px, so a DPR 1
 * capture is upscaled. Not more: resampling a DPR 2 capture to 3 px per CSS
 * px lost "1200m" on a road sign in a photo and added noise words (measured).
 */
export const TARGET_PX_PER_CSS = 2;

/** Pixel budget of one crop; a larger area is recognised at a lower scale. */
export const MAX_CROP_PIXELS = 6_000_000;

/** An OCR word box shares at least this fraction of its area with a DOM run: the DOM text wins. */
export const COVERED_SHARE = 0.2;

/** Tesseract's box format: image px, x1/y1 exclusive. */
export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The part of Tesseract's `blocks` output read here (tesseract.js 7 `Page.blocks`). */
export interface TessWord {
  text: string;
  confidence: number;
  bbox: Bbox;
}
export interface TessLine {
  words: TessWord[];
  bbox: Bbox;
  baseline?: Bbox | null;
}
export interface TessBlock {
  paragraphs: { lines: TessLine[] }[];
}

/** One recognised word in region CSS px. */
export interface OcrWord extends DocRect {
  text: string;
  confidence: number;
  baseline: number;
}

/**
 * Device px per CSS px for the crop of `area`: the capture's own resolution,
 * raised to TARGET_PX_PER_CSS, lowered again if the crop would exceed
 * MAX_CROP_PIXELS.
 */
export function ocrScale(area: DocRect, nativePxPerCss: number): number {
  const wanted = Math.max(nativePxPerCss, TARGET_PX_PER_CSS);
  const cap = Math.sqrt(MAX_CROP_PIXELS / Math.max(1, area.width * area.height));
  return Math.min(wanted, cap);
}

/** Device px per CSS px of the capture: the tiles' real pixel size over their CSS size (scale × zoom). */
export function nativePxPerCss(tiles: readonly Pick<RasterTile, "width" | "pixelWidth">[]): number {
  const t = tiles[0];
  return t && t.width > 0 ? t.pixelWidth / t.width : 1;
}

/** One drawImage call: source rect in the tile's pixels, destination in crop pixels. */
export interface CropDraw {
  tile: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

type TileGeometry = Pick<RasterTile, "x" | "y" | "width" | "height" | "pixelWidth" | "pixelHeight">;

/**
 * How to paint `area` (region CSS px) into a crop canvas at `f` px per CSS px
 * from the tiles it overlaps. Each tile has its own px-per-CSS ratio (the
 * browser floors the captured size), so source rects are per tile.
 */
export function cropPlan(area: DocRect, tiles: readonly TileGeometry[], f: number): CropDraw[] {
  const out: CropDraw[] = [];
  tiles.forEach((tile, i) => {
    const part = intersect(area, tile);
    if (!part || tile.width <= 0 || tile.height <= 0) return;
    const kx = tile.pixelWidth / tile.width;
    const ky = tile.pixelHeight / tile.height;
    out.push({
      tile: i,
      sx: (part.x - tile.x) * kx,
      sy: (part.y - tile.y) * ky,
      sw: part.width * kx,
      sh: part.height * ky,
      dx: (part.x - area.x) * f,
      dy: (part.y - area.y) * f,
      dw: part.width * f,
      dh: part.height * f,
    });
  });
  return out;
}

/** Crop canvas size for `area` at `f`. */
export function cropSize(area: DocRect, f: number): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(area.width * f)), height: Math.max(1, Math.ceil(area.height * f)) };
}

/** A box in crop pixels → region CSS px. */
export function toRegion(b: Bbox, area: DocRect, f: number): DocRect {
  return { x: area.x + b.x0 / f, y: area.y + b.y0 / f, width: (b.x1 - b.x0) / f, height: (b.y1 - b.y0) / f };
}

/**
 * Baseline y (crop px) under horizontal position x. Tesseract gives the
 * line's baseline as a segment; without a usable one, the line box's bottom
 * minus a typical descent (a fifth of the line height) stands in.
 */
function baselineAt(line: TessLine, x: number): number {
  const b = line.baseline;
  const lineHeight = line.bbox.y1 - line.bbox.y0;
  const usable =
    b != null && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) && !(b.x0 === 0 && b.x1 === 0 && b.y0 === 0);
  if (b && usable) {
    const y = b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);
    // A baseline outside the line box is a broken estimate, not a position.
    if (y >= line.bbox.y0 && y <= line.bbox.y1 + lineHeight * 0.1) return y;
  }
  return line.bbox.y1 - lineHeight * 0.2;
}

/** Recognised lines (each a list of words left to right), in region CSS px, unfiltered. */
export function linesFromBlocks(blocks: readonly TessBlock[] | null, area: DocRect, f: number): OcrWord[][] {
  const lines: OcrWord[][] = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const words: OcrWord[] = [];
        for (const w of line.words) {
          const text = w.text.trim();
          if (!text) continue;
          const box = toRegion(w.bbox, area, f);
          const baseline = area.y + baselineAt(line, (w.bbox.x0 + w.bbox.x1) / 2) / f;
          words.push({ ...box, text, confidence: w.confidence, baseline });
        }
        if (words.length > 0) lines.push(words.sort((a, b) => a.x - b.x));
      }
    }
  }
  return lines;
}

export function isConfident(w: OcrWord): boolean {
  return w.confidence >= MIN_CONFIDENCE;
}

const areaOf = (r: DocRect): number => r.width * r.height;

/** Whether `w` lies on text the DOM already has (or another OCR word already took). */
export function isCovered(w: DocRect, occupied: readonly DocRect[]): boolean {
  const own = areaOf(w);
  if (own <= 0) return true;
  return occupied.some((r) => {
    const common = intersect(w, r);
    return common !== null && areaOf(common) >= COVERED_SHARE * own;
  });
}

/** Tesseract reads lines, ticks and textures as "—", "=", "®" or "@": no letter or digit, no word. */
export const hasLetterOrDigit = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * The words that go into the text layer: confident ones with a letter or
 * digit, not lying on `occupied` (the DOM runs' boxes; DOM text always wins).
 * A single character alone on its line is dropped too: on photos and charts
 * that is mostly a stroke read as "A", "N" or "i" (measured on Wikipedia's
 * "Infographic"), while in a line of other words it is a real one ("a",
 * "5 km"). `occupied` grows with every accepted word, so nested or
 * overlapping image areas cannot add the same word twice. Lines left empty
 * are dropped.
 */
export function acceptWords(lines: readonly OcrWord[][], occupied: DocRect[]): OcrWord[][] {
  const out: OcrWord[][] = [];
  for (const line of lines) {
    const kept = line.filter((w) => isConfident(w) && hasLetterOrDigit(w.text) && !isCovered(w, occupied));
    const [only] = kept;
    if (kept.length === 1 && only && [...only.text].length === 1) continue;
    occupied.push(...kept);
    if (kept.length > 0) out.push(kept);
  }
  return out;
}

/** A DOM run's box in the same terms as an OCR word. */
export const runBox = (r: Pick<TextRun, "x" | "top" | "width" | "height">): DocRect => ({
  x: r.x,
  y: r.top,
  width: r.width,
  height: r.height,
});

// Cap height plus the usual ascender overshoot, as a fraction of the font
// size, for common sans-serif faces: turns the ascent Tesseract measured
// into a font size.
const ASCENT_EM = 0.72;

/**
 * One run per word, all on one line. Each word but the last carries the
 * following space and stretches (textLength) to where the next word starts,
 * so copied text keeps its word gaps and every word keeps its own hit area.
 */
export function lineToRuns(words: readonly OcrWord[], line: number, block: number): TextRun[] {
  if (words.length === 0) return [];
  const baseline = words.reduce((s, w) => s + w.baseline, 0) / words.length;
  const top = Math.min(...words.map((w) => w.y));
  const bottom = Math.max(...words.map((w) => w.y + w.height));
  const fontSize = Math.max(1, Math.min((baseline - top) / ASCENT_EM, (bottom - top) * 1.5));
  return words.map((w, i) => {
    const next = words[i + 1];
    const last = next === undefined;
    return {
      text: last ? w.text : `${w.text} `,
      x: w.x,
      y: w.baseline,
      top: w.y,
      width: last ? w.width : Math.max(w.width, next.x - w.x),
      height: w.height,
      fontFamily: "sans-serif",
      fontSize,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#000",
      lang: null,
      dir: "ltr",
      href: null,
      line,
      block,
    };
  });
}

/** The Tesseract side of a pass (background/ocr.ts), a parameter so the bookkeeping is unit-tested. */
export interface OcrEngine {
  /** Resolves once the engine can recognise; a rejection ends the pass. */
  start(): Promise<void>;
  /** One area's recognised lines in region CSS px, unfiltered; a rejection ends the pass. */
  recognize(area: ImageArea): Promise<OcrWord[][]>;
}

/**
 * Recognises up to MAX_AREAS `areas`, one after another, and turns the
 * accepted words into runs. `domRuns` are the region's DOM text runs: OCR
 * words on them are dropped. Never throws: a rejection is a "timeout" (when
 * `isTimeout` says so) or "failed" record without runs, which still says how
 * many areas were planned and how many were done.
 */
export async function runOcrPass(
  areas: readonly ImageArea[],
  domRuns: readonly TextRun[],
  engine: OcrEngine,
  opts: { isTimeout(e: unknown): boolean; now(): number },
): Promise<OcrOutput> {
  const t0 = opts.now();
  const todo = areas.slice(0, MAX_AREAS);
  const truncated = areas.length > todo.length;
  if (todo.length === 0) return { runs: [], info: ocrInfo("no-areas", NOTHING) };
  let recognized = 0;
  const record = (status: OcrStatus, words: number): OcrOutput["info"] =>
    ocrInfo(status, { areas: todo.length, recognized, truncated, words, ms: opts.now() - t0 });
  try {
    await engine.start();
    const occupied = domRuns.map(runBox);
    const runs: TextRun[] = [];
    let line = 0;
    let words = 0;
    for (const [block, area] of todo.entries()) {
      const lines = acceptWords(await engine.recognize(area), occupied);
      recognized++;
      for (const l of lines) {
        runs.push(...lineToRuns(l, line++, block));
        words += l.length;
      }
    }
    return { runs, info: record("ok", words) };
  } catch (e) {
    const timeout = opts.isTimeout(e);
    if (!timeout) console.warn("snapii: OCR failed", e);
    return { runs: [], info: record(timeout ? "timeout" : "failed", 0) };
  }
}
