// SPDX-License-Identifier: GPL-3.0-or-later
// Shadow trees as a content script sees them, closed ones included. Firefox
// gives content scripts openOrClosed* properties on the nodes; Chromium has
// the extension API dom.openOrClosedShadowRoot and nothing for the assigned
// slot (C12 in src/shared/spike.ts). Page context (the layout harness) has
// neither and sees open roots only.

type GeckoElement = Element & { openOrClosedShadowRoot?: ShadowRoot | null };
type GeckoSlottable = (Element | Text) & { openOrClosedAssignedSlot?: HTMLSlotElement | null };

export function shadowRootOf(el: Element): ShadowRoot | null {
  const gecko = (el as GeckoElement).openOrClosedShadowRoot;
  if (gecko !== undefined) return gecko;
  if (el.shadowRoot) return el.shadowRoot;
  // Page context has no `browser`, Firefox's has no `dom`.
  const dom = typeof browser === "undefined" ? undefined : (browser.dom as typeof browser.dom | undefined);
  if (!dom) return null;
  try {
    return dom.openOrClosedShadowRoot(el);
  } catch {
    // The API takes HTML elements only; an SVG element has no shadow root anyway.
    return null;
  }
}

/** The slot `node` is assigned to, also inside a closed tree. */
export function assignedSlotOf(node: Node): HTMLSlotElement | null {
  const slottable = node as GeckoSlottable;
  if (slottable.openOrClosedAssignedSlot !== undefined) return slottable.openOrClosedAssignedSlot;
  if (slottable.assignedSlot) return slottable.assignedSlot;
  // assignedSlot is null for a closed tree: there the slots are asked instead.
  const host = node.parentNode;
  if (host?.nodeType !== 1) return null;
  const root = shadowRootOf(host as Element);
  if (root?.mode !== "closed") return null;
  for (const candidate of root.querySelectorAll("slot")) {
    if (candidate.assignedNodes().includes(node)) return candidate;
  }
  return null;
}
