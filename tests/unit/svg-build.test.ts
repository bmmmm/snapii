// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rasterTextRenderer, renderTextLayer } from "../../src/shared/svg/build.ts";
import type { LinkArea, RasterTile, RenderInput, TextRun } from "../../src/shared/types.ts";
import { attr, byId, elements, isSeparator, named, parseXml, textOf, type XEl } from "./xml-reader.ts";

// ---- fixture ----

const HEBREW = "\u05e9\u05dc\u05d5\u05dd";
const URL_WORLD = "https://example.com/world?a=1&b=2";

function makeRun(over: Partial<TextRun>): TextRun {
  return {
    text: "x",
    x: 0,
    y: 16,
    top: 2,
    width: 10,
    height: 18,
    fontFamily: "serif",
    fontSize: 16,
    fontWeight: 400,
    fontStyle: "normal",
    color: "rgb(0, 0, 0)",
    lang: null,
    dir: "ltr",
    href: null,
    line: 0,
    block: 0,
    ...over,
  };
}

const RUN_HELLO = makeRun({
  text: "Hello ",
  x: 10,
  y: 24.5,
  top: 10,
  width: 38.25,
  fontFamily: '"Helvetica Neue", Arial, sans-serif',
  color: "rgb(20, 20, 20)",
  lang: "en",
  line: 0,
});
const RUN_WORLD = makeRun({
  text: "world",
  x: 48.25,
  y: 24.5,
  top: 10,
  width: 33.126,
  href: URL_WORLD,
  line: 0,
});
const RUN_FRENCH = makeRun({
  text: "Bonjour",
  x: 10,
  y: 52,
  top: 38,
  width: 60.333,
  fontWeight: 700,
  fontStyle: "italic",
  lang: "fr",
  line: 1,
});
const RUN_RTL = makeRun({
  text: HEBREW,
  x: 300,
  y: 52,
  top: 38,
  width: 59.5,
  lang: "he",
  dir: "rtl",
  line: 1,
});

const LINK_WITH_HREF: LinkArea = {
  x: 48.25,
  y: 10,
  width: 33.13,
  height: 18,
  alt: "Open <world> & more",
  href: URL_WORLD,
};
const LINK_WITHOUT_HREF: LinkArea = {
  x: 120,
  y: 70,
  width: 100,
  height: 30,
  alt: "Tooltip only",
  href: null,
};

const TILES: RasterTile[] = [
  {
    x: 0,
    y: 0,
    width: 400,
    height: 80,
    dataURL: "data:image/png;base64,iVBORw0KGgo=",
    pixelWidth: 800,
    pixelHeight: 160,
    format: "png",
  },
  {
    x: 0,
    y: 80,
    width: 400,
    height: 40,
    dataURL: "data:image/jpeg;base64,/9j/4AAQ",
    pixelWidth: 800,
    pixelHeight: 80,
    format: "jpeg",
  },
];

function makeInput(over: Partial<RenderInput> = {}): RenderInput {
  return {
    region: { x: 100.5, y: 250, width: 400, height: 120 },
    // Deliberately interleaved: grouping by line and input order within a line are part of the contract.
    runs: [RUN_HELLO, RUN_FRENCH, RUN_WORLD, RUN_RTL],
    links: [LINK_WITH_HREF, LINK_WITHOUT_HREF],
    page: {
      url: "https://example.com/menu?lang=fr&id=7",
      title: 'Café & "Menu" <draft>',
      lang: "en",
      textFragmentURL: "https://example.com/menu?lang=fr&id=7#:~:text=Hello-,world",
      textFragmentStatus: "SUCCESS",
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 250 },
      devicePixelRatio: 2,
      capturedAt: "2026-10-01T12:00:00.000Z",
      mode: "drag",
      skippedFrames: 0,
      skippedVertical: 1,
    },
    tiles: TILES,
    extensionVersion: "0.1.0",
    zoom: 1,
    scale: 2,
    ...over,
  };
}

