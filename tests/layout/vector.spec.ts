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
//   V5 every picture the scene drew from an <img> or <canvas> has at most the
//      pixels of its box at the page's density (+1 rounding): the part that
//      shows, not the whole original (the corner tests below check the rest)
//   plus per fixture: vector.fills / alpha (a run's paint), clipped (a run
//   with its own clip-path), canvas / darkCanvas (the canvas colour),
//   pictures / pictureArea (how many the scene drew, their area in CSS px).
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
  pictures?: number;
  pictureArea?: number;
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
type PictureOp = Extract<Scene["ops"][number], { op: "image" }>;
const pictureOps = (ops: Scene["ops"]): PictureOp[] =>
  ops.flatMap((op) => (op.op === "group" ? pictureOps(op.children) : op.op === "image" ? [op] : []));
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

/** The scene of #cap after `html` replaced the smoke page's body (and its pictures loaded). */
async function sceneOf(page: Page, html: string, encoding?: { format: "png" | "jpeg"; jpegQuality: number }) {
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    await Promise.all([...document.images].map((im) => im.decode()));
    window.prepare?.();
  }, html);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  return page.evaluate(async (encoding) => {
    const h = window.__snapii;
    const capture = h.debug.captureRect("#cap");
    const { runs, sources } = await h.debug.collectTextRunsDetailed(document, capture, {});
    return h.buildScene(document, capture, { runs, sources, ...(encoding ? { encoding } : {}) });
  }, encoding);
}

test("pictures: JPEG where the settings ask for it and the picture is opaque, else PNG", async ({ page }) => {
  // The canvas is opaque at the top and transparent below.
  await page.addInitScript(() => {
    window.prepare = () => {
      const half = document.querySelector("canvas") as HTMLCanvasElement;
      (half.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 40, 20);
    };
  });
  const html =
    '<main id="cap" style="width:300px"><img src="/fixtures/images/quadrants.png" width="80" height="40"><img src="/fixtures/images/quadrants.png" width="40" height="40" style="border-radius:50%"><canvas width="40" height="40"></canvas></main>';
  const kinds = (scene: Scene) =>
    pictureOps(scene.ops).map((op) => /^data:image\/(\w+)/.exec(op.dataURL)?.[1]);
  // The round one has transparent corners, the canvas a transparent half: JPEG keeps neither.
  expect(kinds(await sceneOf(page, html, { format: "jpeg", jpegQuality: 0.8 }))).toEqual([
    "jpeg",
    "png",
    "png",
  ]);
  expect(kinds(await sceneOf(page, html))).toEqual(["png", "png", "png"]);
  // The quality setting reaches the encoder.
  const size = async (q: number) =>
    pictureOps((await sceneOf(page, html, { format: "jpeg", jpegQuality: q })).ops)[0]?.dataURL.length ?? 0;
  expect(await size(0.1)).toBeLessThan(await size(1));
});

test("pictures: an image still loading is a patch, whatever it shows meanwhile", async ({ page }) => {
  // A new src that never arrives: the old picture stays on screen, the load is not complete.
  await page.route("**/never.png", () => {});
  await page.addInitScript(() => {
    window.prepare = () => {
      (document.querySelector("img") as HTMLImageElement).src = "/fixtures/images/never.png";
    };
  });
  const scene = await sceneOf(
    page,
    '<main id="cap" style="width:300px"><img src="/fixtures/images/quadrants.png" width="80" height="40"></main>',
  );
  expect(scene.unsupported).toEqual({ image: 1 });
  expect(pictureOps(scene.ops)).toEqual([]);
});

