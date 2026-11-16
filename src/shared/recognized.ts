// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text with the OCR setting on: how much of an image is read for a
// selection, which of the recognised words the selection takes, and where
// they stand among the lines of DOM text. DOM-free.
import { bottom, intersect, UNBOUNDED, union, wordInRegion } from "./geometry.ts";
import { runBox } from "./ocr.ts";
import type { DocRect, TextRun } from "./types.ts";

/**
 * The part of the page in which an image is read for `region`. A word the
 * region's edge cuts is copied whole, so the image is read beyond the edge:
 * sideways as far as it goes, a word being as long as it is; up and down by
 * the region's height, since a word counts only with half of its height
 * inside (wordInRegion) and so cannot reach further. Without that limit a
 * line picked on a page with a background picture would have the whole page
 * captured and read. `viewport`: all this browser can capture (Chromium);
 * null where nothing of the image can be captured at all.
 */
export function readingExtent(region: DocRect, viewport: DocRect | null): DocRect | null {
  const band = {
    x: UNBOUNDED.x,
    y: region.y - region.height,
    width: UNBOUNDED.width,
    height: 3 * region.height,
  };
  return viewport ? intersect(band, viewport) : band;
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

/** The line stands higher than the image's text. */
const above = (line: DocRect, text: DocRect): boolean => middle(line) < text.y;

/** A reader has passed the line when reaching the image's text: it is above, or beside it on the left. */
const before = (line: DocRect, text: DocRect): boolean =>
  above(line, text) || (middle(line) < bottom(text) && line.x + line.width / 2 < text.x);

/**
 * `dom` (the selection's runs, in document order) with the `recognized`
 * words (recognizedIn) where a reader meets them, numbered for
 * runsToPlainText: an image's text is a block of its own, after the last
 * line of DOM text that stands before it. Never between two lines of one
 * block that stand beside the image (a picture a paragraph flows around
 * comes after the paragraph); between two lines only where the first is
 * above it. Images keep their own order.
 */
export function withRecognized(dom: readonly TextRun[], recognized: readonly TextRun[]): readonly TextRun[] {
  if (recognized.length === 0) return dom;
  const lines = groupsBy(dom, (r) => `${r.block}/${r.line}`);
  /** after[i]: the images' texts that follow DOM line i - 1. */
  const after: Group[][] = Array.from({ length: lines.length + 1 }, () => []);
  for (const image of groupsBy(recognized, (r) => r.block)) {
    let at = 0;
    for (const [i, line] of lines.entries()) if (before(line.box, image.box)) at = i + 1;
    for (;;) {
      const prev = lines[at - 1];
      const next = lines[at];
      if (!prev || !next || prev.block !== next.block || above(prev.box, image.box)) break;
      at++;
    }
    after[at]?.push(image);
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
