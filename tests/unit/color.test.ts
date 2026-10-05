// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColor } from "../../src/shared/color.ts";
import type { Paint } from "../../src/shared/types.ts";

/** Channels within 1 of the expected byte (conversions round), alpha within 0.001. */
function near(got: Paint | null, want: Paint, what: string): void {
  assert.ok(got, `${what}: parsed`);
  for (const k of ["r", "g", "b"] as const)
    assert.ok(Math.abs(got[k] - want[k]) <= 1, `${what}: ${k} ${got[k]} vs ${want[k]}`);
  assert.ok(Math.abs(got.a - want.a) <= 0.001, `${what}: a ${got.a} vs ${want.a}`);
}

test("parseColor: rgb() and rgba() as getComputedStyle writes them", () => {
  assert.deepEqual(parseColor("rgb(0, 0, 0)"), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("rgb(255, 128, 1)"), { r: 255, g: 128, b: 1, a: 1 });
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 });
  // The space syntax, percentages, `none`.
  assert.deepEqual(parseColor("rgb(10 20 30 / 25%)"), { r: 10, g: 20, b: 30, a: 0.25 });
  assert.deepEqual(parseColor("rgb(100% 0% none)"), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  // Out of range clamps; fractional channels stay (the renderer rounds).
  assert.deepEqual(parseColor("rgb(300, -5, 12.5)"), { r: 255, g: 0, b: 12.5, a: 1 });
  assert.deepEqual(parseColor("rgba(1, 2, 3, 7)"), { r: 1, g: 2, b: 3, a: 1 });
});

test("parseColor: color() spaces convert to sRGB", () => {
  assert.deepEqual(parseColor("color(srgb 1 0.5 0)"), { r: 255, g: 127.5, b: 0, a: 1 });
  assert.deepEqual(parseColor("color(srgb 0 0 1 / 0.4)"), { r: 0, g: 0, b: 255, a: 0.4 });
  near(
    parseColor("color(srgb-linear 0.2140 0.2140 0.2140)"),
    { r: 128, g: 128, b: 128, a: 1 },
    "srgb-linear grey",
  );
  // Display-P3 red lies outside sRGB: clamped to sRGB red.
  near(parseColor("color(display-p3 1 0 0)"), { r: 255, g: 0, b: 0, a: 1 }, "p3 red");
  near(parseColor("color(display-p3 0.5 0.5 0.5)"), { r: 128, g: 128, b: 128, a: 1 }, "p3 grey");
  near(parseColor("color(xyz-d65 0.9505 1 1.089)"), { r: 255, g: 255, b: 255, a: 1 }, "xyz white");
  near(parseColor("color(xyz-d50 0.9643 1 0.8251)"), { r: 255, g: 255, b: 255, a: 1 }, "xyz-d50 white");
});

test("parseColor: oklab, oklch, lab and lch", () => {
  near(parseColor("oklch(1 0 0)"), { r: 255, g: 255, b: 255, a: 1 }, "oklch white");
  near(parseColor("oklch(0 0 0)"), { r: 0, g: 0, b: 0, a: 1 }, "oklch black");
  near(parseColor("oklab(0.627955 0.224863 0.125846)"), { r: 255, g: 0, b: 0, a: 1 }, "oklab red");
  near(parseColor("oklch(0.627955 0.257683 29.2339 / 0.5)"), { r: 255, g: 0, b: 0, a: 0.5 }, "oklch red");
  near(parseColor("oklch(45.2% 0.313214 264.052)"), { r: 0, g: 0, b: 255, a: 1 }, "oklch blue, L in %");
  near(parseColor("lab(54.29 80.8 69.89)"), { r: 255, g: 0, b: 0, a: 1 }, "lab red");
  near(parseColor("lab(100 0 0)"), { r: 255, g: 255, b: 255, a: 1 }, "lab white");
  near(parseColor("lch(54.29 106.84 40.85)"), { r: 255, g: 0, b: 0, a: 1 }, "lch red");
});

test("parseColor: anything else is null, never a string passed through", () => {
  for (const s of [
    "",
    "red",
    "currentcolor",
    "#ff0000",
    "hsl(0 100% 50%)",
    "rgb(1, 2)",
    "rgb(1, 2, 3, 4, 5)",
    "rgb(a, b, c)",
    "rgb(1, 2, 3) url(x)",
    "rgb(1 2 3 / 4 / 5)",
    'rgb(1, 2, 3)"><script>alert(1)</script>',
    "color(foo 1 2 3)",
    "color(srgb 1 2)",
    "oklch(0.5 0.1 200deg)",
    "rgb(1px, 2, 3)",
    "rgb(calc(1), 2, 3)",
    // Components so large the conversion overflows into NaN.
    "lab(50 1e300 0)",
    "oklch(1e300 0 0)",
    "color(display-p3 1e300 1e300 0)",
  ]) {
    assert.equal(parseColor(s), null, JSON.stringify(s));
  }
});
