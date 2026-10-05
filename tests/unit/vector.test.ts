// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { unionArea } from "../../src/shared/geometry.ts";
import { rasterTextRenderer } from "../../src/shared/svg/build.ts";
import { type VectorRenderInput, vectorRenderer } from "../../src/shared/svg/vector.ts";
import type { RasterTile, Scene, SceneOp, TextRun } from "../../src/shared/types.ts";
import {
  attr,
  byId,
  descendants,
  elements,
  isSeparator,
  named,
  parseXml,
  textOf,
  type XEl,
} from "./xml-reader.ts";

// ---- fixture ----

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

const HOSTILE_COLOR = '"><script>alert(1)</script>';
const RUN_TITLE = makeRun({
  text: "Menu & more",
  x: 12,
  y: 30,
  top: 14,
  width: 96.5,
  fontFamily: '"Pacifico", "Brand \\"X\\""',
  fontSize: 20,
  fontWeight: 700,
  color: HOSTILE_COLOR,
  lang: "en",
  line: 0,
});
const RUN_HIDDEN = makeRun({ text: "in a patch", x: 120, y: 30, top: 14, width: 70, line: 0 });
const RUN_FADED = makeRun({
  text: "faded",
  x: 12,
  y: 60,
  top: 46,
  width: 40,
  fontFamily: "Georgia, serif",
  href: "https://example.com/?a=1&b=2",
  line: 1,
});
const RUN_CUT = makeRun({ text: "overhang", x: 160, y: 60, top: 46, width: 60, line: 1 });

const PATCH_TILE: RasterTile = {
  x: 110,
  y: 10,
  width: 90,
  height: 30,
  dataURL: "data:image/png;base64,iVBORw0KGgo=",
  pixelWidth: 180,
  pixelHeight: 60,
  format: "png",
};

const ROUND: [number, number] = [6, 6];

function makeScene(): Scene {
  return {
    canvas: { r: 255, g: 255, b: 255, a: 1 },
    ops: [
      { op: "rect", x: 0, y: 0, width: 240, height: 100, fill: { r: 250, g: 248, b: 240, a: 1 } },
      // A pill: CSS shrinks the 9999 px radius to half the height on both axes.
      {
        op: "rect",
        x: 10,
        y: 70,
        width: 200,
        height: 20,
        radii: [
          [9999, 9999],
          [9999, 9999],
          [9999, 9999],
          [9999, 9999],
        ],
        fill: { r: 0, g: 102, b: 204, a: 0.5 },
        stroke: { width: 2, paint: { r: 0, g: 51, b: 102, a: 1 } },
      },
      {
        op: "group",
        clip: { x: 5, y: 5, width: 100, height: 60, radii: [ROUND, ROUND, [0, 0], [0, 0]] },
        opacity: 0.75,
        children: [
          {
            op: "rect",
            x: 5,
            y: 5,
            width: 100,
            height: 60,
            radii: [ROUND, ROUND, [0, 0], [0, 0]],
            fill: { r: 12.4, g: 200.6, b: 0, a: 1 },
          },
          { op: "image", x: 20, y: 20, width: 16, height: 16, dataURL: "data:image/jpeg;base64,/9j/4AAQ" },
        ],
      },
    ],
    patches: [{ x: 110, y: 10, width: 90, height: 30, reason: "pseudo" }],
    text: [
      { fill: { r: 20, g: 20, b: 20, a: 1 } },
      null,
      { fill: { r: 0, g: 0, b: 238, a: 0.6 } },
      { fill: { r: 0, g: 0, b: 0, a: 1 }, clip: { x: 150, y: 44, width: 50, height: 20 } },
    ],
    unsupported: { pseudo: 1, form: 0 },
  };
}

