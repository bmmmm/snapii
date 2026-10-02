// SPDX-License-Identifier: GPL-3.0-or-later
// Event page: the toolbar popup's "Capture region" (a `start-capture`
// message) or the keyboard shortcut (Alt+Shift+S) injects the content script
// into the tab and starts a capture session there; the content script's
// `save` message comes back here to be captured, rendered and downloaded.
// Listeners are registered at top level so they wake the page.
import { routeMessage } from "../shared/messages.ts";
import { CAPTURE_COMMAND } from "../shared/shortcut.ts";
import { rasterTextRenderer } from "../shared/svg/build.ts";
import { captureRegion } from "./capture.ts";
import { copyToClipboard } from "./clipboard.ts";
import { onDownloadChanged, saveSvg } from "./download.ts";
import { moveLegacyShortcut } from "./legacy-shortcut.ts";
import { recognizeAreas } from "./ocr.ts";
import { type SaveDeps, save } from "./save.ts";
import { loadSettings } from "./settings.ts";
import { startCapture } from "./start.ts";

const ERROR_BADGE_MS = 3000;
const POPUP_URL = browser.runtime.getURL("popup.html");

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The shortcut on a page snapii cannot run on (about:, AMO, the PDF viewer,
 * view-source:, non-HTML documents): say so on the button for a moment
 * instead of failing silently. Tab-specific values, so null restores the
 * global ones.
 */
async function flagTab(tabId: number, reason: string): Promise<void> {
  await browser.action.setBadgeText({ tabId, text: "×" });
  await browser.action.setTitle({ tabId, title: `snapii cannot capture this page: ${reason}` });
  setTimeout(() => {
    // The tab may be gone by then; nothing to restore in that case.
    browser.action.setBadgeText({ tabId, text: null }).catch(() => {});
    browser.action.setTitle({ tabId, title: null }).catch(() => {});
  }, ERROR_BADGE_MS);
}

const saveDeps: SaveDeps = {
  loadSettings,
  captureRegion,
  tellTab: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
  recognize: (areas, tiles, runs) => recognizeAreas(areas, tiles, runs),
  render: rasterTextRenderer,
  saveSvg,
  extensionVersion: browser.runtime.getManifest().version,
};

browser.runtime.onMessage.addListener((raw: unknown, sender) => {
  const route = routeMessage(raw, sender, POPUP_URL);
  // Foreign or malformed messages are not ours to answer (a malformed save
  // is, see routeMessage); the page cannot steer the router.
  if (route.kind === "ignore") return undefined;
  if (route.kind === "reject") {
    console.warn(`snapii: save rejected: ${route.response.detail}`);
    return Promise.resolve(route.response);
  }
  // The popup waits for the reply: it closes on success and shows the reason otherwise.
  if (route.kind === "start") return startCapture(route.message.tabId);
  const { message } = route;
  if (message.type === "copy") return copyToClipboard(message.plain, message.html);
  return save(message.model, sender.tab, saveDeps);
});

browser.downloads.onChanged.addListener(onDownloadChanged);

// The shortcut starts a capture at once, without the popup. Keyboard
// shortcuts of the extension's commands grant activeTab like a toolbar click
// (measured on Firefox 157, tests/glue/popup.test.mjs). There is no popup to
// say why a page is refused, so the toolbar button does. Last and guarded:
// Firefox for Android has no commands API, and a throw here must not cost
// the listeners above (tests/unit/background.test.ts).
browser.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== CAPTURE_COMMAND || tab?.id === undefined) return;
  const started = await startCapture(tab.id);
  if (!started.ok) await flagTab(tab.id, started.reason).catch(() => {});
});

// A key recorded for the old toolbar-click binding would open the popup, not
// capture; asynchronous, so nothing here can cost the listeners above.
if (browser.commands) {
  moveLegacyShortcut().catch((e) => console.warn(`snapii: legacy shortcut not moved: ${errorText(e)}`));
}
