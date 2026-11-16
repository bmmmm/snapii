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

interface Options {
  /** Default: on. */
  wholeWords?: boolean;
  occlusionCheck?: boolean;
  /**
   * Glyphs of the rows' box, each as a text with a "|" before it. The result's
   * `lines` says which line each stands on, counted from the topmost of them:
   * a test that needs the page to wrap somewhere says so and sees it.
   */
  lines?: string[];
}

/** Without the option: the glyphs wholly inside, what Save writes. */
const OFF: Options = { wholeWords: false };

async function load(page: Page): Promise<void> {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
}

/** The runs of `region` over `html` as the page's body: their texts, the plain text and the characters taken. */
function collect(page: Page, html: string, region: Region, opts: Options = {}) {
  return page.evaluate(
    async ({ html, region, opts }) => {
      document.body.innerHTML = html;
      await Promise.all([...document.images].map((img) => img.decode()));
      const h = window.__snapii;
      const glyph = ([sel, at]: [string, string]): DOMRect => {
        const el = document.querySelector(sel);
        const bar = at.indexOf("|");
        const found = (el?.textContent ?? "").indexOf(at.replace("|", ""));
        if (!el || bar < 0 || found < 0) throw new Error(`no "${at}" in ${sel}`);
        let index = found + bar;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          if (index < n.data.length) {
            const one = document.createRange();
            one.setStart(n, index);
            one.setEnd(n, index + ((n.data.codePointAt(index) ?? 0) > 0xffff ? 2 : 1));
            return one.getBoundingClientRect();
          }
          index -= n.data.length;
        }
        throw new Error(`"${at}" is not in a text node of ${sel}`);
      };
      const x = ([sel, at, frac]: Spot): number => {
        const box = glyph([sel, at]);
        return box.left + scrollX + frac * box.width;
      };
      const [sel, from, to] = region.rows ?? ["#p", 0, 1];
      const rows = h.debug.captureRect(sel);
      const left = region.left ? x(region.left) : rows.x;
      const right = region.right ? x(region.right) : rows.x + rows.width;
      const { runs, sources, stats } = await h.debug.collectTextRunsDetailed(
        document,
        { x: left, y: rows.y + from * rows.height, width: right - left, height: (to - from) * rows.height },
        { wholeWords: opts.wholeWords ?? true, occlusionCheck: opts.occlusionCheck ?? false },
      );
      const tops = (opts.lines ?? []).map((at) => Math.round(glyph([sel, at]).top));
      const distinct = [...new Set(tops)].sort((a, b) => a - b);
      return {
        texts: runs.map((r) => r.text),
        plain: h.runsToPlainText(runs),
        taken: sources.map((s) => s.node.data.slice(s.start, s.end)),
        lines: tops.map((t) => distinct.indexOf(t)),
        ms: stats.ms,
      };
    },
    { html, region, opts },
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
  expect((await collect(page, WORDS, region, OFF)).texts).toEqual(["a gamma delta"]);
});

test("a word cut at the region's right edge is taken whole", async ({ page }) => {
  await load(page);
  const region: Region = { left: null, right: ["#p", "gam|ma", 0.5] };
  expect((await collect(page, WORDS, region)).texts).toEqual(["alpha beta gamma"]);
  expect((await collect(page, WORDS, region, OFF)).texts).toEqual(["alpha beta gam"]);
});

test("words cut at both edges are taken whole, the words outside are not", async ({ page }) => {
  await load(page);
  const region: Region = { left: ["#p", "be|ta", 0.5], right: ["#p", "gam|ma", 0.5] };
  const got = await collect(page, WORDS, region);
  expect(got.texts).toEqual(["beta gamma"]);
  expect(got.taken).toEqual(["beta gamma"]);
  expect((await collect(page, WORDS, region, OFF)).texts).toEqual(["a gam"]);
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
      (await collect(page, INLINE, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] }, OFF)).texts,
    ).toEqual([]);
  });
}

