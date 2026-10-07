// SPDX-License-Identifier: GPL-3.0-or-later
// The toolbar button's popup (src/popup/) in the real panel, and the keyboard
// shortcut that starts a capture without it. The popup is a remote <browser>
// in a panel: its document is read through a frame script, clicks are real
// pointer actions in the browser window, keys go through the popup's own
// TextInputProcessor (tools/marionette/firefox.mjs). activeTab is read from
// Firefox's own bookkeeping and shown by what needs it (injection, capture).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { clearClipboard, readClipboard } from "../../tools/marionette/helpers.mjs";
import { ADDON_ID, sleep, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";

let g;
let mac;
let optionsUrl;
before(async () => {
  g = await startGlue(5);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
  mac = (await g.s.chrome("return AppConstants.platform;")) === "macosx";
});
after(async () => {
  await g?.close();
});
// A failed test must not leave its popup open: the next toolbar click would close it.
afterEach(async () => {
  if (g) await closePopup();
});

const display = (win, mc) => (mac ? mc : win);

/** storage.sync as the extension sees it, read in its options page (system sandbox reaches its `browser`). */
function stored() {
  return g.inNewTab(optionsUrl, async () =>
    JSON.parse(
      await g.system(
        "return (async () => JSON.stringify(await window.wrappedJSObject.browser.storage.sync.get(null)))();",
      ),
    ),
  );
}

/** The same, read by the open popup (opening a tab for it would close the popup). */
const storedInPopup = () =>
  g.s.inPopup(async (w) =>
    JSON.parse(w.wrappedJSObject.JSON.stringify(await w.wrappedJSObject.browser.storage.sync.get(null))),
  );

function clearStored() {
  return g.inNewTab(optionsUrl, () =>
    g.system("return (async () => { await window.wrappedJSObject.browser.storage.sync.clear(); })();"),
  );
}

/** Closes the popup the way a second toolbar click does, and waits until it is gone. */
async function closePopup() {
  if ((await g.s.popupCount()) === 0) return;
  await g.s.triggerAction(ADDON_ID);
  await g.popupClosed();
}

/**
 * Replaces the popup's storage.sync.set: `fail` rejects every write, otherwise
 * each write reaches storage `delayMs` late (a slow sync backend).
 */
function stubStorageSet({ fail = false, delayMs = 0 }) {
  return g.s.inPopup(
    (w, fail, delayMs) => {
      const page = w.wrappedJSObject;
      const sync = page.browser.storage.sync;
      const set = sync.set.bind(sync);
      const stub = (items) =>
        new page.Promise((resolve, reject) => {
          if (fail) return reject(new page.Error("stubbed failure"));
          w.setTimeout(() => set(items).then(resolve, reject), delayMs);
        });
      Components.utils.exportFunction(stub, sync, { defineAs: "set" });
      return true;
    },
    fail,
    delayMs,
  );
}

/** Firefox moves the focus into the panel a moment after it is shown (Extension:GrabFocus). */
const focusedInPopup = (id) =>
  g.until(async () => ((await g.popupState()).focused === id ? id : null), `#${id} to have the focus`);

/** Saves the card of the fixture page through the shortcut, element pick and Enter. */
async function saveCard() {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay("shortcut");
  await g.move(310, 290);
  await g.click(310, 290);
  await g.key("Enter");
  return g.newDownload(before);
}

/** Saves the card through the shortcut and waits for the file inside `dir` (relative to the download folder). */
async function saveCardInto(dir) {
  await g.open(PAGE);
  const topLevel = g.svgFiles();
  await g.startOverlay("shortcut");
  await g.move(310, 290);
  await g.click(310, 290);
  await g.key("Enter");
  await fileIn(dir, topLevel);
}

/** Waits for a finished .svg inside `dir`; nothing may have gone to the download folder itself (`topLevel` is its list from before). */
async function fileIn(dir, topLevel) {
  const target = join(g.downloads, dir);
  const name = await g.until(
    () => (existsSync(target) ? readdirSync(target).find((f) => f.endsWith(".svg")) : null),
    `a .svg in ${dir}`,
  );
  await g.until(
    () => readFileSync(join(target, name), "utf8").trimEnd().endsWith("</svg>"),
    `${name} to be complete`,
  );
  assert.deepEqual(g.svgFiles(), topLevel);
}

test("toolbar click on a never-clicked tab: popup with Capture region focused, the shortcut, toggles, version; activeTab granted", async () => {
  await g.inNewTab(`${g.base}${PAGE}`, async () => {
    assert.equal(await g.hasActiveTab(), false);
    const state = await g.openPopup();
    // Opening the popup is the user gesture: the page probe already ran on it.
    assert.equal(await g.hasActiveTab(), true);
    assert.equal(state.capture.disabled, false);
    assert.equal(state.status, "");
    assert.equal(state.shortcut, display("Ctrl+Alt+S", "⇧⌘E"));
    assert.equal(state.capture.text, `Capture region ${display("Ctrl+Alt+S", "⇧⌘E")}`);
    // Screen readers get the shortcut as such, not the glyphs as part of the name.
    assert.equal(state.keyshortcuts, display("Control+Alt+S", "Meta+Shift+E"));
    assert.equal(state.shortcutHidden, true);
    assert.deepEqual(state.toggles, { ocr: false, textFragment: true, removeTrackers: true, saveAs: false });
    assert.deepEqual(state.folder, { value: "", error: "", invalid: false });
    // The commit is missing from a build without git.
    assert.match(state.about, /^snapii \d+\.\d+\.\d+ · (?:[0-9a-f]{7,}.* · )?built .* · Firefox \d+/);
    await focusedInPopup("capture");

    // Kept for a look at the layout (light theme, DPR 2).
    const shot = join(g.out, "popup-light.png");
    writeFileSync(shot, await g.s.popupScreenshot());
    console.log(`popup screenshot: ${shot}`);
    await closePopup();
  });
});

test("Enter in the popup starts a capture: overlay in the page, popup closed", async () => {
  await g.open(PAGE);
  await g.openPopup();
  await focusedInPopup("capture");
  await g.s.keyInPopup("Enter");
  await g.until(async () => (await g.overlayPresent()) === 1, "the overlay");
  await g.popupClosed();
  await g.key("Escape");
  await g.until(async () => (await g.overlayPresent()) === 0, "the overlay to close");
});

test("toggles write storage.sync at once; the next save follows them; the popup shows them next time", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await g.s.clickInPopup('input[name="ocr"]');
  await g.s.clickInPopup('input[name="textFragment"]');
  await g.until(async () => {
    const s = await storedInPopup();
    return s.ocr === true && s.textFragment === false ? s : null;
  }, "both toggles in storage.sync");
  await closePopup();
  // Only the touched keys are written.
  assert.deepEqual(await stored(), { ocr: true, textFragment: false });

  const file = await saveCard();
  assert.equal(file.svg.capture.textFragmentStatus, "DISABLED");
  // OCR on, and the card holds no image: the pass ran and found nothing to read.
  assert.equal(file.svg.capture.ocr.status, "no-areas");

  const again = await g.openPopup();
  assert.deepEqual(again.toggles, { ocr: true, textFragment: false, removeTrackers: true, saveAs: false });
  await g.s.clickInPopup('input[name="ocr"]');
  await g.until(async () => ((await storedInPopup()).ocr === false ? true : null), "OCR off in storage.sync");
  await closePopup();
  const off = await saveCard();
  assert.equal(off.svg.capture.ocr.status, "disabled");
  await clearStored();
});

