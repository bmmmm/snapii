// SPDX-License-Identifier: GPL-3.0-or-later
// Bundled into dist-test/harness.js and injected into fixture pages by the
// layout specs; exposes the page-side modules as window.__snapii. The debug
// helpers re-measure runs without the extractor's own geometry code, so the
// specs compare two independent measurements.

import {
  getFragmentDirectives,
  parseFragmentDirectives,
  processFragmentDirectives,
} from "text-fragments-polyfill/text-fragment-utils";
import { writeClipboard } from "../../src/content/clipboard.ts";
import { cloneVisibleRange } from "../../src/content/extract/clone.ts";
import {
  collectTextRuns,
  collectTextRunsDetailed,
  type RunSource,
} from "../../src/content/extract/collect.ts";
import { collectLinkAreas } from "../../src/content/extract/images.ts";
import { textFragmentURL } from "../../src/content/fragment.ts";
import { startOverlay } from "../../src/content/overlay/overlay.ts";
import { showToast } from "../../src/content/overlay/toolbar.ts";
import { sessionToggle, startSession } from "../../src/content/session.ts";
import { runsToPlainText } from "../../src/shared/plaintext.ts";
import { fragmentToCleanHtml, toSNodes } from "../../src/shared/sanitize.ts";
import { rasterTextRenderer } from "../../src/shared/svg/build.ts";
import type { DocRect } from "../../src/shared/types.ts";

/** Client -> top-level document coordinates for doc, via the frameElement chain. */
function docOffset(doc: Document): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  let win = doc.defaultView as Window;
  while (win.frameElement) {
    const f = win.frameElement as HTMLElement;
    const r = f.getBoundingClientRect();
    const cs = (f.ownerDocument.defaultView as Window).getComputedStyle(f);
    dx += r.left + f.clientLeft + Number.parseFloat(cs.paddingLeft);
    dy += r.top + f.clientTop + Number.parseFloat(cs.paddingTop);
    win = f.ownerDocument.defaultView as Window;
  }
  return { dx: dx + win.scrollX, dy: dy + win.scrollY };
}

/** A4: union of the non-empty client rects of a run's source slice, document coordinates. */
function sliceRect(s: RunSource): DocRect | null {
  const range = s.node.ownerDocument.createRange();
  range.setStart(s.node, s.start);
  range.setEnd(s.node, s.end);
  const { dx, dy } = docOffset(s.node.ownerDocument);
  let out: DocRect | null = null;
  for (const r of range.getClientRects()) {
    if (r.width <= 0 || r.height <= 0) continue;
    const x = Math.min(out?.x ?? Infinity, r.left + dx);
    const y = Math.min(out?.y ?? Infinity, r.top + dy);
    const right = Math.max(out ? out.x + out.width : -Infinity, r.right + dx);
    const bottom = Math.max(out ? out.y + out.height : -Infinity, r.bottom + dy);
    out = { x, y, width: right - x, height: bottom - y };
  }
  return out;
}

/**
 * A5: the baseline at the start of a run, from a zero-size inline-block (an
 * empty inline-block sits on the baseline). It goes right after the run's
 * first character, wrapped together with it in a nowrap span: placed exactly
 * at a soft wrap point it would stay on the previous line, and placed before
 * the first character it would cancel ::first-letter. The text node is split
 * for the probe and joined again afterwards.
 */
function probeBaseline(s: RunSource): number {
  const doc = s.node.ownerDocument;
  // SVG <text> renders no HTML probe, but exposes its glyph origins directly
  // (index valid while the run's node is the element's only text).
  const parent = s.node.parentElement;
  if (parent?.namespaceURI === "http://www.w3.org/2000/svg") {
    const text = parent as unknown as SVGTextContentElement;
    const origin = text.getStartPositionOfChar(s.start);
    const m = text.getScreenCTM();
    if (!m) throw new Error("SVG text without a screen CTM");
    return m.b * origin.x + m.d * origin.y + m.f + docOffset(doc).dy;
  }
  const first = s.node.splitText(s.start);
  const rest = first.splitText(Math.min(first.length, (first.data.codePointAt(0) ?? 0) > 0xffff ? 2 : 1));
  const wrap = doc.createElement("snapii-probe");
  wrap.style.cssText = "text-wrap-mode:nowrap";
  const probe = doc.createElement("snapii-probe");
  probe.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0";
  first.before(wrap);
  wrap.append(first, probe);
  const y = probe.getBoundingClientRect().top + docOffset(doc).dy;
  wrap.remove();
  s.node.appendData(first.data + rest.data);
  rest.remove();
  return y;
}

/** Capture rect of an expect block: a selector's border box or an explicit document rect. */
function captureRect(capture: string | DocRect): DocRect {
  if (typeof capture !== "string") return capture;
  const el = document.querySelector(capture);
  if (!el) throw new Error(`capture selector matches nothing: ${capture}`);
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
}

const harness = {
  collectTextRuns,
  collectLinkAreas,
  startOverlay,
  showToast,
  startSession,
  sessionToggle,
  /** The SVG renderer, run in the browser by the round-trip spec. */
  render: rasterTextRenderer,
  debug: { collectTextRunsDetailed, sliceRect, probeBaseline, captureRect },
  textFragmentURL,
  cloneVisibleRange,
  toSNodes,
  fragmentToCleanHtml,
  runsToPlainText,
  writeClipboard,
  // Test-only re-finder for fragment.spec: what a polyfilled browser does on load.
  fragmentUtils: { getFragmentDirectives, parseFragmentDirectives, processFragmentDirectives },
};

window.__snapii = harness;

export type Harness = typeof harness;
