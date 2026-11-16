// SPDX-License-Identifier: GPL-3.0-or-later
// One capture session in the page: overlay → selection → extraction → save
// request or clipboard write → toast. Free of `browser.*` so the layout
// harness can run it in page context with stubbed sendSave/writeClipboard;
// main.ts wires the real messaging and clipboard.
import { cleanPageUrl } from "../shared/cleanurl.ts";
import { intersect, linksRelativeTo, runsRelativeTo, unionAll } from "../shared/geometry.ts";
import { MAX_RECOGNIZE_RUNS } from "../shared/messages.ts";
import { MAX_AREAS, runBox } from "../shared/ocr.ts";
import { runsToPlainText } from "../shared/plaintext.ts";
import { readingExtent, recognizedIn, withRecognized } from "../shared/recognized.ts";
import { fragmentToCleanHtml, type SNode, toSNodes } from "../shared/sanitize.ts";
import type {
  CapturedMessage,
  CaptureModel,
  FragmentStatus,
  PageMeta,
  RecognizeRequest,
  RecognizeResponse,
  SaveError,
  SaveResponse,
  Settings,
  TextRun,
} from "../shared/types.ts";
import { fitsViewport } from "../shared/viewport.ts";
import type { ClipboardData } from "./clipboard.ts";
import { cloneVisibleRange } from "./extract/clone.ts";
import { collectTextRunsDetailed, type RunSource } from "./extract/collect.ts";
import { areasRelativeTo, collectImageAreas } from "./extract/image-areas.ts";
import { collectLinkAreas } from "./extract/images.ts";
import { buildScene } from "./extract/scene.ts";
import { anchorSources, textFragmentURL } from "./fragment.ts";
import { type OverlayHandle, type Selection, startOverlay, type ToolbarAction } from "./overlay/overlay.ts";
import { viewportSize, visibleViewport } from "./overlay/pick.ts";
import { createHtml, styleHost } from "./overlay/styles.ts";
import { showToast } from "./overlay/toolbar.ts";

/** Why Save is unavailable for a selection that is not wholly visible, where only the viewport can be captured. */
export const VIEWPORT_ONLY_NOTICE =
  "Only what is visible can be saved in this browser. Scroll the selection fully into view or select a smaller area";

const ERROR_TOAST: Record<SaveError, string> = {
  "needs-host-permission": "snapii has no permission to capture this page",
  "capture-failed": "Capture failed. Try again or select another area",
  "too-large": "This area is too large to capture. Select a smaller one",
  "outside-viewport": VIEWPORT_ONLY_NOTICE,
  "download-failed": "The SVG was not saved (download failed or was cancelled)",
};

/**
 * Vector output can save beyond the viewport there, except the parts it
 * takes as pixels: those have to be on screen.
 */
export const VECTOR_OUTSIDE_NOTICE =
  "Parts of this selection that are saved as pixels are outside the visible area. Scroll them into view or select a smaller area";

/** Shown when extraction or messaging throws before the background could answer. */
const UNEXPECTED_TOAST = "Capture failed unexpectedly. Try again";

/** Between `captured` and the reply, while Tesseract reads the images. */
const RECOGNIZING_TOAST = "Saving… (recognizing text)";
/** Long enough for the OCR budget (20 s) and the download; the reply's toast replaces it. */
const RECOGNIZING_TOAST_MS = 30_000;

/**
 * A failure after `captured`: the overlay is already gone, so the toast says
 * the selection was taken and that a retry starts over.
 */
const LATE_ERROR_TOAST = "The selection was captured, but no SVG came of it. Start snapii again to retry";

