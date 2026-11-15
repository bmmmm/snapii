// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text's whole words (`wholeWords` of the collector): a word the
// region's left or right edge runs through is taken whole, a word wholly
// outside is not, and without the option the same region still gives the
// whole glyphs inside it, which is what Save writes. The regions are placed
// on measured glyphs, so no expectation depends on a font's widths.
import { expect, type Page, test } from "@playwright/test";

/** A place across the page: `frac` of the way over the glyph after the "|" in `at`, a text found in `sel`. */
type Spot = [sel: string, at: string, frac: number];

interface Region {
  /** null: the left (right) edge of the rows' box. */
  left: Spot | null;
  right: Spot | null;
  /** The box that gives the region's rows, and the part of its height they take. Default: all of #p. */
  rows?: [sel: string, from: number, to: number];
}

async function load(page: Page): Promise<void> {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
}

/** The runs of `region` over `html` as the page's body: their texts, the plain text and the characters taken. */
function collect(page: Page, html: string, region: Region, wholeWords = true) {
  return page.evaluate(
    async ({ html, region, wholeWords }) => {
      document.body.innerHTML = html;
      const h = window.__snapii;
      const x = ([sel, at, frac]: Spot): number => {
        const el = document.querySelector(sel);
        const bar = at.indexOf("|");
        const found = (el?.textContent ?? "").indexOf(at.replace("|", ""));
        if (!el || bar < 0 || found < 0) throw new Error(`no "${at}" in ${sel}`);
        let index = found + bar;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          if (index < n.data.length) {
            const glyph = document.createRange();
            glyph.setStart(n, index);
            glyph.setEnd(n, index + ((n.data.codePointAt(index) ?? 0) > 0xffff ? 2 : 1));
            const box = glyph.getBoundingClientRect();
            return box.left + scrollX + frac * box.width;
          }
          index -= n.data.length;
        }
        throw new Error(`"${at}" is not in a text node of ${sel}`);
      };
      const [sel, from, to] = region.rows ?? ["#p", 0, 1];
      const rows = h.debug.captureRect(sel);
      const left = region.left ? x(region.left) : rows.x;
      const right = region.right ? x(region.right) : rows.x + rows.width;
      const { runs, sources, stats } = await h.debug.collectTextRunsDetailed(
        document,
        { x: left, y: rows.y + from * rows.height, width: right - left, height: (to - from) * rows.height },
        { wholeWords },
      );
      return {
        texts: runs.map((r) => r.text),
        plain: h.runsToPlainText(runs),
        taken: sources.map((s) => s.node.data.slice(s.start, s.end)),
        ms: stats.ms,
      };
    },
    { html, region, wholeWords },
  );
}

/** One line of 20 px monospace text, #p. */
const line = (inner: string, style = ""): string =>
  `<p id="p" style="font:20px/1.5 monospace;white-space:nowrap;margin:20px;${style}">${inner}</p>`;

const WORDS = line("alpha beta gamma delta");

test("a word cut at the region's left edge is taken whole; without the option the glyphs inside, as Save has them", async ({
  page,
}) => {
  await load(page);
  const region: Region = { left: ["#p", "be|ta", 0.5], right: null };
  expect((await collect(page, WORDS, region)).texts).toEqual(["beta gamma delta"]);
  expect((await collect(page, WORDS, region, false)).texts).toEqual(["a gamma delta"]);
});

test("a word cut at the region's right edge is taken whole", async ({ page }) => {
  await load(page);
  const region: Region = { left: null, right: ["#p", "gam|ma", 0.5] };
  expect((await collect(page, WORDS, region)).texts).toEqual(["alpha beta gamma"]);
  expect((await collect(page, WORDS, region, false)).texts).toEqual(["alpha beta gam"]);
});

