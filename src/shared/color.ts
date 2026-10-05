// SPDX-License-Identifier: GPL-3.0-or-later
// Computed CSS colours -> sRGB numbers. getComputedStyle gives rgb()/rgba()
// for most colours and keeps modern spaces as color(), oklab(), oklch(),
// lab() or lch(); everything is converted here, so a vector SVG only ever
// carries numbers. Anything else (a keyword the browser left unresolved, a
// space not listed) is null: the scene builder then takes the element as
// pixels instead of guessing. DOM-free.

import type { Paint } from "./types.ts";

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
// A component: number, percentage, or `none` (= 0).
const COMPONENT = new RegExp(`^(?:(${NUM})(%?)|none)$`);

type Component = { value: number; percent: boolean };

function component(token: string): Component | null {
  const m = COMPONENT.exec(token);
  if (!m) return null;
  if (m[1] === undefined) return { value: 0, percent: false };
  return { value: Number(m[1]), percent: m[2] === "%" };
}

/** "a b c / d" or "a, b, c, d" -> component tokens and the alpha token (or null). */
function split(body: string): { parts: string[]; alpha: string | null } | null {
  const [main, alpha, extra] = body.split("/");
  if (extra !== undefined || main === undefined) return null;
  const parts = main.includes(",") ? main.split(",").map((s) => s.trim()) : main.trim().split(/\s+/);
  if (alpha !== undefined) return { parts, alpha: alpha.trim() };
  // Legacy comma syntax carries alpha as a fourth part.
  if (main.includes(",") && parts.length === 4)
    return { parts: parts.slice(0, 3), alpha: parts[3] as string };
  return { parts, alpha: null };
}

function alphaOf(token: string | null): number | null {
  if (token === null) return 1;
  const c = component(token);
  if (!c) return null;
  return clamp01(c.percent ? c.value / 100 : c.value);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const toByte = (v: number): number => Math.round(clamp01(v) * 255 * 1000) / 1000;

// sRGB transfer function and its inverse.
const encode = (c: number): number =>
  Math.abs(c) <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055);
const decode = (c: number): number =>
  Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4;

type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];
const mul = (m: Mat, v: Vec): Vec => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

// CSS Color 4 § 18 sample code matrices.
const XYZ65_TO_LIN_SRGB: Mat = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const LIN_P3_TO_XYZ65: Mat = [
  [0.4865709486482162, 0.26566769316909306, 0.19821728523436247],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const D50_TO_D65: Mat = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const OKLAB_TO_LMS: Mat = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_LIN_SRGB: Mat = [
  [4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
  [-1.2684379732850315, 2.6097573492876882, -0.3413193760026573],
  [-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];

const fromLinear = (lin: Vec, a: number): Paint => {
  const [r, g, b] = lin.map((c) => toByte(encode(c))) as Vec;
  return { r, g, b, a };
};

function lab(L: number, A: number, B: number, a: number): Paint {
  // CIE Lab (D50) -> XYZ D50 -> D65 -> linear sRGB.
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = f1 + A / 500;
  const f2 = f1 - B / 200;
  const x = f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k;
  const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const z = f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k;
  const d50: Vec = [(x * 0.3457) / 0.3585, y, (z * (1 - 0.3457 - 0.3585)) / 0.3585];
  return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, d50)), a);
}

function oklab(L: number, A: number, B: number, a: number): Paint {
  const lms = mul(OKLAB_TO_LMS, [L, A, B]).map((c) => c ** 3) as Vec;
  return fromLinear(mul(LMS_TO_LIN_SRGB, lms), a);
}

const polar = (C: number, H: number): [number, number] => [
  C * Math.cos((H * Math.PI) / 180),
  C * Math.sin((H * Math.PI) / 180),
];

/** The colour as sRGB numbers (channels 0–255, alpha 0–1), or null if it is not one this parser knows. */
export function parseColor(css: string): Paint | null {
  const p = convert(css);
  // Huge components overflow the matrices into Infinity - Infinity.
  return p && [p.r, p.g, p.b, p.a].every(Number.isFinite) ? p : null;
}

function convert(css: string): Paint | null {
  const m = /^([a-z-]+)\(([^()]*)\)$/.exec(css.trim().toLowerCase());
  if (!m) return css.trim().toLowerCase() === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  const fn = m[1] as string;
  const body = split(m[2] as string);
  if (!body) return null;
  const a = alphaOf(body.alpha);
  if (a === null) return null;
  let parts = body.parts;
  let space: string | null = null;
  if (fn === "color") {
    space = parts[0] ?? null;
    parts = parts.slice(1);
  }
  if (parts.length !== 3) return null;
  const cs = parts.map(component);
  if (cs.some((c) => c === null)) return null;
  const [c0, c1, c2] = cs as [Component, Component, Component];
  // Percentages scale to each space's reference range.
  const v = (c: Component, full: number) => (c.percent ? (c.value / 100) * full : c.value);

  switch (fn) {
    case "rgb":
    case "rgba":
      return { r: toByte(v(c0, 255) / 255), g: toByte(v(c1, 255) / 255), b: toByte(v(c2, 255) / 255), a };
    case "color": {
      const rgb: Vec = [v(c0, 1), v(c1, 1), v(c2, 1)];
      if (space === "srgb") return { r: toByte(rgb[0]), g: toByte(rgb[1]), b: toByte(rgb[2]), a };
      if (space === "srgb-linear") return fromLinear(rgb, a);
      if (space === "display-p3")
        return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(LIN_P3_TO_XYZ65, rgb.map(decode) as Vec)), a);
      if (space === "xyz" || space === "xyz-d65") return fromLinear(mul(XYZ65_TO_LIN_SRGB, rgb), a);
      if (space === "xyz-d50") return fromLinear(mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, rgb)), a);
      return null;
    }
    case "lab":
      return lab(v(c0, 100), v(c1, 125), v(c2, 125), a);
    case "lch":
      return lab(v(c0, 100), ...polar(v(c1, 150), c2.value), a);
    case "oklab":
      return oklab(v(c0, 1), v(c1, 0.4), v(c2, 0.4), a);
    case "oklch":
      return oklab(v(c0, 1), ...polar(v(c1, 0.4), c2.value), a);
    default:
      return null;
  }
}
