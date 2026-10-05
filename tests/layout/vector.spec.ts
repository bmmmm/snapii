// SPDX-License-Identifier: GPL-3.0-or-later
// Vector output end to end, for every fixture page: collect the runs, build
// the scene (buildScene), take each patch's pixels from a screenshot of the
// region (what the background does with captureVisibleTab), render with
// vectorRenderer, open the SVG in the same browser and check what a reader
// of the file gets:
//   V1 (G2) diffRatio(page, SVG) <= vector.tolerance (default T) for the
//      vector-* fixtures; the other fixtures report theirs
//   V2 (G4) patch area / region <= vector.maxPatchArea and the scene's
//      unsupported counts are vector.unsupported, exactly
//   V3 (G3) one text layer with one <text> per run; select-all copies the
//      expected lines (R1); the text-layer hrefs are the expected links and
//      a linked run's centre hit-tests to its <a> (R2, link areas lie under
//      the text); vector.hidden runs are transparent, vector.visible ones
//      painted
//   V4 (G5) well-formed; no <script>, <foreignObject> or on* attribute;
//      url() only for generated clip ids; images only as base64 png, jpeg,
//      webp or gif data URLs
//   plus per fixture: vector.fills / alpha (a run's paint), clipped (a run
//   with its own clip-path), canvas / darkCanvas (the canvas colour).
// The SVGs stay in test-results/vector/ for inspection.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { linksRelativeTo, runsRelativeTo, unionArea } from "../../src/shared/geometry.ts";
import type { DocRect, Patch, RasterTile, Scene } from "../../src/shared/types.ts";
import { diffRatio } from "./diff.ts";

interface VectorExpect {
  tolerance?: number;
  maxPatchArea?: number;
  unsupported?: Record<string, number>;
  hidden?: string[];
  visible?: string[];
  fills?: Record<string, string>;
  alpha?: Record<string, number>;
  clipped?: string[];
  canvas?: string;
  darkCanvas?: boolean;
}

interface Expect {
  capture: string | DocRect;
  lines: (string | { text: string })[];
  links?: { text: string; href: string }[];
  options?: { occlusionCheck?: boolean };
  skip?: string;
  roundtrip?: boolean;
  vector?: VectorExpect;
  engines?: Record<string, Partial<Expect>>;
}

const DIR = new URL("../fixtures/", import.meta.url);
const OUT = new URL("../../test-results/vector/", import.meta.url);
const NOT_FIXTURES = new Set(["smoke.html", "overlay.html", "overlay-csp.html"]);
// Default fidelity gate for the vector fixtures (plan G2, calibrated at Gate B).
const T = 0.02;

function readExpect(file: string, engine?: string): Expect {
  const html = readFileSync(new URL(file, DIR), "utf8");
  const m = /<script type="application\/json" id="expect">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error(`${file}: no <script type="application/json" id="expect"> block`);
  const exp = JSON.parse(m[1]) as Expect;
  return { ...exp, ...(engine ? exp.engines?.[engine] : undefined) };
}

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".html") && !NOT_FIXTURES.has(f))
  .sort();
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

test("the vector fixtures are there, each with its vector expectations", () => {
  const vector = fixtures.filter((f) => f.startsWith("vector-"));
  expect(vector.length).toBeGreaterThanOrEqual(12);
  for (const f of vector) expect(readExpect(f).vector, f).toBeDefined();
});

/** A screenshot of a 100x60 white page with a black box of that size at x. */
async function square(page: Page, x: number, width = 20): Promise<Buffer> {
  await page.setContent(
    `<body style="margin:0;background:#fff"><div style="position:absolute;left:${x}px;top:10px;width:${width}px;height:20px;background:#000"></div></body>`,
  );
  return page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 60 } });
}

test("diffRatio: same pixels 0, a moved block more, a different size refused", async ({ page }) => {
  const a = await square(page, 10);
  const b = await square(page, 50);
  expect((await diffRatio(page, a, a)).ratio).toBe(0);
  // Both squares count, each 20x20 less the one-pixel neighbourhood allowance at its edges.
  expect((await diffRatio(page, a, b)).ratio).toBeGreaterThan(0.1);
  // A thin line only the second image has: its neighbourhood in the first is
  // all white, so only the comparison from the second side finds it.
  const blank = await square(page, 0, 0);
  const line = await square(page, 50, 1);
  expect((await diffRatio(page, blank, line)).ratio).toBeGreaterThan(0);
  await page.setViewportSize({ width: 200, height: 200 });
  const big = await page.screenshot({ clip: { x: 0, y: 0, width: 103, height: 60 } });
  await expect(diffRatio(page, a, big)).rejects.toThrow(/size differs/);
});

