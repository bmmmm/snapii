// SPDX-License-Identifier: GPL-3.0-or-later
// The shortcut section of the options page, driven with trusted key actions in
// the extension's own page. The evidence that a change took is what Firefox
// reports (commands.getAll) for the start-capture command and the browser
// window's <key> element of the add-on's keyset, which is what the real
// shortcut runs through: dispatching its `command` event opens the overlay,
// as in overlay.test.mjs item 1. The last test presses real key events at the
// browser window: the one place where it matters which command a key reaches.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ADDON_ID, ROOT, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
// WebDriver key codes.
const ALT = "\uE00A";
const SHIFT = "\uE008";
const BACKSPACE = "\uE003";
const ESCAPE = "\uE00C";
const ENTER = "\uE007";

let g;
let optionsUrl;
let mac;
// The manifest's key: Control+Option+S on a Mac, Ctrl+Alt+S elsewhere. The <key> modifiers are
// measured on macOS ("alt,control"); elsewhere read from Firefox's source (Ctrl is "accel",
// ShortcutUtils.getModifiersAttribute sorts), not run.
let DEFAULT;
let SHOWN;
let DEFAULT_ELEMENT;
before(async () => {
  g = await startGlue(8);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
  await g.open(optionsUrl);
  mac = await inPage(`return (await window.wrappedJSObject.browser.runtime.getPlatformInfo()).os === "mac";`);
  DEFAULT = mac ? "MacCtrl+Alt+S" : "Ctrl+Alt+S";
  SHOWN = mac ? "⌃⌥S" : "Ctrl+Alt+S";
  DEFAULT_ELEMENT = { key: "S", modifiers: mac ? "alt,control" : "accel,alt" };
});
after(async () => {
  await g?.close();
});

/** Runs an async function body with the options page's own `browser` in reach (system sandbox). */
const inPage = (body, ...args) => g.system(`return (async () => { ${body} })();`, ...args);

const shortcutOf = async (name) =>
  JSON.parse(
    await inPage(
      `const all = await window.wrappedJSObject.browser.commands.getAll();
       return JSON.stringify(all.find((c) => c.name === arguments[0]).shortcut);`,
      name,
    ),
  );
const shortcut = () => shortcutOf("start-capture");

/** The <key> element of the add-on's keyset in the browser window, or null. */
const keyElement = () =>
  g.s.chrome(
    `const key = document.querySelector("#ext-keyset-id-" + arguments[0].replace(/[^a-z0-9]/gi, "_") + " > key");
     return key ? { key: key.getAttribute("key"), modifiers: key.getAttribute("modifiers") } : null;`,
    ADDON_ID,
  );

const statusText = () => g.content(`return document.getElementById("shortcut-status").textContent;`);
const fieldText = () => g.content(`return document.getElementById("shortcut-input").value;`);
const fieldFocused = () => g.content(`return document.activeElement?.id === "shortcut-input";`);

/** Trusted key press: `mods` are held around `key` (a character or a WebDriver code). */
async function press(key, mods = []) {
  await g.s.perform([
    {
      type: "key",
      id: "keyboard",
      actions: [
        ...mods.map((value) => ({ type: "keyDown", value })),
        { type: "keyDown", value: key },
        { type: "keyUp", value: key },
        ...[...mods].reverse().map((value) => ({ type: "keyUp", value })),
      ],
    },
  ]);
  await g.frames();
}

/** Starts from the default shortcut with the options page freshly loaded and the field focused. */
async function openFresh() {
  await g.open(optionsUrl);
  await inPage(`await window.wrappedJSObject.browser.commands.reset("start-capture");`);
  assert.equal(await shortcut(), DEFAULT);
  await g.open(optionsUrl);
  await g.until(
    () => g.content(`return !document.getElementById("shortcut-input").disabled;`),
    "the shortcut field to be enabled",
  );
  // The page is taller than the viewport: the click goes to where the field is on screen.
  await g.content(`document.getElementById("shortcut-input").scrollIntoView({ block: "center" });`);
  const r = await g.rect("#shortcut-input");
  await g.click(r.x + r.width / 2, r.y + r.height / 2);
  assert.equal(await fieldFocused(), true);
}

