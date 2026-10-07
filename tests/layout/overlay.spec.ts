// SPDX-License-Identifier: GPL-3.0-or-later
// Selection overlay in a real Firefox page: hover pick, ancestor walk, drag
// threshold, toolbar actions, page isolation, CSP-proof styling.
import { expect, type Page, test } from "@playwright/test";
import type { OverlayHandle, startOverlay } from "../../src/content/overlay/overlay.ts";
import type { showToast } from "../../src/content/overlay/toolbar.ts";
import type { DocRect } from "../../src/shared/types.ts";

interface Act {
  action: string;
  mode: string;
  rect: DocRect;
  id: string | null;
}
type TestWindow = Window & {
  __roots: Record<string, ShadowRoot>;
  __actions: Act[];
  __cancelled: number;
  __handle: OverlayHandle;
  __pageEvents: number;
};

// Fixture geometry (document px), see tests/fixtures/overlay.html.
const CARD = { x: 100, y: 100, width: 600, height: 300 };
const PARA = { x: 150, y: 220, width: 400, height: 80 };
const ART = { x: 800, y: 100, width: 400, height: 400 };
const GAP = 8; // TOOLBAR_GAP

async function load(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  // The overlay's shadow root is closed; capture it at creation so the spec
  // can inspect what is drawn. Test-only: a content script's attachShadow
  // is not reachable from page scripts.
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__roots = {};
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      const root = orig.call(this, init);
      w.__roots[this.localName] = root;
      return root;
    };
  });
}

async function start(page: Page, url = "/fixtures/overlay.html"): Promise<void> {
  await load(page, url);
  await begin(page);
}

function begin(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__actions = [];
    w.__cancelled = 0;
    const start = w.__snapii.startOverlay as typeof startOverlay;
    w.__handle = start({
      onAction(action, s) {
        w.__actions.push({ action, mode: s.mode, rect: s.rect, id: s.element?.id ?? null });
      },
      onCancel() {
        w.__cancelled++;
      },
    });
  });
}

