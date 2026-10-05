// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { borderSides, doubleLine, type SideDash, sideDash } from "../../src/content/extract/border.ts";
import type { Paint } from "../../src/shared/types.ts";

// Measured on a box's top side at DPR 1 (Playwright Firefox build 1543,
// Chromium build 1243, 2026-10-05): the number of ink and gap segments along
// the side's middle row, per border width and side length.
const segments = (d: SideDash, length: number): number => {
  if (d.round) return 2 * (Math.round((d.to - d.from) / d.gap) + 1) - 1;
  const period = d.dash + d.gap;
  const dashes = Math.round((length + d.gap) / period);
  return 2 * dashes - 1;
};

const MEASURED: Record<string, Record<number, Record<number, number>>> = {
  "firefox dashed": {
    1: { 30: 11, 39: 13, 48: 17, 57: 19, 120: 41, 210: 71 },
    2: { 30: 5, 39: 7, 57: 11, 66: 11, 120: 21, 210: 35 },
    3: { 30: 5, 48: 7, 66: 9, 97: 11, 120: 15, 210: 25 },
    4: { 30: 3, 39: 5, 66: 7, 93: 9, 120: 11, 210: 19 },
    6: { 30: 3, 57: 5, 93: 7, 129: 9, 201: 13 },
  },
  "chromium dashed": {
    1: { 30: 11, 39: 15, 48: 19, 120: 47, 210: 83 },
    2: { 30: 7, 39: 7, 66: 13, 120: 23, 210: 41 },
    3: { 30: 7, 39: 9, 120: 27, 210: 47 },
    4: { 30: 5, 39: 7, 48: 7, 120: 19, 210: 35 },
    6: { 30: 3, 39: 5, 57: 7, 120: 13, 210: 23 },
  },
  "firefox dotted": {
    3: { 30: 11, 39: 13, 48: 17, 120: 41 },
    4: { 30: 9, 39: 11, 102: 27, 210: 53 },
    6: { 30: 5, 66: 11, 102: 17, 210: 35 },
  },
  "chromium dotted": {
    2: { 30: 15, 39: 19, 48: 25, 120: 61, 210: 105 },
    4: { 30: 7, 39: 9, 48: 13, 57: 15, 120: 31 },
    6: { 30: 5, 39: 7, 48: 9, 57: 9, 84: 15, 102: 17 },
  },
};

for (const [key, byWidth] of Object.entries(MEASURED)) {
  const [target, style] = key.split(" ") as ["firefox" | "chromium", "dashed" | "dotted"];
  test(`sideDash: ${key} as measured, a dash or dot at both ends`, () => {
    for (const [w, byLength] of Object.entries(byWidth))
      for (const [L, count] of Object.entries(byLength)) {
        const d = sideDash(style, Number(L), Number(w), 1, target);
        assert.ok(d, `${key} w${w} L${L}`);
        assert.equal(segments(d, Number(L)), count, `${key} w${w} L${L}`);
        if (!d.round) {
          // Dashes from end to end: n dashes and n - 1 gaps fill the side.
          const n = (count + 1) / 2;
          assert.ok(Math.abs(n * d.dash + (n - 1) * d.gap - Number(L)) < 1e-9, `${key} w${w} L${L} fills`);
          assert.equal(d.from, 0);
          assert.equal(d.to, Number(L));
        }
      }
  });
}

test("sideDash: Chromium never takes a gap of nothing, even when it is as near as the other (SelectBestDashGap)", () => {
  // 18 px of 6 px dashes: two with a 6 px gap, or three with none; 3 px is the target, a tie.
  assert.equal(sideDash("dashed", 18, 3, 1, "chromium")?.gap, 6);
});

test("sideDash: Chromium's dash is 3 widths below 3 device px, 2 from there; Firefox's dash is its gap", () => {
  assert.equal(sideDash("dashed", 120, 2, 1, "chromium")?.dash, 6);
  assert.equal(sideDash("dashed", 120, 3, 1, "chromium")?.dash, 6);
  // 2 CSS px at DPR 2 are 4 device px: the thick ratio.
  assert.equal(sideDash("dashed", 120, 2, 2, "chromium")?.dash, 4);
  const ff = sideDash("dashed", 120, 3, 1, "firefox");
  assert.equal(ff?.dash, 8);
  assert.equal(ff?.gap, 8);
});

test("sideDash: thin dots are square, from the corner on, the last one cut where the side ends", () => {
  for (const target of ["firefox", "chromium"] as const)
    assert.deepEqual(sideDash("dotted", 30, 1, 1, target), {
      from: 0,
      to: 30,
      dash: 1,
      gap: 1,
      round: false,
    });
  assert.deepEqual(sideDash("dotted", 39, 2, 1, "firefox"), {
    from: 0,
    to: 39,
    dash: 2,
    gap: 2,
    round: false,
  });
  // 1 CSS px at DPR 3 is 3 device px: round dots.
  assert.equal(sideDash("dotted", 30, 1, 3, "firefox")?.round, true);
});

