// SPDX-License-Identifier: GPL-3.0-or-later
// OCR of one save in Chromium: a service worker cannot start the Tesseract
// worker (C1), the offscreen document can (C8) and runs the same pass as
// Firefox's event page there.

import { MAX_AREAS, ocrInfo } from "../../shared/ocr.ts";
import type { OffscreenRequest } from "../../shared/offscreen.ts";
import type { ImageArea, OcrOutput, RasterTile, TextRun } from "../../shared/types.ts";

const FAILED = { areas: 0, recognized: 0, truncated: false, words: 0 };

/** Never throws, like recognizeAreas: a failure is a status with no runs. */
export async function recognizeInOffscreen(
  areas: readonly ImageArea[],
  tiles: readonly RasterTile[],
  domRuns: readonly TextRun[],
  ask: (request: OffscreenRequest) => Promise<unknown>,
): Promise<OcrOutput> {
  const t0 = performance.now();
  if (areas.length === 0) return { runs: [], info: ocrInfo("no-areas", { ...FAILED, ms: 0 }) };
  try {
    return (await ask({
      to: "offscreen",
      type: "ocr",
      areas: [...areas],
      tiles: [...tiles],
      runs: [...domRuns],
    })) as OcrOutput;
  } catch (e) {
    console.warn("snapii: OCR failed", e);
    return {
      runs: [],
      info: ocrInfo("failed", {
        ...FAILED,
        areas: Math.min(areas.length, MAX_AREAS),
        truncated: areas.length > MAX_AREAS,
        ms: performance.now() - t0,
      }),
    };
  }
}
