// SPDX-License-Identifier: GPL-3.0-or-later
// The raster renderer: tile <image>s carry the pixels, an invisible text layer
// carries one <text> per run (grouped per line) so text stays selectable and
// links stay clickable without OCR. Pure and deterministic: same input, same
// bytes.
//
// All coordinates in RenderInput are region-relative CSS px. Functions here
// return one string per structural line (joined by the public wrappers) so
// indentation is applied per line and never splits a run's own text.

import type { LinkArea, RasterTile, RenderInput, SvgRenderer, TextRun } from "../types.ts";
import { metadataLines } from "./metadata.ts";
import { fmt, xmlAttr, xmlText } from "./xml.ts";

const pad = (lines: string[]): string[] => lines.map((l) => `  ${l}`);

const anchor = (href: string, inner: string): string =>
  `<a href="${xmlAttr(href)}" xlink:href="${xmlAttr(href)}">${inner}</a>`;

// Invisible, but still hit-testable: SVG 2 drops `fill="none"` text from
// hit-testing, which would make it unselectable. Zero opacity keeps it.
const TRANSPARENT = 'fill="#000" fill-opacity="0"';

// One <text> per run, not one <tspan> per run inside a <text> per line:
// textLength has to pin each run's width so a viewer's other glyph metrics
// cannot move the hit area, and Firefox (measured in 155) ignores textLength
// on <tspan> and keeps the natural width, honouring it only on <text>
// (Chromium 153 honours both). Separate <text> elements still copy in
// document order, and the line separator, being its own <text>, can never
// join a run's text chunk (inside one <text> it shifted an RTL run that ended
// a line by one space width).
function runText(run: TextRun, visible: boolean): string {
  const rtl = run.dir === "rtl";
  const attrs = [
    // text-anchor is "start", which for direction=rtl means the right edge.
    `x="${fmt(rtl ? run.x + run.width : run.x)}"`,
    `y="${fmt(run.y)}"`,
    `textLength="${fmt(run.width)}"`,
    'lengthAdjust="spacingAndGlyphs"',
    `font-family="${xmlAttr(run.fontFamily)}"`,
    `font-size="${fmt(run.fontSize)}"`,
    `font-weight="${fmt(run.fontWeight)}"`,
    `font-style="${xmlAttr(run.fontStyle)}"`,
  ];
  if (rtl) attrs.push('direction="rtl"');
  if (run.lang) attrs.push(`xml:lang="${xmlAttr(run.lang)}"`);
  if (visible) attrs.push(`fill="${xmlAttr(run.color)}"`);
  const el = `<text ${attrs.join(" ")}>${xmlText(run.text)}</text>`;
  return run.href === null ? el : anchor(run.href, el);
}

// Keeps copied words of consecutive lines apart. Placed at the line's right
// end so its own small box sits beside the line, not at the origin.
function lineSeparator(lineRuns: TextRun[]): string {
  const x = Math.max(...lineRuns.map((r) => r.x + r.width));
  const y = lineRuns[lineRuns.length - 1]?.y ?? 0;
  return `<text x="${fmt(x)}" y="${fmt(y)}"> </text>`;
}

function textLayerLines(runs: TextRun[], visible: boolean, id = "text"): string[] {
  const byLine = new Map<number, TextRun[]>();
  for (const run of runs) {
    const line = byLine.get(run.line);
    if (line) line.push(run);
    else byLine.set(run.line, [run]);
  }
  // Under xml:space="preserve" Firefox copies every whitespace character in
  // the layer, even between elements (measured: the indentation of each line
  // showed up in select-all), so the layer is written as one line with no
  // whitespace between its elements; the separators alone split the lines.
  const lines = [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, lineRuns]) =>
        `<g>${lineRuns.map((r) => runText(r, visible)).join("")}${lineSeparator(lineRuns)}</g>`,
    );
  const open = `<g id="${id}" xml:space="preserve" style="white-space:pre"${visible ? "" : ` ${TRANSPARENT}`}>`;
  return [`${open}${lines.join("")}</g>`];
}

/** The `<g id="text">` element. `visible: true` is the phase-2 seam. */
export function renderTextLayer(runs: TextRun[], opts: { visible: boolean }): string {
  return textLayerLines(runs, opts.visible).join("\n");
}

function linkLine(link: LinkArea): string {
  const attrs = `x="${fmt(link.x)}" y="${fmt(link.y)}" width="${fmt(link.width)}" height="${fmt(link.height)}" ${TRANSPARENT}`;
  const rect =
    link.alt === "" ? `<rect ${attrs}/>` : `<rect ${attrs}><title>${xmlText(link.alt)}</title></rect>`;
  return link.href === null ? rect : anchor(link.href, rect);
}

function linksLines(links: LinkArea[]): string[] {
  return links.length === 0
    ? ['<g id="links"></g>']
    : ['<g id="links">', ...pad(links.map(linkLine)), "</g>"];
}

// Geometry is the tile's CSS rect; pixelWidth/pixelHeight go to metadata only,
// so a wrong `scale` can cost sharpness but never position.
const imageLine = (t: RasterTile): string =>
  `<image x="${fmt(t.x)}" y="${fmt(t.y)}" width="${fmt(t.width)}" height="${fmt(t.height)}" preserveAspectRatio="none" xlink:href="${xmlAttr(t.dataURL)}"/>`;

/** The whole document: tiles, link areas, invisible text layer, metadata. */
export const rasterTextRenderer: SvgRenderer = (input: RenderInput): string => {
  const { page, region } = input;
  const w = fmt(region.width);
  const h = fmt(region.height);
  const lang = page.lang ? ` xml:lang="${xmlAttr(page.lang)}"` : "";
  const desc = `Region of ${page.url} captured ${page.capturedAt} by snapii ${input.extensionVersion}. Text is selectable; links are clickable.`;
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${lang}>`,
    `  <title>${xmlText(page.title)}</title>`,
    `  <desc>${xmlText(desc)}</desc>`,
    ...pad(metadataLines(input)),
    ...pad(input.tiles.map(imageLine)),
    ...pad(linksLines(input.links)),
    ...pad(textLayerLines(input.runs, false)),
    // Text read from the pixels by OCR: the same invisible layer, in a group
    // of its own so a reader can tell it from the page's own text.
    ...(input.ocr && input.ocr.runs.length > 0 ? pad(textLayerLines(input.ocr.runs, false, "ocr")) : []),
    "</svg>",
  ].join("\n")}\n`;
};
