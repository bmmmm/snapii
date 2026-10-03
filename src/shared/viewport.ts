// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium's captureVisibleTab takes the viewport and nothing else (C2, C5 in
// spike.ts): whether a region can be saved there, and where it lies in the
// captured picture.

import type { DocRect, PageMeta } from "./types.ts";

/** Binary noise of css × devicePixelRatio products, far below one device pixel. */
const EPS = 1e-6;

/** Is `region` (document CSS px) wholly inside `visible` (the viewport in document CSS px)? */
export function fitsViewport(region: DocRect, visible: DocRect): boolean {
  return (
    region.x >= visible.x - EPS &&
    region.y >= visible.y - EPS &&
    region.x + region.width <= visible.x + visible.width + EPS &&
    region.y + region.height <= visible.y + visible.height + EPS
  );
}

/** The viewport in document CSS px, as the page reported it with the capture model. */
export function visibleRect(page: Pick<PageMeta, "viewport" | "scroll">): DocRect {
  return { x: page.scroll.x, y: page.scroll.y, ...page.viewport };
}

export interface ViewportCrop {
  /** Device px inside the captured picture. */
  source: DocRect;
  /** Pixel size of the tile; smaller than `source` only over the pixel budget. */
  output: { width: number; height: number };
  /** The tile in region-relative CSS px: where the cropped pixels really are. */
  rel: DocRect;
}

/**
 * Where `region` lies in a capture of the viewport, widened to whole device
 * pixels. The picture has devicePixelRatio device px per CSS px (C2) and
 * includes a classic scrollbar, which the page's viewport size does not.
 */
export function planViewportCrop(
  region: DocRect,
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  picture: { width: number; height: number },
  maxPixels: number,
): ViewportCrop {
  const dpr = page.devicePixelRatio;
  if (
    picture.width < Math.floor(page.viewport.width * dpr) - 1 ||
    picture.height < Math.floor(page.viewport.height * dpr) - 1
  ) {
    throw new Error(
      `the ${picture.width}×${picture.height} capture does not match the viewport ` +
        `(${page.viewport.width}×${page.viewport.height} at ${dpr})`,
    );
  }
  const left = Math.floor((region.x - page.scroll.x) * dpr + EPS);
  const top = Math.floor((region.y - page.scroll.y) * dpr + EPS);
  const right = Math.ceil((region.x + region.width - page.scroll.x) * dpr - EPS);
  const bottom = Math.ceil((region.y + region.height - page.scroll.y) * dpr - EPS);
  if (
    left < 0 ||
    top < 0 ||
    right > picture.width ||
    bottom > picture.height ||
    right <= left ||
    bottom <= top
  ) {
    throw new Error("the region is outside the captured viewport");
  }
  const source = { x: left, y: top, width: right - left, height: bottom - top };
  const shrink = Math.min(1, Math.sqrt(maxPixels / (source.width * source.height)));
  return {
    source,
    output: {
      width: Math.max(1, Math.floor(source.width * shrink)),
      height: Math.max(1, Math.floor(source.height * shrink)),
    },
    rel: {
      x: left / dpr - (region.x - page.scroll.x),
      y: top / dpr - (region.y - page.scroll.y),
      width: source.width / dpr,
      height: source.height / dpr,
    },
  };
}
