// SPDX-License-Identifier: GPL-3.0-or-later
// One capture session in the page: overlay → selection → extraction → save
// request or clipboard write → toast. Free of `browser.*` so the layout
// harness can run it in page context with stubbed sendSave/writeClipboard;
// main.ts wires the real messaging and clipboard.
import { cleanPageUrl } from "../shared/cleanurl.ts";
import { linksRelativeTo, runsRelativeTo } from "../shared/geometry.ts";
import { runsToPlainText } from "../shared/plaintext.ts";
import { fragmentToCleanHtml, type SNode, toSNodes } from "../shared/sanitize.ts";
import type {
  CapturedMessage,
  CaptureModel,
  FragmentStatus,
  PageMeta,
  SaveError,
  SaveResponse,
  Settings,
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
  /** The hover shield of a save in flight. */
  let shield: HTMLElement | null = null;

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

  /** The selection's text runs plus the characters each came from. */
  function collect(selection: Selection): ReturnType<typeof collectTextRunsDetailed> {
    // A toast still on screen (e.g. from a copy button) is page DOM: it would
    // end up in the text and, on save, in the raster.
    for (const t of document.querySelectorAll("snapii-toast")) t.remove();
    return collectTextRunsDetailed(document, selection.rect, {
      skip: overlay.host,
      occlusionCheck: deps.settings.occlusionCheck,
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

  async function save(selection: Selection): Promise<void> {
    const endCapture = captureWindow();
    let ranges: Range[] = [];
    let released = false;
    /**
     * Gives the page back: no more capture, no shield, the reader's text
     * selection back. Once only: after that the selection is the reader's
     * again, and a late reply must not overwrite it.
     */
    const release = (): void => {
      endCapture();
      if (released) return;
      released = true;
      shield?.remove();
      shield = null;
      restoreSelection(ranges);
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

      shield = hoverShield();
      overlay.hide();
      ranges = takeSelection();
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

  /** text/plain as the capture shows it; text/html from the visible part of the selected DOM. */
  async function copyText(selection: Selection): Promise<void> {
    const { runs, sources } = await collect(selection);
    // Cancelled while collection waited for the fonts: the user is done, so
    // the clipboard keeps what they had there.
    if (!open) return;
    if (runs.length === 0) {
      notify(NO_TEXT_TOAST);
      return;
    }
    const plain = runsToPlainText(runs);
    const ctx = { baseURL: document.baseURI, pageURL: location.href };
    const range = selectionRange(selection, sources);
    const cloned = range
      ? fragmentToCleanHtml(toSNodes(cloneVisibleRange(range, new Set(sources.map((s) => s.node)))), ctx)
      : "";
    // A range never holds shadow-tree or frame content: text that lives only
    // there (a drag over it, or a picked shadow host or iframe) would paste as
    // nothing in a rich editor, so it goes in as the plain text's paragraphs.
    const html = cloned.trim() !== "" ? cloned : fragmentToCleanHtml(plainParagraphs(plain), ctx);
    await deps.writeClipboard({ plain, html });
    notify(COPIED_TEXT_TOAST);
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
      // The overlay stays open after copied text: saving the same selection
      // is a likely next step, and Escape still closes it. A copied link is
      // the end of it; a failed copy keeps it for another try.
      try {
        if (action === "copy-text") await copyText(selection);
        else {
          await (action === "copy-page-link" ? copyPageLink() : copyLink(selection));
          close();
        }
      } catch (e) {
        console.error("snapii: copy failed", e);
        notify(COPY_FAILED_TOAST);
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
  /** The save whose capture is in flight (a token per save). */
  let saving: object | null = null;
  const sendSave: SessionDeps["sendSave"] = (model, onCaptured) => {
    const token = {};
    saving = token;
    const settle = (): void => {
      if (saving === token) saving = null;
    };
    let sent: ReturnType<SessionDeps["sendSave"]>;
    try {
      sent = deps.sendSave(model, (message) => {
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
  return (settings) => {
    if (session?.isOpen()) {
      session.cancel();
      session = null;
    } else if (!saving) {
      session = startSession({ ...deps, settings, sendSave });
    }
  };
}