const COPY_FAILED_TOAST = "Copy failed. Try again";
const NO_TEXT_TOAST = "No text in the selection";
const COPIED_TEXT_TOAST = "Copied text";
/** Copy text, between `captured` and the reply, while Tesseract reads the selection's images. */
const COPY_RECOGNIZING_TOAST = "Copying… (recognizing text)";
/** The images could not be read (capture or OCR failed, or ran out of time): the DOM text is copied all the same. */
const COPIED_WITHOUT_IMAGES_TOAST = "Copied text. Text in images was not recognized";
/** The same, with no DOM text in the selection: nothing was copied. */
const IMAGES_NOT_READ_TOAST = "Nothing copied. Text in images was not recognized";
const COPIED_PAGE_LINK_TOAST = "Copied page link";
const COPIED_CLEAN_LINK_TOAST = "Copied page link, tracking removed";

/** Copy link's toast per fragment status: a page link says less than a text link, so the toast says why. */
const LINK_TOAST: Record<FragmentStatus, string> = {
  SUCCESS: "Copied link",
  DISABLED: "Copied page link",
  AMBIGUOUS: "Copied page link (no unique text match)",
  INVALID_SELECTION: "Copied page link (no text selected)",
  TIMEOUT: "Copied page link (page too large to link the exact text)",
  EXECUTION_FAILED: "Copied page link (no text link possible)",
};

export interface SessionDeps {
  settings: Settings;
  /** This browser captures the viewport and nothing beyond it (Chromium): Save needs a wholly visible selection. */
  viewportOnly?: boolean;
  /**
   * Hands the model to the background (runtime.sendMessage in main.ts).
   * `onCaptured` runs when the background's `captured` message arrives, i.e.
   * once the last tile is taken, before OCR and download.
   */
  sendSave(model: CaptureModel, onCaptured: (message: CapturedMessage) => void): Promise<SaveResponse>;
  /**
   * Copy text with OCR on: asks the background for the words in the
   * selection's images. `onCaptured` as in sendSave: the pixels are taken,
   * the reading goes on.
   */
  sendRecognize(
    request: RecognizeRequest,
    onCaptured: (message: CapturedMessage) => void,
  ): Promise<RecognizeResponse>;
  /** Writes both flavours (writeClipboard in main.ts); rejects if nothing was written. */
  writeClipboard(data: ClipboardData): Promise<void>;
  now(): Date;
}

export interface SessionHandle {
  readonly overlay: OverlayHandle;
  /** True until the session ends (captured, saved, a link copied, cancelled or cancel()). */
  isOpen(): boolean;
  /** Ends the session and removes the overlay (a second start: popup or shortcut). */
  cancel(): void;
}

interface Fragment {
  url: string | null;
  status: FragmentStatus;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/** runsToPlainText output as <p> per block and <br> per line, for the clean-HTML serializer. */
function plainParagraphs(plain: string): SNode[] {
  return plain.split("\n\n").map((block) => ({
    kind: "element",
    tag: "p",
    attrs: {},
    children: block.split("\n").flatMap((line, i): SNode[] =>
      i === 0
        ? [{ kind: "text", text: line }]
        : [
            { kind: "element", tag: "br", attrs: {}, children: [] },
            { kind: "text", text: line },
          ],
    ),
  }));
}

/**
 * Saves of this page whose capture is under way: from the start of the
 * extraction to the background's `captured` (or its reply). A toast is page
 * DOM, so one shown then would end up in that save's raster; toasts wait
 * until no capture runs. Since a new session may start once the previous
 * save is captured, the earlier save's "Saved" can arrive during the next
 * one's capture.
 */
let capturing = 0;
let heldToast: { message: string; ms: number | undefined } | null = null;

function toast(message: string, ms?: number): void {
  if (capturing > 0) heldToast = { message, ms };
  else showToast(message, ms);
}

/** Opens a capture window; the returned function closes it (idempotent) and shows a held toast. */
function captureWindow(): () => void {
  capturing++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    capturing--;
    if (capturing > 0 || !heldToast) return;
    const held = heldToast;
    heldToast = null;
    showToast(held.message, held.ms);
  };
}

/**
 * Counts the copy actions of this page, across sessions. A Copy text whose
 * images are still being read when the next copy starts is out of date: it
 * would write the older text over the newer.
 */