const display = (win, mc) => (mac ? mc : win);

test("the field shows the active shortcut", async () => {
  await openFresh();
  assert.equal(await fieldText(), SHOWN);
  assert.deepEqual(await keyElement(), DEFAULT_ELEMENT);
});

test("recording Alt+Shift+Y -> Firefox reports it, the <key> element changed and opens the overlay", async () => {
  await openFresh();
  await press("y", [ALT, SHIFT]);
  await g.until(async () => /^Shortcut saved/.test(await statusText()), "the saved status");
  assert.equal(await statusText(), `Shortcut saved: ${display("Alt+Shift+Y", "⌥⇧Y")}`);
  assert.equal(await fieldText(), display("Alt+Shift+Y", "⌥⇧Y"));
  assert.equal(await shortcut(), "Alt+Shift+Y");
  assert.deepEqual(await keyElement(), { key: "Y", modifiers: "alt,shift" });

  // The real path of the shortcut: the keyset's key fires `command`.
  await g.open(PAGE);
  assert.deepEqual(await g.startOverlay("shortcut"), { key: "Y", modifiers: "alt,shift" });
  await g.key("Escape");
  await g.until(async () => (await g.overlayPresent()) === 0, "the overlay to close");
});

test("a combination Firefox refuses is explained and nothing changes", async () => {
  await openFresh();
  // A letter alone, Shift+letter, a key without a name.
  await press("s");
  assert.match(await statusText(), /^S: Add .* \(Shift alone is not enough\)/);
  await press("s", [SHIFT]);
  assert.match(await statusText(), new RegExp("^" + display("Shift\\+S", "⇧S") + ": Add "));
  await press(ENTER, [ALT]);
  assert.equal(await statusText(), "This key cannot be used in a shortcut.");
  assert.equal(await shortcut(), DEFAULT);
  assert.deepEqual(await keyElement(), DEFAULT_ELEMENT);
  assert.equal(await fieldText(), SHOWN);
});

test("Escape leaves the field and keeps the shortcut", async () => {
  await openFresh();
  await press(ESCAPE);
  assert.equal(await fieldFocused(), false);
  assert.equal(await shortcut(), DEFAULT);
});

test("Backspace removes the shortcut: Firefox reports none and the <key> element is gone", async () => {
  await openFresh();
  await press(BACKSPACE);
  await g.until(async () => (await statusText()) === "Shortcut removed", "the removed status");
  assert.equal(await shortcut(), "");
  assert.equal(await fieldText(), "");
  assert.equal(await keyElement(), null);
});

test("Reset shortcut -> the default again, on the <key> element and in the field", async () => {
  await openFresh();
  await press("y", [ALT, SHIFT]);
  await g.until(async () => /^Shortcut saved/.test(await statusText()), "the saved status");
  assert.equal(await shortcut(), "Alt+Shift+Y");

  // The page is taller than the viewport: the click goes to where the button is on screen.
  await g.content(`document.getElementById("shortcut-reset").scrollIntoView({ block: "center" });`);
  const r = await g.rect("#shortcut-reset");
  await g.click(r.x + r.width / 2, r.y + r.height / 2);
  await g.until(async () => /^Default restored/.test(await statusText()), "the restored status");
  assert.equal(await statusText(), `Default restored: ${SHOWN}`);
  assert.equal(await shortcut(), DEFAULT);
  assert.equal(await fieldText(), SHOWN);
  assert.deepEqual(await keyElement(), DEFAULT_ELEMENT);
  // The default works through the real path again.
  await g.open(PAGE);
  assert.deepEqual(await g.startOverlay("shortcut"), DEFAULT_ELEMENT);
  await g.key("Escape");
  await g.until(async () => (await g.overlayPresent()) === 0, "the overlay to close");
});

