// SPDX-License-Identifier: GPL-3.0-or-later
// Text-fragment URLs round-trip: generate one for a passage, open the URL in
// a fresh page and let the polyfill's re-finder (what a browser without
// native support does on load) mark it. The marks must cover exactly the
// passage, in the element it was taken from.
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * How the passage is selected: the element's contents (element mode), the
 * element itself (edges outside it), or a substring of its text (drag mode).
 */
interface Pick {
  id: string;
  passage?: string;
  node?: boolean;
}

async function load(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.addScriptTag({ path: "dist-test/harness.js" });
}

function generate(page: Page, pick: Pick) {
  return page.evaluate(({ id, passage, node }) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    const range = document.createRange();
    if (node) {
      range.selectNode(el);
    } else if (passage === undefined) {
      // Element mode.
      range.selectNodeContents(el);
    } else {
      // Drag mode: first run start to last run end, here one text node.
      const node = el.firstChild as Text;
      const at = node.data.indexOf(passage);
      if (at < 0) throw new Error(`passage not in #${id}`);
      range.setStart(node, at);
      range.setEnd(node, at + passage.length);
    }
    const before = range.toString();
    const result = window.__snapii.textFragmentURL(range, location.href);
    return { ...result, pageURL: location.href, rangeKept: range.toString() === before };
  }, pick);
}

/** Opens url in a new page and returns what the re-finder marked, and where. */
async function refind(browser: Browser, url: string, id: string) {
  const page = await browser.newPage();
  try {
    await load(page, url);
    // From the generated URL, whether or not the browser exposes the directive in location.hash.
    const hash = url.slice(url.indexOf("#"));
    return await page.evaluate(
      ({ hash, id }) => {
        const u = window.__snapii.fragmentUtils;
        const marks = u.processFragmentDirectives(u.parseFragmentDirectives(u.getFragmentDirectives(hash)))
          .text?.[0];
        const target = document.getElementById(id);
        return {
          text: (marks ?? []).map((m) => m.textContent).join(""),
          marks: marks?.length ?? 0,
          inTarget: !!marks?.length && marks.every((m) => target?.contains(m)),
        };
      },
      { hash, id },
    );
  } finally {
    await page.close();
  }
}

const cases: { name: string; file: string; pick: Pick; text: string }[] = [
  {
    name: "unique passage, element mode",
    file: "fragment-unique.html",
    pick: { id: "target" },
    text: "Sphinx of black quartz, judge my vow - and mind the comma.",
  },
  {
    // Edges outside the element: the generator alone ends the match in the
    // next paragraph.
    name: "unique passage, the element itself",
    file: "fragment-unique.html",
    pick: { id: "target", node: true },
    text: "Sphinx of black quartz, judge my vow - and mind the comma.",
  },
  {
    // Only the first block is linked: the generator's cost grows with every
    // block in the range (fragment.ts firstBlock).
    name: "several paragraphs, element mode: the first one",
    file: "fragment-unique.html",
    pick: { id: "cap" },
    text: "An opening paragraph with ordinary words.",
  },
  {
    // A nested block ends the first block as much as the end of its own.
    name: "text in front of a nested block, element mode: up to the nested block",
    file: "fragment-unique.html",
    pick: { id: "mixed" },
    text: "Loose text in front of a nested paragraph",
  },
  {
    // The first paragraph comes again further down, neighbours and all: no
    // context sets it apart, the range's last paragraph does.
    name: "a first paragraph repeated with its context: the whole range",
    file: "fragment-fallback.html",
    pick: { id: "cap" },
    text: "Shared headline Shared blurb A closing line that occurs once.",
  },
  {
    name: "ambiguous passage, drag mode, second occurrence",
    file: "fragment-ambiguous.html",
    pick: { id: "second", passage: "brown fox jumps over the" },
    text: "brown fox jumps over the",
  },
];

for (const c of cases) {
  test(c.name, async ({ page, browser }) => {
    await load(page, `/fixtures/${c.file}`);
    const gen = await generate(page, c.pick);
    expect(gen.status).toBe("SUCCESS");
    expect(gen.rangeKept, "caller's range unchanged").toBe(true);
    expect(gen.url).not.toBeNull();
    const url = gen.url as string;
    expect(url.startsWith(`${gen.pageURL}#:~:text=`), url).toBe(true);

    const found = await refind(browser, url, c.pick.id);
    // Whitespace between blocks may or may not be marked; the words must match.
    const words = (t: string) => t.replace(/\s+/g, "");
    expect(words(found.text), url).toBe(words(c.text));
    expect(found.inTarget, `${url} marks the passage in #${c.pick.id}`).toBe(true);
  });
}

// A news front page in small: from teaser 10's headline to the end of teaser
// 12, which ends in a blurb and an ad label like every teaser. The whole
// range has no unique end: the generator widens it word by word, each step
// checked against all 600 teasers (measured on Playwright's Firefox: 525-551
// ms). Its first block, the headline, is unique at once (41 ms).
test("a range over repeated teasers: links the first headline, fast", async ({ page, browser }) => {
  await load(page, "/fixtures/fragment-teasers.html");
  const gen = await page.evaluate(() => {
    const head = document.querySelector("#t10 h2")?.firstChild;
    const ad = document.querySelector("#t12 div")?.firstChild;
    if (!(head instanceof Text) || !(ad instanceof Text)) throw new Error("no teaser text");
    const range = document.createRange();
    // Drag mode: the first run starts at the headline's first word.
    range.setStart(head, head.data.indexOf("Teaser"));
    range.setEnd(ad, ad.length);
    const t0 = performance.now();
    const result = window.__snapii.textFragmentURL(range, location.href);
    return { ...result, ms: performance.now() - t0, pageURL: location.href };
  });
  expect(gen.status).toBe("SUCCESS");
  expect(gen.ms).toBeLessThan(250);
  // No blanks from around the headline at the edges (no %20 at either end).
  expect(gen.url).toBe(`${gen.pageURL}#:~:text=teaser%20number%2010%20of%20the%20front%20page`);
  const found = await refind(browser, gen.url as string, "t10");
  expect(found.text).toBe("Teaser number 10 of the front page");
  expect(found.inTarget).toBe(true);
});

