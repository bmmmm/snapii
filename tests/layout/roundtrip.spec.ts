// SPDX-License-Identifier: GPL-3.0-or-later
// SVG round trip for every extraction fixture whose expect block does not say
// `"roundtrip": false` (schema: fixtures.spec.ts; the
// round-trip-only fields are listed in Expect below). Per fixture: collect runs
// and link areas for the capture rect, raster the rect with page.screenshot,
// render the SVG with the harness's rasterTextRenderer, serve it as
// image/svg+xml, open it in the same Firefox, and check what a reader of the
// file gets:
//   R1 select-all copies the expected lines, whitespace-normalised, joined
//      with one space (lines neither glued nor dropped)
//   R2 the <a> hrefs of the text layer are the expected links (consecutive
//      equal hrefs merged, like A6), those of the link layer the expected
//      linked areas; the centre of every linked run hit-tests to its <a>
//   R3 each run's <text> element (the one with font attributes), measured as
//      the union of its character cells, has the run's x and width within
//      ±1 px. Vertically the cells are compared with the unclipped box of the
//      run's characters in the page: top and bottom within ±1 px, or within
//      roundtripTolerance[runText] / baselineTolerance[runText] px for named
//      runs (drop caps; baselines estimated for fallback fonts); a fixture's
//      roundtripVerticalTolerance (fraction of fontSize, for webfonts the
//      viewer lacks, whose ascent/descent therefore differ) compares box
//      centres instead.
//   plus: DOMParser(image/svg+xml) reports no parsererror.
// The SVGs stay in test-results/roundtrip/ for inspection.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { linksRelativeTo, runsRelativeTo } from "../../src/shared/geometry.ts";
import type { DocRect, RenderInput, TextRun } from "../../src/shared/types.ts";

interface Expect {
  capture: string | DocRect;
  lines: (string | { text: string })[];
  links?: { text: string; href: string }[];
  areas?: { alt: string; href: string | null }[];
  options?: { occlusionCheck?: boolean };
  skip?: string;
  baselineTolerance?: Record<string, number>;
  roundtrip?: boolean;
  /** Wider vertical R3 tolerance (px) for named runs. */
  roundtripTolerance?: Record<string, number>;
  /** Vertical R3 tolerance as a fraction of each run's fontSize (webfont fixtures). */
  roundtripVerticalTolerance?: number;
  /** Overrides for one engine, see fixtures.spec.ts. */
  engines?: Record<string, Partial<Expect>>;
}

const DIR = new URL("../fixtures/", import.meta.url);
const OUT = new URL("../../test-results/roundtrip/", import.meta.url);
const NOT_FIXTURES = new Set(["smoke.html", "overlay.html", "overlay-csp.html"]);
const X_TOL = 1;
const V_TOL = 1;

function readExpect(file: string, engine?: string): Expect {
  const html = readFileSync(new URL(file, DIR), "utf8");
  const m = /<script type="application\/json" id="expect">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error(`${file}: no <script type="application/json" id="expect"> block`);
  const exp = JSON.parse(m[1]) as Expect;
  return { ...exp, ...(engine ? exp.engines?.[engine] : undefined) };
}

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".html") && !NOT_FIXTURES.has(f))
  .sort()
  .filter((f) => readExpect(f).roundtrip !== false);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.toString("latin1", 12, 16) !== "IHDR") throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Consecutive equal values merged, as A6 merges consecutive runs of one link. */
function mergeRuns<T>(xs: T[]): T[] {
  return xs.filter((x, i) => i === 0 || xs[i - 1] !== x);
}