/** The drawn highlight/selection box in client px, or null when hidden. */
function box(page: Page): Promise<DocRect | null> {
  return page.evaluate(() => {
    const el = (window as unknown as TestWindow).__roots["snapii-overlay"]?.querySelector(".box");
    if (!(el instanceof HTMLElement) || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function actions(page: Page): Promise<Act[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__actions);
}

function scrollTo(page: Page, y: number): Promise<void> {
  return page.evaluate((top) => {
    window.scrollTo(0, top);
  }, y);
}

async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

test("host: closed shadow root on <html>, fixed, topmost", async ({ page }) => {
  await start(page);
  const host = await page.evaluate(() => {
    const h = document.querySelector("snapii-overlay") as HTMLElement;
    const cs = getComputedStyle(h);
    return {
      parent: h.parentElement?.localName,
      open: h.shadowRoot !== null,
      position: cs.position,
      z: cs.zIndex,
      size: [h.offsetWidth, h.offsetHeight],
    };
  });
  expect(host).toEqual({
    parent: "html",
    open: false,
    position: "fixed",
    z: "2147483647",
    size: [1280, 720],
  });
});

test("hover highlights the picked element (heading skipped, article preferred)", async ({ page }) => {
  await start(page);
  await page.mouse.move(200, 250); // on #para
  await expect.poll(() => box(page)).toEqual(PARA);
  await page.mouse.move(200, 140); // on #title (H2) -> enclosing #card
  await expect.poll(() => box(page)).toEqual(CARD);
  await page.mouse.move(850, 140); // on #artp inside <article>
  await expect.poll(() => box(page)).toEqual(ART);
  await page.mouse.move(300, 600); // only the 3000 px spacer: nothing qualifies
  await expect.poll(() => box(page)).toBeNull();
});

test("pointer moves over the same element leave the hint and the Save button untouched", async ({ page }) => {
  await start(page);
  await page.mouse.move(200, 250); // on #para
  await expect.poll(() => box(page)).toEqual(PARA);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow & { __mutations: string[] };
    const root = w.__roots["snapii-overlay"] as ShadowRoot;
    w.__mutations = [];
    new MutationObserver((records) => {
      for (const r of records)
        w.__mutations.push(`${(r.target as Element).className || r.target.nodeName} ${r.type}`);
    }).observe(root.querySelector(".hint") as Node, {
      childList: true,
      characterData: true,
      attributes: true,
    });
    new MutationObserver((records) => {
      for (const r of records) w.__mutations.push(`save ${r.type} ${r.attributeName}`);
    }).observe(root.querySelector('[data-action="save"]') as Node, { attributes: true });
  });
  for (const x of [210, 220, 230, 240, 250]) await page.mouse.move(x, 250);
  // Two frames: the last move's hover update has run.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(await box(page)).toEqual(PARA);
  expect(await page.evaluate(() => (window as unknown as { __mutations: string[] }).__mutations)).toEqual([]);
});

test("ArrowUp gives the parent, ArrowDown goes back; Enter selects then saves", async ({ page }) => {
  await start(page);
  await page.mouse.move(200, 250);
  await expect.poll(() => box(page)).toEqual(PARA);
  await page.keyboard.press("ArrowUp");
  expect(await box(page)).toEqual(CARD);
  await page.keyboard.press("ArrowUp");
  expect(await box(page)).toEqual({ x: 0, y: 0, width: 1280, height: 3000 }); // <body>
  await page.keyboard.press("ArrowDown");
  expect(await box(page)).toEqual(CARD);
  // Small pointer jitter over the same element keeps the walked-up highlight.
  await page.mouse.move(202, 251);
  await page.waitForTimeout(50);
  expect(await box(page)).toEqual(CARD);
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([]);
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([{ action: "save", mode: "element", rect: CARD, id: "card" }]);
});

test("a 41 px drag yields a drag selection with the document rect", async ({ page }) => {
  await start(page);
  await page.mouse.move(300, 600);
  await page.mouse.down();
  await page.mouse.move(309, 640); // hypot(9, 40) = 41
  await page.mouse.up();
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([
    { action: "save", mode: "drag", rect: { x: 300, y: 600, width: 9, height: 40 }, id: null },
  ]);
});

test("the drag rect is in document px when scrolled", async ({ page }) => {
  await start(page);
  await scrollTo(page, 1000);
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(400, 300);
  await expect.poll(() => box(page)).toEqual({ x: 300, y: 200, width: 100, height: 100 });
  await page.mouse.up();
  await page.keyboard.press("Enter");
  expect((await actions(page))[0]?.rect).toEqual({ x: 300, y: 1200, width: 100, height: 100 });
});

test("wheel-scrolling during a drag extends the rect", async ({ page }) => {
  await start(page);
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(309, 340);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  await expect.poll(() => box(page)).toEqual({ x: 300, y: 100, width: 9, height: 240 });
  await page.mouse.up();
  await page.keyboard.press("Enter");
  expect((await actions(page))[0]?.rect).toEqual({ x: 300, y: 300, width: 9, height: 240 });
});

test("a selected fixed element keeps its box on screen while the page scrolls, and is saved where it is", async ({
  page,
}) => {
  await start(page);
  const vh = page.viewportSize()?.height ?? 0;
  const fixed = { x: 0, y: vh - 50, width: 200, height: 50 };
  await clickAt(page, 100, vh - 25);
  await expect.poll(() => box(page)).toEqual(fixed);
  // The box keeps its client position until the overlay handles the scroll
  // event, which Chromium fires a frame after scrollTo: wait for it, or Enter
  // would save the rect of before.
  const scrolled = page.evaluate(
    () => new Promise<void>((done) => addEventListener("scroll", () => done(), { once: true })),
  );
  await scrollTo(page, 500);
  await scrolled;
  await expect.poll(() => box(page)).toEqual(fixed);
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([
    { action: "save", mode: "element", rect: { ...fixed, y: fixed.y + 500 }, id: "fixed" },
  ]);
});

test("a 39 px move stays a click and selects the hovered element", async ({ page }) => {
  await start(page);
  await page.mouse.move(200, 250);
  await expect.poll(() => box(page)).toEqual(PARA);
  await page.mouse.down();
  await page.mouse.move(215, 286); // hypot(15, 36) = 39
  await page.mouse.up();
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([{ action: "save", mode: "element", rect: PARA, id: "para" }]);
});

// The press clears the selection; with nothing pickable under it, the
// previously hovered element must not come back as the selection.
test("a click on nothing pickable clears the selection: hover state, no toolbar", async ({ page }) => {
  await start(page);
  await clickAt(page, 200, 250);
  await expect.poll(() => box(page)).toEqual(PARA);
  const toolbarHidden = () =>
    page.evaluate(() => {
      const tb = (window as unknown as TestWindow).__roots["snapii-overlay"]?.querySelector(".toolbar");
      if (!(tb instanceof HTMLElement)) throw new Error("no toolbar");
      return tb.hidden;
    });
  expect(await toolbarHidden()).toBe(false);
  await clickAt(page, 5, 5);
  expect(await toolbarHidden()).toBe(true);
  expect(await box(page)).toBeNull();
  // Enter in hover state with nothing hovered selects nothing.
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([]);
});

test("Escape removes the host and calls onCancel", async ({ page }) => {
  await start(page);
  await page.mouse.move(200, 250);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.querySelector("snapii-overlay"))).toBeNull();
  expect(await page.evaluate(() => (window as unknown as TestWindow).__cancelled)).toBe(1);
});

