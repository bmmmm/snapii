// SPDX-License-Identifier: GPL-3.0-or-later
// "Copy text" from a real page: the visible part of the selection as clean
// HTML (cloneVisibleRange -> toSNodes -> fragmentToCleanHtml, keep = the run
// sources of collectTextRunsDetailed) and as plain text (runsToPlainText).
// Plus writeClipboard's fallback order with injected clipboard/sendMessage;
// the real clipboard write needs the extension (Marionette glue suite).
import { expect, type Page, test } from "@playwright/test";

async function load(page: Page): Promise<void> {
  await page.goto("/fixtures/copy.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
}

/** Copy text of #cap with the capture rect of `captureSel`; HTML whitespace collapsed. */
function copyText(page: Page, captureSel: string) {
  return page.evaluate(async (captureSel) => {
    const h = window.__snapii;
    const cap = document.getElementById("cap") as HTMLElement;
    const { runs, sources } = await h.debug.collectTextRunsDetailed(
      document,
      h.debug.captureRect(captureSel),
    );
    const range = document.createRange();
    range.selectNodeContents(cap);
    const fragment = h.cloneVisibleRange(range, sources, runs);
    const html = h.fragmentToCleanHtml(h.toSNodes(fragment), {
      baseURL: document.baseURI,
      pageURL: location.href,
    });
    return {
      html: html.replace(/\s+/g, " ").trim(),
      plain: h.runsToPlainText(runs),
      // The clone is detached: the page keeps its hidden text and script.
      pageIntact: cap.textContent?.includes("HIDDENDISPLAY") && cap.textContent.includes("SCRIPTTEXT"),
      origin: location.origin,
    };
  }, captureSel);
}

test("copy text: visible content as clean HTML and plain text", async ({ page }) => {
  await load(page);
  const res = await copyText(page, "#cap");
  const href = new URL("/target?a=1&b=2", res.origin).href.replace(/&/g, "&amp;");
  expect(res.html).toBe(
    [
      "<h1>Copy <em>me</em></h1>",
      `<p>First <b>bold</b> <i>italic</i> paragraph with a <a href="${href}">real link</a> and a script link.</p>`,
      "<p>Shown text and more.</p>",
      '<ul> <li lang="de">Erster Punkt</li> <li>Second <code>item</code></li> </ul>',
      "<p>Escaped &lt;b&gt; &amp; text</p>",
    ].join(" "),
  );
  expect(res.plain).toBe(
    [
      "Copy me",
      "First bold italic paragraph with a real link and a script link.",
      "Shown text and more.",
      "Erster Punkt",
      "Second item",
      "Escaped <b> & text",
    ].join("\n\n"),
  );
  expect(res.pageIntact).toBe(true);
});

test("copy text: text outside the capture rect is left out of the HTML", async ({ page }) => {
  await load(page);
  const res = await copyText(page, "#first");
  const href = new URL("/target?a=1&b=2", res.origin).href.replace(/&/g, "&amp;");
  expect(res.html).toBe(
    `<p>First <b>bold</b> <i>italic</i> paragraph with a <a href="${href}">real link</a> and a script link.</p>`,
  );
  expect(res.plain).toBe("First bold italic paragraph with a real link and a script link.");
});

/**
 * Copy text of a column through `html`, the page's body: from the middle of one glyph of #cap to
 * the middle of another (each a text with "|" before its glyph), over all of #cap's rows, whole
 * words. `lines`: glyphs whose lines the result counts from the top, for a test that needs the
 * page to wrap where it says.
 */
function copyColumn(page: Page, html: string, from: string, to: string, lines: string[] = []) {
  return page.evaluate(
    async ({ html, from, to, lines }) => {
      document.body.innerHTML = html;
      const h = window.__snapii;
      const cap = document.getElementById("cap") as HTMLElement;
      const glyph = (at: string): DOMRect => {
        const found = (cap.textContent ?? "").indexOf(at.replace("|", ""));
        if (found < 0) throw new Error(`no "${at}" in #cap`);
        let index = found + at.indexOf("|");
        const walker = document.createTreeWalker(cap, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          if (index < n.data.length) {
            const one = document.createRange();
            one.setStart(n, index);
            one.setEnd(n, index + 1);
            return one.getBoundingClientRect();
          }
          index -= n.data.length;
        }
        throw new Error(`"${at}" is not in a text node of #cap`);
      };
      const middle = (at: string): number => {
        const box = glyph(at);
        return box.left + scrollX + box.width / 2;
      };
      const rows = h.debug.captureRect("#cap");
      const region = { ...rows, x: middle(from), width: middle(to) - middle(from) };
      const { runs, sources } = await h.debug.collectTextRunsDetailed(document, region, { wholeWords: true });
      const range = document.createRange();
      range.selectNodeContents(cap);
      const fragment = h.cloneVisibleRange(range, sources, runs);
      const tops = lines.map((at) => Math.round(glyph(at).top));
      const distinct = [...new Set(tops)].sort((a, b) => a - b);
      return {
        html: h.fragmentToCleanHtml(h.toSNodes(fragment), {
          baseURL: document.baseURI,
          pageURL: location.href,
        }),
        plain: h.runsToPlainText(runs),
        lines: tops.map((t) => distinct.indexOf(t)),
        origin: location.origin,
      };
    },
    { html, from, to, lines },
  );
}

/** A paragraph of 20 px monospace text, #cap, `ch` letters wide. */
const para = (inner: string, ch: number): string =>
  `<p id="cap" style="width:${ch}ch;font:20px/1.5 monospace;margin:20px">${inner}</p>`;

/** Three lines the column tests count on: "alpha beta gamma", "delta … epsilon", "zeta eta theta". */
const THREE_LINES = ["|alpha", "gamm|a", "|delta", "epsilo|n", "|zeta"];

test("copy text of a column: the words left out between two lines leave one space in the HTML", async ({
  page,
}) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  // The column runs through "beta" and, a line below, "epsilon"; "eta theta" is the third line's part.
  const column = (inner: string) => copyColumn(page, para(inner, 17.5), "b|eta", "bet|a", THREE_LINES);

  // A text node none of whose words are taken: without the space the paste reads "betaepsilon".
  const between = await column("alpha <b>beta</b> gamma delta <i>epsilon</i> zeta eta theta");
  expect(between.lines).toEqual([0, 0, 1, 1, 2]);
  expect(between).toMatchObject({
    html: "<b>beta</b> <i>epsilon</i> eta theta",
    plain: "beta\nepsilon\neta theta",
  });
  // The words left out are the end of the text node the first word is in.
  expect(await column("alpha beta gamma delta <i>epsilon</i> zeta eta theta")).toMatchObject({
    html: "beta <i>epsilon</i> eta theta",
    plain: "beta\nepsilon\neta theta",
  });
  // Left out in a link and after it: the space stands between the elements, the link is gone.
  expect(
    await column('alpha <b>beta</b><a href="/x"> gamma delta</a> a <i>epsilon</i> zeta eta theta'),
  ).toMatchObject({ html: "<b>beta</b> <i>epsilon</i> eta theta", plain: "beta\nepsilon\neta theta" });
  // The second word's characters begin with the space before it: that one is enough.
  expect(await column("alpha <b>beta</b> gamma delta a epsilon zeta <i>eta</i> theta")).toMatchObject({
    html: "<b>beta</b> epsilon <i>eta</i> theta",
    plain: "beta\nepsilon\neta theta",
  });
  // White space of the page's own stands on both sides of what is left out: no third space.
  expect(await column("alpha <b>beta</b> <u>gamma delta</u> <i>epsilon</i> zeta eta theta")).toMatchObject({
    html: "<b>beta</b>  <i>epsilon</i> eta theta",
    plain: "beta\nepsilon\neta theta",
  });

  const links = await copyColumn(
    page,
    para('Lorem <a href="/a">ipsum</a> dolor sit amet, <a href="/b">consectetur</a> adipiscing', 23),
    "i|psum",
    "ipsu|m",
    ["|Lorem", "si|t", "|amet", "consectetu|r", "|adipiscing"],
  );
  expect(links.lines).toEqual([0, 0, 1, 1, 2]);
  expect(links).toMatchObject({
    html: `<a href="${links.origin}/a">ipsum</a> <a href="${links.origin}/b">consectetur</a> adipiscing`,
    plain: "ipsum\nconsectetur\nadipiscing",
  });
});

