// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium's service worker comes and goes: a save must not depend on the
// worker that started the session, and the capture command's handler must
// leave the toolbar button as it found it. The command is fired as an event
// (no key can be pressed from a test), so it carries no activeTab grant of
// its own.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sleep, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
const DEFAULT_TITLE = "snapii: capture region as SVG";

let g;
before(async () => {
  g = await startGlue(5);
});
after(async () => {
  await g?.close();
});

test("the service worker shut down between the start and the save: the save wakes it and writes the file", async () => {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.click(130, 150);
  await g.stopWorker();
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.ok(file.svg.tspans.join("").includes("First glue paragraph"));
  assert.equal(file.svg.images.length, 1);
});

test("the capture command with activeTab granted opens the overlay, a second one closes it", async () => {
  await g.open(PAGE);
  // The popup's opening is the grant; the command then needs no click in it.
  await g.openPopup();
  await g.command("start-capture");
  await g.until(() => g.overlayPresent(), "the overlay");
  await g.command("start-capture");
  await g.until(async () => !(await g.overlayPresent()), "the overlay to close");
});

test("the capture command on a browser page: the toolbar button says why, then has its own title back", async () => {
  await g.open("chrome://version/");
  await g.command("start-capture");
  const flagged = await g.until(async () => {
    const a = await g.action();
    return a.badge === "×" ? a : null;
  }, "the badge");
  assert.equal(flagged.title, "snapii cannot capture this page: Cannot access a chrome:// URL");
  // ERROR_BADGE_MS is 3 s.
  await sleep(3200);
  assert.deepEqual(await g.until(async () => ((await g.action()).badge === "" ? g.action() : null), "the badge to go"), {
    badge: "",
    title: DEFAULT_TITLE,
  });
});