function makeInput(over: Partial<VectorRenderInput> = {}): VectorRenderInput {
  return {
    region: { x: 100.5, y: 250, width: 240, height: 100 },
    runs: [RUN_TITLE, RUN_HIDDEN, RUN_FADED, RUN_CUT],
    links: [{ x: 12, y: 46, width: 40, height: 18, alt: "", href: "https://example.com/?a=1&b=2" }],
    page: {
      url: "https://example.com/menu?lang=fr&id=7",
      title: 'Café & "Menu" <draft>',
      lang: "en",
      textFragmentURL: null,
      textFragmentStatus: "DISABLED",
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 250 },
      devicePixelRatio: 2,
      capturedAt: "2026-10-01T12:00:00.000Z",
      mode: "element",
      skippedFrames: 0,
      skippedVertical: 0,
    },
    tiles: [PATCH_TILE],
    extensionVersion: "0.2.0",
    zoom: 1,
    scale: 2,
    scene: makeScene(),
    ...over,
  };
}

const render = (over: Partial<VectorRenderInput> = {}): string => vectorRenderer(makeInput(over));

/** The <text> element of each run (the ones with font attributes), in document order. */
const runEls = (root: XEl): XEl[] =>
  named(byId(root, "text"), "text").filter((e) => e.attrs.has("font-size"));
const runEl = (root: XEl, text: string): XEl => {
  const el = runEls(root).find((e) => textOf(e) === text);
  assert.ok(el, `run ${text}`);
  return el;
};

