// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignLines,
  groupIntoLines,
  intersect,
  lineIndexOf,
  linksRelativeTo,
  minus,
  runsRelativeTo,
  union,
} from "../../src/shared/geometry.ts";
import type { DocRect, LinkArea, TextRun } from "../../src/shared/types.ts";

const R = (x: number, y: number, width: number, height: number): DocRect => ({ x, y, width, height });

test("intersect: overlap, touching edges and disjoint rects", () => {
  assert.deepEqual(intersect(R(0, 0, 10, 10), R(5, 5, 10, 10)), R(5, 5, 5, 5));
  assert.equal(intersect(R(0, 0, 10, 10), R(10, 0, 5, 5)), null);
  assert.equal(intersect(R(0, 0, 10, 10), R(20, 20, 5, 5)), null);
});

test("union: smallest rect around both", () => {
  assert.deepEqual(union(R(0, 0, 10, 10), R(20, 5, 5, 20)), R(0, 0, 25, 25));
});

test("minus: the bands of a rect around a hole, none where the hole reaches the edge", () => {
  // A hole inside: above, below, left, right.
  assert.deepEqual(minus(R(0, 0, 10, 10), R(2, 3, 4, 5)), [
    R(0, 0, 10, 3),
    R(0, 8, 10, 2),
    R(0, 3, 2, 5),
    R(6, 3, 4, 5),
  ]);
  // A hole over the top-left corner and beyond: only below and right remain.
  assert.deepEqual(minus(R(0, 0, 10, 10), R(-5, -5, 10, 10)), [R(0, 5, 10, 5), R(5, 0, 5, 5)]);
  // No overlap: the whole rect; a hole over all of it: nothing.
  assert.deepEqual(minus(R(0, 0, 10, 10), R(20, 0, 5, 5)), [R(0, 0, 10, 10)]);
  assert.deepEqual(minus(R(0, 0, 10, 10), R(-1, -1, 12, 12)), []);
});

test("groupIntoLines: bidi fragments of one line merge, lines stay apart", () => {
  // Latin, a taller fallback-font Hebrew fragment, Latin; then a second line.
  const groups = groupIntoLines([
    R(0, 155, 66, 20),
    R(66, 152, 43, 23),
    R(109, 155, 105, 20),
    R(0, 185, 80, 20),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.rect, R(0, 152, 214, 23));
  assert.equal(groups[0]?.parts.length, 3);
  assert.deepEqual(groups[1]?.rect, R(0, 185, 80, 20));
});

test("groupIntoLines: a three-line ::first-letter joins the first line, not the ones below", () => {
  const groups = groupIntoLines([
    R(0, 200, 36, 44),
    R(36, 203, 48, 24),
    R(36, 233, 60, 24),
    R(0, 263, 108, 24),
  ]);
  assert.deepEqual(
    groups.map((g) => g.rect.y),
    [200, 233, 263],
  );
});

test("groupIntoLines: a drop cap three lines tall stays apart from all of them", () => {
  // Relative to the shorter rect every line would overlap the cap fully and merge.
  const groups = groupIntoLines([R(0, 0, 40, 72), R(40, 0, 60, 24), R(40, 30, 60, 24), R(0, 60, 100, 24)]);
  assert.deepEqual(
    groups.map((g) => g.rect.y),
    [0, 0, 30, 60],
  );
});

test("groupIntoLines: columns at the same height stay separate lines, in content order", () => {
  // Column one: two lines; column two starts again at the top.
  const groups = groupIntoLines([
    R(0, 0, 100, 20),
    R(0, 30, 100, 20),
    R(150, 0, 100, 20),
    R(150, 30, 100, 20),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.rect.x, g.rect.y]),
    [
      [0, 0],
      [0, 30],
      [150, 0],
      [150, 30],
    ],
  );
});

test("lineIndexOf: the fragment containing the character wins over an equal overlap", () => {
  const groups = groupIntoLines([R(0, 0, 100, 20), R(0, 30, 100, 20), R(150, 0, 100, 20)]);
  assert.equal(lineIndexOf(groups, R(160, 0, 8, 20)), 2);
  assert.equal(lineIndexOf(groups, R(10, 0, 8, 20)), 0);
});

