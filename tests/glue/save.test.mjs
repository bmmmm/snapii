// SPDX-License-Identifier: GPL-3.0-or-later
// Manual checklist items 3, 4, 12 and 13 (tests/MANUAL-CHECKLIST.md): a real
// save through the shortcut -> overlay -> background capture -> download,
// then the file itself is checked, and for item 3 opened in Firefox. Item 12
// also carries the M3 pass: dc:source is the text-fragment URL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { decodeDataUrl, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
// Document CSS px, see tests/glue/fixtures/page.html.
const SWATCH = { x: 700, y: 100, width: 300, height: 200 };
const SWATCH_RGB = [200, 100, 50];
const BORDER = [10, 132, 255];

let g;
before(async () => {
  g = await startGlue(1);
});
after(async () => {
  await g?.close();
});

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const words = (tspans) => tspans.join("").replace(/\s+/g, " ");

/** Element pick at a client point, then Enter (= Save SVG); resolves with the downloaded file. */
async function saveElementAt(x, y) {
  const before = g.svgFiles();
  await g.startOverlay();
  await g.move(x, y);
  await g.click(x, y);
  await g.key("Enter");
  return g.newDownload(before);
}

test("item 3: element save -> .svg in the download dir; opened in Firefox, select-all has the text, links open", async () => {
  await g.open("/fixtures/inline-links.html");
  const cap = await g.rect("#cap");
  const p = await g.rect("#cap p");
  const file = await saveElementAt(p.x + 10, p.y + p.height / 2);
  assert.match(file.name, /^snapii inline-links \d{4}-\d\d-\d\d \d\d-\d\d-\d\d( ?\(\d+\))?\.svg$/);
  // The paragraphs are below the 30 px minimum height, so <main id="cap"> is picked.
  assert.deepEqual(file.svg.capture.selection, { mode: "element", ...cap });

  await g.open(pathToFileURL(file.path).href);
  assert.equal(await g.content("return document.documentElement.localName;"), "svg");
  // Real select-all (Cmd+A on macOS) in the opened SVG.
  await g.key("a", ["Meta"]);
  const selected = (await g.content("return getSelection().toString();")).replace(/\s+/g, " ");
  assert.ok(selected.includes("Read the docs or external."), `select-all text: ${selected}`);
  assert.ok(selected.includes("Keep highlight and mail."), `select-all text: ${selected}`);
  const hrefs = await g.content(
    `return [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));`,
  );
  for (const h of [`${g.base}/docs/a.html`, "https://example.org/x", "mailto:x@example.org"]) {
    assert.ok(hrefs.includes(h), `missing link ${h} in ${hrefs}`);
  }
  // Click the transparent text of "the docs" in the opened file: the link navigates.
  const link =
    await g.content(`const a = [...document.querySelectorAll("a")].find((e) => e.getAttribute("href").endsWith("/docs/a.html"));
     const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await g.click(link.x, link.y);
  await g.until(
    async () => (await g.content("return location.href;")) === `${g.base}/docs/a.html`,
    "the link to navigate",
  );
});

test("item 4: drag across two paragraphs -> the SVG text has both", async () => {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.drag(110, 110, 560, 300);
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.deepEqual(file.svg.capture.selection, { mode: "drag", x: 110, y: 110, width: 450, height: 190 });
  const text = words(file.svg.tspans);
  assert.ok(text.includes("First glue paragraph with a first link inside."), text);
  assert.ok(text.includes("Second glue paragraph, plain text."), text);
  assert.ok(file.svg.hrefs.includes(`${g.base}/glue/target/one`), String(file.svg.hrefs));
});

test("item 12: metadata (dc:source, dc:date, capture JSON) is in the saved file", async () => {
  await g.open(PAGE);
  const t0 = new Date();
  const file = await saveElementAt(310, 290); // inside #card, below both paragraphs
  const t1 = new Date();
  const { dc, capture } = file.svg;
  const url = `${g.base}${PAGE}`;
  // dc:source is the text-fragment URL of the selection, dc:relation the plain one.
  assert.ok(dc.source.startsWith(`${url}#:~:text=`), dc.source);
  assert.equal(dc.relation, url);
  assert.equal(dc.title, "snapii glue page");
  assert.equal(dc.language, "en");
  const date = new Date(dc.date);
  assert.ok(
    date >= new Date(t0.getTime() - 1000) && date <= t1,
    `dc:date ${dc.date} not in [${t0.toISOString()}, ${t1.toISOString()}]`,
  );
  assert.equal(capture.url, url);
  assert.equal(capture.capturedAt, dc.date);
  assert.equal(capture.extensionVersion, "0.2.0");
  assert.equal(capture.textFragmentStatus, "SUCCESS");
  assert.equal(capture.textFragmentURL, dc.source);
  assert.deepEqual(capture.selection, { mode: "element", x: 100, y: 100, width: 500, height: 200 });
  assert.equal(capture.devicePixelRatio, 2);
  assert.deepEqual(capture.viewport, { width: 1280, height: 715 });
  assert.deepEqual(capture.tiles, [
    { rect: { x: 0, y: 0, width: 500, height: 200 }, pixelWidth: 1000, pixelHeight: 400, format: "png" },
  ]);
  assert.match(file.text, /<desc>Region of http:\/\/127\.0\.0\.1:\d+\/glue\/fixtures\/page\.html captured /);
});

test("item 13: neither the overlay nor a hover state is in the raster (flat colour region stays exactly that colour)", async () => {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  const c = center(SWATCH);
  await g.move(c.x, c.y);
  await g.click(c.x, c.y);
  // Guard: on screen the selection box (border + tint) lies over the swatch,
  // so a capture that saw the overlay could not stay one flat colour.
  // (Device px at DPR 2; the toolbar below has the same blue, so single
  // border pixels are checked instead of the colour's bounds.)
  const shot = await g.screenshot();
  const px = (x, y) => shot.at(x, y).slice(0, 3);
  for (const [x, y] of [
    [1400, 400],
    [1999, 400],
    [1700, 200],
    [1700, 599],
  ]) {
    // ±3: the toolbar's drop shadow just reaches the bottom edge.
    const p = px(x, y);
    assert.ok(
      p.every((v, i) => Math.abs(v - BORDER[i]) <= 3),
      `border at ${x},${y}: ${p}`,
    );
  }
  assert.notDeepEqual(px(1700, 400), SWATCH_RGB);
  console.log(`item 13: on screen the swatch centre is rgb(${px(1700, 400)}) under the selection box`);
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.equal(file.svg.images.length, 1);
  const img = await decodeDataUrl(file.svg.images[0].href);
  assert.equal(img.width, 600);
  assert.equal(img.height, 400);
  const { off, total } = img.countOff({ x: 0, y: 0, width: img.width, height: img.height }, SWATCH_RGB);
  console.log(`item 13: ${off} of ${total} px differ from rgb(${SWATCH_RGB})`);
  assert.equal(off, 0);
});

test("item 12 / M3 pass: on a normal article, dc:source is the paragraph's text-fragment URL, status SUCCESS", async () => {
  await g.open("/glue/fixtures/article.html");
  const lead = await g.rect("#lead");
  const file = await saveElementAt(lead.x + 10, lead.y + lead.height / 2);
  const { dc, capture } = file.svg;
  const url = `${g.base}/glue/fixtures/article.html`;
  console.log(`item 12 M3: dc:source ${dc.source}`);
  assert.deepEqual(capture.selection, { mode: "element", ...lead });
  assert.ok(dc.source.startsWith(`${url}#:~:text=`), dc.source);
  // The passage's opening words, lower-cased by the generator.
  assert.ok(dc.source.includes("quartz%20is%20a%20hard"), dc.source);
  assert.equal(dc.relation, url);
  assert.equal(capture.url, url);
  assert.equal(capture.textFragmentStatus, "SUCCESS");
  assert.equal(capture.textFragmentURL, dc.source);
});
