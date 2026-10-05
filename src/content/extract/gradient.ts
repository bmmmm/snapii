// SPDX-License-Identifier: GPL-3.0-or-later
// A computed linear-gradient() over a box -> the line and stops of an SVG
// <linearGradient> (css-images-3 § 3.1, 3.5). What SVG would draw otherwise
// is null, and the box stays a patch: other gradient kinds, several layers,
// colour hints, interpolation outside sRGB, positions in calc().

import { parseColor } from "../../shared/color.ts";
import { MAX_GRADIENT_STOPS } from "../../shared/messages.ts";
import type { LinearGradient, Paint } from "../../shared/types.ts";

type Stop = LinearGradient["stops"][number];

// CSS interpolates premultiplied, SVG straight: between stops of different
// alpha, this many steps follow the premultiplied colour.
const ALPHA_STEPS = 8;
const NUMBER = "(-?\\d*\\.?\\d+(?:e[+-]?\\d+)?)";
const ANGLE = new RegExp(`^${NUMBER}(deg|rad|turn|grad)$`);
const PER_TURN = { deg: 360, rad: 2 * Math.PI, turn: 1, grad: 400 } as const;
const POSITION = new RegExp(`^${NUMBER}(%|px)$`);
const SIDES = /^to (left|right|top|bottom)(?: (left|right|top|bottom))?$/;

/** The arguments of one `name(...)` call that is the whole value, split at its top-level commas. */
function args(value: string, name: string): string[] | null {
  const v = value.trim();
  if (!v.startsWith(`${name}(`)) return null;
  const out: string[] = [];
  let depth = 0;
  let start = name.length + 1;
  for (let i = start; i < v.length; i++) {
    const c = v[i];
    if (c === "(") depth++;
    else if (c === "," && depth === 0) {
      out.push(v.slice(start, i).trim());
      start = i + 1;
    } else if (c === ")" && depth-- === 0) {
      // Anything after the call is another layer.
      if (i !== v.length - 1) return null;
      out.push(v.slice(start, i).trim());
      return out;
    }
  }
  return null;
}

/** The unit vector the gradient runs along (CSS angles: 0deg up, clockwise). */
function direction(arg: string, width: number, height: number): [number, number] | null {
  const angle = ANGLE.exec(arg);
  if (angle) {
    const t = (Number(angle[1]) / PER_TURN[angle[2] as keyof typeof PER_TURN]) * 2 * Math.PI;
    return [Math.sin(t), -Math.cos(t)];
  }
  const to = SIDES.exec(arg);
  if (!to) return null;
  let sx = 0;
  let sy = 0;
  for (const side of [to[1], to[2]]) {
    if (side === "left") sx = -1;
    else if (side === "right") sx = 1;
    else if (side === "top") sy = -1;
    else if (side === "bottom") sy = 1;
  }
  if (sx === 0 || sy === 0) return [sx, sy];
  // Towards a corner: perpendicular to the diagonal between the other two (§ 3.1.1).
  const n = Math.hypot(width, height);
  return [(sx * height) / n, (sy * width) / n];
}

/** The colour between p and q (alphas differ, so it is never clear) at 0 < t < 1, interpolated premultiplied as CSS does. */
function premix(p: Paint, q: Paint, t: number): Paint {
  const a = p.a + (q.a - p.a) * t;
  // Rounding leaves 255 * a / a a hair above 255, which the background refuses.
  const mix = (u: number, v: number) => Math.min(255, (u * p.a * (1 - t) + v * q.a * t) / a);
  return { r: mix(p.r, q.r), g: mix(p.g, q.g), b: mix(p.b, q.b), a };
}

