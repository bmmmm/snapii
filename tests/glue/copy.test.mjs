// SPDX-License-Identifier: GPL-3.0-or-later
// Manual checklist items 8 and 9 (tests/MANUAL-CHECKLIST.md): the toolbar's
// Copy text and Copy link on the installed Firefox, read back from Firefox's
// own clipboard (headless: in-process, so this proves Firefox's write path,
// not what other macOS apps paste). Item 8 runs once on a secure origin
// (http://127.0.0.1 counts as one) and once on a non-secure one
// (http://snapii.test, mapped to 127.0.0.1 by network.dns.localDomains),
// where the content script has no navigator.clipboard and only the
// background page can write (S12).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { clearClipboard, readClipboard } from "../../tools/marionette/helpers.mjs";
import { startGlue } from "./env.mjs";

const ARTICLE = "/glue/fixtures/article.html";
// ::target-text in Fx157's default theme (measured), and the tolerance for
// anti-aliased glyph edges blending into it.
const TARGET_TEXT_RGB = [245, 204, 88];
const TOL = 12;

let g;
before(async () => {
  g = await startGlue(3, { prefs: { "network.dns.localDomains": "snapii.test" } });
});
after(async () => {
  await g?.close();
});

/** Waits for the clipboard to hold text/plain and returns both flavours. */
function clipboard() {
  return g.until(async () => {
    const c = await readClipboard(g.s);
    return c["text/plain"] ? c : null;
  }, "the clipboard to be written");
}

/** Firefox hands text/html back wrapped in a document; the fragment snapii wrote. */
const body = (html) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html;

const PLAIN = [
  "Copy me",
  "First bold italic paragraph with a real link and a script link.",
  "Shown text and more.",
  "Erster Punkt",
  "Second item",
  "Escaped <b> & text",
].join("\n\n");

const html = (origin) =>
  [
    "<h1>Copy <em>me</em></h1>",
    `<p>First <b>bold</b> <i>italic</i> paragraph with a <a href="${origin}/target?a=1&amp;b=2">real link</a> and a script link.</p>`,
    "<p>Shown text and more.</p>",
    '<ul> <li lang="de">Erster Punkt</li> <li>Second <code>item</code></li> </ul>',
    "<p>Escaped &lt;b&gt; &amp; text</p>",
  ].join(" ");

for (const [name, host, secure] of [
  ["a secure origin (127.0.0.1)", "127.0.0.1", true],
  ["a non-secure origin (snapii.test): background fallback", "snapii.test", false],
]) {
  test(`item 8: Copy text on ${name} -> text/plain and text/html on the clipboard`, async () => {
    const origin = `http://${host}:${new URL(g.base).port}`;
    await g.open(`${origin}/fixtures/copy.html`);
    // Guard: the second run really is the page without navigator.clipboard.
    assert.equal(await g.content("return isSecureContext;"), secure);
    await clearClipboard(g.s);
    assert.equal((await readClipboard(g.s))["text/plain"], null);
    await g.startOverlay();
    const cap = await g.rect("#cap");
    await g.drag(4, 4, Math.round(cap.x + cap.width + 10), Math.round(cap.y + cap.height + 10));
    await g.clickToolbar("copy-text");
    const clip = await clipboard();
    assert.equal(clip["text/plain"], PLAIN);
    // Hidden text absent, javascript: link unwrapped, real link kept.
    assert.equal(body(clip["text/html"]).replace(/\s+/g, " ").trim(), html(origin));
    assert.equal(await g.until(() => g.toast(), "the toast"), "Copied text");
    // The overlay stays open after a copy.
    assert.equal(await g.overlayPresent(), 1);
    await g.key("Escape");
  });
}

/** Pixels of rect (CSS px, viewport) painted in the ::target-text colour, and the rect's total, at DPR 2. */
async function highlighted(rect) {
  const shot = await g.screenshot();
  let hits = 0;
  let total = 0;
  for (let y = Math.round(rect.y * 2); y < Math.round((rect.y + rect.height) * 2); y++) {
    for (let x = Math.round(rect.x * 2); x < Math.round((rect.x + rect.width) * 2); x++) {
      const p = shot.at(x, y);
      total++;
      if (TARGET_TEXT_RGB.every((v, i) => Math.abs(p[i] - v) <= TOL)) hits++;
    }
  }
  return { hits, total };
}

test("item 9: Copy link -> the URL opened in a new tab scrolls to the passage and highlights it", async () => {
  const url = `${g.base}${ARTICLE}`;
  await g.open(ARTICLE);
  await g.content(`document.getElementById("far").scrollIntoView({ block: "center" }); return true;`);
  await g.frames();
  await g.startOverlay();
  const far = await g.rect("#far");
  await g.move(far.x + 10, far.y + far.height / 2);
  await g.click(far.x + 10, far.y + far.height / 2);
  await clearClipboard(g.s);
  await g.clickToolbar("copy-link");
  const clip = await clipboard();
  const link = clip["text/plain"];
  assert.ok(link.startsWith(`${url}#:~:text=`), link);
  assert.equal(body(clip["text/html"]), `<a href="${link.replace(/&/g, "&amp;")}">snapii glue article</a>`);
  assert.equal(await g.until(() => g.toast(), "the toast"), "Copied link");
  await g.key("Escape");

  // Control: the plain URL opens at the top, and the passage scrolled into
  // view by hand shows no highlight colour, so the check below can fail.
  const control = await g.inNewTab(url, async () => {
    const scrollY = await g.content("return scrollY;");
    await g.content(`document.getElementById("far").scrollIntoView({ block: "center" }); return true;`);
    await g.frames();
    return { scrollY, ...(await highlighted(await g.rect("#far"))) };
  });
  assert.equal(control.scrollY, 0);
  assert.equal(control.hits, 0);

  const opened = await g.inNewTab(link, async () => {
    // Firefox scrolls to the passage after load; wait for it rather than assume when.
    const scrollY = await g.until(async () => (await g.content("return scrollY;")) || null, "the scroll");
    await g.frames();
    const r = await g.rect("#far");
    return { scrollY, rect: r, hash: await g.content("return location.hash;"), ...(await highlighted(r)) };
  });
  console.log(`item 9: ${JSON.stringify(opened)}`);
  assert.ok(opened.scrollY > 1000, `scrollY ${opened.scrollY}`);
  // The passage is inside the 715 px viewport.
  assert.ok(opened.rect.y >= 0 && opened.rect.y + opened.rect.height <= 715, JSON.stringify(opened.rect));
  // Most of the paragraph's box is painted in the highlight colour (the glyphs are the rest).
  assert.ok(opened.hits > opened.total * 0.25, `${opened.hits} of ${opened.total} px highlighted`);
});
