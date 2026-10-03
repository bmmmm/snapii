// SPDX-License-Identifier: GPL-3.0-or-later
// What Chromium's service worker asks of its offscreen document: the work a
// service worker cannot do itself (C1 in spike.ts).

import type { ImageArea, RasterTile, TextRun } from "./types.ts";

export type OffscreenRequest =
  | { to: "offscreen"; type: "ocr"; areas: ImageArea[]; tiles: RasterTile[]; runs: TextRun[] }
  | { to: "offscreen"; type: "copy"; plain: string; html: string };

/**
 * A runtime message reaches every extension context, the offscreen document
 * included, also when a content script sent it. Content scripts run inside
 * arbitrary pages and their sender carries the tab: those are not answered.
 */
export function isOffscreenRequest(x: unknown, sender: { tab?: unknown }): x is OffscreenRequest {
  if (sender.tab !== undefined) return false;
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.to === "offscreen" && (r.type === "ocr" || r.type === "copy");
}
