// SPDX-License-Identifier: GPL-3.0-or-later
// Copy link's URL opened the way a reader opens it: by the browser's own
// text-fragment search, not the polyfill's (fragment.spec.ts). The two do not
// agree on what a block is: the polyfill goes by tag name, the browsers by
// layout, and an exact match never crosses a block boundary there.
import { expect, type Page, test } from "@playwright/test";

/** The fragment URL for the contents of `selector`, as a pick of that element gets it. */
function linkFor(page: Page, selector: string): Promise<{ url: string | null; status: string }> {
  return page.evaluate((selector) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector) as Element);
    return window.__snapii.textFragmentURL(range, location.href);
  }, selector);
}

/** Whether `selector` is inside the viewport of a new tab that opened `url`. */
async function opensAt(page: Page, url: string, selector: string): Promise<boolean> {
  const opened = await page.context().newPage();
  try {
    await opened.goto(url);
    // The scroll to the match happens once the page has loaded.
    await opened.waitForTimeout(500);
    return await opened.evaluate((selector) => {
      const r = (document.querySelector(selector) as Element).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    }, selector);
  } finally {
    await opened.close();
  }
}

for (const teaser of ["#t1", "#t2"]) {
  test(`a teaser of block-level spans (${teaser}): the copied link opens at the teaser`, async ({ page }) => {
    await page.goto("/fixtures/fragment-block-spans.html");
    await page.addScriptTag({ path: "dist-test/harness.js" });
    const link = await linkFor(page, `${teaser} a`);
    expect(link.status).toBe("SUCCESS");
    expect(await opensAt(page, link.url as string, teaser)).toBe(true);
  });
}

test("a kicker shared by two teasers: the link still opens at the picked one, or is a plain page link", async ({
  page,
}) => {
  await page.goto("/fixtures/fragment-block-spans.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  const link = await linkFor(page, "#t4 a");
  // Never a text link the browser cannot find.
  if (link.url === null) expect(link.status).toBe("AMBIGUOUS");
  else expect(await opensAt(page, link.url, "#t4")).toBe(true);
});
