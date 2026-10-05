// SPDX-License-Identifier: GPL-3.0-or-later
// Runtime validation of messages the background receives. The content script
// runs inside an arbitrary page, so a message is checked field by field
// against the types before any of it reaches capture, rendering or metadata.

import type { FromPopup, SaveResponse, ToBackground, ToContent, UnsupportedReason } from "./types.ts";

type Rec = Record<string, unknown>;

const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isStrOrNull = (x: unknown): boolean => x === null || isStr(x);
const isOneOf =
  <T extends string>(...values: T[]) =>
  (x: unknown): x is T =>
    values.includes(x as T);

const nums = (o: Rec, ...keys: string[]): boolean => keys.every((k) => isNum(o[k]));

const isFontStyle = isOneOf("normal", "italic", "oblique");
const isDir = isOneOf("ltr", "rtl");
const isMode = isOneOf("element", "drag");
const isFragmentStatus = isOneOf(
  "SUCCESS",
  "INVALID_SELECTION",
  "AMBIGUOUS",
  "TIMEOUT",
  "EXECUTION_FAILED",
  "DISABLED",
);

const isRect = (x: unknown): boolean =>
  isRec(x) && nums(x, "x", "y", "width", "height") && (x.width as number) >= 0 && (x.height as number) >= 0;

const isTextRun = (x: unknown): boolean =>
  isRec(x) &&
  isStr(x.text) &&
  nums(x, "x", "y", "top", "width", "height", "fontSize", "fontWeight", "line", "block") &&
  isStr(x.fontFamily) &&
  isFontStyle(x.fontStyle) &&
  isStr(x.color) &&
  isStrOrNull(x.lang) &&
  isDir(x.dir) &&
  isStrOrNull(x.href);

const isLinkArea = (x: unknown): boolean =>
  isRec(x) && nums(x, "x", "y", "width", "height") && isStr(x.alt) && isStrOrNull(x.href);

const isPageMeta = (x: unknown): boolean =>
  isRec(x) &&
  isStr(x.url) &&
  isStr(x.title) &&
  isStrOrNull(x.lang) &&
  isStrOrNull(x.textFragmentURL) &&
  isFragmentStatus(x.textFragmentStatus) &&
  isRec(x.viewport) &&
  nums(x.viewport, "width", "height") &&
  isRec(x.scroll) &&
  nums(x.scroll, "x", "y") &&
  nums(x, "devicePixelRatio", "skippedFrames", "skippedVertical") &&
  isStr(x.capturedAt) &&
  isMode(x.mode);

const isImageKind = isOneOf("img", "canvas", "svg-image", "background");

const isImageArea = (x: unknown): boolean => isRect(x) && isImageKind((x as Rec).kind);

// Every reason, so a new one cannot be added to the type and forgotten here.
const REASONS: Record<UnsupportedReason, true> = {
  transform: true,
  effect: true,
  "background-image": true,
  gradient: true,
  border: true,
  "box-shadow": true,
  "text-effect": true,
  image: true,
  canvas: true,
  media: true,
  frame: true,
  form: true,
  svg: true,
  math: true,
  pseudo: true,
  marker: true,
  "icon-font": true,
  vertical: true,
  color: true,
  budget: true,
};
const isReason = (x: unknown): x is UnsupportedReason => isStr(x) && Object.hasOwn(REASONS, x);

// Nesting and size a real page needs by far less of; beyond them the scene is
// not ours, and walking it would cost the background more than it is worth.
const MAX_SCENE_DEPTH = 32;
const MAX_SCENE_OPS = 200_000;
// The content script merges patches beyond 2 000 (content/extract/scene.ts).
const MAX_SCENE_PATCHES = 10_000;
// The only images a scene may carry; everything else (http:, javascript:,
// image/svg+xml with its scripts) never reaches an href.
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/;

const inRange = (x: unknown, lo: number, hi: number): boolean => isNum(x) && x >= lo && x <= hi;

const isPaint = (x: unknown): boolean =>
  isRec(x) && inRange(x.r, 0, 255) && inRange(x.g, 0, 255) && inRange(x.b, 0, 255) && inRange(x.a, 0, 1);

const isRadii = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.length === 4 &&
  x.every((c) => Array.isArray(c) && c.length === 2 && c.every((v) => isNum(v) && v >= 0));

const isClip = (x: unknown): boolean =>
  isRect(x) && ((x as Rec).radii === undefined || isRadii((x as Rec).radii));

