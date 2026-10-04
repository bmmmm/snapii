// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isToBackground, isToContent, routeMessage } from "../../src/shared/messages.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { CaptureModel, Scene } from "../../src/shared/types.ts";

const model = (): CaptureModel => ({
  region: { x: 10, y: 20, width: 300, height: 200 },
  runs: [
    {
      text: "Hello",
      x: 1,
      y: 14,
      top: 2,
      width: 40,
      height: 16,
      fontFamily: "Arial",
      fontSize: 16,
      fontWeight: 400,
      fontStyle: "normal",
      color: "rgb(0, 0, 0)",
      lang: null,
      dir: "ltr",
      href: "https://example.com/",
      line: 0,
      block: 0,
    },
  ],
  links: [{ x: 0, y: 0, width: 10, height: 10, alt: "", href: null }],
  page: {
    url: "https://example.com/",
    title: "Example",
    lang: "en",
    textFragmentURL: null,
    textFragmentStatus: "DISABLED",
    viewport: { width: 1280, height: 715 },
    scroll: { x: 0, y: 0 },
    devicePixelRatio: 2,
    capturedAt: "2026-10-01T12:00:00.000Z",
    mode: "drag",
    skippedFrames: 0,
    skippedVertical: 0,
  },
});

// The model as loosely typed JSON, so a test can break any field.
// biome-ignore lint/suspicious/noExplicitAny: deliberately ill-typed test input
type Loose = Record<string, any>;

// Each mutation breaks exactly one field of an otherwise valid save message.
const mutations: Array<[string, (m: Loose) => void]> = [
  ["runs not an array", (m) => (m.runs = { 0: m.runs[0] })],
  ["links not an array", (m) => (m.links = "none")],
  ["region NaN", (m) => (m.region.x = Number.NaN)],
  ["region Infinity", (m) => (m.region.height = Number.POSITIVE_INFINITY)],
  ["region negative size", (m) => (m.region.width = -1)],
  ["region missing", (m) => delete m.region],
  ["run text not a string", (m) => (m.runs[0].text = 5)],
  ["run x a string", (m) => (m.runs[0].x = "1")],
  ["run fontStyle unknown", (m) => (m.runs[0].fontStyle = "bold")],
  ["run dir unknown", (m) => (m.runs[0].dir = "ttb")],
  ["run href number", (m) => (m.runs[0].href = 1)],
  ["run is null", (m) => (m.runs[0] = null)],
  ["link alt missing", (m) => delete m.links[0].alt],
  ["page url missing", (m) => delete m.page.url],
  ["page viewport not an object", (m) => (m.page.viewport = 3)],
  ["page scroll.y string", (m) => (m.page.scroll.y = "0")],
  ["page mode unknown", (m) => (m.page.mode = "auto")],
  ["page status unknown", (m) => (m.page.textFragmentStatus = "OK")],
  ["page capturedAt number", (m) => (m.page.capturedAt = 0)],
  ["page devicePixelRatio NaN", (m) => (m.page.devicePixelRatio = Number.NaN)],
  ["imageAreas not an array", (m) => (m.imageAreas = { x: 0, y: 0, width: 30, height: 30, kind: "img" })],
  ["imageArea kind unknown", (m) => (m.imageAreas = [{ x: 0, y: 0, width: 30, height: 30, kind: "video" }])],
  [
    "imageArea width NaN",
    (m) => (m.imageAreas = [{ x: 0, y: 0, width: Number.NaN, height: 30, kind: "img" }]),
  ],
];

test("isToBackground: accepts a well-formed save", () => {
  assert.equal(isToBackground({ type: "save", model: model() }), true);
  assert.equal(isToBackground({ type: "save", model: { ...model(), runs: [], links: [] } }), true);
  // Image areas are optional (sent only with OCR on).
  const imageAreas = [{ x: 0, y: 0, width: 30, height: 20, kind: "background" }];
  assert.equal(isToBackground({ type: "save", model: { ...model(), imageAreas } }), true);
});

test("isToBackground: rejects non-messages and unknown types", () => {
  // open-options: a message type that had no sender and was removed.
  for (const x of [
    null,
    undefined,
    1,
    "save",
    [],
    {},
    { type: "start" },
    { type: "save" },
    { type: "open-options" },
  ]) {
    assert.equal(isToBackground(x), false, JSON.stringify(x));
  }
});

