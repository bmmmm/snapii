// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text with the OCR setting on: the words in the selection's images.
// The capture and the OCR pass are a save's (save.ts), without a file: the
// words go back to the content script, which copies them with the DOM text.
import { type StrategyTab, strategyFor } from "../shared/strategy.ts";
import type { RecognizeRequest, RecognizeResponse } from "../shared/types.ts";
import type { CaptureResult } from "./capture.ts";
import type { SaveDeps } from "./save.ts";

export type RecognizeDeps = Pick<SaveDeps, "loadSettings" | "captureRegion" | "tellTab" | "recognize">;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Never throws: what went wrong is the reply, and the content script copies the DOM text without the images'. */
export async function recognize(
  request: RecognizeRequest,
  tab: (StrategyTab & { id?: number | undefined }) | undefined,
  deps: RecognizeDeps,
): Promise<RecognizeResponse> {
  if (tab?.id === undefined || tab.windowId === undefined || strategyFor(tab) === null) {
    return {
      ok: false,
      error: "capture-failed",
      detail: "only the selected tab of a window can be captured",
    };
  }
  // The content script asks with the setting as it was when the session
  // started; switched off since, no pixel of the page is taken.
  const settings = await deps.loadSettings();
  if (!settings.ocr) return { ok: false, error: "disabled" };

  let captured: CaptureResult;
  try {
    captured = await deps.captureRegion(tab.id, tab.windowId, request.region, settings, request.page);
  } catch (e) {
    return { ok: false, error: "capture-failed", detail: errorText(e) };
  }
  // The pixels are taken: the overlay may come back while the images are
  // read. Not awaited, as in a save.
  deps.tellTab(tab.id, { type: "captured", ocr: true }).catch(() => {});

  const { runs, wordWidths, info } = await deps.recognize(request.areas, captured.tiles, request.runs);
  if (info.status === "timeout" || info.status === "failed") return { ok: false, error: info.status };
  // Which words the selection takes is asked of each word's own box.
  return { ok: true, runs: runs.map((run, i) => ({ ...run, width: wordWidths?.[i] ?? run.width })) };
}