function isOp(x: unknown, depth: number, budget: { left: number }): boolean {
  if (!isRec(x) || --budget.left < 0) return false;
  if (x.op === "rect") {
    const { stroke, border } = x;
    return (
      isRect(x) &&
      (x.radii === undefined || isRadii(x.radii)) &&
      (x.fill === undefined || isPaint(x.fill)) &&
      (stroke === undefined ||
        (isRec(stroke) && isNum(stroke.width) && stroke.width >= 0 && isPaint(stroke.paint))) &&
      (border === undefined ||
        (isRec(border) &&
          Array.isArray(border.widths) &&
          border.widths.length === 4 &&
          border.widths.every((w) => isNum(w) && w >= 0) &&
          isPaint(border.paint)))
    );
  }
  if (x.op === "image") return isRect(x) && isStr(x.dataURL) && IMAGE_DATA_URL.test(x.dataURL);
  if (x.op === "group") {
    return (
      depth < MAX_SCENE_DEPTH &&
      (x.clip === undefined || isClip(x.clip)) &&
      (x.opacity === undefined || inRange(x.opacity, 0, 1)) &&
      Array.isArray(x.children) &&
      x.children.every((c) => isOp(c, depth + 1, budget))
    );
  }
  return false;
}

const isPatch = (x: unknown): boolean => isRect(x) && isReason((x as Rec).reason);

const isTextPaint = (x: unknown): boolean =>
  x === null ||
  (isRec(x) &&
    isPaint(x.fill) &&
    (x.clip === undefined || isRect(x.clip)) &&
    (x.letterSpacing === undefined || isNum(x.letterSpacing)));

/** `runs`: the model's run count; the scene says how each run is painted, one entry per run. */
const isScene = (x: unknown, runs: number): boolean => {
  if (!isRec(x)) return false;
  const budget = { left: MAX_SCENE_OPS };
  return (
    isPaint(x.canvas) &&
    Array.isArray(x.ops) &&
    x.ops.every((op) => isOp(op, 0, budget)) &&
    Array.isArray(x.patches) &&
    x.patches.length <= MAX_SCENE_PATCHES &&
    x.patches.every(isPatch) &&
    Array.isArray(x.text) &&
    x.text.length === runs &&
    x.text.every(isTextPaint) &&
    isRec(x.unsupported) &&
    Object.entries(x.unsupported).every(([k, n]) => isReason(k) && Number.isInteger(n) && (n as number) >= 0)
  );
};

const isCaptureModel = (x: unknown): boolean =>
  isRec(x) &&
  isRect(x.region) &&
  (x.imageAreas === undefined || (Array.isArray(x.imageAreas) && x.imageAreas.every(isImageArea))) &&
  Array.isArray(x.runs) &&
  x.runs.every(isTextRun) &&
  Array.isArray(x.links) &&
  x.links.every(isLinkArea) &&
  isPageMeta(x.page) &&
  (x.scene === undefined || isScene(x.scene, x.runs.length));

/** True only for a well-formed `ToBackground`; the router drops everything else. */
export function isToBackground(x: unknown): x is ToBackground {
  if (!isRec(x)) return false;
  if (x.type === "copy") return isStr(x.plain) && isStr(x.html);
  return x.type === "save" && isCaptureModel(x.model);
}

/**
 * True only for a well-formed `ToContent`. Only extension pages reach the
 * content script's listener, so this guards against our own mistakes (a
 * `captured` without its flag would show the wrong toast), not the page.
 * Settings are checked by loadSettings before they are sent.
 */
export function isToContent(x: unknown): x is ToContent {
  if (!isRec(x)) return false;
  if (x.type === "start") return isRec(x.settings);
  return x.type === "captured" && typeof x.ocr === "boolean";
}

/** What the background router does with one incoming message. */
export type Route =
  /** Not ours (malformed or foreign): no reply, so another listener may answer. */
  | { kind: "ignore" }
  /** A save that cannot run: answered, so the content script gets a SaveResponse, not undefined. */
  | { kind: "reject"; response: Extract<SaveResponse, { ok: false }> }
  | { kind: "handle"; message: ToBackground }
  | { kind: "start"; message: FromPopup };

/** The part of `runtime.MessageSender` the router checks. */
export interface MessageOrigin {
  frameId?: number | undefined;
  url?: string | undefined;
}

const reject = (detail: string): Route => ({
  kind: "reject",
  response: { ok: false, error: "capture-failed", detail },
});

/**
 * @param popupUrl the toolbar popup's own URL (runtime.getURL("popup.html")):
 *   only that page may start a capture in a tab of its choosing.
 */
export function routeMessage(x: unknown, sender: MessageOrigin, popupUrl?: string): Route {
  if (isRec(x) && x.type === "start-capture") {
    // content.js runs inside arbitrary pages and has no business picking a
    // tab; anything but the popup gets no reply.
    const fromPopup = popupUrl !== undefined && sender.url === popupUrl;
    const tabId = x.tabId;
    if (!fromPopup || typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0)
      return { kind: "ignore" };
    return { kind: "start", message: { type: "start-capture", tabId } };
  }
  // Our own content script asked for a save; answering with nothing would
  // make it read `reply.ok` of undefined.
  if (isRec(x) && x.type === "save") {
    // content.js is injected into the top frame only, and the region is in
    // top-document coordinates; a save from any other frame is not ours.
    if (sender.frameId !== 0) return reject("not sent from the top frame");
    if (!isToBackground(x)) return reject("invalid model");
  }
  if (isToBackground(x)) return { kind: "handle", message: x };
  return { kind: "ignore" };
}
