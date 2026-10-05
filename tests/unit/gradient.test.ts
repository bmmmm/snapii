// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { linearGradient } from "../../src/content/extract/gradient.ts";
import { MAX_GRADIENT_STOPS } from "../../src/shared/messages.ts";
import type { LinearGradient } from "../../src/shared/types.ts";

const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";

/** The line and the stops' offsets, rounded to 3 decimals; stops as [offset, r, g, b, a]. */
function shape(g: LinearGradient | null) {
  assert.ok(g, "parsed");
  const r = (n: number) => Math.round(n * 1000) / 1000 + 0;
  return {
    from: g.from.map(r),
    to: g.to.map(r),
    stops: g.stops.map((s) => [r(s.offset), r(s.paint.r), r(s.paint.g), r(s.paint.b), r(s.paint.a)]),
  };
}

const RB = [
  [0, 255, 0, 0, 1],
  [1, 0, 0, 255, 1],
];

test("linearGradient: no direction runs to the bottom, through the box's height", () => {
  assert.deepEqual(shape(linearGradient(`linear-gradient(${RED}, ${BLUE})`, 100, 50)), {
    from: [50, 0],
    to: [50, 50],
    stops: RB,
  });
});

test("linearGradient: an angle (0deg up, clockwise) in any unit, and the side keywords", () => {
  const right = { from: [0, 25], to: [100, 25], stops: RB };
  for (const dir of ["90deg", "0.25turn", "100grad", `${Math.PI / 2}rad`, "to right"])
    assert.deepEqual(shape(linearGradient(`linear-gradient(${dir}, ${RED}, ${BLUE})`, 100, 50)), right, dir);
  assert.deepEqual(shape(linearGradient(`linear-gradient(to top, ${RED}, ${BLUE})`, 100, 50)), {
    from: [50, 50],
    to: [50, 0],
    stops: RB,
  });
  assert.deepEqual(shape(linearGradient(`linear-gradient(to left, ${RED}, ${BLUE})`, 100, 50)), {
    from: [100, 25],
    to: [0, 25],
    stops: RB,
  });
  assert.deepEqual(
    shape(linearGradient(`linear-gradient(to bottom, ${RED}, ${BLUE})`, 100, 50)),
    shape(linearGradient(`linear-gradient(${RED}, ${BLUE})`, 100, 50)),
  );
  // 45deg over 100 x 50: the line is as long as the box's extent along it.
  const l = (100 + 50) * Math.SQRT1_2;
  const half = (l / 2) * Math.SQRT1_2;
  assert.deepEqual(shape(linearGradient(`linear-gradient(45deg, ${RED}, ${BLUE})`, 100, 50)), {
    from: [50 - half, 25 + half].map((n) => Math.round(n * 1000) / 1000),
    to: [50 + half, 25 - half].map((n) => Math.round(n * 1000) / 1000),
    stops: RB,
  });
});

test("linearGradient: towards a corner, the middle of the line meets the other two corners", () => {
  // 200 x 100, to top right: starts at the bottom-left corner's level, ends at the top-right's.
  const g = linearGradient(`linear-gradient(to top right, ${RED}, ${BLUE})`, 200, 100);
  assert.deepEqual(shape(g), { from: [60, 130], to: [140, -30], stops: RB });
  // Either keyword order.
  assert.deepEqual(
    shape(linearGradient(`linear-gradient(to right top, ${RED}, ${BLUE})`, 200, 100)),
    shape(g),
  );
  // The opposite corner: the same line, the other way.
  assert.deepEqual(shape(linearGradient(`linear-gradient(to bottom left, ${RED}, ${BLUE})`, 200, 100)), {
    from: [140, -30],
    to: [60, 130],
    stops: RB,
  });
  // The top-left and the bottom-right corner lie on the line's normal through its middle.
  const [x1, y1] = (g as LinearGradient).from;
  const [x2, y2] = (g as LinearGradient).to;
  const along = (x: number, y: number) =>
    ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2);
  assert.ok(Math.abs(along(0, 0) - 0.5) < 1e-9);
  assert.ok(Math.abs(along(200, 100) - 0.5) < 1e-9);
  assert.ok(Math.abs(along(0, 100)) < 1e-9);
});

test("linearGradient: positions in % and px of the line, two positions, the CSS fixup", () => {
  // To the bottom of a 50 px box: 10px is 0.2 of the line.
  assert.deepEqual(shape(linearGradient(`linear-gradient(${RED} 10px, ${BLUE} 80%)`, 100, 50)).stops, [
    [0.2, 255, 0, 0, 1],
    [0.8, 0, 0, 255, 1],
  ]);
  // Two positions: a hard edge at the middle.
  assert.deepEqual(shape(linearGradient(`linear-gradient(${RED} 0% 50%, ${BLUE} 50%)`, 100, 50)).stops, [
    [0, 255, 0, 0, 1],
    [0.5, 255, 0, 0, 1],
    [0.5, 0, 0, 255, 1],
  ]);
  // Missing positions spread evenly; one before the stop ahead of it moves up to it.
  const green = "rgb(0, 128, 0)";
  assert.deepEqual(
    shape(linearGradient(`linear-gradient(${RED}, ${green}, ${green}, ${BLUE})`, 100, 50)).stops.map(
      (s) => s[0],
    ),
    [0, 0.333, 0.667, 1],
  );
  assert.deepEqual(
    shape(linearGradient(`linear-gradient(${RED} 50%, ${BLUE} 20%)`, 100, 50)).stops.map((s) => s[0]),
    [0.5, 0.5],
  );
  // The first stop is at 0 before the others are clamped to it.
  assert.deepEqual(
    shape(linearGradient(`linear-gradient(${RED}, ${BLUE} -20%)`, 100, 50)).stops.map((s) => s[0]),
    [0, 0],
  );
});