const render = (over: Partial<RenderInput> = {}): string => rasterTextRenderer(makeInput(over));

// ---- tests ----

test("svg: exact match against the golden file", () => {
  const golden = readFileSync(new URL("./golden/simple.svg", import.meta.url), "utf8");
  assert.equal(render(), golden);
});

test("svg: well-formed XML with every namespace prefix declared", () => {
  const root = parseXml(render());
  assert.equal(root.name, "svg");
  assert.equal(attr(root, "xmlns"), "http://www.w3.org/2000/svg");
  assert.equal(attr(root, "xmlns:xlink"), "http://www.w3.org/1999/xlink");
  assert.equal(attr(root, "width"), "400");
  assert.equal(attr(root, "height"), "120");
  assert.equal(attr(root, "viewBox"), "0 0 400 120");
  assert.equal(attr(root, "xml:lang"), "en");
  assert.deepEqual(
    elements(root).map((e) => e.name),
    ["title", "desc", "metadata", "image", "image", "g", "g"],
  );
});

test("svg: document root carries no xml:lang when the page language is unknown", () => {
  const base = makeInput();
  const root = parseXml(rasterTextRenderer({ ...base, page: { ...base.page, lang: null } }));
  assert.equal(root.attrs.has("xml:lang"), false);
});

test("svg: one <text> per run with textLength and lengthAdjust, every line group ends in the separator", () => {
  const layer = byId(parseXml(render()), "text");
  // Firefox copies even whitespace between elements under xml:space="preserve".
  assert.ok(
    layer.children.every((c) => typeof c !== "string"),
    "no character data between the line groups",
  );
  const lines = elements(layer);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.name, "g");
    // No whitespace-only text node between the children: xml:space="preserve" would copy it.
    assert.ok(
      line.children.every((c) => typeof c !== "string"),
      "no character data directly in the line group",
    );
    const kids = elements(line);
    const last = kids.at(-1);
    assert.ok(last && isSeparator(last), "line ends with <text x y> </text>");
    assert.equal(kids.filter(isSeparator).length, 1, "exactly one separator per line");
  }
  assert.equal(named(layer, "tspan").length, 0, "Firefox ignores textLength on <tspan>");
  // The separator sits at the line's right end, on the last run's baseline.
  const [first, second] = lines.map((l) => elements(l).at(-1));
  assert.deepEqual([attr(first as XEl, "x"), attr(first as XEl, "y")], ["81.38", "24.5"]);
  assert.deepEqual([attr(second as XEl, "x"), attr(second as XEl, "y")], ["359.5", "52"]);
  const runTexts = named(layer, "text").filter((t) => !isSeparator(t));
  assert.equal(runTexts.length, 4);
  for (const t of runTexts) {
    assert.ok(Number(attr(t, "textLength")) > 0);
    assert.equal(attr(t, "lengthAdjust"), "spacingAndGlyphs");
  }
});

test("svg: text is invisible through fill-opacity, fill=none never appears", () => {
  const out = render();
  assert.ok(!out.includes('fill="none"'), 'no fill="none" anywhere');
  assert.ok(!/fill\s*:\s*none/.test(out), "no fill:none in a style either");
  const root = parseXml(out);
  const layer = byId(root, "text");
  assert.equal(attr(layer, "fill"), "#000");
  assert.equal(attr(layer, "fill-opacity"), "0");
  assert.equal(attr(layer, "xml:space"), "preserve");
  assert.equal(attr(layer, "style"), "white-space:pre");
  for (const t of named(layer, "text"))
    assert.equal(t.attrs.has("fill"), false, "invisible runs inherit the group fill");
  for (const r of named(byId(root, "links"), "rect")) {
    assert.equal(attr(r, "fill"), "#000");
    assert.equal(attr(r, "fill-opacity"), "0");
  }
});