test("copy text of a column: preserved text keeps its lines in the HTML", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const pre = (inner: string): string =>
    `<div id="cap" style="margin:20px"><pre style="font:20px/1.5 monospace;margin:0">${inner}</pre></div>`;

  // One text node: what is left out between two lines' words holds their line break.
  expect(await copyColumn(page, pre("if (x) {\n    foo bar\n    baz qux\n}"), "b|ar", "ba|r")).toMatchObject({
    html: "<pre>bar\nqux</pre>",
    plain: "bar\nqux",
  });
  // The line break stands in a text node none of whose characters are taken.
  expect(
    await copyColumn(
      page,
      pre("<span>ab</span> = 1;\n<span>cd</span> = 2;\n<span>ef</span> = 3;"),
      "|ab",
      "a|b",
    ),
  ).toMatchObject({ html: "<pre>ab\ncd\nef</pre>", plain: "ab\ncd\nef" });
  expect(await copyColumn(page, pre("ab = 1;\n\ncd = 2;\nef = 3;"), "|ab", "a|b")).toMatchObject({
    html: "<pre>ab\n\ncd\nef</pre>",
    plain: "ab\n\ncd\nef",
  });
});

test("copy text: text left out within a line, text that is not laid out and another block part no words", async ({
  page,
}) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const line = (inner: string) => copyColumn(page, para(inner, 40), "|see", "no|w");

  expect(await line('see foo<span style="display:none">x</span>bar now')).toMatchObject({
    html: "see foobar now",
    plain: "see foobar now",
  });
  // Hidden but laid out: the plain text has one word there, so the HTML has one.
  expect(await line('see foo<span style="visibility:hidden">x</span>bar now')).toMatchObject({
    html: "see foobar now",
    plain: "see foobar now",
  });

  // A word the page breaks in two lines, with text that is not laid out at the break.
  const broken = await copyColumn(
    page,
    para('foo<u style="display:none">x</u>bar', 3.5).replace(
      "margin:20px",
      "margin:20px;word-break:break-all",
    ),
    "|foo",
    "fo|o",
    ["|foo", "|bar"],
  );
  expect(broken.lines).toEqual([0, 1]);
  expect(broken).toMatchObject({ html: "foobar", plain: "foo\nbar" });

  // The paragraph's left-out end leaves no space in it or in the block after it.
  const blocks = await copyColumn(
    page,
    '<div id="cap" style="font:20px/1.5 monospace;margin:20px"><p style="width:17.5ch">alpha beta gamma delta</p>' +
      '<pre style="font:inherit;margin:0">abcdefgh ij\nkl</pre></div>',
    "b|eta",
    "bet|a",
    ["|alpha", "gamm|a", "|delta"],
  );
  expect(blocks.lines).toEqual([0, 0, 1]);
  expect(blocks).toMatchObject({ html: "<p>beta</p><pre>abcdefgh ij</pre>", plain: "beta\n\nabcdefgh ij" });
});

