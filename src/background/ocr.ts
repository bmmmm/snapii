// SPDX-License-Identifier: GPL-3.0-or-later
// OCR of the image areas of one save, in the background page: crops each area
// from the captured tiles, recognises it with Tesseract (deu+eng) in a Web
// Worker and returns invisible text runs. Everything the engine needs ships
// in the add-on (dist/ocr/); nothing is ever fetched from the network.
//
// One worker per save, terminated afterwards: a loaded engine holds the
// unpacked language models and the WASM heap, and saves are rare. The whole
// pass has a time budget; over it, the save goes ahead without OCR text and
// the metadata says so.
import { createWorker, type Worker as TessWorker } from "tesseract.js";
import {
  type CropDraw,
  cropPlan,
  cropSize,
  linesFromBlocks,
  nativePxPerCss,
  OCR_LANGS,
  ocrScale,
  runOcrPass,
  type TessBlock,
} from "../shared/ocr.ts";
import type { ImageArea, OcrOutput, RasterTile, TextRun } from "../shared/types.ts";

/** The whole OCR pass, engine start included (one area took 0.4–0.5 s in all, measured). */
export const OCR_BUDGET_MS = 20_000;

// Tesseract's default "single block" segmentation reads scattered text badly
// (banners, signs in photos), and "auto" takes a photo for a picture region
// and finds no text in it at all (measured on a road sign in a Wikipedia
// photo); "sparse text" looks for words anywhere in the crop.
const PSM_SPARSE_TEXT = "11";

class OcrTimeout extends Error {}

/**
 * Paths inside the add-on. workerBlobURL: false because moz-extension pages
 * may not start blob: workers (Firefox bug 1294996); one core file (the
 * SIMD + LSTM-only build) so tesseract.js never probes for another one; no
 * cache, or the traineddata would be copied into IndexedDB on every save.
 */
function workerOptions(onError: (e: unknown) => void) {
  const url = (path: string) => browser.runtime.getURL(path);
  return {
    workerPath: url("ocr/worker.min.js"),
    corePath: url("ocr/tesseract-core-simd-lstm.wasm.js"),
    langPath: url("ocr/lang"),
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    // Without a handler tesseract.js rethrows a failed job inside the
    // worker's onmessage, an uncaught error next to the rejected promise.
    errorHandler: onError,
  };
}

/** Rejects with OcrTimeout once the deadline passes. */
function before<T>(deadline: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OcrTimeout()), Math.max(0, deadline - performance.now()));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

async function decodeTile(tile: RasterTile): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(tile.dataURL)).blob());
}

/**
 * Starts the engine. tesseract.js resolves only once the models are loaded
 * and never settles at all if loading them fails (it swallows that
 * rejection), and it gives no handle to its Web Worker before then. So the
 * Worker is caught as it is constructed (synchronously, inside createWorker)
 * to be terminated in every case, and a failed job ends the wait at once.
 */
function startEngine(): { ready: Promise<TessWorker>; thread: Worker | undefined } {
  let fail: (e: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = (e) => reject(e instanceof Error ? e : new Error(String(e)));
  });
  const Native = globalThis.Worker;
  let thread: Worker | undefined;
  globalThis.Worker = class extends Native {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(url, opts);
      thread = this;
    }
  };
  let created: Promise<TessWorker>;
  try {
    created = createWorker(
      OCR_LANGS,
      1,
      workerOptions((e) => fail(e)),
    );
  } finally {
    globalThis.Worker = Native;
  }
  // Losing the race must not leave an unhandled rejection behind.
  created.catch(() => {});
  failed.catch(() => {});
  return { ready: Promise.race([created, failed]), thread };
}

/**
 * The area at the crop scale, in colour. No grey/invert step: Tesseract
 * reads light-on-dark lines itself (the glue fixture's white-on-blue banner
 * in full), and a global invert by mean brightness gained nothing on photos
 * of signs (measured on two Wikipedia pages).
 */
function drawCrop(
  size: { width: number; height: number },
  plan: readonly CropDraw[],
  bitmaps: ReadonlyMap<number, ImageBitmap>,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for the OCR crop");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const d of plan) {
    const bitmap = bitmaps.get(d.tile);
    if (bitmap) ctx.drawImage(bitmap, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
  }
  return canvas;
}

/**
 * Recognises `areas` (region CSS px) in the captured `tiles`. `domRuns` are
 * the region's DOM text runs: OCR words on them are dropped. Never throws;
 * a failure or timeout is a status with no runs.
 */
export async function recognizeAreas(
  areas: readonly ImageArea[],
  tiles: readonly RasterTile[],
  domRuns: readonly TextRun[],
  budgetMs = OCR_BUDGET_MS,
): Promise<OcrOutput> {
  const deadline = performance.now() + budgetMs;
  const native = nativePxPerCss(tiles);
  // Only the tiles an area touches are decoded, when it is reached: a long
  // capture has many tiles of up to 32 MP, and the image areas usually lie
  // on one or two of them.
  const bitmaps = new Map<number, ImageBitmap>();
  const bitmapsFor = async (plan: readonly CropDraw[]): Promise<Map<number, ImageBitmap>> => {
    for (const { tile } of plan) {
      const source = tiles[tile];
      if (bitmaps.has(tile) || !source) continue;
      const decoding = decodeTile(source);
      try {
        bitmaps.set(tile, await before(deadline, decoding));
      } catch (e) {
        // Decoded after the timeout: freed at once instead of waiting for GC.
        decoding.then((bitmap) => bitmap.close()).catch(() => {});
        throw e;
      }
    }
    return bitmaps;
  };
  let engine: ReturnType<typeof startEngine> | undefined;
  let worker: TessWorker | undefined;
  try {
    return await runOcrPass(
      areas,
      domRuns,
      {
        async start() {
          engine = startEngine();
          worker = await before(deadline, engine.ready);
          await before(deadline, worker.setParameters({ tessedit_pageseg_mode: PSM_SPARSE_TEXT as never }));
        },
        async recognize(area) {
          if (!worker) throw new Error("the OCR engine was not started");
          const f = ocrScale(area, native);
          const plan = cropPlan(area, tiles, f);
          const crop = drawCrop(cropSize(area, f), plan, await bitmapsFor(plan));
          const { data } = await before(deadline, worker.recognize(crop, {}, { blocks: true, text: false }));
          return linesFromBlocks(data.blocks as TessBlock[] | null, area, f);
        },
      },
      { isTimeout: (e) => e instanceof OcrTimeout, now: () => performance.now() },
    );
  } finally {
    for (const b of bitmaps.values()) b.close();
    bitmaps.clear();
    engine?.thread?.terminate();
  }
}
