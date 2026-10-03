// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { recognizeInOffscreen } from "../../../src/background/chromium/ocr.ts";
import { createOffscreenClient, type OffscreenDeps } from "../../../src/background/chromium/offscreen.ts";
import { isOffscreenRequest, type OffscreenRequest } from "../../../src/shared/offscreen.ts";
import type { ImageArea, OcrOutput, RasterTile } from "../../../src/shared/types.ts";

const COPY: OffscreenRequest = { to: "offscreen", type: "copy", plain: "p", html: "<b>p</b>" };

/** A browser with at most one offscreen document, as Chromium allows. */
function harness(
  opts: { existing?: boolean; answer?: (request: OffscreenRequest) => Promise<unknown> } = {},
) {
  const log: string[] = [];
  let open = opts.existing ?? false;
  const deps: OffscreenDeps = {
    async create() {
      if (open) throw new Error("Only a single offscreen document may be created.");
      await sleep(1);
      open = true;
      log.push("create");
    },
    async close() {
      if (!open) throw new Error("No current offscreen document.");
      open = false;
      log.push("close");
    },
    async send(request) {
      assert.equal(open, true, "a message needs the document");
      log.push(`send:${request.type}`);
      return opts.answer ? opts.answer(request) : true;
    },
  };
  return { deps, log, isOpen: () => open };
}

test("offscreen client: the document exists for the request and is closed after it", async () => {
  const h = harness();
  assert.equal(await createOffscreenClient(h.deps).ask(COPY), true);
  assert.deepEqual(h.log, ["create", "send:copy", "close"]);
});

test("offscreen client: requests in flight share one document, closed after the last", async () => {
  let release: (v: unknown) => void = () => {};
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ answer: (r) => (r.type === "ocr" ? slow : Promise.resolve(true)) });
  const client = createOffscreenClient(h.deps);
  const ocr = client.ask({ to: "offscreen", type: "ocr", areas: [], tiles: [], runs: [] });
  await client.ask(COPY);
  assert.deepEqual(h.log, ["create", "send:ocr", "send:copy"]);
  release("done");
  assert.equal(await ocr, "done");
  assert.deepEqual(h.log, ["create", "send:ocr", "send:copy", "close"]);
});

test("offscreen client: a document left over from an earlier worker is used, then closed", async () => {
  const h = harness({ existing: true });
  await createOffscreenClient(h.deps).ask(COPY);
  assert.deepEqual(h.log, ["send:copy", "close"]);
  assert.equal(h.isOpen(), false);
});

test("offscreen client: a failed request rejects and still closes the document", async () => {
  const h = harness({ answer: () => Promise.reject(new Error("boom")) });
  const client = createOffscreenClient(h.deps);
  await assert.rejects(client.ask(COPY), /boom/);
  assert.equal(h.isOpen(), false);
  // The next request gets a new one.
  h.log.length = 0;
  await assert.rejects(client.ask(COPY), /boom/);
  assert.deepEqual(h.log, ["create", "send:copy", "close"]);
});

test("offscreen client: no answer means nobody handled the request", async () => {
  const h = harness({ answer: async () => undefined });
  await assert.rejects(createOffscreenClient(h.deps).ask(COPY), /offscreen document did not answer/);
});

test("isOffscreenRequest: only extension contexts outside a tab are answered", () => {
  // The service worker and the extension's own pages have no tab; a content script's sender has one.
  assert.equal(isOffscreenRequest(COPY, {}), true);
  assert.equal(isOffscreenRequest(COPY, { tab: { id: 1 } }), false);
  assert.equal(isOffscreenRequest({ type: "copy", plain: "p", html: "h" }, {}), false);
  assert.equal(isOffscreenRequest({ to: "offscreen", type: "other" }, {}), false);
  assert.equal(isOffscreenRequest(null, {}), false);
});

const AREA: ImageArea = { x: 0, y: 0, width: 50, height: 30, kind: "img" };
const TILE: RasterTile = {
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  dataURL: "data:x",
  pixelWidth: 200,
  pixelHeight: 100,
  format: "png",
};

test("recognizeInOffscreen: without image areas no document is asked", async () => {
  const out = await recognizeInOffscreen([], [TILE], [], async () => assert.fail("asked"));
  assert.equal(out.info.status, "no-areas");
});

test("recognizeInOffscreen: the offscreen document's result is the result", async () => {
  const result: OcrOutput = {
    runs: [],
    info: {
      engine: "e",
      langs: ["eng"],
      areas: 1,
      recognized: 1,
      truncated: false,
      words: 0,
      ms: 5,
      status: "ok",
    },
  };
  let asked: OffscreenRequest | undefined;
  const out = await recognizeInOffscreen([AREA], [TILE], [], async (request) => {
    asked = request;
    return result;
  });
  assert.deepEqual(out, result);
  assert.deepEqual(asked, { to: "offscreen", type: "ocr", areas: [AREA], tiles: [TILE], runs: [] });
});

test("recognizeInOffscreen: a document that fails costs the OCR text, not the save", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await recognizeInOffscreen([AREA], [TILE], [], async () => {
      throw new Error("Message exceeded maximum allowed size of 64MiB.");
    });
    assert.equal(out.info.status, "failed");
    assert.equal(out.info.areas, 1);
    assert.equal(out.info.recognized, 0);
    assert.deepEqual(out.runs, []);
  } finally {
    console.warn = warn;
  }
});
