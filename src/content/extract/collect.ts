// SPDX-License-Identifier: GPL-3.0-or-later
// The DOM inside a capture rectangle -> text runs: one run per visual line
// of each visible text node, in flat-tree document order, in document CSS px
// of the top-level document. The renderer puts one invisible <text> on each.
import {
  assignLines,
  bottom,
  EPS,
  intersect,
  reachesInto,
  right,
  UNBOUNDED,
  union,
  unionAll,
} from "../../shared/geometry.ts";
import { linkFor } from "../../shared/links.ts";
import type { DocRect, TextRun } from "../../shared/types.ts";
import {
  applyTextTransform,
  collapse,
  isIconText,
  isPreserved,
  keepsBreaks,
  normalizeLines,
  wordTail,
} from "../../shared/whitespace.ts";
import { runsOn, wordAt } from "../../shared/words.ts";
import { baselineY, fontMetrics } from "./baseline.ts";
import { closestComposed, type FrameContext, flatParent, walkFlatTree } from "./flat-tree.ts";
import { codePointBoundary, codePointStart, type LineSlice, sliceRects, splitIntoLines } from "./lines.ts";
import { Layout } from "./visibility.ts";

export interface CollectOptions {
  /** Subtree to leave out (the snapii overlay). */
  skip?: Element | null;
  /** Drop lines whose centre is covered by another element (viewport only). */
  occlusionCheck?: boolean;
  /**
   * Copy text: a word the rectangle's left or right edge runs through is
   * taken whole, with the part of it in a neighbouring text node of its line
   * (foo<b>bar</b>), and a word wholly outside is left out. Only the
   * rectangle's own edges give way: what the page clips stays cut. Off, a
   * cut line keeps the glyphs that lie wholly inside, as the saved picture
   * shows them.
   */
  wholeWords?: boolean;
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

const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XHTML = "http://www.w3.org/1999/xhtml";
const MATHML = "http://www.w3.org/1998/Math/MathML";

function isLinkish(el: Element): boolean {
  const n = el.localName;
  // Buttons are candidates only so that linkFor can turn them down.
  if (n === "button") return true;
  return (n === "a" || n === "area") && (el.hasAttribute("href") || el.hasAttributeNS(XLINK, "href"));
}

/** URL the element is (inside) a link to, decided by linkFor. */
export function hrefOf(el: Element, pageURL: string): string | null {
  const target = closestComposed(el, isLinkish);
  return target ? linkOf(target, pageURL) : null;
}

/** What a link-ish element links to, decided by linkFor. */
function linkOf(target: Element, pageURL: string): string | null {
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

const hasLang = (e: Element): boolean => e.hasAttribute("lang") || e.hasAttributeNS(XML, "lang");
const ownLang = (e: Element): string | null =>
  e.getAttribute("lang") || e.getAttributeNS(XML, "lang") || null;

/** white-space-collapse where the engine has it, else the legacy white-space. */
const whiteSpaceOf = (cs: CSSStyleDeclaration): string =>
  cs.getPropertyValue("white-space-collapse") || cs.whiteSpace;

/** Newlines in data[from, to). */
function newlines(data: string, from: number, to = data.length): number {
  let n = 0;
  for (let i = from; i < to; i++) if (data.charCodeAt(i) === 10) n++;
  return n;
}

/** Inline-level displays that do not say "inline": inline MathML (Chromium computes `math`), an old-flexbox inline box. */
const INLINE_ATOMIC = new Set(["math", "-webkit-inline-box"]);

function isBlockLevel(display: string): boolean {
  return (
    !display.startsWith("inline") &&
    !display.startsWith("ruby") &&
    display !== "contents" &&
    !INLINE_ATOMIC.has(display)
  );
}

/**
 * e starts a block of its own. Inside a formula the formula lays out its
 * parts, whatever their display says (Chromium computes `block math` for
 * <mi>): only the <math> element itself is a block or not.
 */
function startsBlock(e: Element, display: string): boolean {
  return isBlockLevel(display) && (e.namespaceURI !== MATHML || e.localName === "math");
}

/** Elements that break a word for `capitalize` when they stand between two text nodes (with inline-* boxes). */
const ATOMIC = new Set([
  "br",
  "hr",
  "img",
  "svg",
  "canvas",
  "video",
  "audio",
  "iframe",
  "object",
  "embed",
  "input",
  "select",
  "textarea",
  "button",
]);

/** Whole words: the ruby elements whose text annotates the base beside it. */
const RUBY_TEXT = new Set(["rt", "rp"]);
/** Whole words: displays whose in-flow children are items, each a box of its own. */
const ITEM_CONTAINERS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);
const OUT_OF_FLOW = new Set(["absolute", "fixed"]);

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
  /** The nearest block-level or inline-block (inline-flex, …) ancestor: a word never crosses its edge. */
  root: Element;
}

