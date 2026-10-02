// SPDX-License-Identifier: GPL-3.0-or-later
// The selected DOM as a detached copy that holds only what the capture shows:
// the input of "Copy text"'s clean HTML. Hidden, clipped or out-of-rect text
// is exactly the text the collector produced no run for.

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
 * range.cloneContents() minus every text node whose original is not in keep
 * (the run sources). Whitespace-only text stays regardless: the collector
 * never makes runs for it, but between inline elements it is the space
 * between two words.
 */
export function cloneVisibleRange(range: Range, keep: ReadonlySet<Text>): DocumentFragment {
  const fragment = range.cloneContents();
  const originals = textNodesIn(range);
  const clones = textNodesOf(fragment);
  // cloneContents copies every text node the range intersects, partial ends
  // included (even when empty), in document order; the two lists pair up.
  if (originals.length !== clones.length) {
    throw new Error(`cloneVisibleRange: ${originals.length} text nodes in range, ${clones.length} cloned`);
  }
  for (const [i, clone] of clones.entries()) {
    const original = originals[i] as Text;
    if (!keep.has(original) && clone.data.trim() !== "") clone.remove();
  }
  return fragment;
}