let clipboardTurn = 0;

/** What Copy text gets from the selection's images: the words it takes (document px), or that they could not be read. */
interface FromImages {
  runs: TextRun[];
  failed: boolean;
}
const NO_IMAGES: FromImages = { runs: [], failed: false };

/** Snapshot of the page's text selection, so the capture never shows its highlight. */
function takeSelection(): Range[] {
  const sel = getSelection();
  if (!sel) return [];
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));
  sel.removeAllRanges();
  return ranges;
}

function restoreSelection(ranges: Range[]): void {
  const sel = getSelection();
  if (!sel || ranges.length === 0) return;
  sel.removeAllRanges();
  for (const r of ranges) sel.addRange(r);
}

/**
 * An empty, unpainted, topmost element that takes over hit-testing while the
 * overlay is hidden. With the overlay simply gone (display:none) the page
 * element under a still pointer gets :hover and a mouseover right before the
 * capture, so its hover state ends up in the raster (measured on Fx157).
 */
function hoverShield(): HTMLElement {
  const el = createHtml("snapii-shield");
  styleHost(el, { inset: "0" });
  document.documentElement.append(el);
  return el;
}

/** Is boundary point (a, aOffset) before (b, bOffset) in document order? */
function isBefore(a: Node, aOffset: number, b: Node, bOffset: number): boolean {
  const at = document.createRange();
  at.setStart(a, aOffset);
  return at.comparePoint(b, bOffset) > 0;
}

/**
 * The DOM range a selection stands for: the picked element's contents, or
 * for a drag the first run's start to the last run's end. Runs come in
 * flat-tree order (slotted text sits at its slot, not at its DOM place), so
 * first and last are taken in document order. Only text in the top
 * document's own tree counts: a range cannot reach into a frame's document,
 * and comparing or spanning across a shadow boundary throws or collapses.
 */
function selectionRange(selection: Selection, sources: readonly RunSource[]): Range | null {
  const range = document.createRange();
  if (selection.mode === "element" && selection.element) {
    range.selectNodeContents(selection.element);
    return range;
  }
  let first: RunSource | undefined;
  let last: RunSource | undefined;
  for (const s of sources) {
    if (s.node.getRootNode() !== document) continue;
    if (!first || isBefore(s.node, s.start, first.node, first.start)) first = s;
    if (!last || isBefore(last.node, last.end, s.node, s.end)) last = s;
  }
  if (!first || !last) return null;
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}

function pageMeta(
  selection: Selection,
  deps: SessionDeps,
  stats: { skippedFrames: number; skippedVertical: number },
  fragment: Fragment,
): PageMeta {
  return {
    url: location.href,
    title: document.title,
    // documentElement.lang is "" without a lang attribute: unknown, like null.
    lang: document.documentElement.lang || null,
    textFragmentURL: fragment.url,
    textFragmentStatus: fragment.status,
    viewport: viewportSize(),
    scroll: { x: scrollX, y: scrollY },
    devicePixelRatio,
    capturedAt: deps.now().toISOString(),
    mode: selection.mode,
    skippedFrames: stats.skippedFrames,
    skippedVertical: stats.skippedVertical,
  };
}

