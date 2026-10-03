// SPDX-License-Identifier: GPL-3.0-or-later
// The background both browsers share: the toolbar popup's "Capture region" (a
// `start-capture` message) or the keyboard shortcut (Alt+Shift+S) injects the
// content script into the tab and starts a capture session there; the content
// script's `save` message comes back here to be captured, rendered and
// downloaded. Called at the top level of each entry so the listeners wake the
// event page or the service worker.

import { routeMessage } from "../shared/messages.ts";
import { CAPTURE_COMMAND } from "../shared/shortcut.ts";
import { rasterTextRenderer } from "../shared/svg/build.ts";
import { flagTab } from "./flag.ts";
import type { BrowserPlatform } from "./platform.ts";
import { type SaveDeps, save } from "./save.ts";
import { loadSettings } from "./settings.ts";
import { startCapture } from "./start.ts";

export function startBackground(platform: BrowserPlatform): void {
  const POPUP_URL = browser.runtime.getURL("popup.html");

  const saveDeps: SaveDeps = {
    loadSettings,
    captureRegion: platform.captureRegion,
    tellTab: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
    recognize: platform.recognize,
    render: rasterTextRenderer,
    saveSvg: platform.saveSvg,
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
    if (message.type === "copy") return platform.copyToClipboard(message.plain, message.html);
    return save(message.model, sender.tab, saveDeps);
  });

  // The shortcut starts a capture at once, without the popup. Keyboard
  // shortcuts of the extension's commands grant activeTab like a toolbar click
  // (measured on Firefox 157, tests/glue/popup.test.mjs). There is no popup to
  // say why a page is refused, so the toolbar button does. Last and guarded:
  // Firefox for Android has no commands API, and a throw here must not cost
  // the listeners above (tests/unit/background.test.ts).
  browser.commands?.onCommand.addListener(async (command, tab) => {
    if (command !== CAPTURE_COMMAND || tab?.id === undefined) return;
    const started = await startCapture(tab.id);
    if (!started.ok) await flagTab(platform.action, tab.id, started.reason).catch(() => {});
  });
}