test("a word that ends inside its text node takes nothing from the text beside it", async ({ page }) => {
  await load(page);
  const cut = async (at: string) =>
    (await collect(page, INLINE, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] })).taken;
  expect(await cut("s|ee")).toEqual(["see"]);
  expect(await cut("n|ow")).toEqual(["now"]);
  // Nor where the letters stand 1 px apart, and the text beside is nearer than a gap that parts words.
  const near = async (inner: string) =>
    (
      await collect(page, line(inner, "letter-spacing:-11px"), {
        left: ["#p", "b|ar", 0.2],
        right: ["#p", "b|ar", 0.8],
      })
    ).taken;
  expect(await near("foo<b>x bar</b>")).toEqual(["bar"]);
  expect(await near("<b>bar x</b>foo")).toEqual(["bar"]);
});

test("the word goes on from a text node that has lines above in the region", async ({ page }) => {
  await load(page);
  // One text node of three lines, broken by its own newlines: "aaa bbb ccc", "ddd eee", "foo" before
  // "bar". The region is the column of the fifth letter.
  const html = line("aaa bbb ccc\nddd eee\nfoo<b>bar</b>", "white-space:pre");
  const got = await collect(page, html, { left: ["#p", "aaa |bbb", 0.2], right: ["#p", "aaa |bbb", 0.8] });
  expect(got.plain).toBe("bbb\neee\nfoobar");
  expect(got.taken).toEqual(["bbb", "eee", "foo", "bar"]);
});

test("what parts two words for capitalize parts them here: a space, an inline-block, a picture; hidden text does not", async ({
  page,
}) => {
  await load(page);
  const inBar: Region = { left: ["#p", "b|ar", 0.2], right: ["#p", "b|ar", 0.8] };
  const plain = async (inner: string) => (await collect(page, line(inner), inBar)).plain;
  expect(await plain("foo <b>bar</b> baz")).toBe("bar");
  expect(await plain('foo<span style="display:inline-block">bar</span>baz')).toBe("bar");
  // 4 px wide: nearer than the gap that parts two words by itself.
  expect(await plain('foo<img src="images/quadrants.png" alt="" width="4" height="4"><b>bar</b>')).toBe(
    "bar",
  );
  // Two lines; the region is on the second.
  const below = await collect(page, line("foo<br><b>bar</b>"), { ...inBar, rows: ["#p", 0.5, 1] });
  expect(below.plain).toBe("bar");
  expect(await plain('foo<span style="display:none">x</span><b>bar</b>')).toBe("foobar");
  // The case of a joined word is the page's: one word, one capital.
  expect(await plain('<span style="text-transform:capitalize">see foo<b>bar</b></span>')).toBe("Foobar");
});

test("a gap the eye sees ends a word: padded links side by side are three words", async ({ page }) => {
  await load(page);
  const link = (text: string) => `<a href="#${text}" style="padding:0 20px">${text}</a>`;
  const nav = line(link("Home") + link("About") + link("Contact"));
  const cut = async (html: string, at: string) =>
    (await collect(page, html, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] })).plain;
  expect(await cut(nav, "Ab|out")).toBe("About");
  expect(await cut(nav, "H|ome")).toBe("Home");
  expect(await cut(nav, "Cont|act")).toBe("Contact");
  // 6 px between the two: more than a quarter of the font size.
  expect(await cut(line('foo<b style="margin-left:6px">bar</b>'), "f|oo")).toBe("foo");
  // What letter-spacing puts between two letters is no gap, here 10 px after each.
  const spaced = line("S<span>PA</span>CED out", "letter-spacing:10px");
  expect(await cut(spaced, "P|A")).toBe("SPACED");
  expect(await cut(spaced, "|SPACED")).toBe("SPACED");
  expect(await cut(spaced, "SPAC|ED")).toBe("SPACED");
});

