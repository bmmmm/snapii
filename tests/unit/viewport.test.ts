// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitsViewport, planViewportCrop } from "../../src/shared/viewport.ts";

const page = (dpr: number, scroll = { x: 0, y: 0 }) => ({
  viewport: { width: 1000, height: 713 },
  scroll,
  devicePixelRatio: dpr,
});

test("fitsViewport: a region inside the visible part of the document fits", () => {
  const visible = { x: 0, y: 1000, width: 1000, height: 713 };
  assert.equal(fitsViewport({ x: 10, y: 1100, width: 300, height: 200 }, visible), true);
  // Exactly the viewport.
  assert.equal(fitsViewport(visible, visible), true);
});

test("fitsViewport: a region reaching past any edge does not fit", () => {
  const visible = { x: 0, y: 1000, width: 1000, height: 713 };
  assert.equal(fitsViewport({ x: 10, y: 990, width: 300, height: 200 }, visible), false);
  assert.equal(fitsViewport({ x: 10, y: 1600, width: 300, height: 200 }, visible), false);
  assert.equal(fitsViewport({ x: 800, y: 1100, width: 300, height: 200 }, visible), false);
  assert.equal(fitsViewport({ x: -5, y: 1100, width: 300, height: 200 }, visible), false);
});

test("planViewportCrop: whole CSS px at DPR 2, scrolled", () => {
  const crop = planViewportCrop(
    { x: 10, y: 1100, width: 300, height: 200 },
    page(2, { x: 0, y: 1000 }),
    { width: 2000, height: 1426 },
    1e9,
  );
  assert.deepEqual(crop.source, { x: 20, y: 200, width: 600, height: 400 });
  assert.deepEqual(crop.output, { width: 600, height: 400 });
  assert.deepEqual(crop.rel, { x: 0, y: 0, width: 300, height: 200 });
});

test("planViewportCrop: a region between device pixels is widened to whole ones, and rel says where they are", () => {
  const crop = planViewportCrop(
    { x: 10.3, y: 20.7, width: 100.2, height: 50.1 },
    page(1.5),
    { width: 1500, height: 1070 },
    1e9,
  );
  // 10.3 × 1.5 = 15.45 → 15; 110.5 × 1.5 = 165.75 → 166; 20.7 × 1.5 = 31.05 → 31; 70.8 × 1.5 = 106.2 → 107.
  assert.deepEqual(crop.source, { x: 15, y: 31, width: 151, height: 76 });
  assert.deepEqual(crop.output, { width: 151, height: 76 });
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(crop.rel.x, 15 / 1.5 - 10.3);
  near(crop.rel.y, 31 / 1.5 - 20.7);
  near(crop.rel.width, 151 / 1.5);
  near(crop.rel.height, 76 / 1.5);
});

test("planViewportCrop: binary noise in css × dpr does not add a pixel", () => {
  // 0.1 + 0.2 = 0.30000000000000004; × 10 must still be device px 3, not 4.
  const crop = planViewportCrop(
    { x: 0, y: 0, width: 0.1 + 0.2, height: 1 },
    page(10),
    { width: 10000, height: 7130 },
    1e9,
  );
  assert.equal(crop.source.width, 3);
});

test("planViewportCrop: over the pixel budget the output is scaled down, the source is not", () => {
  const crop = planViewportCrop(
    { x: 0, y: 0, width: 1000, height: 500 },
    page(2),
    { width: 2000, height: 1426 },
    500_000,
  );
  assert.deepEqual(crop.source, { x: 0, y: 0, width: 2000, height: 1000 });
  assert.deepEqual(crop.output, { width: 1000, height: 500 });
  assert.deepEqual(crop.rel, { x: 0, y: 0, width: 1000, height: 500 });
});

test("planViewportCrop: a capture that cannot be this viewport is refused", () => {
  // The picture is half as wide as viewport × DPR: zoom or window changed since the page measured itself.
  assert.throws(
    () =>
      planViewportCrop({ x: 0, y: 0, width: 100, height: 100 }, page(2), { width: 1000, height: 713 }, 1e9),
    /does not match the viewport/,
  );
});

test("planViewportCrop: the scrollbar's width in the picture is no mismatch", () => {
  // captureVisibleTab includes a classic scrollbar (15 CSS px here), the viewport's client size does not.
  const crop = planViewportCrop(
    { x: 900, y: 0, width: 100, height: 100 },
    page(2),
    { width: 2030, height: 1426 },
    1e9,
  );
  assert.deepEqual(crop.source, { x: 1800, y: 0, width: 200, height: 200 });
});

test("planViewportCrop: at a fractional ratio a region ending at the viewport's edge ends at the picture's", () => {
  // 1164 × 713 CSS px at 110 %: 1280.4 × 784.3 device px, captured as 1280 × 784.
  const crop = planViewportCrop(
    { x: 1064, y: 613, width: 100, height: 100 },
    { viewport: { width: 1164, height: 713 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1.1 },
    { width: 1280, height: 784 },
    1e9,
  );
  assert.deepEqual(crop.source, { x: 1170, y: 674, width: 110, height: 110 });
});

test("planViewportCrop: a region wholly in the viewport's last part of a device pixel gets the picture's last pixel", () => {
  // At 110 % the picture ends at 1280 × 784 device px, the viewport at 1280.4 × 784.3:
  // a vector patch from CSS 1163.7 / 712.75 starts past the picture's last pixel.
  const crop = planViewportCrop(
    { x: 1163.7, y: 712.75, width: 0.3, height: 0.25 },
    { viewport: { width: 1164, height: 713 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1.1 },
    { width: 1280, height: 784 },
    1e9,
  );
  assert.deepEqual(crop.source, { x: 1279, y: 783, width: 1, height: 1 });
});

test("planViewportCrop: a region outside the picture is refused", () => {
  assert.throws(
    () =>
      planViewportCrop(
        { x: 0, y: 700, width: 100, height: 100 },
        page(2),
        { width: 2000, height: 1426 },
        1e9,
      ),
    /outside the captured viewport/,
  );
});
