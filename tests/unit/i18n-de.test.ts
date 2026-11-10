// SPDX-License-Identifier: GPL-3.0-or-later
// The German path: with an i18n API that serves _locales/de, the wording
// modules say it in German, values included. The stand-in is installed
// before the modules load, as the browser's API is there before an
// extension script runs (some wording is read once, at load).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Catalogue, installI18n } from "./i18n-stub.ts";

const de: Catalogue = JSON.parse(
  readFileSync(new URL("../../src/_locales/de/messages.json", import.meta.url), "utf8"),
);
installI18n(de);

const { msg, localizePage } = await import("../../src/shared/i18n.ts");
const { describeFolderProblem, insideDownloads } = await import("../../src/shared/folder.ts");
const { describeProblem, formatShortcut } = await import("../../src/shared/shortcut.ts");
const { flagTab } = await import("../../src/background/flag.ts");
const { cannotRun } = await import("../../src/background/start.ts");

test("i18n de: a message comes from the API, its values filled in", () => {
  assert.equal(msg("toolbarSave"), "SVG speichern");
  assert.equal(msg("toastSaved", "Beispiel.svg"), "Beispiel.svg gespeichert");
  assert.equal(msg("shortcutRefused", "Umschalt+S", "Grund"), "Umschalt+S: Grund");
});

test("i18n de: the folder rules name the browser of each build", () => {
  assert.equal(
    insideDownloads("firefox"),
    "Firefox erlaubt Add-ons das Speichern nur innerhalb seines Download-Ordners",
  );
  assert.equal(
    describeFolderProblem("absolute", "chromium"),
    "Der Browser erlaubt Erweiterungen das Speichern nur innerhalb seines Download-Ordners, daher kein vollständiger Pfad. Einen Namen wie snapii oder Seiten/snapii verwenden.",
  );
  assert.equal(describeFolderProblem("too-long"), "Höchstens 80 Zeichen verwenden.");
  assert.equal(
    describeFolderProblem("dot"),
    "Ein Ordnername darf nicht mit einem Punkt beginnen oder enden.",
  );
});

test("i18n de: shortcut problems and key names as the browser shows them in German", () => {
  assert.equal(
    describeProblem("modifier-required", "other"),
    "Strg oder Alt hinzunehmen (Umschalt allein genügt nicht); nur Funktionstasten funktionieren ohne Zusatztaste.",
  );
  assert.match(describeProblem("modifier-required", "mac"), /^Befehlstaste, Wahltaste oder Control/);
  assert.equal(formatShortcut("Ctrl+Shift+Delete", "other"), "Strg+Umschalt+Entf");
  assert.equal(formatShortcut("Alt+PageUp", "other"), "Alt+Bild auf");
  assert.equal(formatShortcut("Command+Up", "other"), "Strg+Pfeil nach oben");
  // macOS shows glyphs in every language; a name the browser gave in German passes through.
  assert.equal(formatShortcut("Alt+Shift+S", "mac"), "⌥⇧S");
  assert.equal(formatShortcut("Strg+Umschalt+S", "other"), "Strg+Umschalt+S");
});

test("i18n de: why snapii cannot run in a tab", async () => {
  const answers: unknown[][] = [[null], [{ result: false }]];
  (globalThis as { browser: Record<string, unknown> }).browser.scripting = {
    executeScript: async () => answers.shift(),
  };
  assert.equal(await cannotRun(1), "Firefox lässt auf dieser Seite keine Erweiterungen zu");
  assert.equal(await cannotRun(1), "snapii funktioniert nur auf HTML-Seiten");
});

test("i18n de: the toolbar button's notice", async () => {
  const titles: (string | null)[] = [];
  await flagTab(
    { setTitle: async ({ title }) => void titles.push(title), setBadgeText: async () => {} },
    1,
    msg("htmlOnly"),
    0,
  );
  assert.deepEqual(titles, [
    "snapii kann diese Seite nicht aufnehmen: snapii funktioniert nur auf HTML-Seiten",
  ]);
});

test("i18n de: a page's static text and its language", () => {
  const element = (data: Record<string, string>) => ({ dataset: data, textContent: "", placeholder: "" });
  const label = element({ i18n: "popupCapture" });
  const field = element({ i18nPlaceholder: "folderPlaceholder" });
  const doc = {
    documentElement: { lang: "" },
    querySelectorAll: (selector: string) =>
      selector === "[data-i18n]" ? [label] : selector === "[data-i18n-placeholder]" ? [field] : [],
  };
  localizePage(doc as unknown as Document);
  assert.equal(doc.documentElement.lang, "de");
  assert.equal(label.textContent, "Bereich aufnehmen");
  assert.equal(field.placeholder, "Download-Ordner selbst");
});
