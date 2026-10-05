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
  const { source, rel } = cropSource(region, page, picture);
  return {
    source,
    output: shrunk(source, Math.min(1, Math.sqrt(maxPixels / (source.width * source.height)))),
    rel,
  };
}

/**
 * Several regions cut from one viewport capture (a vector capture's
 * patches), all shrunk by one factor: the pixel budget is the sum of theirs,
 * and each keeps the density of the others.
 */
export function planViewportCrops(
  regions: readonly DocRect[],
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  picture: { width: number; height: number },
  maxPixels: number,
): ViewportCrop[] {
  const parts = regions.map((r) => cropSource(r, page, picture));
  const total = parts.reduce((n, { source }) => n + source.width * source.height, 0);
  const shrink = Math.min(1, Math.sqrt(maxPixels / total));
  return parts.map(({ source, rel }) => ({ source, output: shrunk(source, shrink), rel }));
}

const shrunk = (source: DocRect, shrink: number): { width: number; height: number } => ({
  width: Math.max(1, Math.floor(source.width * shrink)),
  height: Math.max(1, Math.floor(source.height * shrink)),
});

function cropSource(
  region: DocRect,
  page: Pick<PageMeta, "viewport" | "scroll" | "devicePixelRatio">,
  picture: { width: number; height: number },
): Omit<ViewportCrop, "output"> {
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
  if (!fitsViewport(region, visibleRect(page)))
    throw new Error("the region is outside the captured viewport");
  // At a fractional ratio the viewport's CSS size times dpr lies between two
  // device pixels and the capture has the lower one, so a region ending at the
  // viewport's edge reaches a pixel past the picture, and one wholly in that
  // last part of a pixel (a vector patch) gets the picture's last one.
  const left = Math.min(picture.width - 1, Math.max(0, Math.floor((region.x - page.scroll.x) * dpr + EPS)));
  const top = Math.min(picture.height - 1, Math.max(0, Math.floor((region.y - page.scroll.y) * dpr + EPS)));
  const right = Math.min(picture.width, Math.ceil((region.x + region.width - page.scroll.x) * dpr - EPS));
  const bottom = Math.min(picture.height, Math.ceil((region.y + region.height - page.scroll.y) * dpr - EPS));
  if (right <= left || bottom <= top) throw new Error("the region is outside the captured viewport");
  const source = { x: left, y: top, width: right - left, height: bottom - top };
  return {
    source,
    rel: {
      x: left / dpr - (region.x - page.scroll.x),
      y: top / dpr - (region.y - page.scroll.y),
      width: source.width / dpr,
      height: source.height / dpr,
    },
  };
}
