// SPDX-License-Identifier: GPL-3.0-or-later
// The DOM inside a capture rectangle -> text runs: one run per visual line
// of each visible text node, in flat-tree document order, in document CSS px
// of the top-level document. The renderer puts one invisible <text> on each.
import { assignLines, bottom, intersect, right, union } from "../../shared/geometry.ts";
import { linkFor } from "../../shared/links.ts";
import type { DocRect, TextRun } from "../../shared/types.ts";
import {
  applyTextTransform,
  collapse,
  isIconText,
  isPreserved,
  normalizeLines,
} from "../../shared/whitespace.ts";
import { baselineY, fontMetrics } from "./baseline.ts";
import { closestComposed, type FrameContext, flatParent, walkFlatTree } from "./flat-tree.ts";
import { codePointBoundary, codePointStart, sliceRects, splitIntoLines } from "./lines.ts";
import { Layout } from "./visibility.ts";

export interface CollectOptions {
  /** Subtree to leave out (the snapii overlay). */
  skip?: Element | null;
  /** Drop lines whose centre is covered by another element (viewport only). */
  occlusionCheck?: boolean;
}

export interface CollectStats {
  textNodes: number;
  skippedFrames: number;
  skippedVertical: number;
  ms: number;
}

/** Characters a run was taken from; the layout specs re-measure them. */
export interface RunSource {
  node: Text;
  start: number;
  end: number;
  /** The clip the run was cut to, document coordinates. */
  clip: DocRect;
}

// Client rects come in 1/60 px steps; this much overhang still counts as inside.
const EPS = 0.5;
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";

function isLinkish(el: Element): boolean {
  const n = el.localName;
  // Buttons are candidates only so that linkFor can turn them down.
  if (n === "button") return true;
  return (n === "a" || n === "area") && (el.hasAttribute("href") || el.hasAttributeNS(XLINK, "href"));
}

/** URL the element is (inside) a link to, decided by linkFor. */
export function hrefOf(el: Element, pageURL: string): string | null {
  const target = closestComposed(el, isLinkish);
  if (!target) return null;
  const button = target.localName === "button";
  return linkFor({
    tag: target.localName,
    href: button
      ? target.getAttribute("formaction")
      : (target.getAttribute("href") ?? target.getAttributeNS(XLINK, "href")),
    role: target.getAttribute("role"),
    baseURL: target.baseURI,
    pageURL,
    formaction: button && target.hasAttribute("formaction"),
  });
}

function langOf(el: Element): string | null {
  const owner = closestComposed(el, (e) => e.hasAttribute("lang") || e.hasAttributeNS(XML, "lang"));
  return owner?.getAttribute("lang") || owner?.getAttributeNS(XML, "lang") || null;
}

function isBlockLevel(display: string): boolean {
  return !display.startsWith("inline") && !display.startsWith("ruby") && display !== "contents";
}

// Everything a run takes from its parent element, read once per element.
interface ParentInfo {
  visible: boolean;
  vertical: boolean;
  clip: DocRect | null;
  whiteSpace: string;
  transform: string;
  fontKey: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: TextRun["fontStyle"];
  color: string;
  lang: string | null;
  dir: TextRun["dir"];
  href: string | null;
  block: Element;
}

interface RawRun extends TextRun {
  preserved: boolean;
  source: RunSource;
}

/**
 * Keeps the characters of [start, end) whose glyphs lie inside clip
 * horizontally; a capture edge through a word keeps only whole glyphs.
 * `monotonic`: the line is one bidi fragment, so once a kept glyph is
 * followed by one outside the clip no later glyph can be inside — reading on
 * to the end of a million-character line took minutes. It also lets a binary
 * search skip the glyphs before the clip (14 s for an edge 1 M px in).
 */