test("linearGradient: stops beyond the box move the line's ends out, offsets stay 0-1", () => {
  assert.deepEqual(shape(linearGradient(`linear-gradient(${RED} -50%, ${BLUE} 150%)`, 100, 50)), {
    from: [50, -25],
    to: [50, 75],
    stops: RB,
  });
  // One stop beyond: the others keep their places along the line.
  assert.deepEqual(shape(linearGradient(`linear-gradient(${RED}, ${BLUE} 200%)`, 100, 50)), {
    from: [50, 0],
    to: [50, 100],
    stops: [
      [0, 255, 0, 0, 1],
      [1, 0, 0, 255, 1],
    ],
  });
});

test("linearGradient: towards transparency the colour stays, as premultiplied interpolation keeps it", () => {
  const g = shape(linearGradient(`linear-gradient(rgba(0, 0, 0, 0), ${RED})`, 100, 50));
  // No step through grey: every stop is red, only its alpha rises.
  assert.ok(
    g.stops.every(([, r, gg, b]) => r === 255 && gg === 0 && b === 0),
    JSON.stringify(g.stops),
  );
  assert.deepEqual(
    g.stops.map((s) => s[4]),
    [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1],
  );
  // The other way round alike.
  const out = shape(linearGradient(`linear-gradient(${RED}, rgba(0, 0, 0, 0))`, 100, 50));
  assert.ok(
    out.stops.every(([, r, gg, b]) => r === 255 && gg === 0 && b === 0),
    JSON.stringify(out.stops),
  );
  // A transparent stop between two colours fades out of one and into the other.
  const mid = shape(linearGradient(`linear-gradient(${RED}, rgba(0, 0, 0, 0), ${BLUE})`, 100, 50)).stops;
  const atHalf = mid.filter((s) => s[0] === 0.5);
  assert.deepEqual(atHalf, [
    [0.5, 255, 0, 0, 0],
    [0.5, 0, 0, 255, 0],
  ]);
  // Half-transparent red to blue: in the middle 3/4 alpha, a third red, two thirds blue.
  const half = shape(linearGradient(`linear-gradient(rgba(255, 0, 0, 0.5), ${BLUE})`, 100, 50)).stops;
  assert.deepEqual(
    half.find((s) => s[0] === 0.5),
    [0.5, 85, 0, 170, 0.75],
  );
});

test("linearGradient: every stop's channels stay within 0-255, exactly (the background refuses anything else)", () => {
  // Bootstrap's .bg-gradient, then a sweep of fades between full channels at partial alphas.
  const values = ["linear-gradient(180deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0))"];
  for (const a of [0.01, 0.15, 0.3, 0.5, 0.7, 0.99])
    for (const b of [0, 0.05, 0.4, 0.6, 1])
      values.push(`linear-gradient(rgba(255, 255, 0, ${a}), rgba(255, 0, 255, ${b}))`);
  for (const value of values) {
    const g = linearGradient(value, 100, 50);
    assert.ok(g, value);
    for (const { paint } of g.stops)
      for (const k of ["r", "g", "b"] as const)
        assert.ok(paint[k] >= 0 && paint[k] <= 255, `${value}: ${k} ${paint[k]}`);
  }
});

test("linearGradient: never more stops than the background takes; a hard edge adds none", () => {
  // 220 stripes with hard edges between red and transparent: drawn, within the limit.
  const stripes = Array.from({ length: 220 }, (_, i) =>
    i % 2 ? `rgba(0, 0, 0, 0) ${i}px ${i + 1}px` : `rgb(255, 0, 0) ${i}px ${i + 1}px`,
  );
  const g = linearGradient(`linear-gradient(to right, ${stripes.join(", ")})`, 220, 10);
  assert.ok(g);
  assert.ok(g.stops.length <= MAX_GRADIENT_STOPS, String(g.stops.length));
  // 260 soft changes of alpha need more steps than that: a patch, not a refused save.
  const soft = Array.from({ length: 260 }, (_, i) => (i % 2 ? "rgba(0, 0, 255, 0.5)" : RED));
  assert.equal(linearGradient(`linear-gradient(${soft.join(", ")})`, 100, 50), null);
});

test("linearGradient: what SVG would draw otherwise is null", () => {
  for (const value of [
    `radial-gradient(${RED}, ${BLUE})`,
    `repeating-linear-gradient(${RED}, ${BLUE} 10px)`,
    `linear-gradient(${RED}, ${BLUE}), linear-gradient(${BLUE}, ${RED})`,
    `linear-gradient(${RED}, 30%, ${BLUE})`,
    `linear-gradient(in oklab, ${RED}, ${BLUE})`,
    `linear-gradient(90deg in oklab, ${RED}, ${BLUE})`,
    `linear-gradient(${RED} calc(10% + 5px), ${BLUE})`,
    `linear-gradient(oklch(0.5 0.2 30), ${BLUE})`,
    `linear-gradient(rgb(x, y, z), ${BLUE})`,
    `linear-gradient(${RED} 1em, ${BLUE})`,
    `linear-gradient(${RED})`,
    `linear-gradient(${RED} 1% 2% 3%, ${BLUE})`,
    `linear-gradient(to middle, ${RED}, ${BLUE})`,
    `url("x.png")`,
    "none",
  ])
    assert.equal(linearGradient(value, 100, 50), null, value);
  // A box of no extent along the line.
  assert.equal(linearGradient(`linear-gradient(${RED}, ${BLUE})`, 100, 0), null);
});
