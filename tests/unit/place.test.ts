// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { placeToolbar, TOOLBAR_GAP } from "../../src/shared/place.ts";

const TB = { width: 300, height: 36 };
// Viewport scrolled to (0, 1000), 1280 × 720 visible.
const VP = { x: 0, y: 1000, width: 1280, height: 720 };

test("below the selection when it fits, right-aligned to it", () => {
  const p = placeToolbar({ x: 200, y: 1100, width: 600, height: 300 }, TB, VP);
  assert.deepEqual(p, { x: 500, y: 1400 + TOOLBAR_GAP });
});

test("below is exact at the viewport's bottom edge", () => {
  const bottom = VP.y + VP.height - TB.height - TOOLBAR_GAP;
  const p = placeToolbar({ x: 200, y: 1100, width: 600, height: bottom - 1100 }, TB, VP);
  assert.equal(p.y, bottom + TOOLBAR_GAP);
});

test("above when there is no room below", () => {
  const p = placeToolbar({ x: 200, y: 1300, width: 600, height: 400 }, TB, VP);
  assert.deepEqual(p, { x: 500, y: 1300 - TOOLBAR_GAP - TB.height });
});

test("inside the bottom edge when neither below nor above fits", () => {
  const p = placeToolbar({ x: 200, y: 1010, width: 600, height: 690 }, TB, VP);
  assert.deepEqual(p, { x: 500, y: 1700 - TOOLBAR_GAP - TB.height });
});

test("inside the visible part when the selection runs past the viewport", () => {
  const p = placeToolbar({ x: 0, y: 500, width: 1280, height: 3000 }, TB, VP);
  assert.equal(p.y, 1720 - TOOLBAR_GAP - TB.height);
});

test("a selection entirely off screen still gets an on-screen toolbar", () => {
  const above = placeToolbar({ x: 200, y: 100, width: 600, height: 300 }, TB, VP);
  assert.equal(above.y, VP.y);
  const below = placeToolbar({ x: 200, y: 3000, width: 600, height: 300 }, TB, VP);
  assert.equal(below.y, VP.y + VP.height - TOOLBAR_GAP - TB.height);
});

test("x is clamped into the viewport on both sides", () => {
  assert.equal(placeToolbar({ x: 0, y: 1100, width: 120, height: 100 }, TB, VP).x, 0);
  assert.equal(placeToolbar({ x: 1200, y: 1100, width: 400, height: 100 }, TB, VP).x, 1280 - TB.width);
  const scrolledX = { x: 500, y: 0, width: 800, height: 600 };
  assert.equal(placeToolbar({ x: 0, y: 100, width: 600, height: 100 }, TB, scrolledX).x, 500);
});

test("a toolbar wider than the viewport sticks to its left edge", () => {
  const narrow = { x: 40, y: 0, width: 200, height: 600 };
  assert.equal(placeToolbar({ x: 60, y: 100, width: 150, height: 100 }, TB, narrow).x, 40);
});
