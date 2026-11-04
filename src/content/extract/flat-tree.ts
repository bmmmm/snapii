// SPDX-License-Identifier: GPL-3.0-or-later
// Walks the flat tree, the tree the user actually sees: shadow roots instead
// of their hosts' light children, slots followed by what is assigned to them
// (a slot forwarded into another slot is yielded on the way, as flatParent
// names it), same-origin iframes entered in place. Node-type checks use nodeType and
// localName because instanceof fails across iframe realms.

import { assignedSlotOf, shadowRootOf } from "../shadow.ts";

const ELEMENT = 1;
const TEXT = 3;
const FRAGMENT = 11;

// Never rendered as text, and walking them is wasted work on large pages.
const NOT_RENDERED = new Set(["head", "script", "style", "template", "noscript"]);

/**
 * A frame shown at another size than it is laid out at: zoom, or a CSS
 * transform: scale() on it or on an ancestor (offsetWidth is the layout size,
 * the client rect the painted one). What is inside it is measured in its own
 * unscaled coordinates, which the frame geometry does not scale, so its text
 * would land off the picture and be cut to the scaled box.
 */
function isScaled(frame: Element): boolean {
  const { width, height } = frame.getBoundingClientRect();
  const { offsetWidth, offsetHeight } = frame as HTMLElement;
  // offsetWidth is rounded: a fractional width is not a scale.
  return Math.abs(width - offsetWidth) > 1 || Math.abs(height - offsetHeight) > 1;
}

const near = (v: number | undefined, to: number): boolean => v !== undefined && Math.abs(v - to) < 1e-6;
// matrix3d() is column-major: entries 12-14 are the translation, the rest must be the identity's.
const IDENTITY_3D = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, null, null, null, 1];

/** A computed transform that does more than move the box. */
function turns(transform: string): boolean {
  if (transform === "none") return false;
  const m = /^matrix(3d)?\((.*)\)$/.exec(transform);
  if (!m?.[2]) return true;
  const v = m[2].split(",").map(Number);
  if (!m[1]) return !(near(v[0], 1) && near(v[1], 0) && near(v[2], 0) && near(v[3], 1));
  return IDENTITY_3D.some((want, i) => want !== null && !near(v[i], want));
}

/**
 * A frame turned or mirrored by a transform on it or on an ancestor: a half
 * turn or a mirror keeps the size, so isScaled does not see it, yet the text
 * inside is painted turned while its own coordinates are not. Any transform
 * but a move counts, the individual rotate and scale properties too (they are
 * not part of the computed transform). Costs a computed style per ancestor,
 * up to the frame's own root: an outer frame was checked before it was entered.
 */
function isTurned(frame: Element): boolean {
  const view = frame.ownerDocument.defaultView;
  if (!view) return false;
  for (let el: Element | null = frame; el; el = flatParent(el)) {
    const cs = view.getComputedStyle(el);
    if (turns(cs.transform)) return true;
    if (cs.rotate !== "none" && !near(Number.parseFloat(cs.rotate.split(" ").at(-1) ?? ""), 0)) return true;
    if (cs.scale !== "none" && cs.scale.split(" ").some((f) => !near(Number(f), 1))) return true;
  }
  return false;
}

/** The document a node lives in, plus how to get from there to the top. */
export interface FrameContext {
  doc: Document;
  /** The iframe element showing doc; null for the walk's root document. */
  frame: Element | null;
  parent: FrameContext | null;
}

export interface FlatNode {
  node: Element | Text;
  ctx: FrameContext;
}

export interface WalkOptions {
  /** Subtree left out entirely (the snapii overlay host). */
  skip?: Element | null;
  /** Called for frames whose document is not read: not readable (cross-origin, sandboxed), shown scaled, turned or mirrored. */
  onOpaqueFrame?: (frame: Element, ctx: FrameContext) => void;
}

function isShadowRoot(node: Node | null): node is ShadowRoot {
  return node?.nodeType === FRAGMENT && "host" in node;
}

/** Parent in the flat tree: the assigned slot, else the parent element or shadow host. */
export function flatParent(node: Node): Element | null {
  const slot = assignedSlotOf(node);
  if (slot) return slot;
  const p = node.parentNode;
  if (p?.nodeType === ELEMENT) return p as Element;
  return isShadowRoot(p) ? p.host : null;
}

/** Nearest element, starting at el, that satisfies test; crosses shadow boundaries. */
export function closestComposed(el: Element | null, test: (el: Element) => boolean): Element | null {
  for (let e = el; e; e = flatParent(e)) if (test(e)) return e;
  return null;
}

/**
 * Yields every element (before its children) and text node under root in
 * flat-tree document order.
 */
export function* walkFlatTree(root: Document | Element, opts: WalkOptions = {}): Generator<FlatNode> {
  const doc = root.nodeType === ELEMENT ? (root as Element).ownerDocument : (root as Document);
  const start = root.nodeType === ELEMENT ? (root as Element) : doc.documentElement;
  if (!start) return;
  const stack: { list: ArrayLike<Node>; i: number; ctx: FrameContext }[] = [
    { list: [start], i: 0, ctx: { doc, frame: null, parent: null } },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as (typeof stack)[number];
    if (top.i >= top.list.length) {
      stack.pop();
      continue;
    }
    const node = top.list[top.i++] as Node;
    const ctx = top.ctx;
    if (node.nodeType === TEXT) {
      yield { node: node as Text, ctx };
      continue;
    }
    if (node.nodeType !== ELEMENT) continue;
    const el = node as Element;
    if (el === opts.skip || NOT_RENDERED.has(el.localName)) continue;
    yield { node: el, ctx };
    if (el.localName === "iframe" || el.localName === "frame") {
      let inner: Document | null = null;
      try {
        inner = (el as HTMLIFrameElement).contentDocument;
      } catch {
        // Some engines throw instead of returning null for cross-origin frames.
      }
      if (inner?.documentElement && !isScaled(el) && !isTurned(el)) {
        stack.push({ list: [inner.documentElement], i: 0, ctx: { doc: inner, frame: el, parent: ctx } });
      } else {
        opts.onOpaqueFrame?.(el, ctx);
      }
      continue;
    }
    const shadow = shadowRootOf(el);
    if (shadow) {
      stack.push({ list: shadow.childNodes, i: 0, ctx });
    } else if (el.localName === "slot" && isShadowRoot(el.getRootNode())) {
      // Not flattened: a forwarded slot is a node here too, so what it carries
      // finds it as flatParent. An empty slot shows its fallback children.
      const assigned = (el as HTMLSlotElement).assignedNodes();
      stack.push({ list: assigned.length > 0 ? assigned : el.childNodes, i: 0, ctx });
    } else {
      stack.push({ list: el.childNodes, i: 0, ctx });
    }
  }
}
