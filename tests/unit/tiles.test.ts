// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { SPIKE } from "../../src/shared/spike.ts";
import {
  captureScale,
  deviceStep,
  type PlannedTile,
  planTiles,
  type TileLimits,
} from "../../src/shared/tiles.ts";
import type { DocRect } from "../../src/shared/types.ts";

const DPRS = [1, 1.25, 1.5, 2, 3];
const DEFAULT_LIMITS: TileLimits = {
  maxSide: SPIKE.maxCaptureSide,
  maxArea: SPIKE.maxCaptureArea,
  maxTilePixels: 32_000_000,
};

// Widths and heights chosen so the limit-derived band heights are not
// multiples of the whole-pixel step on their own (1366 × 1.25 = 1707.5 px wide).
const REGIONS: DocRect[] = [
  { x: 0, y: 0, width: 1366, height: 40_000 },
  { x: 13, y: 250, width: 999, height: 45_001 },
  { x: 100.25, y: 200.5, width: 1920.5, height: 30_000.7 },
  { x: 0, y: 0, width: 300, height: 200 },
];

const device = (css: number, scale: number) => Math.floor(css * scale + 1e-9);

function assertPartition(region: DocRect, tiles: PlannedTile[]) {
  const x0 = Math.floor(region.x);
  const y0 = Math.floor(region.y);
  const x1 = Math.ceil(region.x + region.width);
  const y1 = Math.ceil(region.y + region.height);
  let area = 0;
  for (const t of tiles) {
    assert.ok(t.doc.x >= x0 && t.doc.y >= y0 && t.doc.x + t.doc.width <= x1 && t.doc.y + t.doc.height <= y1);
    assert.ok(t.doc.width > 0 && t.doc.height > 0);
    assert.equal(t.rel.x, t.doc.x - region.x);
    assert.equal(t.rel.y, t.doc.y - region.y);
    assert.equal(t.rel.width, t.doc.width);
    assert.equal(t.rel.height, t.doc.height);
    area += t.doc.width * t.doc.height;
  }
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = (tiles[i] as PlannedTile).doc;
      const b = (tiles[j] as PlannedTile).doc;
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `tiles ${i} and ${j} overlap`);
    }
  }
  // Inside the bounds and pairwise disjoint: equal area means full coverage.
  assert.equal(area, (x1 - x0) * (y1 - y0));
}

function assertLimits(tiles: PlannedTile[], scale: number, limits: TileLimits) {
  for (const t of tiles) {
    const w = device(t.doc.width, scale);
    const h = device(t.doc.height, scale);
    assert.equal(t.pixelWidth, w);
    assert.equal(t.pixelHeight, h);
    assert.ok(w <= limits.maxSide && h <= limits.maxSide, `side ${w}x${h}`);
    assert.ok(w * h <= limits.maxArea, `area ${w * h}`);
    assert.ok(w * h <= limits.maxTilePixels, `tile pixels ${w * h}`);
  }
}

test("planTiles: full coverage, no overlap, limits held for every DPR", () => {
  for (const dpr of DPRS) {
    for (const region of REGIONS) {
      const tiles = planTiles(region, dpr, DEFAULT_LIMITS);
      assert.ok(tiles.length > 0);
      assertPartition(region, tiles);
      assertLimits(tiles, dpr, DEFAULT_LIMITS);
    }
  }
});

test("planTiles: every cut lands on a whole device pixel for DPR {1,1.25,1.5,2,3}", () => {
  for (const dpr of DPRS) {
    for (const region of REGIONS) {
      const tiles = planTiles(region, dpr, DEFAULT_LIMITS);
      assert.ok(tiles.length > 1 || region.height < 1000, `expected several bands for ${region.height}`);
      const y0 = Math.floor(region.y);
      for (const t of tiles) {
        // Distance of each band start from the region start, in device px.
        const offset = (t.doc.y - y0) * dpr;
        assert.ok(Math.abs(offset - Math.round(offset)) < 1e-9, `DPR ${dpr}: cut at ${offset} device px`);
        assert.ok(Number.isInteger(t.doc.y) && Number.isInteger(t.doc.height), "whole CSS px");
      }
      // All bands but the last one carry a whole number of device rows.
      for (const t of tiles.slice(0, -1)) {
        const rows = t.doc.height * dpr;
        assert.ok(Math.abs(rows - Math.round(rows)) < 1e-9, `DPR ${dpr}: band of ${rows} device rows`);
      }
    }
  }
});

test("planTiles: full-width bands unless the width alone breaks a limit", () => {
  const bands = planTiles({ x: 0, y: 0, width: 2000, height: 50_000 }, 2, DEFAULT_LIMITS);
  assert.ok(bands.every((t) => t.doc.x === 0 && t.doc.width === 2000));
  assert.ok(bands.length > 1);

  // 40,000 CSS px at DPR 1 is wider than one capture call may be: columns too.
  const wide = planTiles({ x: 0, y: 0, width: 40_000, height: 3000 }, 1, DEFAULT_LIMITS);
  assert.ok(new Set(wide.map((t) => t.doc.x)).size > 1);
  assertPartition({ x: 0, y: 0, width: 40_000, height: 3000 }, wide);
  assertLimits(wide, 1, DEFAULT_LIMITS);
});

