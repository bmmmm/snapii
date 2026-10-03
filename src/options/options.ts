// SPDX-License-Identifier: GPL-3.0-or-later
// Settings form: shows what the background will use (loadSettings applies the
// same validation) and stores each change at once in storage.sync.
// maxTotalPixels/maxTilePixels stay internal and are never written here.
// The keyboard shortcut section at the end goes through browser.commands.

import { isValidSetting, loadSettings } from "../background/settings.ts";
import { showAbout } from "../shared/about.ts";
import { checkFolder, describeFolderProblem, insideDownloads } from "../shared/folder.ts";
import {
  CAPTURE_COMMAND,
  describeProblem,
  formatShortcut,
  isModifierKey,
  keyEventToShortcut,
  type Platform,
  validateShortcut,
} from "../shared/shortcut.ts";
import { TARGET } from "../shared/target.ts";
import type { Settings } from "../shared/types.ts";

type FormKey = "format" | "jpegQuality" | "saveAs" | "saveFolder" | "occlusionCheck" | "textFragment" | "ocr";
const FORM_KEYS: FormKey[] = [
  "format",
  "jpegQuality",
  "saveAs",
  "saveFolder",
  "occlusionCheck",
  "textFragment",
  "ocr",
];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`options.html has no #${id}`);
  return el as T;
}

const form = byId<HTMLFormElement>("settings");
const quality = byId<HTMLInputElement>("quality");
const qualityValue = byId<HTMLOutputElement>("quality-value");
const folder = byId<HTMLInputElement>("folder");
const folderError = byId<HTMLElement>("folder-error");
const status = byId<HTMLElement>("status");

