// SPDX-License-Identifier: GPL-3.0-or-later
// Where the selection shows images, the only places the background's OCR
// looks at: <img> (also inside <picture>), <canvas>, SVG <image>, and boxes
// painted with a CSS background image. Only the visible part counts, clipped
// like text; tiny images (icons, bullets) are left out.
import { intersect } from "../../shared/geometry.ts";
import { MIN_AREA } from "../../shared/ocr.ts";
import type { DocRect, ImageArea } from "../../shared/types.ts";
import { walkFlatTree } from "./flat-tree.ts";
import { Layout } from "./visibility.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function kindOf(el: Element, layout: Layout): ImageArea["kind"] | null {
  if (el.localName === "img") return "img";
  if (el.localName === "canvas") return "canvas";
  if (el.localName === "image" && el.namespaceURI === SVG_NS) return "svg-image";
  // Gradients alone are not images of text; url() and image-set(url()) are.
  return layout.style(el).backgroundImage.includes("url(") ? "background" : null;
}

/** Image areas in document CSS px, in flat-tree order. */
export function collectImageAreas(
  root: Document | Element,
  captureRect: DocRect,
  opts: { skip?: Element | null } = {},
): ImageArea[] {
  const layout = new Layout();
  const out: ImageArea[] = [];
  for (const { node, ctx } of walkFlatTree(root, { skip: opts.skip })) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (!layout.frame(ctx).clip) continue;
    // The box first: most elements of a page lie outside the selection, and
    // reading their style is the expensive part.
    const box = layout.toDoc(el.getBoundingClientRect(), ctx);
    if (!intersect(box, captureRect)) continue;
    const kind = kindOf(el, layout);
    if (!kind || !layout.isRendered(el)) continue;
    const clip = layout.clip(el, ctx);
    const shown = clip && intersect(box, clip);
    const inside = shown && intersect(shown, captureRect);
    if (inside && inside.width >= MIN_AREA.width && inside.height >= MIN_AREA.height) {
      out.push({ ...inside, kind });
    }
  }
  return out;
}

export function areasRelativeTo(areas: readonly ImageArea[], region: DocRect): ImageArea[] {
  return areas.map((a) => ({ ...a, x: a.x - region.x, y: a.y - region.y }));
}