test("pictures: their own rounded corners cut along the content box, each corner less the two sides it joins", async ({
  page,
}) => {
  // An opaque canvas of 100 x 100 CSS px (200 x 200 of its own, so one
  // picture pixel per CSS px), radius 40, borders 10, 6, 4, 12 (top, right,
  // bottom, left) and padding 10: the content box's corners are 18/20,
  // 24/20, 24/26 and 18/26.
  await page.addInitScript(() => {
    window.prepare = () => {
      const c = document.querySelector("canvas") as HTMLCanvasElement;
      (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 200, 200);
    };
  });
  const scene = await sceneOf(
    page,
    '<main id="cap" style="width:300px"><canvas width="200" height="200" style="display:block;width:100px;height:100px;border:solid rgb(0,0,0);border-width:10px 6px 4px 12px;padding:10px;border-radius:40px"></canvas></main>',
  );
  const [picture] = pictureOps(scene.ops);
  const { size, alpha } = await page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { size: [bitmap.width, bitmap.height], alpha: [...data.filter((_, i) => i % 4 === 3)] };
  }, picture?.dataURL ?? "");
  expect(size).toEqual([100, 100]);
  const radii = [
    [18, 20],
    [24, 20],
    [24, 26],
    [18, 26],
  ] as const;
  const wrong: string[] = [];
  for (const [corner, [rx, ry]] of radii.entries()) {
    // Each corner's 40 x 40 square: transparent only outside its ellipse.
    for (let j = 0; j < 40; j++) {
      for (let i = 0; i < 40; i++) {
        // The pixel's centre, measured from this corner inwards.
        const f = ((i + 0.5 - rx) / rx) ** 2 + ((j + 0.5 - ry) / ry) ** 2;
        const outside = i < rx && j < ry && f > 1;
        // Antialiasing: no verdict for a pixel the curve may cross.
        if (i < rx && j < ry && Math.abs(Math.sqrt(f) - 1) * Math.min(rx, ry) < 0.75) continue;
        const x = corner === 0 || corner === 3 ? i : 99 - i;
        const y = corner < 2 ? j : 99 - j;
        const a = alpha[y * 100 + x] ?? -1;
        if (outside ? a > 32 : a < 223) wrong.push(`corner ${corner} (${x},${y}) alpha ${a}`);
      }
    }
  }
  expect(wrong).toEqual([]);
});

test("pictures: a rounded one the region cuts keeps its corners where the element has them", async ({
  page,
}) => {
  // An opaque 100 x 100 canvas, radius 20, half of it left of and above the
  // region: only its bottom-right corner is in the picture.
  await page.addInitScript(() => {
    window.prepare = () => {
      const c = document.querySelector("canvas") as HTMLCanvasElement;
      (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 200, 200);
    };
  });
  const scene = await sceneOf(
    page,
    '<main id="cap" style="display:flow-root;margin:100px;width:100px;height:100px"><canvas width="200" height="200" style="display:block;width:100px;height:100px;margin:-50px 0 0 -50px;border-radius:20px"></canvas></main>',
  );
  const [picture] = pictureOps(scene.ops);
  const alpha = await page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3];
    return {
      size: [bitmap.width, bitmap.height],
      bottomLeft: at(0, 49),
      topRight: at(49, 0),
      bottomRight: at(49, 49),
    };
  }, picture?.dataURL ?? "");
  expect(alpha).toEqual({ size: [50, 50], bottomLeft: 255, topRight: 255, bottomRight: 0 });
});

