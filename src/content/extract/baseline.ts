// SPDX-License-Identifier: GPL-3.0-or-later
// Baseline of a line from its rect. A text rect spans the font's ascent plus
// descent, so the baseline sits at a / (a + d) of its height; one canvas per
// document measures a and d once per font.
import type { DocRect } from "../../shared/types.ts";

export interface FontMetrics {
  a: number;
  d: number;
}

// Used when no canvas is available; typical Latin ratio.
const FALLBACK: FontMetrics = { a: 0.8, d: 0.2 };
const XHTML = "http://www.w3.org/1999/xhtml";

// createElement in an SVG or XML document makes a namespace-less element
// without getContext; the XHTML namespace yields a real canvas everywhere.
function canvasContext(doc: Document): CanvasRenderingContext2D | null {
  try {
    return (doc.createElementNS(XHTML, "canvas") as HTMLCanvasElement).getContext("2d");
  } catch {
    return null;
  }
}

const perDocument = new WeakMap<
  Document,
  { ctx: CanvasRenderingContext2D | null; cache: Map<string, FontMetrics> }
>();

/**
 * Ascent and descent of the first available font for key ("style weight
 * sizepx family", canvas font syntax). The canvas belongs to doc so that its
 * @font-face fonts resolve; callers wait for doc.fonts.ready first.
 */
export function fontMetrics(doc: Document, key: string): FontMetrics {
  let entry = perDocument.get(doc);
  if (!entry) {
    entry = { ctx: canvasContext(doc), cache: new Map() };
    perDocument.set(doc, entry);
  }
  let m = entry.cache.get(key);
  if (!m) {
    m = FALLBACK;
    if (entry.ctx) {
      entry.ctx.font = key;
      const t = entry.ctx.measureText("Hxgy");
      const a = t.fontBoundingBoxAscent;
      const d = t.fontBoundingBoxDescent;
      if (Number.isFinite(a) && Number.isFinite(d) && a + d > 0) m = { a, d };
    }
    entry.cache.set(key, m);
  }
  return m;
}

export function baselineOffset(h: number, m: FontMetrics): number {
  return (h * m.a) / (m.a + m.d);
}

/**
 * Baseline y of a line given its bidi fragments. Fragments drawn in a
 * fallback font (Hebrew or Arabic in a Latin font, CJK) have that font's
 * taller or shorter box while the canvas only knows the first available
 * font, so a fragment whose height matches that font anchors the baseline
 * when there is one. Lines set entirely in a fallback font keep the ratio
 * estimate (off by a few px when the fonts' ascent/descent ratios differ).
 */
export function baselineY(parts: readonly DocRect[], union: DocRect, m: FontMetrics): number {
  // Metrics are measured at the run's own size, so a + d is the expected box height.
  const anchor = parts.find((p) => Math.abs(p.height - (m.a + m.d)) <= 0.5) ?? union;
  return anchor.y + baselineOffset(anchor.height, m);
}
