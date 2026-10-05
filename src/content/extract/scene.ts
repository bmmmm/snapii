// SPDX-License-Identifier: GPL-3.0-or-later
// The DOM inside a capture rectangle -> a scene for the vector renderer:
// backgrounds and borders as boxes in paint order, patches (pixels) for what
// cannot be drawn so, and per text run a colour or null. The text itself
// stays the collector's runs, so Copy text, the fragment link and both
// renderers share one truth; this only decides how each run is painted.
//
// Paint order is CSS 2.1 Appendix E per stacking context: the context's own
// box, negative z-index contexts, block backgrounds, floats, inline content,
// positioned descendants with z-index auto or 0, positive z-index. Floats,
// inline-blocks, flex and grid items and positioned z-index:auto boxes paint
// atomically, but their positioned descendants and stacking contexts belong
// to the enclosing stacking context. What this approximates (table layers, a
// rounded clip that is not the binding one) is measured, not claimed.
//
// An element that cannot be drawn (plan §4.8) becomes a patch over its box
// and those of its descendants (R-patch); its text runs stay, invisible,
// because the pixels show them. Document coordinates throughout, the scene
// is made region-relative at the end.

import { parseColor } from "../../shared/color.ts";
import { intersect, union } from "../../shared/geometry.ts";
import type {
  DocRect,
  Paint,
  Patch,
  Radii,
  Scene,
  SceneClip,
  SceneOp,
  TextPaint,
  TextRun,
  UnsupportedReason,
} from "../../shared/types.ts";
import { collapse, isIconText } from "../../shared/whitespace.ts";
import { createHtml, setImportant } from "../overlay/styles.ts";
import type { RunSource } from "./collect.ts";
import { type FrameContext, flatParent, walkFlatTree } from "./flat-tree.ts";
import { Layout } from "./visibility.ts";

