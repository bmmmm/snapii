// SPDX-License-Identifier: GPL-3.0-or-later
// A real save in Chromium: toolbar popup -> overlay -> service worker capture
// -> download, then the file itself is checked. Chromium takes the viewport
// only (C2/C5 in src/shared/spike.ts), so the picture is one tile at the
// screen's density and a selection beyond the viewport is not saved.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { boundsOf, decodeDataUrl, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
// Document CSS px, see tests/glue/fixtures/page.html.
const SWATCH = { x: 700, y: 100, width: 300, height: 200 };
const SWATCH_RGB = [200, 100, 50];
const NOTICE =
  "Only what is visible can be saved in this browser. Scroll the selection fully into view or select a smaller area";

let g;
before(async () => {
  g = await startGlue(1);
});
after(async () => {
  await g?.close();
});

/** Element pick at a client point, then Enter (= Save SVG); resolves with the downloaded file. */
async function saveElementAt(x, y) {
  const before = g.svgFiles();
  await g.startOverlay();
  await g.click(x, y);
  await g.key("Enter");
  return g.newDownload(before);
}

test("element save: an .svg in the download folder with the picture at the screen's density, the text and the record", async () => {
  await g.open(PAGE);
  const file = await saveElementAt(130, 150);
  assert.match(file.name, /^snapii snapii glue page \d{4}-\d\d-\d\d \d\d-\d\d-\d\d( ?\(\d+\))?\.svg$/);
  assert.equal(await g.until(() => g.toast(), "the toast"), `Saved ${file.name}`);

  const { capture, images, tspans, hrefs } = file.svg;
  assert.deepEqual(capture.selection, { mode: "element", x: 120, y: 120, width: 400, height: 80 });
  assert.deepEqual(tspans.join("").replace(/\s+/g, " ").trim(), "First glue paragraph with a first link inside.");
  assert.deepEqual(hrefs, [`${g.base}/glue/target/one`]);
  // Device scale factor 2 at zoom 1: two device px per CSS px, none of it zoom.
  assert.equal(capture.zoom, 1);
  assert.equal(capture.scale, 2);
  assert.deepEqual(capture.tiles, [
    { rect: { x: 0, y: 0, width: 400, height: 80 }, pixelWidth: 800, pixelHeight: 160, format: "png" },
  ]);
  assert.equal(images.length, 1);
  const tile = await decodeDataUrl(images[0].href);
  assert.deepEqual([tile.width, tile.height], [800, 160]);
});

test("drag over the swatch: the picture is the page's pixels, without overlay, box or hover state", async () => {
  await g.open(PAGE);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.drag(SWATCH.x - 20, SWATCH.y - 20, SWATCH.x + SWATCH.width + 20, SWATCH.y + SWATCH.height + 20);
  await g.clickToolbar("save");
  const file = await g.newDownload(before);
  const tile = await decodeDataUrl(file.svg.images[0].href);
  // The swatch in device px inside the 340 x 240 region.
  assert.deepEqual(boundsOf(tile, SWATCH_RGB), { x: 40, y: 40, width: 600, height: 400 });
  // Around it only the white page: no selection border, no dimming.
  assert.deepEqual(tile.at(4, 4).slice(0, 3), [255, 255, 255]);
  assert.deepEqual(tile.at(tile.width - 5, tile.height - 5).slice(0, 3), [255, 255, 255]);
});

test("zoom 150 %: three device px per CSS px, recorded as scale 2 at zoom 1.5", async () => {
  await g.open(PAGE);
  await g.setZoom(1.5);
  try {
    const p = await g.rect("#para");
    const file = await saveElementAt(p.x + 10, p.y + p.height / 2);
    const { capture, images } = file.svg;
    assert.equal(capture.zoom, 1.5);
    assert.equal(capture.scale, 2);
    assert.equal(capture.devicePixelRatio, 3);
    const tile = await decodeDataUrl(images[0].href);
    assert.deepEqual([tile.width, tile.height], [1200, 240]);
  } finally {
    await g.setZoom(1);
  }
});