test("words cut at both edges are taken whole, the words outside are not", async ({ page }) => {
  await load(page);
  const region: Region = { left: ["#p", "be|ta", 0.5], right: ["#p", "gam|ma", 0.5] };
  const got = await collect(page, WORDS, region);
  expect(got.texts).toEqual(["beta gamma"]);
  expect(got.taken).toEqual(["beta gamma"]);
  expect((await collect(page, WORDS, region, false)).texts).toEqual(["a gam"]);
});

test("an edge in the space between two words takes no word beyond it", async ({ page }) => {
  await load(page);
  const got = await collect(page, WORDS, {
    left: ["#p", "alpha| beta", 0.5],
    right: ["#p", "gamma| delta", 0.5],
  });
  expect(got.texts).toEqual(["beta gamma"]);
});

test("part of one glyph inside is enough; a word that only touches the edge is outside", async ({ page }) => {
  await load(page);
  // A fifth of beta's last letter and of gamma's first.
  const sliver = await collect(page, WORDS, { left: ["#p", "bet|a", 0.8], right: ["#p", "|gamma", 0.2] });
  expect(sliver.texts).toEqual(["beta gamma"]);
  // The edges on the glyphs' own edges: beta ends where the region starts.
  const touching = await collect(page, WORDS, { left: ["#p", "bet|a", 1], right: ["#p", "gamm|a", 1] });
  expect(touching.texts).toEqual(["gamma"]);
});

test("a line with less than half its height in the region gives no word, as before", async ({ page }) => {
  await load(page);
  const left: Spot = ["#p", "be|ta", 0.5];
  expect((await collect(page, WORDS, { left, right: null, rows: ["#p", 0, 0.4] })).texts).toEqual([]);
  expect((await collect(page, WORDS, { left, right: null, rows: ["#p", 0, 0.6] })).texts).toEqual([
    "beta gamma delta",
  ]);
});

const INLINE = line("see foo<b>bar</b>baz now");

for (const [part, at] of [
  ["first", "f|oo"],
  ["middle", "b|ar"],
  ["last", "ba|z"],
] as const) {
  test(`a word across inline elements, cut in its ${part} text node, is taken whole across all three`, async ({
    page,
  }) => {
    await load(page);
    // The region lies inside one glyph: the two other text nodes are wholly outside it.
    const got = await collect(page, INLINE, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] });
    expect(got.plain).toBe("foobarbaz");
    expect(got.taken).toEqual(["foo", "bar", "baz"]);
    expect(
      (await collect(page, INLINE, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] }, false)).texts,
    ).toEqual([]);
  });
}

test("the word goes on from a text node that has lines above in the region", async ({ page }) => {
  await load(page);
  // Three lines: "aaa bbb ccc", "ddd eee", "foobar"; the region is the column of the fifth letter.
  const html =
    '<p id="p" style="font:20px/1.5 monospace;width:12ch;margin:20px">aaa bbb ccc ddd eee foo<b>bar</b></p>';
  const got = await collect(page, html, { left: ["#p", "aaa| bbb", 0.5], right: ["#p", "aaa |bbb", 0.5] });
  expect(got.plain).toBe("bbb\neee\nfoobar");
});

test("what parts two words for capitalize parts them here: a space, an inline-block, a picture; hidden text does not", async ({
  page,
}) => {
  await load(page);
  const inBar: Region = { left: ["#p", "b|ar", 0.2], right: ["#p", "b|ar", 0.8] };
  const plain = async (inner: string) => (await collect(page, line(inner), inBar)).plain;
  expect(await plain("foo <b>bar</b> baz")).toBe("bar");
  expect(await plain('foo<span style="display:inline-block">bar</span>baz')).toBe("bar");
  expect(await plain('foo<img alt="" width="4" height="4"><b>bar</b>')).toBe("bar");
  // Two lines; the region is on the second.
  const below = await collect(page, line("foo<br><b>bar</b>"), { ...inBar, rows: ["#p", 0.5, 1] });
  expect(below.plain).toBe("bar");
  expect(await plain('foo<span style="display:none">x</span><b>bar</b>')).toBe("foobar");
  // The case of a joined word is the page's: one word, one capital.
  expect(await plain('<span style="text-transform:capitalize">see foo<b>bar</b></span>')).toBe("Foobar");
});

