// SPDX-License-Identifier: GPL-3.0-or-later
// Checklist item 17 in the real Firefox: started with German as its UI
// language (intl.locale.requested), the popup, the settings page, the toolbar
// button's tooltip, the commands, the overlay and the toast are the German
// catalogue's, and none of it reaches the saved file.
//
// The language has to be in the Firefox that runs: a German build, or one
// with the German language pack. The harness cannot add it (a language pack
// is a download for exactly this Firefox version), so with a Firefox that
// has no German these tests are skipped and say so.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import de from "../../src/_locales/de/messages.json" with { type: "json" };
import en from "../../src/_locales/en/messages.json" with { type: "json" };
import { ADDON_ID, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";

let g;
let mac;
let optionsUrl;
/** Why the tests cannot run here, or "" if this Firefox has German. */
let noGerman = "";
before(async () => {
  g = await startGlue(9, { prefs: { "intl.locale.requested": "de" } });
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
  mac = (await g.s.chrome("return AppConstants.platform;")) === "macosx";
  const available = await g.s.chrome("return Services.locale.availableLocales;");
  if (!available.includes("de")) noGerman = `this Firefox has no German interface, only ${available.join(", ")}`;
});
after(async () => {
  await g?.close();
});

/** The catalogue's text for every key; a mismatch names the key. */
function assertGerman(texts) {
  assert.notDeepEqual(texts, {});
  for (const [key, text] of Object.entries(texts)) assert.equal(text, de[key].message, key);
}

/** What the extension's own APIs answer, read in its options page (the system sandbox reaches its `browser`). */
const fromExtension = () =>
  g.inNewTab(optionsUrl, async () =>
    JSON.parse(
      await g.system(
        `const page = window.wrappedJSObject;
        return (async () =>
          JSON.stringify({
            title: await page.browser.action.getTitle(page.JSON.parse("{}")),
            description: page.browser.runtime.getManifest().description,
            commands: Object.fromEntries(
              [...(await page.browser.commands.getAll())].map((c) => [c.name, c.description]),
            ),
          }))();`,
      ),
    ),
  );

test("German Firefox: the browser's UI language is German", async (t) => {
  if (noGerman) return t.skip(noGerman);
  assert.equal(await g.s.chrome("return Services.locale.appLocaleAsBCP47;"), "de");
});

test("German Firefox: the popup is German, with the shortcut in German key names", async (t) => {
  if (noGerman) return t.skip(noGerman);
  await g.open(PAGE);
  const state = await g.openPopup();
  try {
    assert.equal(state.capture.text, `Bereich aufnehmen ${mac ? "⇧⌘E" : "Strg+Alt+S"}`);
    assert.equal(state.status, "");
    const page = await g.s.inPopup((w) => {
      const d = w.document;
      return {
        lang: d.documentElement.lang,
        texts: Object.fromEntries([...d.querySelectorAll("[data-i18n]")].map((el) => [el.dataset.i18n, el.textContent])),
        placeholder: d.getElementById("folder").placeholder,
      };
    });
    assert.equal(page.lang, "de");
    assertGerman(page.texts);
    assert.equal(page.texts.popupAllSettings, "Alle Einstellungen…");
    assert.equal(page.placeholder, "Download-Ordner selbst");
  } finally {
    await g.s.triggerAction(ADDON_ID);
    await g.popupClosed();
  }
});

test("German Firefox: the settings page is German, the folder rule and a refused folder too", async (t) => {
  if (noGerman) return t.skip(noGerman);
  await g.open(optionsUrl);
  await g.until(
    () => g.content(`return document.getElementById("folder-hint").textContent !== "";`),
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
  assertGerman(page.texts);
  assert.equal(page.texts.optionsReset, "Auf Standardwerte zurücksetzen");
  assert.match(
    page.folderHint,
    /^Firefox erlaubt Add-ons das Speichern nur innerhalb seines Download-Ordners, daher ist dies der Name eines Unterordners/,
  );

  const field = await g.rect("#folder");
  await g.click(field.x + field.width / 2, field.y + field.height / 2);
  await g.s.perform([
    {
      type: "key",
      id: "keyboard",
      actions: [..."../x"].flatMap((value) => [
        { type: "keyDown", value },
        { type: "keyUp", value },
      ]),
    },
  ]);
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

test("German Firefox: the toolbar button's tooltip, the add-on's description and the commands are German", async (t) => {
  if (noGerman) return t.skip(noGerman);
  const shown = await fromExtension();
  assert.deepEqual(shown, {
    title: "snapii: Bereich als SVG aufnehmen",
    description: de.extensionDescription.message,
    commands: { "start-capture": "Bereich aufnehmen", _execute_action: "snapii-Menü öffnen" },
  });
});

test("German Firefox: hint, toolbar and toast are German; the saved file has no word of the interface", async (t) => {
  if (noGerman) return t.skip(noGerman);
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay("shortcut");
  const inOverlay = (body) =>
    g.system(`const root = document.querySelector("snapii-overlay").openOrClosedShadowRoot; ${body}`);
  assert.equal(await inOverlay(`return root.querySelector(".hint").textContent;`), de.overlayHint.message);
  await g.move(310, 290);
  await g.click(310, 290);
  // Each button is its label followed by the key's badge.
  assert.deepEqual(
    await inOverlay(
      `return [...root.querySelectorAll(".toolbar button")].map((b) => b.firstChild.textContent);`,
    ),
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
