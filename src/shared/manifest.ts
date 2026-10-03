// SPDX-License-Identifier: GPL-3.0-or-later
// The manifest each browser gets, derived from src/manifest.json (the Firefox
// one). Chromium runs the background as a service worker, needs the offscreen
// permission for what a service worker cannot do and takes raster icons only.

export type BuildTarget = "firefox" | "chromium";

type Manifest = Record<string, unknown>;

const CHROMIUM_ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

/** The oldest Chromium the facts in spike.ts were measured on. */
const MINIMUM_CHROME_VERSION = "151";

export function manifestFor(target: BuildTarget, source: Manifest, version: string): Manifest {
  if (target === "firefox") return { ...source, version };
  const { browser_specific_settings: _gecko, ...shared } = source;
  return {
    ...shared,
    version,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    icons: CHROMIUM_ICONS,
    action: { ...(source.action as Manifest), default_icon: CHROMIUM_ICONS },
    background: { service_worker: "background.js" },
    permissions: [...(source.permissions as string[]), "offscreen"],
  };
}
