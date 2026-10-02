// SPDX-License-Identifier: GPL-3.0-or-later
// The <metadata> block: Dublin Core RDF for generic tools, plus the full
// capture record as JSON for anything that wants to reproduce or audit the
// capture. Deterministic: no clocks, `capturedAt` comes from the caller.

import type { OcrInfo, RenderInput } from "../types.ts";
import { xmlText } from "./xml.ts";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const SNAPII_NS = "urn:x-snapii:capture:1";

const ocrRecord = (o: OcrInfo): OcrInfo => ({
  engine: o.engine,
  langs: [...o.langs],
  areas: o.areas,
  recognized: o.recognized,
  truncated: o.truncated,
  words: o.words,
  ms: o.ms,
  status: o.status,
});

/**
 * The capture record. `selection` is the region in document CSS px as given;
 * tile rects are region-relative CSS px like everything else in `RenderInput`.
 * Pixel sizes live here only — `<image>` geometry is always the CSS rect.
 * Fields are copied one by one so extra properties on the input can never
 * leak into the file.
 */
function captureRecord(input: RenderInput) {
  const { page, region } = input;
  return {
    schema: 1,
    extensionVersion: input.extensionVersion,
    url: page.url,
    textFragmentURL: page.textFragmentURL,
    textFragmentStatus: page.textFragmentStatus,
    capturedAt: page.capturedAt,
    title: page.title,
    lang: page.lang,
    viewport: { width: page.viewport.width, height: page.viewport.height },
    scroll: { x: page.scroll.x, y: page.scroll.y },
    devicePixelRatio: page.devicePixelRatio,
    zoom: input.zoom,
    scale: input.scale,
    selection: { mode: page.mode, x: region.x, y: region.y, width: region.width, height: region.height },
    tiles: input.tiles.map((t) => ({
      rect: { x: t.x, y: t.y, width: t.width, height: t.height },
      pixelWidth: t.pixelWidth,
      pixelHeight: t.pixelHeight,
      format: t.format,
    })),
    runCount: input.runs.length,
    skippedFrames: page.skippedFrames,
    skippedVertical: page.skippedVertical,
    ...(input.ocr ? { ocr: ocrRecord(input.ocr.info) } : {}),
  };
}

/**
 * The element as one string per structural line, so the document builder can
 * indent without ever splitting a value that contains a newline.
 */
export function metadataLines(input: RenderInput): string[] {
  const { page } = input;
  const dc = (name: string, value: string) => `      <dc:${name}>${xmlText(value)}</dc:${name}>`;
  return [
    "<metadata>",
    `  <rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:dc="${DC_NS}">`,
    '    <rdf:Description rdf:about="">',
    dc("title", page.title),
    dc("source", page.textFragmentURL ?? page.url),
    dc("relation", page.url),
    dc("date", page.capturedAt),
    dc("format", "image/svg+xml"),
    // An empty string is "unknown" just like null (documentElement.lang is "" without a lang attribute).
    ...(page.lang ? [dc("language", page.lang)] : []),
    "    </rdf:Description>",
    "  </rdf:RDF>",
    // JSON.stringify escapes control characters and lone surrogates itself;
    // xmlText only has to protect the markup characters.
    `  <snapii:capture xmlns:snapii="${SNAPII_NS}" content-type="application/json">${xmlText(JSON.stringify(captureRecord(input)))}</snapii:capture>`,
    "</metadata>",
  ];
}

/** The complete `<metadata>…</metadata>` element. */
export function renderMetadata(input: RenderInput): string {
  return metadataLines(input).join("\n");
}