interface RawRun extends TextRun {
  preserved: boolean;
  source: RunSource;
}

/** The characters [start, end) of one line of a text node that make a run. */
interface Cut {
  line: LineSlice;
  /** The line's box and the box of the characters taken, document coordinates. */
  rect: DocRect;
  box: DocRect;
  start: number;
  end: number;
  /** Whole words with the occlusion check: something else is painted over the part of it in the rectangle; no run. */
  covered?: true;
}

/** A text node's part in the capture: its parent, the clip its runs are cut to, and its cuts in line order. */
interface Measured {
  parent: Element;
  info: ParentInfo;
  clip: DocRect;
  cuts: Cut[];
}

/**
 * Two boxes of one visual line: the shorter one's vertical centre lies in the
 * taller one, as `assignLines` has it. Any overlap is not enough: under a
 * tight line-height the next line's box reaches up into this one, and a word
 * wrapped at its hyphen is not one word of one line.
 */
function sameLine(a: DocRect, b: DocRect): boolean {
  const [short, tall] = a.height <= b.height ? [a, b] : [b, a];
  const centre = short.y + short.height / 2;
  return centre >= tall.y && centre <= bottom(tall);
}

/**
 * Keeps the characters of [start, end) whose glyphs lie inside clip
 * horizontally; a capture edge through a word keeps only whole glyphs.
 * `monotonic`: the line is one bidi fragment, so once a kept glyph is
 * followed by one outside the clip no later glyph can be inside — reading on
 * to the end of a million-character line took minutes. It also lets a binary
 * search skip the glyphs before the clip (14 s for an edge 1 M px in).
 * `touching` keeps the glyphs clip reaches into as well, a glyph its edge
 * runs through included: the characters whose words Copy text takes. Never
 * fewer than without it.
 */
function trimToClip(
  node: Text,
  range: Range,
  start: number,
  end: number,
  clip: DocRect,
  toDoc: (r: DocRect) => DocRect,
  monotonic: boolean,
  touching = false,
): { start: number; end: number; box: DocRect } | null {
  let first = -1;
  let last = -1;
  let box: DocRect | null = null;
  let rtl = false;
  if (monotonic) ({ at: start, rtl } = firstAtClip(node, range, start, end, clip, toDoc, touching));
  for (let i = start; i < end; i++) {
    let glyph = false;
    let inside = false;
    // Touching: the glyph lies beyond clip's far edge, where no later one reaches back.
    let past = false;
    for (const r of sliceRects(node, range, i, i + 1)) {
      glyph = true;
      const d = toDoc(r);
      if ((d.x >= clip.x - EPS && right(d) <= right(clip) + EPS) || (touching && reachesInto(d, clip))) {
        inside = true;
        if (first < 0) first = i;
        last = i;
        box = box ? union(box, d) : d;
      } else if (touching) past = rtl ? right(d) <= clip.x - EPS : d.x >= right(clip) + EPS;
    }
    // A collapsed space has no glyph and says nothing about where the line is.
    if (monotonic && (first >= 0 || past) && glyph && !inside) break;
  }
  if (!box) return null;
  // Keep surrogate pairs whole at both ends.
  return { start: codePointStart(node.data, first), end: codePointBoundary(node.data, last + 1), box };
}

/**
 * On a one-fragment line: the first offset in [start, end) whose glyph is not
 * before clip's leading edge (left for LTR, right for RTL), or a smaller one.
 * Offsets without a glyph (collapsed spaces) take the next glyph's side.
 * `touching`: or whose glyph reaches past that edge, as `reachesInto` has
 * it. `rtl`: the line runs right to left.
 */
