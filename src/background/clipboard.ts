// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard writes on behalf of the content script. On non-secure http pages
// the content script has no navigator.clipboard at all; the background page
// is a secure context and, with clipboardWrite, needs no user gesture (S12).

/** Writes one item with both flavours; resolves true so the sender can tell success from "no listener". */
export async function copyToClipboard(plain: string, html: string): Promise<true> {
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([plain], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    }),
  ]);
  return true;
}