export function startSession(deps: SessionDeps): SessionHandle {
  /** The overlay is up and the session answers the toolbar. */
  let open = true;
  /** The user ended the session (a second start, Escape, Cancel). */
  let cancelled = false;
  /** The background has captured this session's save (`captured` arrived). */
  let captured = false;
  /** The hover shield of a capture in flight. */
  let shield: HTMLElement | null = null;
  /** Copy texts of this session that are under way: from the images' reading to the settled clipboard write. */
  let reading = 0;

  /**
   * Every way out of the session, including a cancel while the background
   * has not answered: a shield left behind would keep the page from getting
   * any click.
   */
  const close = (): void => {
    open = false;
    shield?.remove();
    shield = null;
    overlay.destroy();
  };

  const cancel = (): void => {
    cancelled = true;
    // "Copying…" would go on announcing a copy that no longer happens.
    if (reading > 0) for (const t of document.querySelectorAll("snapii-toast")) t.remove();
    close();
  };

  /**
   * A toast for this session's outcome, unless it was cancelled meanwhile: a
   * save or copy already handed off still completes, but the user is done
   * with the session and expects no word from it.
   */
  const notify = (message: string, ms?: number): void => {
    if (!cancelled) toast(message, ms);
  };

  /** The selection's text runs plus the characters each came from; `wholeWords` as the collector has it. */
  function collect(selection: Selection, wholeWords = false): ReturnType<typeof collectTextRunsDetailed> {
    // A toast still on screen (e.g. from a copy button) is page DOM: it would
    // end up in the text and, on save, in the raster.
    for (const t of document.querySelectorAll("snapii-toast")) t.remove();
    return collectTextRunsDetailed(document, selection.rect, {
      skip: overlay.host,
      occlusionCheck: deps.settings.occlusionCheck,
      wholeWords,
    });
  }

  function fragmentFor(
    selection: Selection,
    sources: readonly RunSource[],
    pageURL = location.href,
  ): Fragment {
    if (!deps.settings.textFragment) return { url: null, status: "DISABLED" };
    const range = selectionRange(selection, selection.mode === "drag" ? anchorSources(sources) : sources);
    if (!range) return { url: null, status: "INVALID_SELECTION" };
    return textFragmentURL(range, pageURL);
  }

  /**
   * Takes snapii and the reader's text selection off the screen for a
   * capture: the hover shield up, the overlay hidden; two frames later the
   * screen shows it. The returned function gives the page back: no shield,
   * the selection back. Once only: after that the selection is the reader's
   * again, and a late reply must not overwrite it.
   */
  function conceal(): () => void {
    const mine = hoverShield();
    shield = mine;
    let ranges: Range[] = [];
    let given = false;
    const giveBack = (): void => {
      if (given) return;
      given = true;
      mine.remove();
      if (shield === mine) shield = null;
      restoreSelection(ranges);
    };
    try {
      overlay.hide();
      ranges = takeSelection();
    } catch (e) {
      // Nobody else knows of the shield yet, and it would keep every click from the page.
      giveBack();
      throw e;
    }
    return giveBack;
  }

  async function save(selection: Selection): Promise<void> {
    const endCapture = captureWindow();
    let giveBack = (): void => {};
    let released = false;
    /** Gives the page back: no more capture, and what conceal() took. */
    const release = (): void => {
      endCapture();
      released = true;
      giveBack();
    };
    /** The background has the last tile: the page is free while OCR, rendering and download run. */
    const onCaptured = (message: CapturedMessage): void => {
      // After the reply (a stale message): the reply has decided already.
      if (released) return;
      captured = true;
      release();
      close();
      // Not for a cancelled session: notify stays silent.
      if (message.ocr) notify(RECOGNIZING_TOAST, RECOGNIZING_TOAST_MS);
    };

    let reply: SaveResponse;
    try {
      const region = selection.rect;
      const { runs, stats, sources } = await collect(selection);
      const links = collectLinkAreas(document, region, { skip: overlay.host });
      const model: CaptureModel = {
        region,
        runs: runsRelativeTo(runs, region),
        links: linksRelativeTo(links, region),
        page: pageMeta(selection, deps, stats, fragmentFor(selection, sources)),
      };
      // Vector output: how the same runs are painted, and the boxes around them.
      if (deps.settings.output === "vector") {
        model.scene = buildScene(document, region, {
          runs,
          sources,
          skip: overlay.host,
          encoding: deps.settings,
        });
      }
      // Only with OCR on (raster output): the background recognises text in these areas.
      if (deps.settings.ocr && !model.scene) {
        model.imageAreas = areasRelativeTo(
          collectImageAreas(document, region, { skip: overlay.host }),
          region,
        );
      }

      giveBack = conceal();
      // The hide and the cleared selection have to reach the screen before the
      // background captures it: one frame to style/lay out, one to paint.
      await nextFrame();
      await nextFrame();
      // Cancelled (a second start) during extraction or the wait: a new
      // session's overlay may already be on screen.
      if (cancelled) return;
      reply = await deps.sendSave(model, onCaptured);
    } finally {
      release();
    }

    if (reply.ok) {
      notify(`Saved ${reply.filename}`);
      close();
      return;
    }
    if (captured) {
      // No overlay to restore: the user has moved on, the page is theirs.
      notify(reply.error === "download-failed" ? ERROR_TOAST[reply.error] : LATE_ERROR_TOAST);
      return;
    }
    if (open) overlay.show();
    const vectorOutside = reply.error === "outside-viewport" && deps.settings.output === "vector";
    notify(vectorOutside ? VECTOR_OUTSIDE_NOTICE : (ERROR_TOAST[reply.error] ?? UNEXPECTED_TOAST));
  }

  /** What the background is asked to read for a Copy text, or null where the selection shows no image. */
  function recognitionOf(selection: Selection, runs: readonly TextRun[]): RecognizeRequest | null {
    const extent = readingExtent(selection.rect, deps.viewportOnly ? visibleViewport() : null);
    if (!extent) return null;
    const areas = collectImageAreas(document, selection.rect, { skip: overlay.host, extent }).slice(
      0,
      MAX_AREAS,
    );
    const box = unionAll(areas);
    if (!box) return null;
    // A single area is its own bounding box, `kind` and all.
    const region = { x: box.x, y: box.y, width: box.width, height: box.height };
    // Only text on an image can lie on one of its words.
    const onImages = runs.filter((r) => areas.some((a) => intersect(runBox(r), a)));
    return {
      region,
      areas: areasRelativeTo(areas, region),
      runs: runsRelativeTo(onImages.slice(0, MAX_RECOGNIZE_RUNS), region),
      page: { viewport: viewportSize(), scroll: { x: scrollX, y: scrollY }, devicePixelRatio },
    };
  }

  /**
   * With the OCR setting on: the words the selection takes from the images
   * it touches. The background captures those, so snapii leaves the screen
   * until it has the pixels; then the overlay is back and `onCaptured` runs,
   * while the reading takes its seconds. null: this copy is over (the
   * session was cancelled, or the clipboard has been written again since).
   */
  async function recognizeImages(
    selection: Selection,
    runs: readonly TextRun[],
    onCaptured: () => void,
  ): Promise<FromImages | null> {
    if (!deps.settings.ocr) return NO_IMAGES;
    const request = recognitionOf(selection, runs);
    if (!request) return NO_IMAGES;
    const turn = clipboardTurn;
    const endCapture = captureWindow();
    let giveBack = (): void => {};
    let back = false;
    /** Once only, like giveBack: a save may have hidden the overlay again by the time the reply comes. */
    const release = (): void => {
      endCapture();
      giveBack();
      if (back) return;
      back = true;
      if (open) overlay.show();
    };
    let reply: RecognizeResponse | undefined;
    try {
      giveBack = conceal();
      // As in save(): the hide has to be on screen before the capture.
      await nextFrame();
      await nextFrame();
      if (cancelled) return null;
      reply = await deps.sendRecognize(request, () => {
        // After the reply (a stale message): the reply has decided already.
        if (back) return;
        release();
        notify(COPY_RECOGNIZING_TOAST, RECOGNIZING_TOAST_MS);
        onCaptured();
      });
    } catch (e) {
      // The DOM text is still worth copying.
      console.error("snapii: recognizing text failed", e);
    } finally {
      release();
    }
    if (cancelled || turn !== clipboardTurn) return null;
    // No reply at all (the background went away) is a failure like any other.
    if (!reply?.ok) return { runs: [], failed: reply?.error !== "disabled" };
    const { x, y } = request.region;
    const inDocument = reply.runs.map((r) => ({ ...r, x: r.x + x, y: r.y + y, top: r.top + y }));
    return { runs: recognizedIn(inDocument, selection.rect), failed: false };
  }

  /**
   * text/plain as the capture shows it, a word the selection's edge runs
   * through taken whole; text/html from the visible part of the selected
   * DOM, the same characters. With the OCR setting on, the words in the
   * selection's images too; `onReading` runs once those are only being read.
   */
  async function copyText(selection: Selection, onReading: () => void): Promise<void> {
    const { runs, sources } = await collect(selection, true);
    // Cancelled while collection waited for the fonts: the user is done, so
    // the clipboard keeps what they had there.
    if (!open) return;
    const ctx = { baseURL: document.baseURI, pageURL: location.href };
    // A range never holds shadow-tree or frame content. Where whole lines
    // live only there (a drag over a web component's paragraphs, a picked
    // shadow host or iframe) the clone would paste without them, so the HTML
    // is the plain text's paragraphs; a word inside a line of page text (a
    // timestamp element) is left out of the HTML instead, which keeps the
    // page's links and emphasis.
    const own = (i: number): boolean => sources[i]?.node.getRootNode() === document;
    const ownLines = new Set(runs.filter((_, i) => own(i)).map((r) => r.line));
    const outside = runs.some((r, i) => !own(i) && !ownLines.has(r.line));
    const range = outside ? null : selectionRange(selection, sources);
    // Before the images are read, not after: the page goes on meanwhile (a
    // clock, a re-render), and `sources` are offsets into its text as it is now.
    const cloned = range ? fragmentToCleanHtml(toSNodes(cloneVisibleRange(range, sources, runs)), ctx) : "";
    let images: FromImages | null;
    reading++;
    try {
      images = await recognizeImages(selection, runs, onReading);
      if (!images) return;
      const text = withRecognized(runs, images.runs);
      if (text.length === 0) {
        notify(images.failed ? IMAGES_NOT_READ_TOAST : NO_TEXT_TOAST);
        return;
      }
      const plain = runsToPlainText(text);
      // The page's HTML has no place for an image's words: they follow it, a
      // paragraph per image, the same characters as in the plain text.
      const read = images.runs.length > 0 ? plainParagraphs(runsToPlainText(images.runs)) : [];
      const html =
        cloned.trim() !== ""
          ? cloned + (read.length > 0 ? fragmentToCleanHtml(read, ctx) : "")
          : fragmentToCleanHtml(plainParagraphs(plain), ctx);
      await deps.writeClipboard({ plain, html });
    } finally {
      reading--;
    }
    notify(images.failed ? COPIED_WITHOUT_IMAGES_TOAST : COPIED_TEXT_TOAST);
  }

  /** The selection's text-fragment URL, else the page URL; as html a link named like the page. */
  async function copyLink(selection: Selection): Promise<void> {
    // Element mode needs no runs: its range is the element's contents.
    const sources = selection.mode === "drag" ? (await collect(selection)).sources : [];
    // As in copyText: no clipboard write for a session cancelled meanwhile.
    if (!open) return;
    const page = cleanPageUrl(location.href, deps.settings.removeTrackers);
    const fragment = fragmentFor(selection, sources, page);
    const href = fragment.url ?? page;
    const title = document.title.trim() || href;
    await deps.writeClipboard({
      plain: href,
      html: `<a href="${escapeAttr(href)}">${escapeText(title)}</a>`,
    });
    notify(LINK_TOAST[fragment.status]);
  }

  /** The page's address, without tracking parameters when the setting says so; it reads nothing of the selection. */
  async function copyPageLink(): Promise<void> {
    const href = cleanPageUrl(location.href, deps.settings.removeTrackers);
    const title = document.title.trim() || href;
    await deps.writeClipboard({
      plain: href,
      html: `<a href="${escapeAttr(href)}">${escapeText(title)}</a>`,
    });
    notify(href === location.href ? COPIED_PAGE_LINK_TOAST : COPIED_CLEAN_LINK_TOAST);
  }

  async function onAction(action: ToolbarAction, selection: Selection): Promise<void> {
    if (action !== "save") {
      clipboardTurn++;
      const failed = (e: unknown): void => {
        console.error("snapii: copy failed", e);
        notify(COPY_FAILED_TOAST);
      };
      // The overlay stays open after copied text: saving the same selection
      // is a likely next step, and Escape still closes it. A copied link is
      // the end of it; a failed copy keeps it for another try.
      try {
        if (action === "copy-text") {
          // Reading images takes seconds, in which the toolbar and Escape
          // work again: the action ends once the copy needs the overlay no
          // more, the copy on its own.
          await new Promise<void>((free) => {
            copyText(selection, free).catch(failed).finally(free);
          });
        } else {
          await (action === "copy-page-link" ? copyPageLink() : copyLink(selection));
          close();
        }
      } catch (e) {
        failed(e);
      }
      return;
    }
    try {
      await save(selection);
    } catch (e) {
      console.error("snapii: save failed", e);
      if (captured) {
        notify(LATE_ERROR_TOAST);
        return;
      }
      // The overlay is restored, not removed: the user can retry or cancel.
      if (open) overlay.show();
      notify(UNEXPECTED_TOAST);
    }
  }

  const overlay = startOverlay({
    onAction,
    onCancel: cancel,
    // Vector output needs a capture only for its patches, which the background
    // checks against the viewport itself.
    ...(deps.viewportOnly && deps.settings.output !== "vector"
      ? {
          saveBlocked: (selection: Selection) =>
            fitsViewport(selection.rect, visibleViewport()) ? null : VIEWPORT_ONLY_NOTICE,
        }
      : {}),
  });

  return {
    overlay,
    isOpen: () => open,
    cancel,
  };
}