test("the Remove trackers toggle: stored off, the next Copy page link keeps the trackers; the popup shows it next time", async () => {
  await clearStored();
  await g.open(`${PAGE}?id=7&utm_source=news&fbclid=abc#top`);
  await g.openPopup();
  await g.s.clickInPopup('input[name="removeTrackers"]');
  await g.until(
    async () => ((await storedInPopup()).removeTrackers === false ? true : null),
    "the toggle in storage.sync",
  );
  await closePopup();
  assert.deepEqual(await stored(), { removeTrackers: false });

  await g.startOverlay();
  await g.move(310, 290);
  await g.click(310, 290);
  await clearClipboard(g.s);
  await g.clickToolbar("copy-page-link");
  const clip = await g.until(async () => {
    const c = await readClipboard(g.s);
    return c["text/plain"] ? c : null;
  }, "the clipboard to be written");
  assert.equal(clip["text/plain"], `${g.base}${PAGE}?id=7&utm_source=news&fbclid=abc#top`);
  await g.until(async () => (await g.overlayPresent()) === 0, "the overlay to close");

  const again = await g.openPopup();
  assert.equal(again.toggles.removeTrackers, false);
  await closePopup();
  await clearStored();
});

test("the folder field: Enter stores it normalised in storage.sync; the next save lands in it; the popup shows it next time", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await g.s.clickInPopup('input[name="saveFolder"]');
  await g.s.typeInPopup("Pages/ popup ");
  await g.s.keyInPopup("Enter");
  await g.until(async () => ((await storedInPopup()).saveFolder === "Pages/popup" ? true : null), "the folder in storage.sync");
  assert.deepEqual((await g.popupState()).folder, { value: "Pages/popup", error: "", invalid: false });
  await closePopup();
  assert.deepEqual(await stored(), { saveFolder: "Pages/popup" });

  await saveCardInto("Pages/popup");
  const again = await g.openPopup();
  assert.equal(again.folder.value, "Pages/popup");
  await closePopup();
  await clearStored();
});