test("in a flex or grid row each item is a box of its own: no word goes on past one", async ({ page }) => {
  await load(page);
  const row = (inner: string, style: string) =>
    `<div id="p" style="${style};width:600px;font:20px/1.5 monospace;white-space:nowrap">${inner}</div>`;
  const cut = async (html: string, at: string) =>
    (await collect(page, html, { left: ["#p", at, 0.2], right: ["#p", at, 0.8] })).plain;
  for (const style of ["display:flex;justify-content:space-between", "display:flex", "display:inline-flex"]) {
    expect(await cut(row("Total<b>5</b>items", style), "T|otal")).toBe("Total");
    expect(await cut(row("Total<b>5</b>items", style), "it|ems")).toBe("items");
  }
  // An item too narrow to part them by its width: it parts them as an item.
  const thin = row('Total<b style="width:2px"></b>items', "display:flex");
  expect(await cut(thin, "T|otal")).toBe("Total");
  expect(await cut(thin, "it|ems")).toBe("items");
  const grid = row("Name<i>x</i>Value", "display:grid;grid-template-columns:200px 200px 200px");
  expect(await cut(grid, "N|ame")).toBe("Name");
  expect(await cut(grid, "Val|ue")).toBe("Value");
  expect(
    await cut(
      row('Total<i style="width:2px"></i>items', "display:inline-grid;grid-auto-flow:column"),
      "T|otal",
    ),
  ).toBe("Total");
  // Each text an item of its own.
  expect(await cut(row("<span>Total</span><b>5</b><span>items</span>", "display:flex"), "T|otal")).toBe(
    "Total",
  );
  // An item of the row all the same under a wrapper that has no box of its own.
  const wrapped = row(
    '<span style="display:contents">Total<b style="width:2px"></b>items</span>',
    "display:flex",
  );
  expect(await cut(wrapped, "T|otal")).toBe("Total");
  // No items: an element without a box, and one taken out of the flow.
  expect(await cut(row('Total<b style="display:none">5</b>items', "display:flex"), "T|otal")).toBe(
    "Totalitems",
  );
  expect(await cut(row('To<i style="position:absolute"></i>tal<b>5</b>items', "display:flex"), "T|o")).toBe(
    "Total",
  );
  // Two text nodes with no item between are one item, and so is a word inside an item.
  expect(await cut(row("To<!-- -->tal<b>5</b>items", "display:flex"), "T|o")).toBe("Total");
  expect(await cut(row("<span>foo<b>bar</b>baz</span><b>5</b>", "display:flex"), "b|ar")).toBe("foobarbaz");
});

test("a ruby annotation is no part of its base's word, nor the base of the annotation's", async ({
  page,
}) => {
  await load(page);
  const cut = async (html: string, sel: string, at: string) =>
    (await collect(page, html, { left: [sel, at, 0.2], right: [sel, at, 0.8], rows: [sel, 0, 1] })).taken;
  // The annotation above its base: the rows are the base's, then the annotation's.
  const above = line('<ruby><span id="b">base</span><rt id="rt">anno</rt></ruby>text more');
  expect(await cut(above, "#b", "b|ase")).toEqual(["base"]);
  expect(await cut(above, "#rt", "a|nno")).toEqual(["anno"]);
  // A page that sets it in the line (the fallback of old browsers): beside its base, still not its word.
  const inline = line('<ruby>base<rt style="display:inline">anno</rt></ruby>text more');
  expect(await cut(inline, "#p", "ba|se")).toEqual(["base"]);
  expect(await cut(inline, "#p", "an|no")).toEqual(["anno"]);
  expect(await cut(inline, "#p", "te|xt")).toEqual(["text"]);
});

test("text the page hides is never taken, and a word does not go on through it", async ({ page }) => {
  await load(page);
  for (const hidden of ["visibility:hidden", "opacity:0"]) {
    const html = line(`foo<b style="${hidden}">bar</b>baz`);
    const cut = async (from: string, to = from) =>
      (await collect(page, html, { left: ["#p", from, 0.2], right: ["#p", to, 0.8] })).taken;
    expect(await cut("f|oo")).toEqual(["foo"]);
    expect(await cut("ba|z")).toEqual(["baz"]);
    expect(await cut("b|ar")).toEqual([]);
    expect(await cut("f|oo", "ba|z")).toEqual(["foo", "baz"]);
  }
});

test("the part of a word in the text beside it is what the page shows of it", async ({ page }) => {
  await load(page);
  const cut = async (html: string, at: string, rows?: Region["rows"]) =>
    (await collect(page, html, { left: ["#p", at, 0.2], right: ["#p", at, 0.8], ...(rows ? { rows } : {}) }))
      .taken;
  const box = (style: string) =>
    `<div id="p" style="font:20px/1.5 monospace;white-space:nowrap;overflow:hidden;margin:20px;${style}">foo<b>bar</b>baz</div>`;
  // The box ends inside the "a" of "bar", then inside its "b": the rest is not on the page.
  expect(await cut(box("width:4.4ch"), "f|oo")).toEqual(["foo", "b"]);
  expect(await cut(box("width:3.4ch"), "f|oo")).toEqual(["foo"]);
  // The box starts inside the second letter of "foo".
  expect(await cut(box("width:20ch;text-indent:-1.6ch"), "b|ar")).toEqual(["o", "bar", "baz"]);
  // A tall neighbour with less than half its height in the region's rows is not in the region.
  const tall = line('<span id="s">foo</span><b style="font-size:60px">BAR</b>');
  expect(await cut(tall, "f|oo", ["#s", 0, 1])).toEqual(["foo"]);
  expect(await cut(tall, "f|oo")).toEqual(["foo", "BAR"]);
});

