// SPDX-License-Identifier: GPL-3.0-or-later
// The version line at the bottom of the options page and the toolbar popup:
// tells builds apart when debugging (dist/build-info.json is written by
// scripts/build.mjs).

import { TARGET } from "./target.ts";

export interface BuildInfo {
  commit: string | null;
  dirty: boolean;
  builtAt: string;
}

/**
 * "snapii 0.1.0 · c26a3cd · built 2026-10-01 17:40 UTC · Firefox 157.0";
 * `browserLabel` is the browser's name and version, null when unknown.
 */
export function aboutLine(version: string, build: BuildInfo | null, browserLabel: string | null): string {
  const parts = [`snapii ${version}`];
  if (build?.commit) parts.push(build.dirty ? `${build.commit} (+ local changes)` : build.commit);
  if (build?.builtAt) parts.push(`built ${build.builtAt.slice(0, 16).replace("T", " ")} UTC`);
  if (browserLabel) parts.push(browserLabel);
  return parts.join(" · ");
}

/**
 * "Chromium 153" from a Chromium user agent's brand list (the brand the
 * browser gives itself, e.g. "Microsoft Edge"), else from its Chrome/ token.
 */
export function chromiumLabel(nav: {
  userAgent: string;
  userAgentData?: { brands: { brand: string; version: string }[] } | undefined;
}): string | null {
  const brands = nav.userAgentData?.brands.filter((b) => !/not.*brand/i.test(b.brand)) ?? [];
  const own = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
  if (own) return `${own.brand} ${own.version}`;
  const m = /Chrome\/([\d.]+)/.exec(nav.userAgent);
  return m ? `Chromium ${m[1]}` : null;
}

/** Reads version, build info and browser version and writes the line into `el`. */
export async function showAbout(el: HTMLElement): Promise<void> {
  const version = browser.runtime.getManifest().version;
  let build: BuildInfo | null = null;
  try {
    build = (await (await fetch(browser.runtime.getURL("build-info.json"))).json()) as BuildInfo;
  } catch {
    // A build without the file (or a broken one) still shows the version.
  }
  let label: string | null = null;
  if (TARGET === "chromium") label = chromiumLabel(navigator);
  else {
    try {
      label = `Firefox ${(await browser.runtime.getBrowserInfo()).version}`;
    } catch {
      // The version line is for debugging only: better without the browser than none.
    }
  }
  el.textContent = aboutLine(version, build, label);
}