test("svg: <image> geometry is the tile's CSS rect, never its pixel size", () => {
  const images = named(parseXml(render()), "image");
  assert.equal(images.length, TILES.length);
  TILES.forEach((tile, i) => {
    assert.notEqual(tile.pixelWidth, tile.width, "fixture precondition: pixel size differs from CSS size");
    const img = images[i];
    assert.ok(img);
    assert.equal(attr(img, "x"), String(tile.x));
    assert.equal(attr(img, "y"), String(tile.y));
    assert.equal(attr(img, "width"), String(tile.width));
    assert.equal(attr(img, "height"), String(tile.height));
    assert.equal(attr(img, "preserveAspectRatio"), "none");
    assert.equal(attr(img, "xlink:href"), tile.dataURL);
  });
});

test("svg: a tile at a fractional CSS rect keeps that rect (rounded to 2 decimals), not pixel/scale", () => {
  const tile: RasterTile = {
    x: 0.333,
    y: 80.5,
    width: 400.126,
    height: 10,
    dataURL: "data:image/png;base64,AAAA",
    pixelWidth: 801,
    pixelHeight: 20,
    format: "png",
  };
  const img = named(parseXml(render({ tiles: [tile] })), "image")[0];
  assert.ok(img);
  assert.equal(attr(img, "x"), "0.33");
  assert.equal(attr(img, "y"), "80.5");
  assert.equal(attr(img, "width"), "400.13");
  assert.equal(attr(img, "height"), "10");
});

test("svg: RTL runs get direction and anchor at the right edge, LTR runs neither", () => {
  const layer = byId(parseXml(render()), "text");
  const tspans = named(layer, "text").filter((t) => !isSeparator(t));
  const rtl = tspans.find((t) => textOf(t) === HEBREW);
  assert.ok(rtl);
  assert.equal(attr(rtl, "direction"), "rtl");
  assert.equal(attr(rtl, "x"), String(RUN_RTL.x + RUN_RTL.width));
  assert.equal(attr(rtl, "xml:lang"), "he");
  for (const t of tspans.filter((t) => t !== rtl)) assert.equal(t.attrs.has("direction"), false);
  const ltr = tspans.find((t) => textOf(t) === "Bonjour");
  assert.ok(ltr);
  assert.equal(attr(ltr, "x"), "10");
});

test("svg: run attributes — baseline, font, language only where known", () => {
  const tspans = named(byId(parseXml(render()), "text"), "text").filter((t) => !isSeparator(t));
  const french = tspans.find((t) => textOf(t) === "Bonjour");
  assert.ok(french);
  assert.equal(attr(french, "y"), "52");
  assert.equal(attr(french, "textLength"), "60.33");
  assert.equal(attr(french, "font-weight"), "700");
  assert.equal(attr(french, "font-style"), "italic");
  assert.equal(attr(french, "font-family"), "serif");
  assert.equal(attr(french, "xml:lang"), "fr");
  const hello = tspans.find((t) => textOf(t) === "Hello ");
  assert.ok(hello);
  assert.equal(attr(hello, "font-family"), '"Helvetica Neue", Arial, sans-serif');
  assert.equal(attr(hello, "xml:lang"), "en");
  const world = tspans.find((t) => textOf(t) === "world");
  assert.ok(world);
  assert.equal(world.attrs.has("xml:lang"), false, "run without a known language carries none");
});

test("svg: linked runs sit in <a href xlink:href>, unlinked runs do not", () => {
  const layer = byId(parseXml(render()), "text");
  const anchors = named(layer, "a");
  assert.equal(anchors.length, 1);
  const a = anchors[0];
  assert.ok(a);
  assert.equal(attr(a, "href"), URL_WORLD);
  assert.equal(attr(a, "xlink:href"), URL_WORLD);
  assert.deepEqual(
    elements(a).map((e) => [e.name, textOf(e)]),
    [["text", "world"]],
  );
});