/**
 * What a `start` message (the popup's Capture region or the shortcut) does in the page: ends
 * the open session, else opens a new one. Not while a capture is in flight,
 * though: after a cancel the background keeps capturing the page, and a new
 * overlay would end up in the tiles still to come. The click is ignored
 * silently: a toast is page DOM too and would be captured the same way.
 * Once the background has the last tile (`captured`), a new session may
 * start while the previous save still recognises text and downloads.
 */
export function sessionToggle(deps: Omit<SessionDeps, "settings">): (settings: Settings) => void {
  let session: SessionHandle | null = null;
  /** The save, or the Copy text reading images, whose capture is in flight (a token per request). */
  let saving: object | null = null;
  type OnCaptured = (message: CapturedMessage) => void;
  const guarded =
    <A, R>(send: (what: A, onCaptured: OnCaptured) => Promise<R>) =>
    (what: A, onCaptured: OnCaptured): Promise<R> => {
      const token = {};
      saving = token;
      const settle = (): void => {
        if (saving === token) saving = null;
      };
      let sent: Promise<R>;
      try {
        sent = send(what, (message) => {
          settle();
          onCaptured(message);
        });
      } catch (e) {
        // A synchronous throw would otherwise leave the guard set for good and
        // every later start in this tab would be ignored.
        settle();
        throw e;
      }
      sent.then(settle, settle);
      return sent;
    };
  const sendSave = guarded<CaptureModel, SaveResponse>((model, onCaptured) =>
    deps.sendSave(model, onCaptured),
  );
  const sendRecognize = guarded<RecognizeRequest, RecognizeResponse>((request, onCaptured) =>
    deps.sendRecognize(request, onCaptured),
  );
  return (settings) => {
    if (session?.isOpen()) {
      session.cancel();
      session = null;
    } else if (!saving) {
      session = startSession({ ...deps, settings, sendSave, sendRecognize });
    }
  };
}
