// SPDX-License-Identifier: GPL-3.0-or-later
// Extraction checks for every fixture page in tests/fixtures/ (except
// smoke.html), each driven by the page's own
//   <script type="application/json" id="expect">{…}</script>
//
// expect schema. Coordinates are document CSS px; every href is resolved
// against the fixture's URL before comparing, so fixtures write "/x".
//   capture       string | {x, y, width, height}. A CSS selector means the
//                 border box of its first match; an object is the rect itself.
//   lines         (string | {text, dir})[], non-empty. A1: the text of each
//                 visual line, i.e. the texts of the runs sharing one `line`
//                 number joined without separator (normalizeLines has already
//                 placed the spaces); line numbers run 0..n-1. With {dir} also
//                 A7: every run of that line has that dir.
//   absent?       string[]. A2: no run text (and no line text) contains any of them.
//   links?        {text, href}[]. A6: every maximal sequence of consecutive runs
//                 with the same non-null href, in order; text joins the run texts
//                 ("" within a line, " " across lines). Default [].
//   areas?        {alt, href}[]. A6: collectLinkAreas() in order; href null is
//                 an unlinked image with alt text. Default [].
//   stats?        exact values for any of textNodes, skippedFrames, skippedVertical.
//   options?      CollectOptions for the collection, e.g. {"occlusionCheck": true}.
//   skip?         CSS selector of the subtree passed as `skip` to both
//                 collectors (stands in for the snapii overlay).
//   maxMs?        budget for one collection (collectTextRunsDetailed, the
//                 variant the checks use), timed in the page.
//   baselineTolerance? {runText: px}. Wider A5 tolerance for named runs.
//   roundtrip?    false: the fixture is unsuitable for the SVG round-trip spec.
//   reason?       free text: why the block deviates from the defaults
//                 (roundtrip:false, baselineTolerance).
//
// Fixture hook: if the page defines window.beforeCollect, it is awaited
// immediately before collection, inside the same page task chain (webfont.html
// starts its font load there so that loading races the collection).
//
// Checks per fixture:
//   A1 lines   A2 absent   A3 every run and area inside the capture rect (±0.5)
//   A4 each run's rect = union of the non-empty client rects of its source
//      slice (debug side channel), cut to the run's clip (±0.5)
//   A5 baseline y within ±1 px of a zero-size inline-block probe at the run's
//      start: right after its first character, held on its line by a nowrap
//      wrapper; in SVG <text>, the glyph origin of its first character
//      (measured after every document's fonts are ready)
//   A6 links and areas   A7 line directions
//   plus stats, maxMs, and collectTextRuns() returning the same runs as the
//   detailed variant the checks use.
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { CollectOptions, CollectStats } from "../../src/content/extract/collect.ts";
import type { DocRect, LinkArea, TextRun } from "../../src/shared/types.ts";

interface Expect {
  capture: string | DocRect;
  lines: (string | { text: string; dir: TextRun["dir"] })[];
  absent?: string[];
  links?: { text: string; href: string }[];
  areas?: { alt: string; href: string | null }[];
  stats?: Partial<Omit<CollectStats, "ms">>;
  /** JSON only; the skip element comes from `skip`. */
  options?: Pick<CollectOptions, "occlusionCheck">;
  skip?: string;
  maxMs?: number;
  baselineTolerance?: Record<string, number>;
  roundtrip?: boolean;
  reason?: string;
}

const DIR = new URL("../fixtures/", import.meta.url);
// Pages that serve other specs (harness smoke, overlay interaction) carry no
// extraction expectations.
const NOT_FIXTURES = new Set(["smoke.html", "overlay.html", "overlay-csp.html"]);
// The fixture table; each needs its own expect block.
const REQUIRED = [
  "multiline.html",
  "inline-links.html",
  "rtl.html",
  "hidden.html",
  "clip-partial.html",
  "shadow.html",
  "webfont.html",
  "images.html",
  "buttons.html",
  "pre.html",
  "transform.html",
  "letter-spacing.html",
  "first-letter.html",
  "user-select-none.html",
  "icon-font.html",
  "iframe-same-origin.html",
  "iframe-child.html",
  "long-article.html",
];
const TOL = 0.5;
const BASELINE_TOL = 1;

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".html") && !NOT_FIXTURES.has(f))
  .sort();