test("svg: link areas — with href inside <a>, without href a bare rect, both with an alt <title>", () => {
  const links = byId(parseXml(render()), "links");
  const kids = elements(links);
  assert.deepEqual(
    kids.map((k) => k.name),
    ["a", "rect"],
  );
  const [linked, bare] = kids;
  assert.ok(linked && bare);
  assert.equal(attr(linked, "href"), URL_WORLD);
  assert.equal(attr(linked, "xlink:href"), URL_WORLD);
  const inner = elements(linked);
  assert.equal(inner.length, 1);
  assert.equal(inner[0]?.name, "rect");
  assert.equal(textOf(inner[0] as XEl), "Open <world> & more");
  assert.equal(attr(bare, "x"), "120");
  assert.equal(attr(bare, "width"), "100");
  assert.equal(textOf(bare), "Tooltip only");
  assert.equal(named(bare, "title").length, 1);
  assert.equal(bare.attrs.has("href"), false);
});

test("svg: a link area without alt text gets no empty <title>", () => {
  const root = parseXml(
    render({
      links: [
        { ...LINK_WITHOUT_HREF, alt: "" },
        { ...LINK_WITH_HREF, alt: "" },
      ],
    }),
  );
  assert.equal(named(byId(root, "links"), "title").length, 0);
});

test("svg: lines are ordered numerically and runs keep input order within a line", () => {
  const runs = [
    makeRun({ text: "ten-a", line: 10 }),
    makeRun({ text: "two-a", line: 2 }),
    makeRun({ text: "ten-b", line: 10 }),
    makeRun({ text: "two-b", line: 2 }),
    makeRun({ text: "zero", line: 0 }),
  ];
  const layer = byId(parseXml(render({ runs })), "text");
  const lines = elements(layer).map((l) =>
    elements(l)
      .filter((t) => !isSeparator(t))
      .map(textOf),
  );
  assert.deepEqual(lines, [["zero"], ["two-a", "two-b"], ["ten-a", "ten-b"]]);
});

test("svg: renderTextLayer is the <g id=text> of the document", () => {
  const runs = makeInput().runs;
  const layer = renderTextLayer(runs, { visible: false });
  assert.ok(layer.startsWith('<g id="text"'));
  assert.ok(layer.endsWith("</g>"));
  const indented = layer
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  assert.ok(render().includes(`${indented}\n</svg>`), "same text layer, nested one level");
});

test("svg: visible text (phase-2 seam) takes its fill from the run and drops the zero opacity", () => {
  const runs = [RUN_HELLO, makeRun({ text: "red", x: 60, color: "rgb(255, 0, 0)", line: 0 })];
  const layer = renderTextLayer(runs, { visible: true });
  assert.ok(!layer.includes("fill-opacity"), "no zero opacity on visible text");
  assert.ok(!layer.includes('fill="none"'));
  const g = parseXml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${layer}</svg>\n`,
  );
  const group = byId(g, "text");
  assert.equal(group.attrs.has("fill"), false);
  assert.equal(group.attrs.has("fill-opacity"), false);
  const tspans = named(group, "text").filter((t) => !isSeparator(t));
  assert.deepEqual(
    tspans.map((t) => attr(t, "fill")),
    ["rgb(20, 20, 20)", "rgb(255, 0, 0)"],
  );
  assert.ok(tspans.every((t) => t.attrs.has("textLength") && attr(t, "lengthAdjust") === "spacingAndGlyphs"));
});

test("svg: invisible mode of renderTextLayer sets the zero opacity on the group only", () => {
  const layer = renderTextLayer([RUN_HELLO], { visible: false });
  assert.equal(layer.match(/fill-opacity="0"/g)?.length, 1);
  assert.equal(layer.match(/ fill="/g)?.length, 1);
});

test("svg: hostile page text stays well-formed and loses no markup characters", () => {
  const evil = 'a<b>&"c" \u0000\u0001\ud800 \u{1f600}';
  const clean = 'a<b>&"c"  \u{1f600}';
  const base = makeInput();
  const out = rasterTextRenderer({
    ...base,
    page: { ...base.page, title: evil, url: `https://x.test/?a=1&b="2"${"\u0000"}` },
    runs: [makeRun({ text: evil, fontFamily: evil, lang: evil, href: evil })],
    links: [{ x: 0, y: 0, width: 1, height: 1, alt: evil, href: evil }],
  });
  const root = parseXml(out);
  assert.equal(textOf(elements(root)[0] as XEl), clean);
  const tspan = named(byId(root, "text"), "text").find((t) => !isSeparator(t));
  assert.ok(tspan);
  assert.equal(textOf(tspan), clean);
  assert.equal(attr(tspan, "font-family"), clean);
  assert.equal(attr(tspan, "xml:lang"), clean);
  assert.equal(attr(named(byId(root, "links"), "a")[0] as XEl, "href"), clean);
});

