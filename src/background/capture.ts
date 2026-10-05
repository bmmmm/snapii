// SPDX-License-Identifier: GPL-3.0-or-later
// Region → raster tiles with captureVisibleTab (decisions D1–D3 in
// docs/development.md; the measured facts are in src/shared/spike.ts).
// All tiles are taken at the page's current scroll position, without
// scrolling in between, so position:fixed content shows once (S8).

import { SPIKE } from "../shared/spike.ts";
import { captureScale, type PlannedTile, planPatches, planTiles } from "../shared/tiles.ts";
import type { DocRect, RasterTile, Settings } from "../shared/types.ts";

export interface CaptureResult {
  tiles: RasterTile[];
  /** The `scale` passed to captureVisibleTab (zoom not included). */
  scale: number;
  zoom: number;
}

/** No tile plan exists within the per-call limits. */
export class TooLargeError extends Error {}

/** The region reaches beyond the viewport and this browser captures only what is visible. */
export class OutsideViewportError extends Error {
  constructor() {
    super("the region is not wholly inside the viewport");
  }
}

/** The options of one capture call; `quality` is 0–100 and only read for JPEG. */
export function imageDetails(tile: PlannedTile, scale: number, settings: Settings) {
  return {
    rect: tile.doc,
    scale,
    format: settings.format,
    ...(settings.format === "jpeg" ? { quality: Math.round(settings.jpegQuality * 100) } : {}),
  };
}

/**
 * The real pixel size of a capture: the browser floors the snapped rect
 * (S5), so the planned size can be off by one; metadata gets the truth.
 */
async function pixelSize(dataURL: string): Promise<{ width: number; height: number }> {
  const blob = await (await fetch(dataURL)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** The browser calls a tile capture needs; parameters so unit tests run without `browser`. */
export interface CaptureDeps {
  captureVisibleTab(windowId: number, details: ReturnType<typeof imageDetails>): Promise<string>;
  getTab(tabId: number): Promise<{ active: boolean; windowId?: number | undefined }>;
  pixelSize(dataURL: string): Promise<{ width: number; height: number }>;
}

const browserDeps = (): CaptureDeps => ({
  captureVisibleTab: (windowId, details) => browser.tabs.captureVisibleTab(windowId, details),
  getTab: (tabId) => browser.tabs.get(tabId),
  pixelSize,
});

export const TAB_CHANGED = "tab changed during capture";

/**
 * Captures the planned tiles of `tabId`. captureVisibleTab takes whatever tab
 * is selected in `windowId` at each call, and another tab may hold an
 * activeTab grant too (S10): a tab switch mid-capture would put its pixels
 * into the SVG. So the tab is checked before every call and once after the
 * last; each capture lies between two checks that saw the tab selected.
 */
export async function captureTiles(
  target: { tabId: number; windowId: number },
  plan: PlannedTile[],
  scale: number,
  settings: Settings,
  deps: CaptureDeps,
): Promise<RasterTile[]> {
  const ensureSelected = async (): Promise<void> => {
    const tab = await deps.getTab(target.tabId);
    if (!tab.active || tab.windowId !== target.windowId) throw new Error(TAB_CHANGED);
  };
  const tiles: RasterTile[] = [];
  // One call at a time: each holds a full image in memory until encoded.
  for (const tile of plan) {
    await ensureSelected();
    const dataURL = await deps.captureVisibleTab(target.windowId, imageDetails(tile, scale, settings));
    const { width, height } = await deps.pixelSize(dataURL);
    tiles.push({ ...tile.rel, dataURL, pixelWidth: width, pixelHeight: height, format: settings.format });
  }
  await ensureSelected();
  return tiles;
}

const limitsFor = (settings: Settings) => ({
  maxSide: SPIKE.maxCaptureSide,
  maxArea: SPIKE.maxCaptureArea,
  maxTilePixels: settings.maxTilePixels,
});

/** A plan that does not fit the per-call limits is a region too large. */
function planned(plan: () => PlannedTile[]): PlannedTile[] {
  try {
    return plan();
  } catch (e) {
    throw new TooLargeError(e instanceof Error ? e.message : String(e));
  }
}

export async function captureRegion(
  tabId: number,
  windowId: number,
  region: DocRect,
  settings: Settings,
): Promise<CaptureResult> {
  const zoom = await browser.tabs.getZoom(tabId);
  // The background page's devicePixelRatio is the screen's, independent of
  // zoom (S6); the page's own value is quantised.
  const scale = captureScale(region, globalThis.devicePixelRatio, zoom, settings.maxTotalPixels);
  const plan = planned(() => planTiles(region, scale * zoom, limitsFor(settings)));
  if (plan.length === 0) throw new Error("the selected region is empty");

  const tiles = await captureTiles({ tabId, windowId }, plan, scale, settings, browserDeps());
  return { tiles, scale, zoom };
}

/**
 * The pixels of a vector capture's patches (region-relative): one call per
 * planned tile of each patch, at the scale the whole region would get, so
 * patch pixels match a raster capture's. No patches, no capture; zoom and
 * scale are still read, the record needs them.
 */
export async function capturePatches(
  tabId: number,
  windowId: number,
  region: DocRect,
  patches: readonly DocRect[],
  settings: Settings,
): Promise<CaptureResult> {
  const zoom = await browser.tabs.getZoom(tabId);
  const scale = captureScale(region, globalThis.devicePixelRatio, zoom, settings.maxTotalPixels);
  const plan = planned(() => planPatches(region, patches, scale * zoom, limitsFor(settings)));
  const tiles =
    plan.length === 0 ? [] : await captureTiles({ tabId, windowId }, plan, scale, settings, browserDeps());
  return { tiles, scale, zoom };
}
