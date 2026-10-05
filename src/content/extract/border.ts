// SPDX-License-Identifier: GPL-3.0-or-later
// How a browser lays out a dashed, dotted or double border side, which CSS
// leaves to it: measured on Firefox and Chromium (2026-10-05, the tables
// are in tests/unit/border.test.ts). A side's pattern runs over its whole
// outer length, with a dash or dot at both ends. DOM-free.

import type { BuildTarget } from "../../shared/manifest.ts";
import { TARGET } from "../../shared/target.ts";
import type { DocRect, Paint, SceneOp } from "../../shared/types.ts";

/** A side's pattern along its length: from, to, dash and gap; round: dots of the border's width, dash 0. */
export interface SideDash {
  from: number;
  to: number;
  dash: number;
  gap: number;
  round: boolean;
}

/** Blink's StrokeData::SelectBestDashGap on an open path: the gap nearest `gap` that ends in a dash. */
function bestGap(length: number, dash: number, gap: number): number | null {
  const fewest = Math.floor((length + gap) / (dash + gap));
  if (fewest < 2) return null;
  const fewGap = (length - fewest * dash) / (fewest - 1);
  const moreGap = (length - (fewest + 1) * dash) / fewest;
  return moreGap <= 0 || Math.abs(fewGap - gap) < Math.abs(moreGap - gap) ? fewGap : moreGap;
}

/** Firefox's: the fewest equal segments, an odd number, none longer than `most`. */
const oddSegments = (length: number, most: number): number => {
  const s = Math.ceil(length / most);
  return s % 2 === 1 ? s : s + 1;
};

/**
 * The pattern of a dashed or dotted side of `length` and `width` (CSS px),
 * or null where the browser draws it solid (too short for two dashes).
 * The thresholds are in device pixels, as the browsers take them.
 */
export function sideDash(
  style: "dashed" | "dotted",
  length: number,
  width: number,
  dpr: number,
  target: BuildTarget = TARGET,
): SideDash | null {
  if (!(length > 0) || !(width > 0)) return null;
  const device = width * dpr;
  if (style === "dashed") {
    if (target === "chromium") {
      const dash = width * (device >= 3 ? 2 : 3);
      const gap = bestGap(length, dash, width * (device >= 3 ? 1 : 2));
      return gap === null ? null : { from: 0, to: length, dash, gap, round: false };
    }
    const s = oddSegments(length, 3 * width);
    return s === 1 ? null : { from: 0, to: length, dash: length / s, gap: length / s, round: false };
  }
  if (device < 3) {
    // Square dots: Chromium spaces 2 device px ones to end in a dot, thinner ones run from the corner on.
    const gap = target === "chromium" && device >= 2 ? bestGap(length, width, width) : width;
    return gap === null ? null : { from: 0, to: length, dash: width, gap, round: false };
  }
  if (target === "chromium") {
    // Round dots centred from end to end, two widths apart or as near as fits.
    const dots = Math.round((length - width) / (2 * width)) + 1;
    if (dots < 2) return null;
    return {
      from: width / 2,
      to: length - width / 2,
      dash: 0,
      gap: (length - width) / (dots - 1),
      round: true,
    };
  }
  // Firefox: a dot in every other of an odd number of segments, centred in it.
  const s = oddSegments(length, width);
  if (s === 1) return null;
  const segment = length / s;
  return { from: segment / 2, to: length - segment / 2, dash: 0, gap: 2 * segment, round: true };
}

/** The thickness of each of a double border's two lines, or null where it is one solid line. */
export function doubleLine(width: number, dpr: number): number | null {
  const device = width * dpr;
  return device >= 3 ? Math.round(device / 3) / dpr : null;
}

/** One side of a border, top, right, bottom, left; paint null where it is not shown. */
export interface StyledSide {
  width: number;
  style: string;
  paint: Paint | null;
}

/**
 * A square border box's sides as shapes: a solid side as its band, a double
 * one as its two lines (the inner one kept off a double neighbour's outer
 * line), dashes and dots as a line along the side's middle. A dashed or
 * dotted side too short for its pattern is solid, as the browsers draw it.
 */
export function borderSides(
  box: DocRect,
  sides: StyledSide[],
  dpr: number,
  target: BuildTarget = TARGET,
): SceneOp[] {
  const { x, y, width: w, height: h } = box;
  const ops: SceneOp[] = [];
  // How far a double side's inner line keeps off a corner: a double neighbour's width less its outer line.
  const inset = (i: number) => {
    const s = sides[i];
    const line = s?.paint && s.style === "double" ? doubleLine(s.width, dpr) : null;
    return line === null ? 0 : (s?.width ?? 0) - line;
  };
  for (const [i, side] of sides.entries()) {
    const { paint, width: t } = side;
    if (!paint || paint.a <= 0 || !(t > 0)) continue;
    const along = i % 2 === 0;
    const band = [
      { x, y, width: w, height: t },
      { x: x + w - t, y, width: t, height: h },
      { x, y: y + h - t, width: w, height: t },
      { x, y, width: t, height: h },
    ][i] as DocRect;
    const line = side.style === "double" ? doubleLine(t, dpr) : null;
    if (line !== null) {
      // The outer line along the side's outer edge, the inner one along its inner edge.
      const near = i === 0 || i === 3;
      const from = inset(along ? 3 : 0);
      const to = inset(along ? 1 : 2);
      const outer = along
        ? { x, y: near ? band.y : band.y + t - line, width: w, height: line }
        : { x: near ? band.x : band.x + t - line, y, width: line, height: h };
      const inner = along
        ? { x: x + from, y: near ? band.y + t - line : band.y, width: w - from - to, height: line }
        : { x: near ? band.x + t - line : band.x, y: y + from, width: line, height: h - from - to };
      ops.push({ op: "rect", ...outer, fill: paint }, { op: "rect", ...inner, fill: paint });
      continue;
    }
    const d =
      side.style === "dashed" || side.style === "dotted"
        ? sideDash(side.style, along ? w : h, t, dpr, target)
        : null;
    if (!d) {
      ops.push({ op: "rect", ...band, fill: paint });
      continue;
    }
    const mid = along ? band.y + t / 2 : band.x + t / 2;
    // A dot exactly on the line's end is dropped where rounding puts it a
    // hair beyond (Chromium): the line runs on half a gap, the next dot does not fit.
    const to = d.round ? d.to + d.gap / 2 : d.to;
    ops.push({
      op: "line",
      ...(along
        ? { x1: x + d.from, y1: mid, x2: x + to, y2: mid }
        : { x1: mid, y1: y + d.from, x2: mid, y2: y + to }),
      width: t,
      paint,
      dash: [d.dash, d.gap],
      ...(d.round ? { round: true } : {}),
    });
  }
  return ops;
}
