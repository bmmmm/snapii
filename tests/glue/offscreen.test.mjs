// SPDX-License-Identifier: GPL-3.0-or-later
// Manual checklist items 5 and 7 (tests/MANUAL-CHECKLIST.md): regions partly
// or fully outside the viewport (D1: captureVisibleTab honours an
// off-viewport rect) and page zoom (D2: px = floor(rect x scale x zoom),
// scale = devicePixelRatio = 2 here). The <image> geometry is always the CSS
// rect; the real pixel size is in the metadata JSON and in the PNG itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decodeDataUrl, startGlue } from "./env.mjs";

const PAGE = "/glue/fixtures/page.html";
// Document CSS px, see tests/glue/fixtures/page.html.
const BELOW = { x: 100, y: 3000, width: 600, height: 400 };
const BELOW_RGB = [60, 140, 90];
// Below the block's 64 px paragraph (which would be picked itself), still inside the viewport at scrollY 2500.
const BELOW_PICK_Y = 150;
const CARD = { x: 100, y: 100, width: 500, height: 200 };

let g;
before(async () => {
  g = await startGlue(2);
});
after(async () => {
  await g?.close();
});

/** Element pick at a client point; `between` runs after the pick, before Enter. */
async function saveElementAt(x, y, between = async () => {}) {
  const before = g.svgFiles();
  await g.startOverlay();
  await g.move(x, y);
  await g.click(x, y);
  await between();
  await g.key("Enter");
  return g.newDownload(before);
}

/** Checks the below-the-fold save: geometry, pixel size, content of the raster, text. */
async function checkBelow(file, scrollY) {
  const { capture, images, tspans } = file.svg;
  assert.equal(capture.scroll.y, scrollY);
  assert.deepEqual(capture.selection, { mode: "element", ...BELOW });
  assert.equal(images.length, 1);
  assert.deepEqual(
    { x: images[0].x, y: images[0].y, width: images[0].width, height: images[0].height },
    { x: 0, y: 0, width: BELOW.width, height: BELOW.height },
  );
  const tile = capture.tiles[0];
  assert.deepEqual([tile.pixelWidth, tile.pixelHeight], [BELOW.width * 2, BELOW.height * 2]);
  const img = await decodeDataUrl(images[0].href);
  assert.deepEqual([img.width, img.height], [tile.pixelWidth, tile.pixelHeight]);
  // All four corners are the block's own colour: the off-viewport part was
  // really rendered, not left transparent or filled from the visible area.
  for (const [x, y] of [
    [2, 2],
    [img.width - 3, 2],
    [2, img.height - 3],
    [img.width - 3, img.height - 3],
  ]) {
    assert.deepEqual(img.at(x, y).slice(0, 3), BELOW_RGB, `pixel ${x},${y}`);
  }
  assert.ok(tspans.join("").includes("Below the fold text."), tspans.join("|"));
  return `${tile.pixelWidth}x${tile.pixelHeight} px for ${BELOW.width}x${BELOW.height} CSS px at scrollY ${scrollY}`;
}

test("item 5a: selection partly below the viewport -> full raster at rect x 2, text present", async () => {
  await g.open(PAGE);
  await g.scrollTo(2500); // #below now spans client y 500–900 in a 715 px viewport
  const r = await g.rect("#below");
  assert.ok(r.y < 715 && r.y + r.height > 715, `straddles the fold: ${JSON.stringify(r)}`);
  const file = await saveElementAt(r.x + 50, r.y + BELOW_PICK_Y);
  console.log(`item 5a: ${await checkBelow(file, 2500)}`);
});

test("item 5b: selection scrolled fully out of the viewport before saving -> same result", async () => {
  await g.open(PAGE);
  await g.scrollTo(2500);
  const r = await g.rect("#below");
  const file = await saveElementAt(r.x + 50, r.y + BELOW_PICK_Y, () => g.scrollTo(0));
  console.log(`item 5b: ${await checkBelow(file, 0)}`);
});

for (const zoom of [1.5, 0.8]) {
  test(`item 7: page zoom ${zoom * 100} % -> <image> = CSS rect, pixels = floor(rect x 2 x ${zoom})`, async () => {
    await g.open(PAGE);
    try {
      await g.setZoom(zoom);
      const dpr = await g.content("return window.devicePixelRatio;");
      // The page's own value is quantised by Gecko's app units at 80 % (spike S6).
      assert.ok(Math.abs(dpr - 2 * zoom) < 0.05, `page devicePixelRatio ${dpr}`);
      const card = await g.rect("#card");
      // Inside #card but below both paragraphs: the card itself is picked.
      const file = await saveElementAt(card.x + 210, card.y + 190);
      const { capture, images } = file.svg;
      assert.deepEqual(capture.selection, { mode: "element", ...CARD });
      assert.equal(capture.zoom, zoom);
      assert.equal(capture.scale, 2);
      assert.deepEqual(
        { x: images[0].x, y: images[0].y, width: images[0].width, height: images[0].height },
        { x: 0, y: 0, width: CARD.width, height: CARD.height },
      );
      const tile = capture.tiles[0];
      const expected = [Math.floor(CARD.width * 2 * zoom), Math.floor(CARD.height * 2 * zoom)];
      assert.deepEqual([tile.pixelWidth, tile.pixelHeight], expected);
      const img = await decodeDataUrl(images[0].href);
      assert.deepEqual([img.width, img.height], expected);
      console.log(
        `item 7 zoom ${zoom}: page DPR ${dpr}, <image> ${images[0].width}x${images[0].height}, PNG ${img.width}x${img.height}`,
      );
    } finally {
      await g.setZoom(1);
    }
  });
}
