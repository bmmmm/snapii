// SPDX-License-Identifier: GPL-3.0-or-later
// One save, from the content script's model to the downloaded file: capture,
// hand the page back, OCR, render, download. The browser calls are
// parameters (main.ts wires the real ones) so unit tests can check the order.
import { makeFilename } from "../shared/filename.ts";
import { OCR_DISABLED } from "../shared/ocr.ts";
import { type StrategyTab, strategyFor } from "../shared/strategy.ts";
import type {
  CaptureModel,
  DocRect,
  ImageArea,
  OcrOutput,
  PageMeta,
  RasterTile,
  RenderInput,
  SaveError,
  SaveResponse,
  Settings,
  TextRun,
  ToContent,
} from "../shared/types.ts";
import { type CaptureResult, OutsideViewportError, TooLargeError } from "./capture.ts";

export interface SaveDeps {
  loadSettings(): Promise<Settings>;
  /** `page` is the viewport and density the content script saw (the Chromium capture needs them). */
  captureRegion(
    tabId: number,
    windowId: number,
    region: DocRect,
    settings: Settings,
    page: PageMeta,
  ): Promise<CaptureResult>;
  /** Sends `message` to the tab's top frame (where content.js runs). */
  tellTab(tabId: number, message: ToContent): Promise<unknown>;
  recognize(
    areas: readonly ImageArea[],
    tiles: readonly RasterTile[],
    runs: readonly TextRun[],
  ): Promise<OcrOutput>;
  render(input: RenderInput): string;
  saveSvg(svg: string, filename: string, saveAs: boolean): Promise<unknown>;
  extensionVersion: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function captureError(e: unknown): SaveError {
  if (e instanceof TooLargeError) return "too-large";
  if (e instanceof OutsideViewportError) return "outside-viewport";
  return "capture-failed";
}

export async function save(
  model: CaptureModel,
  tab: (StrategyTab & { id?: number | undefined }) | undefined,
  deps: SaveDeps,
): Promise<SaveResponse> {
  if (tab?.id === undefined || tab.windowId === undefined || strategyFor(tab) === null) {
    return {
      ok: false,
      error: "capture-failed",
      detail: "only the selected tab of a window can be captured",
    };
  }
  const settings = await deps.loadSettings();

  let captured: CaptureResult;
  try {
    captured = await deps.captureRegion(tab.id, tab.windowId, model.region, settings, model.page);
  } catch (e) {
    return { ok: false, error: captureError(e), detail: errorText(e) };
  }

  // The last tile is taken (captureRegion returns after it), so the page may
  // change again: the content script lifts its hover shield and closes the
  // overlay now instead of keeping the page blocked through OCR and download.
  // Not awaited: the save goes on whether or not the tab still listens.
  const areas = model.imageAreas ?? [];
  const ocrRuns = settings.ocr && areas.length > 0;
  deps.tellTab(tab.id, { type: "captured", ocr: ocrRuns }).catch(() => {});

  // On the captured pixels, so the page is not read twice.
  const ocr = settings.ocr ? await deps.recognize(areas, captured.tiles, model.runs) : OCR_DISABLED;

  let svg: string;
  try {
    svg = deps.render({
      ...model,
      tiles: captured.tiles,
      extensionVersion: deps.extensionVersion,
      zoom: captured.zoom,
      scale: captured.scale,
      ocr,
    });
  } catch (e) {
    // SaveResponse has no render error; the capture is what produced nothing.
    return { ok: false, error: "capture-failed", detail: `render: ${errorText(e)}` };
  }

  const filename = makeFilename(model.page);
  const path = settings.saveFolder === "" ? filename : `${settings.saveFolder}/${filename}`;
  try {
    await deps.saveSvg(svg, path, settings.saveAs);
  } catch (e) {
    // Includes "Download canceled by the user" from the Save-as dialog (S9).
    return { ok: false, error: "download-failed", detail: errorText(e) };
  }
  return { ok: true, filename };
}
