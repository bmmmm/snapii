// SPDX-License-Identifier: GPL-3.0-or-later
// What of an element is actually painted. Only display:none removes client
// rects; visibility, opacity, clipping ancestors and frame viewports have to
// be checked here. One Layout instance per collection caches per element, so
// a page with thousands of text nodes reads each style once.
import { intersect, translate, UNBOUNDED } from "../../shared/geometry.ts";
import type { DocRect } from "../../shared/types.ts";
import { closestComposed, type FrameContext, flatParent, shadowRootOf } from "./flat-tree.ts";

/** Maps a frame's client coordinates to top-level document coordinates. */
export interface FrameGeometry {
  dx: number;
  dy: number;
  /** The frame's visible viewport in document coordinates; null if nothing of it shows. */
  clip: DocRect | null;
}

const px = (v: string): number => Number.parseFloat(v) || 0;

function clientToRect(r: DOMRectReadOnly): DocRect {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

// Lengths of inset(): "inset(10px 20% 0px)" -> [top, right, bottom, left].
function insetEdges(value: string, box: DocRect): [number, number, number, number] | null {
  const m = /^inset\(([^)]*)\)/.exec(value);
  if (!m?.[1]) return null;
  const parts =
    m[1]
      .split(/\s+round\s+/)[0]
      ?.trim()
      .split(/\s+/) ?? [];
  const len = (s: string | undefined, basis: number) =>
    s === undefined ? undefined : s.endsWith("%") ? (px(s) / 100) * basis : px(s);
  const t = len(parts[0], box.height) ?? 0;
  const r = len(parts[1], box.width) ?? (parts[0] === undefined ? 0 : (len(parts[0], box.width) ?? 0));
  const b = len(parts[2], box.height) ?? t;
  const l = len(parts[3], box.width) ?? r;
  return [t, r, b, l];
}

export class Layout {
  #styles = new Map<Element, CSSStyleDeclaration>();
  #rendered = new Map<Element, boolean>();
  #clips = new Map<Element, DocRect | null>();
  #frames = new Map<FrameContext, FrameGeometry>();

  style(el: Element): CSSStyleDeclaration {
    let cs = this.#styles.get(el);
    if (!cs) {
      cs = (el.ownerDocument.defaultView as Window).getComputedStyle(el);
      this.#styles.set(el, cs);
    }
    return cs;
  }

  frame(ctx: FrameContext): FrameGeometry {
    const hit = this.#frames.get(ctx);
    if (hit) return hit;
    let geo: FrameGeometry;
    if (!ctx.frame || !ctx.parent) {
      const win = ctx.doc.defaultView as Window;
      geo = { dx: win.scrollX, dy: win.scrollY, clip: UNBOUNDED };
    } else {
      // Frame content starts at the iframe's content box.
      const f = ctx.frame as HTMLElement;
      const outer = this.frame(ctx.parent);
      const cs = this.style(f);
      const r = f.getBoundingClientRect();
      const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
      const top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
      const width =
        r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
      const height =
        r.height -
        px(cs.borderTopWidth) -
        px(cs.borderBottomWidth) -
        px(cs.paddingTop) -
        px(cs.paddingBottom);
      const dx = outer.dx + left;
      const dy = outer.dy + top;
      const shown = this.isRendered(f) ? this.clip(f, ctx.parent) : null;
      geo = { dx, dy, clip: shown && intersect(shown, { x: dx, y: dy, width, height }) };
    }
    this.#frames.set(ctx, geo);
    return geo;
  }

  /** Client rect of an element or range in ctx's document -> document coordinates. */
  toDoc(r: DOMRectReadOnly | DocRect, ctx: FrameContext): DocRect {
    const g = this.frame(ctx);
    const rect = "left" in r ? clientToRect(r) : r;
    return translate(rect, g.dx, g.dy);
  }

