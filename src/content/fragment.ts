// SPDX-License-Identifier: GPL-3.0-or-later
// Text-fragment URL (`#:~:text=…`) that re-finds the captured passage. Firefox
// offers no extension API to generate one, so the polyfill's generator runs
// in the content script. Only the generation utils are imported: the
// package root would install the whole polyfill into the page (S11).
import {
  GenerateFragmentStatus,
  generateFragmentFromRange,
  setTimeout as setGenerationTimeout,
} from "text-fragments-polyfill/dist/fragment-generation-utils.js";
import { serializeTextDirective, type TextFragment, withTextDirective } from "../shared/textdirective.ts";
import type { FragmentStatus } from "../shared/types.ts";

// Generation walks the DOM synchronously inside the toolbar click; past this
// budget a plain URL is the better answer than a frozen page. 500 ms timed out
// on wide selections of a news front page (ga.de, 2026-10-01: 600-650 ms).
// The budget covers both attempts (first block, then the whole range).
export const GENERATION_TIMEOUT_MS = 2000;

/**
 * Elements the generator treats as block boundaries (BLOCK_ELEMENTS plus
 * html and body, polyfill 6.7.0; not exported by its dist build). A range
 * without one inside and at most 300 characters long is matched as one exact
 * string, the generator's cheapest case.
 */
const GENERATOR_BLOCKS = new Set(
  (
    "ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DETAILS DIALOG DD DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER " +
    "FORM H1 H2 H3 H4 H5 H6 HEADER HGROUP HR LI MAIN NAV OL P PRE SECTION TABLE UL TR TH TD COLGROUP COL " +
    "CAPTION THEAD TBODY TFOOT HTML BODY"
  ).split(" "),
);

const isGeneratorBlock = (n: Node): boolean =>
  n.nodeType === Node.ELEMENT_NODE && GENERATOR_BLOCKS.has((n as Element).tagName.toUpperCase());

/**
 * Whether text inside n and text outside it lie in different blocks. The
 * generator goes by tag name; a browser's own text-fragment search goes by
 * layout, and an exact match never crosses a block boundary there: a kicker
 * and a headline in two <span>s with display:block (spiegel.de teasers) are
 * one run to the generator, and the link it makes for both finds nothing
 * (measured in Chromium 153 and Firefox 155). Anything but plain inline
 * layout counts, so a run can only come out shorter, never across a boundary.
 */
function isBlockBoundary(n: Node): boolean {
  if (n.nodeType !== Node.ELEMENT_NODE) return false;
  if (isGeneratorBlock(n)) return true;
  const display = getComputedStyle(n as Element).display;
  return display !== "inline" && display !== "contents" && display !== "none";
}

/** The element whose block the text node lies in. */
function blockOf(text: Text): Node | null {
  let block = text.parentNode;
  while (block && !isBlockBoundary(block)) block = block.parentNode;
  return block;
}

/** The shown text nearest to `from` inside `block`, in the given direction, or null. */
function neighbourText(from: Text, block: Node, forward: boolean): Text | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  walker.currentNode = from;
  for (let n = forward ? walker.nextNode() : walker.previousNode(); n; ) {
    if (isShownText(n as Text)) return n as Text;
    n = forward ? walker.nextNode() : walker.previousNode();
  }
  return null;
}

/** Whether range (edges on text) starts, or ends, where the shown text of its block does. */
function atBlockEdge(range: Range, end: boolean): boolean {
  const node = (end ? range.endContainer : range.startContainer) as Text;
  if (node.nodeType !== Node.TEXT_NODE) return false;
  const rest = end ? node.data.slice(range.endOffset) : node.data.slice(0, range.startOffset);
  if (/\S/.test(rest)) return false;
  const block = blockOf(node);
  if (!block) return false;
  const neighbour = neighbourText(node, block, end);
  return neighbour === null || blockOf(neighbour) !== block;
}

/** The generator's normalizeString (polyfill 6.7.0): what it compares and what it writes into an exact term. */
const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const joined = (a: string | undefined, b: string | undefined): string =>
  [a, b].filter((part) => part !== undefined && part !== "").join(" ");

/**
 * The generator widens a range to whole words before it writes the terms,
 * and it tells words apart by its own blocks: where two blocks by layout meet
 * without a blank between them ("Berlin" closing one span, "Bratwurst"
 * opening the next), the term comes out as "berlinbratwurst", which exists in
 * no block. The part beyond the range goes where a browser looks for it: into
 * the suffix (or, at the start, the prefix), which may lie in the next block.
 */