test("toolbar: below the selection; Save SVG and Copy text report the selection (scrolled)", async ({
  page,
}) => {
  await start(page);
  await scrollTo(page, 150);
  await clickAt(page, 200, 100); // #para at client y 70..150
  const buttons = await page.evaluate(() => {
    const root = (window as unknown as TestWindow).__roots["snapii-overlay"] as ShadowRoot;
    const rectOf = (sel: string): DocRect => {
      const r = (root.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      toolbar: rectOf(".toolbar"),
      save: rectOf('[data-action="save"]'),
      text: rectOf('[data-action="copy-text"]'),
      labels: [...root.querySelectorAll(".toolbar button")].map((b) => b.textContent),
    };
  });
  expect(buttons.labels).toEqual(["Save SVG", "Copy text", "Copy element link", "Copy page link", "Cancel"]);
  expect(buttons.toolbar.y).toBe(PARA.y - 150 + PARA.height + GAP);
  // Layout rounding differs per platform (550.0000152587891 on Linux CI).
  expect(buttons.toolbar.x + buttons.toolbar.width).toBeCloseTo(PARA.x + PARA.width, 2);
  expect(await actions(page)).toEqual([]);
  await clickAt(page, buttons.save.x + 5, buttons.save.y + 5);
  await clickAt(page, buttons.text.x + 5, buttons.text.y + 5);
  expect(await actions(page)).toEqual([
    { action: "save", mode: "element", rect: PARA, id: "para" },
    { action: "copy-text", mode: "element", rect: PARA, id: "para" },
  ]);
});

test("Cancel button removes the host; setBusy blocks actions", async ({ page }) => {
  await start(page);
  await clickAt(page, 200, 250);
  const cancel = await page.evaluate(() => {
    const root = (window as unknown as TestWindow).__roots["snapii-overlay"] as ShadowRoot;
    const r = (root.querySelector('[data-action="cancel"]') as HTMLElement).getBoundingClientRect();
    (window as unknown as TestWindow).__handle.setBusy(true);
    return { x: r.x + 5, y: r.y + 5 };
  });
  await page.keyboard.press("Enter");
  await clickAt(page, cancel.x, cancel.y);
  expect(await actions(page)).toEqual([]);
  expect(await page.evaluate(() => document.querySelector("snapii-overlay") !== null)).toBe(true);
  await page.evaluate(() => (window as unknown as TestWindow).__handle.setBusy(false));
  await clickAt(page, cancel.x, cancel.y);
  expect(await page.evaluate(() => document.querySelector("snapii-overlay"))).toBeNull();
  expect(await page.evaluate(() => (window as unknown as TestWindow).__cancelled)).toBe(1);
});

test("the page sees no mouse or key events and no default actions", async ({ page }) => {
  await load(page, "/fixtures/overlay.html");
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__pageEvents = 0;
    for (const t of ["mousedown", "mouseup", "click", "pointerdown", "keydown", "keyup"]) {
      document.addEventListener(t, () => w.__pageEvents++, true);
    }
  });
  await begin(page);
  const link = await page.evaluate(() => {
    const r = (document.getElementById("link") as HTMLElement).getBoundingClientRect();
    return { x: r.x + 3, y: r.y + r.height / 2 };
  });
  await clickAt(page, link.x, link.y);
  await page.keyboard.press("a");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__pageEvents)).toBe(0);
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("page-dispatched (untrusted) events neither select nor act; real input still does", async ({ page }) => {
  await load(page, "/fixtures/overlay.html");
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__pageEvents = 0;
    for (const t of ["mousemove", "mousedown", "mouseup", "click", "keydown"]) {
      document.addEventListener(t, () => w.__pageEvents++, true);
    }
  });
  await begin(page);
  /** What a hostile page can do: dispatch its own events at the window. */
  const forge = (events: Array<[string, number, number] | [string, string]>) =>
    page.evaluate(async (list) => {
      for (const e of list) {
        const ev =
          e.length === 3
            ? new MouseEvent(e[0], {
                bubbles: true,
                cancelable: true,
                clientX: e[1],
                clientY: e[2],
                button: 0,
              })
            : new KeyboardEvent(e[0], { bubbles: true, cancelable: true, key: e[1] });
        document.body.dispatchEvent(ev);
      }
      // Lets a hover update scheduled by a forged mousemove run.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, events);

  // Hover, Enter-select, Enter-save: nothing happens.
  await forge([
    ["mousemove", 200, 250],
    ["keydown", "Enter"],
    ["keydown", "Enter"],
  ]);
  expect(await box(page)).toBeNull();
  // A forged drag selects nothing either.
  await forge([
    ["mousedown", 300, 600],
    ["mousemove", 400, 700],
    ["mouseup", 400, 700],
    ["keydown", "Enter"],
  ]);
  expect(await box(page)).toBeNull();
  expect(await actions(page)).toEqual([]);

  // A real selection, then forged clicks on Save SVG, Enter, ArrowUp, Escape.
  await clickAt(page, 200, 250);
  expect(await box(page)).toEqual(PARA);
  const save = await page.evaluate(() => {
    const root = (window as unknown as TestWindow).__roots["snapii-overlay"] as ShadowRoot;
    const r = (root.querySelector('[data-action="save"]') as HTMLElement).getBoundingClientRect();
    return { x: r.x + 5, y: r.y + 5 };
  });
  await forge([
    ["mousedown", save.x, save.y],
    ["mouseup", save.x, save.y],
    ["click", save.x, save.y],
    ["keydown", "Enter"],
    ["keydown", "ArrowUp"],
    ["keydown", "Escape"],
  ]);
  expect(await actions(page)).toEqual([]);
  expect(await box(page)).toEqual(PARA);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__cancelled)).toBe(0);
  // Still swallowed: the page saw none of the forged (or real) events.
  expect(await page.evaluate(() => (window as unknown as TestWindow).__pageEvents)).toBe(0);

  // Real input still works.
  await page.keyboard.press("Enter");
  expect(await actions(page)).toEqual([{ action: "save", mode: "element", rect: PARA, id: "para" }]);
});

