// SPDX-License-Identifier: GPL-3.0-or-later
// The vector renderer: the scene's boxes as SVG shapes, patches as <image>s
// over them, link areas, and one text layer on top whose runs are visible
// where the boxes leave them showing and invisible (but selectable) where a
// patch or a later box shows or hides them. Pure and deterministic like the
// raster renderer; clip ids are a counter, never anything from the page.
//
// Layer order, bottom to top: canvas, boxes, patches, links, text. Patches
// lie over every box because a patch is a screenshot of its area: whatever
// the boxes there would paint is already in its pixels.

import { unionArea } from "../geometry.ts";
import { SPIKE_VECTOR } from "../spike.ts";
import type {
  DocRect,
  LinearGradient,
  Paint,
  Radii,
  RenderInput,
  Scene,
  SceneClip,
  SceneOp,
  TextPaint,
  TextRun,
} from "../types.ts";
import { imageLine, linksLines, pad, TRANSPARENT, textLayerLines } from "./build.ts";
import { metadataLines, type VectorRecord } from "./metadata.ts";
import { fmt, xmlAttr, xmlText } from "./xml.ts";

/** `tiles` are the patches' pixels, region-relative like the patches themselves. */
export interface VectorRenderInput extends RenderInput {
  scene: Scene;
}

// A viewer without the page's fonts keeps at least the kind of face.
const FALLBACK_FAMILY = "sans-serif";
// textLength pins each run's width; visible glyphs keep their shape (V1).
const LENGTH_ADJUST = SPIKE_VECTOR.visibleTextLengthAdjust;

const channel = (v: number): string =>
  Number.isFinite(v) ? String(Math.round(Math.min(255, Math.max(0, v)))) : "0";

/** `fill`/`stroke` and its opacity from numbers only; an opaque paint gets no opacity attribute. */
function paintAttrs(p: Paint, prop: "fill" | "stroke"): string {
  const rgb = `${prop}="rgb(${channel(p.r)},${channel(p.g)},${channel(p.b)})"`;
  const a = Number.isFinite(p.a) ? Math.min(1, Math.max(0, p.a)) : 0;
  return a >= 1 ? rgb : `${rgb} ${prop}-opacity="${fmt(a)}"`;
}

const NO_RADII: Radii = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

/**
 * CSS shrinks all radii by one factor when two of them overlap along a side
 * (css-backgrounds-3 § 5.5); an SVG <rect> would clamp rx and ry each on its
 * own and make a pill's round ends elliptical.
 */
export function fitRadii(w: number, h: number, radii: Radii): Radii {
  // A corner with either radius zero is square (css-backgrounds-3 § 5.2).
  const square = radii.map(([x, y]) => (x > 0 && y > 0 ? [x, y] : [0, 0])) as Radii;
  const [tl, tr, br, bl] = square;
  // A side whose radii sum to zero sets no limit; a side of length zero sets them to zero.
  const side = (length: number, sum: number) => (sum > 0 ? Math.max(0, length) / sum : 1);
  const f = Math.min(
    1,
    side(w, tl[0] + tr[0]),
    side(h, tr[1] + br[1]),
    side(w, br[0] + bl[0]),
    side(h, bl[1] + tl[1]),
  );
  return f >= 1 ? square : (square.map(([x, y]) => [x * f, y * f]) as Radii);
}

const isZero = (r: Radii): boolean => r.every(([x]) => x === 0);
const isUniform = (r: Radii): boolean => r.every(([x, y]) => x === r[0][0] && y === r[0][1]);

/** A box outline: <rect> (rounded alike at every corner) or <path> with one arc per corner. */
function shape(box: DocRect, radii: Radii | undefined, attrs: string): string {
  const { x, y, width: w, height: h } = box;
  const geo = `x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"`;
  const tail = attrs ? ` ${attrs}/>` : "/>";
  const r = radii ? fitRadii(w, h, radii) : NO_RADII;
  if (isZero(r)) return `<rect ${geo}${tail}`;
  if (isUniform(r)) {
    const [rx, ry] = r[0];
    return `<rect ${geo} rx="${fmt(rx)}"${ry === rx ? "" : ` ry="${fmt(ry)}"`}${tail}`;
  }
  return `<path d="${pathData(box, r)}"${tail}`;
}