test("a folder add-ons cannot use is not stored; the popup says why and keeps what was typed", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await g.s.clickInPopup('input[name="saveFolder"]');
  await g.s.typeInPopup("../x");
  await g.s.keyInPopup("Enter");
  const st = await g.until(async () => {
    const s = await g.popupState();
    return s.folder.error !== "" ? s : null;
  }, "the refusal");
  assert.match(st.folder.error, /^Not saved: .*\.\./);
  assert.equal(st.folder.invalid, true);
  assert.equal(st.folder.value, "../x");
  await closePopup();
  assert.deepEqual(await stored(), {});
});

test("a folder still being written when Capture region is clicked reaches that save", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await stubStorageSet({ delayMs: 3000 });
  await g.s.clickInPopup('input[name="saveFolder"]');
  await g.s.typeInPopup("Pages/slow");
  await g.s.keyInPopup("Enter");
  // The write is three seconds away; the capture starts only after it.
  await g.s.clickInPopup("#capture");
  await g.until(async () => (await g.overlayPresent()) === 1, "the overlay");
  await g.popupClosed();
  const topLevel = g.svgFiles();
  await g.move(310, 290);
  await g.click(310, 290);
  await g.key("Enter");
  await fileIn("Pages/slow", topLevel);
  await clearStored();
});

test("a refused folder keeps the popup open on that field instead of capturing without it", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await g.s.clickInPopup('input[name="saveFolder"]');
  await g.s.typeInPopup("../x");
  // Leaving the field commits it (refused), then the click lands on the button.
  await g.s.clickInPopup("#capture");
  await sleep(700);
  const st = await g.popupState();
  assert.match(st.folder.error, /^Not saved: /);
  assert.equal(st.focused, "folder");
  assert.equal(await g.s.popupCount(), 1);
  assert.equal(await g.overlayPresent(), 0);
  await closePopup();
  assert.deepEqual(await stored(), {});
});

test("a folder that cannot be stored goes back to the stored one and says so", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await stubStorageSet({ fail: true });
  await g.s.clickInPopup('input[name="saveFolder"]');
  await g.s.typeInPopup("abc");
  await g.s.keyInPopup("Enter");
  const st = await g.until(async () => {
    const s = await g.popupState();
    return s.folder.error === "Could not save the setting" ? s : null;
  }, "the failure message");
  assert.equal(st.folder.value, "");
  await closePopup();
  assert.deepEqual(await stored(), {});
});

test("a toggle that cannot be stored flips back and says so", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await stubStorageSet({ fail: true });
  await g.s.clickInPopup('input[name="ocr"]');
  const st = await g.until(async () => {
    const s = await g.popupState();
    return s.status === "Could not save the setting" ? s : null;
  }, "the failure status");
  assert.equal(st.toggles.ocr, false);
  await closePopup();
  assert.deepEqual(await stored(), {});
});

