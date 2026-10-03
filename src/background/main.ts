// SPDX-License-Identifier: GPL-3.0-or-later
// Firefox's event page: the shared background (background.ts) on the Firefox
// platform. Listeners are registered at top level so they wake the page.

import { startBackground } from "./background.ts";
import { captureRegion } from "./capture.ts";
import { copyToClipboard } from "./clipboard.ts";
import { onDownloadChanged, saveSvg } from "./download.ts";
import { moveLegacyShortcut } from "./legacy-shortcut.ts";
import { recognizeAreas } from "./ocr.ts";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

browser.downloads.onChanged.addListener(onDownloadChanged);

startBackground({
  captureRegion,
  recognize: (areas, tiles, runs) => recognizeAreas(areas, tiles, runs),
  saveSvg,
  copyToClipboard,
  action: browser.action,
});

// A key recorded for the old toolbar-click binding would open the popup, not
// capture; asynchronous, so nothing here can cost the listeners above.
if (browser.commands) {
  moveLegacyShortcut().catch((e) => console.warn(`snapii: legacy shortcut not moved: ${errorText(e)}`));
}
