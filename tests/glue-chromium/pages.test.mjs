// SPDX-License-Identifier: GPL-3.0-or-later
// The toolbar popup and the options page in Chromium: a page extensions may
// not touch is refused with the reason, the shortcut is shown but changed in
// the browser's own settings (C11 in src/shared/spike.ts), and the folder
// rules are the ones Chromium's download API really applies.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { checkFolder } from "../../src/shared/folder.ts";
import { startGlue } from "./env.mjs";

// What commands.getAll() reports for the default binding: Chromium on macOS
// gives the key in its symbol form.
const SHORTCUT = process.platform === "darwin" ? "⇧⌘E" : "Alt+Shift+S";

let g;
before(async () => {
  g = await startGlue(3);
});
after(async () => {
  await g?.close();
});

test("popup on a web page: the capture button is ready, with the bound shortcut and this browser in the version line", async () => {
  await g.open("/glue/fixtures/page.html");
  await g.openPopup();
  const state = await g.popupState();
  assert.equal(state.captureDisabled, false);
  assert.equal(state.status, "");
  assert.equal(state.shortcut, SHORTCUT);
  assert.match(state.about, /^snapii \d+\.\d+\.\d+ · .* · Chromium \d+$/);
});

test("popup with vector output: the OCR toggle is off (that mode has no OCR)", async () => {
  await g.setSettings({ output: "vector" });
  try {
    await g.open("/glue/fixtures/page.html");
    await g.openPopup();
    await g.until(async () => (await g.popupState()).ocrDisabled === true, "the OCR toggle to be disabled");
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
  await g.openPopup();
  assert.equal((await g.popupState()).ocrDisabled, false);
});

test("popup on a browser page: the button is disabled and the popup says why", async () => {
  await g.open("chrome://version/");
  await g.openPopup();
  const state = await g.popupState();
  assert.equal(state.captureDisabled, true);
  assert.equal(state.status, "snapii cannot capture this page: Cannot access a chrome:// URL");
});

test("options page: the shortcut is shown read-only with the way to the browser's shortcut settings", async () => {
  await g.open(g.extensionUrl("options.html"));
  await g.until(
    async () => (await g.content(`return document.getElementById("shortcut-input").value;`)) !== "",
    "the shortcut",
  );
  const shown = await g.content(`
    const el = (id) => document.getElementById(id);
    return {
      value: el("shortcut-input").value,
      disabled: el("shortcut-input").disabled,
      resetHidden: el("shortcut-reset").hidden,
      settingsHidden: el("shortcut-settings").hidden,
      folderHint: el("folder-hint").textContent.trim().replace(/\\s+/g, " "),
      about: el("about").textContent,
    };
  `);
  assert.deepEqual(
    { value: shown.value, disabled: shown.disabled, reset: shown.resetHidden, settings: shown.settingsHidden },
    { value: SHORTCUT, disabled: true, reset: true, settings: false },
  );
  assert.match(shown.folderHint, /^The browser lets extensions save only inside its Downloads folder, so this is/);
  assert.match(shown.about, /Chromium \d+$/);
  const opened = g.context.waitForEvent("page");
  // The page is taller than the viewport: the click goes to where the button is on screen.
  await g.content(`document.getElementById("shortcut-settings").scrollIntoView({ block: "center" });`);
  const button = await g.rect("#shortcut-settings");
  await g.click(button.x + button.width / 2, button.y + button.height / 2);
  const page = await opened;
  await page.waitForURL("chrome://extensions/shortcuts");
  await page.close();
});

test("options page: a folder name Chromium reserves is refused with the reason", async () => {
  await g.open(g.extensionUrl("options.html"));
  const field = await g.rect("#folder");
  await g.click(field.x + 20, field.y + field.height / 2);
  await g.page.keyboard.type("Pages/CON");
  await g.key("Enter");
  const error = await g.until(
    () => g.content(`const e = document.getElementById("folder-error"); return e.hidden ? null : e.textContent;`),
    "the folder error",
  );
  assert.match(error, /reserved by the browser/);
  assert.deepEqual(await g.background(() => chrome.storage.sync.get("saveFolder")), {});
});

test("the folder rules are Chromium's: checkFolder accepts exactly what downloads.download takes", async () => {
  const names = [
    "snapii",
    "Pages/snapii",
    "a b",
    "ünï",
    "a~b",
    "console",
    "com0",
    "a.lnk.x",
    "~a",
    "a~",
    "CON",
    "nul.txt",
    "com1",
    "LPT9",
    "clock$",
    "x.lnk",
    "a.local",
    "a.scf",
    "a.url",
    "desktop.ini",
    "thumbs.db",
    "a.{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}",
    ".hidden",
    "a.",
    "a:b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "a<b",
  ];
  const taken = await g.background(async (names) => {
    const out = {};
    for (const name of names) {
      try {
        await chrome.downloads.download({ url: "data:text/plain,x", filename: `${name}/f.txt`, saveAs: false });
        out[name] = true;
      } catch {
        out[name] = false;
      }
    }
    return out;
  }, names);
  for (const name of names) {
    assert.equal(checkFolder(name, "chromium").ok, taken[name], `${name}: download ${taken[name] ? "took" : "refused"} it`);
  }
});
