// SPDX-License-Identifier: GPL-3.0-or-later
// Rectangle arithmetic and line assignment for text runs. DOM-free: rects are
// plain {x, y, width, height} so Node tests can build them by hand.
import type { DocRect, LinkArea, TextRun } from "./types.ts";

/** Stand-in for "no clip"; finite so that x + width never turns into NaN. */
export const UNBOUNDED: DocRect = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };

export function right(r: DocRect): number {
  return r.x + r.width;
}

export function bottom(r: DocRect): number {
  return r.y + r.height;
}

/** Common area of two rects, or null when they share no area at all. */
export function intersect(a: DocRect, b: DocRect): DocRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(right(a), right(b));
  const btm = Math.min(bottom(a), bottom(b));
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

export function union(a: DocRect, b: DocRect): DocRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

/** The parts of `r` outside `hole`: up to four bands (above, below, left, right of it). */
export function minus(r: DocRect, hole: DocRect): DocRect[] {
  const h = intersect(r, hole);
  if (!h) return [r];
  const out: DocRect[] = [];
  if (h.y > r.y) out.push({ x: r.x, y: r.y, width: r.width, height: h.y - r.y });
  if (bottom(h) < bottom(r))
    out.push({ x: r.x, y: bottom(h), width: r.width, height: bottom(r) - bottom(h) });
  if (h.x > r.x) out.push({ x: r.x, y: h.y, width: h.x - r.x, height: h.height });
  if (right(h) < right(r)) out.push({ x: right(h), y: h.y, width: right(r) - right(h), height: h.height });
  return out;
}

export function unionAll(rects: readonly DocRect[]): DocRect | null {
  let out: DocRect | null = null;
  for (const r of rects) out = out ? union(out, r) : r;
  return out;
}

/** Area covered by rects, overlaps counted once: per vertical slab, the merged y-spans. */
export function unionArea(rects: readonly DocRect[]): number {
  const solid = rects.filter((r) => r.width > 0 && r.height > 0);
  const xs = [...new Set(solid.flatMap((r) => [r.x, right(r)]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    const spans = solid
      .filter((r) => r.x <= x0 && right(r) >= x1)
      .map((r) => [r.y, bottom(r)] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const [s, e] of spans) {
      if (e <= end) continue;
      covered += e - Math.max(s, end);
      end = e;
    }
    area += covered * (x1 - x0);
  }
  return area;
}

export function translate(r: DocRect, dx: number, dy: number): DocRect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/**
 * Vertical overlap relative to the taller rect. Using the taller one keeps a
 * three-line ::first-letter or a tall fallback-font fragment from swallowing
 * neighbouring lines, while bidi fragments of one line (similar heights)
 * still score close to 1.
 */
export function verticalOverlap(a: DocRect, b: DocRect): number {
  const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  const tallest = Math.max(a.height, b.height);
  return overlap > 0 && tallest > 0 ? overlap / tallest : 0;
}

export interface LineGroup {
  /** Union of the parts. */
  rect: DocRect;
  /** The client rects that make up this line (one per bidi fragment). */
  parts: DocRect[];
}

/**
 * Groups the client rects of one text node into visual lines. Rects arrive
 * in content order and the fragments of one line are consecutive, so a rect
 * joins the latest group if it overlaps it by more than half, otherwise it
 * opens a new one. Only the latest: in multi-column layout a line in the
 * next column sits at the same height as an earlier one.
 */
export function groupIntoLines(rects: readonly DocRect[]): LineGroup[] {
  const groups: LineGroup[] = [];
  for (const r of rects) {
    const g = groups[groups.length - 1];
    if (g && verticalOverlap(g.rect, r) > 0.5) {
      g.rect = union(g.rect, r);
      g.parts.push(r);
    } else {
      groups.push({ rect: r, parts: [r] });
    }
  }
  return groups;
}

/**
 * Index of the group a single character rect belongs to: the group with a
 * fragment containing the character's centre (columns share heights), else
 * the best vertical overlap, else the nearest centre.
 */
export function lineIndexOf(groups: readonly LineGroup[], r: DocRect): number {
  const cx = r.x + r.width / 2;
  const centre = r.y + r.height / 2;
  const holder = groups.findIndex((g) =>
    g.parts.some((p) => cx >= p.x && cx <= right(p) && centre >= p.y && centre <= bottom(p)),
  );
  if (holder >= 0) return holder;
  let best = 0;
  let bestScore = -Infinity;
  for (const [i, g] of groups.entries()) {
    const overlap = verticalOverlap(g.rect, r);
    const score = overlap > 0 ? overlap : -Math.abs(g.rect.y + g.rect.height / 2 - centre) - 1;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

type Lineable = Pick<TextRun, "y" | "top" | "height" | "block" | "line">;

/**
 * Numbers visual lines across runs in document order: a run starts a new
 * line when it belongs to another block, when its vertical centre lies
 * outside the previous run's box, or when it starts at or below the previous
 * run's baseline. The last rule matters when the previous box is tall: a
 * run that carries a ::first-letter drop cap reaches into the next line, and
 * whether that line's centre falls inside it depends on the platform's font
 * metrics (Linux CI merged the two lines, macOS did not).
 */
export function assignLines<T extends Lineable>(runs: readonly T[]): T[] {
  let line = -1;
  let prev: T | undefined;
  return runs.map((run) => {
    const centre = run.top + run.height / 2;
    if (
      !prev ||
      run.block !== prev.block ||
      centre < prev.top ||
      centre > prev.top + prev.height ||
      run.top >= prev.y
    )
      line++;
    prev = run;
    return { ...run, line };
  });
}

export function runsRelativeTo(runs: readonly TextRun[], region: DocRect): TextRun[] {
  return runs.map((r) => ({ ...r, x: r.x - region.x, y: r.y - region.y, top: r.top - region.y }));
}

export function linksRelativeTo(links: readonly LinkArea[], region: DocRect): LinkArea[] {
  return links.map((l) => ({ ...l, x: l.x - region.x, y: l.y - region.y }));
}