test("over the patch budget, patches merge before the text's visibility is decided", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  // 2 100 patched boxes (a box shadow each) between words: more than MAX_PATCHES.
  await page.evaluate(() => {
    const words = Array.from(
      { length: 2100 },
      (_, i) =>
        `w${i} <i style="display:inline-block;width:6px;height:6px;box-shadow:0 0 0 1px rgb(255,0,0)"></i>`,
    );
    document.body.innerHTML = `<main id="cap" style="width:600px;font:12px/16px serif">${words.join(" ")}</main>`;
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const got = await page.evaluate(async () => {
    const h = window.__snapii;
    const capture = h.debug.captureRect("#cap");
    const { runs, sources } = await h.debug.collectTextRunsDetailed(document, capture, {});
    const scene = h.buildScene(document, capture, { runs, sources });
    const rel = runs.map((r) => ({ x: r.x - capture.x + r.width / 2, y: r.top - capture.y + r.height / 2 }));
    const inPatch = rel.map((c) =>
      scene.patches.some((p) => c.x >= p.x && c.x < p.x + p.width && c.y >= p.y && c.y < p.y + p.height),
    );
    return {
      patches: scene.patches.length,
      budget: scene.unsupported.budget ?? 0,
      runs: runs.length,
      shownInPatch: inPatch.filter((inside, i) => inside && scene.text[i] !== null).length,
      inPatch: inPatch.filter(Boolean).length,
    };
  });
  expect(got.runs).toBeGreaterThan(2000);
  expect(got.patches).toBeLessThanOrEqual(2000);
  expect(got.budget).toBe(1);
  expect(got.inPatch, "the merged patches cover text").toBeGreaterThan(0);
  expect(got.shownInPatch, "no run painted over pixels that already show it").toBe(0);
});

test("the skipped subtree (the overlay) is not in the scene", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(() => {
    document.body.innerHTML =
      '<main id="cap" style="width:300px"><p>Page text</p></main><div id="fake" style="position:fixed;inset:0;background:rgb(255,0,255)"></div>';
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const fills = await page.evaluate(async () => {
    const h = window.__snapii;
    const capture = h.debug.captureRect("#cap");
    const skip = document.getElementById("fake");
    const { runs, sources } = await h.debug.collectTextRunsDetailed(document, capture, { skip });
    const magenta = (ops: Scene["ops"]): number =>
      ops.reduce(
        (n, op) =>
          n +
          (op.op === "group"
            ? magenta(op.children)
            : op.op === "rect" && op.fill?.g === 0 && op.fill.r === 255
              ? 1
              : 0),
        0,
      );
    return {
      skipped: magenta(h.buildScene(document, capture, { runs, sources, skip }).ops),
      walked: magenta(h.buildScene(document, capture, { runs, sources }).ops),
    };
  });
  expect(fills.walked, "without skip the fake overlay is a box of the scene").toBeGreaterThan(0);
  expect(fills.skipped).toBe(0);
});

/** Each patch's pixels, cut from the region's screenshot on whole pixels (DPR 1, CSS scale). */
async function cropTiles(page: Page, png: Buffer, patches: Patch[]): Promise<RasterTile[]> {
  return page.evaluate(
    async ({ url, patches }) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const out: RasterTile[] = [];
      for (const p of patches) {
        const x0 = Math.max(0, Math.floor(p.x));
        const y0 = Math.max(0, Math.floor(p.y));
        const x1 = Math.min(bitmap.width, Math.ceil(p.x + p.width));
        const y1 = Math.min(bitmap.height, Math.ceil(p.y + p.height));
        if (x1 <= x0 || y1 <= y0) continue;
        const c = new OffscreenCanvas(x1 - x0, y1 - y0);
        (c.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(bitmap, -x0, -y0);
        const blob = await c.convertToBlob({ type: "image/png" });
        const dataURL = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
        out.push({
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          dataURL,
          pixelWidth: x1 - x0,
          pixelHeight: y1 - y0,
          format: "png",
        });
      }
      return out;
    },
    { url: `data:image/png;base64,${png.toString("base64")}`, patches },
  );
}

for (const file of fixtures) {
  test(file, async ({ page, browserName }) => {
    const exp = readExpect(file, browserName);
    const vec = exp.vector;
    await page.goto(`/fixtures/${file}`);
    await page.addScriptTag({ path: "dist-test/harness.js" });
    const col = await page.evaluate(
      async ({ exp }) => {
        const h = window.__snapii;
        await window.beforeCollect?.();
        const capture = h.debug.captureRect(exp.capture);
        const skipEl = exp.skip ? document.querySelector(exp.skip) : null;
        const opts = { ...exp.options, skip: skipEl };
        const { runs, stats, sources } = await h.debug.collectTextRunsDetailed(document, capture, opts);
        const links = h.collectLinkAreas(document, capture, { skip: skipEl });
        const t0 = performance.now();
        const scene = h.buildScene(document, capture, { runs, sources, skip: skipEl });
        return {
          capture,
          runs,
          links,
          scene,
          sceneMs: performance.now() - t0,
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
    const scene: Scene = col.scene;
    const ref = await page.screenshot({ clip: capture, fullPage: true, scale: "css" });
    const tiles = await cropTiles(page, ref, scene.patches);
    const runs = runsRelativeTo(col.runs, capture);
    const svg = await page.evaluate((input) => window.__snapii.renderVector(input), {
      region: capture,
      runs,
      links: linksRelativeTo(col.links, capture),
      page: {
        url: col.url,
        title: col.title,
        lang: col.lang,
        textFragmentURL: null,
        textFragmentStatus: "DISABLED" as const,
        viewport: col.viewport,
        scroll: col.scroll,
        devicePixelRatio: col.devicePixelRatio,
        capturedAt: "2026-10-01T00:00:00.000Z",
        mode: "element" as const,
        skippedFrames: col.stats.skippedFrames,
        skippedVertical: col.stats.skippedVertical,
      },
      tiles,
      extensionVersion: "0.0.0-test",
      zoom: 1,
      scale: 1,
      scene,
    });
    mkdirSync(OUT, { recursive: true });
    const name = file.replace(/\.html$/, `.${browserName}.svg`);
    writeFileSync(new URL(name, OUT), svg);

    const svgURL = new URL(`/vector/${name}`, col.url).href;
    await page.route(svgURL, (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }),
    );
    await page.goto(svgURL);
    // A screenshot with fullPage never returns in an SVG document (Playwright
    // sizes the page through HTML APIs): the viewport takes the SVG's size,
    // which also puts every run in reach of elementFromPoint.
    await page.setViewportSize({ width: Math.ceil(capture.width), height: Math.ceil(capture.height) });
    const got = await page.evaluate((svg) => {
      const root = document.documentElement;
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      getSelection()?.selectAllChildren(root);
      const copied = getSelection()?.toString() ?? "";
      getSelection()?.removeAllRanges();
      const attrsOf = [...parsed.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.name));
      const layers = [...document.querySelectorAll("g#text")];
      const runEls = [...(document.getElementById("text")?.querySelectorAll("text[font-size]") ?? [])];
      return {
        rootName: root.localName,
        parserErrors: parsed.getElementsByTagName("parsererror").length,
        copied,
        layers: layers.length,
        eventAttrs: attrsOf.filter((n) => /^on/i.test(n)),
        runs: runEls.map((e) => ({
          text: e.textContent ?? "",
          fill: e.getAttribute("fill"),
          opacity: e.getAttribute("fill-opacity"),
          clip: e.getAttribute("clip-path"),
        })),
        textHrefs: [...(document.getElementById("text")?.querySelectorAll("a") ?? [])].map((a) =>
          a.getAttribute("href"),
        ),
        canvas: document.getElementById("canvas")?.getAttribute("fill") ?? null,
      };
    }, svg);
    const shot = await page.screenshot({
      clip: { x: 0, y: 0, width: capture.width, height: capture.height },
      scale: "css",
    });
    const diff = await diffRatio(page, ref, shot);
    writeFileSync(new URL(name.replace(/\.svg$/, ".page.png"), OUT), ref);
    writeFileSync(new URL(name.replace(/\.svg$/, ".svg.png"), OUT), shot);
    const patchShare = unionArea(scene.patches) / (capture.width * capture.height);
    console.log(
      `V ${browserName} ${file}: diff ${pct(diff.ratio)} patches ${scene.patches.length} (${pct(patchShare)}) ops ${scene.ops.length} scene ${col.sceneMs.toFixed(1)} ms`,
    );

    // V4
    expect.soft(got.parserErrors, "V4 DOMParser parsererror").toBe(0);
    expect(got.rootName, "the SVG opens as an SVG document").toBe("svg");
    expect.soft(/<script|<foreignObject/i.test(svg), "V4 no script, no foreignObject").toBe(false);
    expect.soft(got.eventAttrs, "V4 no event attributes").toEqual([]);
    for (const m of svg.matchAll(/url\(([^)]*)\)/g))
      expect.soft(m[1], "V4 url() only for clip ids").toMatch(/^#c\d+$/);
    for (const m of svg.matchAll(/href="([^"]*)"/g)) {
      if (m[1]?.startsWith("data:"))
        expect.soft(m[1], "V4 image data URLs").toMatch(/^data:image\/(png|jpeg|webp|gif);base64,/);
    }

    // V3
    expect.soft(got.layers, "V3 one text layer").toBe(1);
    expect.soft(got.runs.length, "V3 one <text> per run").toBe(runs.length);
    if (exp.roundtrip !== false) {
      const lines = exp.lines.map((l) => (typeof l === "string" ? l : l.text));
      const order = [...runs].sort((a, b) => a.line - b.line);
      const expected = browserName === "chromium" ? order.map((r) => r.text).join(" ") : lines.join(" ");
      expect.soft(norm(got.copied), "V3 select-all text (R1)").toBe(norm(expected));
      const abs = (href: string) => new URL(href, col.url).href;
      expect
        .soft(
          got.textHrefs.filter((h, i, all) => i === 0 || all[i - 1] !== h),
          "V3 text-layer hrefs (R2)",
        )
        .toEqual((exp.links ?? []).map((l) => abs(l.href)));
      const linked = runs.filter((r) => r.href !== null);
      const hits = await page.evaluate(
        (points) =>
          points.map(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href") ?? null,
          ),
        linked.map((r) => ({ x: r.x + r.width / 2, y: r.top + r.height / 2 })),
      );
      expect
        .soft(hits, "V3 a linked run's centre hit-tests to its <a> (R2)")
        .toEqual(linked.map((r) => r.href));
    }
    const runNamed = (text: string) => {
      const hit = got.runs.find((r) => r.text === text);
      expect(hit, `run "${text}"`).toBeDefined();
      return hit as (typeof got.runs)[number];
    };
    for (const t of vec?.hidden ?? []) {
      const r = runNamed(t);
      expect.soft([r.fill, r.opacity], `V3 "${t}" is invisible`).toEqual(["#000", "0"]);
    }
    for (const t of vec?.visible ?? []) {
      const r = runNamed(t);
      expect.soft(r.opacity === "0" || r.fill === "#000", `V3 "${t}" is painted`).toBe(false);
    }
    for (const [t, fill] of Object.entries(vec?.fills ?? {}))
      expect.soft(runNamed(t).fill, `fill of "${t}"`).toBe(fill);
    for (const [t, a] of Object.entries(vec?.alpha ?? {}))
      expect.soft(Number(runNamed(t).opacity), `fill-opacity of "${t}"`).toBeCloseTo(a, 2);
    for (const t of vec?.clipped ?? [])
      expect.soft(runNamed(t).clip, `"${t}" is clipped`).toMatch(/^url\(#c\d+\)$/);
    if (vec?.canvas) expect.soft(got.canvas, "canvas colour").toBe(vec.canvas);
    if (vec?.darkCanvas) {
      const [r = 255, g = 255, b = 255] = (got.canvas?.match(/\d+/g) ?? []).map(Number);
      expect.soft(r + g + b, `canvas ${got.canvas} is dark`).toBeLessThan(3 * 80);
    }

    if (!vec) return;
    // V2
    expect.soft(scene.unsupported, "V2 unsupported counts").toEqual(vec.unsupported ?? {});
    expect.soft(patchShare, "V2 patch area share").toBeLessThanOrEqual(vec.maxPatchArea ?? 0);
    // V1
    expect
      .soft(diff.ratio, `V1 diffRatio ${pct(diff.ratio)}, differing box ${JSON.stringify(diff.box)}`)
      .toBeLessThanOrEqual(vec.tolerance ?? T);
  });
}
