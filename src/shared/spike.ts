// SPDX-License-Identifier: GPL-3.0-or-later
// Platform facts measured on Firefox 157 (headless, DPR 2 emulated) on
// 2026-10-01 with a throw-away add-on that captured a calibration page at
// several scales and sizes and compared the pixels. Change a value only with
// a new measurement of that kind; docs/development.md lists the decisions
// (D1–D4) built on these facts. Imported by the pure strategyFor() and
// planTiles().

export const SPIKE = {
  measuredOn: "Firefox 157.0, headless, macOS, 2026-10-01",

  // S1/S2: captureVisibleTab under activeTab only takes `rect` in CSS px
  // relative to the document, inside or outside the viewport, no scrolling.
  visibleTabHonoursRect: true,
  visibleTabOffViewport: "captured",
  // S3: without <all_urls> `browser.tabs.captureTab` is undefined
  // ("browser.tabs.captureTab is not a function").
  tabCaptureNeedsAllUrls: true,
  // S10: activeTab survives event-page suspension (2 min, click and shortcut)
  // and switching tabs (per Firefox source a navigation drops it; not measured).
  activeTabSurvivesSuspend: true,

  // S5/S6: output px = floor(snap(rect) * scale * zoom); snap() widens the
  // rect to whole CSS px; zoom = tabs.getZoom(). Default scale = the
  // background's devicePixelRatio (zoom-independent).
  scaleIncludesZoom: true,
  defaultScaleIsDevicePixelRatio: true,
  outputSizeRounding: "floor",
  // S2: pixels of the rect outside the document are transparent black.
  outsideDocument: "transparent",
  // S8: position:fixed elements are painted where they are on screen at the
  // current scroll position, never repeated in off-viewport rects.
  fixedElements: "at-current-scroll-position",

  // S7 / D3: limits per capture call. Adopted caps (Firefox Screenshots'
  // MAX_CAPTURE_DIMENSION / MAX_CAPTURE_AREA) sit inside the measured envelope.
  maxCaptureSide: 32766,
  maxCaptureArea: 472_907_776,
  // Measured envelope: each side <= 65535 px, and the RGBA surface
  // (16-byte-aligned stride * height) < 2^31 bytes; beyond it the promise
  // rejects with "An unexpected error occurred" (no blank or truncated image).
  measuredMaxSide: 65_535,
  measuredMaxSurfaceBytes: 2 ** 31 - 1,

  // S9 / D4: background blob URL + downloads.download(); the event page stays
  // alive while the Save-as dialog is open; revoke on onChanged
  // complete/interrupted, never before download() resolves.
  downloadPath: "background-blob",
  revokeBlobUrl: "on-download-complete",
  eventPageIdleTimeoutMs: 30_000,

  // S11: fragment-generation-utils runs in the content-script world.
  fragmentUtilsInContentScript: true,

  // S12: navigator.clipboard.write with text/html + text/plain works from the
  // content script on secure origins only (navigator.clipboard is undefined on
  // http); from the extension background it works whatever page is active.
  clipboardFromContentScript: "secure-contexts-only",
  clipboardFromBackground: true,
} as const;

// Platform facts measured on Chromium 151.0.7922.173 and 153.0.8010.12
// (headless, Linux, device scale factor 2) on 2026-10-03 with a throw-away
// extension with host access that captured a calibration page whose pixels
// encode their document position. Same rule: a value changes only with a new
// measurement of that kind.
export const SPIKE_CHROMIUM = {
  measuredOn: "Chromium 151.0.7922.173 and 153.0.8010.12, headless, Linux, 2026-10-03",

  // C1: a service worker has no URL.createObjectURL, navigator.clipboard,
  // Worker or devicePixelRatio; OffscreenCanvas, createImageBitmap, FileReader
  // and fetch() of a data: URL exist.
  serviceWorkerHasObjectURLs: false,
  serviceWorkerHasWorkers: false,
  serviceWorkerHasClipboard: false,

  // C2: captureVisibleTab returns the viewport (a classic scrollbar included)
  // at device scale factor × zoom device px per CSS px, which is the page's
  // devicePixelRatio: 1000 × 713 CSS px gave 2000 × 1426 at zoom 1, and
  // 666 × 475 CSS px gave the same 2000 × 1426 at zoom 1.5.
  captureDensityIsPageDevicePixelRatio: true,
  // C4/C5: `scale` alone changes nothing; `rect` is a crop of the viewport
  // (integers, viewport-relative), and one outside it rejects with "Failed to
  // capture tab: image readback failed". Nothing beyond the viewport.
  visibleTabOffViewport: "rejected",
  // C3: tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND is 2; the third call
  // within a second rejects. One call per 550 ms never did.
  captureCallsPerSecond: 2,
  captureIntervalMs: 550,

  // C8/C10: an offscreen document runs the Tesseract worker under the
  // extension CSP; its navigator.clipboard.write rejects ("Document is not
  // focused."), document.execCommand("copy") with a copy-event handler works.
  offscreenRunsWorkers: true,
  offscreenAsyncClipboard: false,
  // C9: runtime messages carry at most 64 MiB (48 MB passed, 80 MB did not).
  maxMessageBytes: 64 * 1024 * 1024,

  // C11: commands.update, commands.reset and runtime.getBrowserInfo do not exist.
  shortcutChangeableByExtension: false,
  // C12: content scripts have no openOrClosedShadowRoot on elements; the
  // extension API dom.openOrClosedShadowRoot(element) reaches closed roots.
  closedShadowRootsThrough: "dom-api",
  // C13: action.setTitle rejects a null title; a null badge text clears the badge.
  actionTitleNullable: false,
  // C14: downloads.download saved a 40 MB data: URL from the service worker.
  downloadPath: "data-url",
  // C16: download() resolves as soon as the download exists, before a Save-as
  // dialog is answered; a cancel is the state "interrupted" with the error
  // USER_CANCELED (headless, where no dialog can open, every saveAs ends so).
  downloadResolvesBeforeSaveAs: true,
} as const;