function record(svg: string): Record<string, unknown> {
  const m = /<snapii:capture [^>]*>([^<]*)<\/snapii:capture>/.exec(svg);
  assert.ok(m?.[1]);
  return JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

// ---- tests ----

test("vector: exact match against the golden file", () => {
  const golden = readFileSync(new URL("./golden/vector-simple.svg", import.meta.url), "utf8");
  assert.equal(render(), golden);
});

test("vector: layers bottom to top — canvas, shapes, patches, links, text", () => {
  const root = parseXml(render());
  assert.equal(root.name, "svg");
  assert.equal(attr(root, "viewBox"), "0 0 240 100");
  assert.deepEqual(
    elements(root).map((e) => e.attrs.get("id") ?? e.name),
    ["title", "desc", "metadata", "defs", "canvas", "shapes", "patches", "links", "text"],
  );
  assert.equal(attr(byId(root, "canvas"), "fill"), "rgb(255,255,255)");
  const patches = named(byId(root, "patches"), "image");
  assert.equal(patches.length, 1);
  assert.deepEqual(
    ["x", "y", "width", "height"].map((k) => attr(patches[0] as XEl, k)),
    ["110", "10", "90", "30"],
  );
});

test("vector: one text layer, every run exactly once, in line order", () => {
  const root = parseXml(render());
  assert.equal(named(root, "g").filter((g) => g.attrs.get("id") === "text").length, 1);
  assert.deepEqual(runEls(root).map(textOf), ["Menu & more", "in a patch", "faded", "overhang"]);
  const layer = byId(root, "text");
  assert.equal(attr(layer, "xml:space"), "preserve");
  // The layer itself paints nothing: each run says whether it shows.
  assert.equal(layer.attrs.has("fill"), false);
  assert.equal(layer.attrs.has("fill-opacity"), false);
  for (const line of elements(layer)) assert.ok(isSeparator(elements(line).at(-1) as XEl));
});

test("vector: a run without paint (in a patch or under a box) is invisible but hit-testable, never fill=none", () => {
  const root = parseXml(render());
  const hidden = runEl(root, "in a patch");
  assert.equal(attr(hidden, "fill"), "#000");
  assert.equal(attr(hidden, "fill-opacity"), "0");
  assert.ok(!render().includes('fill="none" fill-opacity'));
  for (const el of runEls(root)) assert.notEqual(el.attrs.get("fill"), "none");
});

test("vector: visible runs are painted from numbers, never from the page's colour string", () => {
  const svg = render();
  const root = parseXml(svg);
  assert.equal(attr(runEl(root, "Menu & more"), "fill"), "rgb(20,20,20)");
  assert.equal(runEl(root, "Menu & more").attrs.has("fill-opacity"), false);
  const faded = runEl(root, "faded");
  assert.equal(attr(faded, "fill"), "rgb(0,0,238)");
  assert.equal(attr(faded, "fill-opacity"), "0.6");
  assert.ok(!svg.includes("<script"), "the run's raw color never reaches the file");
  assert.ok(!svg.includes("alert(1)"));
});

test("vector: textLength pins each run on <text>, never on <tspan>, by spacing; a generic family is appended when missing", () => {
  const svg = render();
  assert.ok(!svg.includes("<tspan"));
  const root = parseXml(svg);
  for (const el of runEls(root)) {
    assert.ok(el.attrs.has("textLength"));
    // Visible glyphs keep their shape; the raster's invisible layer still stretches them.
    assert.equal(attr(el, "lengthAdjust"), "spacing");
  }
  assert.equal(attr(runEl(root, "Menu & more"), "font-family"), '"Pacifico", "Brand \\"X\\"", sans-serif');
  assert.equal(attr(runEl(root, "faded"), "font-family"), "Georgia, serif");
  assert.equal(attr(runEl(root, "in a patch"), "font-family"), "serif");
});

test("vector: a run with a space at either end preserves it on its own <text>; letter-spacing is written", () => {
  const runs = [
    makeRun({ text: "Some text with ", line: 0 }),
    makeRun({ text: " here", x: 120, line: 0 }),
    makeRun({ text: "inner space", x: 0, line: 1 }),
  ];
  const scene: Scene = {
    ...makeScene(),
    text: [
      { fill: { r: 0, g: 0, b: 0, a: 1 }, letterSpacing: 8 },
      null,
      { fill: { r: 0, g: 0, b: 0, a: 1 } },
    ],
  };
  const root = parseXml(render({ runs, scene }));
  const [lead, trail, inner] = ["Some text with ", " here", "inner space"].map((t) => runEl(root, t));
  assert.ok(lead && trail && inner);
  assert.equal(attr(lead, "xml:space"), "preserve");
  assert.equal(attr(trail, "xml:space"), "preserve");
  assert.equal(inner.attrs.has("xml:space"), false);
  assert.equal(attr(lead, "letter-spacing"), "8");
  assert.equal(inner.attrs.has("letter-spacing"), false);
  // The invisible run keeps its space too, and stays transparent.
  assert.equal(attr(trail, "fill-opacity"), "0");
});

test("vector: a run that overhangs its clip is clipped, the others are not", () => {
  const root = parseXml(render());
  const cut = runEl(root, "overhang");
  const id = /^url\(#(c\d+)\)$/.exec(attr(cut, "clip-path"))?.[1];
  assert.ok(id);
  const rect = elements(byId(root, id))[0] as XEl;
  assert.deepEqual(
    ["x", "y", "width", "height"].map((k) => attr(rect, k)),
    ["150", "44", "50", "20"],
  );
  for (const t of ["Menu & more", "in a patch", "faded"])
    assert.equal(runEl(root, t).attrs.has("clip-path"), false);
});

test("vector: radii overlapping along a side shrink together, as CSS does (a pill keeps round ends)", () => {
  const root = parseXml(render());
  const pill = named(byId(root, "shapes"), "rect").find((r) => r.attrs.get("width") === "200");
  assert.ok(pill);
  assert.equal(attr(pill, "rx"), "10");
  assert.equal(pill.attrs.has("ry"), false);
});

test("vector: corners rounded unlike each other become one path with an arc per rounded corner", () => {
  const root = parseXml(render());
  const path = named(byId(root, "shapes"), "path")[0];
  assert.ok(path);
  assert.equal(attr(path, "d"), "M11 5H99A6 6 0 0 1 105 11V65H5V11A6 6 0 0 1 11 5Z");
  assert.equal(attr(path, "fill"), "rgb(12,201,0)");
});

test("vector: a border is painted inside the box: the stroke runs half its width in", () => {
  const root = parseXml(render());
  const stroke = named(byId(root, "shapes"), "rect").find((r) => r.attrs.has("stroke"));
  assert.ok(stroke);
  assert.deepEqual(
    ["x", "y", "width", "height", "rx", "fill", "stroke", "stroke-width"].map((k) => attr(stroke, k)),
    ["11", "71", "198", "18", "9", "none", "rgb(0,51,102)", "2"],
  );
  // A border at least half the box's size fills it.
  const thick: Scene = {
    ...makeScene(),
    ops: [
      {
        op: "rect",
        x: 0,
        y: 0,
        width: 10,
        height: 6,
        stroke: { width: 3, paint: { r: 1, g: 2, b: 3, a: 1 } },
      },
    ],
  };
  const only = named(byId(parseXml(render({ scene: thick })), "shapes"), "rect");
  assert.equal(only.length, 1);
  assert.equal(attr(only[0] as XEl, "fill"), "rgb(1,2,3)");
  // The same with the box's width the binding side.
  const narrow: Scene = {
    ...thick,
    ops: [{ ...(thick.ops[0] as SceneOp & { op: "rect" }), width: 6, height: 10 }],
  };
  const filled = named(byId(parseXml(render({ scene: narrow })), "shapes"), "rect");
  assert.equal(filled.length, 1);
  assert.equal(attr(filled[0] as XEl, "fill"), "rgb(1,2,3)");
  // The stroke's corners are rounded half its width less than the box's.
  const rounded = named(
    shapesOf([
      {
        op: "rect",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        radii: [
          [8, 8],
          [8, 8],
          [8, 8],
          [8, 8],
        ],
        stroke: { width: 4, paint: { r: 0, g: 0, b: 0, a: 1 } },
      },
    ]),
    "rect",
  );
  assert.equal(attr(rounded[0] as XEl, "rx"), "6");
});

/** The shapes layer of a scene made of just these ops. */
const shapesOf = (ops: SceneOp[]): XEl =>
  byId(parseXml(render({ scene: { ...makeScene(), ops } })), "shapes");
const box = (over: Partial<SceneOp & { op: "rect" }>): SceneOp => ({
  op: "rect",
  x: 0,
  y: 0,
  width: 100,
  height: 10,
  fill: { r: 0, g: 0, b: 0, a: 1 },
  ...over,
});

test("vector: an overlap on any one side shrinks all radii by the same factor", () => {
  const z: [number, number] = [0, 0];
  const shapes = shapesOf([
    // top: 6 + 6 > 10 wide; right: 6 + 6 > 10 high; bottom and left likewise.
    box({ width: 10, height: 100, radii: [[6, 1], [6, 1], z, z] }),
    box({ radii: [z, [1, 6], [1, 6], z] }),
    box({ width: 10, height: 100, radii: [z, z, [6, 1], [6, 1]] }),
    box({ radii: [[1, 6], z, z, [1, 6]] }),
  ]);
  const arcs = named(shapes, "path").map((p) =>
    [...attr(p, "d").matchAll(/A(\S+) (\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
  );
  assert.deepEqual(arcs, [
    ["5 0.83", "5 0.83"],
    ["0.83 5", "0.83 5"],
    ["5 0.83", "5 0.83"],
    ["0.83 5", "0.83 5"],
  ]);
});

test("vector: a side of length zero leaves no room for radii", () => {
  const shapes = shapesOf([
    box({
      width: 0,
      height: 20,
      radii: [
        [5, 5],
        [0, 0],
        [0, 0],
        [5, 5],
      ],
    }),
  ]);
  assert.equal(named(shapes, "path").length, 0);
  const [only] = named(shapes, "rect");
  assert.ok(only);
  assert.equal(only.attrs.has("rx"), false);
});

test("vector: a corner with one radius zero is square; equal elliptical corners stay a <rect> with rx and ry", () => {
  const shapes = shapesOf([
    box({
      radii: [
        [5, 0],
        [5, 0],
        [5, 0],
        [5, 0],
      ],
    }),
    box({
      radii: [
        [4, 2],
        [4, 2],
        [4, 2],
        [4, 2],
      ],
    }),
    // Same horizontal radius everywhere, not the same vertical one: a path.
    box({
      radii: [
        [4, 2],
        [4, 3],
        [4, 2],
        [4, 3],
      ],
    }),
  ]);
  const [square, oval] = named(shapes, "rect");
  assert.ok(square && oval);
  assert.equal(square.attrs.has("rx"), false);
  assert.equal(attr(oval, "rx"), "4");
  assert.equal(attr(oval, "ry"), "2");
  assert.equal(named(shapes, "path").length, 1);
});

test("vector: colour channels are clamped integers, alpha clamped, opaque paint has no opacity attribute", () => {
  const shapes = shapesOf([
    box({ fill: { r: 300, g: -5, b: Number.NaN, a: 2 } }),
    box({ fill: { r: 1, g: 2, b: 3, a: Number.NaN } }),
    box({ fill: { r: 1, g: 2, b: 3, a: -1 } }),
  ]);
  const [over, nan, neg] = named(shapes, "rect");
  assert.ok(over && nan && neg);
  assert.equal(attr(over, "fill"), "rgb(255,0,0)");
  assert.equal(over.attrs.has("fill-opacity"), false);
  assert.equal(attr(nan, "fill-opacity"), "0");
  assert.equal(attr(neg, "fill-opacity"), "0");
});

test("vector: clips of the same rect but other radii get their own clipPath", () => {
  const svg = render({
    scene: {
      ...makeScene(),
      ops: [
        { op: "group", clip: { x: 1, y: 1, width: 50, height: 50 }, children: [] },
        {
          op: "group",
          clip: {
            x: 1,
            y: 1,
            width: 50,
            height: 50,
            radii: [
              [3, 3],
              [3, 3],
              [3, 3],
              [3, 3],
            ],
          },
          children: [],
        },
      ],
      text: [null, null, null, null],
    },
  });
  assert.deepEqual(
    [...svg.matchAll(/<clipPath id="(c\d+)">(<\w+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ["c0 <rect", "c1 <rect"],
  );
  assert.ok(svg.includes('<clipPath id="c1"><rect x="1" y="1" width="50" height="50" rx="3"/>'));
});

test("vector: a one-colour border of unequal widths is the ring between the box and its padding box", () => {
  const paint = { r: 80, g: 80, b: 160, a: 1 };
  const shapes = shapesOf([
    {
      op: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      radii: [
        [20, 20],
        [20, 20],
        [20, 20],
        [20, 20],
      ],
      border: { widths: [2, 10, 2, 10], paint },
    },
    { op: "rect", x: 0, y: 50, width: 50, height: 20, border: { widths: [0, 0, 0, 0], paint } },
  ]);
  const paths = named(shapes, "path");
  assert.equal(paths.length, 1, "a border of zero widths draws nothing");
  const ring = paths[0] as XEl;
  assert.equal(attr(ring, "fill-rule"), "evenodd");
  assert.equal(attr(ring, "fill"), "rgb(80,80,160)");
  // Outer box with radius 20, padding box 10..90 x 2..38 with radii 20-10=10 by 20-2=18.
  assert.equal(
    attr(ring, "d"),
    "M20 0H80A20 20 0 0 1 100 20V20A20 20 0 0 1 80 40H20A20 20 0 0 1 0 20V20A20 20 0 0 1 20 0Z" +
      "M20 2H80A10 18 0 0 1 90 20V20A10 18 0 0 1 80 38H20A10 18 0 0 1 10 20V20A10 18 0 0 1 20 2Z",
  );
});

test("vector: groups carry their clip and opacity; an opaque group gets no opacity", () => {
  const root = parseXml(render());
  const group = named(byId(root, "shapes"), "g")[0];
  assert.ok(group);
  assert.match(attr(group, "clip-path"), /^url\(#c\d+\)$/);
  assert.equal(attr(group, "opacity"), "0.75");
  const opaque: Scene = { ...makeScene(), ops: [{ op: "group", opacity: 1, children: [] }] };
  const g = named(byId(parseXml(render({ scene: opaque })), "shapes"), "g")[0];
  assert.ok(g);
  assert.equal(g.attrs.size, 0);
  const image = named(group, "image")[0];
  assert.ok(image);
  assert.equal(attr(image, "preserveAspectRatio"), "none");
  assert.equal(attr(image, "xlink:href"), "data:image/jpeg;base64,/9j/4AAQ");
});

test("vector: clip ids are a counter in order of first use, one clipPath per distinct shape", () => {
  const svg = render();
  const ids = [...svg.matchAll(/<clipPath id="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["c0", "c1"]);
  const twice: Scene = {
    ...makeScene(),
    ops: [
      { op: "group", clip: { x: 1, y: 1, width: 5, height: 5 }, children: [] },
      { op: "group", clip: { x: 1, y: 1, width: 5, height: 5 }, children: [] },
    ],
    text: [null, null, null, { fill: { r: 0, g: 0, b: 0, a: 1 }, clip: { x: 1, y: 1, width: 5, height: 5 } }],
  };
  const shared = render({ scene: twice });
  assert.equal([...shared.matchAll(/<clipPath /g)].length, 1);
  assert.equal([...shared.matchAll(/clip-path="url\(#c0\)"/g)].length, 3);
});

test("vector: output is deterministic and ends in a single newline", () => {
  assert.equal(render(), render());
  assert.ok(render().endsWith("</svg>\n"));
  assert.ok(!render().endsWith("\n\n"));
});

test("vector: nothing but generated ids behind url(), no script, no foreignObject, no event attributes", () => {
  const svg = render();
  for (const m of svg.matchAll(/url\(([^)]*)\)/g)) assert.match(m[1] ?? "", /^#c\d+$/);
  assert.ok(!/<script|<foreignObject/i.test(svg));
  const root = parseXml(svg);
  for (const el of [root, ...descendants(root)])
    for (const k of el.attrs.keys()) assert.ok(!/^on/i.test(k), k);
  for (const m of svg.matchAll(/xlink:href="(data:[^"]*)"/g))
    assert.match(m[1] ?? "", /^data:image\/(png|jpeg|webp|gif);base64,/);
});

test("vector: metadata records the patches as tiles and counts the scene, never its shapes", () => {
  const rec = record(render());
  assert.equal(rec.schema, 1);
  assert.equal(rec.output, "vector");
  assert.equal(rec.zoom, 1);
  assert.equal(rec.scale, 2);
  assert.deepEqual(rec.tiles, [
    { rect: { x: 110, y: 10, width: 90, height: 30 }, pixelWidth: 180, pixelHeight: 60, format: "png" },
  ]);
  // Two rects and a group with two children: five ops; unsupported keys sorted.
  assert.deepEqual(rec.scene, { ops: 5, patches: 1, patchArea: 2700, unsupported: { form: 0, pseudo: 1 } });
  assert.equal(rec.runCount, 4);
  assert.ok(!JSON.stringify(rec).includes("data:"), "no image data in the record");
});

test("vector: no patches — tiles is empty, zoom and scale are still numbers", () => {
  const scene: Scene = { ...makeScene(), patches: [] };
  const svg = render({ scene, tiles: [], zoom: 1.5, scale: 1.33 });
  const rec = record(svg);
  assert.deepEqual(rec.tiles, []);
  assert.equal(rec.zoom, 1.5);
  assert.equal(rec.scale, 1.33);
  assert.deepEqual((rec.scene as { patches: number; patchArea: number }).patches, 0);
  assert.equal(elements(byId(parseXml(svg), "patches")).length, 0);
});

test("vector: an empty scene still yields a well-formed document with every layer", () => {
  const scene: Scene = {
    canvas: { r: 0, g: 0, b: 0, a: 0 },
    ops: [],
    patches: [],
    text: [],
    unsupported: {},
  };
  const root = parseXml(render({ scene, runs: [], links: [], tiles: [] }));
  assert.deepEqual(
    elements(root).map((e) => e.attrs.get("id") ?? e.name),
    ["title", "desc", "metadata", "canvas", "shapes", "patches", "links", "text"],
  );
  assert.equal(attr(byId(root, "canvas"), "fill-opacity"), "0");
});

test("vector: the raster record has no vector fields", () => {
  const raster = rasterTextRenderer(makeInput());
  const rec = record(raster);
  assert.equal("output" in rec, false);
  assert.equal("scene" in rec, false);
});

test("unionArea: overlaps count once, empty or inverted rects not at all", () => {
  assert.equal(unionArea([]), 0);
  assert.equal(unionArea([{ x: 0, y: 0, width: 10, height: 10 }]), 100);
  assert.equal(
    unionArea([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 20, width: 10, height: -5 },
    ]),
    100,
  );
  assert.equal(
    unionArea([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ]),
    175,
  );
  assert.equal(
    unionArea([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 3, height: 3 },
      { x: 20, y: 0, width: 0, height: 50 },
    ]),
    100,
  );
  // Two rects side by side with a gap, and one bridging them below: 16 + 16 + 40 - 8 - 8.
  assert.equal(
    unionArea([
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 6, y: 0, width: 4, height: 4 },
      { x: 0, y: 2, width: 10, height: 4 },
    ]),
    56,
  );
});
