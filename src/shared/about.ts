// SPDX-License-Identifier: GPL-3.0-or-later
// The version line at the bottom of the options page and the toolbar popup:
// tells builds apart when debugging (dist/build-info.json is written by
// scripts/build.mjs).

export interface BuildInfo {
  commit: string | null;
  dirty: boolean;
  builtAt: string;
}

/** "snapii 0.1.0 · c26a3cd · built 2026-10-01 17:40 UTC · Firefox 157.0" */
export function aboutLine(version: string, build: BuildInfo | null, firefox: string | null): string {
  const parts = [`snapii ${version}`];
  if (build?.commit) parts.push(build.dirty ? `${build.commit} (+ local changes)` : build.commit);
  if (build?.builtAt) parts.push(`built ${build.builtAt.slice(0, 16).replace("T", " ")} UTC`);
  if (firefox) parts.push(`Firefox ${firefox}`);
  return parts.join(" · ");
}

/** Reads version, build info and Firefox version and writes the line into `el`. */
export async function showAbout(el: HTMLElement): Promise<void> {
  const version = browser.runtime.getManifest().version;
  let build: BuildInfo | null = null;
  try {
    build = (await (await fetch(browser.runtime.getURL("build-info.json"))).json()) as BuildInfo;
  } catch {
    // A build without the file (or a broken one) still shows the version.
  }
  let firefox: string | null = null;
  try {
    firefox = (await browser.runtime.getBrowserInfo()).version;
  } catch {
    // Not available outside Firefox.
  }
  el.textContent = aboutLine(version, build, firefox);
}
