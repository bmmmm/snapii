// SPDX-License-Identifier: GPL-3.0-or-later
// Pure hover-pick heuristic: given the ancestor chain under the pointer,
// choose the element whose box the overlay highlights. Modelled on the
// behaviour of Firefox Screenshots' getBestRectForElement (overlayHelpers.mjs),
// re-implemented, not copied. DOM-free so Node can unit-test it.

/** One element of the composed ancestor chain, innermost first. */
export interface ChainEntry {
  tag: string;
  role: string | null;
  /** Computed `display`. */
  display: string;
  width: number;
  height: number;
}

/**
 * Size thresholds in CSS px. Same numbers as Firefox 157 Screenshots:
 * MIN_DETECT_WIDTH/HEIGHT 100 × 30 and MAX_DETECT_WIDTH/HEIGHT set to
 * max(client + 100, 1000 / 700) by updateWindowDimensions(). `vw`/`vh` are the
 * viewport's client size (scrollbars excluded).
 */
export const PICK_LIMITS: {
  minW: number;
  minH: number;
  maxW(vw: number): number;
  maxH(vh: number): number;
} = {
  minW: 100,
  minH: 30,
  maxW: (vw) => Math.max(vw + 100, 1000),
  maxH: (vh) => Math.max(vh + 100, 700),
};

// Headings are usually a thin strip of a section; Screenshots never
// auto-selects them, so the walk continues to the enclosing block.
const SKIP_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
// Inline boxes wrap line fragments, display:contents has no box at all.
const SKIP_DISPLAY = new Set(["inline", "contents"]);
const STOP_TAGS = new Set(["HTML", "BODY"]);

const isArticle = (e: ChainEntry): boolean => e.tag.toUpperCase() === "ARTICLE" || e.role === "article";

/**
 * Index into `chain` (0 = element under the pointer) of the element to
 * highlight, or -1 when nothing qualifies. Walks up until HTML/BODY or an
 * ancestor larger than the max; skips entries below the min, inline or
 * display:contents boxes and H1–H6; then prefers the nearest article /
 * [role=article] ancestor if it fits within the max.
 */
export function pickCandidate(chain: ChainEntry[], viewport: { width: number; height: number }): number {
  const maxW = PICK_LIMITS.maxW(viewport.width);
  const maxH = PICK_LIMITS.maxH(viewport.height);
  const tooBig = (e: ChainEntry): boolean => e.width > maxW || e.height > maxH;

  let found = -1;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i] as ChainEntry;
    if (STOP_TAGS.has(e.tag.toUpperCase()) || tooBig(e)) break;
    if (e.width < PICK_LIMITS.minW || e.height < PICK_LIMITS.minH) continue;
    if (SKIP_DISPLAY.has(e.display)) continue;
    if (SKIP_TAGS.has(e.tag.toUpperCase())) continue;
    found = i;
    break;
  }
  if (found < 0) return -1;

  // Only the nearest article counts: an oversized one means the page uses
  // articles as layout regions, not as cards.
  for (let j = found + 1; j < chain.length; j++) {
    const e = chain[j] as ChainEntry;
    if (STOP_TAGS.has(e.tag.toUpperCase())) break;
    if (isArticle(e)) return tooBig(e) ? found : j;
  }
  return found;
}