test("sideDash: round dots sit centred, the first and last inside the side", () => {
  const ff = sideDash("dotted", 30, 3, 1, "firefox");
  assert.ok(ff?.round);
  assert.equal(ff.dash, 0);
  // 11 segments of 30/11: dots centred half a segment in.
  assert.ok(Math.abs(ff.from - 15 / 11) < 1e-9);
  assert.ok(Math.abs(ff.to - (30 - 15 / 11)) < 1e-9);
  assert.ok(Math.abs(ff.gap - 60 / 11) < 1e-9);
  const cr = sideDash("dotted", 57, 4, 1, "chromium");
  assert.ok(cr?.round);
  assert.equal(cr.from, 2);
  assert.equal(cr.to, 55);
  assert.ok(Math.abs(cr.gap - 53 / 7) < 1e-9);
});

test("sideDash: a side too short for two dashes is solid (null); no length or width, nothing", () => {
  assert.equal(sideDash("dashed", 9, 3, 1, "firefox"), null);
  assert.equal(sideDash("dashed", 20, 6, 1, "chromium"), null);
  assert.equal(sideDash("dotted", 5, 4, 1, "chromium"), null);
  assert.equal(sideDash("dotted", 3, 3, 1, "firefox"), null);
  for (const [L, w] of [
    [0, 2],
    [30, 0],
    [Number.NaN, 2],
  ])
    assert.equal(sideDash("dashed", L as number, w as number, 1, "firefox"), null);
});

test("doubleLine: one line under 3 device px, else two of a third of the width rounded (measured, both browsers)", () => {
  // w: line thickness, as both browsers drew w = 1..12 px.
  const measured = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4];
  for (let w = 1; w <= 12; w++) assert.equal(doubleLine(w, 1), measured[w] || null, `w${w}`);
  // 2 CSS px at DPR 2: 4 device px, lines of 1 device px.
  assert.equal(doubleLine(2, 2), 0.5);
});

const BLACK: Paint = { r: 0, g: 0, b: 0, a: 1 };
const side = (width: number, style: string, paint: Paint | null = BLACK) => ({ width, style, paint });

test("borderSides: a double border is two lines a side, the inner ones kept off the double neighbours' outer lines", () => {
  const box = { x: 10, y: 20, width: 100, height: 44 };
  const ops = borderSides(
    box,
    [0, 1, 2, 3].map(() => side(6, "double")),
    1,
    "firefox",
  );
  const rect = (x: number, y: number, width: number, height: number) => ({
    op: "rect",
    x,
    y,
    width,
    height,
    fill: BLACK,
  });
  assert.deepEqual(ops, [
    rect(10, 20, 100, 2),
    rect(14, 24, 92, 2),
    rect(108, 20, 2, 44),
    rect(104, 24, 2, 36),
    rect(10, 62, 100, 2),
    rect(14, 58, 92, 2),
    rect(10, 20, 2, 44),
    rect(14, 24, 2, 36),
  ]);
});

test("borderSides: each side by its own style; a hidden double neighbour keeps no inset", () => {
  const box = { x: 0, y: 0, width: 100, height: 44 };
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const ops = borderSides(
    box,
    [side(2, "dashed", red), side(4, "dotted"), side(3, "double"), side(1, "solid")],
    1,
    "firefox",
  );
  assert.deepEqual(ops, [
    { op: "line", x1: 0, y1: 1, x2: 100, y2: 1, width: 2, paint: red, dash: [100 / 17, 100 / 17] },
    // Round dots run on half a gap past the last one.
    { op: "line", x1: 98, y1: 2, x2: 98, y2: 46, width: 4, paint: BLACK, dash: [0, 8], round: true },
    { op: "rect", x: 0, y: 43, width: 100, height: 1, fill: BLACK },
    { op: "rect", x: 0, y: 41, width: 100, height: 1, fill: BLACK },
    { op: "rect", x: 0, y: 0, width: 1, height: 44, fill: BLACK },
  ]);
  // The top's inner line spans the whole side when the left double side is not shown.
  const hidden = borderSides(
    box,
    [side(6, "double"), side(0, "none"), side(0, "none"), side(6, "double", null)],
    1,
  );
  assert.deepEqual(hidden[1], { op: "rect", x: 0, y: 4, width: 100, height: 2, fill: BLACK });
});

test("borderSides: a side too thin for two lines or too short for its dashes is its band; unshown sides nothing", () => {
  const box = { x: 0, y: 0, width: 100, height: 8 };
  const ops = borderSides(
    box,
    [side(2, "double"), side(3, "dashed"), side(1, "dotted", { ...BLACK, a: 0 }), side(0, "solid")],
    1,
    "firefox",
  );
  assert.deepEqual(ops, [
    { op: "rect", x: 0, y: 0, width: 100, height: 2, fill: BLACK },
    { op: "rect", x: 97, y: 0, width: 3, height: 8, fill: BLACK },
  ]);
  assert.deepEqual(
    borderSides(box, [side(1, "dotted", null), side(0, "none"), side(0, "none"), side(0, "none")], 1),
    [],
  );
});
