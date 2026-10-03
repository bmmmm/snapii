// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium's service worker: the shared background (background.ts) on the
// Chromium platform. The worker keeps no state of its own between events;
// what it cannot do itself (C1 in src/shared/spike.ts) the offscreen document does.

import { startBackground } from "../background.ts";
import { captureRegion } from "./capture.ts";
import { saveSvg } from "./download.ts";
import { recognizeInOffscreen } from "./ocr.ts";
import { offscreen } from "./offscreen.ts";

const defaultTitle = browser.runtime.getManifest().action?.default_title ?? "";

startBackground({
  captureRegion,
  recognize: (areas, tiles, runs) => recognizeInOffscreen(areas, tiles, runs, offscreen.ask),
  saveSvg,
  copyToClipboard: async (plain, html) => {
    await offscreen.ask({ to: "offscreen", type: "copy", plain, html });
    return true;
  },
  action: {
    setBadgeText: (details) => browser.action.setBadgeText(details),
    // Chromium rejects a null title (C13): the manifest's own is set again.
    setTitle: ({ tabId, title }) => browser.action.setTitle({ tabId, title: title ?? defaultTitle }),
  },
});