test("lineIndexOf: best vertical overlap, nearest centre when none", () => {
  const groups = groupIntoLines([R(0, 0, 100, 20), R(0, 30, 100, 20)]);
  assert.equal(lineIndexOf(groups, R(10, 31, 5, 20)), 1);
  assert.equal(lineIndexOf(groups, R(10, 0, 5, 20)), 0);
  assert.equal(lineIndexOf(groups, R(10, 90, 5, 20)), 1);
});

const run = (top: number, height: number, block: number): TextRun => ({
  text: "t",
  x: 0,
  y: top + height * 0.8,
  top,
  width: 10,
  height,
  fontFamily: "serif",
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  color: "rgb(0, 0, 0)",
  lang: null,
  dir: "ltr",
  href: null,
  line: -1,
  block,
});

test("assignLines: same line while centre stays in the previous box and block is unchanged", () => {
  const runs = [run(0, 20, 0), run(2, 16, 0), run(30, 20, 0), run(30, 20, 1), run(31, 20, 1)];
  assert.deepEqual(
    assignLines(runs).map((r) => r.line),
    [0, 0, 1, 2, 2],
  );
});

test("assignLines: a run below a drop-cap run's baseline starts a new line", () => {
  // Measured on Linux CI (first-letter.html): the first run's box includes the
  // 45 px initial (40..85, baseline 62); the next line's centre is exactly 85.
  const capRun = { ...run(40, 45, 0), y: 62 };
  const next = { ...run(72, 26, 0), y: 92 };
  assert.deepEqual(
    assignLines([capRun, next]).map((r) => r.line),
    [0, 1],
  );
});

test("assignLines: a run three times taller on the same baseline stays on the line, in either order", () => {
  // 16 px and 48 px text on one baseline (y 114.5): the tall box's centre lies
  // above the short one's box, the short box's centre inside the tall one.
  const short = { ...run(100, 18, 0), y: 114.5 };
  const tall = { ...run(70.5, 55, 0), y: 114.5 };
  assert.deepEqual(
    assignLines([short, tall]).map((r) => r.line),
    [0, 0],
  );
  assert.deepEqual(
    assignLines([tall, short]).map((r) => r.line),
    [0, 0],
  );
  // The next line below either still starts a new one.
  const below = { ...run(130, 18, 0), y: 144.5 };
  assert.deepEqual(
    assignLines([short, tall, below]).map((r) => r.line),
    [0, 0, 1],
  );
  // A tall run on the next line under a tight line-height reaches up over the
  // short one's centre, but its baseline lies a line below.
  const pro = { ...run(0, 18.4, 0), y: 14.7 };
  const price = { ...run(7.7, 55, 0), y: 50.7 };
  assert.deepEqual(
    assignLines([pro, price]).map((r) => r.line),
    [0, 1],
  );
  // Chromium's own run for a floated drop cap: its baseline lies 28 px below
  // the line's (first-letter.html), the text after it is on its line.
  const cap = { ...run(10, 68, 0), y: 63 };
  const rest = { ...run(12, 23, 0), y: 35 };
  assert.deepEqual(
    assignLines([cap, rest]).map((r) => r.line),
    [0, 0],
  );
  // A small raised currency sign before a big number: the number's baseline
  // lies lower by more than the sign is tall, but it goes on from the sign.
  const sign = { ...run(0, 17, 0), x: 0, width: 9, y: 14 };
  const number = { ...run(4, 69, 0), x: 9, width: 66, y: 59 };
  assert.deepEqual(
    assignLines([sign, number]).map((r) => r.line),
    [0, 0],
  );
  // A superscript and the text after it share the line.
  const base = { ...run(100, 18, 0), y: 114 };
  const sup = { ...run(95, 14, 0), y: 106 };
  assert.deepEqual(
    assignLines([base, sup, { ...base, x: 30 }]).map((r) => r.line),
    [0, 0, 0],
  );
});

test("runsRelativeTo: shifts x, baseline and top by the region origin", () => {
  const [moved] = runsRelativeTo([{ ...run(100, 20, 0), x: 50, y: 116 }], R(40, 90, 500, 500));
  assert.equal(moved?.x, 10);
  assert.equal(moved?.y, 26);
  assert.equal(moved?.top, 10);
  assert.equal(moved?.width, 10);
  assert.equal(moved?.height, 20);
});

test("linksRelativeTo: shifts x and y, keeps size", () => {
  const link: LinkArea = { x: 50, y: 100, width: 30, height: 40, alt: "a", href: null };
  assert.deepEqual(linksRelativeTo([link], R(40, 90, 500, 500)), [{ ...link, x: 10, y: 10 }]);
});