test("a toggle still being written when Capture region is clicked reaches that capture", async () => {
  await clearStored();
  await g.open(PAGE);
  await g.openPopup();
  await stubStorageSet({ delayMs: 800 });
  await g.s.clickInPopup('input[name="textFragment"]');
  await g.s.clickInPopup("#capture");
  await g.until(async () => (await g.overlayPresent()) === 1, "the overlay");
  await g.popupClosed();
  const before = g.svgFiles();
  await g.move(310, 290);
  await g.click(310, 290);
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.equal(file.svg.capture.textFragmentStatus, "DISABLED");
  await clearStored();
});

test("an open options page follows a popup toggle without a reload", async () => {
  await clearStored();
  await g.open(optionsUrl);
  await g.until(() => g.content(`return !document.getElementById("shortcut-input").disabled;`), "the options page");
  const ocrBox = () => g.content(`return document.querySelector('input[name="ocr"]').checked;`);
  assert.equal(await ocrBox(), false);
  await g.openPopup();
  await g.s.clickInPopup('input[name="ocr"]');
  await closePopup();
  await g.until(ocrBox, "the options page's OCR checkbox to follow");
  await clearStored();
});

test("All settings… opens snapii's options in about:addons and closes the popup", async () => {
  await g.open(PAGE);
  const tabs = await g.s.chrome("return gBrowser.tabs.length;");
  await g.openPopup();
  await g.s.clickInPopup("#options");
  await g.popupClosed();
  const opened = await g.until(
    () =>
      g.s.chrome(
        `const b = gBrowser.selectedBrowser;
         if (b.currentURI.spec !== "about:addons") return null;
         const inline = b.contentDocument.querySelector("browser.inline-options-browser, #addon-inline-options browser")
           ?? [...b.contentDocument.querySelectorAll("browser")].find((x) => x.currentURI?.spec.endsWith("/options.html"));
         return inline ? { tabs: gBrowser.tabs.length, options: inline.currentURI.spec } : null;`,
      ),
    "about:addons with snapii's options",
  );
  assert.equal(opened.tabs, tabs + 1);
  assert.equal(opened.options, optionsUrl);
  await g.s.chrome("gBrowser.removeTab(gBrowser.selectedTab); return true;");
});

for (const [what, url, reason] of [
  ["about:addons", "about:addons", "Firefox does not let extensions run on this page"],
  ["an SVG document", "/glue/fixtures/doc.svg", "snapii works on HTML pages only"],
]) {
  test(`popup on ${what}: Capture region disabled, the reason in the popup, no badge, no overlay`, async () => {
    await g.open(url);
    const t0 = Date.now();
    const state = await g.openPopup();
    assert.equal(state.capture.disabled, true);
    assert.equal(state.status, `snapii cannot capture this page: ${reason}`);
    // The settings stay in reach, by keyboard too.
    await focusedInPopup("options");
    // A click on the disabled button does nothing: popup open, no badge, no overlay host.
    await g.s.clickInPopup("#capture");
    await sleep(500);
    assert.equal(await g.s.popupCount(), 1);
    assert.ok(!(await g.action()).badge);
    if (url.startsWith("/")) assert.equal(await g.overlayPresent(), 0);
    assert.deepEqual(await g.consoleErrors(t0), []);
    await closePopup();
  });
}

test("the start-capture shortcut on a never-clicked tab: activeTab from the command, overlay, and a save (captureVisibleTab)", async () => {
  await g.inNewTab(`${g.base}${PAGE}`, async () => {
    assert.equal(await g.hasActiveTab(), false);
    const before = g.svgFiles();
    const key = await g.startOverlay("shortcut");
    assert.deepEqual(
      key,
      process.platform === "darwin" ? { key: "E", modifiers: "accel,shift" } : { key: "S", modifiers: "accel,alt" },
    );
    assert.equal(await g.hasActiveTab(), true);
    assert.equal(await g.s.popupCount(), 0);
    await g.move(310, 290);
    await g.click(310, 290);
    await g.key("Enter");
    const file = await g.newDownload(before);
    assert.equal(file.svg.images.length, 1);
    assert.match(file.svg.tspans.join(""), /First glue paragraph/);
  });
});
