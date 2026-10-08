// SPDX-License-Identifier: GPL-3.0-or-later
// A computed box-shadow -> its outer shadows as numbers (css-backgrounds-3
// § 7). Both engines write each one as `<colour> <x> <y> <blur> <spread>` in
// px, `inset` last (measured 2026-10-05). An inset shadow or any other form
// is null, and the box stays a patch.

import { parseColor } from "../../shared/color.ts";
import type { Paint } from "../../shared/types.ts";

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  paint: Paint;
}

const PX = "(-?\\d*\\.?\\d+(?:e[+-]?\\d+)?)px";
const SHADOW = new RegExp(`^(.+?) ${PX} ${PX} ${PX} ${PX}$`);

/** The value split at its top-level commas (a colour's own commas stay). */
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/**
 * The shadows of a computed box-shadow, the one painted on top first, without
 * the fully transparent ones (Tailwind sets `0 0 #0000` on every ring);
 * null if one is not an outer shadow this reads.
 */
export function outerShadows(value: string): Shadow[] | null {
  const out: Shadow[] = [];
  for (const part of parts(value)) {
    const m = SHADOW.exec(part);
    if (!m) return null;
    const paint = parseColor(m[1] as string);
    if (!paint) return null;
    if (paint.a === 0) continue;
    out.push({ paint, x: Number(m[2]), y: Number(m[3]), blur: Number(m[4]), spread: Number(m[5]) });
  }
  return out;
}

/**
 * A corner radius of the shadow shape (css-backgrounds-3 § 7.1.1): the
 * border radius plus the spread, a radius smaller than the spread growing
 * less (a square corner stays square), never below zero.
 */
export function spreadRadius(r: number, spread: number): number {
  if (r >= spread) return Math.max(0, r + spread);
  return r + spread * (1 + (r / spread - 1) ** 3);
}
