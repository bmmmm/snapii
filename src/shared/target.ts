// SPDX-License-Identifier: GPL-3.0-or-later
// Which browser this bundle was built for. scripts/build.mjs replaces
// SNAPII_TARGET; code that runs unbundled (the unit tests) or in the layout
// harness sees none and gets the Firefox behaviour.

import type { BuildTarget } from "./manifest.ts";

declare const SNAPII_TARGET: BuildTarget | undefined;

export const TARGET: BuildTarget = typeof SNAPII_TARGET === "string" ? SNAPII_TARGET : "firefox";

/** Chromium saves only what is visible (captureVisibleTab takes nothing else there). */
export const VIEWPORT_ONLY = TARGET === "chromium";

/** How a message names the browser and what it calls its extensions. */
export const browserWords = (target: BuildTarget = TARGET): { browser: string; extensions: string } =>
  target === "firefox"
    ? { browser: "Firefox", extensions: "add-ons" }
    : { browser: "The browser", extensions: "extensions" };
