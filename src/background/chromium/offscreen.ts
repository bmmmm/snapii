// SPDX-License-Identifier: GPL-3.0-or-later
// The service worker's side of the offscreen document: created for a request,
// shared by requests in flight, closed after the last one. Chromium allows
// one such document per extension; one left behind by a worker that was shut
// down mid-request is taken over.

import type { OffscreenRequest } from "../../shared/offscreen.ts";

/** The browser calls the client needs; parameters so unit tests run without `browser`. */
export interface OffscreenDeps {
  /** Rejects when the document already exists. */
  create(): Promise<void>;
  close(): Promise<void>;
  send(request: OffscreenRequest): Promise<unknown>;
}

export interface OffscreenClient {
  ask(request: OffscreenRequest): Promise<unknown>;
}

export function createOffscreenClient(deps: OffscreenDeps): OffscreenClient {
  let users = 0;
  let ready: Promise<void> | null = null;
  let closing: Promise<void> = Promise.resolve();
  return {
    async ask(request) {
      users++;
      // After a close still under way, or the new document would go with it.
      ready ??= closing.then(() => deps.create()).catch(() => {});
      try {
        await ready;
        const answer = await deps.send(request);
        if (answer === undefined) throw new Error("the offscreen document did not answer");
        return answer;
      } finally {
        users--;
        if (users === 0) {
          ready = null;
          closing = deps.close().catch(() => {});
          await closing;
        }
      }
    },
  };
}

export const offscreen = createOffscreenClient({
  create: () =>
    browser.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "CLIPBOARD"],
      justification: "Text recognition runs in a Web Worker; copying text needs a document.",
    }),
  close: () => browser.offscreen.closeDocument(),
  send: (request) => browser.runtime.sendMessage(request),
});
