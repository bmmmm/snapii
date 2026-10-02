// SPDX-License-Identifier: GPL-3.0-or-later
// M4 options page: the form is driven with real clicks and keys in the
// extension's own page (moz-extension://<uuid>/options.html), then a fixture
// region is saved through the toolbar/overlay path. The saved file is the
// evidence that storage.sync reached the background, not the form's own state.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFolder } from "../../src/shared/folder.ts";
import { ADDON_ID, ROOT, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
const ARROW_LEFT = "\uE012"; // WebDriver ArrowLeft: a range input steps down by 1.

let g;
let optionsUrl;
before(async () => {
  g = await startGlue(6);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
});
after(async () => {
  await g?.close();
});

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function clickOn(selector) {
  const c = center(await g.rect(selector));
  await g.click(c.x, c.y);
}

/** Everything in storage.sync, read through the options page's own `browser` (system sandbox reaches it). */
const stored = async () =>
  JSON.parse(
    await g.system(
      `return (async () => JSON.stringify(await window.wrappedJSObject.browser.storage.sync.get(null)))();`,
    ),
  );

const statusText = () => g.content(`return document.getElementById("status").textContent;`);

/** Waits for the "Saved" confirmation of the change just made, then lets it clear for the next one. */
async function saved() {
  await g.until(async () => (await statusText()) === "Saved", "the Saved status");
}

const checkedFormat = () => g.content(`return document.querySelector('input[name="format"]:checked')?.value;`);

/**
 * Opens the options page with exactly `values` in storage.sync, so each test
 * sets its own starting point instead of inheriting the previous test's.
 */
async function openWith(values) {
  await g.open(optionsUrl);
  // Parsed in the page's compartment: an object made in the system sandbox
  // would not cross into the page's storage API.
  await g.system(
    `const json = arguments[0];
    return (async () => {
      const sync = window.wrappedJSObject.browser.storage.sync;
      await sync.clear();
      await sync.set(window.wrappedJSObject.JSON.parse(json));
    })();`,
    JSON.stringify(values),
  );
  assert.deepEqual(await stored(), values);
  // The form reads storage once, on load.
  await g.open(optionsUrl);
  const format = values.format ?? "png";
  await g.until(async () => (await checkedFormat()) === format, "the form to load the stored settings");
}

/** Saves the card of the fixture page (element pick, Enter) and returns the parsed file. */
async function saveCard() {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.move(310, 290); // inside #card, below both paragraphs
  await g.click(310, 290);
  await g.key("Enter");
  return g.newDownload(before);
}

/** Types into the focused element with real key actions. */
async function type(text) {
  await g.s.perform([
    {
      type: "key",
      id: "keyboard",
      actions: [...text].flatMap((value) => [
        { type: "keyDown", value },
        { type: "keyUp", value },
      ]),
    },
  ]);
  await g.frames();
}

const folderError = () =>
  g.content(`const el = document.getElementById("folder-error"); return el.hidden ? "" : el.textContent;`);

const folderState = () =>
  g.content(`const el = document.getElementById("folder");
    return { value: el.value, invalid: el.getAttribute("aria-invalid") === "true" };`);

/** Saves the card and waits for the file inside `dir` (relative to the download folder). */
async function saveCardInto(dir) {
  await g.open(PAGE);
  const target = join(g.downloads, dir);
  const topLevel = g.svgFiles();
  await g.startOverlay();
  await g.move(310, 290);
  await g.click(310, 290);
  await g.key("Enter");
  const name = await g.until(
    () => (existsSync(target) ? readdirSync(target).find((f) => f.endsWith(".svg")) : null),
    `a .svg in ${dir}`,
  );
  await g.until(
    () => readFileSync(join(target, name), "utf8").trimEnd().endsWith("</svg>"),
    `${name} to be complete`,
  );
  // Nothing went to the download folder itself.
  assert.deepEqual(g.svgFiles(), topLevel);
  return name;
}

test("the form shows the defaults, the quality slider is only enabled for JPEG", async () => {
  await openWith({});
  const state = await g.content(`
    const box = (n) => document.querySelector('input[name="' + n + '"]').checked;
    return {
      disabled: document.getElementById("quality").disabled,
      shown: document.getElementById("quality-value").textContent,
      saveAs: box("saveAs"),
      occlusionCheck: box("occlusionCheck"),
      textFragment: box("textFragment"),
    };`);
  assert.deepEqual(state, {
    disabled: true,
    shown: "92%",
    saveAs: false,
    occlusionCheck: false,
    textFragment: true,
  });
  await clickOn('input[name="format"][value="jpeg"]');
  await saved();
  assert.equal(await g.content(`return document.getElementById("quality").disabled;`), false);
});

test("the footer names version, commit and Firefox, for debugging", async () => {
  await openWith({});
  await g.content(`return new Promise((r) => setTimeout(r, 300));`);
  const about = await g.content(`return document.getElementById("about").textContent;`);
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.match(about, new RegExp(`^snapii ${version.replace(/\./g, "\\.")} · ${commit}`));
  assert.match(about, / · built \d{4}-\d\d-\d\d \d\d:\d\d UTC · Firefox \d+/);
});

test("a stored quality below 50 % shows as stored: slider and label", async () => {
  // Valid for the background (isValidSetting), so the capture uses it.
  await openWith({ format: "jpeg", jpegQuality: 0.3 });
  const shown = await g.content(`return {
    slider: document.getElementById("quality").value,
    label: document.getElementById("quality-value").textContent,
  };`);
  assert.deepEqual(shown, { slider: "30", label: "30%" });
});

test("format JPEG + quality 50 % in the options page -> the saved file holds a JPEG tile", async () => {
  await openWith({ format: "jpeg", jpegQuality: 0.51 });
  await g.content(`document.getElementById("quality").focus();`);
  await g.key(ARROW_LEFT);
  await saved();
  assert.equal(await g.content(`return document.getElementById("quality-value").textContent;`), "50%");
  // Only the touched keys are written: the pixel budgets stay internal.
  assert.deepEqual(await stored(), { format: "jpeg", jpegQuality: 0.5 });

  const file = await saveCard();
  const { images, capture } = file.svg;
  assert.equal(images.length, 1);
  assert.ok(images[0].href.startsWith("data:image/jpeg;base64,"), images[0].href.slice(0, 40));
  assert.deepEqual(
    capture.tiles.map((t) => t.format),
    ["jpeg"],
  );
  // Default is on: the options page has not touched it.
  assert.equal(capture.textFragmentStatus, "SUCCESS");
});

test("text fragment off in the options page -> textFragmentStatus DISABLED", async () => {
  await openWith({ format: "jpeg" });
  assert.equal(await g.content(`return document.querySelector('input[name="textFragment"]').checked;`), true);
  await clickOn('input[name="textFragment"]');
  await saved();
  const file = await saveCard();
  assert.equal(file.svg.capture.textFragmentStatus, "DISABLED");
  assert.equal(file.svg.capture.textFragmentURL, null);
  // The checkbox is independent of the format stored before it.
  assert.deepEqual(
    file.svg.capture.tiles.map((t) => t.format),
    ["jpeg"],
  );
});

test("Reset to defaults -> PNG again and the text fragment is back", async () => {
  await openWith({ format: "jpeg", jpegQuality: 0.5, textFragment: false });
  await clickOn("#reset");
  await g.until(async () => (await statusText()) === "Defaults restored", "the reset status");
  const form = await g.content(`return {
    format: document.querySelector('input[name="format"]:checked').value,
    textFragment: document.querySelector('input[name="textFragment"]').checked,
    shown: document.getElementById("quality-value").textContent,
  };`);
  assert.deepEqual(form, { format: "png", textFragment: true, shown: "92%" });
  assert.deepEqual(await stored(), {});
  const file = await saveCard();
  assert.ok(file.svg.images[0].href.startsWith("data:image/png;base64,"));
  assert.deepEqual(
    file.svg.capture.tiles.map((t) => t.format),
    ["png"],
  );
  assert.equal(file.svg.capture.textFragmentStatus, "SUCCESS");
});

test("folder inside Downloads, typed with real keys: stored normalised, and the next save lands in it", async () => {
  await openWith({});
  assert.deepEqual(await folderState(), { value: "", invalid: false });
  await clickOn("#folder");
  await type("Pages/ snapii ");
  await g.key("Enter");
  await saved();
  assert.deepEqual(await folderState(), { value: "Pages/snapii", invalid: false });
  assert.deepEqual(await stored(), { saveFolder: "Pages/snapii" });
  assert.equal(await saveCardInto("Pages/snapii").then((n) => n.startsWith("snapii ")), true);

  // Emptied again: back to the download folder itself.
  await g.open(optionsUrl);
  await g.until(async () => (await folderState()).value === "Pages/snapii", "the stored folder to show");
  await g.content(`document.getElementById("folder").select();`);
  await g.key("Backspace");
  await g.key("Enter");
  await saved();
  assert.deepEqual(await stored(), { saveFolder: "" });
  const file = await saveCard();
  assert.ok(file.name.endsWith(".svg"));
});

test("a folder add-ons cannot use is not stored and says why; the field keeps what was typed", async () => {
  await openWith({ saveFolder: "kept" });
  await g.until(async () => (await folderState()).value === "kept", "the stored folder to show");
  await clickOn("#folder");
  await g.content(`document.getElementById("folder").select();`);
  await type("../x");
  await g.key("Enter");
  await g.until(async () => /^Not saved: /.test(await folderError()), "the refusal");
  assert.match(await folderError(), /\.\./);
  assert.deepEqual(await folderState(), { value: "../x", invalid: true });
  assert.deepEqual(await stored(), { saveFolder: "kept" });

  // Typing the stored folder again clears the refusal; nothing changes in storage to re-render the field.
  await g.content(`document.getElementById("folder").select();`);
  await type("kept");
  await g.key("Enter");
  await saved();
  assert.equal(await folderError(), "");
  assert.deepEqual(await folderState(), { value: "kept", invalid: false });
  assert.deepEqual(await stored(), { saveFolder: "kept" });
});

test("Reset to defaults clears the folder", async () => {
  await openWith({ saveFolder: "kept" });
  await g.until(async () => (await folderState()).value === "kept", "the stored folder to show");
  await clickOn("#reset");
  await g.until(async () => (await statusText()) === "Defaults restored", "the reset status");
  assert.deepEqual(await folderState(), { value: "", invalid: false });
  assert.deepEqual(await stored(), {});
});

test("the folder rules agree with downloads.download: what they accept it takes, what they refuse it refuses", async () => {
  await openWith({});
  /** downloads.download's verdict on `filename`, asked in the options page (a blob of its own, as a save has). */
  const firefox = (filename) =>
    g.system(
      `return (async () => {
        const w = window.wrappedJSObject;
        const url = w.URL.createObjectURL(new w.Blob(w.JSON.parse('["probe"]')));
        try {
          await w.browser.downloads.download(w.JSON.parse(arguments[0].replace("BLOB", url)));
          return "accepted";
        } catch (e) {
          return "refused: " + e.message;
        }
      })();`,
      JSON.stringify({ url: "BLOB", filename, conflictAction: "overwrite" }),
    );
  const accepted = [
    "snapii",
    "Pages/snapii",
    "My Pages/2026 Q4",
    "a.b/c..d",
    "a  b",
    "~notes",
    "a#b",
    "a&b",
    "a'b",
    "a{b}",
    "a$b",
    "日本語",
    "emoji😀",
    "ä".repeat(80),
  ];
  // Written below a folder of their own, so no later test finds them.
  for (const folder of accepted) {
    assert.deepEqual(checkFolder(folder), { ok: true, folder }, folder);
    assert.equal(await firefox(`firefox-probe/${folder}/probe.svg`), "accepted", folder);
  }
  const refused = [
    "/abs",
    "~/x",
    "../x",
    "a/../x",
    ".hidden",
    "a.",
    "a:b",
    "a|b",
    "a*b",
    'a"b',
    "a<b",
    "a?b",
    "a\u0085b",
    "a\u00a0b",
    "a\u2003b",
    "a\u200ab",
    "a\u200bb",
    "a\u202eb",
    "a\u2029b",
  ];
  for (const folder of refused) {
    assert.equal(checkFolder(folder).ok, false, JSON.stringify(folder));
    assert.match(await firefox(`${folder}/probe.svg`), /^refused: filename must not /, JSON.stringify(folder));
  }

  // "%" is accepted, but Firefox saves it as "_": the folder would not be the typed one, so it is refused here.
  assert.equal(checkFolder("100%").ok, false);
  assert.equal(await firefox("firefox-probe/pct/100%/probe.svg"), "accepted");
  await g.until(
    () => existsSync(join(g.downloads, "firefox-probe/pct/100_/probe.svg")),
    "the folder Firefox made of 100%",
  );
});
