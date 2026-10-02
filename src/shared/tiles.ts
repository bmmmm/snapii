// SPDX-License-Identifier: GPL-3.0-or-later
// Pure planning of the raster capture: which scale to ask for and how to cut
// the region into capture calls. Facts behind the formulas: the measurements
// in ./spike.ts (S5/S6 → D2 scale, S7 → D3 limits; docs/development.md).

import type { DocRect } from "./types.ts";

/** Per-call limits in device px (output pixels of one capture). */
export interface TileLimits {
  /** Longest side of one capture call. */
  maxSide: number;
  /** Pixel count of one capture call. */
  maxArea: number;
  /** Pixel count of one tile (one `<image>`); the operational budget. */
  maxTilePixels: number;
}

export interface PlannedTile {
  /** Document CSS px, whole numbers: the `rect` for the capture call. */
  doc: DocRect;
  /** The same rect relative to the region origin: the tile's `<image>` geometry. */
  rel: DocRect;
  /** Expected output size: floor(css × scale), the browser's own rounding (S5). */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * The `scale` to pass to `captureVisibleTab` (D2). The browser multiplies it
 * by the page zoom itself, so the wanted density (what the screen shows,
 * devicePixelRatio × zoom) is divided by zoom, after capping it so the whole
 * region stays within `maxTotalPixels`.
 */
export function captureScale(
  region: DocRect,
  devicePixelRatio: number,
  zoom: number,
  maxTotalPixels: number,
): number {
  const { width, height } = snapRect(region);
  const desired = devicePixelRatio * zoom;
  const cap = Math.sqrt(maxTotalPixels / (width * height));
  return Math.min(desired, cap) / zoom;
}

/**
 * Widens a rect to whole CSS px, as the browser does before capturing (S5),
 * so every planned edge is a capture edge and nothing is stretched.
 */
export function snapRect(rect: DocRect): DocRect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.ceil(rect.x + rect.width) - x,
    height: Math.ceil(rect.y + rect.height) - y,
  };
}

// Tolerance for "css × scale is a whole number": scale × zoom products such as
// 2 × 0.8 carry binary rounding noise far below this.
const EPS = 1e-9;
const MAX_STEP = 64;

/**
 * The smallest CSS length whose device length is a whole number, so cuts at
 * its multiples never fall inside a device pixel. 1.25 → 4, 1.5 → 2, 2 → 1.
 * Scales without a small rational form (a capped scale) get 1: no guarantee.
 */
export function deviceStep(scale: number): number {
  for (let k = 1; k <= MAX_STEP; k++) {
    const px = k * scale;
    if (Math.abs(px - Math.round(px)) < EPS * Math.max(1, px)) return k;
  }
  return 1;
}

const devicePx = (css: number, scale: number): number => Math.floor(css * scale + EPS);

/** Largest multiple of `step` (CSS px) whose device length fits `limitPx`. */
function fitLength(limitPx: number, scale: number, step: number): number {
  let len = Math.floor(limitPx / scale / step) * step;
  while (len > 0 && devicePx(len, scale) > limitPx) len -= step;
  return len;
}

/** Cuts [0, total) into pieces of `size` (the last one takes the rest). */
function cuts(total: number, size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = 0; at < total; at += size) out.push([at, Math.min(size, total - at)]);
  return out;
}

/**
 * Cuts `rect` (document CSS px) into capture calls for `scale` device px per
 * CSS px (already including zoom). Horizontal bands of full width, columns
 * only when the width alone breaks a limit. The tiles cover the rect widened
 * to whole CSS px exactly once; interior cuts sit on multiples of
 * deviceStep(scale), so every tile but the last band/column has whole device
 * pixels. `rel` of the first tile can start slightly before 0 when the region
 * starts between CSS pixels: that is where the captured pixels really are.
 * Throws RangeError when not even one CSS px fits the limits.
 */
export function planTiles(rect: DocRect, scale: number, limits: TileLimits): PlannedTile[] {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`invalid scale ${scale}`);
  const snapped = snapRect(rect);
  if (snapped.width <= 0 || snapped.height <= 0) return [];
  const area = Math.min(limits.maxArea, limits.maxTilePixels);

  let step = deviceStep(scale);
  // A whole-pixel step that alone breaks a limit is dropped for plain CSS px.
  if (devicePx(step, scale) > limits.maxSide || devicePx(step, scale) ** 2 > area) step = 1;
  const minBand = Math.min(step, snapped.height);

  // Full width unless the width alone (with the thinnest band) breaks a limit.
  let colWidth = snapped.width;
  if (
    devicePx(colWidth, scale) > limits.maxSide ||
    devicePx(colWidth, scale) * devicePx(minBand, scale) > area
  ) {
    colWidth = Math.min(
      fitLength(limits.maxSide, scale, step),
      fitLength(area / Math.max(1, devicePx(minBand, scale)), scale, step),
    );
  }
  if (colWidth <= 0) throw new RangeError(`scale ${scale} too large for the capture limits`);

  const colPx = devicePx(Math.min(colWidth, snapped.width), scale);
  const bandHeight = Math.min(
    fitLength(limits.maxSide, scale, step),
    fitLength(area / Math.max(1, colPx), scale, step),
  );
  if (bandHeight <= 0) throw new RangeError(`scale ${scale} too large for the capture limits`);

  const tiles: PlannedTile[] = [];
  for (const [dy, h] of cuts(snapped.height, bandHeight)) {
    for (const [dx, w] of cuts(snapped.width, colWidth)) {
      const x = snapped.x + dx;
      const y = snapped.y + dy;
      tiles.push({
        doc: { x, y, width: w, height: h },
        rel: { x: x - rect.x, y: y - rect.y, width: w, height: h },
        pixelWidth: devicePx(w, scale),
        pixelHeight: devicePx(h, scale),
      });
    }
  }
  return tiles;
}