test("copy text: a text node of 80 000 lines is cut down within two seconds", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const got = await page.evaluate(() => {
    const lines = 80_000;
    document.body.innerHTML = '<p id="cap"></p>';
    const cap = document.getElementById("cap") as HTMLElement;
    const node = document.createTextNode("ab cd ".repeat(lines));
    cap.append(node);
    // The runs a column through the first word of each line gives; the collector is not the subject.
    const clip = { x: 0, y: 0, width: 1, height: 1 };
    const sources = Array.from({ length: lines }, (_, i) => ({ node, start: 6 * i, end: 6 * i + 2, clip }));
    const runs = sources.map((_, line) => ({ block: 0, line }));
    const range = document.createRange();
    range.selectNodeContents(cap);
    const t0 = performance.now();
    const text = window.__snapii.cloneVisibleRange(range, sources, runs).textContent ?? "";
    return { ms: performance.now() - t0, length: text.length, start: text.slice(0, 9) };
  });
  expect(got).toMatchObject({ length: 3 * 80_000 - 1, start: "ab ab ab " });
  // 140–210 ms on Chromium; with a new list of the node's runs for each run 40 000 lines took 3 s
  // and these 80 000 took 15 s.
  expect(got.ms).toBeLessThan(2000);
});

test("copy text: blank lines in preserved text stay, one empty line each", async ({ page }) => {
  await page.goto("/fixtures/pre.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const plain = await page.evaluate(async () => {
    const h = window.__snapii;
    const { runs } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#blanks"));
    return h.runsToPlainText(runs);
  });
  expect(plain).toBe("a\n\nb\n\n\ncd\n\ne\n\nf\n\ng\n\np\n\nq");
});

