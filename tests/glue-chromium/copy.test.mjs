// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text and Copy link in Chromium, read back from the real clipboard. On
// a secure origin the content script writes itself; on a non-secure one
// (http://snapii.test) it has no navigator.clipboard and the service worker
// has none either (C1 in src/shared/spike.ts): the write goes through the
// offscreen document, which is gone again afterwards.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NON_SECURE_HOST, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";

let g;
let reader;
before(async () => {
  g = await startGlue(2);
  reader = `${g.base}/fixtures/smoke.html`;
});
after(async () => {
  await g?.close();
});

for (const [name, host, secure] of [
  ["a secure origin (127.0.0.1)", "127.0.0.1", true],
  [`a non-secure origin (${NON_SECURE_HOST}): through the offscreen document`, NON_SECURE_HOST, false],
]) {
  test(`Copy text on ${name}: plain text and clean HTML with the link`, async () => {
    const origin = `http://${host}:${new URL(g.base).port}`;
    await g.writeClipboard(reader, "before the copy");
    await g.open(`${origin}${PAGE}`);
    assert.equal(await g.content("return isSecureContext;"), secure);
    await g.startOverlay();
    await g.click(130, 150);
    await g.clickToolbar("copy-text");
    assert.equal(await g.until(() => g.toast(), "the toast"), "Copied text");
    const clip = await g.readClipboard(reader);
    assert.equal(clip["text/plain"], "First glue paragraph with a first link inside.");
    assert.match(clip["text/html"], new RegExp(`<a href="${origin}/glue/target/one">first link</a>`));
    assert.match(clip["text/html"], /First glue paragraph with a/);
    await g.until(async () => !(await g.offscreenOpen()), "the offscreen document to be closed");
  });
}

test("Copy link: the text-fragment URL as plain text and as a link named like the page", async () => {
  await g.writeClipboard(reader, "before the copy");
  await g.open(PAGE);
  await g.startOverlay();
  await g.click(130, 150);
  await g.clickToolbar("copy-link");
  assert.equal(await g.until(() => g.toast(), "the toast"), "Copied link");
  const clip = await g.readClipboard(reader);
  assert.ok(clip["text/plain"].startsWith(`${g.base}${PAGE}#:~:text=`), clip["text/plain"]);
  assert.match(clip["text/html"], /^(<meta[^>]*>)?<a href="[^"]+#:~:text=[^"]+">snapii glue page<\/a>$/);
});
