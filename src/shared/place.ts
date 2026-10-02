// SPDX-License-Identifier: GPL-3.0-or-later
// Pure toolbar placement for the selection overlay. All rects in document
// CSS px; `vp` is the visible viewport, so the result is always on screen.
import type { DocRect } from "./types.ts";

/** Space between the selection edge and the toolbar. */
export const TOOLBAR_GAP = 8;

/**
 * Top-left of the toolbar: below the selection if it fits in the viewport,
 * else above it, else inside the selection's (visible) bottom edge. x is
 * right-aligned to the selection like Firefox Screenshots' buttons, then
 * clamped into the viewport.
 */
export function placeToolbar(
  sel: DocRect,
  tb: { width: number; height: number },
  vp: DocRect,
): { x: number; y: number } {
  const vpBottom = vp.y + vp.height;
  const fits = (y: number): boolean => y >= vp.y && y + tb.height <= vpBottom;

  const below = sel.y + sel.height + TOOLBAR_GAP;
  const above = sel.y - TOOLBAR_GAP - tb.height;
  let y: number;
  if (fits(below)) y = below;
  else if (fits(above)) y = above;
  else {
    const inside = Math.min(sel.y + sel.height, vpBottom) - TOOLBAR_GAP - tb.height;
    // Lower bound last: a toolbar taller than the viewport sticks to its top.
    y = Math.max(vp.y, Math.min(inside, vpBottom - tb.height));
  }

  const right = sel.x + sel.width - tb.width;
  const x = Math.max(vp.x, Math.min(right, vp.x + vp.width - tb.width));
  return { x, y };
}
