// SPDX-License-Identifier: GPL-3.0-or-later
// M4 size measurement (README "File size"): a full-viewport selection of two
// generated pages (text only; a photo-like hero image above the text), each
// saved once as PNG (the default) and once as JPEG (quality 0.92, the default,
// switched on by clicking the options page like options.test.mjs does).
// Prints rect, device px and file sizes as test diagnostics (run with
// `--test-reporter=spec` to see them) and asserts sanity bounds, not exact
// byte counts: the numbers move with the font rasteriser and the Firefox
// build. JPEG is only required to win on the page with the photo: on text
// over white it does not (measured, see the README).
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { after, before, test } from "node:test";
import { ADDON_ID, startGlue } from "./env.mjs";

const MB = 1024 * 1024;
const LIMIT = 20 * MB;
// Any page of the fixture server will do: buildPage replaces its content.
const BASE_PAGE = "/glue/fixtures/article.html";

let g;
let optionsUrl;
before(async () => {
  g = await startGlue(7);
  const host = await g.s.chrome(
    "return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;",
    ADDON_ID,
  );
  optionsUrl = `moz-extension://${host}/options.html`;
});
after(async () => {
  await g?.close();
});

/**
 * A generated page, built in the page (it is serialised with toString, so it
 * must stay self-contained): a dark header band with links, optionally a
 * 360 px photo-like hero (seeded blobs and fine noise on a canvas at device
 * resolution), then three columns of headings and prose in a sans-serif
 * system font, i.e. lots of antialiased glyphs on white.
 */
