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
    const fragment = h.cloneVisibleRange(range, new Set(sources.map((s) => s.node)));
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