test("hide() sets display:none on the host, show() restores it", async ({ page }) => {
  await start(page);
  const display = () =>
    page.evaluate(() => getComputedStyle(document.querySelector("snapii-overlay") as Element).display);
  await page.evaluate(() => (window as unknown as TestWindow).__handle.hide());
  expect(await display()).toBe("none");
  await page.evaluate(() => (window as unknown as TestWindow).__handle.show());
  expect(await display()).toBe("block");
});

test("under style-src 'none' the highlight is still styled and placed", async ({ page }) => {
  await start(page, "/fixtures/overlay-csp.html");
  // Guard: the CSP really blocks styles on this page.
  const blocked = await page.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = "#block { color: rgb(255, 0, 0) }";
    document.head.append(s);
    return getComputedStyle(document.getElementById("block") as Element).color !== "rgb(255, 0, 0)";
  });
  expect(blocked).toBe(true);
  const target = await page.evaluate(() => {
    const r = (document.getElementById("block") as Element).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.move(target.x + 20, target.y + target.height / 2);
  await expect.poll(() => box(page)).toEqual(target);
  const style = await page.evaluate(() => {
    const el = (window as unknown as TestWindow).__roots["snapii-overlay"]?.querySelector(".box") as Element;
    const cs = getComputedStyle(el);
    return [cs.borderTopStyle, cs.borderTopWidth, cs.borderTopColor];
  });
  expect(style).toEqual(["solid", "2px", "rgb(10, 132, 255)"]);
});