function buildPage(photo) {
  const sentences = [
    "Quartz is a hard, crystalline mineral composed of silica.",
    "The crystals grow as six-sided prisms that end in six-sided pyramids.",
    "Many varieties are prized as gemstones, from amethyst to citrine.",
    "Piezoelectric oscillators keep the time in nearly every wristwatch.",
    "A thin slice of the crystal vibrates at a very stable frequency.",
    "Weathering breaks the rock down, and the grains travel with the rivers.",
    "Sand on most beaches is mostly quartz because it resists both water and chemistry.",
    "Glassmakers have melted it for thousands of years to make vessels and lenses.",
    "In the laboratory a single crystal can be grown in weeks inside a pressurised vessel.",
    "Collectors value clarity, colour and the absence of inclusions above everything else.",
    "The mineral is named in old sources after the German word for hard.",
    "Fine grains of it polish stone, metal and glass without leaving deep scratches.",
  ];
  const paragraph = (i) =>
    Array.from({ length: 4 + (i % 3) }, (_, k) => sentences[(i * 5 + k * 7) % sentences.length]).join(" ");
  const sections = Array.from(
    { length: 24 },
    (_, i) => `<h2>Section ${i + 1}: notes on quartz</h2><p>${paragraph(i)}</p><p>${paragraph(i + 11)}</p>`,
  ).join("");
  document.title = photo ? "snapii sizes text and photo page" : "snapii sizes text page";
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style>
      html, body { margin: 0; background: #fff; }
      body { font: 15px/1.55 system-ui, sans-serif; color: #1a1a1a; }
      header { background: #1f2933; color: #fff; padding: 18px 32px; height: 28px; display: flex; gap: 28px; }
      header strong { font-size: 20px; margin-right: auto; }
      header a { color: #9fd3ff; }
      canvas { display: block; width: 1280px; height: 360px; }
      main { columns: 3; column-gap: 40px; padding: 24px 32px; }
      h2 { font-size: 17px; margin: 0 0 6px; color: #0b4f8a; break-after: avoid; }
      p { margin: 0 0 16px; }
    </style>`,
  );
  document.body.innerHTML = `<header><strong>The Quartz Weekly</strong><a href="/a">News</a><a href="/b">Minerals</a><a href="/c">About</a></header>${photo ? "<canvas width=2560 height=720></canvas>" : ""}<main>${sections}</main>`;
  if (!photo) return;
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  let seed = 20261001;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  ctx.fillStyle = "#3b6b8c";
  ctx.fillRect(0, 0, 2560, 720);
  for (let i = 0; i < 500; i++) {
    const x = rnd() * 2560;
    const y = rnd() * 720;
    const r = 30 + rnd() * 220;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = `${Math.floor(rnd() * 255)}, ${Math.floor(rnd() * 255)}, ${Math.floor(rnd() * 255)}`;
    grad.addColorStop(0, `rgba(${c}, 0.45)`);
    grad.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const img = ctx.getImageData(0, 0, 2560, 720);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = Math.floor(rnd() * 13) - 6;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Saves the whole viewport as a drag selection and returns the file with its sizes. */
async function saveViewport(photo) {
  await g.open(BASE_PAGE);
  await g.content(`(${buildPage.toString()})(${photo});`);
  await g.frames();
  const before = g.svgFiles();
  await g.startOverlay();
  // Pointer positions are inside the 1280x715 viewport: the last pixel is 1279x714.
  await g.drag(0, 0, 1279, 714);
  await g.key("Enter");
  const file = await g.newDownload(before);
  const bytes = statSync(file.path).size;
  const { capture, images } = file.svg;
  const [tile] = capture.tiles;
  // The <image> payload without the base64 inflation (4 bytes per 3).
  const b64 = images[0].href.slice(images[0].href.indexOf(",") + 1);
  const imageBytes = Math.floor((b64.length * 3) / 4);
  return { file, bytes, imageBytes, capture, tile };
}

const mb = (n) => (n / MB).toFixed(2);

function report(t, label, m) {
  const { selection, devicePixelRatio, runCount } = m.capture;
  t.diagnostic(
    `${label}: selection ${selection.width}x${selection.height} CSS px @${selection.x},${selection.y}, ` +
      `DPR ${devicePixelRatio}, tile ${m.tile.pixelWidth}x${m.tile.pixelHeight} device px (${m.tile.format}), ` +
      `${runCount} text runs, SVG ${m.bytes} bytes (${mb(m.bytes)} MiB), image payload ${m.imageBytes} bytes (${mb(m.imageBytes)} MiB)`,
  );
}

function checkViewportSelection(m, format) {
  const { selection, devicePixelRatio, tiles, runCount } = m.capture;
  assert.equal(selection.mode, "drag");
  assert.equal(devicePixelRatio, 2);
  // The whole viewport (1280x715), give or take the last pixel the pointer cannot reach.
  assert.ok(selection.width >= 1279 && selection.height >= 714, JSON.stringify(selection));
  assert.equal(tiles.length, 1);
  assert.equal(m.tile.format, format);
  assert.equal(m.tile.pixelWidth, selection.width * 2);
  assert.equal(m.tile.pixelHeight, selection.height * 2);
  // Real text came along, so the size is that of a text page and not of a blank one.
  assert.ok(runCount > 20, `runCount ${runCount}`);
  assert.ok(m.file.svg.images[0].href.startsWith(`data:image/${format};base64,`));
  assert.ok(m.bytes < LIMIT, `${m.bytes} bytes`);
}

test("full-viewport selection at DPR 2: PNG and JPEG 0.92, text page and text + photo page", async (t) => {
  const png = { text: await saveViewport(false), photo: await saveViewport(true) };
  report(t, "PNG, text page", png.text);
  report(t, "PNG, text + photo page", png.photo);
  checkViewportSelection(png.text, "png");
  checkViewportSelection(png.photo, "png");

  // The options page, with a real click on the JPEG radio (as options.test.mjs does); quality stays at its default 0.92.
  await g.open(optionsUrl);
  const r = await g.rect('input[name="format"][value="jpeg"]');
  await g.click(r.x + r.width / 2, r.y + r.height / 2);
  await g.until(
    async () => (await g.content(`return document.getElementById("status").textContent;`)) === "Saved",
    "the Saved status",
  );
  const jpeg = { text: await saveViewport(false), photo: await saveViewport(true) };
  report(t, "JPEG 0.92, text page", jpeg.text);
  report(t, "JPEG 0.92, text + photo page", jpeg.photo);
  checkViewportSelection(jpeg.text, "jpeg");
  checkViewportSelection(jpeg.photo, "jpeg");

  for (const page of ["text", "photo"]) {
    assert.deepEqual(
      jpeg[page].capture.selection,
      png[page].capture.selection,
      `both formats must select the same region of the ${page} page for the comparison to mean anything`,
    );
  }
  // Not asserted for the text page: JPEG is not smaller there (see the README).
  assert.ok(
    jpeg.photo.bytes < png.photo.bytes,
    `JPEG ${jpeg.photo.bytes} B is not smaller than PNG ${png.photo.bytes} B on the photo page`,
  );
});
