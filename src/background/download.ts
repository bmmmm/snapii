// SPDX-License-Identifier: GPL-3.0-or-later
// SVG download from a background blob: URL (decision D4 in docs/development.md).
// Revoking the URL before download() resolves breaks the download (CRASH),
// so it is revoked on the terminal onChanged state, or when download()
// rejects (Save-as cancel sends no onChanged at all).

/** The platform calls the downloader needs; parameters so unit tests run without `browser`. */
export interface DownloadDeps {
  download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface Downloader {
  /** downloads.onChanged listener. */
  onChanged(delta: { id: number; state?: { current?: string | undefined } | undefined }): void;
  /** Starts the download and resolves with its id; rejects as download() does. */
  saveSvg(svg: string, filename: string, saveAs: boolean): Promise<number>;
}

export function createDownloader(deps: DownloadDeps): Downloader {
  /** Download id → blob URL, waiting for complete/interrupted. */
  const pending = new Map<number, string>();
  /** Ids whose terminal state arrived before download() resolved. */
  const finishedEarly = new Set<number>();
  /** download() calls not yet settled; ids are only worth recording while one is. */
  let calls = 0;

  function settle(): void {
    calls--;
    // Any id still recorded belongs to someone else's download: drop it, so
    // unrelated downloads never accumulate here.
    if (calls === 0) finishedEarly.clear();
  }

  return {
    onChanged(delta) {
      const state = delta.state?.current;
      if (state !== "complete" && state !== "interrupted") return;
      const url = pending.get(delta.id);
      if (url === undefined) {
        if (calls > 0) finishedEarly.add(delta.id);
        return;
      }
      pending.delete(delta.id);
      deps.revokeObjectURL(url);
    },

    async saveSvg(svg, filename, saveAs) {
      const url = deps.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      calls++;
      let id: number;
      try {
        id = await deps.download({ url, filename, saveAs });
      } catch (e) {
        deps.revokeObjectURL(url);
        settle();
        throw e;
      }
      if (finishedEarly.delete(id)) deps.revokeObjectURL(url);
      else pending.set(id, url);
      settle();
      return id;
    },
  };
}

const downloader = createDownloader({
  download: (options) => browser.downloads.download(options),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});

/** Registered at the event page's top level by main.ts. */
export const onDownloadChanged = downloader.onChanged;
export const saveSvg = downloader.saveSvg;
