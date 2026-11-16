// SPDX-License-Identifier: GPL-3.0-or-later
// Where the selection shows images, the only places the background's OCR
// looks at: <img> (also inside <picture>), <canvas>, SVG <image>, and boxes
// painted with a CSS background image. Only the visible part counts, clipped
// like text; tiny images (icons, bullets) are left out.
import { EPS, intersect } from "../../shared/geometry.ts";
import { MIN_AREA } from "../../shared/ocr.ts";
import type { DocRect, ImageArea } from "../../shared/types.ts";
import { walkFlatTree } from "./flat-tree.ts";
import { Layout } from "./visibility.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Copy text reads an image only with this much of its height (CSS px) in the selection: half of the smallest text the engine reads. */
const MIN_HEIGHT_INSIDE = 4;

function kindOf(el: Element, layout: Layout): ImageArea["kind"] | null {
  if (el.localName === "img") return "img";
  if (el.localName === "canvas") return "canvas";
  if (el.localName === "image" && el.namespaceURI === SVG_NS) return "svg-image";
  // Gradients alone are not images of text; url() and image-set(url()) are.
  return layout.style(el).backgroundImage.includes("url(") ? "background" : null;
}

/**
 * Image areas in document CSS px, in flat-tree order: of each image that
 * shows in `captureRect`, the part inside it. With `extent`, the part inside
 * that instead (Copy text reads an image beyond the selection's edge, for
 * the words the edge cuts); an image the rect merely borders is none of its,
 * nor one it shows too low a strip of for any word to count.
 */
export function collectImageAreas(
  root: Document | Element,
  captureRect: DocRect,
  opts: { skip?: Element | null; extent?: DocRect } = {},
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
    if (!inside) continue;
    const area = opts.extent
      ? inside.width > EPS && inside.height >= MIN_HEIGHT_INSIDE && intersect(shown, opts.extent)
      : inside;
    if (area && area.width >= MIN_AREA.width && area.height >= MIN_AREA.height) {
      out.push({ ...area, kind });
    }
  }
  return out;
}

export function areasRelativeTo(areas: readonly ImageArea[], region: DocRect): ImageArea[] {
  return areas.map((a) => ({ ...a, x: a.x - region.x, y: a.y - region.y }));
}
