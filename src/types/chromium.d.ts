// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium-only extension APIs the code uses, next to the Firefox typings
// that describe everything both browsers share.

declare namespace browser.offscreen {
  function createDocument(parameters: {
    url: string;
    reasons: Array<"WORKERS" | "CLIPBOARD">;
    justification: string;
  }): Promise<void>;
  function closeDocument(): Promise<void>;
}

declare namespace browser.dom {
  function openOrClosedShadowRoot(element: Element): ShadowRoot | null;
}