test("punctuation, a hyphenated compound, a number and a URL stay in one piece", async ({ page }) => {
  await load(page);
  const html = line("He said (well-known, e.g. https://example.org/a?b=1). 3,5 kg");
  const cut = async (at: string) =>
    (await collect(page, html, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] })).texts;
  expect(await cut("kno|wn")).toEqual(["(well-known,"]);
  expect(await cut("exa|mple")).toEqual(["https://example.org/a?b=1)."]);
  expect(await cut("3|,5")).toEqual(["3,5"]);
});

test("a word wrapped at its hyphen is taken line by line", async ({ page }) => {
  await load(page);
  // "aa", "well-", "known": the region is on the third line only.
  const html = '<p id="p" style="font:20px/1.5 monospace;width:6ch;margin:20px">aa well-known</p>';
  const got = await collect(page, html, {
    left: ["#p", "kno|wn", 0.2],
    right: ["#p", "kno|wn", 0.8],
    rows: ["#p", 0.7, 1],
  });
  expect(got.texts).toEqual(["known"]);
  // The same across two elements, each of one line.
  const parts = await collect(page, html.replace("well-known", "<i>well-</i><b>known</b>"), {
    left: ["#p", "kno|wn", 0.2],
    right: ["#p", "kno|wn", 0.8],
    rows: ["#p", 0.7, 1],
  });
  expect(parts.texts).toEqual(["known"]);
  // "aaaa well-", "known", both lines in the region's rows: its column reaches "aaaa" and "known" only.
  const rows = await collect(
    page,
    html.replace("6ch", "11ch").replace("aa well-known", "aaaa <i>well-</i><b>known</b>"),
    { left: ["#p", "k|nown", 0.2], right: ["#p", "k|nown", 0.8] },
  );
  expect(rows.texts).toEqual(["aaaa", "known"]);
});

test("a right-to-left line: the words the region reaches, whole", async ({ page }) => {
  await load(page);
  // Second and third word; the third lies left of the second.
  const got = await collect(page, line("שלום עולם טוב מאוד", "direction:rtl"), {
    left: ["#p", "ט|וב", 0.5],
    right: ["#p", "עו|לם", 0.5],
  });
  expect(got.texts).toEqual(["עולם טוב"]);
  // A line of several bidi fragments is read glyph by glyph.
  const mixed = await collect(page, line("abc שלום def ghi"), {
    left: ["#p", "d|ef", 0.2],
    right: ["#p", "d|ef", 0.8],
  });
  expect(mixed.texts).toEqual(["def"]);
});

test("what the page clips stays cut: only the region's own edges give way to a word", async ({ page }) => {
  await load(page);
  // The box shows "alpha be"; the region is wider than the box.
  const html = `<div id="rows" style="width:600px"><div style="width:8ch;overflow:hidden;font:20px/1.5 monospace;white-space:nowrap" id="p">alpha beta gamma</div></div>`;
  const wide = await collect(page, html, { left: null, right: null, rows: ["#rows", 0, 1] });
  expect(wide.texts).toEqual(["alpha be"]);
  // The region's left edge through "alpha" gives the word; the page's edge through "beta" does not.
  const cut = await collect(page, html, { left: ["#p", "al|pha", 0.5], right: null, rows: ["#rows", 0, 1] });
  expect(cut.texts).toEqual(["alpha be"]);
  expect((await collect(page, html, { left: ["#p", "al|pha", 0.5], right: null }, false)).texts).toEqual([
    "ha be",
  ]);
  // Cut by the page at both ends, well inside the region: neither end grows back to its word.
  const both = `<div id="rows" style="width:600px"><div style="width:9ch;margin-left:100px;text-indent:-3ch;overflow:hidden;font:20px/1.5 monospace;white-space:nowrap" id="p">alpha beta gamma</div></div>`;
  const inside = await collect(page, both, { left: null, right: null, rows: ["#rows", 0, 1] });
  expect(inside.texts).toEqual(["ha beta g"]);
  // The region's right edge through "beta" gives that word; "alpha" stays as the page shows it.
  const mixed = await collect(page, both, { left: null, right: ["#p", "b|eta", 0.5], rows: ["#rows", 0, 1] });
  expect(mixed.texts).toEqual(["ha beta"]);
});