function readExpect(file: string): Expect {
  const html = readFileSync(new URL(file, DIR), "utf8");
  const m = /<script type="application\/json" id="expect">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error(`${file}: no <script type="application/json" id="expect"> block`);
  const exp = JSON.parse(m[1]) as Expect;
  if (!exp.capture || !Array.isArray(exp.lines) || exp.lines.length === 0) {
    throw new Error(`${file}: expect needs capture and a non-empty lines array`);
  }
  return exp;
}

const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const r2 = (n: number) => Math.round(n * 100) / 100;

function inside(r: DocRect, cap: DocRect): boolean {
  return (
    r.x >= cap.x - TOL &&
    r.y >= cap.y - TOL &&
    r.x + r.width <= cap.x + cap.width + TOL &&
    r.y + r.height <= cap.y + cap.height + TOL
  );
}

function clipTo(r: DocRect, clip: DocRect): DocRect | null {
  const x = Math.max(r.x, clip.x);
  const y = Math.max(r.y, clip.y);
  const right = Math.min(r.x + r.width, clip.x + clip.width);
  const bottom = Math.min(r.y + r.height, clip.y + clip.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function linesOf(runs: TextRun[]): TextRun[][] {
  const out: TextRun[][] = [];
  for (const [i, r] of runs.entries()) {
    if (i === 0 || r.line !== runs[i - 1]?.line) out.push([]);
    out[out.length - 1]?.push(r);
  }
  return out;
}

function linkGroups(runs: TextRun[]): { text: string; href: string }[] {
  const out: { text: string; href: string; line: number }[] = [];
  for (const [i, r] of runs.entries()) {
    const last = out[out.length - 1];
    if (r.href && last && runs[i - 1]?.href === r.href) {
      last.text += (r.line === last.line ? "" : " ") + r.text;
      last.line = r.line;
    } else if (r.href) {
      out.push({ text: r.text, href: r.href, line: r.line });
    }
  }
  return out.map(({ text, href }) => ({ text, href }));
}

test("every fixture from the table is present", () => {
  for (const name of REQUIRED) expect(fixtures, name).toContain(name);
});

for (const file of fixtures) {
  test(file, async ({ page }) => {
    const exp = readExpect(file);
    await page.goto(`/fixtures/${file}`);
    await page.addScriptTag({ path: "dist-test/harness.js" });
    const res = await page.evaluate(
      async ({ exp }) => {
        const h = window.__snapii;
        await window.beforeCollect?.();
        const capture = h.debug.captureRect(exp.capture);
        const skipEl = exp.skip ? document.querySelector(exp.skip) : null;
        if (exp.skip && !skipEl) throw new Error(`skip selector matches nothing: ${exp.skip}`);
        const opts = { ...exp.options, skip: skipEl };
        const t0 = performance.now();
        const detailed = await h.debug.collectTextRunsDetailed(document, capture, opts);
        const ms = performance.now() - t0;
        const pub = await h.collectTextRuns(document, capture, opts);
        const areas = h.collectLinkAreas(document, capture, { skip: skipEl });
        // A4/A5 re-measure the settled layout, whatever the extractor saw.
        const docs = new Set([document, ...detailed.sources.map((s) => s.node.ownerDocument)]);
        await Promise.all([...docs].map((d) => d.fonts.ready));
        const slices = detailed.sources.map((s) => h.debug.sliceRect(s));
        const probes = detailed.sources.map((s) => h.debug.probeBaseline(s));
        return {
          url: location.href,
          capture,
          ms,
          runs: detailed.runs,
          stats: detailed.stats,
          publicRuns: pub.runs,
          areas,
          slices,
          clips: detailed.sources.map((s) => s.clip),
          probes,
        };
      },
      { exp },
    );
    const abs = (href: string | null) => (href === null ? null : new URL(href, res.url).href);
    const label = (i: number) => `run ${i} ${JSON.stringify(res.runs[i]?.text)}`;
    test.info().annotations.push({ type: "collect-ms", description: res.ms.toFixed(1) });
    if (exp.maxMs !== undefined) console.log(`${file}: collectTextRuns took ${res.ms.toFixed(1)} ms`);

    // A1 / A7
    const lines = linesOf(res.runs);
    const lineTexts = lines.map((l) => l.map((r) => r.text).join(""));
    expect.soft(lineTexts, "A1 lines").toEqual(exp.lines.map((l) => (typeof l === "string" ? l : l.text)));
    expect
      .soft(
        lines.map((l) => l[0]?.line),
        "A1 line numbers dense",
      )
      .toEqual(lines.map((_, i) => i));
    const dirs: string[] = [];
    for (const [i, l] of exp.lines.entries()) {
      if (typeof l === "string") continue;
      for (const r of lines[i] ?? [])
        if (r.dir !== l.dir) dirs.push(`line ${i} ${JSON.stringify(r.text)}: ${r.dir}`);
    }
    expect.soft(dirs, "A7 dir").toEqual([]);

    // A2
    const leaks = (exp.absent ?? []).filter((a) => lineTexts.some((t) => t.includes(a)));
    expect.soft(leaks, "A2 absent").toEqual([]);

    // A3
    const outside = [
      ...res.runs.flatMap((r, i) =>
        inside({ x: r.x, y: r.top, width: r.width, height: r.height }, res.capture) ? [] : [label(i)],
      ),
      ...res.areas.flatMap((a: LinkArea, i) => (inside(a, res.capture) ? [] : [`area ${i} ${a.alt}`])),
    ];
    expect.soft(outside, "A3 inside capture").toEqual([]);

    // A4
    const a4: string[] = [];
    for (const [i, r] of res.runs.entries()) {
      const slice = res.slices[i];
      const clip = res.clips[i];
      const want = slice && clip ? clipTo(slice, clip) : null;
      if (
        !want ||
        !near(r.x, want.x) ||
        !near(r.top, want.y) ||
        !near(r.width, want.width) ||
        !near(r.height, want.height)
      ) {
        const got = [r.x, r.top, r.width, r.height].map(r2);
        a4.push(
          `${label(i)}: run ${got} vs slice ${want && [want.x, want.y, want.width, want.height].map(r2)}`,
        );
      }
    }
    expect.soft(a4, "A4 run rect = slice rect").toEqual([]);

    // A5
    const a5: string[] = [];
    for (const [i, r] of res.runs.entries()) {
      const probe = res.probes[i];
      const tol = exp.baselineTolerance?.[r.text] ?? BASELINE_TOL;
      if (probe === undefined || !near(r.y, probe, tol)) {
        a5.push(`${label(i)}: y ${r2(r.y)} vs probe ${probe === undefined ? "none" : r2(probe)}`);
      }
    }
    expect.soft(a5, "A5 baseline").toEqual([]);

    // A6
    expect
      .soft(linkGroups(res.runs), "A6 links")
      .toEqual((exp.links ?? []).map((l) => ({ text: l.text, href: abs(l.href) })));
    expect
      .soft(
        res.areas.map((a) => ({ alt: a.alt, href: a.href })),
        "A6 areas",
      )
      .toEqual((exp.areas ?? []).map((a) => ({ alt: a.alt, href: abs(a.href) })));

    for (const [key, value] of Object.entries(exp.stats ?? {})) {
      expect.soft(res.stats[key as keyof CollectStats], `stats.${key}`).toBe(value);
    }
    if (exp.maxMs !== undefined)
      expect.soft(res.ms, `collect time (ms) < ${exp.maxMs}`).toBeLessThan(exp.maxMs);
    expect.soft(res.publicRuns, "collectTextRuns = detailed runs").toEqual(res.runs);
  });
}
