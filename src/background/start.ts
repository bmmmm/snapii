// SPDX-License-Identifier: GPL-3.0-or-later
// Starting a capture session in a tab: the probe whether snapii can run there
// at all, then the injection of the content script and its `start` message.
// Needs activeTab for the tab (the toolbar popup or the shortcut grants it).

import { browserWords } from "../shared/target.ts";
import type { StartResult, ToContent } from "../shared/types.ts";
import { loadSettings } from "./settings.ts";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const NO_ACCESS = `${browserWords().browser} does not let extensions run on this page`;

/**
 * Runs in the page. The overlay is HTML appended to the root element, and
 * HTML outside <foreignObject> is not rendered under an SVG or XML root
 * (measured): a session there would be an invisible overlay that swallows
 * every click and key. An XHTML root other than <html> renders the overlay,
 * but is no page snapii is made for (and the text-fragment generator would
 * loop forever under it, see content/fragment.ts).
 */
const hasHtmlRoot = (): boolean => {
  const root = document.documentElement;
  return root?.namespaceURI === "http://www.w3.org/1999/xhtml" && root.localName === "html";
};

/**
 * Why snapii cannot run in the tab, or null when it can. Injects only the
 * probe function, nothing that stays in the page, so the popup asks this when
 * it opens.
 */
export async function cannotRun(tabId: number): Promise<string | null> {
  try {
    // Pages the extension may not script (AMO, the PDF viewer, view-source:)
    // reject the injection.
    const [probe] = await browser.scripting.executeScript({
      target: { tabId },
      func: hasHtmlRoot,
    });
    // Firefox 157 resolves with [null] instead of rejecting on about:addons;
    // a start message there only fails with "Receiving end does not exist"
    // and an uncaught exception in Firefox's messaging code (measured).
    if (probe == null) return NO_ACCESS;
    if (probe.result === false) return "snapii works on HTML pages only";
    return null;
  } catch (e) {
    return errorText(e);
  }
}

/** Injects the content script and opens (or, if one is open, closes) the selection overlay. */
export async function startCapture(tabId: number): Promise<StartResult> {
  const reason = await cannotRun(tabId);
  if (reason !== null) return { ok: false, reason };
  try {
    const injected = await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    if (!injected.some((r) => r != null)) return { ok: false, reason: NO_ACCESS };
    const message: ToContent = { type: "start", settings: await loadSettings() };
    await browser.tabs.sendMessage(tabId, message);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errorText(e) };
  }
}
