// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isToBackground, isToContent, routeMessage } from "../../src/shared/messages.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { CaptureModel } from "../../src/shared/types.ts";

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
