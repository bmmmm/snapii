// SPDX-License-Identifier: GPL-3.0-or-later
// One text node of a million characters on a single line (a raw .js or .json
// file as the browser shows it), cut by the capture's edge: trimming the line
// to the clip reads one rect per character, so it has to stop once the clip
// is behind it.
import { expect, type Page, test } from "@playwright/test";

const WORDS = 200_000; // "word " × 200 000 = 1 MB

/** The runs of a 400 px wide clipped container holding the 1 MB line. */
async function collectLongLine(page: Page) {
  await page.goto("/fixtures/smoke.html");
  await page.evaluate((words) => {
    document.body.innerHTML = `<main id="cap" style="width:400px;overflow:hidden"><pre style="margin:0;white-space:pre">${"word ".repeat(words)}</pre></main>`;
  }, WORDS);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  return page.evaluate(async () => {
    const h = window.__snapii;
    const { runs, stats } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#cap"), {});
    return { ms: stats.ms, texts: runs.map((r) => r.text) };
  });
}

test("a 1 MB single-line pre cut at the right edge gives its first words within a second", async ({
  page,
}) => {
  const got = await collectLongLine(page);
  expect(got.texts.length).toBe(1);
  expect(got.texts[0]).toMatch(/^word word /);
  // Minutes before the early exit; ~200 ms on Chromium now, with room for a slow CI runner.
  expect(got.ms).toBeLessThan(3000);
});

test("a capture edge a million px into a 1 MB line finds its words within a second", async ({ page }) => {
  // The clip starts deep inside the line: reading one rect per character up
  // to the clip took ~14 s; a binary search finds the first glyph inside it.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate((words) => {
    document.body.innerHTML = `<pre id="p" style="margin:0;white-space:pre">${"word ".repeat(words)}</pre>`;
  }, WORDS);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const got = await page.evaluate(async () => {
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const { runs, stats } = await h.debug.collectTextRunsDetailed(
      document,
      { ...cap, x: cap.x + 1_000_000, width: 400 },
      {},
    );
    return { ms: stats.ms, texts: runs.map((r) => r.text), x: runs.map((r) => r.x - cap.x) };
  });
  expect(got.texts.length).toBe(1);
  expect(got.texts[0]).toMatch(/^(word ?|ord ?|rd ?|d ?| )+$/);
  // Whole glyphs inside the clip only: the run starts at or after the edge.
  expect(got.x[0]).toBeGreaterThanOrEqual(1_000_000 - 0.5);
  expect(got.x[0]).toBeLessThan(1_000_000 + 20);
  expect(got.ms).toBeLessThan(3000);
});

test("a right-to-left 250 KB line with the edge a million px from its start is searched as fast", async ({
  page,
}) => {
  // The line starts at its right end: the search walks right to left.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate((words) => {
    document.body.innerHTML = `<pre id="p" dir="rtl" style="margin:0;white-space:pre;width:max-content">${"שלום ".repeat(words)}</pre>`;
  }, WORDS / 4);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const got = await page.evaluate(async () => {
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const edge = cap.x + cap.width - 1_000_000;
    const { runs, stats } = await h.debug.collectTextRunsDetailed(
      document,
      { ...cap, x: edge - 400, width: 400 },
      {},
    );
    return { ms: stats.ms, texts: runs.map((r) => r.text), right: runs.map((r) => edge - (r.x + r.width)) };
  });
  expect(got.texts.length).toBe(1);
  expect(got.texts[0]).toMatch(/[א-ת]{2}/);
  expect(got.right[0]).toBeGreaterThanOrEqual(-0.5);
  expect(got.right[0]).toBeLessThan(30);
  expect(got.ms).toBeLessThan(3000);
});

test("a 1 MB pre of 5000 lines under a 2000×200 capture gives its visible lines within a second", async ({
  page,
}) => {
  // Finding where each of 5000 lines starts cost one binary search per line
  // of the whole node (8.5 s on Chromium); only the lines the clip meets need one.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(() => {
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `${String(i).padStart(4, "0")} ${"abcdefghi ".repeat(20)}`,
    );
    // Scrolled: the lines are kept by their document position, not the client one.
    document.body.innerHTML = `<div style="height:3000px"></div><main id="cap" style="width:2000px;height:200px;overflow:hidden"><pre style="margin:0">${lines.join("\n")}</pre></main>`;
    scrollTo(0, 2900);
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const got = await page.evaluate(async () => {
    const h = window.__snapii;
    const { runs, stats } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#cap"), {});
    return { ms: stats.ms, texts: runs.map((r) => r.text) };
  });
  expect(got.texts.length).toBeGreaterThanOrEqual(10);
  got.texts.forEach((t, i) => {
    expect(t.trimEnd()).toBe(`${String(i).padStart(4, "0")} ${"abcdefghi ".repeat(20)}`.trimEnd());
  });
  expect(got.ms).toBeLessThan(1000);
});

test("collapsed spaces inside the clip do not end the line early", async ({ page }) => {
  // Of three spaces two collapse to nothing and have no glyph rect: only a
  // glyph outside the clip says the line has left it.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(() => {
    document.body.innerHTML = `<main id="cap" style="width:400px;overflow:hidden"><p style="margin:0;white-space:nowrap">${"word   ".repeat(2000)}</p></main>`;
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const texts = await page.evaluate(async () => {
    const h = window.__snapii;
    const { runs } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#cap"), {});
    return runs.map((r) => r.text);
  });
  expect(texts.length).toBe(1);
  expect(texts[0]).toMatch(/^word word word word /);
});

test("a line that ends in a long run of collapsed spaces is still searched to the clip", async ({ page }) => {
  // The search's first probe lands among the spaces: no glyph from there to
  // the end of the line.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(() => {
    document.body.innerHTML = `<p id="p" style="margin:0;white-space:nowrap;width:max-content">${"word ".repeat(2000)}${" ".repeat(20_000)}</p>`;
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const texts = await page.evaluate(async () => {
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const { runs } = await h.debug.collectTextRunsDetailed(
      document,
      { ...cap, x: cap.x + 2000, width: 400 },
      {},
    );
    return runs.map((r) => r.text);
  });
  expect(texts.length).toBe(1);
  expect(texts[0]).toMatch(/word word /);
});

test("a bidi line is scanned to its end: the right-to-left part re-enters the clip after the left-to-right part left it", async ({
  page,
}) => {
  // "abc שלום עולם def": in logical order the Hebrew starts at its visual
  // right end, outside a clip that ends in its middle, and comes back inside.
  await page.goto("/fixtures/smoke.html");
  await page.evaluate(() => {
    document.body.innerHTML =
      '<main id="cap" style="width:600px"><p id="p" style="margin:0;white-space:nowrap;font:20px serif">abc שלום עולם def</p></main>';
  });
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const texts = await page.evaluate(async () => {
    const h = window.__snapii;
    const node = (document.getElementById("p") as HTMLElement).firstChild as Text;
    const he = document.createRange();
    he.setStart(node, 4);
    he.setEnd(node, 13);
    const r = he.getBoundingClientRect();
    const cap = h.debug.captureRect("#cap");
    const { runs } = await h.debug.collectTextRunsDetailed(
      document,
      { ...cap, width: r.left + scrollX + r.width / 2 - cap.x },
      {},
    );
    return runs.map((t) => t.text);
  });
  expect(texts.length).toBe(1);
  expect(texts[0]).toMatch(/^abc [א-ת]/);
});
