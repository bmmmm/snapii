// SPDX-License-Identifier: GPL-3.0-or-later
// Manual checklist items 1, 2, 10 and 11 (tests/MANUAL-CHECKLIST.md) on the
// installed Firefox, headless, DPR 2, with dist/ as a temporary add-on. The
// overlay's shadow root is closed and the test driver runs as a page script,
// so what the overlay draws is read from screenshots: the highlight border is
// exactly #0a84ff, the area outside the highlight is dimmed to 70 %.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { boundsOf, PROBE_EXT, sleep, startGlue } from "./env.mjs";

const BORDER = [10, 132, 255];
const PAGE = "/glue/fixtures/page.html";
// Document CSS px, see tests/glue/fixtures/page.html.
const PARA = { x: 120, y: 120, width: 400, height: 80 };
const CARD = { x: 100, y: 100, width: 500, height: 200 };

let g;
before(async () => {
  g = await startGlue(0);
  // Item 11's probe: a second, test-only add-on with a content script.
  await g.s.installAddon(PROBE_EXT);
});
after(async () => {
  await g?.close();
});

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** The highlight drawn by the overlay, in CSS px (screenshot at DPR 2), or null. */
async function highlight() {
  const shot = await g.screenshot();
  const b = boundsOf(shot, BORDER);
  return b && { x: b.x / 2, y: b.y / 2, width: b.width / 2, height: b.height / 2, shot };
}

const strip = ({ shot: _, ...r }) => r;

test("item 1: toolbar popup's Capture region and the capture shortcut open the overlay; Escape leaves no snapii-overlay; starting again closes it", async () => {
  await g.open(PAGE);
  assert.equal(await g.overlayPresent(), 0);
  // Toolbar button, then a real click on "Capture region" in its popup.
  // trigger("popup") also waits for the popup to close itself.
  await g.startOverlay("popup");
  assert.equal(await g.overlayPresent(), 1);
  await g.key("Escape");
  await g.until(async () => (await g.overlayPresent()) === 0, "Escape to remove the overlay");

  const shortcut = await g.startOverlay("shortcut");
  assert.deepEqual(shortcut, { key: "S", modifiers: process.platform === "darwin" ? "alt,control" : "accel,alt" });
  assert.equal(await g.overlayPresent(), 1);
  await g.key("Escape");
  await g.until(async () => (await g.overlayPresent()) === 0, "Escape to remove the overlay");

  await g.startOverlay("popup");
  await g.trigger("popup");
  await g.until(async () => (await g.overlayPresent()) === 0, "the second start to close the overlay");
  await g.startOverlay("shortcut");
  await g.trigger("shortcut");
  await g.until(async () => (await g.overlayPresent()) === 0, "the second shortcut to close the overlay");
});

test("item 2: hover highlights the element under the pointer; ArrowUp/ArrowDown walk the ancestors", async () => {
  await g.open(PAGE);
  await g.startOverlay();
  await g.move(center(PARA).x, center(PARA).y);
  const h = await highlight();
  assert.deepEqual(strip(h), PARA);
  // Outside the highlight the page is dimmed (white -> 70 %), inside it is not.
  const [r] = h.shot.at(40 * 2, 400 * 2);
  assert.ok(r >= 176 && r <= 181, `dimmed outside: ${r}`);
  const inside = h.shot.at(300 * 2, 190 * 2);
  assert.ok(inside[0] > 225 && inside[2] === 255, `light tint inside: ${inside}`);

  await g.key("ArrowUp");
  assert.deepEqual(strip(await highlight()), CARD);
  await g.key("ArrowDown");
  assert.deepEqual(strip(await highlight()), PARA);
  await g.key("Escape");
});