test("at least one fixture takes part in the round trip", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

for (const file of fixtures) {
  test(file, async ({ page, browserName }) => {
    const exp = readExpect(file, browserName);
    await page.goto(`/fixtures/${file}`);
    await page.addScriptTag({ path: "dist-test/harness.js" });
    const col = await page.evaluate(
      async ({ exp }) => {
        const h = window.__snapii;
        await window.beforeCollect?.();
        const capture = h.debug.captureRect(exp.capture);
        const skipEl = exp.skip ? document.querySelector(exp.skip) : null;
        if (exp.skip && !skipEl) throw new Error(`skip selector matches nothing: ${exp.skip}`);
        const opts = { ...exp.options, skip: skipEl };
        const { runs, stats, sources } = await h.debug.collectTextRunsDetailed(document, capture, opts);
        const links = h.collectLinkAreas(document, capture, { skip: skipEl });
        // Vertical reference per run: the unclipped box of its characters
        // (the SVG text is never cut, the run's own box may be).
        const refs = sources.map((s) => h.debug.sliceRect(s));
        return {
          capture,
          runs,
          refs,
          links,
          stats,
          url: location.href,
          title: document.title,
          lang: document.documentElement.lang || null,
          viewport: { width: innerWidth, height: innerHeight },
          scroll: { x: scrollX, y: scrollY },
          devicePixelRatio,
        };
      },
      { exp },
    );
    const { capture } = col;
    // fullPage: clip is in document coordinates whatever the scroll position.
    const png = await page.screenshot({ clip: capture, fullPage: true, scale: "css" });
    const px = pngSize(png);
    const input: RenderInput = {
      region: capture,
      runs: runsRelativeTo(col.runs, capture),
      links: linksRelativeTo(col.links, capture),
      page: {
        url: col.url,
        title: col.title,
        lang: col.lang,
        textFragmentURL: null,
        textFragmentStatus: "DISABLED",
        viewport: col.viewport,
        scroll: col.scroll,
        devicePixelRatio: col.devicePixelRatio,
        capturedAt: "2026-10-01T00:00:00.000Z",
        mode: "element",
        skippedFrames: col.stats.skippedFrames,
        skippedVertical: col.stats.skippedVertical,
      },
      tiles: [
        {
          x: 0,
          y: 0,
          width: capture.width,
          height: capture.height,
          dataURL: `data:image/png;base64,${png.toString("base64")}`,
          pixelWidth: px.width,
          pixelHeight: px.height,
          format: "png",
        },
      ],
      extensionVersion: "0.0.0-test",
      zoom: 1,
      scale: px.width / capture.width,
    };
    const svg = await page.evaluate((input) => window.__snapii.render(input), input);
    mkdirSync(OUT, { recursive: true });
    const name = file.replace(/\.html$/, ".svg");
    writeFileSync(new URL(name, OUT), svg);

    const svgURL = new URL(`/roundtrip/${name}`, col.url).href;
    await page.route(svgURL, (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }),
    );
    await page.goto(svgURL);

    const got = await page.evaluate((svg) => {
      const root = document.documentElement;
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      getSelection()?.selectAllChildren(root);
      const copied = getSelection()?.toString() ?? "";
      getSelection()?.removeAllRanges();
      const anchorsIn = (id: string) =>
        [...(document.getElementById(id)?.querySelectorAll("a") ?? [])].map((a) => ({
          href: a.getAttribute("href"),
          xlink: a.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        }));
      // Run elements carry font attributes, line separators none.
      const els = [...(document.getElementById("text")?.querySelectorAll("text[font-size]") ?? [])];
      return {
        rootName: root.localName,
        parserErrors: parsed.getElementsByTagName("parsererror").length,
        copied,
        textAnchors: anchorsIn("text"),
        linkAnchors: anchorsIn("links"),
        // Union of the character cells (advance x font ascent/descent), not
        // getBoundingClientRect: Firefox pads a <text> element's box and hit
        // area by ~2-3 px on each side for glyph overhang whatever the run.
        boxes: els.map((e) => {
          const t = e as SVGTextContentElement;
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (let i = 0; i < t.getNumberOfChars(); i++) {
            const r = t.getExtentOfChar(i);
            x0 = Math.min(x0, r.x);
            y0 = Math.min(y0, r.y);
            x1 = Math.max(x1, r.x + r.width);
            y1 = Math.max(y1, r.y + r.height);
          }
          return { text: e.textContent ?? "", x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        }),
      };
    }, svg);
    // The renderer writes lines in numeric order, runs in input order within a line.
    const order = input.runs
      .map((_, i) => i)
      .sort((a, b) => (input.runs[a]?.line ?? 0) - (input.runs[b]?.line ?? 0));
    const runs: TextRun[] = order.flatMap((i) => input.runs[i] ?? []);
    const refs = order.map((i) => {
      const r = col.refs[i];
      return r ? { top: r.y - capture.y, bottom: r.y + r.height - capture.y } : null;
    });
    const abs = (href: string) => new URL(href, col.url).href;

    expect.soft(got.parserErrors, "DOMParser parsererror").toBe(0);
    expect(got.rootName, "the SVG opens as an SVG document").toBe("svg");

    // R1
    const lines = exp.lines.map((l) => (typeof l === "string" ? l : l.text));
    // Chromium's Selection.toString() puts a line break between two <text>
    // elements, also those of one line (measured in 153): there the copy is
    // the run texts with a space between each two.
    const expected = browserName === "chromium" ? runs.map((r) => r.text).join(" ") : lines.join(" ");
    expect.soft(norm(got.copied), "R1 select-all text").toBe(norm(expected));

    // R2
    for (const a of [...got.textAnchors, ...got.linkAnchors])
      expect.soft(a.xlink, "R2 xlink:href = href").toBe(a.href);
    expect
      .soft(mergeRuns(got.textAnchors.map((a) => a.href)), "R2 text-layer hrefs")
      .toEqual((exp.links ?? []).map((l) => abs(l.href)));
    expect
      .soft(
        got.linkAnchors.map((a) => a.href),
        "R2 link-area hrefs",
      )
      .toEqual((exp.areas ?? []).flatMap((a) => (a.href === null ? [] : [abs(a.href)])));
    const hits = await page.evaluate(
      (linked) =>
        linked.map(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest("a")?.getAttribute("href") ?? null;
        }),
      runs.filter((r) => r.href !== null).map((r) => ({ x: r.x + r.width / 2, y: r.top + r.height / 2 })),
    );
    expect
      .soft(hits, "R2 linked run centre hit-tests to its <a>")
      .toEqual(runs.filter((r) => r.href !== null).map((r) => r.href));

    // R3
    expect(got.boxes.length, "R3 one text element per run").toBe(runs.length);
    const r3: string[] = [];
    let worst = { x: 0, width: 0, vertical: 0 };
    for (const [i, run] of runs.entries()) {
      const box = got.boxes[i];
      if (!box) continue;
      // Chromium gives a <text> that holds only a space no extent at all.
      if (browserName === "chromium" && run.text.trim() === "" && !Number.isFinite(box.x)) continue;
      const dx = Math.abs(box.x - run.x);
      const dw = Math.abs(box.width - run.width);
      const ref = refs[i];
      if (!ref) {
        r3.push(`run ${i} ${JSON.stringify(run.text)}: no reference box`);
        continue;
      }
      // Without the page's font the viewer's box has other ascent/descent
      // metrics, so only its centre can match.
      const dv =
        exp.roundtripVerticalTolerance === undefined
          ? Math.max(Math.abs(box.y - ref.top), Math.abs(box.y + box.height - ref.bottom))
          : Math.abs(box.y + box.height / 2 - (ref.top + ref.bottom) / 2);
      worst = {
        x: Math.max(worst.x, dx),
        width: Math.max(worst.width, dw),
        vertical: Math.max(worst.vertical, dv),
      };
      const vTol =
        exp.roundtripTolerance?.[run.text] ??
        exp.baselineTolerance?.[run.text] ??
        (exp.roundtripVerticalTolerance === undefined
          ? V_TOL
          : exp.roundtripVerticalTolerance * run.fontSize);
      if (box.text !== run.text || dx > X_TOL || dw > X_TOL || dv > vTol) {
        r3.push(
          `run ${i} ${JSON.stringify(run.text)} (svg ${JSON.stringify(box.text)}): ` +
            `x ${r2(box.x)} vs ${r2(run.x)}, width ${r2(box.width)} vs ${r2(run.width)}, ` +
            `top ${r2(box.y)} vs ${r2(ref.top)}, bottom ${r2(box.y + box.height)} vs ${r2(ref.bottom)}`,
        );
      }
    }
    console.log(`R3 ${file}: worst x ${r2(worst.x)} width ${r2(worst.width)} vertical ${r2(worst.vertical)}`);
    expect.soft(r3, "R3 geometry").toEqual([]);
  });
}
