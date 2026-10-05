// SPDX-License-Identifier: GPL-3.0-or-later
// Region → one raster tile in Chromium. captureVisibleTab takes the viewport
// only there, at the screen's density, twice a second at most (C2, C3, C5 in
// src/shared/spike.ts): one PNG capture, cropped to the region and encoded in
// the format from the settings. A region that is not wholly visible is refused.

import { SPIKE_CHROMIUM } from "../../shared/spike.ts";
import type { DocRect, PageMeta, Settings } from "../../shared/types.ts";
import {
  fitsViewport,
  planViewportCrop,
  planViewportCrops,
  type ViewportCrop,
  visibleRect,
} from "../../shared/viewport.ts";
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
  /** Decodes the picture once, cuts out what `plan` says for its size and encodes each part as the settings ask. */
  crop(
    dataURL: string,
    plan: (picture: Picture) => ViewportCrop[],
    settings: Settings,
  ): Promise<{ dataURL: string; planned: ViewportCrop }[]>;
}

/** The viewport, taken while `tabId` is the selected tab and the page has not scrolled since the model. */
async function takeViewport(
  tabId: number,
  windowId: number,
  page: Pick<PageMeta, "scroll">,
  deps: ViewportCaptureDeps,
): Promise<string> {
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
  return viewport;
}

const maxPixelsFor = (settings: Settings): number =>
  Math.min(settings.maxTotalPixels, settings.maxTilePixels);

export async function captureViewportRegion(
  tabId: number,
  windowId: number,
  region: DocRect,
  settings: Settings,
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  deps: ViewportCaptureDeps,
): Promise<CaptureResult> {
  if (!fitsViewport(region, visibleRect(page))) throw new OutsideViewportError();
  const viewport = await takeViewport(tabId, windowId, page, deps);
  const [cropped] = await deps.crop(
    viewport,
    (picture) => [planViewportCrop(region, page, picture, maxPixelsFor(settings))],
    settings,
  );
  if (!cropped) throw new Error("no tile was cut from the capture");
  const { dataURL, planned } = cropped;
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

/**
 * The pixels of a vector capture's patches (region-relative), all cut from
 * one viewport capture (the call is rate-limited, C3) with one shrink
 * factor. A patch beyond the viewport cannot be had: refused before any
 * capture; the vector parts of the region may lie anywhere. No patches, no
 * capture: the density is the page's devicePixelRatio (C2).
 */
export async function captureViewportPatches(
  tabId: number,
  windowId: number,
  region: DocRect,
  patches: readonly DocRect[],
  settings: Settings,
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  deps: ViewportCaptureDeps,
): Promise<CaptureResult> {
  // Thinner than a layout unit is float noise between adjoining boxes, not a
  // picture: it would crop to no pixel at all.
  const shown = patches.filter((p) => p.width >= 1 / 64 && p.height >= 1 / 64);
  const docs = shown.map((p) => ({ ...p, x: region.x + p.x, y: region.y + p.y }));
  if (docs.some((d) => !fitsViewport(d, visibleRect(page)))) throw new OutsideViewportError();
  if (docs.length === 0) {
    const zoom = await deps.getZoom(tabId);
    return { tiles: [], scale: page.devicePixelRatio / zoom, zoom };
  }
  const viewport = await takeViewport(tabId, windowId, page, deps);
  const cropped = await deps.crop(
    viewport,
    (picture) => planViewportCrops(docs, page, picture, maxPixelsFor(settings)),
    settings,
  );
  const zoom = await deps.getZoom(tabId);
  const tiles = cropped.map(({ dataURL, planned }, i) => ({
    ...planned.rel,
    x: planned.rel.x + (shown[i]?.x ?? 0),
    y: planned.rel.y + (shown[i]?.y ?? 0),
    dataURL,
    pixelWidth: planned.output.width,
    pixelHeight: planned.output.height,
    format: settings.format,
  }));
  // The widest crop says the shared density best: a one-pixel crop keeps its pixel whatever the shrink.
  const widest = cropped.reduce<ViewportCrop | null>(
    (w, { planned }) => (w && w.source.width >= planned.source.width ? w : planned),
    null,
  );
  const scale = widest ? widest.output.width / widest.rel.width / zoom : page.devicePixelRatio / zoom;
  return { tiles, scale, zoom };
}

/** Canvas and bitmap decoding exist in the service worker (C1). */
async function crop(
  dataURL: string,
  plan: (picture: Picture) => ViewportCrop[],
  settings: Settings,
): Promise<{ dataURL: string; planned: ViewportCrop }[]> {
  const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
  try {
    const out: { dataURL: string; planned: ViewportCrop }[] = [];
    for (const planned of plan({ width: bitmap.width, height: bitmap.height })) {
      const { source, output } = planned;
      const canvas = new OffscreenCanvas(output.width, output.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context for the tile");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        output.width,
        output.height,
      );
      const blob = await canvas.convertToBlob(
        settings.format === "jpeg"
          ? { type: "image/jpeg", quality: settings.jpegQuality }
          : { type: "image/png" },
      );
      out.push({ dataURL: await blobToDataURL(blob), planned });
    }
    return out;
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

export function capturePatches(
  tabId: number,
  windowId: number,
  region: DocRect,
  patches: readonly DocRect[],
  settings: Settings,
  page: PageMeta,
): Promise<CaptureResult> {
  return captureViewportPatches(tabId, windowId, region, patches, settings, page, browserDeps());
}
