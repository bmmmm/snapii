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
 * A frame shown at another size than it is laid out at: a CSS transform:
 * scale() or zoom on it or on an ancestor (offsetWidth is the layout size,
 * the client rect the painted one). What is inside it is measured in its own
 * unscaled coordinates, which the frame geometry does not scale, so its text
 * would land off the picture and be cut to the scaled box. Nothing of a
 * rotated one fits either; only a half turn keeps the size, and is not seen.
 */
function isScaled(frame: Element): boolean {
  const { width, height } = frame.getBoundingClientRect();
  const { offsetWidth, offsetHeight } = frame as HTMLElement;
  // offsetWidth is rounded: a fractional width is not a scale.
  return Math.abs(width - offsetWidth) > 1 || Math.abs(height - offsetHeight) > 1;
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
  /** Called for frames whose document is not read: not readable (cross-origin, sandboxed) or shown scaled. */
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
      if (inner?.documentElement && !isScaled(el)) {
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
