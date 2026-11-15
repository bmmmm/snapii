// SPDX-License-Identifier: GPL-3.0-or-later
// The selected DOM as a detached copy that holds only what the capture shows:
// the input of "Copy text"'s clean HTML. Hidden, clipped or out-of-rect text
// is exactly the text the collector produced no run for.
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

/**
 * range.cloneContents() cut down to the characters the runs came from
 * (`sources`), so that the HTML says what the plain text says: a text node
 * that made no run goes, one that made some keeps their characters only — a
 * paragraph the capture shows a column of gives that column's words, not
 * the whole paragraph. Whitespace-only text stays regardless: the collector
 * never makes runs for it, but between inline elements it is the space
 * between two words.
 */
export function cloneVisibleRange(range: Range, sources: readonly RunSource[]): DocumentFragment {
  const kept = new Map<Text, RunSource[]>();
  for (const s of sources) kept.set(s.node, [...(kept.get(s.node) ?? []), s]);
  const fragment = range.cloneContents();
  const originals = textNodesIn(range);
  const clones = textNodesOf(fragment);
  // cloneContents copies every text node the range intersects, partial ends
  // included (even when empty), in document order; the two lists pair up.
  if (originals.length !== clones.length) {
    throw new Error(`cloneVisibleRange: ${originals.length} text nodes in range, ${clones.length} cloned`);
  }
  /**
   * What stands before the next kept characters for the words left out
   * since the last ones, to keep the two apart: their line breaks if they had
   * any (preserved text stays in its lines), else one space. Nothing before
   * the first kept characters, and nothing after the last.
   */
  let owed = "";
  let any = false;
  for (const [i, clone] of clones.entries()) {
    const original = originals[i] as Text;
    const mine = kept.get(original);
    if (!mine) {
      if (clone.data.trim() !== "") clone.remove();
      continue;
    }
    const { data } = original;
    let out = "";
    const leaveOut = (stretch: string): void => {
      // White space alone stays where it is.
      if (!/\S/.test(stretch)) out += stretch;
      else if (any) owed = (owed + stretch).replace(/[^\n]/g, "") || " ";
    };
    // The clone holds the original's characters inside the range.
    let at = original === range.startContainer ? range.startOffset : 0;
    const to = original === range.endContainer ? range.endOffset : data.length;
    for (const s of mine.sort((a, b) => a.start - b.start)) {
      const start = Math.max(s.start, at);
      const end = Math.min(s.end, to);
      if (end <= start) continue;
      leaveOut(data.slice(at, start));
      out += owed + data.slice(start, end);
      owed = "";
      any = true;
      at = end;
    }
    leaveOut(data.slice(at, to));
    clone.data = out;
  }
  return fragment;
}
