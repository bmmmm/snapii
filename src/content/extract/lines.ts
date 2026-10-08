// SPDX-License-Identifier: GPL-3.0-or-later
// D-split: one text node -> its visual lines. The node's client rects give
// the line boxes; a binary search over character offsets finds where each
// line starts, so a 2,000-character paragraph in 20 lines costs ~220 rect
// reads instead of 2,000.
import { groupIntoLines, lineIndexOf } from "../../shared/geometry.ts";
import type { DocRect } from "../../shared/types.ts";

export interface LineSlice {
  /** UTF-16 offsets into the text node, end exclusive. */
  start: number;
  end: number;
  /** Union of parts, client coordinates. */
  rect: DocRect;
  /** One client rect per bidi fragment of this line. */
  parts: DocRect[];
}

/** Client rects that cover glyphs; collapsed whitespace reports zero width. */
export function glyphRects(range: Range): DocRect[] {
  const out: DocRect[] = [];
  for (const r of range.getClientRects()) {
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

const midPair = (data: string, i: number) =>
  i > 0 && i < data.length && isLow(data.charCodeAt(i)) && isHigh(data.charCodeAt(i - 1));

/** Moves an offset off the middle of a surrogate pair, towards the end. */
export function codePointBoundary(data: string, i: number): number {
  return midPair(data, i) ? i + 1 : i;
}

/** Moves an offset off the middle of a surrogate pair, towards the start. */
export function codePointStart(data: string, i: number): number {
  return midPair(data, i) ? i - 1 : i;
}

/** Rects of the characters [start, end) of node; range is reused scratch. */
export function sliceRects(node: Text, range: Range, start: number, end: number): DocRect[] {
  range.setStart(node, start);
  range.setEnd(node, end);
  return glyphRects(range);
}

/**
 * Splits node into lines. range is scratch space owned by the caller (one
 * per document). Characters without a glyph rect (collapsed spaces) belong to
 * the line of the previous visible character. With keep, only the lines whose
 * rect it accepts are returned, and only their starts are searched for: a
 * 5000-line <pre> under a small capture needs a dozen searches, not 5000.
 */
export function splitIntoLines(node: Text, range: Range, keep?: (rect: DocRect) => boolean): LineSlice[] {
  range.selectNodeContents(node);
  const groups = groupIntoLines(glyphRects(range));
  const data = node.data;
  const len = data.length;
  if (groups.length <= 1) return groups.map((g) => ({ start: 0, end: len, rect: g.rect, parts: g.parts }));

  const lineOf = (i: number): number => {
    for (let j = i; j >= 0; j--) {
      const [r] = sliceRects(node, range, j, j + 1);
      if (r) return lineIndexOf(groups, r);
    }
    return 0;
  };
  const starts = new Map<number, number>([[0, 0]]);
  // Start of the latest line found; lines are searched in order.
  let floor = 0;
  const startOf = (k: number): number => {
    if (k >= groups.length) return len;
    const known = starts.get(k);
    if (known !== undefined) return known;
    // Smallest offset whose line is k or later; lines only advance with content order.
    let lo = floor + 1;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineOf(mid) >= k) hi = mid;
      else lo = mid + 1;
    }
    // Firefox gives a pair's high half a zero-width rect and its low half the
    // glyph, so the search stops on the low half; the pair starts this line.
    const start = codePointStart(data, lo);
    starts.set(k, start);
    floor = start;
    return start;
  };
  const out: LineSlice[] = [];
  groups.forEach((g, k) => {
    if (keep && !keep(g.rect)) return;
    const start = startOf(k);
    out.push({
      start: Math.min(start, len),
      end: Math.min(startOf(k + 1), len),
      rect: g.rect,
      parts: g.parts,
    });
  });
  return out;
}