const DIST = join(ROOT, "dist");
/** The extension's background starts anew; the options page of the old install is gone with it. */
async function restartAddon() {
  await g.open("about:blank");
  await g.s.installAddon(DIST);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
  await g.open(optionsUrl);
}
const update = (name, shortcut) =>
  inPage(
    `await window.wrappedJSObject.browser.commands.update(
       window.wrappedJSObject.JSON.parse(arguments[0]));`,
    JSON.stringify({ name, shortcut }),
  );
const closePopup = async () => {
  if ((await g.s.popupCount()) === 0) return;
  await g.s.triggerAction(ADDON_ID);
  await g.popupClosed();
};

test("a key an older build left on the toolbar action moves to start-capture at startup, once, and then captures", async () => {
  try {
    // What an update from the build before the popup leaves behind: the key the
    // user had recorded on the toolbar action, and no memory of having moved it.
    await g.open(optionsUrl);
    await inPage(`await window.wrappedJSObject.browser.commands.reset("start-capture");`);
    await update("_execute_action", "Alt+Shift+Y");
    await inPage(`await window.wrappedJSObject.browser.storage.local.remove("legacyShortcutMoved");`);
    assert.equal(await shortcutOf("_execute_action"), "Alt+Shift+Y");
    assert.equal(await shortcut(), DEFAULT);

    // The fault: that key opens the popup, no capture starts.
    await g.open(PAGE);
    await g.s.pressAltShift("Y");
    await g.until(async () => (await g.s.popupCount()) === 1, "the popup the old key opens");
    assert.equal(await g.overlayPresent(), 0);
    await closePopup();

    await restartAddon();
    await g.until(async () => (await shortcut()) === "Alt+Shift+Y", "the key to arrive on start-capture");
    assert.equal(await shortcutOf("_execute_action"), "");
    assert.deepEqual(await keyElement(), { key: "Y", modifiers: "alt,shift" });

    // The same key press now captures.
    await g.open(PAGE);
    await g.s.pressAltShift("Y");
    await g.until(async () => (await g.overlayPresent()) === 1, "the overlay");
    assert.equal(await g.s.popupCount(), 0);
    await g.key("Escape");
    await g.until(async () => (await g.overlayPresent()) === 0, "the overlay to close");

    // Once: a key bound to the menu on purpose afterwards survives the next startup.
    await g.open(optionsUrl);
    await update("_execute_action", "Alt+Shift+U");
    await restartAddon();
    // The background's start has long been done by the time Firefox answers.
    await g.s.chrome("return new Promise((resolve) => setTimeout(resolve, 1000));");
    assert.equal(await shortcutOf("_execute_action"), "Alt+Shift+U");
    assert.equal(await shortcut(), "Alt+Shift+Y");
  } finally {
    await closePopup().catch(() => {});
    await g.open(optionsUrl).catch(() => {});
    await inPage(`
      const b = window.wrappedJSObject.browser;
      await b.commands.reset("start-capture");
      await b.commands.reset("_execute_action");`).catch(() => {});
  }
});

test("a capture key the user chose is kept when a stale toolbar-action key is taken away", async () => {
  try {
    await g.open(optionsUrl);
    await update("start-capture", "Alt+Shift+K");
    await update("_execute_action", "Alt+Shift+Y");
    await inPage(`await window.wrappedJSObject.browser.storage.local.remove("legacyShortcutMoved");`);

    await restartAddon();
    await g.until(async () => (await shortcutOf("_execute_action")) === "", "the stale key to be taken away");
    assert.equal(await shortcut(), "Alt+Shift+K");
    assert.deepEqual(await keyElement(), { key: "K", modifiers: "alt,shift" });
  } finally {
    await g.open(optionsUrl).catch(() => {});
    await inPage(`
      const b = window.wrappedJSObject.browser;
      await b.commands.reset("start-capture");
      await b.commands.reset("_execute_action");`).catch(() => {});
  }
});