export interface SceneOptions {
  /** The collector's runs and, parallel to them, where each came from (document coordinates). */
  runs: readonly TextRun[];
  sources: readonly RunSource[];
  /** The snapii overlay, left out as everywhere else. */
  skip?: Element | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const FORM = new Set(["input", "select", "textarea", "meter", "progress"]);
const MEDIA = new Set(["video", "audio", "embed", "object"]);
// Replaced and void elements have no ::before/::after of their own.
const NO_PSEUDO = new Set([
  "img",
  "input",
  "video",
  "audio",
  "canvas",
  "iframe",
  "frame",
  "embed",
  "object",
  "select",
  "textarea",
  "br",
  "wbr",
]);
// A page this large, or one that takes this long, is taken as pixels, whole:
// the walk would cost more than the capture. Wikipedia's SVG article (4 800
// elements) takes 180 ms in Firefox (2026-10-05).
const MAX_ELEMENTS = 60_000;
const MAX_MS = 5_000;
// Beyond this many patches, overlapping ones merge, then whole bands.
const MAX_PATCHES = 2_000;
const BAND = 256;
// Below the limits the background's validator sets (shared/messages.ts).
const MAX_GROUP_DEPTH = 24;
const MAX_OPS = 150_000;

/** The walk ran out of budget: the region becomes one patch. */
class OverBudget extends Error {}
// Client rects come in 1/60 px steps; this much counts as the same edge.
const EPS = 0.5;
const WHITE: Paint = { r: 255, g: 255, b: 255, a: 1 };
const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

const px = (v: string): number => Number.parseFloat(v) || 0;
const contains = (r: DocRect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
const within = (inner: DocRect, outer: DocRect): boolean =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.width <= outer.x + outer.width + EPS &&
  inner.y + inner.height <= outer.y + outer.height + EPS;
const same = (a: DocRect, b: DocRect): boolean => within(a, b) && within(b, a);
const inset = (r: DocRect, t: number, rt: number, b: number, l: number): DocRect => ({
  x: r.x + l,
  y: r.y + t,
  width: Math.max(0, r.width - l - rt),
  height: Math.max(0, r.height - t - b),
});

interface Box {
  el: Element;
  ctx: FrameContext;
  cs: CSSStyleDeclaration;
  parent: Box | null;
  kids: (Box | Text)[];
  /** Its background is the canvas's (root or body propagation): not painted as its own. */
  propagated?: boolean;
  /** A frame whose document cannot be read. */
  opaque?: boolean;
}

/** A stacking context (real) or a box that paints atomically like one (pseudo). */
interface Layer {
  owner: Box;
  real: boolean;
  z: number;
  opacity: number;
  neg: Layer[];
  blocks: Box[];
  floats: Layer[];
  inlines: (Box | Layer | Text)[];
  positioned: Layer[];
  pos: Layer[];
}

const isBox = (x: Box | Layer | Text): x is Box => "kids" in x;
const isLayer = (x: Box | Layer | Text): x is Layer => "real" in x;

const layer = (owner: Box, real: boolean, z = 0, opacity = 1): Layer => ({
  owner,
  real,
  z,
  opacity,
  neg: [],
  blocks: [],
  floats: [],
  inlines: [],
  positioned: [],
  pos: [],
});

// Stable: equal z keep tree order.
const byZ = (layers: Layer[]): Layer[] => [...layers].sort((a, b) => a.z - b.z);

function sides(cs: CSSStyleDeclaration) {
  return SIDES.map((s) => ({
    width: px(cs.getPropertyValue(`border-${s}-width`)),
    style: cs.getPropertyValue(`border-${s}-style`),
    color: cs.getPropertyValue(`border-${s}-color`),
  }));
}

const shown = (s: { width: number; style: string }): boolean =>
  s.width > 0 && s.style !== "none" && s.style !== "hidden";

function hasPaintedBox(cs: CSSStyleDeclaration): boolean {
  const bg = parseColor(cs.backgroundColor);
  return (
    (bg !== null && bg.a > 0) ||
    cs.backgroundImage !== "none" ||
    cs.boxShadow !== "none" ||
    sides(cs).some(shown) ||
    (cs.outlineStyle !== "none" && px(cs.outlineWidth) > 0)
  );
}

/**
 * How far an element's shadows and filters paint beyond its box: an upper
 * bound from the lengths they are made of (a blur's reach is about three
 * times its radius).
 */
function inkMargin(cs: CSSStyleDeclaration): number {
  const lengths = (v: string) =>
    [...v.matchAll(/(-?\d*\.?\d+)px/g)].reduce((s, m) => s + Math.abs(Number(m[1])), 0);
  let m = 0;
  if (cs.boxShadow !== "none") m = Math.max(m, lengths(cs.boxShadow));
  if (cs.textShadow !== "none") m = Math.max(m, lengths(cs.textShadow));
  if (cs.filter !== "none") m = Math.max(m, 3 * lengths(cs.filter));
  return m;
}

const countOps = (ops: readonly SceneOp[]): number =>
  ops.reduce((n, op) => n + 1 + (op.op === "group" ? countOps(op.children) : 0), 0);

/** A clip-path or legacy clip of the element's own, which cuts its own box too. */
const ownShapeClip = (cs: CSSStyleDeclaration): boolean =>
  cs.clipPath !== "none" ||
  (cs.clip.startsWith("rect(") && (cs.position === "absolute" || cs.position === "fixed"));

function translateOp(op: SceneOp, dx: number, dy: number): SceneOp {
  if (op.op === "group") {
    return {
      ...op,
      ...(op.clip ? { clip: { ...op.clip, x: op.clip.x + dx, y: op.clip.y + dy } } : {}),
      children: op.children.map((c) => translateOp(c, dx, dy)),
    };
  }
  return { ...op, x: op.x + dx, y: op.y + dy };
}

class Builder {
  readonly #layout = new Layout();
  readonly #boxes = new Map<Element, Box>();
  readonly #patches: Patch[] = [];
  readonly #unsupported: Partial<Record<UnsupportedReason, number>> = {};
  /** Opaque fills in paint order, by band of BAND px, for text a later box hides. */
  readonly #painted = new Map<number, { rect: DocRect; seq: number }[]>();
  readonly #textSeq = new Map<Text, number>();
  readonly #contentClips = new Map<Box, SceneClip | null>();
  readonly #opacities = new Map<Box, number>();
  readonly #rects = new Map<Box, DocRect>();
  #seq = 0;
  #alpha = 1;
  #depth = 0;
  #deadline = 0;
  readonly doc: Document;
  readonly region: DocRect;
  readonly opts: SceneOptions;

  constructor(doc: Document, region: DocRect, opts: SceneOptions) {
    this.doc = doc;
    this.region = region;
    this.opts = opts;
  }

  build(): Scene {
    this.#deadline = performance.now() + MAX_MS;
    let canvas = WHITE;
    let ops: SceneOp[] = [];
    try {
      const root = this.#walk();
      canvas = this.#canvas(root);
      if (!root) throw new OverBudget();
      const reason = this.#reasonOf(root);
      if (reason) {
        this.#patch(root, [this.region], reason);
      } else {
        const top = layer(root, true);
        this.#visit(root, top, top);
        this.#paint(top, ops);
        if (countOps(ops) > MAX_OPS) throw new OverBudget();
      }
    } catch (e) {
      // Too large, too slow, or nested deeper than the call stack goes: the
      // region is pixels, whole, like a raster capture.
      // A stack overflow: RangeError in Chromium, InternalError in Firefox. Any
      // other RangeError is a bug and stays one.
      const deep =
        (e instanceof RangeError && /call stack/i.test(e.message)) ||
        (e instanceof Error && e.name === "InternalError" && /recursion/i.test(e.message));
      if (!(e instanceof OverBudget) && !deep) throw e;
      ops = [];
      this.#patches.length = 0;
      for (const k of Object.keys(this.#unsupported)) delete this.#unsupported[k as UnsupportedReason];
      this.#patch(null, [this.region], "budget");
    }
    this.#limitPatches();
    const text = this.opts.runs.map((run, i) => this.#textPaint(run, this.opts.sources[i]));
    const dx = -this.region.x;
    const dy = -this.region.y;
    return {
      canvas,
      ops: ops.map((op) => translateOp(op, dx, dy)),
      patches: this.#patches.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
      text: text.map((t) =>
        t?.clip ? { ...t, clip: { ...t.clip, x: t.clip.x + dx, y: t.clip.y + dy } } : t,
      ),
      unsupported: this.#unsupported,
    };
  }

  /** Border box in document coordinates, read once. */
  #rect(b: Box): DocRect {
    let r = this.#rects.get(b);
    if (!r) {
      r = this.#layout.toDoc(b.el.getBoundingClientRect(), b.ctx);
      this.#rects.set(b, r);
    }
    return r;
  }

  /** The flat tree as boxes; null when the page is too large to be worth it. */
  #walk(): Box | null {
    let count = 0;
    let root: Box | null = null;
    const opaque = new Set<Element>();
    for (const { node, ctx } of walkFlatTree(this.doc, {
      skip: this.opts.skip,
      onOpaqueFrame: (frame) => opaque.add(frame),
    })) {
      const up = flatParent(node) ?? ctx.frame;
      const parent = up ? this.#boxes.get(up) : undefined;
      if (node.nodeType === Node.TEXT_NODE) {
        parent?.kids.push(node as Text);
        continue;
      }
      if (++count > MAX_ELEMENTS) return null;
      const el = node as Element;
      const box: Box = { el, ctx, cs: this.#layout.style(el), parent: parent ?? null, kids: [] };
      this.#boxes.set(el, box);
      if (parent) parent.kids.push(box);
      else root ??= box;
    }
    for (const frame of opaque) {
      const box = this.#boxes.get(frame);
      if (box) box.opaque = true;
    }
    return root;
  }

  /**
   * The canvas colour: the root's background, else body's (CSS propagates it
   * to the whole canvas), else the system colour Canvas in the root's colour
   * scheme. A propagated background image cannot be drawn: the region is a patch.
   */
  #canvas(root: Box | null): Paint {
    const source = root && this.#propagation(root);
    if (source) {
      source.propagated = true;
      if (source.cs.backgroundImage !== "none") {
        const url = source.cs.backgroundImage.includes("url(");
        this.#patch(source, [this.region], url ? "background-image" : "gradient");
      }
      const bg = parseColor(source.cs.backgroundColor);
      if (bg && bg.a >= 1) return bg;
      // A see-through background is painted over the system canvas.
      if (bg && bg.a > 0) {
        const under = this.#systemCanvas();
        const mix = (c: number, u: number) => c * bg.a + u * (1 - bg.a);
        return { r: mix(bg.r, under.r), g: mix(bg.g, under.g), b: mix(bg.b, under.b), a: 1 };
      }
    }
    return this.#systemCanvas();
  }

  /** The box whose background is the canvas's, if any has one. */
  #propagation(root: Box): Box | null {
    const has = (b: Box) => {
      const bg = parseColor(b.cs.backgroundColor);
      return (bg !== null && bg.a > 0) || b.cs.backgroundImage !== "none";
    };
    if (has(root)) return root;
    const body = root.kids.find((k): k is Box => isBox(k) && k.el.localName === "body");
    return body && has(body) ? body : null;
  }

  // Read through a probe on the page itself: the overlay's host has
  // all:initial, which resets color-scheme, so Canvas there is always light.
  #systemCanvas(): Paint {
    const html = this.doc.documentElement;
    if (!html || this.doc !== document) return WHITE;
    const probe = createHtml("snapii-probe");
    setImportant(probe, {
      all: "initial",
      position: "fixed",
      width: "0",
      height: "0",
      "color-scheme": getComputedStyle(html).colorScheme || "normal",
      "background-color": "Canvas",
    });
    html.append(probe);
    try {
      return parseColor(getComputedStyle(probe).backgroundColor) ?? WHITE;
    } finally {
      probe.remove();
    }
  }

  // ------------------------------------------------------------ classification

  /** Why this element cannot be drawn as shapes, or null if it can. */
  #reasonOf(b: Box): UnsupportedReason | null {
    const { el, cs } = b;
    const name = el.localName;
    if (el.namespaceURI === SVG_NS) return "svg";
    if (el.namespaceURI === MATHML_NS) return "math";
    if (name === "img") return "image";
    if (name === "canvas") return "canvas";
    if (MEDIA.has(name)) return "media";
    if (FORM.has(name) || (name === "button" && cs.appearance !== "none")) return "form";
    if (b.opaque) return "frame";
    // These change how the whole subtree is painted: checked wherever the box is.
    if (cs.transform !== "none" || cs.rotate !== "none" || cs.scale !== "none" || cs.translate !== "none")
      return "transform";
    if (
      cs.filter !== "none" ||
      (cs.getPropertyValue("backdrop-filter") || "none") !== "none" ||
      cs.mixBlendMode !== "normal" ||
      (cs.getPropertyValue("mask-image") || "none") !== "none" ||
      (cs.getPropertyValue("-webkit-mask-image") || "none") !== "none" ||
      // It cuts the element's own background too, not just its content.
      ownShapeClip(cs)
    )
      return "effect";
    // The rest concerns the box itself and what it paints around it: not worth
    // a style read where none of that can show. html's and body's pseudo-elements
    // can lie anywhere on the canvas (a fixed overlay), so those two are always read.
    const m = inkMargin(cs);
    const r = this.#rect(b);
    const reach = { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
    if (name !== "html" && name !== "body" && !intersect(reach, this.region)) return null;
    if (!b.propagated && cs.backgroundImage !== "none")
      return cs.backgroundImage.includes("url(") ? "background-image" : "gradient";
    if (cs.boxShadow !== "none") return "box-shadow";
    const text = b.kids.some((k) => !isBox(k) && k.data.trim() !== "");
    if (
      text &&
      (cs.textShadow !== "none" ||
        px(cs.getPropertyValue("-webkit-text-stroke-width")) > 0 ||
        /text/.test(cs.getPropertyValue("background-clip")) ||
        /text/.test(cs.getPropertyValue("-webkit-background-clip")))
    )
      return "text-effect";
    if (!this.#bordersDrawable(b)) return "border";
    if (!this.#coloursParse(b, text)) return "color";
    if (
      !NO_PSEUDO.has(name) &&
      (this.#paintsPseudo(el, "::before") ||
        this.#paintsPseudo(el, "::after") ||
        (!cs.display.startsWith("inline") &&
          (this.#restyles(b, "::first-letter") || this.#restyles(b, "::first-line"))))
    )
      return "pseudo";
    if (text && !cs.writingMode.startsWith("horizontal")) return "vertical";
    if (b.kids.some((k) => !isBox(k) && isIconText(collapse(k.data, "normal")))) return "icon-font";
    return null;
  }

  #bordersDrawable(b: Box): boolean {
    const { cs } = b;
    const visible = sides(cs).filter(shown);
    if (visible.some((s) => s.style !== "solid")) return false;
    const outline = cs.outlineStyle !== "none" && px(cs.outlineWidth) > 0;
    if (outline && cs.outlineStyle !== "solid") return false;
    if ((cs.getPropertyValue("border-image-source") || "none") !== "none") return false;
    if (visible.length === 0) return true;
    // Sides of their own colours are drawn as straight bars: with rounded corners only one colour is.
    const oneColour = visible.every((s) => s.color === visible[0]?.color);
    return oneColour || CORNERS.every((c) => px(cs.getPropertyValue(`border-${c}-radius`)) === 0);
  }

  #coloursParse(b: Box, text: boolean): boolean {
    const { cs } = b;
    const colours = [
      cs.backgroundColor,
      ...sides(cs)
        .filter(shown)
        .map((s) => s.color),
    ];
    if (cs.outlineStyle !== "none" && px(cs.outlineWidth) > 0) colours.push(cs.outlineColor);
    if (text) colours.push(cs.color);
    return colours.every((c) => parseColor(c) !== null) && (!text || this.#textColour(b) !== null);
  }

  /**
   * A drop cap or a styled first line: the collector gives those characters
   * the block's font and colour, so as visible text they would be wrong.
   */
  #restyles(b: Box, which: "::first-letter" | "::first-line"): boolean {
    const p = (b.el.ownerDocument.defaultView as Window).getComputedStyle(b.el, which);
    const { cs } = b;
    // An engine without the pseudo-element for this box answers with an empty style.
    if (!p.fontSize) return false;
    return (
      p.fontSize !== cs.fontSize ||
      p.fontFamily !== cs.fontFamily ||
      p.fontWeight !== cs.fontWeight ||
      p.fontStyle !== cs.fontStyle ||
      p.color !== cs.color ||
      p.float !== "none" ||
      parseColor(p.backgroundColor)?.a !== 0
    );
  }

  #paintsPseudo(el: Element, which: "::before" | "::after"): boolean {
    const cs = (el.ownerDocument.defaultView as Window).getComputedStyle(el, which);
    const content = cs.content;
    if (content === "none" || content === "normal" || cs.display === "none") return false;
    // A hidden tooltip paints nothing, background or not.
    if (cs.visibility !== "visible") return false;
    if (hasPaintedBox(cs)) return true;
    // Only strings: a clearfix's "" or " " (Bootstrap 3) paints nothing. Counters,
    // attr() and images are taken to paint.
    const strings = /^\s*(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(content);
    return (
      !strings ||
      content
        .replace(/"((?:[^"\\]|\\.)*)"/g, "$1")
        .replace(/\\(.)/g, "$1")
        .trim() !== ""
    );
  }

  /** CSS creates a stacking context for this box (the ones that matter once transforms and effects are patches). */
  #isContext(b: Box, zIndexed: boolean): boolean {
    const { cs, el } = b;
    return (
      el === el.ownerDocument.documentElement ||
      zIndexed ||
      cs.position === "fixed" ||
      cs.position === "sticky" ||
      Number.parseFloat(cs.opacity) < 1 ||
      cs.isolation === "isolate" ||
      /paint|layout|strict|content/.test(cs.contain) ||
      /size/.test(cs.getPropertyValue("container-type")) ||
      /opacity|transform|filter|isolation/.test(cs.willChange)
    );
  }

  // ------------------------------------------------------------ paint order

  /** Sorts b's children into the layers of C (nearest context) and R (nearest real stacking context). */
  #visit(b: Box, C: Layer, R: Layer): void {
    const flex = /flex|grid/.test(b.cs.display);
    const order = (k: Box | Text) => (isBox(k) ? Number.parseInt(k.cs.order, 10) || 0 : 0);
    const kids = flex ? [...b.kids].sort((p, q) => order(p) - order(q)) : b.kids;
    for (const k of kids) {
      if (!isBox(k)) {
        C.inlines.push(k);
        continue;
      }
      const { cs } = k;
      if (cs.display === "none") continue;
      if (performance.now() > this.#deadline) throw new OverBudget();
      if (cs.display === "contents") {
        this.#visit(k, C, R);
        continue;
      }
      if (!this.#layout.isRendered(k.el)) {
        // Not painted itself (no patch for an invisible file input or a hidden
        // slide); under visibility:hidden its children may still show.
        if (cs.visibility !== "visible") this.#visit(k, C, R);
        continue;
      }
      // Cut away entirely by its own clip (a wiped-out overlay, a visually
      // hidden label): nothing shows. Layout.clip also applies the element's
      // own overflow clip, so that only counts for a box of at most one pixel.
      if (ownShapeClip(cs) && !this.#layout.clip(k.el, k.ctx)) {
        const r = this.#rect(k);
        const own = cs.overflowX !== "visible" || cs.overflowY !== "visible";
        if (!own || r.width * r.height <= 1) continue;
      }
      const reason = this.#reasonOf(k);
      if (reason) {
        // body (or a frame's root) paints wherever its content runs, not only
        // inside its own box: it takes the region, as the root does in build().
        const doc = k.el.ownerDocument;
        const whole = k.el === doc.body || k.el === doc.documentElement;
        this.#patch(k, whole ? [this.region] : this.#extent(k), reason);
        continue;
      }
      this.#marker(k);
      const positioned = cs.position !== "static";
      // Flex and grid items: z-index applies, and they paint like inline-blocks.
      const item = flex && cs.position !== "absolute" && cs.position !== "fixed";
      const zIndexed = (positioned || item) && cs.zIndex !== "auto";
      if (this.#isContext(k, zIndexed)) {
        const z = zIndexed ? Number.parseInt(cs.zIndex, 10) || 0 : 0;
        const n = layer(k, true, z, Number.parseFloat(cs.opacity));
        (z < 0 ? R.neg : z > 0 ? R.pos : R.positioned).push(n);
        this.#visit(k, n, n);
      } else if (positioned) {
        const n = layer(k, false);
        R.positioned.push(n);
        this.#visit(k, n, R);
      } else if (cs.float !== "none") {
        const n = layer(k, false);
        C.floats.push(n);
        this.#visit(k, n, R);
      } else if (this.#isFrame(k)) {
        // A frame's document paints inside the frame, whatever its own stacking.
        const n = layer(k, true, 0, Number.parseFloat(cs.opacity));
        C.inlines.push(n);
        this.#visit(k, n, n);
      } else if (item || (cs.display.startsWith("inline") && cs.display !== "inline")) {
        const n = layer(k, false);
        C.inlines.push(n);
        this.#visit(k, n, R);
      } else if (cs.display === "inline") {
        C.inlines.push(k);
        this.#visit(k, C, R);
      } else {
        C.blocks.push(k);
        this.#visit(k, C, R);
      }
    }
  }

  #isFrame(b: Box): boolean {
    const n = b.el.localName;
    return n === "iframe" || n === "frame";
  }