test.describe("at two device px per CSS px", () => {
  test.use({ deviceScaleFactor: 2 });

  test("pictures: an ancestor's rounded clip cuts them too, so its corners are not in the file", async ({
    page,
  }) => {
    // An opaque 100 x 100 canvas in a box with radius 20 and overflow hidden
    // (an avatar made the common way), half of it left of and above the
    // region: only the box's bottom-right corner is in the picture, 40 device
    // px round.
    await page.addInitScript(() => {
      window.prepare = () => {
        const c = document.querySelector("canvas") as HTMLCanvasElement;
        (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 200, 200);
      };
    });
    const scene = await sceneOf(
      page,
      '<main id="cap" style="display:flow-root;margin:100px;width:100px;height:100px"><div style="width:100px;height:100px;margin:-50px 0 0 -50px;border-radius:20px;overflow:hidden"><canvas width="200" height="200" style="display:block;width:100px;height:100px"></canvas></div></main>',
    );
    const [picture] = pictureOps(scene.ops);
    const alpha = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3];
      return {
        size: [bitmap.width, bitmap.height],
        bottomLeft: at(0, 99),
        topRight: at(99, 0),
        // Outside a 40 px corner, inside a 20 px one.
        inCorner: at(91, 91),
        // 0.3 px outside the curve: kept, the SVG's clip draws that edge.
        nearCurve: at(88, 88),
      };
    }, picture?.dataURL ?? "");
    expect(alpha).toEqual({ size: [100, 100], bottomLeft: 255, topRight: 255, inCorner: 0, nearCurve: 255 });
  });

  test("pictures: an ancestor's rounded clip is cut out a little outside the curve, at every corner", async ({
    page,
  }) => {
    // A card of 100 x 100 CSS px, radius 20 (40 device px), wholly in view:
    // the pixels at both ends of each corner's arc, 0.87 px outside it, stay
    // for the SVG's clip to draw the edge.
    await page.addInitScript(() => {
      window.prepare = () => {
        const c = document.querySelector("canvas") as HTMLCanvasElement;
        (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 200, 200);
      };
    });
    const scene = await sceneOf(
      page,
      '<main id="cap" style="width:100px"><div style="width:100px;height:100px;border-radius:20px;overflow:hidden"><canvas width="200" height="200" style="display:block;width:100px;height:100px"></canvas></div></main>',
    );
    const ends: [number, number][] = [
      [199, 170],
      [170, 199],
      [199, 29],
      [170, 0],
      [0, 29],
      [29, 0],
      [0, 170],
      [29, 199],
    ];
    expect(await alphaAt(page, scene, ends)).toEqual([ends.map(() => 255)]);
  });

  test("pictures: JPEG under an ancestor's rounded clip has no dark rim at the curve", async ({ page }) => {
    // The same white canvas as a JPEG: JPEG has no transparency, what is
    // erased turns black, and the edge the SVG's clip draws must not.
    await page.addInitScript(() => {
      window.prepare = () => {
        const ctx = (document.querySelector("canvas") as HTMLCanvasElement).getContext(
          "2d",
        ) as CanvasRenderingContext2D;
        ctx.fillStyle = "rgb(255, 255, 255)";
        ctx.fillRect(0, 0, 200, 200);
      };
    });
    const scene = await sceneOf(
      page,
      '<main id="cap" style="display:flow-root;margin:100px;width:100px;height:100px"><div style="width:100px;height:100px;margin:-50px 0 0 -50px;border-radius:20px;overflow:hidden"><canvas width="200" height="200" style="display:block;width:100px;height:100px"></canvas></div></main>',
      { format: "jpeg", jpegQuality: 0.92 },
    );
    const [picture] = pictureOps(scene.ops);
    expect(picture?.dataURL).toMatch(/^data:image\/jpeg/);
    const darkest = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      // Along the corner's diagonal, from inside up to 0.3 px outside the curve.
      return Math.min(
        ...[80, 84, 86, 88].map((p) => Math.min(...ctx.getImageData(p, p, 1, 1).data.slice(0, 3))),
      );
    }, picture?.dataURL ?? "");
    expect(darkest).toBeGreaterThanOrEqual(230);
  });
});

/** Alpha at each point of every picture in the scene, in its own pixels. */
async function alphaAt(page: Page, scene: Scene, points: [number, number][]): Promise<number[][]> {
  return page.evaluate(
    ({ urls, points }) =>
      Promise.all(
        urls.map(async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const c = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bitmap, 0, 0);
          return points.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] ?? -1);
        }),
      ),
    { urls: pictureOps(scene.ops).map((p) => p.dataURL), points },
  );
}

test("pictures: a radius of calc(infinity * 1px), a full round, cuts them too", async ({ page }) => {
  // Its own and an ancestor's; Firefox computes it as 3.4e38px.
  await page.addInitScript(() => {
    window.prepare = () => {
      for (const c of document.querySelectorAll("canvas"))
        (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 60, 60);
    };
  });
  const round = "border-radius:calc(infinity * 1px)";
  const scene = await sceneOf(
    page,
    `<main id="cap" style="display:flex;gap:10px;width:300px"><canvas width="60" height="60" style="display:block;${round}"></canvas><div style="${round};overflow:hidden"><canvas width="60" height="60" style="display:block"></canvas></div></main>`,
  );
  // A corner pixel and the centre of each.
  expect(
    await alphaAt(page, scene, [
      [1, 1],
      [30, 30],
    ]),
  ).toEqual([
    [0, 255],
    [0, 255],
  ]);
});