function withinBlocks(fragment: TextFragment, range: Range): TextFragment {
  const own = normalize(range.toString()).trim();
  const out: TextFragment = { ...fragment };

  const last = fragment.textEnd === undefined ? "textStart" : "textEnd";
  const endTerm = normalize(out[last] ?? "");
  if (atBlockEdge(range, true)) {
    let keep = endTerm.length;
    while (keep > 0 && !own.endsWith(endTerm.slice(0, keep))) keep--;
    if (keep > 0 && keep < endTerm.length) {
      out[last] = endTerm.slice(0, keep).trim();
      out.suffix = joined(endTerm.slice(keep).trim(), out.suffix);
    }
  }

  const startTerm = normalize(out.textStart);
  if (atBlockEdge(range, false)) {
    let keep = startTerm.length;
    while (keep > 0 && !own.startsWith(startTerm.slice(startTerm.length - keep))) keep--;
    if (keep > 0 && keep < startTerm.length) {
      out.textStart = startTerm.slice(startTerm.length - keep).trim();
      out.prefix = joined(out.prefix, startTerm.slice(0, startTerm.length - keep).trim());
    }
  }
  return out;
}

/** Whether the shown text of range (edges on text) lies in more than one block. */
function spansBlocks(range: Range): boolean {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: Node | null | undefined;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!range.intersectsNode(t) || !isShownText(t)) continue;
    const block = blockOf(t);
    if (first === undefined) first = block;
    else if (block !== first) return true;
  }
  return false;
}

const STATUS_NAMES = new Map<number, FragmentStatus>(
  Object.entries(GenerateFragmentStatus).map(([name, code]) => [code, name as FragmentStatus]),
);

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * Whether the generator can be handed range without freezing the tab. Its
 * search for a block ancestor (makeWalkerForNode, polyfill 6.7.0) climbs
 * parentNode until it meets a block element or an <html>, with no other exit
 * and no timeout check: in a shadow tree without a block element (the
 * overlay picks inside shadow roots, closed ones too) or under a root that
 * is not HTML's <html> (an SVG or XML document), parentNode runs out first
 * and the loop never ends. The generator searches the global document, so a
 * range anywhere else has nothing to point at anyway.
 */
function generatorCanHandle(range: Range): boolean {
  const root = document.documentElement;
  return (
    range.commonAncestorContainer.getRootNode() === document &&
    root?.namespaceURI === XHTML &&
    root.localName === "html"
  );
}

/**
 * A copy of range whose element-boundary edges are moved onto the first and
 * last rendered, non-blank text inside it; null if there is none. The
 * generator mishandles element edges (measured, polyfill 6.7.0):
 * selectNodeContents(p) yields a fragment for p's last word only, and
 * selectNode(p) one whose match runs on into the next paragraph.
 */
function onTextEdges(range: Range): Range | null {
  const root = range.commonAncestorContainer;
  const doc = root.ownerDocument;
  if (!doc) return null;
  const texts: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) {
    texts.push(root as Text);
  } else {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (
        range.intersectsNode(t) &&
        /\S/.test(t.data) &&
        t.parentElement?.checkVisibility({ visibilityProperty: true })
      ) {
        texts.push(t);
      }
    }
  }
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (!first || !last) return null;
  const out = range.cloneRange();
  if (out.startContainer.nodeType !== Node.TEXT_NODE) out.setStart(first, 0);
  if (out.endContainer.nodeType !== Node.TEXT_NODE) out.setEnd(last, last.length);
  return out.collapsed ? null : out;
}

/**
 * The sources whose text scrolls with the page, or all of them if none does.
 * A drag at the top of the viewport takes in a fixed or sticky header, which
 * comes first in the DOM: a link starting there would not scroll to the
 * selection at all, and a fixed banner at the end of the DOM (a cookie
 * dialog) would stretch the range over the whole page.
 */
export function anchorSources<T extends { node: Text }>(sources: readonly T[]): readonly T[] {
  const pinned = new Map<Element, boolean>();
  const isPinned = (el: Element | null): boolean => {
    if (!el) return false;
    let v = pinned.get(el);
    if (v === undefined) {
      const position = getComputedStyle(el).position;
      v = position === "fixed" || position === "sticky" || isPinned(el.parentElement);
      pinned.set(el, v);
    }
    return v;
  };
  const flowing = sources.filter((s) => !isPinned(s.node.parentElement));
  return flowing.length > 0 ? flowing : sources;
}