  #paint(L: Layer, out: SceneOp[]): void {
    const alpha = L.real && L.opacity < 1 ? Math.max(0, L.opacity) : 1;
    const outer = this.#alpha;
    this.#alpha *= alpha;
    if (alpha < 1 && ++this.#depth > MAX_GROUP_DEPTH) throw new OverBudget();
    const ops: SceneOp[] = [];
    this.#own(L.owner, ops);
    for (const n of byZ(L.neg)) this.#paint(n, ops);
    for (const b of L.blocks) this.#own(b, ops);
    for (const f of L.floats) this.#paint(f, ops);
    for (const x of L.inlines) {
      if (isLayer(x)) this.#paint(x, ops);
      else if (isBox(x)) this.#own(x, ops);
      else this.#textSeq.set(x, this.#seq);
    }
    for (const p of L.positioned) this.#paint(p, ops);
    for (const p of byZ(L.pos)) this.#paint(p, ops);
    this.#alpha = outer;
    if (alpha < 1) {
      this.#depth--;
      if (ops.length > 0) out.push({ op: "group", opacity: alpha, children: ops });
    } else {
      out.push(...ops);
    }
  }

  // ------------------------------------------------------------ boxes

  /** Border boxes: one per line fragment for an inline box. */
  #fragments(b: Box): DocRect[] {
    const { el, ctx, cs } = b;
    if (cs.display === "inline") {
      const rects = [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
      if (rects.length > 1) return rects.map((r) => this.#layout.toDoc(r, ctx));
    }
    return [this.#rect(b)];
  }

  /**
   * What a patch of b must cover: its box, grown by what shadows and filters
   * paint beyond it, plus the boxes of positioned descendants that leave it
   * (a dropdown). Only shown ones: a hidden popover still has a box, and a
   * union over every descendant took in boxes broken across columns.
   */
  #extent(b: Box): DocRect[] {
    const { cs, el, ctx } = b;
    const m = inkMargin(cs);
    const out = this.#fragments(b).map((r) => ({
      x: r.x - m,
      y: r.y - m,
      width: r.width + 2 * m,
      height: r.height + 2 * m,
    }));
    if (cs.overflowX !== "visible" && cs.overflowY !== "visible") return out;
    let n = 0;
    for (const d of el.querySelectorAll("*")) {
      if (++n > 2_000) break;
      const box = this.#boxes.get(d);
      if (!box || (box.cs.position !== "absolute" && box.cs.position !== "fixed")) continue;
      if (!this.#layout.isRendered(d)) continue;
      const r = d.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(this.#layout.toDoc(r, ctx));
    }
    return out;
  }

  #radii(cs: CSSStyleDeclaration, box: DocRect): Radii | undefined {
    const len = (v: string | undefined, basis: number) =>
      v === undefined ? undefined : v.endsWith("%") ? (px(v) / 100) * basis : px(v);
    const radii = CORNERS.map((c) => {
      const [h, v] = cs.getPropertyValue(`border-${c}-radius`).trim().split(/\s+/);
      const x = len(h, box.width) ?? 0;
      return [x, len(v, box.height) ?? (h?.endsWith("%") ? (len(h, box.height) ?? 0) : x)];
    }) as Radii;
    return radii.some(([x, y]) => x > 0 && y > 0) ? radii : undefined;
  }

  /** The clip of b's content: its own overflow clip (rounded by its padding-box radii) within its container's. */
  #contentClip(b: Box): SceneClip | null {
    if (this.#contentClips.has(b)) return this.#contentClips.get(b) ?? null;
    const rect = this.#layout.clip(b.el, b.ctx);
    let clip: SceneClip | null = null;
    if (rect) {
      clip = { ...rect };
      const own = this.#clipsOverflow(b) ? this.#paddingClip(b) : null;
      if (own && same(rect, own)) clip = own;
      else {
        const container = this.#containerBox(b);
        const outer = container && this.#contentClip(container);
        if (outer?.radii && same(rect, outer)) clip = { ...rect, radii: outer.radii };
      }
    }
    this.#contentClips.set(b, clip);
    return clip;
  }

  #clipsOverflow(b: Box): boolean {
    const { cs, el } = b;
    const doc = el.ownerDocument;
    if (el === doc.documentElement || el === doc.body || cs.display === "inline") return false;
    return (
      cs.overflowX !== "visible" || cs.overflowY !== "visible" || /paint|strict|content/.test(cs.contain)
    );
  }

  /** b's padding box with the inner radii, where b has rounded corners. */
  #paddingClip(b: Box): SceneClip | null {
    const border = this.#layout.toDoc(b.el.getBoundingClientRect(), b.ctx);
    const radii = this.#radii(b.cs, border);
    if (!radii) return null;
    const [t, r, bt, l] = sides(b.cs).map((s) => s.width) as [number, number, number, number];
    const inner = radii.map(([x, y], i) => [
      Math.max(0, x - (i === 0 || i === 3 ? l : r)),
      Math.max(0, y - (i < 2 ? t : bt)),
    ]) as Radii;
    return { ...inset(border, t, r, bt, l), radii: inner };
  }

  #containerBox(b: Box): Box | null {
    const c = this.#layout.container(b.el);
    return c ? (this.#boxes.get(c) ?? null) : null;
  }

  /** Where b's own background and border can be seen. */
  #ownClip(b: Box): SceneClip | null {
    const rect = this.#layout.boxClip(b.el, b.ctx);
    if (!rect) return null;
    const container = this.#containerBox(b);
    const outer = container && this.#contentClip(container);
    return outer?.radii && same(rect, outer) ? { ...rect, radii: outer.radii } : rect;
  }

  /** Background, border and outline of b, in this order, wrapped in its clip where it needs one. */
  #own(b: Box, out: SceneOp[]): void {
    const { el, cs } = b;
    if (!this.#layout.isRendered(el)) return;
    const clip = this.#ownClip(b);
    if (!clip) return;
    if (el === el.ownerDocument.documentElement && b.ctx.frame) this.#frameCanvas(b, out);
    const frags = this.#fragments(b);
    if (!frags.some((f) => intersect(f, this.region) && intersect(f, clip))) return;
    const ops: SceneOp[] = [];
    const single = frags.length === 1;
    const rtl = cs.direction === "rtl";
    const borders = sides(cs);
    const [bt, br, bb, bl] = borders.map((s) => (shown(s) ? s.width : 0)) as [number, number, number, number];
    const bg = b.propagated ? null : parseColor(cs.backgroundColor);
    for (const [i, frag] of frags.entries()) {
      const first = i === 0;
      const last = i === frags.length - 1;
      // box-decoration-break: slice — a wrapped inline box has its start edge on the
      // first fragment and its end edge on the last.
      const startEdge = single || (rtl ? last : first);
      const endEdge = single || (rtl ? first : last);
      const leftEdge = rtl ? endEdge : startEdge;
      const rightEdge = rtl ? startEdge : endEdge;
      const all = this.#radii(cs, frag);
      const radii = all && (single ? all : this.#sliceRadii(all, leftEdge, rightEdge));
      if (bg && bg.a > 0) {
        const area = this.#backgroundArea(cs, frag, [bt, rightEdge ? br : 0, bb, leftEdge ? bl : 0]);
        const r = area === frag ? radii : undefined;
        ops.push({ op: "rect", ...area, ...(r ? { radii: r } : {}), fill: bg });
        this.#opaque(area, clip, bg);
      }
      this.#borderOps(borders, frag, radii, leftEdge, rightEdge, ops);
    }
    this.#outlineOp(b, frags, ops);
    if (ops.length === 0) return;
    const extent = frags.reduce(union);
    out.push(...(this.#needsClip(clip, extent) ? [{ op: "group" as const, clip, children: ops }] : ops));
  }

  #sliceRadii(r: Radii, left: boolean, right: boolean): Radii | undefined {
    const z: [number, number] = [0, 0];
    const out: Radii = [left ? r[0] : z, right ? r[1] : z, right ? r[2] : z, left ? r[3] : z];
    return out.some(([x, y]) => x > 0 && y > 0) ? out : undefined;
  }

  #backgroundArea(cs: CSSStyleDeclaration, frag: DocRect, border: [number, number, number, number]): DocRect {
    const clipTo = cs.backgroundClip;
    if (clipTo === "padding-box") return inset(frag, ...border);
    if (clipTo === "content-box") {
      const [t, r, b, l] = border;
      return inset(
        frag,
        t + px(cs.paddingTop),
        r + px(cs.paddingRight),
        b + px(cs.paddingBottom),
        l + px(cs.paddingLeft),
      );
    }
    return frag;
  }

  #borderOps(
    borders: ReturnType<typeof sides>,
    frag: DocRect,
    radii: Radii | undefined,
    leftEdge: boolean,
    rightEdge: boolean,
    ops: SceneOp[],
  ): void {
    const visible = borders.map((s, i) => shown(s) && (i === 1 ? rightEdge : i === 3 ? leftEdge : true));
    if (!visible.some(Boolean)) return;
    const first = borders[0] as (typeof borders)[number];
    const uniform =
      visible.every(Boolean) && borders.every((s) => s.width === first.width && s.color === first.color);
    if (uniform) {
      const paint = parseColor(first.color);
      if (paint && paint.a > 0)
        ops.push({ op: "rect", ...frag, ...(radii ? { radii } : {}), stroke: { width: first.width, paint } });
      return;
    }
    // One colour, unequal widths: the ring between the box and its padding box.
    const colours = new Set(borders.filter((_, i) => visible[i]).map((s) => s.color));
    if (colours.size === 1) {
      const paint = parseColor([...colours][0] as string);
      const widths = borders.map((s, i) => (visible[i] ? s.width : 0)) as [number, number, number, number];
      if (paint && paint.a > 0)
        ops.push({ op: "rect", ...frag, ...(radii ? { radii } : {}), border: { widths, paint } });
      return;
    }
    // Sides of their own colours: straight bars (a rounded box here was patched as "border").
    const { x, y, width: w, height: h } = frag;
    const bars: DocRect[] = [
      { x, y, width: w, height: borders[0]?.width ?? 0 },
      { x: x + w - (borders[1]?.width ?? 0), y, width: borders[1]?.width ?? 0, height: h },
      { x, y: y + h - (borders[2]?.width ?? 0), width: w, height: borders[2]?.width ?? 0 },
      { x, y, width: borders[3]?.width ?? 0, height: h },
    ];
    for (const [i, bar] of bars.entries()) {
      const paint = visible[i] ? parseColor(borders[i]?.color ?? "") : null;
      if (paint && paint.a > 0) ops.push({ op: "rect", ...bar, fill: paint });
    }
  }

  #outlineOp(b: Box, frags: DocRect[], ops: SceneOp[]): void {
    const { cs } = b;
    const w = px(cs.outlineWidth);
    if (cs.outlineStyle !== "solid" || w <= 0) return;
    const paint = parseColor(cs.outlineColor);
    if (!paint || paint.a <= 0) return;
    const grow = px(cs.outlineOffset) + w;
    for (const f of frags) {
      const box = { x: f.x - grow, y: f.y - grow, width: f.width + 2 * grow, height: f.height + 2 * grow };
      ops.push({ op: "rect", ...box, stroke: { width: w, paint } });
    }
  }

  /** An iframe document's root background fills the frame's viewport (frames are transparent otherwise). */
  #frameCanvas(root: Box, out: SceneOp[]): void {
    const source = this.#propagation(root);
    if (!source) return;
    source.propagated = true;
    const bg = parseColor(source.cs.backgroundColor);
    const win = root.ctx.doc.defaultView;
    if (!bg || bg.a <= 0 || !win) return;
    const g = this.#layout.frame(root.ctx);
    const viewport = { x: g.dx, y: g.dy, width: win.innerWidth, height: win.innerHeight };
    const clip = g.clip && intersect(viewport, g.clip);
    if (!clip) return;
    out.push({ op: "rect", ...clip, fill: bg });
    this.#opaque(clip, clip, bg);
  }

  /** Records an opaque fill: text painted before it and under it is hidden. */
  #opaque(area: DocRect, clip: DocRect, paint: Paint): void {
    this.#seq++;
    if (paint.a < 1 || this.#alpha < 1) return;
    const shown = intersect(area, clip);
    const rect = shown && intersect(shown, this.region);
    if (!rect) return;
    for (let b = Math.floor(rect.y / BAND); b <= Math.floor((rect.y + rect.height) / BAND); b++) {
      const band = this.#painted.get(b);
      if (band) band.push({ rect, seq: this.#seq });
      else this.#painted.set(b, [{ rect, seq: this.#seq }]);
    }
  }

  #needsClip(clip: SceneClip, extent: DocRect): boolean {
    if (!within(extent, clip)) return true;
    if (!clip.radii) return false;
    // Inside the clip but within reach of a rounded corner.
    const r = Math.max(...clip.radii.flat());
    return !within(extent, inset(clip, r, r, r, r));
  }

  // ------------------------------------------------------------ patches

  #patch(b: Box | null, rects: DocRect[], reason: UnsupportedReason): void {
    const clip = b ? this.#ownClip(b) : this.region;
    let any = false;
    for (const r of rects) {
      const shownPart = clip && intersect(r, clip);
      const inside = shownPart && intersect(shownPart, this.region);
      // Thinner than a layout unit: float noise where boxes adjoin at a zoom, not a part of the picture.
      if (!inside || inside.width < 1 / 64 || inside.height < 1 / 64) continue;
      this.#patches.push({ ...inside, reason });
      any = true;
    }
    if (any) this.#unsupported[reason] = (this.#unsupported[reason] ?? 0) + 1;
  }

  /**
   * A list item's marker (::marker has no box in the DOM): a strip beside the
   * first line, as wide as a marker usually is, not the whole item.
   */
  #marker(b: Box): void {
    const { cs } = b;
    if (cs.display !== "list-item" || (cs.listStyleType === "none" && cs.listStyleImage === "none")) return;
    if (!this.#layout.isRendered(b.el)) return;
    const box = this.#layout.toDoc(b.el.getBoundingClientRect(), b.ctx);
    const fs = px(cs.fontSize);
    const lh = cs.lineHeight === "normal" ? fs * 1.2 : px(cs.lineHeight);
    const shape = cs.listStyleImage === "none" && /^(disc|circle|square)$/.test(cs.listStyleType);
    const w = (shape ? 1.5 : 2.5) * fs;
    const rtl = cs.direction === "rtl";
    const [t, r, , l] = sides(cs).map((s) => s.width) as [number, number, number, number];
    const top = box.y + t + px(cs.paddingTop);
    const outside = cs.listStylePosition === "outside";
    const start = rtl ? box.x + box.width - r - px(cs.paddingRight) : box.x + l + px(cs.paddingLeft);
    const x = rtl ? (outside ? start : start - w) : outside ? start - w : start;
    this.#patch(b, [{ x, y: top, width: w, height: lh }], "marker");
  }

  /**
   * Over budget: overlapping patches merge, then the rest by bands of the
   * region. Far over it, straight to bands: the merge is quadratic (40 000
   * list markers took 2.7 s in V8).
   */
  #limitPatches(): void {
    if (this.#patches.length <= MAX_PATCHES) return;
    const merged: Patch[] = [];
    for (const p of this.#patches.length > 2 * MAX_PATCHES ? [] : this.#patches) {
      let cur: Patch = p;
      for (let i = merged.length - 1; i >= 0; i--) {
        const m = merged[i] as Patch;
        if (intersect(m, cur)) {
          cur = { ...union(m, cur), reason: m.reason };
          merged.splice(i, 1);
        }
      }
      merged.push(cur);
    }
    let out = this.#patches.length > 2 * MAX_PATCHES ? this.#patches : merged;
    if (out.length > MAX_PATCHES) {
      const bands = new Map<number, Patch>();
      for (const p of out) {
        const k = Math.floor((p.y - this.region.y) / BAND);
        const prev = bands.get(k);
        bands.set(k, prev ? { ...union(prev, p), reason: "budget" } : p);
      }
      out = [...bands.values()];
      this.#unsupported.budget = (this.#unsupported.budget ?? 0) + 1;
    }
    this.#patches.splice(0, this.#patches.length, ...out);
  }

  // ------------------------------------------------------------ text

  #textColour(b: Box): Paint | null {
    const fill = b.cs.getPropertyValue("-webkit-text-fill-color");
    return parseColor(fill && fill !== b.cs.color ? fill : b.cs.color);
  }

  /** Product of the opacity of b and its ancestors: text is not inside their groups. */
  #opacityOf(b: Box): number {
    // Up to the nearest box already known, then back down: no recursion per
    // DOM level, which a deep page would overflow outside the build's budget.
    const chain: Box[] = [];
    let at: Box | null = b;
    while (at && !this.#opacities.has(at)) {
      chain.push(at);
      at = at.parent;
    }
    let product = at ? (this.#opacities.get(at) as number) : 1;
    for (const box of chain.reverse()) {
      const own = Number.parseFloat(box.cs.opacity);
      product *= Number.isFinite(own) ? own : 1;
      this.#opacities.set(box, product);
    }
    return product;
  }

  #textPaint(run: TextRun, source: RunSource | undefined): TextPaint | null {
    const parent = source && flatParent(source.node);
    const box = parent && this.#boxes.get(parent);
    if (!source || !box) return null;
    const cx = run.x + run.width / 2;
    const cy = run.top + run.height / 2;
    // The pixels already show it.
    if (this.#patches.some((p) => contains(p, cx, cy))) return null;
    // A box painted later hides it.
    const seq = this.#textSeq.get(source.node) ?? Number.POSITIVE_INFINITY;
    const band = this.#painted.get(Math.floor(cy / BAND)) ?? [];
    if (band.some((o) => o.seq > seq && contains(o.rect, cx, cy))) return null;
    const colour = this.#textColour(box);
    if (!colour) return null;
    const paint: TextPaint = { fill: { ...colour, a: colour.a * this.#opacityOf(box) } };
    const spacing = px(box.cs.letterSpacing);
    if (spacing !== 0) paint.letterSpacing = spacing;
    // The collector keeps lines that are half visible; their glyphs would overhang the clip.
    const glyphs = { x: run.x, y: run.y - run.fontSize, width: run.width, height: run.fontSize * 1.3 };
    if (!within(glyphs, source.clip) && !same(source.clip, this.region)) paint.clip = source.clip;
    return paint;
  }
}

/** The scene of the region (region-relative), for the runs the collector found there. */
export function buildScene(doc: Document, region: DocRect, opts: SceneOptions): Scene {
  return new Builder(doc, region, opts).build();
}