const radios = (): HTMLInputElement[] => [...form.querySelectorAll<HTMLInputElement>('input[name="format"]')];
const checkbox = (name: FormKey): HTMLInputElement => {
  const el = form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`);
  if (!el) throw new Error(`options.html has no checkbox ${name}`);
  return el;
};

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, ms = 2000): void {
  clearTimeout(statusTimer);
  status.textContent = text;
  // An error stays until the next action; "Saved" is only a confirmation.
  if (ms > 0) statusTimer = setTimeout(() => (status.textContent = ""), ms);
}

/** Shows why the typed folder is refused next to the field (the field is described by it), or clears it. */
function folderProblem(text: string | null): void {
  folderError.textContent = text ?? "";
  folderError.hidden = text === null;
  if (text === null) folder.removeAttribute("aria-invalid");
  else folder.setAttribute("aria-invalid", "true");
}

/** The quality slider only matters for JPEG. */
function syncQualityEnabled(): void {
  quality.disabled = !radios().some((r) => r.checked && r.value === "jpeg");
}

function showQuality(): void {
  qualityValue.textContent = `${quality.value}%`;
}

function render(s: Settings): void {
  for (const r of radios()) r.checked = r.value === s.format;
  // The slider spans 0-100 %, every value isValidSetting accepts, so a stored
  // value always shows as the one the capture uses.
  quality.value = String(Math.round(s.jpegQuality * 100));
  showQuality();
  syncQualityEnabled();
  checkbox("saveAs").checked = s.saveAs;
  folder.value = s.saveFolder;
  folderProblem(null);
  checkbox("occlusionCheck").checked = s.occlusionCheck;
  checkbox("textFragment").checked = s.textFragment;
  checkbox("ocr").checked = s.ocr;
}

/** Writes only values the background would accept. */
async function save<K extends FormKey>(key: K, value: Settings[K]): Promise<void> {
  if (!isValidSetting(key, value)) {
    say("Not saved: invalid value", 0);
    return;
  }
  try {
    await browser.storage.sync.set({ [key]: value });
    say("Saved");
  } catch {
    say("Could not save", 0);
  }
}

form.addEventListener("change", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.name === "format") {
    syncQualityEnabled();
    if (el.checked && (el.value === "png" || el.value === "jpeg")) void save("format", el.value);
  } else if (el === quality) {
    showQuality();
    void save("jpegQuality", Number(quality.value) / 100);
  } else if (el === folder) {
    const check = checkFolder(folder.value);
    if (!check.ok) {
      folderProblem(`Not saved: ${describeFolderProblem(check.reason)}`);
      return;
    }
    // The storage change re-renders the field: the normalised path ("a\b/ c" -> "a/b/c"), no refusal.
    // Firefox fires it for an unchanged value too (tests/glue/options.test.mjs types the stored folder again).
    void save("saveFolder", check.folder);
  } else if (
    el.name === "saveAs" ||
    el.name === "occlusionCheck" ||
    el.name === "textFragment" ||
    el.name === "ocr"
  ) {
    void save(el.name, el.checked);
  }
});

// Enter in the folder field would submit the form, i.e. reload the page; the
// field commits through "change" instead, which Enter fires first.
form.addEventListener("submit", (event) => event.preventDefault());

// Dragging the slider updates the label live; the value is stored on release.
quality.addEventListener("input", showQuality);

byId("reset").addEventListener("click", async () => {
  try {
    // Removing (not writing the defaults) lets the defaults follow future versions.
    await browser.storage.sync.remove(FORM_KEYS);
    render(await loadSettings());
    say("Defaults restored");
  } catch {
    say("Could not reset", 0);
  }
});

// Keyboard shortcut. The browser keeps it (commands.update stores it in its own
// settings store), so it is read back from commands.getAll rather than cached.
const shortcutInput = byId<HTMLInputElement>("shortcut-input");
// Chromium-based browsers map the chrome: scheme to their own.
const SHORTCUT_SETTINGS_URL = "chrome://extensions/shortcuts";
const shortcutStatus = byId<HTMLElement>("shortcut-status");
let platform: Platform = "other";
let shortcut = "";
let shortcutBusy = false;

function sayShortcut(text: string): void {
  shortcutStatus.textContent = text;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function readShortcut(): Promise<void> {
  const commands = await browser.commands.getAll();
  shortcut = commands.find((c) => c.name === CAPTURE_COMMAND)?.shortcut ?? "";
  shortcutInput.value = formatShortcut(shortcut, platform);
}

async function changeShortcut(change: () => Promise<void>, done: () => string): Promise<void> {
  // Keys pressed while the browser is still storing the last one are dropped.
  shortcutBusy = true;
  try {
    await change();
    await readShortcut();
    sayShortcut(done());
  } catch (e) {
    // The browser's own message says why it refused (or what went wrong).
    sayShortcut(`Not saved: ${errorText(e)}`);
  } finally {
    shortcutBusy = false;
  }
}

const noModifier = (e: KeyboardEvent): boolean => !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey);

// The field is the recorder: whatever is pressed while it has the focus is the
// new shortcut. Everything but Tab is swallowed so the browser's own keys do not
// fire (the current shortcut would open the overlay).
shortcutInput.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !(e.altKey || e.ctrlKey || e.metaKey)) return; // keyboard users must get out
  e.preventDefault();
  if (isModifierKey(e.key) || shortcutBusy) return;
  if (e.key === "Escape" && noModifier(e)) {
    shortcutInput.blur();
    sayShortcut("");
    return;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && noModifier(e)) {
    void changeShortcut(
      () => browser.commands.update({ name: CAPTURE_COMMAND, shortcut: "" }),
      () => "Shortcut removed",
    );
    return;
  }
  const next = keyEventToShortcut(e, platform);
  if (next === null) {
    sayShortcut("This key cannot be used in a shortcut.");
    return;
  }
  const check = validateShortcut(next);
  if (!check.ok) {
    sayShortcut(`${formatShortcut(next, platform)}: ${describeProblem(check.reason, platform)}`);
    return;
  }
  void changeShortcut(
    () => browser.commands.update({ name: CAPTURE_COMMAND, shortcut: next }),
    () => `Shortcut saved: ${formatShortcut(shortcut, platform)}`,
  );
});

byId("shortcut-reset").addEventListener("click", () => {
  if (shortcutBusy) return;
  void changeShortcut(
    () => browser.commands.reset(CAPTURE_COMMAND),
    () => `Default restored: ${formatShortcut(shortcut, platform)}`,
  );
});

/**
 * Chromium keeps the shortcut in its own settings page and gives extensions
 * no way to change it (C11 in src/shared/spike.ts): the field only shows it.
 */
function showShortcutReadOnly(): void {
  byId("shortcut-reset").hidden = true;
  byId("shortcut-hint").textContent =
    "The browser keeps this shortcut. Change it on its shortcut settings page, then reopen this page.";
  const settings = byId("shortcut-settings");
  settings.hidden = false;
  settings.addEventListener("click", () => {
    browser.tabs
      .create({ url: SHORTCUT_SETTINGS_URL })
      .catch((e) => sayShortcut(`Could not open the browser's shortcut settings: ${errorText(e)}`));
  });
}

async function initShortcut(): Promise<void> {
  try {
    platform = (await browser.runtime.getPlatformInfo()).os === "mac" ? "mac" : "other";
    await readShortcut();
    if (typeof browser.commands.update === "function") shortcutInput.disabled = false;
    else showShortcutReadOnly();
  } catch (e) {
    sayShortcut(`Could not read the shortcut: ${errorText(e)}`);
  }
}

// IIFE bundle: no top-level await.
void loadSettings().then(render);
// The toolbar popup writes three of these values too; an open page follows.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") void loadSettings().then(render);
});
void initShortcut();
if (TARGET !== "firefox") {
  byId("folder-hint").textContent =
    `${insideDownloads()}, so this is a sub-folder name such as snapii or Pages/snapii; ` +
    "it is created when needed. Leave it empty for the Downloads folder itself.";
}
const about = document.getElementById("about");
if (about) void showAbout(about);
