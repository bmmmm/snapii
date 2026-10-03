// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium's offscreen document: what the service worker cannot do (C1 in
// src/shared/spike.ts). Text recognition, since only a document can start
// the Tesseract worker, and the clipboard write for pages without a secure
// origin. Created per request by src/background/chromium/offscreen.ts.

import { recognizeAreas } from "../background/ocr.ts";
import { isOffscreenRequest } from "../shared/offscreen.ts";

/**
 * navigator.clipboard.write rejects here ("Document is not focused.", C10);
 * the copy command asks for no focus. Its copy event carries both flavours.
 */
function copy(plain: string, html: string): true {
  const onCopy = (e: ClipboardEvent): void => {
    e.clipboardData?.setData("text/plain", plain);
    e.clipboardData?.setData("text/html", html);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    if (!document.execCommand("copy")) throw new Error("the copy command was refused");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
  return true;
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isOffscreenRequest(message, sender)) return undefined;
  if (message.type === "copy") return Promise.resolve().then(() => copy(message.plain, message.html));
  return recognizeAreas(message.areas, message.tiles, message.runs);
});