// A saved snapii .svg opened directly: an XML document, where
// document.createElement gives null-namespace elements without style or
// attachShadow. Served by route so it really is image/svg+xml.
const SVG_DOC = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <rect id="r" x="100" y="100" width="300" height="200" fill="#eef"/>
  <text x="120" y="160" font-size="24">SVG document text</text>
  <script href="/harness.js"/>
</svg>`;

test("overlay and toast start on an SVG document", async ({ page }) => {
  await page.route("**/overlay-doc.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: SVG_DOC }),
  );
  await page.route("**/harness.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: "dist-test/harness.js" }),
  );
  await page.goto("/fixtures/overlay-doc.svg");
  await page.waitForFunction(() => document.documentElement.localName === "svg" && "__snapii" in window);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__roots = {};
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      const root = orig.call(this, init);
      w.__roots[this.localName] = root;
      return root;
    };
  });
  await begin(page);
  const host = await page.evaluate(() => {
    const h = document.querySelector("snapii-overlay") as HTMLElement;
    const root = (window as unknown as TestWindow).__roots["snapii-overlay"] as ShadowRoot;
    return {
      ns: h.namespaceURI,
      position: h.style.getPropertyValue("position"),
      parts: [...root.children].map((c) => [c.namespaceURI, c.className]),
    };
  });
  expect(host).toEqual({
    ns: "http://www.w3.org/1999/xhtml",
    position: "fixed",
    parts: [
      ["http://www.w3.org/1999/xhtml", "glass"],
      ["http://www.w3.org/1999/xhtml", "box"],
      ["http://www.w3.org/1999/xhtml", "hint"],
      ["http://www.w3.org/1999/xhtml", "toolbar"],
    ],
  });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__cancelled)).toBe(1);
  expect(await page.evaluate(() => document.querySelector("snapii-overlay"))).toBeNull();

  await page.evaluate(() => (window.__snapii.showToast as typeof showToast)("Saved", 300));
  const toast = await page.evaluate(() => {
    const box = (window as unknown as TestWindow).__roots["snapii-toast"]?.querySelector(".toast");
    return [box?.namespaceURI, box?.textContent];
  });
  expect(toast).toEqual(["http://www.w3.org/1999/xhtml", "Saved"]);
  await expect.poll(() => page.evaluate(() => document.querySelector("snapii-toast"))).toBeNull();
});

test("showToast shows the message and removes itself", async ({ page }) => {
  await load(page, "/fixtures/overlay.html");
  await page.evaluate(() => (window.__snapii.showToast as typeof showToast)("Saved", 300));
  const text = await page.evaluate(
    () => (window as unknown as TestWindow).__roots["snapii-toast"]?.querySelector(".toast")?.textContent,
  );
  expect(text).toBe("Saved");
  expect(await page.evaluate(() => document.querySelectorAll("snapii-toast").length)).toBe(1);
  await expect.poll(() => page.evaluate(() => document.querySelector("snapii-toast"))).toBeNull();
});
