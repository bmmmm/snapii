// SPDX-License-Identifier: GPL-3.0-or-later
// SVG download in Chromium. A service worker has no object URLs (C1), so the
// file goes to downloads.download as a data: URL (C14): nothing to revoke,
// and no state that a worker restart during the Save-as dialog could lose.

import { blobToDataURL } from "./data-url.ts";

/** Resolves with the download's id; rejects as download() does (a cancelled Save-as dialog included). */
export async function saveSvg(svg: string, filename: string, saveAs: boolean): Promise<number> {
  const url = await blobToDataURL(new Blob([svg], { type: "image/svg+xml" }));
  return browser.downloads.download({ url, filename, saveAs });
}
