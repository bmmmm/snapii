// SPDX-License-Identifier: GPL-3.0-or-later
// The manifest each browser gets, derived from src/manifest.json (the Firefox
// one). Chromium runs the background as a service worker, needs the offscreen
// permission for what a service worker cannot do, takes raster icons only and
// refuses the Firefox default key of the capture command.

export type BuildTarget = "firefox" | "chromium";

type Manifest = Record<string, unknown>;

const CHROMIUM_ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

/** The oldest Chromium the facts in spike.ts were measured on. */
export const MINIMUM_CHROME_VERSION = "151";

/**
 * Chromium does not load an extension whose command default is Ctrl+Alt+<key>
 * (nor MacCtrl+Alt+<key> as the Mac one; measured on Chromium 151, the service
 * worker never starts), so it keeps the key the capture command had before
 * the Firefox default moved. The user can bind any key in chrome://extensions/shortcuts.
 */
const CHROMIUM_CAPTURE_KEY = { default: "Alt+Shift+S" };

export function manifestFor(target: BuildTarget, source: Manifest, version: string): Manifest {
  if (target === "firefox") return { ...source, version };
  const { browser_specific_settings: _gecko, ...shared } = source;
  const commands = source.commands as Record<string, Manifest>;
  return {
    ...shared,
    commands: {
      ...commands,
      "start-capture": { ...commands["start-capture"], suggested_key: CHROMIUM_CAPTURE_KEY },
    },
    version,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    icons: CHROMIUM_ICONS,
    action: { ...(source.action as Manifest), default_icon: CHROMIUM_ICONS },
    background: { service_worker: "background.js" },
    permissions: [...(source.permissions as string[]), "offscreen"],
  };
}
