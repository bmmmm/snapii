// SPDX-License-Identifier: GPL-3.0-or-later
// Clickable or described areas that have no text run to carry them: images
// (alt text, plus their link) and link-only anchors (icon links, logo
// links). The renderer turns each into a transparent <rect> in an <a>.
import { intersect, unionAll } from "../../shared/geometry.ts";
import type { DocRect, LinkArea } from "../../shared/types.ts";
import { collapse, isIconText } from "../../shared/whitespace.ts";
import { hrefOf } from "./collect.ts";
import { type FrameContext, flatParent, walkFlatTree } from "./flat-tree.ts";
import { glyphRects } from "./lines.ts";
import { Layout } from "./visibility.ts";

const XLINK = "http://www.w3.org/1999/xlink";

// An inline anchor around a block child can report an empty box of its own.
function boxOf(el: Element): DOMRectReadOnly | DocRect {
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return r;
  const kids = [...el.children]
    .map((c) => c.getBoundingClientRect())
    .filter((k) => k.width > 0 && k.height > 0)
    .map((k) => ({ x: k.left, y: k.top, width: k.width, height: k.height }));
  return unionAll(kids) ?? r;
}

/** Whether any text inside the anchor is actually painted (it then carries the link itself). */
function hasVisibleText(anchor: Element, ctx: FrameContext, layout: Layout): boolean {
  const range = ctx.doc.createRange();
  for (const { node } of walkFlatTree(anchor)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    if (!text.data.trim() || isIconText(text.data)) continue;
    const parent = flatParent(text);
    if (!parent || !layout.isRendered(parent)) continue;
    const clip = layout.clip(parent, ctx);
    range.selectNodeContents(text);
    if (clip && glyphRects(range).some((r) => intersect(layout.toDoc(r, ctx), clip))) return true;
  }
  return false;
}

/** Accessible name of a link-only anchor: aria-label, title, else visually hidden text. */
function nameOf(anchor: Element): string {
  const label = anchor.getAttribute("aria-label")?.trim() || anchor.getAttribute("title")?.trim();
  if (label) return label;
  const text = collapse(anchor.textContent ?? "", "normal").trim();
  return isIconText(text) ? "" : text;
}

export function collectLinkAreas(
  root: Document | Element,
  captureRect: DocRect,
  opts: { skip?: Element | null } = {},
): LinkArea[] {
  const layout = new Layout();
  const pageURL = (
    root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as Element).ownerDocument
  ).URL;
  const out: LinkArea[] = [];
  for (const { node, ctx } of walkFlatTree(root, { skip: opts.skip })) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const isImg = el.localName === "img";
    const isAnchor = el.localName === "a" && (el.hasAttribute("href") || el.hasAttributeNS(XLINK, "href"));
    if ((!isImg && !isAnchor) || !layout.frame(ctx).clip) continue;
    const box = layout.toDoc(boxOf(el), ctx);
    if (!intersect(box, captureRect) || !layout.isRendered(el)) continue;
    const href = hrefOf(el, pageURL);
    let alt: string;
    if (isImg) {
      alt = collapse(el.getAttribute("alt") ?? "", "normal").trim();
      if (!alt && !href) continue;
    } else {
      // Text runs carry the link of anchors with visible text, images that of image links.
      if (!href || el.querySelector("img") || hasVisibleText(el, ctx, layout)) continue;
      alt = nameOf(el);
    }
    const clip = layout.clip(el, ctx);
    const shown = clip && intersect(box, clip);
    const inside = shown && intersect(shown, captureRect);
    if (inside) out.push({ ...inside, alt, href });
  }
  return out;
}