test("a word under something else is left out by its part in the region, with the occlusion check on", async ({
  page,
}) => {
  await load(page);
  // The cover hides the word's first 20 letters, its middle among them; the rest and " ab" show.
  const html = `<div style="position:relative;font:20px/1.5 monospace;margin:20px">
    <p id="p" style="margin:0;white-space:nowrap">Donaudampfschifffahrtsgesellschaft ab</p>
    <div style="position:absolute;left:0;top:0;width:20ch;height:100%;background:#fff"></div></div>`;
  const shown: Region = { left: ["#p", "ges|ell", 0.5], right: ["#p", "gesellsch|aft", 0.5] };
  const on = await collect(page, html, shown, { occlusionCheck: true });
  expect(on.texts).toEqual(["Donaudampfschifffahrtsgesellschaft"]);
  expect((await collect(page, html, shown, { wholeWords: false, occlusionCheck: true })).texts).toEqual([
    "llsch",
  ]);
  // The region over the covered letters only: no word.
  const covered: Region = { left: ["#p", "Do|nau", 0.5], right: ["#p", "Donaudam|pf", 0.5] };
  expect((await collect(page, html, covered, { occlusionCheck: true })).texts).toEqual([]);
  expect((await collect(page, html, covered)).texts).toEqual(["Donaudampfschifffahrtsgesellschaft"]);
  // Across text nodes each part in the region counts by itself: a covered one is left out and
  // not brought back by the one beside it.
  const parts = `<div style="position:relative;font:20px/1.5 monospace;margin:20px">
    <p id="p" style="margin:0;white-space:nowrap">foo<b>bar</b>baz</p>
    <div style="position:absolute;left:0;top:0;width:3ch;height:100%;background:#fff"></div></div>`;
  const both: Region = { left: ["#p", "f|oo", 0.5], right: ["#p", "b|ar", 0.5] };
  expect((await collect(page, parts, both, { occlusionCheck: true })).taken).toEqual(["bar", "baz"]);
  expect((await collect(page, parts, both)).taken).toEqual(["foo", "bar", "baz"]);
  // And a covered one brings nothing with it.
  const inFoo: Region = { left: ["#p", "f|oo", 0.2], right: ["#p", "f|oo", 0.8] };
  expect((await collect(page, parts, inFoo, { occlusionCheck: true })).taken).toEqual([]);
  // The cover over "baz": the same from the word's other end.
  const inBaz: Region = { left: ["#p", "ba|z", 0.2], right: ["#p", "ba|z", 0.8] };
  const last = parts.replace("left:0", "left:6ch");
  expect((await collect(page, last, inBaz, { occlusionCheck: true })).taken).toEqual([]);
  expect((await collect(page, last, inBaz)).taken).toEqual(["foo", "bar", "baz"]);
});

