// SPDX-License-Identifier: GPL-3.0-or-later
// SVG download in Chromium. A service worker has no object URLs (C1 in
// src/shared/spike.ts), so the file goes to downloads.download as a data:
// URL (C14): nothing to revoke, and no state that a worker restart could
// lose. download() resolves as soon as the download exists, before a Save-as
// dialog is answered (C16), so the outcome is asked for until there is one;
// each of those calls also keeps the worker awake while the dialog is open.
// A paused download has no outcome until someone resumes it, so the save
// ends there instead of keeping the page busy.

import { blobToDataURL } from "./data-url.ts";

const POLL_MS = 250;

/** The browser calls the download needs; parameters so unit tests run without `browser`. */
export interface DataUrlDownloadDeps {
  toDataURL(svg: string): Promise<string>;
  download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>;
  /** The download as the browser has it now, undefined once it no longer knows the id. */
  find(
    id: number,
  ): Promise<{ state: string; paused?: boolean | undefined; error?: string | undefined } | undefined>;
  sleep(ms: number): Promise<void>;
}

/** Resolves with the download's id once the file is written; rejects when it is not (a cancelled Save-as dialog included). */
export async function saveSvgAsDataURL(
  svg: string,
  filename: string,
  saveAs: boolean,
  deps: DataUrlDownloadDeps,
): Promise<number> {
  const id = await deps.download({ url: await deps.toDataURL(svg), filename, saveAs });
  for (;;) {
    const item = await deps.find(id);
    if (!item) throw new Error("the browser no longer knows the download");
    if (item.state === "complete") return id;
    if (item.state === "interrupted") {
      // The words Firefox's download() rejects with in the same case.
      if (item.error === "USER_CANCELED") throw new Error("Download canceled by the user");
      throw new Error(`the download was interrupted: ${item.error}`);
    }
    if (item.paused) throw new Error("the download was paused");
    await deps.sleep(POLL_MS);
  }
}

export function saveSvg(svg: string, filename: string, saveAs: boolean): Promise<number> {
  return saveSvgAsDataURL(svg, filename, saveAs, {
    toDataURL: (text) => blobToDataURL(new Blob([text], { type: "image/svg+xml" })),
    download: (options) => browser.downloads.download(options),
    find: async (id) => (await browser.downloads.search({ id }))[0],
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