function firstAtClip(
  node: Text,
  range: Range,
  start: number,
  end: number,
  clip: DocRect,
  toDoc: (r: DocRect) => DocRect,
  touching: boolean,
): { at: number; rtl: boolean } {
  /** The first glyph from i on, before `to`. */
  const glyph = (i: number, to = end): { at: number; rect: DocRect } | null => {
    for (let j = i; j < to; j++) {
      const [r] = sliceRects(node, range, j, j + 1);
      if (r) return { at: j, rect: toDoc(r) };
    }
    return null;
  };
  const head = glyph(start);
  if (!head) return { at: start, rtl: false };
  let tail: DocRect | null = null;
  for (let j = end - 1; j > head.at && !tail; j--) {
    const [r] = sliceRects(node, range, j, j + 1);
    if (r) tail = toDoc(r);
  }
  const rtl = tail !== null && tail.x < head.rect.x;
  const reached = (d: DocRect) =>
    (rtl ? right(d) <= right(clip) + EPS : d.x >= clip.x - EPS) ||
    (touching && (rtl ? right(clip) - d.x : right(d) - clip.x) > EPS);
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // None before hi: the first glyph from mid on is at or after hi, which is reached.
    const g = glyph(mid, hi);
    if (!g || reached(g.rect)) hi = mid;
    else lo = g.at + 1;
  }
  return { at: lo, rtl };
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
  /** `at`: how many of `elements` (every element in walk order) came before the text node, for `capitalize`. */
  const texts: { node: Text; ctx: FrameContext; at: number }[] = [];
  const elements: Element[] = [];
  const opaque: { frame: Element; ctx: FrameContext }[] = [];
  const docs = new Set<Document>();
  const walk = walkFlatTree(root, {
    skip: opts.skip,
    onOpaqueFrame: (frame, ctx) => opaque.push({ frame, ctx }),
  });
  for (const { node, ctx } of walk) {
    if (node.nodeType === Node.TEXT_NODE) texts.push({ node: node as Text, ctx, at: elements.length });
    else {
      docs.add(ctx.doc);
      elements.push(node as Element);
    }
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

  /**
   * What an element takes from its flat-tree ancestors: its block, its
   * word root, its language and its link — each its own if it sets one,
   * else its parent's. Up to the nearest element already known, then back
   * down: a deep inline tree costs a step per element, not a walk to the
   * root for each (1 500 nested <u> read a million attributes).
   */
  const inherited = new Map<
    Element,
    { block: Element | null; root: Element | null; lang: string | null; href: string | null }
  >();
  const inheritedOf = (el: Element) => {
    const chain: Element[] = [];
    let at: Element | null = el;
    while (at && !inherited.has(at)) {
      chain.push(at);
      at = flatParent(at);
    }
    let up = at ? inherited.get(at) : undefined;
    for (const e of chain.reverse()) {
      const d = layout.style(e).display;
      const block = startsBlock(e, d);
      const own = {
        block: block ? e : (up?.block ?? null),
        root: block || d.startsWith("inline-") || INLINE_ATOMIC.has(d) ? e : (up?.root ?? null),
        lang: hasLang(e) ? ownLang(e) : (up?.lang ?? null),
        href: isLinkish(e) ? linkOf(e, pageURL) : (up?.href ?? null),
      };
      inherited.set(e, own);
      up = own;
    }
    return up as NonNullable<typeof up>;
  };

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
    // The computed size is before CSS zoom, the text is painted zoomed; a
    // display: contents element (a slot) reports 1, its boxed ancestor the
    // zoom (measured, both browsers).
    const boxed = closestComposed(el, (e) => layout.style(e).display !== "contents") ?? el;
    const zoom = (boxed as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
    const fontWeight = Number.parseFloat(cs.fontWeight) || 400;
    const from = inheritedOf(el);
    info = {
      visible: layout.isRendered(el),
      vertical: !cs.writingMode.startsWith("horizontal"),
      clip: layout.clip(el, ctx),
      whiteSpace: whiteSpaceOf(cs),
      transform: cs.textTransform,
      fontKey: `${fontStyle} ${fontWeight} ${fontSize}px ${cs.fontFamily}`,
      fontFamily: cs.fontFamily,
      fontSize: fontSize * zoom,
      fontWeight,
      fontStyle,
      color: cs.color,
      lang: from.lang,
      dir: cs.direction === "rtl" ? "rtl" : "ltr",
      href: from.href,
      block: from.block ?? el,
      root: from.root ?? el,
    };
    parents.set(el, info);
    return info;
  };

  /**
   * The newlines of tail.node after tail.from, where they break lines of
   * the last run's inline flow: rendered HTML text whose parent keeps
   * breaks, laid out in the last run's block itself or in the inline-block
   * the last run is in (a code element made one) — not in another
   * inline-block, a form control, an out-of-flow box (its own block) or SVG
   * markup.
   */
  const tailBreaks = (tail: { node: Text; ctx: FrameContext; from: number }, last: ParentInfo): number => {
    const p = flatParent(tail.node);
    if (!p || p.namespaceURI !== XHTML || !closestComposed(p, (e) => e === last.block)) return 0;
    const info = infoOf(p, tail.ctx);
    if (info.root !== last.block && info.root !== last.root) return 0;
    if (!info.visible || !keepsBreaks(info.whiteSpace)) return 0;
    return newlines(tail.node.data, tail.from);
  };

  const words = opts.wholeWords === true;
  // Whole words: the rectangle's rows across the page's width. A word's glyphs
  // beyond the rectangle's left or right edge count; what the page clips of
  // them does not.
  const rows: DocRect = words
    ? { x: UNBOUNDED.x, y: captureRect.y, width: UNBOUNDED.width, height: captureRect.height }
    : captureRect;

  type TextAt = (typeof texts)[number];
  const textAt = (i: number): TextAt => texts[i] as TextAt;

  /**
   * t is laid out in root's inline flow: it has a box — under display:
   * contents (a slot) its nearest boxed ancestor has one — and is in no other
   * inline-block and in no box out of the flow (absolutely positioned or
   * floated).
   */
  const flows = (t: TextAt, root: Element): boolean => {
    const p = flatParent(t.node);
    const boxed = p && closestComposed(p, (e) => layout.style(e).display !== "contents");
    return !!p && !!boxed && layout.hasBox(boxed) && infoOf(p, t.ctx).root === root;
  };

  /** No atomic element and no inline-block is laid out between texts j and i (j first): none a word of one line would have to get past. */
  const unbroken = (j: number, i: number): boolean => {
    // The flat-tree ancestors of the later text: an element between that holds it is no boundary.
    const ancestors = new Set<Element>();
    for (let a = flatParent(textAt(i).node); a; a = flatParent(a)) ancestors.add(a);
    for (const e of elements.slice(textAt(j).at, textAt(i).at)) {
      if (ancestors.has(e) || !layout.hasBox(e)) continue;
      const d = layout.style(e).display;
      if (ATOMIC.has(e.localName) || d.startsWith("inline-") || INLINE_ATOMIC.has(d)) return false;
    }
    return true;
  };

  /**
   * What text i gives the capture, or null for none. `beside` asks a
   * neighbour of a cut word instead (whole words): the word at the node's end
   * (`tail`) or start, if it stands on the line of `rect` — also in a node the
   * rectangle does not touch.
   */
  const measure = (i: number, beside?: { rect: DocRect; tail: boolean }): Measured | null => {
    const { node, ctx } = textAt(i);
    if (!node.data) return null;
    if (!layout.frame(ctx).clip) return null;
    let range = ranges.get(ctx.doc);
    if (!range) {
      range = ctx.doc.createRange();
      ranges.set(ctx.doc, range);
    }
    range.selectNodeContents(node);
    // Cheap reject: one rect read per node; everything below costs far more.
    const outer = range.getBoundingClientRect();
    if (
      outer.width <= 0 ||
      outer.height <= 0 ||
      !intersect(layout.toDoc(outer, ctx), beside ? rows : captureRect)
    )
      return null;

    const parent = flatParent(node);
    if (!parent) return null;
    const info = infoOf(parent, ctx);
    if (!info.visible) return null;
    if (info.vertical) {
      if (!beside) stats.skippedVertical++;
      return null;
    }
    const clip = info.clip && intersect(info.clip, rows);
    // Whole words: the lines to look at are still those the rectangle meets.
    const within = clip && words ? intersect(clip, captureRect) : clip;
    if (!clip || !(within || beside)) return null;
    const toDoc = (r: DocRect) => layout.toDoc(r, ctx);
    const cuts: Cut[] = [];
    const lines = splitIntoLines(node, range, (r) =>
      beside ? sameLine(toDoc(r), beside.rect) : within !== null && intersect(toDoc(r), within) !== null,
    );
    for (const line of lines) {
      const rect = toDoc(line.rect);
      // A node of one line comes back whatever the filter says.
      if (beside && !sameLine(rect, beside.rect)) continue;
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
      if (words) {
        // The characters the rectangle reaches, then out to the edges of their
        // words, as far as the line shows them.
        let from = start;
        let to = end;
        if (beside) {
          if (beside.tail ? end !== node.data.length : start !== 0) continue;
          if (beside.tail) from = end - 1;
          else to = start + 1;
        } else if (box.x < captureRect.x - EPS || right(box) > right(captureRect) + EPS) {
          const hit = trimToClip(node, range, start, end, captureRect, toDoc, line.parts.length === 1, true);
          if (!hit) continue;
          ({ start: from, end: to } = hit);
        }
        from = Math.max(start, wordAt(node.data, from, info.lang, line.start, line.end).start);
        to = Math.min(end, wordAt(node.data, to - 1, info.lang, line.start, line.end).end);
        if (from > start || to < end) {
          box = unionAll(sliceRects(node, range, from, to).map(toDoc)) ?? box;
          start = from;
          end = to;
        }
      }
      cuts.push({ line, rect, start, end, box });
    }
    return { parent, info, clip, cuts };
  };

  /**
   * Whole words across text nodes: where a taken word reaches the start or
   * the end of its text node and goes on in the text beside it on its line
   * (foo<b>bar</b>baz), the neighbour gives its part of the word, and through
   * a neighbour that is all one word the next one does. What parts two words
   * there is what parts them for `capitalize` (see `before` below) — white
   * space, another block or inline-block, an atomic element between — and
   * what parts them for the eye: a gap between the two (padding, a margin),
   * a flex or grid item between, a ruby annotation.
   */
  const joinWords = (plan: (Measured | null)[]): void => {
    /**
     * The widest gap a word goes on across: what letter-spacing puts
     * between two letters, and a quarter of the font size (2 px for small
     * print) for kerning, an italic's overhang and rounding. The smaller of
     * the two texts' counts, so a cut says by itself how far its neighbour
     * can be.
     */
    const slack = (m: Measured): number =>
      Math.max(2, m.info.fontSize / 4) +
      Math.max(0, Number.parseFloat(layout.style(m.parent).letterSpacing) || 0);

    /** The glyph at a cut's end (`tail`) or start: the one that faces the text beside it. */
    const facing = (k: number, cut: Cut, tail: boolean): DocRect => {
      const { node, ctx } = textAt(k);
      const from = tail ? codePointStart(node.data, cut.end - 1) : cut.start;
      const to = tail ? cut.end : codePointBoundary(node.data, cut.start + 1);
      const rects = sliceRects(node, ranges.get(ctx.doc) as Range, from, to);
      return unionAll(rects.map((r) => layout.toDoc(r, ctx))) ?? cut.box;
    };

    /**
     * The flowing text before and after each flowing text of the same word
     * root (see `flows`), -1 for none. One pass over the page, made when the
     * first cut asks: a search from each text for its neighbour took 25 s on
     * 600 nested blocks.
     */
    let links: { before: Int32Array; after: Int32Array } | null = null;
    const linked = (): NonNullable<typeof links> => {
      if (links) return links;
      const before = new Int32Array(texts.length).fill(-1);
      const after = new Int32Array(texts.length).fill(-1);
      const last = new Map<Element, number>();
      const boxes = new Map<Element, boolean>();
      for (const [i, t] of texts.entries()) {
        const p = t.node.data ? flatParent(t.node) : null;
        const boxed = p && closestComposed(p, (e) => layout.style(e).display !== "contents");
        if (!p || !boxed) continue;
        let has = boxes.get(boxed);
        if (has === undefined) {
          has = layout.hasBox(boxed);
          boxes.set(boxed, has);
        }
        if (!has) continue;
        const root = inheritedOf(p).root ?? p;
        const j = last.get(root);
        if (j !== undefined) {
          before[i] = j;
          after[j] = i;
        }
        last.set(root, i);
      }
      links = { before, after };
      return links;
    };

    const annotation = (k: number): Element | null => {
      const p = flatParent(textAt(k).node);
      return (
        p && closestComposed(p, (e) => RUBY_TEXT.has(e.localName) || layout.style(e).display === "ruby-text")
      );
    };
    /**
     * Something parts texts j and i (j first) that a word of one line does
     * not get past: what parts them for `capitalize`; a ruby annotation, which
     * is never part of its base's word; a flex or grid item between them — a
     * box of its own, however close it stands (Total<b>5</b>items in a flex
     * row are three items, and the two texts share the container as root).
     */
    const parted = (j: number, i: number): boolean => {
      if (!unbroken(j, i) || annotation(j) !== annotation(i)) return true;
      for (const e of elements.slice(textAt(j).at, textAt(i).at)) {
        if (!layout.hasBox(e) || OUT_OF_FLOW.has(layout.style(e).position)) continue;
        const up = flatParent(e);
        const container = up && closestComposed(up, (a) => layout.style(a).display !== "contents");
        if (container && ITEM_CONTAINERS.has(layout.style(container).display)) return true;
      }
      return false;
    };

    /**
     * Takes the part of cut's word that stands in the text before text i
     * (`backwards`) or after it, if there is one; that text and its cut, or
     * null. The checks go from cheap to dear, and the first needs nothing
     * but the cut: a neighbour near enough to belong to the word, next to a
     * glyph well inside the rectangle, is one the rectangle reaches itself.
     */
    const reach = (i: number, cut: Cut, backwards: boolean): { at: number; cut: Cut } | null => {
      const reachable = slack(plan[i] as Measured);
      const inside = (r: DocRect): boolean =>
        r.x > captureRect.x + EPS + reachable && right(r) < right(captureRect) - EPS - reachable;
      if (inside(cut.box)) return null;
      const k = backwards ? linked().before[i] : linked().after[i];
      if (k === undefined || k < 0) return null;
      const { data } = textAt(k).node;
      if (!runsOn(data, backwards ? data.length - 1 : 0)) return null;
      const had = plan[k];
      // Its word is taken already, or is covered.
      if (backwards ? had?.cuts.at(-1)?.end === data.length : had?.cuts[0]?.start === 0) return null;
      const mine = facing(i, cut, !backwards);
      if (inside(mine)) return null;
      const more = measure(k, { rect: cut.rect, tail: backwards });
      const part = more?.cuts[0];
      if (!more || !part) return null;
      const theirs = facing(k, part, backwards);
      const gap = Math.max(mine.x, theirs.x) - Math.min(right(mine), right(theirs));
      if (gap > Math.min(reachable, slack(more))) return null;
      if (backwards ? parted(k, i) : parted(i, k)) return null;
      if (!had) {
        plan[k] = more;
        return { at: k, cut: part };
      }
      const next = backwards ? had.cuts[had.cuts.length - 1] : had.cuts[0];
      if (next && next.line.start === part.line.start && part.start <= next.end && next.start <= part.end) {
        // A covered one stays covered, with what it takes in.
        next.box = union(next.box, part.box);
        next.start = Math.min(next.start, part.start);
        next.end = Math.max(next.end, part.end);
        return { at: k, cut: next };
      }
      if (backwards) had.cuts.push(part);
      else had.cuts.unshift(part);
      return { at: k, cut: part };
    };

    for (let i = 0; i < plan.length; i++) {
      const measured = plan[i];
      if (!measured || measured.cuts.length === 0) continue;
      // Backwards, node by node: the texts before i have had their turn.
      let at = i;
      let cut = measured.cuts[0] as Cut;
      while (!cut.covered && cut.start === 0 && runsOn(textAt(at).node.data, 0)) {
        const more = reach(at, cut, true);
        if (!more) break;
        ({ at, cut } = more);
      }
      // Forwards one node: the loop goes on from there.
      const last = measured.cuts[measured.cuts.length - 1] as Cut;
      const { data } = textAt(i).node;
      if (!last.covered && last.end === data.length && runsOn(data, data.length - 1)) reach(i, last, false);
    }
  };

  const plan = words ? texts.map((_, i) => measure(i)) : null;
  if (plan) {
    // Before the words grow: a word is covered or not by its part in the
    // rectangle. The middle of the whole word can lie under something the
    // rectangle does not show.
    if (opts.occlusionCheck) {
      for (const [i, measured] of plan.entries()) {
        if (!measured) continue;
        for (const cut of measured.cuts) {
          const seen = intersect(cut.box, captureRect) ?? cut.box;
          if (layout.occluded(measured.parent, seen, textAt(i).ctx, opts.skip)) cut.covered = true;
        }
      }
    }
    joinWords(plan);
  }

  const raw: RawRun[] = [];
  /** Index in `texts` of the node the last raw run came from. */
  let lastRun = -1;
  /**
   * Segment breaks of preserved text since the last run's last character:
   * two or more before a run of the same block are empty lines between, which
   * no run carries (a "\n" slice collapses to nothing, a "\n\n" text node
   * between two spans has no glyph and no rect).
   */
  let breaks = 0;
  /** The last run's parent: only text in its block can stand between that run and the next one of the block. */
  let lastInfo: ParentInfo | null = null;
  /** The node in hand and the offset after its last run's text, for the breaks that follow it. */
  let tail: { node: Text; ctx: FrameContext; from: number } | null = null;
  for (const [i, { node, ctx }] of texts.entries()) {
    if (tail && lastInfo && tail.node.data.includes("\n", tail.from)) breaks += tailBreaks(tail, lastInfo);
    tail = { node, ctx, from: 0 };
    const measured = plan ? plan[i] : measure(i);
    if (!measured) continue;
    const { parent, info, clip, cuts } = measured;
    const metrics = fontMetrics(ctx.doc, info.fontKey);
    const toDoc = (r: DocRect) => layout.toDoc(r, ctx);
    /**
     * What is rendered before a slice, for `capitalize`: the node's own text
     * before it, else the last run's node's where the page runs the word on
     * across the two (foo<b>bar</b>, foo<span hidden>x</span>bar, text
     * slotted through a shadow tree): on the same line, under the same block
     * or inline-block, with no atomic element or line break laid out between
     * the two text nodes — a picture, an inline-block, a <br>, a collapsed
     * space start a word, painted or not (visibility: hidden, opacity: 0;
     * both browsers capitalise after each; measured). Text with no box
     * (display: none) or an empty inline between does not.
     */
    const before = (start: number, box: DocRect): string => {
      if (!info.transform.includes("capitalize")) return "";
      if (start > 0) return wordTail(node.data, start);
      const prev = raw[raw.length - 1];
      if (!prev || lastRun < 0 || prev.source.node.ownerDocument !== ctx.doc) return "";
      const parent = flatParent(prev.source.node);
      const prevInfo = parent && infoOf(parent, ctx);
      if (!prevInfo || prevInfo.root !== info.root) return "";
      if (!(prev.top < box.y + box.height && box.y < prev.top + prev.height)) return "";
      for (let j = lastRun + 1; j < i; j++) {
        // A text node that made no run: one laid out in this line's flow holding a
        // space is a boundary; one without a box or out of the flow is not.
        const t = textAt(j);
        if (/\s/.test(t.node.data) && flows(t, info.root)) return "";
      }
      if (!unbroken(lastRun, i)) return "";
      // Not wordTail: across nodes the engines part after marks, joiners, emoji or a
      // second apostrophe (x''<b>abc</b>: Chromium "Abc", Firefox "abc"; measured).
      return prev.source.node.data.slice(-2);
    };

    for (const { line, rect, start, end, box, covered } of cuts) {
      if (covered || (!plan && opts.occlusionCheck && layout.occluded(parent, box, ctx, opts.skip))) continue;
      const text = applyTextTransform(
        collapse(node.data.slice(start, end), info.whiteSpace),
        info.transform,
        info.lang,
        before(start, box),
      );
      if (!text || isIconText(text)) continue;
      // The newlines around a slice's text end the line before it or its own;
      // where spaces collapse (pre-line) they have no glyph and stay in the
      // slice beside them, where they are kept they are the text.
      const slice = keepsBreaks(info.whiteSpace) ? node.data.slice(start, end) : "";
      const edge = isPreserved(info.whiteSpace) ? /^\n+/ : /^[ \t\n\r]+/;
      const lead = slice.length - slice.replace(edge, "").length;
      const rest = slice.slice(lead);
      const trail =
        rest.length - rest.replace(isPreserved(info.whiteSpace) ? /\n+$/ : /[ \t\n\r]+$/, "").length;
      const gap = breaks + (slice ? newlines(node.data, tail.from, start + lead) : 0);
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
        ...(gap > 1 ? { blankLinesBefore: gap - 1 } : {}),
        preserved: isPreserved(info.whiteSpace),
        source: { node, start, end, clip },
      });
      lastRun = i;
      breaks = 0;
      lastInfo = info;
      tail.from = end - trail;
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
