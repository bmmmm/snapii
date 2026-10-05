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

/**
 * A colour in sRGB as numbers: channels 0–255, alpha 0–1. A page's CSS colour
 * is parsed into this before it reaches a vector SVG, so no colour string from
 * the page is ever written into one.
 */
export interface Paint {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Corner radii as [horizontal, vertical]: top-left, top-right, bottom-right, bottom-left. */
export type Radii = [[number, number], [number, number], [number, number], [number, number]];

/** A clip rectangle, rounded where the clipping box has radii. */
export interface SceneClip extends DocRect {
  radii?: Radii;
}

/** One drawing operation of a vector capture; region-relative CSS px. */
export type SceneOp =
  | {
      op: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      radii?: Radii;
      fill?: Paint;
      /** A CSS border: painted inside the rect's edge, like the border box. */
      stroke?: { width: number; paint: Paint };
      /** A one-colour border of unequal widths (top, right, bottom, left): the ring between the box and its padding box. */
      border?: { widths: [number, number, number, number]; paint: Paint };
    }
  | {
      op: "image";
      x: number;
      y: number;
      width: number;
      height: number;
      /** The visible part only, already cropped to the rect. */
      dataURL: string;
    }
  | { op: "group"; clip?: SceneClip; opacity?: number; children: SceneOp[] };

/** Why part of a vector capture is pixels (a patch) instead of shapes. */
export type UnsupportedReason =
  | "transform"
  | "effect"
  | "background-image"
  | "gradient"
  | "border"
  | "box-shadow"
  | "text-effect"
  | "image"
  | "canvas"
  | "media"
  | "frame"
  | "form"
  | "svg"
  | "math"
  | "pseudo"
  | "marker"
  | "icon-font"
  | "vertical"
  | "color"
  | "budget";

/** A part of the region taken as pixels from the screen (region-relative CSS px). */
export interface Patch extends DocRect {
  reason: UnsupportedReason;
}

/** How a run is painted in a vector capture; `clip` where its glyphs would overhang (region-relative). */
export interface TextPaint {
  fill: Paint;
  clip?: DocRect;
  /** CSS letter-spacing in px: it follows every glyph, the last one too, which textLength alone cannot place. */
  letterSpacing?: number;
}

/**
 * The region as drawing operations, built by the content script and rendered
 * by the background. Text stays in CaptureModel.runs: `text` says per run how
 * it is painted, or null where a patch shows it or a later box hides it.
 */
export interface Scene {
  /** The page's canvas colour, under everything. */
  canvas: Paint;
  /** Boxes in paint order. */
  ops: SceneOp[];
  /** Painted over all ops; the background fills them with pixels. */
  patches: Patch[];
  /** Parallel to CaptureModel.runs. */
  text: (TextPaint | null)[];
  /** Elements per reason that were not turned into shapes. */
  unsupported: Partial<Record<UnsupportedReason, number>>;
}

export interface CaptureModel {
  region: DocRect;
  runs: TextRun[];
  links: LinkArea[];
  page: PageMeta;
  /** Sent only when the OCR setting is on. */
  imageAreas?: ImageArea[];
  /** Sent only in vector output. */
  scene?: Scene;
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
  /** "vector": shapes and visible text, pixels only where they cannot be had (beta); "raster": the screenshot. */
  output: "raster" | "vector";
}
