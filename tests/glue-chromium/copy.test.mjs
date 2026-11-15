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

/** The middle of the glyph after the "|" in `at`, a text found in `selector`, and the glyph's top and bottom. */
function glyph(selector, at) {
  return g.content(
    `const el = document.querySelector(arguments[0]);
     let index = el.textContent.indexOf(arguments[1].replace("|", "")) + arguments[1].indexOf("|");
     const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
     for (let n = walker.nextNode(); n; n = walker.nextNode()) {
       if (index < n.data.length) {
         const range = document.createRange();
         range.setStart(n, index);
         range.setEnd(n, index + 1);
         const r = range.getBoundingClientRect();
         return { x: r.x + r.width / 2, top: r.top, bottom: r.bottom };
       }
       index -= n.data.length;
     }
     return null;`,
    selector,
    at,
  );
}

test("Copy text of a region that cuts a word at each edge: both words whole, in both flavours", async () => {
  await g.writeClipboard(reader, "before the copy");
  await g.open(PAGE);
  await g.startOverlay();
  // "First glue paragraph with a first link inside.": from the middle of
  // glue's u to the middle of link's n.
  const from = await glyph("#para", "gl|ue");
  const to = await glyph("#para", "li|nk");
  await g.drag(from.x, from.top + 2, to.x, to.bottom - 2);
  await g.clickToolbar("copy-text");
  assert.equal(await g.until(() => g.toast(), "the toast"), "Copied text");
  const clip = await g.readClipboard(reader);
  assert.equal(clip["text/plain"], "glue paragraph with a first link");
  assert.match(
    clip["text/html"],
    new RegExp(`^(<meta[^>]*>)?glue paragraph with a <a href="${g.base}/glue/target/one">first link</a>$`),
  );
});

test("Copy link: the text-fragment URL as plain text and as a link named like the page", async () => {
  await g.writeClipboard(reader, "before the copy");
  await g.open(PAGE);
  await g.startOverlay();
  await g.click(130, 150);
  await g.clickToolbar("copy-link");
  assert.equal(await g.until(() => g.toast(), "the toast"), "Copied link");
  // A copied link closes the overlay.
  await g.until(async () => !(await g.overlayPresent()), "the overlay to close");
  const clip = await g.readClipboard(reader);
  assert.ok(clip["text/plain"].startsWith(`${g.base}${PAGE}#:~:text=`), clip["text/plain"]);
  assert.match(clip["text/html"], /^(<meta[^>]*>)?<a href="[^"]+#:~:text=[^"]+">snapii glue page<\/a>$/);
});