function trimToClip(
  node: Text,
  range: Range,
  start: number,
  end: number,
  clip: DocRect,
  toDoc: (r: DocRect) => DocRect,
  monotonic: boolean,
): { start: number; end: number; box: DocRect } | null {
  let first = -1;
  let last = -1;
  let box: DocRect | null = null;
  if (monotonic) start = firstAtClip(node, range, start, end, clip, toDoc);
  for (let i = start; i < end; i++) {
    let glyph = false;
    let inside = false;
    for (const r of sliceRects(node, range, i, i + 1)) {
      glyph = true;
      const d = toDoc(r);
      if (d.x >= clip.x - EPS && right(d) <= right(clip) + EPS) {
        inside = true;
        if (first < 0) first = i;
        last = i;
        box = box ? union(box, d) : d;
      }
    }
    // A collapsed space has no glyph and says nothing about where the line is.
    if (monotonic && first >= 0 && glyph && !inside) break;
  }
  if (!box) return null;
  // Keep surrogate pairs whole at both ends.
  return { start: codePointStart(node.data, first), end: codePointBoundary(node.data, last + 1), box };
}

/**
 * On a one-fragment line: the first offset in [start, end) whose glyph is not
 * before clip's leading edge (left for LTR, right for RTL), or a smaller one.
 * Offsets without a glyph (collapsed spaces) take the next glyph's side.
 */
function firstAtClip(
  node: Text,
  range: Range,
  start: number,
  end: number,
  clip: DocRect,
  toDoc: (r: DocRect) => DocRect,
): number {
  const glyph = (i: number): { at: number; rect: DocRect } | null => {
    for (let j = i; j < end; j++) {
      const [r] = sliceRects(node, range, j, j + 1);
      if (r) return { at: j, rect: toDoc(r) };
    }
    return null;
  };
  const head = glyph(start);
  if (!head) return start;
  let tail: DocRect | null = null;
  for (let j = end - 1; j > head.at && !tail; j--) {
    const [r] = sliceRects(node, range, j, j + 1);
    if (r) tail = toDoc(r);
  }
  const rtl = tail !== null && tail.x < head.rect.x;
  const reached = (d: DocRect) => (rtl ? right(d) <= right(clip) + EPS : d.x >= clip.x - EPS);
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const g = glyph(mid);
    if (!g || reached(g.rect)) hi = mid;
    else lo = g.at + 1;
  }
  return lo;
}

export async function collectTextRuns(
  root: Document | Element,
  captureRect: DocRect,
  opts: CollectOptions = {},
): Promise<{ runs: TextRun[]; stats: CollectStats }> {
  const { runs, stats } = await collectTextRunsDetailed(root, captureRect, opts);
  return { runs, stats };
}