test("a selection reaching beyond the viewport: Save says why and does nothing; scrolled into view it saves", async () => {
  await g.open(PAGE);
  // #below spans document y 3000 to 3400; its upper part is above the viewport.
  await g.scrollTo(3200);
  const before = g.svgFiles();
  await g.startOverlay();
  await g.click(400, 100);
  const save = (await g.toolbar()).find((b) => b.action === "save");
  assert.deepEqual([save.unavailable, save.title], [true, NOTICE]);
  assert.equal(await g.hint(), NOTICE);
  await g.clickToolbar("save");
  await g.key("Enter");
  assert.equal(await g.overlayPresent(), true);
  assert.deepEqual(g.svgFiles(), before);

  await g.scrollTo(2900);
  await g.until(async () => !(await g.toolbar()).find((b) => b.action === "save")?.unavailable, "Save to be available");
  await g.key("Enter");
  const file = await g.newDownload(before);
  assert.deepEqual(file.svg.capture.selection, { mode: "element", x: 100, y: 3000, width: 600, height: 400 });
  assert.equal(file.svg.capture.scroll.y, 2900);
  assert.ok(file.svg.tspans.join("").includes("Below the fold text."));
});

test("the folder and JPEG settings: the file lands in the sub-folder with a JPEG picture", async () => {
  await g.setSettings({ saveFolder: "Pages/snapii", format: "jpeg" });
  try {
    await g.open(PAGE);
    const file = await saveElementAt(130, 150);
    assert.match(file.name, /^Pages\/snapii\/snapii snapii glue page [^/]+\.svg$/);
    assert.equal(file.svg.capture.tiles[0].format, "jpeg");
    assert.match(file.svg.images[0].href, /^data:image\/jpeg;base64,/);
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

test("Ask where to save, dialog cancelled: the page says the SVG was not saved, and no file exists", async () => {
  // Headless Chromium has no file dialog: every saveAs download ends as a
  // cancelled one (C16 in src/shared/spike.ts), which is the case under test.
  await g.setSettings({ saveAs: true });
  try {
    await g.open(PAGE);
    const before = g.svgFiles();
    await g.startOverlay();
    await g.click(130, 150);
    await g.key("Enter");
    assert.equal(
      await g.until(() => g.toast(), "the toast"),
      "The SVG was not saved (download failed or was cancelled)",
    );
    assert.deepEqual(g.svgFiles(), before);
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

const VECTOR_NOTICE =
  "Parts of this selection that are saved as pixels are outside the visible area. Scroll them into view or select a smaller area";
/** Puts a 40 x 30 red box with a filter (a patch in vector output) at the start of `selector`. */
async function addPatch(selector) {
  await g.content(`
    const box = document.createElement("div");
    box.style.cssText = "width:40px;height:30px;background:#c00;filter:opacity(1)";
    document.querySelector(${JSON.stringify(selector)}).prepend(box);
  `);
  await g.frames();
}

test("vector output: shapes and visible text, no patch, and the overlay (closed shadow root, shadowed box) left out", async () => {
  await g.setSettings({ output: "vector" });
  try {
    await g.open(PAGE);
    const file = await saveElementAt(130, 150);
    const { capture } = file.svg;
    assert.equal(capture.output, "vector");
    assert.deepEqual(capture.scene, { ops: capture.scene.ops, patches: 0, patchArea: 0, unsupported: {} });
    assert.deepEqual(capture.tiles, []);
    assert.equal(capture.scale, 2);
    assert.equal(file.svg.images.length, 0);
    assert.match(file.text, /<text [^>]*fill="rgb\(0,0,0\)"[^>]*>First glue paragraph with a <\/text>/);
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

test("vector output beyond the viewport: without patches the selection saves (Save is not held back)", async () => {
  await g.setSettings({ output: "vector" });
  try {
    await g.open(PAGE);
    await g.scrollTo(3200);
    const before = g.svgFiles();
    await g.startOverlay();
    await g.click(400, 100);
    const save = (await g.toolbar()).find((b) => b.action === "save");
    assert.equal(save.unavailable, false);
    await g.key("Enter");
    const file = await g.newDownload(before);
    assert.deepEqual(file.svg.capture.selection, { mode: "element", x: 100, y: 3000, width: 600, height: 400 });
    assert.equal(file.svg.capture.scene.patches, 0);
    assert.ok(file.svg.tspans.join("").includes("Below the fold text."));
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

test("vector output with a patch beyond the viewport: the toast says so and nothing is saved; in view, one capture", async () => {
  await g.setSettings({ output: "vector" });
  try {
    await g.open(PAGE);
    await addPatch("#below");
    // The box sits at the top of #below (document y 3000), above the viewport.
    await g.scrollTo(3200);
    const before = g.svgFiles();
    await g.startOverlay();
    await g.click(400, 100);
    await g.key("Enter");
    assert.equal(await g.until(() => g.toast(), "the toast"), VECTOR_NOTICE);
    assert.equal(await g.overlayPresent(), true);
    assert.deepEqual(g.svgFiles(), before);
    await g.key("Escape");

    await g.scrollTo(2900);
    // #below in client px now: 100,100 to 700,500.
    await g.startOverlay();
    await g.drag(100, 100, 700, 500);
    await g.clickToolbar("save");
    const file = await g.newDownload(before);
    const { capture, images } = file.svg;
    assert.deepEqual(capture.selection, { mode: "drag", x: 100, y: 3000, width: 600, height: 400 });
    assert.equal(capture.scene.unsupported.effect, 1);
    assert.equal(capture.tiles.length, 1);
    assert.equal(capture.tiles[0].pixelWidth, 80);
    const tile = await decodeDataUrl(images[0].href);
    assert.deepEqual(tile.at(40, 30).slice(0, 3), [204, 0, 0]);
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

test("vector output with pictures read in the content script: drawn where the page could read them, patches where not", async () => {
  await g.setSettings({ output: "vector" });
  try {
    await g.open("/fixtures/vector-images.html");
    const p = await g.rect("#cap p");
    const file = await saveElementAt(p.x + 10, p.y + p.height / 2);
    const { capture, images } = file.svg;
    // As in the page's own context (vector.spec.ts): the picture from the other
    // origin, the canvas it tainted, the blank canvas, the missing image and
    // the calc() positions are patches.
    assert.deepEqual(capture.scene.unsupported, { image: 4, canvas: 2 });
    assert.equal(capture.tiles.length, capture.scene.patches);
    // The pictures come first (the shapes layer), at the screen's density at most.
    const pictures = images.slice(0, images.length - capture.tiles.length);
    assert.equal(pictures.length, 14);
    // At the screen's density, as a raster capture of the area holds it: the
    // 160 x 80 PNG shown at 80 x 40, and shown stretched to 220 x 24 (more
    // pixels than it has across), as is the 220 x 24 canvas.
    const sizeOf = async (w, h) =>
      Promise.all(
        pictures
          .filter((im) => im.width === w && im.height === h)
          .map(async (im) => {
            const png = await decodeDataUrl(im.href);
            return [png.width, png.height];
          }),
      );
    assert.deepEqual(await sizeOf(80, 40), [[160, 80]]);
    assert.deepEqual(await sizeOf(220, 24), [
      [440, 48],
      [440, 48],
    ]);
    for (const im of pictures) {
      const png = await decodeDataUrl(im.href);
      assert.ok(
        png.width <= Math.ceil(im.width * 2) + 1 && png.height <= Math.ceil(im.height * 2) + 1,
        `${png.width}x${png.height} for ${im.width}x${im.height}`,
      );
    }
  } finally {
    await g.background(() => chrome.storage.sync.clear());
  }
});

test("text in a closed shadow tree is in the text layer", async () => {
  await g.open(PAGE);
  await g.content(`
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:120px;top:400px;width:400px;height:60px";
    host.attachShadow({ mode: "closed" }).innerHTML = "<p style='margin:0'>Closed shadow text.</p>";
    document.body.append(host);
  `);
  await g.frames();
  const file = await saveElementAt(130, 410);
  assert.ok(file.svg.tspans.join("").includes("Closed shadow text."), file.svg.tspans.join("|"));
});
