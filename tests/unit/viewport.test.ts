// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitsViewport, planViewportCrop, planViewportCrops } from "../../src/shared/viewport.ts";

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

test("fitsViewport: a region reaching up to a pixel past the whole-pixel viewport size fits, further not", () => {
  // Chromium at a device scale of 1.5: clientHeight 713, a 100vh box ends at 713.33 (measured).
  const visible = { x: 0, y: 1000, width: 1001, height: 713 };
  assert.equal(fitsViewport({ x: 0, y: 1000, width: 1001.3333, height: 713.3333 }, visible), true);
  assert.equal(fitsViewport({ x: 0, y: 1000, width: 1001, height: 714 }, visible), true);
  assert.equal(fitsViewport({ x: 0, y: 1000, width: 1001, height: 714.01 }, visible), false);
  assert.equal(fitsViewport({ x: 0, y: 1000, width: 1002.01, height: 713 }, visible), false);
  // The start is exact: nothing before the viewport fits.
  assert.equal(fitsViewport({ x: -0.5, y: 1000, width: 300, height: 200 }, visible), false);
  assert.equal(fitsViewport({ x: 0, y: 999.5, width: 300, height: 200 }, visible), false);
});

test("planViewportCrop: a region a fraction past the whole-pixel viewport size is cut to the picture", () => {
  // DPR 1.5, viewport 1001×713 reported, picture 1502×1070: the 100vh box's pixels are all there.
  const crop = planViewportCrop(
    { x: 0, y: 0, width: 1001.3333, height: 713.3333 },
    { viewport: { width: 1001, height: 713 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1.5 },
    { width: 1502, height: 1070 },
    1e8,
  );
  assert.deepEqual(crop.source, { x: 0, y: 0, width: 1502, height: 1070 });
  // A picture that ends at the reported size gives what it has.
  const cut = planViewportCrop(
    { x: 0, y: 0, width: 1001.3333, height: 713.3333 },
    { viewport: { width: 1001, height: 713 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1.5 },
    { width: 1501, height: 1069 },
    1e8,
  );
  assert.deepEqual(cut.source, { x: 0, y: 0, width: 1501, height: 1069 });
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

test("planViewportCrop: scrolled sideways, rel still says where the widened pixels lie", () => {
  // Scrolled to (40, 1000): the region starts 10.3 CSS px into the viewport, device px 15.45 → 15.
  const crop = planViewportCrop(
    { x: 50.3, y: 1020.7, width: 100.2, height: 50.1 },
    page(1.5, { x: 40, y: 1000 }),
    { width: 1500, height: 1070 },
    1e9,
  );
  assert.deepEqual(crop.source, { x: 15, y: 31, width: 151, height: 76 });
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(crop.rel.x, 15 / 1.5 - 10.3);
  near(crop.rel.y, 31 / 1.5 - 20.7);
});

test("planViewportCrops: the pixel budget is shared, every crop shrinks by the same factor", () => {
  const regions = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 0, width: 300, height: 100 },
    { x: 600, y: 0, width: 1, height: 1 },
  ];
  // 10 000 + 30 000 + 1 device px against a budget of 9 000: each side × 0.474, rounded down,
  // and a crop of one pixel keeps it.
  const shrunk = planViewportCrops(regions, page(1), { width: 1000, height: 713 }, 9_000);
  assert.deepEqual(
    shrunk.map((c) => c.output),
    [
      { width: 47, height: 47 },
      { width: 142, height: 47 },
      { width: 1, height: 1 },
    ],
  );
  assert.deepEqual(shrunk[1]?.source, { x: 200, y: 0, width: 300, height: 100 });
  assert.deepEqual(shrunk[1]?.rel, { x: 0, y: 0, width: 300, height: 100 });
  // Within the budget nothing shrinks.
  const kept = planViewportCrops(regions, page(1), { width: 1000, height: 713 }, 1e9);
  assert.deepEqual(
    kept.map((c) => c.output),
    [
      { width: 100, height: 100 },
      { width: 300, height: 100 },
      { width: 1, height: 1 },
    ],
  );
});

test("fitsViewport: a region may end exactly a pixel past the reported width", () => {
  const visible = { x: 0, y: 1000, width: 1001, height: 713 };
  assert.equal(fitsViewport({ x: 0, y: 1000, width: 1002, height: 713 }, visible), true);
});

test("planViewportCrop: the picture may be a device pixel short of the viewport, not two", () => {
  // DPR 1.5, 1001 × 713 CSS px: 1501.5 × 1069.5 device px, of which the capture has at least 1500 × 1068.
  const at = { viewport: { width: 1001, height: 713 }, scroll: { x: 0, y: 0 }, devicePixelRatio: 1.5 };
  const region = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(planViewportCrop(region, at, { width: 1500, height: 1068 }, 1e9).source, {
    x: 0,
    y: 0,
    width: 15,
    height: 15,
  });
  for (const picture of [
    { width: 1499, height: 1068 },
    { width: 1500, height: 1067 },
  ]) {
    assert.throws(() => planViewportCrop(region, at, picture, 1e9), /does not match the viewport/);
  }
});

test("planViewportCrop: a region of no width or no height is refused", () => {
  for (const region of [
    { x: 10, y: 10, width: 0, height: 10 },
    { x: 10, y: 10, width: 10, height: 0 },
  ]) {
    assert.throws(
      () => planViewportCrop(region, page(2), { width: 2000, height: 1426 }, 1e9),
      /outside the captured viewport/,
    );
  }
});
