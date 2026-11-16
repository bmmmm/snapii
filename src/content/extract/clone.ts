// SPDX-License-Identifier: GPL-3.0-or-later
// The selected DOM as a detached copy that holds only the characters "Copy
// text"'s runs were taken from: the input of its clean HTML. That is what
// the plain text holds — more than the capture shows where the region's edge
// cuts a word, which both take whole. Hidden, clipped or out-of-region text
// is exactly the text the collector produced no run for.
import type { TextRun } from "../../shared/types.ts";
import type { RunSource } from "./collect.ts";

/** Text nodes of the original that range touches, in document order. */
function textNodesIn(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const out: Text[] = [];
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  if (!walker) return out;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (range.intersectsNode(n)) out.push(n as Text);
  }
  return out;
}

function textNodesOf(fragment: DocumentFragment): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** A stretch of a cloned text node (`node`: its place in the range's text nodes), in document order. */
interface Piece {
  node: number;
  text: string;
  /** The run these characters made; null for the rest: left out, or white space, which stays. */
  run: Pick<TextRun, "block" | "line"> | null;
  space: boolean;
}

/**
 * range.cloneContents() cut down to the characters the runs came from
 * (`sources`, one for each of `runs`), so that the HTML says what the plain
 * text says: a text node that made no run goes, one that made some keeps
 * their characters only — a paragraph the capture shows a column of gives
 * that column's words, not the whole paragraph. White space alone stays
 * regardless: the collector never makes runs for it, but between inline
 * elements it is the space between two words.
 *
 * Where the plain text starts a new line within a block, the words left out
 * in between must not make one word of the two kept ones (<b>beta</b> gamma
 * <i>epsilon</i>): one of them leaves their line breaks behind if they had
 * any (preserved text stays in its lines), else one space where no white
 * space stands there anyway — the one highest in the tree, so the space
 * lands between two elements rather than inside a link. Text that is not
 * laid out (display: none) parts nothing, and neither does anything within a
 * line (the plain text has "foobar" there too), before the first kept
 * characters, after the last, or between two blocks, which are apart already.
 */
export function cloneVisibleRange(
  range: Range,
  sources: readonly RunSource[],
  runs: readonly Pick<TextRun, "block" | "line">[],
): DocumentFragment {
  const kept = new Map<Text, { start: number; end: number; run: Pick<TextRun, "block" | "line"> }[]>();
  for (const [i, s] of sources.entries()) {
    const run = runs[i];
    if (!run) continue;
    const part = { start: s.start, end: s.end, run };
    const parts = kept.get(s.node);
    // Not a new list for each: 40 000 runs of one text node took 3 s that way.
    if (parts) parts.push(part);
    else kept.set(s.node, [part]);
  }
  const fragment = range.cloneContents();
  const originals = textNodesIn(range);
  const clones = textNodesOf(fragment);
  // cloneContents copies every text node the range intersects, partial ends
  // included (even when empty), in document order; the two lists pair up.
  if (originals.length !== clones.length) {
    throw new Error(`cloneVisibleRange: ${originals.length} text nodes in range, ${clones.length} cloned`);
  }

  const pieces: Piece[] = [];
  for (const [node, original] of originals.entries()) {
    const { data } = original;
    // The clone holds the original's characters inside the range.
    let at = original === range.startContainer ? range.startOffset : 0;
    const to = original === range.endContainer ? range.endOffset : data.length;
    const rest = (end: number): void => {
      const text = data.slice(at, end);
      if (text) pieces.push({ node, text, run: null, space: !/\S/.test(text) });
    };
    for (const s of (kept.get(original) ?? []).sort((a, b) => a.start - b.start)) {
      const start = Math.max(s.start, at);
      const end = Math.min(s.end, to);
      if (end <= start) continue;
      rest(start);
      pieces.push({ node, text: data.slice(start, end), run: s.run, space: false });
      at = end;
    }
    rest(to);
  }

  const probe = range.cloneRange();
  /** A text node that made runs is laid out; one that made none may be display: none. */
  const laidOut = (p: Piece): boolean => {
    const original = originals[p.node] as Text;
    if (kept.has(original)) return true;
    probe.selectNodeContents(original);
    return probe.getClientRects().length > 0;
  };
  const depth = (p: Piece): number => {
    let n = 0;
    for (let a = clones[p.node]?.parentNode; a; a = a.parentNode) n++;
    return n;
  };
  let last: Piece | null = null;
  /** What stands between the last kept characters and the next. */
  let between: Piece[] = [];
  for (const p of pieces) {
    if (!p.run) {
      between.push(p);
      continue;
    }
    const out = between.filter((q) => !q.space);
    const parting =
      last?.run?.block === p.run.block && last.run.line !== p.run.line ? out.filter(laidOut) : [];
    // A run's characters may begin or end with a space its text has lost at the line's edge.
    const spaced = between.some((q) => q.space) || /^\s/.test(p.text) || /\s$/.test(last?.text ?? "");
    const breaks = parting
      .map((q) => q.text)
      .join("")
      .replace(/[^\n]/g, "");
    const holder =
      breaks || !spaced
        ? parting.reduce<Piece | null>((best, q) => (best && depth(best) <= depth(q) ? best : q), null)
        : null;
    for (const q of out) q.text = q === holder ? breaks || " " : "";
    last = p;
    between = [];
  }
  for (const q of between) if (!q.space) q.text = "";

  const texts = clones.map(() => "");
  for (const p of pieces) texts[p.node] += p.text;
  for (const [i, clone] of clones.entries()) {
    // Nothing of it is left: the node goes. White space alone was never touched.
    if (texts[i] === "" && clone.data !== "") clone.remove();
    else clone.data = texts[i] as string;
  }
  return fragment;
}
