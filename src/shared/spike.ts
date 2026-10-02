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
