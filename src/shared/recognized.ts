// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text with the OCR setting on: how much of an image is read for a
// selection, which of the recognised words the selection takes, and where
// they stand among the lines of DOM text. DOM-free.
import { bottom, intersect, UNBOUNDED, union, wordInRegion } from "./geometry.ts";
import { ocrScale, runBox, TARGET_PX_PER_CSS } from "./ocr.ts";
import type { DocRect, TextRun } from "./types.ts";

/**
 * The part of `image` (what the page shows of it) that is read for
 * `region`: all of it. Where the picture read ends is not for the selection
 * to decide: an edge through a line of text spoils the lines beside it.
 * Measured with tesseract.js 7 on tests/glue/fixtures/ocr.html in Chromium
 * (Firefox: other letters, the same outcome): a crop that ends 1 px into the
 * line below has "Willkommen in Köln" read as "LL IE in AED" (confidence 34,
 * 35, 94, 32; "in" 43 px high instead of 19), a crop 1 px shorter as "MC in
 * Köln", and the whole picture as its three lines, every word at 91 or more.
 *
 * Only an image too large to be cropped at full resolution (ocrScale) is
 * read in a band: sideways as far as it goes, a word being as long as it is;
 * up and down by the region's height, since a word counts only with half of
 * its height inside (wordInRegion) and so cannot reach further. Without that
 * a line picked on a page with a background picture would have the whole
 * page captured and read. `viewport`: all this browser can capture
 * (Chromium). null: nothing a word of the selection could stand in can be
 * captured.
 */
export function readingExtent(
  image: DocRect,
  region: DocRect,
  viewport: DocRect | null,
  pxPerCss: number,
): DocRect | null {
  const visible = viewport ? intersect(image, viewport) : image;
  const band =
    visible && intersect(visible, { ...UNBOUNDED, y: region.y - region.height, height: 3 * region.height });
  if (!band) return null;
  return ocrScale(visible, pxPerCss) >= Math.max(pxPerCss, TARGET_PX_PER_CSS) ? visible : band;
}

/**
 * The recognised words `region` takes, by the rule for DOM words: one the
 * edge runs through is taken whole, one outside is not. `runs` are the
 * pass's (one per word, same coordinates as `region`); what is left of a
 * line is spaced anew, one space between its words and none after the last.
 */
export function recognizedIn(runs: readonly TextRun[], region: DocRect): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    const text = run.text.trim();
    if (text === "" || !wordInRegion(runBox(run), region)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.line === run.line && prev.block === run.block) prev.text += " ";
    out.push({ ...run, text });
  }
  return out;
}

interface Group {
  runs: TextRun[];
  box: DocRect;
  block: number;
}

/** Consecutive runs that share what `key` reads of them, with the box around them. */
function groupsBy(runs: readonly TextRun[], key: (run: TextRun) => string | number): Group[] {
  const out: Group[] = [];
  let last: string | number | undefined;
  for (const run of runs) {
    const k = key(run);
    const group = out[out.length - 1];
    if (group && k === last) {
      group.runs.push(run);
      group.box = union(group.box, runBox(run));
    } else {
      out.push({ runs: [run], box: runBox(run), block: run.block });
    }
    last = k;
  }
  return out;
}

const middle = (r: DocRect): number => r.y + r.height / 2;

/** The line stands higher than the image. */
const above = (line: DocRect, image: DocRect): boolean => middle(line) < image.y;

/** The line stands lower than the image. */
const below = (line: DocRect, image: DocRect): boolean => middle(line) >= bottom(image);

/** A reader has passed the line when reaching the image: it is above, or beside it on the left. */
const before = (line: DocRect, image: DocRect): boolean =>
  above(line, image) || (!below(line, image) && line.x + line.width / 2 < image.x);

/**
 * `dom` (the selection's runs, in document order) with the `recognized`
 * words (recognizedIn) where a reader meets them, numbered for
 * runsToPlainText: an image's text is a block of its own, after the last
 * line of DOM text that stands before the image. Never between two lines of
 * one block of which one stands beside the image (a picture a paragraph
 * flows around comes after the paragraph); between two lines only where the
 * image stands between them, the first above it and the next below. Images
 * keep their own order.
 *
 * `areas`: the images read, by the block number the pass gave their words.
 * Where an image stands is asked of its area, not of its words: those lie
 * somewhere in the picture, level with any line of a paragraph beside it.
 */
export function withRecognized(
  dom: readonly TextRun[],
  recognized: readonly TextRun[],
  areas: readonly DocRect[],
): readonly TextRun[] {
  if (recognized.length === 0) return dom;
  const lines = groupsBy(dom, (r) => `${r.block}/${r.line}`);
  /** after[i]: the images' texts that follow DOM line i - 1. */
  const after: Group[][] = Array.from({ length: lines.length + 1 }, () => []);
  for (const text of groupsBy(recognized, (r) => r.block)) {
    const image = areas[text.block] ?? text.box;
    let at = 0;
    for (const [i, line] of lines.entries()) if (before(line.box, image)) at = i + 1;
    for (;;) {
      const prev = lines[at - 1];
      const next = lines[at];
      if (!prev || !next || prev.block !== next.block) break;
      if (above(prev.box, image) && below(next.box, image)) break;
      at++;
    }
    after[at]?.push(text);
  }
  // The collector numbers lines and blocks from 0: below that, no number is one of its.
  let fresh = 0;
  const out: TextRun[] = [];
  const add = (images: readonly Group[] = []): void => {
    for (const image of images) {
      const block = --fresh;
      for (const line of groupsBy(image.runs, (r) => r.line)) {
        const number = --fresh;
        for (const run of line.runs) out.push({ ...run, block, line: number });
      }
    }
  };
  add(after[0]);
  for (const [i, line] of lines.entries()) {
    out.push(...line.runs);
    add(after[i + 1]);
  }
  return out;
}
