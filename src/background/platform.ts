// SPDX-License-Identifier: GPL-3.0-or-later
// What differs between the browsers' background contexts: the Firefox event
// page (main.ts) and the Chromium service worker (chromium/main.ts) each fill
// this in, background.ts wires it to the listeners both share.
import type { FlagDeps } from "./flag.ts";
import type { SaveDeps } from "./save.ts";

export interface Platform {
  captureRegion: SaveDeps["captureRegion"];
  recognize: SaveDeps["recognize"];
  saveSvg: SaveDeps["saveSvg"];
  /** Clipboard write for a page without a secure origin; resolves true once written. */
  copyToClipboard(plain: string, html: string): Promise<true>;
  action: FlagDeps;
}