// Every uniqueness check of the generator walks the whole document once per
// occurrence of its candidate, without looking at the clock: on this page
// one check outlasts the budget several times over (Chromium 141: 8.3-8.5 s
// in all for a 2 s budget, 2.2 s with the guard), long enough for Firefox to
// flag snapii as slowing it down. The budget has to hold within a check too.
test("a range over a large page of recurring text: TIMEOUT within the budget", async ({ page }) => {
  await load(page, "/fixtures/fragment-flood.html");
  const gen = await page.evaluate(() => {
    const more = document.querySelector("#t4000 a")?.firstChild;
    const blurb = document.querySelector("#t4003 p")?.firstChild;
    if (!(more instanceof Text) || !(blurb instanceof Text)) throw new Error("no teaser text");
    const range = document.createRange();
    range.setStart(more, 0);
    range.setEnd(blurb, 10);
    const t0 = performance.now();
    const result = window.__snapii.textFragmentURL(range, location.href);
    return { ...result, ms: performance.now() - t0, budget: window.__snapii.GENERATION_TIMEOUT_MS };
  });
  expect(gen).toMatchObject({ url: null, status: "TIMEOUT" });
  expect(gen.ms).toBeLessThan(gen.budget + 500);
});

test("a drag that ends inside the first block: the link ends there too", async ({ page, browser }) => {
  await load(page, "/fixtures/fragment-unique.html");
  const gen = await page.evaluate(() => {
    const p = document.getElementById("inline");
    const bold = p?.querySelector("b")?.firstChild;
    if (!(p?.firstChild instanceof Text) || !(bold instanceof Text)) throw new Error("no #inline text");
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(bold, bold.length);
    return window.__snapii.textFragmentURL(range, location.href);
  });
  expect(gen.status).toBe("SUCCESS");
  const found = await refind(browser, gen.url as string, "inline");
  expect(found.text, gen.url ?? "").toBe("A passage with bold words");
});

// Handed to the generator, this range freezes the page: its block-ancestor
// search climbs to the shadow root and loops there forever. Without the
// guard, this test fails on its own short timeout (the evaluate never
// returns); Playwright then tears down the worker with its Firefox, and the
// rest of the suite runs on a fresh one.
test("text in a shadow tree with no block ancestor: INVALID_SELECTION, without running the generator", async ({
  page,
}) => {
  test.setTimeout(10_000);
  await load(page, "/fixtures/shadow-noblock.html");
  const res = await page.evaluate(() => {
    const a = document.getElementById("card")?.shadowRoot?.getElementById("more");
    if (!a) throw new Error("no #more in #card's shadow root");
    const range = document.createRange();
    range.selectNodeContents(a);
    const t0 = performance.now();
    const result = window.__snapii.textFragmentURL(range, location.href);
    return { ...result, ms: performance.now() - t0 };
  });
  expect(res).toMatchObject({ url: null, status: "INVALID_SELECTION" });
  expect(res.ms).toBeLessThan(500);
});

// Same loop under an XHTML root that is not <html>: nothing above the text
// is a block element. Red without the root check = this test's timeout.
test("an XHTML document whose root is not <html>: INVALID_SELECTION, without running the generator", async ({
  page,
}) => {
  test.setTimeout(10_000);
  // addScriptTag needs a <head>; the document loads the harness itself.
  await page.route("**/span-root.xhtml", (route) =>
    route.fulfill({
      contentType: "application/xhtml+xml",
      body: '<span xmlns="http://www.w3.org/1999/xhtml">Text under a span root.<script src="/harness.js"/></span>',
    }),
  );
  await page.route("**/harness.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: "dist-test/harness.js" }),
  );
  await page.goto("/fixtures/span-root.xhtml");
  await page.waitForFunction(() => "__snapii" in window);
  const res = await page.evaluate(() => {
    // Guard: an XHTML root, just not <html>.
    const root = document.documentElement;
    if (root.namespaceURI !== "http://www.w3.org/1999/xhtml" || root.localName !== "span") {
      throw new Error(`unexpected root ${root.namespaceURI} ${root.localName}`);
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    return window.__snapii.textFragmentURL(range, location.href);
  });
  expect(res).toEqual({ url: null, status: "INVALID_SELECTION" });
});

test("a collapsed range yields no URL and INVALID_SELECTION", async ({ page }) => {
  await load(page, "/fixtures/fragment-unique.html");
  const res = await page.evaluate(() => {
    const range = document.createRange();
    range.setStart(document.getElementById("target")?.firstChild as Text, 3);
    return window.__snapii.textFragmentURL(range, location.href);
  });
  expect(res).toEqual({ url: null, status: "INVALID_SELECTION" });
});
