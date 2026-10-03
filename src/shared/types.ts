// SPDX-License-Identifier: GPL-3.0-or-later
// Data contracts shared by the content script, the background page and the
// renderer. DOM-free so Node can type-check and unit-test everything that
// only consumes these shapes.

/** Rectangle in document CSS pixels (or region-relative, where stated). */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One visual line fragment of one text node with uniform style and link. */
export interface TextRun {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  top: number;
  width: number;
  height: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic" | "oblique";
  color: string;
  lang: string | null;
  dir: "ltr" | "rtl";
  href: string | null;
  line: number;
  block: number;
}

export interface LinkArea {
  x: number;
  y: number;
  width: number;
  height: number;
  alt: string;
  href: string | null;
}

export type FragmentStatus =
  | "SUCCESS"
  | "INVALID_SELECTION"
  | "AMBIGUOUS"
  | "TIMEOUT"
  | "EXECUTION_FAILED"
  | "DISABLED";

export interface PageMeta {
  url: string;
  title: string;
  lang: string | null;
  textFragmentURL: string | null;
  textFragmentStatus: FragmentStatus;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  capturedAt: string;
  mode: "element" | "drag";
  skippedFrames: number;
  skippedVertical: number;
}

/**
 * A painted image in the region (region-relative CSS px, visible part only):
 * the only places OCR looks at.
 */
export interface ImageArea extends DocRect {
  kind: "img" | "canvas" | "svg-image" | "background";
}

export interface CaptureModel {
  region: DocRect;
  runs: TextRun[];
  links: LinkArea[];
  page: PageMeta;
  /** Sent only when the OCR setting is on. */
  imageAreas?: ImageArea[];
}

export interface RasterTile extends DocRect {
  dataURL: string;
  pixelWidth: number;
  pixelHeight: number;
  format: "png" | "jpeg";
}

export type OcrStatus = "ok" | "disabled" | "no-areas" | "timeout" | "failed";

/** What the metadata records about one save's OCR pass. */
export interface OcrInfo {
  engine: string;
  langs: string[];
  /** Image areas the pass set out to recognise (at most MAX_AREAS). */
  areas: number;
  /** Of those, the ones Tesseract finished before the pass ended (timeout, failure). */
  recognized: number;
  /** The region had more image areas than MAX_AREAS; the rest were not looked at. */
  truncated: boolean;
  /** Words that made it into the text layer. */
  words: number;
  ms: number;
  status: OcrStatus;
}

export interface OcrOutput {
  /** Region-relative, like the DOM runs; empty unless status is "ok". */
  runs: TextRun[];
  info: OcrInfo;
}

export interface RenderInput extends CaptureModel {
  tiles: RasterTile[];
  extensionVersion: string;
  zoom: number;
  scale: number;
  /** Absent: no OCR record at all (renders byte-identical to before OCR existed). */
  ocr?: OcrOutput;
}

export type SvgRenderer = (input: RenderInput) => string;

export type ToContent =
  | { type: "start"; settings: Settings }
  // The background has the last tile: nothing more is read from the page, so
  // the content script gives it back before OCR, rendering and download.
  // `ocr`: text recognition runs now (the slow part, worth a toast).
  | { type: "captured"; ocr: boolean };
export type CapturedMessage = Extract<ToContent, { type: "captured" }>;
export type ToBackground =
  | { type: "save"; model: CaptureModel }
  // Clipboard fallback: content-script navigator.clipboard is undefined on
  // non-secure http pages, the background page can always write (S12).
  | { type: "copy"; plain: string; html: string };
/** From the toolbar popup: start a capture session in that tab (the popup closes, the background stays). */
export type FromPopup = { type: "start-capture"; tabId: number };
/** The reply to `start-capture`; `reason` says why snapii cannot run in the tab. */
export type StartResult = { ok: true } | { ok: false; reason: string };
export type SaveResponse =
  | { ok: true; filename: string }
  | {
      ok: false;
      error:
        | "needs-host-permission"
        | "capture-failed"
        | "too-large"
        | "outside-viewport"
        | "download-failed";
      detail?: string;
    };

export type SaveError = Extract<SaveResponse, { ok: false }>["error"];

export interface Settings {
  format: "png" | "jpeg";
  jpegQuality: number;
  maxTotalPixels: number;
  maxTilePixels: number;
  saveAs: boolean;
  /** Folder inside Firefox's download folder the files go to; "" is the download folder itself (shared/folder.ts). */
  saveFolder: string;
  occlusionCheck: boolean;
  textFragment: boolean;
  /** Recognise text in images (Tesseract, in the background page). */
  ocr: boolean;
}