test("a narrow column through a paragraph of three lines gives each line's words", async ({ page }) => {
  await load(page);
  // tests/fixtures/multiline.html: "alpha beta gamma", "delta epsilon", "zeta eta theta".
  const html =
    '<main style="width:17.5ch;font:20px/1.5 monospace"><p id="p">alpha beta gamma delta epsilon zeta eta theta</p></main>';
  const region: Region = { left: ["#p", "b|eta", 0.5], right: ["#p", "bet|a", 0.5] };
  const got = await collect(page, html, region);
  expect(got.texts).toEqual(["beta", "epsilon", "eta theta"]);
  expect(got.plain).toBe("beta\nepsilon\neta theta");
  expect((await collect(page, html, region, false)).texts).toEqual(["t", "s"]);
});

test("a script written without spaces: the word the segmenter sees, not the sentence", async ({ page }) => {
  await load(page);
  const html = line("東京に行くe-mailを書く。", "").replace("<p ", '<p lang="ja" ');
  const inKyo = await collect(page, html, { left: ["#p", "東|京", 0.2], right: ["#p", "東|京", 0.8] });
  const word = await page.evaluate(() => {
    const text = "東京に行くe-mailを書く。";
    for (const s of new Intl.Segmenter("ja", { granularity: "word" }).segment(text)) {
      if (s.index <= 1 && 1 < s.index + s.segment.length) return s.segment;
    }
    return null;
  });
  expect(inKyo.texts).toEqual([word]);
  expect(inKyo.texts[0]).toContain("京");
  expect(inKyo.texts[0]?.length).toBeLessThan(5);
  // The Latin word between keeps its hyphen.
  const inMail = await collect(page, html, { left: ["#p", "e-m|ail", 0.2], right: ["#p", "e-m|ail", 0.8] });
  expect(inMail.texts).toEqual(["e-mail"]);
});

test("surrogate pairs stay whole at a word's edges", async ({ page }) => {
  await load(page);
  const html = line("ab 😀😀cd ef");
  expect((await collect(page, html, { left: ["#p", "😀😀c|d", 0.2], right: null })).texts).toEqual([
    "😀😀cd ef",
  ]);
  expect((await collect(page, html, { left: null, right: ["#p", "😀|😀cd", 0.5] })).texts).toEqual([
    "ab 😀😀cd",
  ]);
});

test("whole words on a 1 MB line with the edge a million px in: found as fast as the glyphs", async ({
  page,
}) => {
  await load(page);
  const got = await page.evaluate(async () => {
    document.body.innerHTML = `<pre id="p" style="margin:0;white-space:pre">${"word ".repeat(200_000)}</pre>`;
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const { runs, stats } = await h.debug.collectTextRunsDetailed(
      document,
      { ...cap, x: cap.x + 1_000_000, width: 400 },
      { wholeWords: true },
    );
    return { ms: stats.ms, texts: runs.map((r) => r.text) };
  });
  expect(got.texts.length).toBe(1);
  // Preserved text: a space the region reaches is text too.
  expect(got.texts[0]).toMatch(/^ ?word( word){5,} ?$/);
  // The limit of long-line.spec for the same line without the option.
  expect(got.ms).toBeLessThan(3000);
});