test("svg: a newline inside a run's text is reproduced verbatim, never indented", () => {
  const out = render({ runs: [makeRun({ text: "a\nb  c", line: 0 })] });
  const tspan = named(byId(parseXml(out), "text"), "text").find((t) => !isSeparator(t));
  assert.ok(tspan);
  assert.equal(textOf(tspan), "a\nb  c");
});

test("svg: output is deterministic and ends in a single newline", () => {
  const a = render();
  assert.equal(a, render());
  assert.ok(a.endsWith("</svg>\n"));
  assert.ok(!a.endsWith("\n\n"));
});

test("svg: no runs, no links, no tiles still yields a well-formed document", () => {
  const root = parseXml(render({ runs: [], links: [], tiles: [] }));
  assert.deepEqual(
    elements(root).map((e) => e.name),
    ["title", "desc", "metadata", "g", "g"],
  );
  assert.equal(elements(byId(root, "text")).length, 0);
  assert.equal(elements(byId(root, "links")).length, 0);
});

test("svg: the metadata block is embedded, one level deep", () => {
  const root = parseXml(render());
  const meta = elements(root).find((e) => e.name === "metadata");
  assert.ok(meta);
  assert.deepEqual(
    elements(meta).map((e) => e.name),
    ["rdf:RDF", "snapii:capture"],
  );
});

const OCR_INFO = {
  engine: "tesseract.js 7.0.0",
  langs: ["deu", "eng"],
  areas: 1,
  recognized: 1,
  truncated: false,
  words: 2,
  ms: 812,
  status: "ok" as const,
};

test("svg: OCR runs go into their own invisible <g id=ocr> after the DOM layer, which stays as it was", () => {
  const ocrRuns = [
    makeRun({ text: "Summer ", x: 10, y: 60, width: 70, line: 0, fontFamily: "sans-serif" }),
    makeRun({ text: "Sale", x: 80, y: 60, width: 40, line: 0, fontFamily: "sans-serif" }),
  ];
  const plain = render();
  const out = render({ ocr: { runs: ocrRuns, info: OCR_INFO } });
  const root = parseXml(out);
  assert.deepEqual(
    elements(root).map((e) => (e.name === "g" ? `g#${e.attrs.get("id")}` : e.name)),
    ["title", "desc", "metadata", "image", "image", "g#links", "g#text", "g#ocr"],
  );
  const ocr = byId(root, "ocr");
  assert.equal(attr(ocr, "fill-opacity"), "0");
  assert.equal(attr(ocr, "xml:space"), "preserve");
  assert.equal(textOf(ocr), "Summer Sale ");
  for (const t of named(ocr, "text").filter((e) => !isSeparator(e))) {
    assert.ok(Number(attr(t, "textLength")) > 0);
  }
  // The DOM layer is byte for byte the one rendered without OCR.
  const domLayer = (svg: string) => svg.slice(svg.indexOf('<g id="text"'), svg.indexOf("</svg>"));
  assert.ok(domLayer(out).startsWith(domLayer(plain).trimEnd()));
  // No runs (nothing recognised, or OCR off): no group at all.
  assert.ok(!render({ ocr: { runs: [], info: { ...OCR_INFO, words: 0 } } }).includes('id="ocr"'));
});