/** Path data of a box with these (already fitted) radii, clockwise from the top-left corner. */
function pathData(box: DocRect, r: Radii): string {
  const { x, y, width: w, height: h } = box;
  const [tl, tr, br, bl] = r;
  // A square corner needs no segment: the side lines already meet there.
  const arc = ([rx, ry]: [number, number], ex: number, ey: number) =>
    rx > 0 ? `A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(ex)} ${fmt(ey)}` : "";
  return [
    `M${fmt(x + tl[0])} ${fmt(y)}`,
    `H${fmt(x + w - tr[0])}`,
    arc(tr, x + w, y + tr[1]),
    `V${fmt(y + h - br[1])}`,
    arc(br, x + w - br[0], y + h),
    `H${fmt(x + bl[0])}`,
    arc(bl, x, y + h - bl[1]),
    `V${fmt(y + tl[1])}`,
    arc(tl, x + tl[0], y),
    "Z",
  ].join("");
}

/**
 * A border of unequal widths in one colour: the box minus its padding box,
 * whose corners curve by the outer radius less the adjoining widths
 * (css-backgrounds-3 § 5.3).
 */
function ringLine(
  op: Extract<SceneOp, { op: "rect" }>,
  widths: [number, number, number, number],
  paint: Paint,
): string {
  const [t, rt, b, l] = widths;
  const outer = op.radii ? fitRadii(op.width, op.height, op.radii) : NO_RADII;
  const inner = outer.map(([x, y], i) => [
    Math.max(0, x - (i === 0 || i === 3 ? l : rt)),
    Math.max(0, y - (i < 2 ? t : b)),
  ]) as Radii;
  const box = {
    x: op.x + l,
    y: op.y + t,
    width: Math.max(0, op.width - l - rt),
    height: Math.max(0, op.height - t - b),
  };
  const d = `${pathData(op, outer)}${pathData(box, fitRadii(box.width, box.height, inner))}`;
  return `<path d="${d}" fill-rule="evenodd" ${paintAttrs(paint, "fill")}/>`;
}

const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
// A stop's offset is a share of the gradient line, which can be thousands of
// px long: fmt's two decimals would move it by up to half a percent of that.
const offset = (v: number): string => String(Number(unit(v).toFixed(6)));

/** Hands out clip and gradient ids in order of first use; one definition per distinct one. */
class Defs {
  #ids = new Map<string, string>();
  #clips = 0;
  #gradients = 0;
  #defs: string[] = [];