const isShownText = (t: Text): boolean =>
  /\S/.test(t.data) && !!t.parentElement?.checkVisibility({ visibilityProperty: true });

/**
 * The part of range (edges on text, as from onTextEdges) up to the end of
 * the block its start lies in, without the whitespace around it. Every
 * widening step of the generator re-checks uniqueness against the whole
 * document, and on a range over many blocks it widens the start and the end:
 * on a news front page (ga.de, 7,800 text nodes, 2026-10-01) a viewport-wide
 * drag took 1.2-1.4 s or timed out at 2 s, its first block 0.2 s. The link
 * still jumps to where the selection starts.
 */
function firstBlock(range: Range): Range {
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return range;
  const start = range.startContainer as Text;
  const block = blockOf(start);
  let end = start;
  let endOffset = start === range.endContainer ? range.endOffset : end.length;
  if (block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = start;
    // Inside block, a nested block element ends the run as much as block's own end.
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (isBlockBoundary(n) || range.comparePoint(n, 0) > 0) break;
      if (n.nodeType === Node.TEXT_NODE && isShownText(n as Text)) {
        end = n as Text;
        endOffset = n === range.endContainer ? range.endOffset : end.length;
      }
    }
  }
  // Blanks at the edges would end up in an exact-match fragment as %20.
  let startOffset = range.startOffset;
  while (startOffset < start.length && /\s/.test(start.data.charAt(startOffset))) startOffset++;
  while (endOffset > 0 && /\s/.test(end.data.charAt(endOffset - 1))) endOffset--;
  const out = range.cloneRange();
  out.setEnd(end, endOffset);
  out.setStart(start, startOffset);
  // Blank all through (only possible with start === end): leave it to the generator.
  return out.collapsed ? range : out;
}

const rangesEqual = (a: Range, b: Range): boolean =>
  a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
  a.compareBoundaryPoints(Range.END_TO_END, b) === 0;

type Generated = ReturnType<typeof generateFragmentFromRange>;

/** generateFragmentFromRange on a copy of range, within ms. */
function generate(range: Range, ms: number): Generated {
  setGenerationTimeout(Math.max(ms, 1));
  return generateFragmentFromRange(range.cloneRange());
}

/** The fragment URL for range on pageURL, or null with the generator's reason. */
export function textFragmentURL(
  range: Range,
  pageURL: string,
): { url: string | null; status: FragmentStatus } {
  if (!generatorCanHandle(range)) return { url: null, status: "INVALID_SELECTION" };
  try {
    // Copies, so the caller's range stays as given: the generator moves the
    // edges of the range it gets. A collapsed range has no passage to point
    // at (the generator would expand it to the word around it).
    const edges = onTextEdges(range);
    if (!edges) return { url: null, status: "INVALID_SELECTION" };
    const t0 = Date.now();
    const short = firstBlock(edges);
    let generated = short;
    let result = generate(short, GENERATION_TIMEOUT_MS);
    // A first block that occurs elsewhere too, context and all: the rest of
    // the range may set it apart, in what is left of the budget.
    if (result.status === GenerateFragmentStatus.AMBIGUOUS && !rangesEqual(short, edges)) {
      generated = edges;
      result = generate(edges, GENERATION_TIMEOUT_MS - (Date.now() - t0));
      // Without an end term the fragment is the range's text as one exact
      // match: over more than one block no browser finds it.
      if (result.fragment && !result.fragment.textEnd && spansBlocks(edges)) {
        return { url: null, status: "AMBIGUOUS" };
      }
    }
    const status = STATUS_NAMES.get(result.status) ?? "EXECUTION_FAILED";
    if (status !== "SUCCESS" || !result.fragment) {
      return { url: null, status: status === "SUCCESS" ? "EXECUTION_FAILED" : status };
    }
    const fragment = withinBlocks(result.fragment, generated);
    return { url: withTextDirective(pageURL, serializeTextDirective(fragment)), status };
  } catch {
    // encodeURIComponent throws on lone surrogates in the page text.
    return { url: null, status: "EXECUTION_FAILED" };
  }
}