test("pictures: an ancestor's rounded clip leaves an opaque one opaque: it hides the text under it, and JPEG applies", async ({
  page,
}) => {
  // The card's corners are hidden by the card's clip anyway, the text in them too.
  await page.addInitScript(() => {
    window.prepare = () => {
      const c = document.querySelector("canvas") as HTMLCanvasElement;
      (c.getContext("2d") as CanvasRenderingContext2D).fillRect(0, 0, 200, 40);
    };
  });
  const html =
    '<main id="cap" style="width:300px"><div style="position:relative;width:200px;border-radius:12px;overflow:hidden;font:16px/40px serif"><p style="margin:0">Text under the picture</p><canvas width="200" height="40" style="position:absolute;left:0;top:0"></canvas></div></main>';
  const scene = await sceneOf(page, html, { format: "jpeg", jpegQuality: 0.8 });
  expect(scene.text.length).toBeGreaterThan(0);
  expect(scene.text.every((t) => t === null)).toBe(true);
  expect(pictureOps(scene.ops).map((op) => /^data:image\/(\w+)/.exec(op.dataURL)?.[1])).toEqual(["jpeg"]);
});

test("pictures over the pixel budget are patches, counted before anything is drawn", async ({ page }) => {
  // Three blank canvases of 6 Mpx: the first two are drawn (and read back
  // empty), the third would take the pictures past 16 Mi px.
  const canvas = '<canvas width="2450" height="2450"></canvas>';
  const scene = await sceneOf(
    page,
    `<main id="cap" style="display:flex;width:7350px">${canvas}${canvas}${canvas}</main>`,
  );
  expect(scene.unsupported).toEqual({ canvas: 2, budget: 1 });
});

test("pictures over the data URL budget are patches", async ({ page }) => {
  // Three canvases of 3 Mpx opaque noise, each 12 M (RGB) to 16 M (RGBA)
  // characters as a PNG data URL: two fit in 32 MiB, three do not.
  await page.addInitScript(() => {
    window.prepare = () => {
      for (const c of document.querySelectorAll("canvas")) {
        const ctx = c.getContext("2d") as CanvasRenderingContext2D;
        const img = ctx.createImageData(c.width, c.height);
        for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0;
        ctx.putImageData(img, 0, 0);
      }
    };
  });
  const canvas = '<canvas width="1732" height="1732"></canvas>';
  const scene = await sceneOf(
    page,
    `<main id="cap" style="display:flex;width:5196px">${canvas}${canvas}${canvas}</main>`,
  );
  expect(scene.unsupported).toEqual({ budget: 1 });
  expect(pictureOps(scene.ops)).toHaveLength(2);
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
    const pictures = pictureOps(scene.ops);
    const pictureSizes = await page.evaluate(
      (urls) =>
        Promise.all(
          urls.map(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            return { width: bitmap.width, height: bitmap.height };
          }),
        ),
      pictures.map((p) => p.dataURL),
    );
    // Whole pixels: Chromium scales a screenshot of a fractional width to whole
    // pixels (Firefox cuts), and the patches come out of this picture, so a
    // fractional clip would resample them once more in the comparison (a
    // DejaVu Sans Mono region on Linux is 168.5625 px wide).
    const shotSize = { width: Math.floor(capture.width), height: Math.floor(capture.height) };
    const ref = await page.screenshot({ clip: { ...capture, ...shotSize }, fullPage: true, scale: "css" });
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
      clip: { x: 0, y: 0, ...shotSize },
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
    // V5
    for (const [i, p] of pictures.entries()) {
      const size = pictureSizes[i];
      const most = {
        width: Math.ceil(p.width * col.devicePixelRatio) + 1,
        height: Math.ceil(p.height * col.devicePixelRatio) + 1,
      };
      expect
        .soft(
          size && size.width <= most.width && size.height <= most.height,
          `V5 picture ${i} ${JSON.stringify(size)} in ${JSON.stringify(most)}`,
        )
        .toBe(true);
    }
    if (vec?.pictures !== undefined) expect.soft(pictures.length, "pictures drawn").toBe(vec.pictures);
    if (vec?.pictureArea !== undefined) {
      const area = pictures.reduce((s, p) => s + p.width * p.height, 0);
      expect.soft(Math.abs(area - vec.pictureArea), `area of the pictures ${area}`).toBeLessThan(1);
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