  /**
   * Whether el is painted at all. checkVisibility covers display, visibility,
   * opacity and content-visibility on el and its flat-tree ancestors. Boxless
   * elements (display: contents, e.g. <slot>) report false, so the check runs
   * on the nearest ancestor with a box; visibility inherits, so el's own
   * computed value still counts.
   */
  isRendered(el: Element): boolean {
    let hit = this.#rendered.get(el);
    if (hit !== undefined) return hit;
    const cs = this.style(el);
    if (cs.visibility !== "visible") {
      hit = false;
    } else {
      const boxed = closestComposed(el, (e) => this.style(e).display !== "contents");
      hit =
        boxed?.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
          // Pre-Fx122 spellings of the same options.
          checkOpacity: true,
          checkVisibilityCSS: true,
        } as CheckVisibilityOptions) ?? false;
    }
    this.#rendered.set(el, hit);
    return hit;
  }

  /**
   * The area in which el's content can be seen, in document coordinates:
   * every overflow / contain:paint ancestor on its containing-block chain,
   * clip-path: inset(), clip: rect(), and the viewports of enclosing frames.
   * null means nothing of el's content shows.
   */
  clip(el: Element, ctx: FrameContext): DocRect | null {
    if (this.#clips.has(el)) return this.#clips.get(el) ?? null;
    const cs = this.style(el);
    const container = this.#containerOf(el, cs.position);
    let clip: DocRect | null = container ? this.clip(container, ctx) : this.frame(ctx).clip;
    if (clip && cs.display !== "contents") clip = this.#ownClip(el, cs, clip, ctx);
    this.#clips.set(el, clip);
    return clip;
  }

  // Overflow clipping follows the containing-block chain: an absolutely
  // positioned box escapes overflow:hidden on static ancestors, a fixed one
  // escapes everything up to a transformed ancestor.
  #containerOf(el: Element, position: string): Element | null {
    const parent = flatParent(el);
    if (!parent || (position !== "absolute" && position !== "fixed")) return parent;
    return closestComposed(parent, (a) => {
      const s = this.style(a);
      const fixedCB =
        s.transform !== "none" ||
        s.perspective !== "none" ||
        s.filter !== "none" ||
        /paint|layout|strict|content/.test(s.contain) ||
        /transform|perspective|filter/.test(s.willChange);
      return fixedCB || (position === "absolute" && s.position !== "static");
    });
  }

  #ownClip(el: Element, cs: CSSStyleDeclaration, clip: DocRect, ctx: FrameContext): DocRect | null {
    // The root element's and body's overflow belongs to the viewport, and
    // overflow does not apply to inline boxes; clip-path and clip still do.
    const doc = el.ownerDocument;
    const boxClips = el !== doc.documentElement && el !== doc.body && cs.display !== "inline";
    const paint = /paint|strict|content/.test(cs.contain);
    const clipX = boxClips && (cs.overflowX !== "visible" || paint);
    const clipY = boxClips && (cs.overflowY !== "visible" || paint);
    const needsBox = clipX || clipY || cs.clipPath.startsWith("inset(") || cs.clip.startsWith("rect(");
    if (!needsBox) return clip;
    const border = this.toDoc(el.getBoundingClientRect(), ctx);
    let out: DocRect | null = clip;
    if (clipX || clipY) {
      const bl = px(cs.borderLeftWidth);
      const bt = px(cs.borderTopWidth);
      const pad = {
        x: border.x + bl,
        y: border.y + bt,
        width: border.width - bl - px(cs.borderRightWidth),
        height: border.height - bt - px(cs.borderBottomWidth),
      };
      out = intersect(out, {
        x: clipX ? pad.x : UNBOUNDED.x,
        y: clipY ? pad.y : UNBOUNDED.y,
        width: clipX ? pad.width : UNBOUNDED.width,
        height: clipY ? pad.height : UNBOUNDED.height,
      });
    }
    const inset = insetEdges(cs.clipPath, border);
    if (out && inset) {
      const [t, r, b, l] = inset;
      out = intersect(out, {
        x: border.x + l,
        y: border.y + t,
        width: border.width - l - r,
        height: border.height - t - b,
      });
    }
    // Legacy clip: rect(top, right, bottom, left) on absolutely positioned boxes.
    const legacy = /^rect\(([^)]*)\)/.exec(cs.clip)?.[1]?.split(/[,\s]+/);
    if (out && legacy && (cs.position === "absolute" || cs.position === "fixed")) {
      const edge = (s: string | undefined, auto: number) => (s === undefined || s === "auto" ? auto : px(s));
      const t = edge(legacy[0], 0);
      const r = edge(legacy[1], border.width);
      const b = edge(legacy[2], border.height);
      const l = edge(legacy[3], 0);
      out = intersect(out, { x: border.x + l, y: border.y + t, width: r - l, height: b - t });
    }
    return out;
  }

  /**
   * Whether something else is painted over the centre of rect (document
   * coordinates). The skip subtree (the snapii overlay, still up while
   * collecting) is looked through. Only points inside the viewport can be
   * hit-tested; others count as not occluded.
   */
  occluded(owner: Element, rect: DocRect, ctx: FrameContext, skip: Element | null | undefined): boolean {
    const g = this.frame(ctx);
    const win = ctx.doc.defaultView as Window;
    const cx = rect.x + rect.width / 2 - g.dx;
    const cy = rect.y + rect.height / 2 - g.dy;
    if (cx < 0 || cy < 0 || cx >= win.innerWidth || cy >= win.innerHeight) return false;
    const within = (inner: Element, outer: Element) => closestComposed(inner, (e) => e === outer) !== null;
    const topmost = (root: Document | ShadowRoot) =>
      root.elementsFromPoint(cx, cy).find((e) => !skip || !within(e, skip)) ?? null;
    let hit = topmost(ctx.doc);
    // Retarget into shadow trees; the document only reports the host.
    for (let root = hit && shadowRootOf(hit); hit && root; root = shadowRootOf(hit)) {
      const inner = topmost(root);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) return false;
    return !within(owner, hit) && !within(hit, owner);
  }
}