/** A computed linear-gradient() as an SVG gradient over a box of this size (coordinates from its top-left corner). */
export function linearGradient(value: string, width: number, height: number): LinearGradient | null {
  const parts = args(value, "linear-gradient");
  if (!parts) return null;
  let dir: [number, number] = [0, 1];
  let list = parts;
  if (parts[0]?.startsWith("to ") || ANGLE.test(parts[0] ?? "")) {
    const d = direction(parts[0] as string, width, height);
    if (!d) return null;
    dir = d;
    list = parts.slice(1);
  }
  // The gradient line: through the centre, as long as the box's extent along it.
  const length = Math.abs(width * dir[0]) + Math.abs(height * dir[1]);
  if (!(length > 0) || list.length < 2) return null;

  const raw: { paint: Paint; at: number | null }[] = [];
  for (const arg of list) {
    // A colour, then up to two positions. A lone position is a colour hint;
    // "in <space>" a colour space: both null.
    const m = /^(rgba?\([^)]*\))\s*(.*)$/.exec(arg);
    if (!m) return null;
    const paint = parseColor(m[1] as string);
    if (!paint) return null;
    const at = m[2] ? (m[2] as string).split(/\s+/) : [];
    if (at.length > 2) return null;
    if (at.length === 0) raw.push({ paint, at: null });
    for (const p of at) {
      const q = POSITION.exec(p);
      if (!q) return null;
      raw.push({ paint, at: q[2] === "%" ? Number(q[1]) / 100 : Number(q[1]) / length });
    }
  }

  // Colour stop fixup (§ 3.5.3): ends at 0 and 1, no stop before the one
  // ahead of it, the ones without a position spread evenly between neighbours.
  const first = raw[0] as (typeof raw)[number];
  const last = raw[raw.length - 1] as (typeof raw)[number];
  first.at ??= 0;
  last.at ??= 1;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of raw) {
    if (s.at === null) continue;
    s.at = Math.max(s.at, max);
    max = s.at;
  }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i]?.at !== null) continue;
    let j = i;
    while (raw[j]?.at === null) j++;
    const from = raw[i - 1]?.at as number;
    const to = raw[j]?.at as number;
    for (let k = i; k < j; k++)
      (raw[k] as (typeof raw)[number]).at = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }

  const stops: Stop[] = [];
  raw.forEach((s, i) => {
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const at = s.at as number;
    // A hard edge (both at one offset) needs no steps.
    if (prev && prev.paint.a !== s.paint.a && at > (prev.at as number)) {
      for (let k = 1; k < ALPHA_STEPS; k++) {
        const t = k / ALPHA_STEPS;
        stops.push({
          offset: (prev.at as number) + (at - (prev.at as number)) * t,
          paint: premix(prev.paint, s.paint, t),
        });
      }
    }
    if (s.paint.a > 0) {
      stops.push({ offset: at, paint: s.paint });
      return;
    }
    // A transparent stop has no colour of its own: towards each side it
    // takes its neighbour's, as premultiplying would (there are two stops at least).
    const left = (prev ?? (next as typeof s)).paint;
    const right = (next ?? (prev as typeof s)).paint;
    stops.push({ offset: at, paint: { ...left, a: 0 } });
    if (right !== left) stops.push({ offset: at, paint: { ...right, a: 0 } });
  });

  // More than the background takes: the box is a patch, not a refused save.
  if (stops.length > MAX_GRADIENT_STOPS) return null;

  // SVG keeps offsets in 0-1: a stop beyond the box moves the line's ends out instead.
  const lo = Math.min(0, stops[0]?.offset ?? 0);
  const hi = Math.max(1, stops[stops.length - 1]?.offset ?? 1);
  const cx = width / 2;
  const cy = height / 2;
  const start: [number, number] = [cx - (dir[0] * length) / 2, cy - (dir[1] * length) / 2];
  const along = (o: number): [number, number] => [
    start[0] + dir[0] * length * o,
    start[1] + dir[1] * length * o,
  ];
  return {
    from: along(lo),
    to: along(hi),
    stops: stops.map((s) => ({ offset: (s.offset - lo) / (hi - lo), paint: s.paint })),
  };
}
