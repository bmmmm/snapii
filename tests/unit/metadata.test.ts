// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMetadata } from "../../src/shared/svg/metadata.ts";
import type { PageMeta, RenderInput } from "../../src/shared/types.ts";

function makeInput(page: Partial<PageMeta> = {}): RenderInput {
  return {
    region: { x: 100, y: 250.5, width: 400, height: 120 },
    runs: [
      {
        text: "Hello",
        x: 0,
        y: 16,
        top: 2,
        width: 40,
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
      },
    ],
    links: [],
    page: {
      url: "https://example.com/post?a=1&b=2",
      title: "Example post",
      lang: "en",
      textFragmentURL: null,
      textFragmentStatus: "DISABLED",
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 200 },
      devicePixelRatio: 2,
      capturedAt: "2026-10-01T12:00:00.000Z",
      mode: "element",
      skippedFrames: 1,
      skippedVertical: 2,
      ...page,
    },
    tiles: [
      {
        x: 0,
        y: 0,
        width: 400,
        height: 80,
        dataURL: "data:image/png;base64,AAAA",
        pixelWidth: 800,
        pixelHeight: 160,
        format: "png",
      },
      {
        x: 0,
        y: 80,
        width: 400,
        height: 40,
        dataURL: "data:image/png;base64,BBBB",
        pixelWidth: 800,
        pixelHeight: 80,
        format: "jpeg",
      },
    ],
    extensionVersion: "0.1.0",
    zoom: 1.1,
    scale: 2,
  };
}

// XML 1.0 Char, written independently of src/shared/svg/xml.ts.
const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

function dcValue(xml: string, name: string): string | undefined {
  const m = new RegExp(`<dc:${name}>([^<]*)</dc:${name}>`).exec(xml);
  return m?.[1] === undefined ? undefined : unescapeXml(m[1]);
}

function captureJson(xml: string): unknown {
  const m = /<snapii:capture [^>]*>([^<]*)<\/snapii:capture>/.exec(xml);
  assert.ok(m?.[1] !== undefined, "snapii:capture element with text content");
  return JSON.parse(unescapeXml(m[1]));
}

test("metadata: dc:source falls back to the plain URL, dc:relation is always the plain URL", () => {
  const plain = renderMetadata(makeInput());
  assert.equal(dcValue(plain, "source"), "https://example.com/post?a=1&b=2");
  assert.equal(dcValue(plain, "relation"), "https://example.com/post?a=1&b=2");

  const withFragment = renderMetadata(
    makeInput({
      textFragmentURL: "https://example.com/post?a=1&b=2#:~:text=Hello",
      textFragmentStatus: "SUCCESS",
    }),
  );
  assert.equal(dcValue(withFragment, "source"), "https://example.com/post?a=1&b=2#:~:text=Hello");
  assert.equal(dcValue(withFragment, "relation"), "https://example.com/post?a=1&b=2");
});

test("metadata: Dublin Core fields", () => {
  const xml = renderMetadata(makeInput());
  assert.equal(dcValue(xml, "title"), "Example post");
  assert.equal(dcValue(xml, "date"), "2026-10-01T12:00:00.000Z");
  assert.equal(dcValue(xml, "format"), "image/svg+xml");
  assert.equal(dcValue(xml, "language"), "en");
  assert.match(xml, /xmlns:rdf="http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#"/);
  assert.match(xml, /xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/);
});

test("metadata: dc:language only when the language is known", () => {
  assert.equal(dcValue(renderMetadata(makeInput({ lang: null })), "language"), undefined);
  assert.equal(dcValue(renderMetadata(makeInput({ lang: "" })), "language"), undefined);
  assert.equal(dcValue(renderMetadata(makeInput({ lang: "de-AT" })), "language"), "de-AT");
});

test("metadata: the element is complete and the capture block carries its namespace and type", () => {
  const xml = renderMetadata(makeInput());
  assert.ok(xml.startsWith("<metadata>"));
  assert.ok(xml.endsWith("</metadata>"));
  assert.match(
    xml,
    /<snapii:capture xmlns:snapii="urn:x-snapii:capture:1" content-type="application\/json">/,
  );
  assert.equal(xml.match(/<snapii:capture /g)?.length, 1);
});

