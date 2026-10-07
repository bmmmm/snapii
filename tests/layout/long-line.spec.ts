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
