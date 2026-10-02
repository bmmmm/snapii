// SPDX-License-Identifier: GPL-3.0-or-later
// "Copy text" / "Copy link": one clipboard item with text/plain and
// text/html. The content script writes directly where it can; on non-secure
// http pages navigator.clipboard is undefined there, so the background page
// (a secure context) writes instead (S12).
import type { ToBackground } from "../shared/types.ts";

export interface ClipboardData {
  plain: string;
  html: string;
}

/** What writeClipboard talks to; injectable so the fallback logic is testable. */
export interface ClipboardDeps {
  clipboard: Pick<Clipboard, "write"> | undefined;
  makeItem: (data: ClipboardData) => ClipboardItem;
  sendMessage: (message: ToBackground) => Promise<unknown>;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultDeps = (): ClipboardDeps => ({
  // undefined (not a throw) where the page is not a secure context.
  clipboard: navigator.clipboard,
  makeItem: ({ plain, html }) =>
    new ClipboardItem({
      "text/plain": new Blob([plain], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    }),
  sendMessage: (message) => browser.runtime.sendMessage(message),
});

/** Resolves once either side wrote; rejects only if both failed. */
export async function writeClipboard(
  data: ClipboardData,
  deps: ClipboardDeps = defaultDeps(),
): Promise<void> {
  let direct = "navigator.clipboard is unavailable";
  if (deps.clipboard) {
    try {
      await deps.clipboard.write([deps.makeItem(data)]);
      return;
    } catch (e) {
      direct = errorText(e);
    }
  }
  let fallback: string;
  try {
    const message: ToBackground = { type: "copy", plain: data.plain, html: data.html };
    // The background answers true; undefined means nobody handled the message.
    if ((await deps.sendMessage(message)) === true) return;
    fallback = "background did not confirm the write";
  } catch (e) {
    fallback = errorText(e);
  }
  throw new Error(`clipboard write failed: ${direct}; background: ${fallback}`);
}
