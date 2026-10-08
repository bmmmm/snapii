// SPDX-License-Identifier: GPL-3.0-or-later
// PNG decoding and the regex reading of the SVG files snapii writes, for the
// glue tests and the interactive driver.
import { decodeRows } from "./png.mjs";

/** PNG → { width, height, at(x, y) → [r, g, b, a] }. */
export async function decodePng(buf) {
  const rows = [];
  let bpp = 4;
  const info = await decodeRows(buf, (y, row, b) => {
    bpp = b;
    rows[y] = Buffer.from(row);
  });
  return {
    width: info.width,
    height: info.height,
    at(x, y) {
      const row = rows[y];
      const i = x * bpp;
      return [row[i], row[i + 1], row[i + 2], bpp === 4 ? row[i + 3] : 255];
    },
    /** Pixels in the device-px rect whose colour differs from `rgb` by more than `tol` per channel. */
    countOff(rect, rgb, tol = 0) {
      let off = 0;
      let total = 0;
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const p = this.at(x, y);
          total++;
          if (Math.abs(p[0] - rgb[0]) > tol || Math.abs(p[1] - rgb[1]) > tol || Math.abs(p[2] - rgb[2]) > tol)
            off++;
        }
      }
      return { off, total };
    },
  };
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** The parts of a saved SVG the checklist looks at, by regex over the exact bytes snapii writes. */
export function parseSvg(text) {
  const dc = {};
  for (const m of text.matchAll(/<dc:(\w+)>([^<]*)<\/dc:\w+>/g)) dc[m[1]] = unescapeXml(m[2]);
  const json = /<snapii:capture[^>]*>([^<]*)<\/snapii:capture>/.exec(text);
  const images = [...text.matchAll(/<image ([^>]*)\/>/g)].map((m) => {
    const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1];
    return {
      x: Number(attr("x")),
      y: Number(attr("y")),
      width: Number(attr("width")),
      height: Number(attr("height")),
      href: unescapeXml(attr("xlink:href") ?? ""),
    };
  });
  // One <text> per run (the renderer's font attributes tell runs from the
  // line separators), its glyphs in a <tspan> where a decoration of another
  // colour paints the <text>; the key keeps its old name for the callers.
  const tspans = [
    ...text.matchAll(/<text [^>]*font-size[^>]*>(?:<tspan [^>]*>)?([^<]*)(?:<\/tspan>)?<\/text>/g),
  ].map((m) => unescapeXml(m[1]));
  const hrefs = [...text.matchAll(/<a href="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  return { dc, capture: json ? JSON.parse(unescapeXml(json[1])) : null, images, tspans, hrefs };
}

/** Decoded PNG of an `<image>`'s data URL. */
export function decodeDataUrl(href) {
  const m = /^data:image\/png;base64,(.*)$/.exec(href);
  if (!m) throw new Error(`not a PNG data URL: ${href.slice(0, 40)}`);
  return decodePng(Buffer.from(m[1], "base64"));
}

/** Union of pixels with exactly this colour, in device px, or null. */
export function boundsOf(img, rgb) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = img.at(x, y);
      if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