  clip(clip: SceneClip): string {
    return this.#id(["clip", clip.x, clip.y, clip.width, clip.height, clip.radii ?? null], () => {
      const id = `c${this.#clips++}`;
      return [id, `<clipPath id="${id}">${shape(clip, clip.radii, "")}</clipPath>`];
    });
  }

  /** A gradient over the rect at (x, y): its line is relative to that corner. */
  gradient(g: LinearGradient, x: number, y: number): string {
    const [x1, y1, x2, y2] = [x + g.from[0], y + g.from[1], x + g.to[0], y + g.to[1]];
    return this.#id(["gradient", x1, y1, x2, y2, g.stops], () => {
      const id = `g${this.#gradients++}`;
      const stops = g.stops.map((s) => {
        const p = s.paint;
        const a = unit(p.a);
        const opacity = a >= 1 ? "" : ` stop-opacity="${fmt(a)}"`;
        return `<stop offset="${offset(s.offset)}" stop-color="rgb(${channel(p.r)},${channel(p.g)},${channel(p.b)})"${opacity}/>`;
      });
      return [
        id,
        [
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}">`,
          ...pad(stops),
          "</linearGradient>",
        ].join("\n"),
      ];
    });
  }

  #id(key: unknown[], make: () => [string, string]): string {
    const k = JSON.stringify(key);
    let id = this.#ids.get(k);
    if (!id) {
      const [made, def] = make();
      id = made;
      this.#ids.set(k, id);
      this.#defs.push(def);
    }
    return id;
  }

  lines(): string[] {
    return this.#defs.length === 0
      ? []
      : ["<defs>", ...pad(this.#defs.flatMap((d) => d.split("\n"))), "</defs>"];
  }
}

/** A CSS border is painted inside the border box: a stroke centred half its width in. */
function rectLines(op: Extract<SceneOp, { op: "rect" }>, defs: Defs): string[] {
  const out: string[] = [];
  if (op.fill) out.push(shape(op, op.radii, paintAttrs(op.fill, "fill")));
  if (op.gradient) out.push(shape(op, op.radii, `fill="url(#${defs.gradient(op.gradient, op.x, op.y)})"`));
  const stroke = op.stroke;
  if (stroke && stroke.width > 0) {
    const w = stroke.width;
    if (2 * w >= op.width || 2 * w >= op.height) {
      // The border covers the whole box.
      out.push(shape(op, op.radii, paintAttrs(stroke.paint, "fill")));
    } else {
      const outer = op.radii ? fitRadii(op.width, op.height, op.radii) : NO_RADII;
      const inner = outer.map(([x, y]) => [Math.max(0, x - w / 2), Math.max(0, y - w / 2)]) as Radii;
      const box = { x: op.x + w / 2, y: op.y + w / 2, width: op.width - w, height: op.height - w };
      out.push(
        shape(box, inner, `fill="none" ${paintAttrs(stroke.paint, "stroke")} stroke-width="${fmt(w)}"`),
      );
    }
  }
  const border = op.border;
  if (border?.widths.some((w) => w > 0)) out.push(ringLine(op, border.widths, border.paint));
  return out;
}

function opLines(op: SceneOp, defs: Defs): string[] {
  if (op.op === "rect") return rectLines(op, defs);
  if (op.op === "image") {
    return [
      `<image x="${fmt(op.x)}" y="${fmt(op.y)}" width="${fmt(op.width)}" height="${fmt(op.height)}" preserveAspectRatio="none" xlink:href="${xmlAttr(op.dataURL)}"/>`,
    ];
  }
  const attrs = [
    ...(op.clip ? [`clip-path="url(#${defs.clip(op.clip)})"`] : []),
    ...(op.opacity !== undefined && op.opacity < 1 ? [`opacity="${fmt(Math.max(0, op.opacity))}"`] : []),
  ];
  const children = op.children.flatMap((c) => opLines(c, defs));
  return [`<g${attrs.length ? ` ${attrs.join(" ")}` : ""}>`, ...pad(children), "</g>"];
}

const countOps = (ops: readonly SceneOp[]): number =>
  ops.reduce((n, op) => n + 1 + (op.op === "group" ? countOps(op.children) : 0), 0);

/** The whole document: canvas, boxes, patches, link areas, text layer, metadata. */
export function vectorRenderer(input: VectorRenderInput): string {
  const { page, region, scene } = input;
  // Whole pixels: Chromium draws an SVG document of a fractional size
  // resampled, every shape, glyph and patch pixel a little blurred (measured
  // on Linux, 2026-10-05: 168.56 px wide 9.7 % of the pixels off, 169 px wide
  // none). The content keeps its region-relative place; the canvas colour
  // fills the strip of less than a pixel, as the page goes on there.
  const w = fmt(Math.ceil(region.width - 0.005));
  const h = fmt(Math.ceil(region.height - 0.005));
  const lang = page.lang ? ` xml:lang="${xmlAttr(page.lang)}"` : "";
  const desc = `Region of ${page.url} captured ${page.capturedAt} by snapii ${input.extensionVersion}. Shapes and text are vector; parts that could not be converted are pixels. Text is selectable; links are clickable.`;
  const defs = new Defs();
  const shapes = scene.ops.flatMap((op) => opLines(op, defs));

  const paints = new Map<TextRun, TextPaint | null>();
  input.runs.forEach((run, i) => {
    paints.set(run, scene.text[i] ?? null);
  });
  const paint = (run: TextRun): string => {
    // Without its edge space a visible run's glyphs close up on the next
    // run's (V2): the run preserves it itself, the layer's does not count.
    const own = SPIKE_VECTOR.edgeSpaceNeedsOwnPreserve && /^ | $/.test(run.text);
    const edge = own ? 'xml:space="preserve" ' : "";
    const p = paints.get(run);
    if (!p) return `${edge}${TRANSPARENT}`;
    const attrs = [paintAttrs(p.fill, "fill")];
    if (p.letterSpacing) attrs.push(`letter-spacing="${fmt(p.letterSpacing)}"`);
    if (p.clip) attrs.push(`clip-path="url(#${defs.clip(p.clip)})"`);
    return `${edge}${attrs.join(" ")}`;
  };
  const text = textLayerLines(input.runs, {
    paint,
    lengthAdjust: LENGTH_ADJUST,
    fallbackFamily: FALLBACK_FAMILY,
  });

  const record: VectorRecord = {
    ops: countOps(scene.ops),
    patches: scene.patches.length,
    patchArea: Number(unionArea(scene.patches).toFixed(2)),
    unsupported: scene.unsupported,
  };
  const group = (id: string, lines: string[]) =>
    lines.length === 0 ? [`<g id="${id}"></g>`] : [`<g id="${id}">`, ...pad(lines), "</g>"];
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${lang}>`,
    `  <title>${xmlText(page.title)}</title>`,
    `  <desc>${xmlText(desc)}</desc>`,
    ...pad(metadataLines(input, record)),
    ...pad(defs.lines()),
    `  <rect id="canvas" width="${w}" height="${h}" ${paintAttrs(scene.canvas, "fill")}/>`,
    ...pad(group("shapes", shapes)),
    ...pad(group("patches", input.tiles.map(imageLine))),
    ...pad(linksLines(input.links)),
    ...pad(text),
    "</svg>",
  ].join("\n")}\n`;
}
