// SPDX-License-Identifier: GPL-3.0-or-later
// Region → one raster tile in Chromium. captureVisibleTab takes the viewport
// only there, at the screen's density, twice a second at most (C2, C3, C5 in
// src/shared/spike.ts): one PNG capture, cropped to the region and encoded in
// the format from the settings. A region that is not wholly visible is refused.

import { SPIKE_CHROMIUM } from "../../shared/spike.ts";
import type { DocRect, PageMeta, Settings } from "../../shared/types.ts";
import { fitsViewport, planViewportCrop, type ViewportCrop, visibleRect } from "../../shared/viewport.ts";
import { type CaptureResult, OutsideViewportError, TAB_CHANGED } from "../capture.ts";
import { blobToDataURL } from "./data-url.ts";
import { createPacer } from "./pace.ts";

type Picture = { width: number; height: number };

/** The browser calls a viewport capture needs; parameters so unit tests run without `browser`. */
export interface ViewportCaptureDeps {
  /** The visible part of the selected tab of `windowId` as a PNG data URL. */
  captureVisibleTab(windowId: number): Promise<string>;
  getTab(tabId: number): Promise<{ active: boolean; windowId?: number | undefined }>;
  getZoom(tabId: number): Promise<number>;
  /** The page's scroll position now. */
  getScroll(tabId: number): Promise<{ x: number; y: number }>;
  /** Decodes the picture, cuts out what `plan` says for its size and encodes it as the settings ask. */
  crop(
    dataURL: string,
    plan: (picture: Picture) => ViewportCrop,
    settings: Settings,
  ): Promise<{ dataURL: string; planned: ViewportCrop }>;
}

export async function captureViewportRegion(
  tabId: number,
  windowId: number,
  region: DocRect,
  settings: Settings,
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  deps: ViewportCaptureDeps,
): Promise<CaptureResult> {
  if (!fitsViewport(region, visibleRect(page))) throw new OutsideViewportError();
  // As in Firefox's captureTiles: captureVisibleTab takes whatever tab is
  // selected, so the capture lies between two checks that saw ours selected.
  const ensureSelected = async (): Promise<void> => {
    const tab = await deps.getTab(tabId);
    if (!tab.active || tab.windowId !== windowId) throw new Error(TAB_CHANGED);
  };
  await ensureSelected();
  const viewport = await deps.captureVisibleTab(windowId);
  await ensureSelected();
  // The crop rests on where the page said it was scrolled to; a page that
  // moved since (a script, a scroll still in motion) shows other pixels there.
  const scroll = await deps.getScroll(tabId);
  if (Math.abs(scroll.x - page.scroll.x) > 0.5 || Math.abs(scroll.y - page.scroll.y) > 0.5) {
    throw new Error("the page scrolled during the capture");
  }

  const maxPixels = Math.min(settings.maxTotalPixels, settings.maxTilePixels);
  const { dataURL, planned } = await deps.crop(
    viewport,
    (picture) => planViewportCrop(region, page, picture, maxPixels),
    settings,
  );
  const zoom = await deps.getZoom(tabId);
  return {
    tiles: [
      {
        ...planned.rel,
        dataURL,
        pixelWidth: planned.output.width,
        pixelHeight: planned.output.height,
        format: settings.format,
      },
    ],
    scale: planned.output.width / planned.rel.width / zoom,
    zoom,
  };
}

/** Canvas and bitmap decoding exist in the service worker (C1). */
async function crop(
  dataURL: string,
  plan: (picture: Picture) => ViewportCrop,
  settings: Settings,
): Promise<{ dataURL: string; planned: ViewportCrop }> {
  const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
  try {
    const planned = plan({ width: bitmap.width, height: bitmap.height });
    const { source, output } = planned;
    const canvas = new OffscreenCanvas(output.width, output.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for the tile");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, output.width, output.height);
    const blob = await canvas.convertToBlob(
      settings.format === "jpeg"
        ? { type: "image/jpeg", quality: settings.jpegQuality }
        : { type: "image/png" },
    );
    return { dataURL: await blobToDataURL(blob), planned };
  } finally {
    bitmap.close();
  }
}

const paced = createPacer(SPIKE_CHROMIUM.captureIntervalMs, {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const browserDeps = (): ViewportCaptureDeps => ({
  captureVisibleTab: (windowId) => paced(() => browser.tabs.captureVisibleTab(windowId, { format: "png" })),
  getTab: (tabId) => browser.tabs.get(tabId),
  getZoom: (tabId) => browser.tabs.getZoom(tabId),
  getScroll: async (tabId) => {
    const [frame] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => ({ x: scrollX, y: scrollY }),
    });
    return frame?.result as { x: number; y: number };
  },
  crop,
});

export function captureRegion(
  tabId: number,
  windowId: number,
  region: DocRect,
  settings: Settings,
  page: PageMeta,
): Promise<CaptureResult> {
  return captureViewportRegion(tabId, windowId, region, settings, page, browserDeps());
}
