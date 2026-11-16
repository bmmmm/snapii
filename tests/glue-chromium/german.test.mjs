// SPDX-License-Identifier: GPL-3.0-or-later
// Checklist item C7h in the real Chromium: started with German as its UI
// language, the popup, the settings page, the toolbar button's tooltip, the
// commands, the overlay and the toast are the German catalogue's, and none of
// it reaches the saved file.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import de from "../../src/_locales/de/messages.json" with { type: "json" };
import en from "../../src/_locales/en/messages.json" with { type: "json" };
import { startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";

let g;
before(async () => {
  g = await startGlue(6, { lang: "de" });
});
after(async () => {
  await g?.close();
});

/** The catalogue's text for every key; a mismatch names the key. */
function assertGerman(texts) {
  assert.notDeepEqual(texts, {});
  for (const [key, text] of Object.entries(texts)) assert.equal(text, de[key].message, key);
}

test("German Chromium: the browser's UI language is German", async () => {
  assert.equal(await g.background(() => chrome.i18n.getUILanguage()), "de");
});

test("German Chromium: the popup is German, and so is the reason on a page it cannot capture", async () => {
  await g.open(PAGE);
  await g.openPopup();
  const state = await g.popupState();
  assert.equal(state.lang, "de");
  assertGerman(state.texts);
  assert.equal(state.texts.popupCapture, "Bereich aufnehmen");
  assert.equal(state.texts.popupAllSettings, "Alle Einstellungen…");
  assert.equal(state.status, "");

  await g.open("chrome://version/");
  await g.openPopup();
  const refused = await g.popupState();
  assert.equal(refused.captureDisabled, true);
  assert.match(refused.status, /^snapii kann diese Seite nicht aufnehmen: /);
});

test("German Chromium: the settings page is German, the folder rule and a refused folder too", async () => {
  await g.open(g.extensionUrl("options.html"));
  await g.until(
    () => g.content(`return document.getElementById("shortcut-input").value !== "";`),
    "the settings page's texts",
  );
  const page = await g.content(`
    return {
      lang: document.documentElement.lang,
      title: document.title,
      texts: Object.fromEntries(
        [...document.querySelectorAll("[data-i18n]")].map((el) => [el.dataset.i18n, el.textContent]),
      ),
      folderHint: document.getElementById("folder-hint").textContent,
    };
  `);
  assert.equal(page.lang, "de");
  assert.equal(page.title, "snapii-Einstellungen");
  // The read-only shortcut section has its own hint here (C11 in src/shared/spike.ts).
  const { optionsShortcutHint, ...texts } = page.texts;
  assertGerman(texts);
  assert.equal(optionsShortcutHint, de.optionsShortcutHintReadOnly.message);
  assert.equal(page.texts.optionsShortcutSettings, "In den Browser-Einstellungen ändern");
  assert.match(
    page.folderHint,
    /^Der Browser erlaubt Erweiterungen das Speichern nur innerhalb seines Download-Ordners, daher ist dies der Name eines Unterordners/,
  );

  const field = await g.rect("#folder");
  await g.click(field.x + 20, field.y + field.height / 2);
  await g.page.keyboard.type("../x");
  await g.key("Enter");
  const error = await g.until(
    () => g.content(`const e = document.getElementById("folder-error"); return e.hidden ? null : e.textContent;`),
    "the refusal",
  );
  assert.equal(
    error,
    "Nicht gespeichert: Ein Ordner darf kein „..“ enthalten (er läge sonst außerhalb des Download-Ordners).",
  );
});

test("German Chromium: the toolbar button's tooltip, the extension's description and the commands are German", async () => {
  const shown = await g.background(async () => ({
    title: await chrome.action.getTitle({}),
    description: chrome.runtime.getManifest().description,
    commands: Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.description])),
  }));
  assert.deepEqual(shown, {
    title: "snapii: Bereich als SVG aufnehmen",
    description: de.extensionDescription.message,
    // For the action's own command Chromium reports no description (measured on Chromium 153).
    commands: { "start-capture": "Bereich aufnehmen", _execute_action: "" },
  });
});

test("German Chromium: hint, toolbar and toast are German; the saved file has no word of the interface", async () => {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  assert.equal(await g.hint(), de.overlayHint.message);
  await g.click(130, 150);
  // Each button is its label followed by the key's badge.
  assert.deepEqual(
    await g.extension(`(() => {
      const root = browser.dom.openOrClosedShadowRoot(document.querySelector("snapii-overlay"));
      return [...root.querySelectorAll(".toolbar button")].map((b) => b.firstChild.textContent);
    })()`),
    ["SVG speichern", "Text kopieren", "Elementlink kopieren", "Seitenlink kopieren", "Abbrechen"],
  );
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.equal(await g.until(() => g.toast(), "the toast"), `${file.name} gespeichert`);
  assert.match(file.name, /^snapii snapii glue page \d{4}-\d\d-\d\d \d\d-\d\d-\d\d( ?\(\d+\))?\.svg$/);

  // The page is English: a German text in the file could only be the
  // interface's. Without the pictures, whose base64 holds any short word.
  const german = Object.keys(de)
    .filter((key) => de[key].message !== en[key].message && !de[key].placeholders)
    .map((key) => de[key].message)
    .filter((text) => text.length >= 5);
  assert.ok(german.includes("SVG speichern"));
  const markup = file.text.replace(/data:[^"]*/g, "");
  assert.deepEqual(
    german.filter((text) => markup.includes(text)),
    [],
  );
  assert.equal(markup.includes("gespeichert"), false);
});
