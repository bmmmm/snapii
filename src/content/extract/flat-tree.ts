// SPDX-License-Identifier: GPL-3.0-or-later
// Walks the flat tree, the tree the user actually sees: shadow roots instead
// of their hosts' light children, slots replaced by what is assigned to them,
// same-origin iframes entered in place. Node-type checks use nodeType and
// localName because instanceof fails across iframe realms.

import { assignedSlotOf, shadowRootOf } from "../shadow.ts";

const ELEMENT = 1;
const TEXT = 3;
const FRAGMENT = 11;

// Never rendered as text, and walking them is wasted work on large pages.
const NOT_RENDERED = new Set(["head", "script", "style", "template", "noscript"]);

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
  /** Called for frames whose document is not readable (cross-origin, sandboxed). */
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
      if (inner?.documentElement) {
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
      // flatten: nested slots resolve to their content, empty slots to fallback.
      stack.push({ list: (el as HTMLSlotElement).assignedNodes({ flatten: true }), i: 0, ctx });
    } else {
      stack.push({ list: el.childNodes, i: 0, ctx });
    }
  }
}
