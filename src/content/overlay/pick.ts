// SPDX-License-Identifier: GPL-3.0-or-later
// DOM side of the hover pick: hit-testing under the overlay, the composed
// ancestor chain, and the geometry helpers the overlay needs. The heuristic
// itself is the pure pickCandidate() in shared/pick.ts.
import { type ChainEntry, pickCandidate } from "../../shared/pick.ts";
import type { DocRect } from "../../shared/types.ts";
import { shadowRootOf } from "../shadow.ts";

/** Parent in the composed tree: steps from a shadow root's top to its host. */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  return parent instanceof ShadowRoot ? parent.host : null;
}

/**
 * Innermost page element under the client point, skipping our own host.
 * The host is skipped by identity (not by being on top): the
 * closed-root descent would otherwise walk into the overlay.
 */
export function hitTest(x: number, y: number, host: Element): Element | null {
  let el = document.elementsFromPoint(x, y).find((e) => e !== host) ?? null;
  while (el) {
    const root = shadowRootOf(el);
    if (!root || el === host) break;
    // A shadow root's elementsFromPoint also lists light-DOM ancestors;
    // only a node inside this root is a step down.
    const inner = root.elementsFromPoint(x, y).find((e) => e.getRootNode() === root);
    if (!inner) break;
    el = inner;
  }
  return el;
}

/** Client size of the layout viewport (scrollbars excluded). */
export function viewportSize(): { width: number; height: number } {
  const de = document.documentElement;
  // In quirks mode documentElement.client* describe the document, not the viewport.
  if (document.compatMode === "BackCompat") return { width: innerWidth, height: innerHeight };
  return { width: de.clientWidth, height: de.clientHeight };
}

/** Visible viewport in document px. */
export function visibleViewport(): DocRect {
  return { x: scrollX, y: scrollY, ...viewportSize() };
}

function entryOf(el: Element): ChainEntry {
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    role: el.getAttribute("role"),
    display: getComputedStyle(el).display,
    width: r.width,
    height: r.height,
  };
}

/** The element the overlay should highlight for a pointer at (x, y), or null. */
export function pickAt(x: number, y: number, host: Element): Element | null {
  const elements: Element[] = [];
  for (let el = hitTest(x, y, host); el; el = composedParent(el)) elements.push(el);
  const i = pickCandidate(elements.map(entryOf), viewportSize());
  return i < 0 ? null : (elements[i] ?? null);
}

/**
 * ArrowUp target: the nearest composed ancestor that has its own box and
 * differs from `el`'s box (a same-size wrapper would make the key look dead),
 * up to and including <html>.
 */
export function parentOf(el: Element): Element | null {
  const a = el.getBoundingClientRect();
  for (let p = composedParent(el); p; p = composedParent(p)) {
    if (getComputedStyle(p).display === "contents") continue;
    const b = p.getBoundingClientRect();
    if (b.x !== a.x || b.y !== a.y || b.width !== a.width || b.height !== a.height) return p;
  }
  return null;
}

/** Document size the selection is clamped to. */
function docSize(): { width: number; height: number } {
  const de = document.documentElement;
  return {
    width: Math.max(de.scrollWidth, de.clientWidth),
    height: Math.max(de.scrollHeight, de.clientHeight),
  };
}

/** Normalises two document points into a rect clamped to the document. */
export function clampedRect(x0: number, y0: number, x1: number, y1: number): DocRect {
  const { width, height } = docSize();
  const cx = (v: number): number => Math.min(Math.max(v, 0), width);
  const cy = (v: number): number => Math.min(Math.max(v, 0), height);
  const left = cx(Math.min(x0, x1));
  const top = cy(Math.min(y0, y1));
  return { x: left, y: top, width: cx(Math.max(x0, x1)) - left, height: cy(Math.max(y0, y1)) - top };
}

/** An element's border box in document px, clamped to the document. */
export function docRectOf(el: Element): DocRect {
  const r = el.getBoundingClientRect();
  return clampedRect(r.left + scrollX, r.top + scrollY, r.right + scrollX, r.bottom + scrollY);
}