for (const [name, url] of [
  ["about:addons", "about:addons"],
  ["view-source:", null],
]) {
  // The popup says why inside itself (tests/glue/popup.test.mjs); the shortcut has only the button.
  test(`item 10: ${name} cannot be captured: the shortcut puts badge "×" with a reason, no console error`, async () => {
    await g.open(url ?? `view-source:${g.base}${PAGE}`);
    const t0 = Date.now();
    await g.trigger("shortcut");
    const flagged = await g.until(async () => {
      const a = await g.action();
      return a.badge === "×" ? a : null;
    }, "the error badge");
    assert.match(flagged.title, /^snapii cannot capture this page: /);
    await sleep(500);
    assert.deepEqual(await g.consoleErrors(t0), []);
    // The badge is a 3 s notice, then the global state returns.
    await g.until(async () => !(await g.action()).badge, "the badge to clear", 6000);
    console.log(`item 10 ${name}: title "${flagged.title}"`);
  });
}

test("item 11: strict CSP page (HTTP header style-src/script-src 'none') -> overlay styled, save works", async () => {
  await g.open("/glue/fixtures/csp.html");
  // Guards: the header is in force (the page's own <style> and <script> are blocked).
  const guard = await g.content(`return {
    title: document.title,
    background: getComputedStyle(document.documentElement).backgroundColor,
    probe: document.documentElement.getAttribute("data-csp-probe"),
  };`);
  assert.equal(guard.title, "snapii glue csp");
  assert.notEqual(guard.background, "rgb(255, 0, 0)");
  // The finding: which styling path works from the content-script (Xray) world.
  const probe = JSON.parse(guard.probe);
  console.log(`item 11 probe: ${JSON.stringify(probe)}`);
  assert.equal(probe.adoptedAssign, "ok");
  assert.equal(probe.adoptedCount, 1);
  assert.equal(probe.adoptedColor, "rgb(1, 2, 3)");
  // Measured on Fx157: the fallback <style> element added by a content script
  // also applies despite style-src 'none' (the page's own <style> does not,
  // see the guard). Recorded, not required: adoptStyles() uses the
  // constructed sheet first, and that path is the one asserted above.
  console.log(
    `item 11 fallback <style> from the content script applies: ${probe.styleElementColor === "rgb(4, 5, 6)"}`,
  );

  await g.startOverlay();
  const block = await g.rect("#block");
  await g.move(block.x + 20, block.y + 10);
  const h = await highlight();
  assert.ok(h, "no highlight border drawn: overlay unstyled");
  for (const k of ["x", "y", "width", "height"])
    assert.ok(Math.abs(h[k] - block[k]) <= 0.5, `${k}: ${h[k]} vs ${block[k]}`);
  const [r] = h.shot.at(
    Math.round((block.x + block.width / 2) * 2),
    Math.round((block.y + block.height + 40) * 2),
  );
  assert.ok(r >= 176 && r <= 181, `dimmed outside: ${r}`);

  const before = g.svgFiles();
  await g.click(block.x + 20, block.y + 10);
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.match(file.svg.tspans.join(""), /First line.*fourth line/s);
});

for (const [what, file, root] of [
  ["an SVG document opened directly", "doc.svg", ["http://www.w3.org/2000/svg", "svg"]],
  ["an XHTML document whose root is not <html>", "span-root.xhtml", ["http://www.w3.org/1999/xhtml", "span"]],
]) {
  test(`${what} is refused: the shortcut puts badge "×" with a reason, no overlay host`, async () => {
    await g.open(`/glue/fixtures/${file}`);
    // Guard: Firefox really made a document with that root of it.
    assert.deepEqual(
      await g.content("const r = document.documentElement; return [r.namespaceURI, r.localName];"),
      root,
    );
    const t0 = Date.now();
    await g.trigger("shortcut");
    const flagged = await g.until(async () => {
      const a = await g.action();
      return a.badge === "×" ? a : null;
    }, "the error badge");
    assert.equal(flagged.title, "snapii cannot capture this page: snapii works on HTML pages only");
    await sleep(500);
    assert.equal(await g.overlayPresent(), 0);
    assert.deepEqual(await g.consoleErrors(t0), []);
    await g.until(async () => !(await g.action()).badge, "the badge to clear", 6000);
  });
}
