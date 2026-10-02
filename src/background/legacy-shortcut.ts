// SPDX-License-Identifier: GPL-3.0-or-later
// Builds before the toolbar popup bound the capture shortcut to the toolbar
// action (`_execute_action`). Firefox keeps a key the user recorded there
// across updates, so after the update that key opened the popup instead of
// starting a capture (measured on Fx157: the stored key survives, the
// manifest default does not). Once, the first time this code runs, such a key
// moves to the capture command, unless the user chose a key for that one
// themselves, and the menu command is reset to unbound.

import { CAPTURE_COMMAND, MENU_COMMAND } from "../shared/shortcut.ts";

const DONE_KEY = "legacyShortcutMoved";

/** The platform calls the move needs; parameters so unit tests run without `browser`. */
export interface LegacyShortcutDeps {
  isDone(): Promise<boolean>;
  markDone(): Promise<void>;
  /** The key bound to the menu command, "" when none. */
  menuShortcut(): Promise<string>;
  /** The key bound to the capture command, "" when none. */
  captureShortcut(): Promise<string>;
  /** The capture command's key in the manifest: what it has until the user changes it. */
  readonly captureDefault: string;
  setCaptureShortcut(shortcut: string): Promise<void>;
  resetMenuShortcut(): Promise<void>;
}

const browserDeps = (): LegacyShortcutDeps => ({
  async isDone() {
    return (await browser.storage.local.get(DONE_KEY))[DONE_KEY] === true;
  },
  async markDone() {
    await browser.storage.local.set({ [DONE_KEY]: true });
  },
  async menuShortcut() {
    return (await browser.commands.getAll()).find((c) => c.name === MENU_COMMAND)?.shortcut ?? "";
  },
  async captureShortcut() {
    return (await browser.commands.getAll()).find((c) => c.name === CAPTURE_COMMAND)?.shortcut ?? "";
  },
  captureDefault: browser.runtime.getManifest().commands?.[CAPTURE_COMMAND]?.suggested_key?.default ?? "",
  async setCaptureShortcut(shortcut) {
    await browser.commands.update({ name: CAPTURE_COMMAND, shortcut });
  },
  async resetMenuShortcut() {
    await browser.commands.reset(MENU_COMMAND);
  },
});

/**
 * Resolves with whether the menu command had a key to take away. Rejects
 * without marking the work done when Firefox refuses a step, so the next start
 * of the event page tries again; the capture command is set first, so a failed
 * reset only repeats it.
 */
export async function moveLegacyShortcut(deps: LegacyShortcutDeps = browserDeps()): Promise<boolean> {
  if (await deps.isDone()) return false;
  const legacy = await deps.menuShortcut();
  if (legacy !== "") {
    // Only an unset or default capture key gives way: another one is the user's own choice.
    const current = await deps.captureShortcut();
    if (current === "" || current === deps.captureDefault) await deps.setCaptureShortcut(legacy);
    await deps.resetMenuShortcut();
  }
  await deps.markDone();
  return legacy !== "";
}