test("isToBackground: rejects a save whose model is malformed in any one field", () => {
  for (const [name, mutate] of mutations) {
    const m = model() as unknown as Loose;
    mutate(m);
    assert.equal(isToBackground({ type: "save", model: m }), false, name);
  }
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** A scene with one of each op, for the one-run model. */
const scene = (): Scene => ({
  canvas: { r: 255, g: 255, b: 255, a: 1 },
  ops: [
    {
      op: "group",
      clip: {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        radii: [
          [4, 4],
          [4, 4],
          [0, 0],
          [0, 0],
        ],
      },
      opacity: 0.5,
      children: [
        {
          op: "rect",
          x: 1,
          y: 2,
          width: 30,
          height: 20,
          radii: [
            [2, 3],
            [2, 3],
            [2, 3],
            [2, 3],
          ],
          fill: { r: 10, g: 20, b: 30, a: 0.25 },
          stroke: { width: 1, paint: { r: 0, g: 0, b: 0, a: 1 } },
        },
        { op: "image", x: 0, y: 0, width: 16, height: 16, dataURL: PNG },
      ],
    },
  ],
  patches: [{ x: 5, y: 5, width: 10, height: 10, reason: "pseudo" }],
  text: [{ fill: { r: 0, g: 0, b: 0, a: 1 }, clip: { x: 0, y: 0, width: 50, height: 20 } }],
  unsupported: { pseudo: 1, budget: 0 },
});

/** n groups, each the only child of the one before. */
function nested(n: number): Loose {
  let op: Loose = { op: "rect", x: 0, y: 0, width: 1, height: 1 };
  for (let i = 0; i < n; i++) op = { op: "group", children: [op] };
  return op;
}

// Each mutation breaks exactly one field of an otherwise valid scene.
const sceneMutations: Array<[string, (s: Loose) => void]> = [
  ["canvas missing", (s) => delete s.canvas],
  ["canvas a CSS string", (s) => (s.canvas = "white")],
  ["canvas channel above 255", (s) => (s.canvas.r = 256)],
  ["canvas channel NaN", (s) => (s.canvas.g = Number.NaN)],
  ["canvas alpha above 1", (s) => (s.canvas.a = 1.5)],
  ["canvas alpha negative", (s) => (s.canvas.a = -0.1)],
  ["canvas channel negative", (s) => (s.canvas.b = -1)],
  ["ops not an array", (s) => (s.ops = {})],
  ["op unknown", (s) => (s.ops = [{ op: "path", d: "M0 0" }])],
  ["op null", (s) => (s.ops = [null])],
  ["rect x NaN", (s) => (s.ops[0].children[0].x = Number.NaN)],
  ["rect width Infinity", (s) => (s.ops[0].children[0].width = Number.POSITIVE_INFINITY)],
  ["rect negative height", (s) => (s.ops[0].children[0].height = -1)],
  ["rect fill a string", (s) => (s.ops[0].children[0].fill = '"><script>alert(1)</script>')],
  [
    "rect radii three corners",
    (s) =>
      (s.ops[0].children[0].radii = [
        [1, 1],
        [1, 1],
        [1, 1],
      ]),
  ],
  ["rect radius negative", (s) => (s.ops[0].children[0].radii[2] = [-1, 0])],
  ["rect radius NaN", (s) => (s.ops[0].children[0].radii[0] = [Number.NaN, 0])],
  ["rect radius one value", (s) => (s.ops[0].children[0].radii[1] = [3])],
  ["rect radii a string", (s) => (s.ops[0].children[0].radii = "4px ")],
  ["stroke a CSS string", (s) => (s.ops[0].children[0].stroke = "1px solid red")],
  ["stroke null", (s) => (s.ops[0].children[0].stroke = null)],
  ["stroke width a string", (s) => (s.ops[0].children[0].stroke.width = "2")],
  ["stroke width negative", (s) => (s.ops[0].children[0].stroke.width = -1)],
  ["stroke paint missing", (s) => delete s.ops[0].children[0].stroke.paint],
  ["image javascript: URL", (s) => (s.ops[0].children[1].dataURL = "javascript:alert(1)")],
  ["image http: URL", (s) => (s.ops[0].children[1].dataURL = "http://example.com/a.png")],
  [
    "image SVG data URL",
    (s) => (s.ops[0].children[1].dataURL = "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"),
  ],
  ["image data URL with a quote", (s) => (s.ops[0].children[1].dataURL = `${PNG}"onload="x`)],
  ["image data URL not base64", (s) => (s.ops[0].children[1].dataURL = "data:image/png,abc")],
  ["image dataURL missing", (s) => delete s.ops[0].children[1].dataURL],
  ["image width NaN", (s) => (s.ops[0].children[1].width = Number.NaN)],
  ["group opacity above 1", (s) => (s.ops[0].opacity = 2)],
  ["group children not an array", (s) => (s.ops[0].children = null)],
  ["group clip NaN", (s) => (s.ops[0].clip.y = Number.NaN)],
  ["group clip radius negative", (s) => (s.ops[0].clip.radii[0] = [0, -2])],
  ["groups nested too deep", (s) => (s.ops = [nested(33)])],
  [
    "too many ops",
    (s) => (s.ops = Array.from({ length: 200_001 }, () => ({ op: "rect", x: 0, y: 0, width: 1, height: 1 }))),
  ],
  ["patch reason unknown", (s) => (s.patches[0].reason = "magic")],
  ["patch width NaN", (s) => (s.patches[0].width = Number.NaN)],
  ["patches not an array", (s) => (s.patches = s.patches[0])],
  ["text shorter than runs", (s) => (s.text = [])],
  ["text longer than runs", (s) => (s.text = [null, null])],
  ["text entry a colour string", (s) => (s.text = ["#000"])],
  ["text a string", (s) => (s.text = "x")],
  ["text fill alpha NaN", (s) => (s.text[0].fill.a = Number.NaN)],
  ["text clip negative width", (s) => (s.text[0].clip.width = -5)],
  ["unsupported reason unknown", (s) => (s.unsupported = { magic: 1 })],
  ["unsupported count negative", (s) => (s.unsupported = { pseudo: -1 })],
  ["unsupported count fractional", (s) => (s.unsupported = { pseudo: 0.5 })],
  ["unsupported missing", (s) => delete s.unsupported],
];

test("isToBackground: accepts a save with a well-formed scene", () => {
  assert.equal(isToBackground({ type: "save", model: { ...model(), scene: scene() } }), true);
  // A run hidden behind a box (null), no ops, no patches.
  const bare: Scene = {
    canvas: { r: 0, g: 0, b: 0, a: 0 },
    ops: [],
    patches: [],
    text: [null],
    unsupported: {},
  };
  assert.equal(isToBackground({ type: "save", model: { ...model(), scene: bare } }), true);
  assert.equal(
    isToBackground({ type: "save", model: { ...model(), scene: { ...scene(), ops: [nested(32)] } } }),
    true,
  );
});

test("isToBackground: rejects a save whose scene is malformed in any one field", () => {
  for (const [name, mutate] of sceneMutations) {
    const s = scene() as unknown as Loose;
    mutate(s);
    assert.equal(isToBackground({ type: "save", model: { ...model(), scene: s } }), false, name);
  }
  assert.equal(isToBackground({ type: "save", model: { ...model(), scene: null } }), false, "scene null");
});

test("isToBackground: accepts a copy message with plain and html strings", () => {
  assert.equal(isToBackground({ type: "copy", plain: "a", html: "<p>a</p>" }), true);
  assert.equal(isToBackground({ type: "copy", plain: "", html: "" }), true);
});

test("isToBackground: rejects a malformed copy message", () => {
  for (const x of [
    { type: "copy" },
    { type: "copy", plain: "a" },
    { type: "copy", html: "a" },
    { type: "copy", plain: 1, html: "a" },
    { type: "copy", plain: "a", html: null },
    { type: "copy", plain: ["a"], html: "a" },
  ]) {
    assert.equal(isToBackground(x), false, JSON.stringify(x));
  }
});

// content.js runs in the top frame only (frameId 0).
const TOP = { frameId: 0 };
const INVALID_MODEL = {
  kind: "reject",
  response: { ok: false, error: "capture-failed", detail: "invalid model" },
};

test("routeMessage: a save with a malformed model gets a capture-failed reply", () => {
  for (const [name, mutate] of mutations) {
    const m = model() as unknown as Loose;
    mutate(m);
    assert.deepEqual(routeMessage({ type: "save", model: m }, TOP), INVALID_MODEL, name);
  }
  assert.deepEqual(routeMessage({ type: "save" }, TOP), INVALID_MODEL);
  assert.deepEqual(routeMessage({ type: "save", model: null }, TOP), INVALID_MODEL);
});

test("routeMessage: unknown or foreign messages get no reply", () => {
  for (const x of [
    null,
    undefined,
    1,
    "save",
    [],
    {},
    { type: "start" },
    { type: "copy" },
    { type: "SAVE" },
    { type: "open-options" },
  ]) {
    assert.deepEqual(routeMessage(x, TOP), { kind: "ignore" }, JSON.stringify(x));
  }
});

test("routeMessage: well-formed messages are handled", () => {
  for (const message of [
    { type: "save", model: model() },
    { type: "copy", plain: "a", html: "<p>a</p>" },
  ]) {
    assert.deepEqual(routeMessage(message, TOP), { kind: "handle", message }, message.type);
  }
});

test("routeMessage: a save from any frame but the top one gets capture-failed", () => {
  const notTop = {
    kind: "reject",
    response: { ok: false, error: "capture-failed", detail: "not sent from the top frame" },
  };
  for (const sender of [{ frameId: 1 }, { frameId: 4711 }, { frameId: -1 }, {}, { frameId: undefined }]) {
    assert.deepEqual(routeMessage({ type: "save", model: model() }, sender), notTop, JSON.stringify(sender));
  }
  // Foreign messages from a subframe still get no reply at all.
  assert.deepEqual(routeMessage({ type: "start" }, { frameId: 1 }), { kind: "ignore" });
});

const POPUP = "moz-extension://uuid/popup.html";

test("routeMessage: start-capture from the popup is routed with its tab id", () => {
  const message = { type: "start-capture", tabId: 7 };
  assert.deepEqual(routeMessage(message, { url: POPUP }, POPUP), { kind: "start", message });
  assert.deepEqual(routeMessage({ type: "start-capture", tabId: 0, extra: 1 }, { url: POPUP }, POPUP), {
    kind: "start",
    message: { type: "start-capture", tabId: 0 },
  });
});

test("routeMessage: start-capture from anything but the popup, or without a valid tab id, gets no reply", () => {
  const message = { type: "start-capture", tabId: 7 };
  // content.js (top frame of some page), another extension page, no URL at all, no popup URL known.
  for (const [sender, popupUrl] of [
    [{ ...TOP, url: "https://example.com/" }, POPUP],
    [{ url: "moz-extension://uuid/options.html" }, POPUP],
    [{}, POPUP],
    [{ url: POPUP }, undefined],
    [{}, undefined],
  ] as const) {
    assert.deepEqual(routeMessage(message, sender, popupUrl), { kind: "ignore" }, JSON.stringify(sender));
  }
  for (const tabId of [undefined, "7", -1, 1.5, Number.NaN, null]) {
    assert.deepEqual(routeMessage({ type: "start-capture", tabId }, { url: POPUP }, POPUP), {
      kind: "ignore",
    });
  }
});

test("isToContent: start with settings, captured with its OCR flag", () => {
  assert.equal(isToContent({ type: "start", settings: DEFAULT_SETTINGS }), true);
  assert.equal(isToContent({ type: "captured", ocr: true }), true);
  assert.equal(isToContent({ type: "captured", ocr: false }), true);
});

test("isToContent: rejects a captured without a boolean flag, and anything else", () => {
  for (const x of [
    { type: "captured" },
    { type: "captured", ocr: "yes" },
    { type: "captured", ocr: 1 },
    { type: "start" },
    { type: "start", settings: null },
    { type: "save", ocr: true },
    null,
    "captured",
    [{ type: "captured", ocr: true }],
  ]) {
    assert.equal(isToContent(x), false, JSON.stringify(x));
  }
});
