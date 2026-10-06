// SPDX-License-Identifier: GPL-3.0-or-later
// The toolbar button's popup: start a capture in the tab the popup belongs to,
// four quick toggles and the save folder on the same storage.sync values as
// the options page, and the way to all settings. Opening the popup grants activeTab for that tab
// (measured, tests/glue/popup.test.mjs), so the probe below may run there and
// the background can inject the content script after the click.

import { isValidSetting, loadSettings } from "../background/settings.ts";
import { cannotRun } from "../background/start.ts";
import { showAbout } from "../shared/about.ts";
import { checkFolder, describeFolderProblem } from "../shared/folder.ts";
import { ariaShortcut, CAPTURE_COMMAND, formatShortcut } from "../shared/shortcut.ts";
import type { FromPopup, StartResult } from "../shared/types.ts";

type ToggleKey = "ocr" | "textFragment" | "removeTrackers" | "saveAs";
const TOGGLES: ToggleKey[] = ["ocr", "textFragment", "removeTrackers", "saveAs"];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup.html has no #${id}`);
  return el as T;
}

const capture = byId<HTMLButtonElement>("capture");
const status = byId<HTMLElement>("status");
const toggles = byId<HTMLFieldSetElement>("toggles");
const options = byId<HTMLButtonElement>("options");
const folder = byId<HTMLInputElement>("folder");
const folderError = byId<HTMLElement>("folder-error");

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Enter starts a capture right away, as with a menu; on a refused page the settings link is first. */
function focusFirst(): void {
  (capture.disabled ? options : capture).focus();
}
focusFirst();
// Firefox hands the popup window the focus once the panel is shown, and that
// leaves the body focused, not the button focused above (measured on Fx157).
window.addEventListener(
  "focus",
  () => {
    if (document.activeElement === document.body) focusFirst();
  },
  { once: true },
);

// The popup's own window is the browser window it hangs from.
const tabId: Promise<number | undefined> = browser.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => tab?.id);

/** The page cannot be captured: say why here, keep the rest of the popup usable. */
function refuse(reason: string): void {
  const hadFocus = document.activeElement === capture;
  capture.disabled = true;
  status.textContent = `snapii cannot capture this page: ${reason}`;
  // A disabled button drops the focus; keyboard users keep a place to be.
  if (hadFocus) focusFirst();
}

/**
 * The toggle or folder write in flight: a capture started right after one
 * must see it, since the background reads storage.sync when it starts.
 */
let pendingWrite: Promise<void> = Promise.resolve();

let starting = false;
capture.addEventListener("click", async () => {
  if (starting) return;
  starting = true;
  try {
    await pendingWrite;
    // A refused folder would be left out of this capture, and the popup closes before it can be read.
    if (folder.hasAttribute("aria-invalid")) return void folder.focus();
    const id = await tabId;
    if (id === undefined) return refuse("no active tab");
    // The background does the work: this popup is gone as soon as it closes.
    const message: FromPopup = { type: "start-capture", tabId: id };
    const reply = (await browser.runtime.sendMessage(message)) as StartResult | undefined;
    if (reply?.ok) window.close();
    else refuse(reply?.reason ?? "no answer from snapii's background page");
  } catch (e) {
    refuse(errorText(e));
  } finally {
    starting = false;
  }
});

/** Asks the page before any click, so a refused page shows a disabled button and the reason at once. */
async function probe(): Promise<void> {
  try {
    const id = await tabId;
    if (id === undefined) return refuse("no active tab");
    const reason = await cannotRun(id);
    if (reason !== null) refuse(reason);
  } catch (e) {
    refuse(errorText(e));
  } finally {
    capture.removeAttribute("aria-busy");
  }
}

async function showShortcut(): Promise<void> {
  try {
    const platform = (await browser.runtime.getPlatformInfo()).os === "mac" ? "mac" : "other";
    const command = (await browser.commands.getAll()).find((c) => c.name === CAPTURE_COMMAND);
    const shortcut = command?.shortcut ?? "";
    byId("capture-shortcut").textContent = formatShortcut(shortcut, platform);
    // The <kbd> glyphs are hidden from screen readers; this says it properly.
    if (shortcut !== "") capture.setAttribute("aria-keyshortcuts", ariaShortcut(shortcut, platform));
  } catch {
    // Without the hint the button still works.
  }
}

const checkbox = (key: ToggleKey): HTMLInputElement => {
  const el = toggles.querySelector<HTMLInputElement>(`input[name="${key}"]`);
  if (!el) throw new Error(`popup.html has no checkbox ${key}`);
  return el;
};

/** The folder as stored, to show again when a write fails. */
let storedFolder = "";

async function showToggles(): Promise<void> {
  const settings = await loadSettings();
  for (const key of TOGGLES) checkbox(key).checked = settings[key];
  // Vector output has no OCR (the options page says why).
  const vector = settings.output === "vector";
  checkbox("ocr").disabled = vector;
  checkbox("ocr").title = vector ? "Off for the Shapes and text output (see All settings)" : "";
  storedFolder = settings.saveFolder;
  folder.value = storedFolder;
  toggles.disabled = false;
}

function folderProblem(text: string | null): void {
  folderError.textContent = text ?? "";
  folderError.hidden = text === null;
  if (text === null) folder.removeAttribute("aria-invalid");
  else folder.setAttribute("aria-invalid", "true");
}

/** Stores the typed folder when it passes the same check the background applies; the field then shows the normalised path. */
async function commitFolder(): Promise<void> {
  const check = checkFolder(folder.value);
  if (!check.ok) return folderProblem(`Not saved: ${describeFolderProblem(check.reason)}`);
  folderProblem(null);
  folder.value = check.folder;
  const { folder: value } = check;
  const write = pendingWrite.then(async () => {
    try {
      await browser.storage.sync.set({ saveFolder: value });
      storedFolder = value;
    } catch {
      folder.value = storedFolder;
      folderProblem("Could not save the setting");
    }
  });
  pendingWrite = write;
  await write;
}

toggles.addEventListener("change", async (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el === folder) return void commitFolder();
  const key = TOGGLES.find((k) => k === el.name);
  // Writes only what the background would accept (loadSettings applies the same check).
  const value = el.checked;
  if (key === undefined || !isValidSetting(key, value)) return;
  const write = pendingWrite.then(async () => {
    try {
      await browser.storage.sync.set({ [key]: value });
    } catch {
      // The checkbox shows what the next capture uses: the stored value.
      el.checked = !value;
      status.textContent = "Could not save the setting";
    }
  });
  pendingWrite = write;
  await write;
});

options.addEventListener("click", async () => {
  try {
    await browser.runtime.openOptionsPage();
    window.close();
  } catch (e) {
    status.textContent = `Could not open the settings: ${errorText(e)}`;
  }
});

// IIFE bundle: no top-level await.
void probe();
void showShortcut();
void showToggles();
void showAbout(byId("about"));