test("copy text: newlines outside the line flow add no blank line; an indented pre-line keeps its own", async ({
  page,
}) => {
  await page.goto("/fixtures/pre.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const plain = await page.evaluate(async () => {
    const h = window.__snapii;
    const { runs } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#notblank"));
    return h.runsToPlainText(runs);
  });
  expect(plain).toBe("h\ni\nj\nk\n\nl\n\nm\n\nn\n   \no");
});

test("copy text: inline math and an old-flexbox inline box stay in their line", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const plain = await page.evaluate(async () => {
    document.body.innerHTML =
      '<p id="cap" style="width:400px">a <math><mi>x</mi><mo>+</mo><mn>1</mn></math> b <span style="display:-webkit-inline-box">c</span> d</p>';
    const h = window.__snapii;
    const { runs } = await h.debug.collectTextRunsDetailed(document, h.debug.captureRect("#cap"));
    return h.runsToPlainText(runs);
  });
  expect(plain).toBe("a x+1 b c d");
});

test("writeClipboard: content clipboard first, background as fallback, rejects only if both fail", async ({
  page,
}) => {
  await load(page);
  const res = await page.evaluate(async () => {
    const h = window.__snapii;
    const data = { plain: "p", html: "<b>h</b>" };
    type Log = string[];
    const run = async (clipboard: "ok" | "reject" | "none", background: "ok" | "reject" | "silent") => {
      const log: Log = [];
      const deps = {
        clipboard:
          clipboard === "none"
            ? undefined
            : {
                write: async (items: ClipboardItem[]) => {
                  log.push(`write:${items.length}`);
                  if (clipboard === "reject") throw new Error("NotAllowedError");
                },
              },
        makeItem: (d: { plain: string; html: string }) => {
          log.push(`item:${d.plain}|${d.html}`);
          return {} as ClipboardItem;
        },
        sendMessage: async (m: unknown) => {
          log.push(`send:${JSON.stringify(m)}`);
          if (background === "reject") throw new Error("no clipboard");
          return background === "ok" ? true : undefined;
        },
      };
      try {
        await h.writeClipboard(data, deps);
        return { ok: true, log };
      } catch (e) {
        return { ok: false, log, error: (e as Error).message };
      }
    };
    return {
      direct: await run("ok", "ok"),
      missing: await run("none", "ok"),
      rejected: await run("reject", "ok"),
      both: await run("reject", "reject"),
      unanswered: await run("none", "silent"),
    };
  });
  const send = `send:${JSON.stringify({ type: "copy", plain: "p", html: "<b>h</b>" })}`;
  expect(res.direct).toEqual({ ok: true, log: ["item:p|<b>h</b>", "write:1"] });
  expect(res.missing).toEqual({ ok: true, log: [send] });
  expect(res.rejected).toEqual({ ok: true, log: ["item:p|<b>h</b>", "write:1", send] });
  expect(res.both.ok).toBe(false);
  expect(res.both.error).toContain("NotAllowedError");
  expect(res.both.error).toContain("no clipboard");
  expect(res.unanswered.ok).toBe(false);
});