test("glyphs narrower than the tolerance still reach into the region", async ({ page }) => {
  await load(page);
  // Each letter 0.3 px after the one before.
  const html = line("abcdefgh ijkl", "letter-spacing:-11.7px");
  const region: Region = { left: ["#p", "a|bcdefgh", 0.5], right: null };
  expect((await collect(page, html, region, OFF)).texts).toEqual(["bcdefgh ijkl"]);
  expect((await collect(page, html, region)).texts).toEqual(["abcdefgh ijkl"]);
  // 0.7 px apart, the edge 0.42 px into the "b": less than half of it inside, but within the
  // tolerance that makes it a glyph inside for Save. A word of its own, it must not get lost.
  const wider = line("a b cdefgh ijkl", "letter-spacing:-11.3px");
  const inB: Region = { left: ["#p", "a |b", 0.6], right: null };
  expect((await collect(page, wider, inB, OFF)).texts).toEqual(["b cdefgh ijkl"]);
  expect((await collect(page, wider, inB)).texts).toEqual(["b cdefgh ijkl"]);
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
  const third: Region = { left: ["#p", "kno|wn", 0.2], right: ["#p", "kno|wn", 0.8], rows: ["#p", 0.7, 1] };
  // The page wraps where the test says; with other widths it would test something else.
  const lines = ["|aa", "|well-", "well|-", "|known"];
  const got = await collect(page, html, third, { lines });
  expect(got.lines).toEqual([0, 1, 1, 2]);
  expect(got.texts).toEqual(["known"]);
  // The same across two elements, each of one line.
  const parts = await collect(page, html.replace("well-known", "<i>well-</i><b>known</b>"), third, {
    lines,
  });
  expect(parts.lines).toEqual([0, 1, 1, 2]);
  expect(parts.texts).toEqual(["known"]);
  // "aaaa well-", "known", both lines in the region's rows: its column reaches "aaaa" and "known" only.
  const rows = await collect(
    page,
    html.replace("6ch", "11ch").replace("aa well-known", "aaaa <i>well-</i><b>known</b>"),
    { left: ["#p", "k|nown", 0.2], right: ["#p", "k|nown", 0.8] },
    { lines: ["|aaaa", "well|-", "|known"] },
  );
  expect(rows.lines).toEqual([0, 0, 1]);
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
  // The box shows "alpha be" and less than half of the "t"; the region is wider than the box.
  const html = `<div id="rows" style="width:600px"><div style="width:8.4ch;overflow:hidden;font:20px/1.5 monospace;white-space:nowrap" id="p">alpha beta gamma</div></div>`;
  const wide = await collect(page, html, { left: null, right: null, rows: ["#rows", 0, 1] });
  expect(wide.texts).toEqual(["alpha be"]);
  // The region's left edge through "alpha" gives the word; the page's edge through "beta" does not.
  const cut = await collect(page, html, { left: ["#p", "al|pha", 0.5], right: null, rows: ["#rows", 0, 1] });
  expect(cut.texts).toEqual(["alpha be"]);
  expect((await collect(page, html, { left: ["#p", "al|pha", 0.5], right: null }, OFF)).texts).toEqual([
    "ha be",
  ]);
  // Cut by the page at both ends, well inside the region, a third of a letter beyond "ha beta g" on
  // either side: neither end grows back to its word.
  const both = `<div id="rows" style="width:600px"><div style="width:9.6ch;margin-left:100px;text-indent:-2.7ch;overflow:hidden;font:20px/1.5 monospace;white-space:nowrap" id="p">alpha beta gamma</div></div>`;
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
  const got = await collect(page, html, region, { lines: ["|alpha", "gamm|a", "|delta", "|zeta"] });
  expect(got.lines).toEqual([0, 0, 1, 2]);
  expect(got.texts).toEqual(["beta", "epsilon", "eta theta"]);
  expect(got.plain).toBe("beta\nepsilon\neta theta");
  expect((await collect(page, html, region, OFF)).texts).toEqual(["t", "s"]);
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
  // Beside such a script two pieces of text are two words as likely as one: no joining.
  const pieces = line("東京<b>bar</b>京").replace("<p ", '<p lang="ja" ');
  const inBar = await collect(page, pieces, { left: ["#p", "b|ar", 0.2], right: ["#p", "b|ar", 0.8] });
  expect(inBar.taken).toEqual(["bar"]);
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

test("the option never takes less: every letter the glyphs inside give is in the words", async ({ page }) => {
  // Columns of three widths across each page's capture, a little beside it on both sides.
  const pages = [
    "multiline.html",
    "copy.html",
    "inline-links.html",
    "letter-spacing.html",
    "transform.html",
    "rtl.html",
    "pre.html",
    // Letters drawn over one another, 0.3 px apart, and a word across elements.
    '<p id="cap" style="font:20px/1.5 monospace;white-space:nowrap;letter-spacing:-11.7px;width:60px">abcdefgh ijkl <b>mno</b>pqr</p>',
  ];
  let letters = 0;
  let grown = 0;
  for (const fixture of pages) {
    await page.goto(`/fixtures/${fixture.startsWith("<") ? "smoke.html" : fixture}`);
    await page.addScriptTag({ path: "dist-test/harness.js" });
    const got = await page.evaluate(
      async (html) => {
        if (html) document.body.innerHTML = html;
        const h = window.__snapii;
        const cap = h.debug.captureRect("#cap");
        const missing: string[] = [];
        let letters = 0;
        let grown = 0;
        const step = Math.max(3.7, (cap.width + 20) / 31.3);
        for (const width of [3, 41, 173]) {
          for (let x = cap.x - 10; x < cap.x + cap.width + 10; x += step) {
            const region = { x, y: cap.y, width, height: cap.height };
            const off = await h.debug.collectTextRunsDetailed(document, region, {});
            const on = await h.debug.collectTextRunsDetailed(document, region, { wholeWords: true });
            const count = (sources: typeof on.sources) => sources.reduce((n, s) => n + s.end - s.start, 0);
            if (count(on.sources) > count(off.sources)) grown++;
            for (const s of off.sources) {
              for (let at = s.start; at < s.end; at++) {
                if (!/\S/.test(s.node.data.charAt(at))) continue;
                letters++;
                if (!on.sources.some((o) => o.node === s.node && o.start <= at && at < o.end)) {
                  missing.push(
                    `"${s.node.data.slice(s.start, s.end)}" [${at - s.start}] at x ${x}, ${width} wide`,
                  );
                }
              }
            }
          }
        }
        return { missing: missing.slice(0, 5), letters, grown };
      },
      fixture.startsWith("<") ? fixture : null,
    );
    expect(got.missing, fixture).toEqual([]);
    expect(got.letters, fixture).toBeGreaterThan(0);
    letters += got.letters;
    grown += got.grown;
  }
  // Not vacuous (4 419 letters, 318 regions where the words were more than the glyphs).
  expect(letters).toBeGreaterThan(2000);
  expect(grown).toBeGreaterThan(100);
});

test("whole words on a 1 MB line with the edge a million px in: found as fast as the glyphs", async ({
  page,
}) => {
  await load(page);
  const got = await page.evaluate(async () => {
    document.body.innerHTML = `<pre id="p" style="margin:0;white-space:pre">${"word ".repeat(200_000)}</pre>`;
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const region = { ...cap, x: cap.x + 1_000_000, width: 400 };
    const collect = (wholeWords: boolean) =>
      h.debug.collectTextRunsDetailed(document, region, { wholeWords });
    // The first collection lays the line out; the two after it time the glyphs alone.
    await collect(false);
    const off = Math.max((await collect(false)).stats.ms, (await collect(false)).stats.ms);
    const { runs, stats } = await collect(true);
    return { ms: stats.ms, off, texts: runs.map((r) => r.text) };
  });
  expect(got.texts.length).toBe(1);
  // Preserved text: a space the region reaches is text too.
  expect(got.texts[0]).toMatch(/^ ?word( word){5,} ?$/);
  // Against the same line without the option, in the same page under the same load: a fixed
  // limit failed on a busy machine. Measured 1.1–1.4 s for both; reading every glyph up to the
  // edge, which the search spares, took 14 s.
  expect(got.ms).toBeLessThan(3 * got.off + 500);
});

test("600 blocks nested in one another: the text beside a word is looked up, not searched for", async ({
  page,
}) => {
  await load(page);
  const got = await page.evaluate(async () => {
    const n = 600;
    document.body.innerHTML = `<div id="p">${"<div>h".repeat(n)}${"t</div>".repeat(n)}</div>`;
    const h = window.__snapii;
    const cap = h.debug.captureRect("#p");
    const collect = (wholeWords: boolean) => h.debug.collectTextRunsDetailed(document, cap, { wholeWords });
    await collect(false);
    const off = (await collect(false)).stats.ms;
    const on = await collect(true);
    return { off, ms: on.stats.ms, runs: on.runs.length };
  });
  expect(got.runs).toBeGreaterThan(1000);
  // Every line starts at the region's edge, so each asks for its neighbour. Measured 60–80 ms
  // without the option and 80–110 ms with it; a search from each text took 23–27 s here (4.5 s
  // for 300 blocks, 0.7 s for 160).
  expect(got.ms).toBeLessThan(3000);
});