test("planTiles: a small region is one tile with region-relative geometry", () => {
  const region = { x: 100.25, y: 200.5, width: 333.3, height: 201.7 };
  const tiles = planTiles(region, 1.5, DEFAULT_LIMITS);
  assert.equal(tiles.length, 1);
  const [t] = tiles as [PlannedTile];
  // S5: the browser widens 100.25–433.55 × 200.5–402.2 to 100–434 × 200–403.
  assert.deepEqual(t.doc, { x: 100, y: 200, width: 334, height: 203 });
  assert.deepEqual(t.rel, { x: -0.25, y: -0.5, width: 334, height: 203 });
  assert.equal(t.pixelWidth, 501);
  assert.equal(t.pixelHeight, 304);
});

test("planTiles: empty region gives no tiles, absurd scale throws", () => {
  assert.deepEqual(planTiles({ x: 5, y: 5, width: 0, height: 10 }, 2, DEFAULT_LIMITS), []);
  assert.throws(() => planTiles({ x: 0, y: 0, width: 10, height: 10 }, 0, DEFAULT_LIMITS), RangeError);
  assert.throws(
    () => planTiles({ x: 0, y: 0, width: 10, height: 10 }, 1e6, { ...DEFAULT_LIMITS, maxSide: 1000 }),
    RangeError,
  );
});

test("captureScale: screen density divided by zoom, capped by maxTotalPixels", () => {
  const small = { x: 0, y: 0, width: 500, height: 300 };
  assert.equal(captureScale(small, 2, 1, 100_000_000), 2);
  // S6: at 150 % zoom the browser multiplies by 1.5 itself; DPR 2 × 1.5 = 3 device px per CSS px.
  assert.equal(captureScale(small, 2, 1.5, 100_000_000) * 1.5, 3);
  const big = { x: 0, y: 0, width: 2000, height: 50_000 };
  const s = captureScale(big, 2, 1.25, 100_000_000);
  const total = device(2000, s * 1.25) * device(50_000, s * 1.25);
  assert.ok(total <= 100_000_000 && total > 99_000_000, `total ${total}`);
});

// S6: under page zoom the planner gets captureScale() × zoom, a product with
// binary noise (1.5 × 0.8 = 1.2000000000000002), not a clean DPR.
const ZOOMS = [0.8, 0.9, 1.1, 1.5];

test("planTiles: zoomed scales (DPR × zoom) keep coverage, limits and whole-pixel cuts", () => {
  assert.equal(1.5 * 0.8, 1.2000000000000002); // the noise this test is about
  for (const dpr of DPRS) {
    for (const zoom of ZOOMS) {
      for (const region of REGIONS) {
        const scale = captureScale(region, dpr, zoom, Number.POSITIVE_INFINITY) * zoom;
        const tiles = planTiles(region, scale, DEFAULT_LIMITS);
        const what = `DPR ${dpr} zoom ${zoom} scale ${scale}`;
        assert.ok(tiles.length > 0, what);
        assertPartition(region, tiles);
        assertLimits(tiles, scale, DEFAULT_LIMITS);
        // Every DPR × zoom here is a short decimal, so each cut can sit on a
        // whole device pixel: the planner must find that step despite the noise.
        const y0 = Math.floor(region.y);
        for (const t of tiles) {
          const offset = (t.doc.y - y0) * scale;
          assert.ok(Math.abs(offset - Math.round(offset)) < 1e-6, `${what}: cut at ${offset} device px`);
        }
      }
    }
  }
});

test("planTiles: a capped, irrational scale still covers the region within every limit", () => {
  const limits: TileLimits = { maxSide: 4000, maxArea: SPIKE.maxCaptureArea, maxTilePixels: 3_000_000 };
  for (const zoom of [1, ...ZOOMS]) {
    for (const region of REGIONS) {
      const maxTotalPixels = 20_000_000;
      const s = captureScale(region, 2, zoom, maxTotalPixels);
      const scale = s * zoom;
      const tiles = planTiles(region, scale, limits);
      assert.ok(tiles.length > 0);
      assertPartition(region, tiles);
      assertLimits(tiles, scale, limits);
      const total = tiles.reduce((sum, t) => sum + t.pixelWidth * t.pixelHeight, 0);
      assert.ok(total <= maxTotalPixels, `zoom ${zoom}: ${total} px over the budget`);
    }
  }
  // The large regions really are capped (otherwise this test proves nothing).
  const big = REGIONS[0] as DocRect;
  assert.ok(captureScale(big, 2, 1.1, 20_000_000) * 1.1 < 2 * 1.1);
  assert.equal(deviceStep(captureScale(big, 2, 1.1, 20_000_000) * 1.1), 1);
});