test("metadata: the JSON round-trips after unescaping", () => {
  const input = makeInput({
    textFragmentURL: "https://example.com/post#:~:text=a%2Db",
    textFragmentStatus: "SUCCESS",
  });
  assert.deepEqual(captureJson(renderMetadata(input)), {
    schema: 1,
    extensionVersion: "0.1.0",
    url: "https://example.com/post?a=1&b=2",
    textFragmentURL: "https://example.com/post#:~:text=a%2Db",
    textFragmentStatus: "SUCCESS",
    capturedAt: "2026-10-01T12:00:00.000Z",
    title: "Example post",
    lang: "en",
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 200 },
    devicePixelRatio: 2,
    zoom: 1.1,
    scale: 2,
    selection: { mode: "element", x: 100, y: 250.5, width: 400, height: 120 },
    tiles: [
      { rect: { x: 0, y: 0, width: 400, height: 80 }, pixelWidth: 800, pixelHeight: 160, format: "png" },
      { rect: { x: 0, y: 80, width: 400, height: 40 }, pixelWidth: 800, pixelHeight: 80, format: "jpeg" },
    ],
    runCount: 1,
    skippedFrames: 1,
    skippedVertical: 2,
  });
});

test("metadata: unknown values are null in the JSON, the image data is not copied", () => {
  const xml = renderMetadata(makeInput({ lang: null }));
  const json = captureJson(xml) as { lang: unknown; textFragmentURL: unknown };
  assert.equal(json.lang, null);
  assert.equal(json.textFragmentURL, null);
  assert.ok(!xml.includes("base64"));
});

test("metadata: a fragment URL with & and - survives in dc:source and in the JSON", () => {
  const fragment =
    "https://example.com/a?x=1&y=2&amp=3#:~:text=pre%2Dfix-,start&more,end,-suf%2Dfix&text=other";
  const xml = renderMetadata(makeInput({ textFragmentURL: fragment, textFragmentStatus: "SUCCESS" }));
  assert.equal(dcValue(xml, "source"), fragment);
  assert.equal((captureJson(xml) as { textFragmentURL: string }).textFragmentURL, fragment);
  // On the wire the ampersands are entity-escaped, never bare.
  assert.ok(xml.includes("x=1&amp;y=2&amp;amp=3"), "dc:source carries &amp;");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(xml), "no bare ampersand anywhere");
});

test("metadata: hostile page text cannot break out of the element or lose information", () => {
  const title = 'a</snapii:capture><x/> --> ]]> & "q" \u0001 \ud800 \u{1f600}';
  const xml = renderMetadata(makeInput({ title }));
  assert.equal(xml.match(/<snapii:capture /g)?.length, 1);
  assert.equal(xml.match(/<\/snapii:capture>/g)?.length, 1);
  assert.equal((captureJson(xml) as { title: string }).title, title);
  // Only the JSON keeps the exotic characters; the Dublin Core copy is sanitised.
  assert.equal(dcValue(xml, "title"), 'a</snapii:capture><x/> --> ]]> & "q"   \u{1f600}');
  // Whole-code-point iteration: a lone surrogate shows up as its own element.
  for (const ch of xml) {
    const cp = ch.codePointAt(0) ?? -1;
    assert.ok(isXmlChar(cp), `invalid XML character U+${cp.toString(16)} in the output`);
  }
});

test("metadata: deterministic", () => {
  assert.equal(renderMetadata(makeInput()), renderMetadata(makeInput()));
});

test("metadata: the OCR record is in the JSON only when the input has one", () => {
  const info = {
    engine: "tesseract.js 7.0.0",
    langs: ["deu", "eng"],
    areas: 3,
    recognized: 2,
    truncated: true,
    words: 20,
    ms: 804,
    status: "ok" as const,
  };
  const withOcr = captureJson(renderMetadata({ ...makeInput(), ocr: { runs: [], info } })) as Record<
    string,
    unknown
  >;
  assert.deepEqual(withOcr.ocr, info);
  const without = captureJson(renderMetadata(makeInput())) as Record<string, unknown>;
  assert.equal("ocr" in without, false);
});