/** collectTextRuns plus, per run, the characters it came from (debug side channel). */
export async function collectTextRunsDetailed(
  root: Document | Element,
  captureRect: DocRect,
  opts: CollectOptions = {},
): Promise<{ runs: TextRun[]; stats: CollectStats; sources: RunSource[] }> {
  const t0 = performance.now();
  const stats: CollectStats = { textNodes: 0, skippedFrames: 0, skippedVertical: 0, ms: 0 };
  const texts: { node: Text; ctx: FrameContext }[] = [];
  const opaque: { frame: Element; ctx: FrameContext }[] = [];
  const docs = new Set<Document>();
  const walk = walkFlatTree(root, {
    skip: opts.skip,
    onOpaqueFrame: (frame, ctx) => opaque.push({ frame, ctx }),
  });
  for (const { node, ctx } of walk) {
    if (node.nodeType === Node.TEXT_NODE) texts.push({ node: node as Text, ctx });
    else docs.add(ctx.doc);
  }
  stats.textNodes = texts.length;
  // Every measurement below has to see the layout with its final fonts.
  await Promise.all([...docs].map((d) => d.fonts.ready));

  const layout = new Layout();
  for (const { frame, ctx } of opaque) {
    if (intersect(layout.toDoc(frame.getBoundingClientRect(), ctx), captureRect)) stats.skippedFrames++;
  }
  const pageURL = (
    root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as Element).ownerDocument
  ).URL;
  const ranges = new Map<Document, Range>();
  const parents = new Map<Element, ParentInfo>();
  const blocks = new Map<Element, number>();

  const infoOf = (el: Element, ctx: FrameContext): ParentInfo => {
    let info = parents.get(el);
    if (info) return info;
    const cs = layout.style(el);
    const fontStyle = cs.fontStyle.startsWith("oblique")
      ? "oblique"
      : cs.fontStyle === "italic"
        ? "italic"
        : "normal";
    const fontSize = Number.parseFloat(cs.fontSize) || 0;
    const fontWeight = Number.parseFloat(cs.fontWeight) || 400;
    info = {
      visible: layout.isRendered(el),
      vertical: !cs.writingMode.startsWith("horizontal"),
      clip: layout.clip(el, ctx),
      whiteSpace: cs.getPropertyValue("white-space-collapse") || cs.whiteSpace,
      transform: cs.textTransform,
      fontKey: `${fontStyle} ${fontWeight} ${fontSize}px ${cs.fontFamily}`,
      fontFamily: cs.fontFamily,
      fontSize,
      fontWeight,
      fontStyle,
      color: cs.color,
      lang: langOf(el),
      dir: cs.direction === "rtl" ? "rtl" : "ltr",
      href: hrefOf(el, pageURL),
      block: closestComposed(el, (e) => isBlockLevel(layout.style(e).display)) ?? el,
    };
    parents.set(el, info);
    return info;
  };

  const raw: RawRun[] = [];
  for (const { node, ctx } of texts) {
    if (!node.data) continue;
    if (!layout.frame(ctx).clip) continue;
    let range = ranges.get(ctx.doc);
    if (!range) {
      range = ctx.doc.createRange();
      ranges.set(ctx.doc, range);
    }
    range.selectNodeContents(node);
    // Cheap reject: one rect read per node; everything below costs far more.
    const outer = range.getBoundingClientRect();
    if (outer.width <= 0 || outer.height <= 0 || !intersect(layout.toDoc(outer, ctx), captureRect)) continue;

    const parent = flatParent(node);
    if (!parent) continue;
    const info = infoOf(parent, ctx);
    if (!info.visible) continue;
    if (info.vertical) {
      stats.skippedVertical++;
      continue;
    }
    const clip = info.clip && intersect(info.clip, captureRect);
    if (!clip) continue;
    const metrics = fontMetrics(ctx.doc, info.fontKey);
    const toDoc = (r: DocRect) => layout.toDoc(r, ctx);

    for (const line of splitIntoLines(node, range)) {
      const rect = toDoc(line.rect);
      const shown = intersect(rect, clip);
      // Less than half the line visible: the raster shows a sliver, not text.
      if (!shown || shown.height < rect.height / 2) continue;
      let { start, end } = line;
      let box = rect;
      if (rect.x < clip.x - EPS || right(rect) > right(clip) + EPS) {
        const kept = trimToClip(node, range, start, end, clip, toDoc, line.parts.length === 1);
        if (!kept) continue;
        ({ start, end, box } = kept);
      }
      if (opts.occlusionCheck && layout.occluded(parent, box, ctx, opts.skip)) continue;
      const text = applyTextTransform(
        collapse(node.data.slice(start, end), info.whiteSpace),
        info.transform,
        info.lang,
      );
      if (!text || isIconText(text)) continue;
      let block = blocks.get(info.block);
      if (block === undefined) {
        block = blocks.size;
        blocks.set(info.block, block);
      }
      const top = Math.max(box.y, clip.y);
      raw.push({
        text,
        x: box.x,
        // From the unclipped line: a line cut at the capture edge keeps its baseline.
        y: baselineY(line.parts.map(toDoc), rect, metrics),
        top,
        width: box.width,
        height: Math.min(bottom(box), bottom(clip)) - top,
        fontFamily: info.fontFamily,
        fontSize: info.fontSize,
        fontWeight: info.fontWeight,
        fontStyle: info.fontStyle,
        color: info.color,
        lang: info.lang,
        dir: info.dir,
        href: info.href,
        line: 0,
        block,
        preserved: isPreserved(info.whiteSpace),
        source: { node, start, end, clip },
      });
    }
  }

  const done = normalizeLines(assignLines(raw));
  // Runs dropped by normalizeLines (lone spaces) leave gaps; hand out dense numbers.
  const dense = (ids: Map<number, number>, id: number) => {
    if (!ids.has(id)) ids.set(id, ids.size);
    return ids.get(id) as number;
  };
  const lineIds = new Map<number, number>();
  const blockIds = new Map<number, number>();
  stats.ms = performance.now() - t0;
  return {
    runs: done.map(({ preserved: _p, source: _s, ...run }) => ({
      ...run,
      line: dense(lineIds, run.line),
      block: dense(blockIds, run.block),
    })),
    stats,
    sources: done.map((r) => r.source),
  };
}
