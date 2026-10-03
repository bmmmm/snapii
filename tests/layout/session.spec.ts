// SPDX-License-Identifier: GPL-3.0-or-later
// The content-script session with stubbed sendSave and writeClipboard: what
// the background or the clipboard would receive, and in which state the page
// is at that moment. The two exclusion checks of M2 live here: the overlay is
// out of the rendering when the capture is requested, and its toolbar text is
// never extracted. M3: the text-fragment URL in the saved model, Copy text
// and Copy link.
import { expect, type Page, test } from "@playwright/test";
import type { ClipboardData } from "../../src/content/clipboard.ts";
import type { SessionHandle, startSession } from "../../src/content/session.ts";
import { isToBackground } from "../../src/shared/messages.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type {
  CapturedMessage,
  CaptureModel,
  DocRect,
  SaveResponse,
  Settings,
} from "../../src/shared/types.ts";

interface Call {
  model: CaptureModel;
  /** Computed display of the overlay host when sendSave ran. */
  display: string | null;
  /** Page text selection ranges when sendSave ran. */
  rangeCount: number;
  /** Animation frames between the host's hide and sendSave. */
  framesSinceHide: number;
  /** Whether #para matched :hover when sendSave ran. */
  paraHover: boolean;
}
/** A reply, or "throw" for a sendSave that rejects (messaging failed). */
type Reply = SaveResponse | "throw";
type TestWindow = Window & {
  __calls: Call[];
  /** What writeClipboard was handed. */
  __clips: ClipboardData[];
  /** Makes writeClipboard reject (both clipboard paths failed). */
  __clipFail: boolean;
  /** While set, sendSave and writeClipboard wait for it (a background or clipboard that hangs). */
  __hold?: Promise<void>;
  __release?: () => void;
  /** writeClipboard calls that started, finished or not. */
  __clipStarted: number;
  __reply: Reply;
  __session: SessionHandle;
  __frames: number;
  __framesAtHide: number;
  /** Overlay hidden / shields present at the moment a test cancelled. */
  __cancelledAt?: { hidden: boolean; shields: number };
  /** One toolbar click on a sessionToggle (the content script's `start` handling). */
  __toggle?: () => void;
  /** The `onCaptured` of the last sendSave: what the background's `captured` message calls. */
  __onCaptured?: (message: CapturedMessage) => void;
  /** Page clicks on #para (the page taking input again). */
  __paraClicks: number;
};

const TOOLBAR_LABELS = ["Save SVG", "Copy text", "Copy link", "Cancel"];
const NOW = "2026-10-01T12:00:00.000Z";

/**
 * Loads the overlay fixture with the harness. Shadow roots are forced open:
 * the extractor in the content-script world reaches the overlay's closed
 * root through openOrClosedShadowRoot, which page scripts do not have, so
 * only an open root lets this page-context run see the toolbar the way the
 * extension would (and lets the spec read the toast).
 */
/** fixture: a file in tests/fixtures, or an absolute path under tests/. */
async function load(page: Page, fixture = "overlay.html"): Promise<void> {
  await page.goto(fixture.startsWith("/") ? fixture : `/fixtures/${fixture}`);
  await page.addScriptTag({ path: "dist-test/harness.js" });
  await page.evaluate(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      return orig.call(this, { ...init, mode: "open" });
    };
  });
}

async function begin(
  page: Page,
  reply: Reply,
  settings: Settings = DEFAULT_SETTINGS,
  viewportOnly = false,
): Promise<void> {
  await page.evaluate(
    ({ settings, reply, now, viewportOnly }) => {
      const w = window as unknown as TestWindow;
      w.__calls = [];
      w.__clips = [];
      w.__clipStarted = 0;
      w.__reply = reply;
      // Frame counter, and the count at the moment the host's display turns none.
      w.__frames = 0;
      w.__framesAtHide = -1;
      const tick = (): void => {
        w.__frames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new MutationObserver(() => {
        const host = document.querySelector("snapii-overlay") as HTMLElement | null;
        if (host?.style.display === "none" && w.__framesAtHide < 0) w.__framesAtHide = w.__frames;
      }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style"] });
      const start = w.__snapii.startSession as typeof startSession;
      w.__session = start({
        settings,
        viewportOnly,
        now: () => new Date(now),
        async sendSave(model, onCaptured) {
          w.__onCaptured = onCaptured;
          const host = document.querySelector("snapii-overlay");
          w.__calls.push({
            // A copy: the reply below must not be able to change what was sent.
            model: JSON.parse(JSON.stringify(model)),
            display: host ? getComputedStyle(host).display : null,
            rangeCount: getSelection()?.rangeCount ?? -1,
            framesSinceHide: w.__framesAtHide < 0 ? -1 : w.__frames - w.__framesAtHide,
            paraHover: document.getElementById("para")?.matches(":hover") ?? false,
          });
          await w.__hold;
          if (w.__reply === "throw") throw new Error("Could not establish connection");
          return w.__reply;
        },
        async writeClipboard(data) {
          w.__clipStarted++;
          await w.__hold;
          if (w.__clipFail) throw new Error("clipboard write failed");
          w.__clips.push(data);
        },
      });
    },
    { settings, reply, now: NOW, viewportOnly },
  );
}

/** Drags across the whole viewport: no room above or below, so the toolbar sits inside the selection. */
async function selectViewport(page: Page): Promise<DocRect> {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport");
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(vp.width - 4, vp.height - 4, { steps: 4 });
  await page.mouse.up();
  return { x: 4, y: 4, width: vp.width - 8, height: vp.height - 8 };
}

/** The visible toolbar's client rect, or null. */
function toolbarRect(page: Page): Promise<DocRect | null> {
  return page.evaluate(() => {
    const tb = document.querySelector("snapii-overlay")?.shadowRoot?.querySelector(".toolbar");
    if (!(tb instanceof HTMLElement) || tb.hidden) return null;
    const r = tb.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__calls);
}

function toastText(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector("snapii-toast")?.shadowRoot?.querySelector(".toast")?.textContent ?? null,
  );
}

function hostState(page: Page): Promise<{ attached: boolean; display: string | null }> {
  return page.evaluate(() => {
    const host = document.querySelector("snapii-overlay");
    return { attached: !!host?.isConnected, display: host ? getComputedStyle(host).display : null };
  });
}

/** Selects the paragraph's text the way a reader would have before starting snapii. */
function selectParagraph(page: Page): Promise<void> {
  return page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("para") as HTMLElement);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
}

const selectedText = (page: Page): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? "");

async function saveViewport(
  page: Page,
  reply: Reply,
  beforeEnter: () => Promise<void> = async () => {},
): Promise<{ call: Call; region: DocRect }> {
  await load(page);
  await selectParagraph(page);
  await begin(page, reply);
  const region = await selectViewport(page);
  await beforeEnter();
  // Guard: the toolbar is drawn inside the region, so check (b) is not vacuous.
  const tb = await toolbarRect(page);
  expect(tb).not.toBeNull();
  expect(tb && tb.y >= region.y && tb.y + tb.height <= region.y + region.height).toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  if (!call) throw new Error("no sendSave call");
  return { call, region };
}

test("(a) the overlay host is display:none when sendSave runs, the page selection cleared", async ({
  page,
}) => {
  const { call } = await saveViewport(page, { ok: true, filename: "x.svg" });
  expect(call.display).toBe("none");
  expect(call.rangeCount).toBe(0);
  // Two frames passed after the hide, so it was painted before the capture.
  expect(call.framesSinceHide).toBeGreaterThanOrEqual(2);
});

test("(b) no toolbar text in the saved model; page text is there, region-relative", async ({ page }) => {
  const { call, region } = await saveViewport(page, { ok: true, filename: "x.svg" });
  const texts = call.model.runs.map((r) => r.text);
  for (const label of TOOLBAR_LABELS) expect(texts.join("\n")).not.toContain(label);
  expect(texts.join(" ")).toContain("Some paragraph text with a");
  expect(texts).toContain("link");
  // #para is at document (150, 220); region-relative runs start inside the region.
  const para = call.model.runs.find((r) => r.text.startsWith("Some paragraph"));
  expect(para?.x).toBeCloseTo(150 - region.x, 0);
  expect(call.model.region).toEqual(region);
});

test("the model passes the background's message validation", async ({ page }) => {
  const { call } = await saveViewport(page, { ok: true, filename: "x.svg" });
  expect(isToBackground({ type: "save", model: call.model })).toBe(true);
  const p = call.model.page;
  expect(p.url).toMatch(/\/fixtures\/overlay\.html$/);
  expect(p).toMatchObject({
    title: "overlay",
    lang: "en",
    capturedAt: NOW,
    mode: "drag",
    scroll: { x: 0, y: 0 },
  });
});

test("(c) an error reply restores the overlay (still attached) and the page selection", async ({ page }) => {
  await saveViewport(page, { ok: false, error: "capture-failed", detail: "boom" });
  await expect.poll(() => hostState(page)).toEqual({ attached: true, display: "block" });
  await expect.poll(() => toastText(page)).toBe("Capture failed. Try again or select another area");
  expect(await selectedText(page)).toContain("Some paragraph text");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__session.isOpen())).toBe(true);
  // The toolbar is usable again for a retry.
  await expect.poll(() => toolbarRect(page)).not.toBeNull();
});

test("(d) an ok reply removes the host and shows the saved toast", async ({ page }) => {
  await saveViewport(page, { ok: true, filename: "snapii overlay.svg" });
  await expect.poll(() => hostState(page)).toEqual({ attached: false, display: null });
  await expect.poll(() => toastText(page)).toBe("Saved snapii overlay.svg");
  expect(await selectedText(page)).toContain("Some paragraph text");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__session.isOpen())).toBe(false);
});

/** Clicks a toolbar button and waits for its toast (none: does not wait). */
async function clickButton(
  page: Page,
  action: "save" | "copy-text" | "copy-link",
  toast?: string,
): Promise<void> {
  const button = await page.evaluate((action) => {
    const b = document
      .querySelector("snapii-overlay")
      ?.shadowRoot?.querySelector(`[data-action="${action}"]`)
      ?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  }, action);
  if (!button) throw new Error(`no ${action} button`);
  await page.mouse.click(button.x, button.y);
  if (toast !== undefined) await expect.poll(() => toastText(page)).toBe(toast);
}

const clickCopy = (page: Page): Promise<void> => clickButton(page, "copy-text", "Copied text");

function clips(page: Page): Promise<ClipboardData[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__clips);
}

/** Element pick of #id (pointer on it, ArrowUp `up` times), as a user selects it. */
async function pickElement(page: Page, id: string, up = 0): Promise<void> {
  const r = await page.evaluate((id) => {
    const b = document.getElementById(id)?.getBoundingClientRect();
    return b ? { x: b.x + 10, y: b.y + b.height / 2 } : null;
  }, id);
  if (!r) throw new Error(`no #${id}`);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.up();
  for (let i = 0; i < up; i++) await page.keyboard.press("ArrowUp");
}

test("copy text: visible text as plain + clean HTML; the overlay stays, nothing is saved", async ({
  page,
}) => {
  await load(page, "copy.html");
  await begin(page, { ok: true, filename: "x.svg" });
  const cap = await page.evaluate(() => {
    const r = document.getElementById("cap")?.getBoundingClientRect();
    return r ? { right: r.right, bottom: r.bottom } : null;
  });
  if (!cap) throw new Error("no #cap");
  // Drag mode: from the page corner to just past #cap.
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(cap.right + 10, cap.bottom + 10, { steps: 4 });
  await page.mouse.up();
  await clickCopy(page);
  const [clip, ...rest] = await clips(page);
  expect(rest).toEqual([]);
  const origin = await page.evaluate(() => location.origin);
  const href = new URL("/target?a=1&b=2", origin).href.replace(/&/g, "&amp;");
  expect(clip?.plain).toBe(
    [
      "Copy me",
      "First bold italic paragraph with a real link and a script link.",
      "Shown text and more.",
      "Erster Punkt",
      "Second item",
      "Escaped <b> & text",
    ].join("\n\n"),
  );
  // Hidden span gone, javascript: link unwrapped, real link kept and resolved.
  expect(clip?.html.replace(/\s+/g, " ").trim()).toBe(
    [
      "<h1>Copy <em>me</em></h1>",
      `<p>First <b>bold</b> <i>italic</i> paragraph with a <a href="${href}">real link</a> and a script link.</p>`,
      "<p>Shown text and more.</p>",
      '<ul> <li lang="de">Erster Punkt</li> <li>Second <code>item</code></li> </ul>',
      "<p>Escaped &lt;b&gt; &amp; text</p>",
    ].join(" "),
  );
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
  expect(await calls(page)).toEqual([]);
});

test("copy link: the text-fragment URL of the picked paragraph, as plain text and as a titled link", async ({
  page,
}) => {
  await load(page);
  await begin(page, { ok: true, filename: "x.svg" });
  await pickElement(page, "para");
  await clickButton(page, "copy-link", "Copied link");
  const [clip] = await clips(page);
  const url = await page.evaluate(() => location.href);
  // The generator lower-cases the passage; matching is case-insensitive.
  expect(clip?.plain).toBe(`${url}#:~:text=some%20paragraph%20text%20with%20a%20link%20inside.`);
  expect(clip?.html).toBe(`<a href="${clip?.plain}">overlay</a>`);
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
});

test("save: the model carries the paragraph's text-fragment URL with status SUCCESS", async ({ page }) => {
  await load(page);
  await begin(page, { ok: true, filename: "x.svg" });
  await pickElement(page, "para");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  expect(call?.model.page.mode).toBe("element");
  expect(call?.model.page.textFragmentStatus).toBe("SUCCESS");
  expect(call?.model.page.textFragmentURL).toBe(
    `${call?.model.page.url}#:~:text=some%20paragraph%20text%20with%20a%20link%20inside.`,
  );
});

test("save with the text-fragment setting off: DISABLED and no URL", async ({ page }) => {
  await load(page);
  await begin(page, { ok: true, filename: "x.svg" }, { ...DEFAULT_SETTINGS, textFragment: false });
  await pickElement(page, "para");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  expect(call?.model.page).toMatchObject({ textFragmentURL: null, textFragmentStatus: "DISABLED" });
});

// The pick lands in a shadow tree without a block element, where the
// text-fragment generator would loop forever and freeze the page. Without
// fragment.ts's guard this test fails on its own short timeout instead.
test("save of text in a shadow tree with no block ancestor completes, status INVALID_SELECTION", async ({
  page,
}) => {
  test.setTimeout(10_000);
  await load(page, "shadow-noblock.html");
  await begin(page, { ok: true, filename: "x.svg" });
  const a = await page.evaluate(() => {
    const b = document.getElementById("card")?.shadowRoot?.getElementById("more")?.getBoundingClientRect();
    return b ? { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height } : null;
  });
  if (!a) throw new Error("no #more in #card's shadow root");
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  // Guard: the shadow tree's <a> is what was picked.
  expect(call?.model.region).toEqual(a);
  expect(call?.model.page).toMatchObject({
    mode: "element",
    textFragmentURL: null,
    textFragmentStatus: "INVALID_SELECTION",
  });
  await expect.poll(() => hostState(page)).toEqual({ attached: false, display: null });
  await expect.poll(() => toastText(page)).toBe("Saved x.svg");
});

test("cancel() (second toolbar click) removes the overlay", async ({ page }) => {
  await load(page);
  await begin(page, { ok: true, filename: "x.svg" });
  await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
  expect(await hostState(page)).toEqual({ attached: false, display: null });
  expect(await page.evaluate(() => (window as unknown as TestWindow).__session.isOpen())).toBe(false);
});

test("the element under a still pointer gets no :hover before the capture", async ({ page }) => {
  await load(page);
  await page.mouse.move(200, 250); // on #para
  // Guard: without the overlay the pointer does hover #para.
  expect(await page.evaluate(() => document.getElementById("para")?.matches(":hover"))).toBe(true);
  await begin(page, { ok: true, filename: "x.svg" });
  await page.mouse.move(201, 251);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  expect(call?.model.region).toEqual({ x: 150, y: 220, width: 400, height: 80 });
  expect(call?.paraHover).toBe(false);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("snapii-shield").length)).toBe(0);
});

test("a toast still on screen is neither extracted nor left for the capture", async ({ page }) => {
  // The toast sits bottom-centre, inside the full-viewport selection.
  const { call } = await saveViewport(page, { ok: true, filename: "x.svg" }, () => clickCopy(page));
  expect(call.model.runs.map((r) => r.text).join("\n")).not.toContain("Copied text");
});

test("a rejected sendSave restores the overlay with the unexpected-error toast", async ({ page }) => {
  await saveViewport(page, "throw");
  await expect.poll(() => hostState(page)).toEqual({ attached: true, display: "block" });
  await expect.poll(() => toastText(page)).toBe("Capture failed unexpectedly. Try again");
  expect(await page.evaluate(() => document.querySelectorAll("snapii-shield").length)).toBe(0);
  expect(await selectedText(page)).toContain("Some paragraph text");
});

for (const when of ["right after Enter", "while waiting for the frames after the hide"]) {
  test(`cancel ${when}: nothing is sent, nothing left behind`, async ({ page }) => {
    await load(page);
    await selectParagraph(page);
    await begin(page, { ok: true, filename: "x.svg" });
    await selectViewport(page);
    // The overlay acts only on trusted input, so Enter is a real key press and
    // the cancel hangs off a mutation the session makes at the right moment.
    await page.evaluate((atHide) => {
      const w = window as unknown as TestWindow;
      const host = document.querySelector("snapii-overlay") as HTMLElement;
      const cancel = (): void => {
        w.__cancelledAt = {
          hidden: host.style.display === "none",
          shields: document.querySelectorAll("snapii-shield").length,
        };
        w.__session.cancel();
      };
      if (!atHide) {
        // Extraction starts by removing any toast; the observer's microtask
        // runs before save() resumes after `await collect()`, i.e. extraction
        // has begun but nothing is hidden yet.
        const marker = document.createElement("snapii-toast");
        document.documentElement.append(marker);
        new MutationObserver((_, obs) => {
          if (marker.isConnected) return;
          obs.disconnect();
          cancel();
        }).observe(document.documentElement, { childList: true });
        return;
      }
      new MutationObserver((_, obs) => {
        if (host.style.display !== "none") return;
        obs.disconnect();
        cancel();
      }).observe(host, { attributes: true, attributeFilter: ["style"] });
    }, when !== "right after Enter");
    await page.keyboard.press("Enter");
    // Guard: the cancel ran, in the window this test is about.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as TestWindow).__cancelledAt))
      .toEqual(when === "right after Enter" ? { hidden: false, shields: 0 } : { hidden: true, shields: 1 });
    await page.waitForTimeout(300);
    expect(await calls(page)).toEqual([]);
    expect(await hostState(page)).toEqual({ attached: false, display: null });
    expect(await page.evaluate(() => document.querySelectorAll("snapii-shield").length)).toBe(0);
    expect(await selectedText(page)).toContain("Some paragraph text");
  });
}

const DRAG_ORDER = "/glue/fixtures/drag-order.html?a=1&b=2";

/** Drag from (x0, y0) to (x1, y1), page px. */
async function drag(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
}

// Runs come in flat-tree order (#beta, shadow text, #alpha); the fragment has
// to start at #alpha, the first run in DOM order, and skip the shadow tree's
// own text. It covers that first block only (fragment.ts firstBlock).
// Expectation measured on Playwright's Firefox.
const DRAG_FRAGMENT = "#:~:text=alpha%20paragraph%20comes%20first%20in%20the%20markup.";

test("drag save: the fragment starts at the first run in DOM order, past a shadow tree", async ({ page }) => {
  await load(page, DRAG_ORDER);
  await begin(page, { ok: true, filename: "x.svg" });
  await drag(page, 40, 50, 700, 230);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  // Guard: the drag holds all three texts, in flat-tree order.
  expect(call?.model.runs.map((r) => r.text)).toEqual([
    "Beta paragraph closes the slotted pair.",
    "Shadow tree text between them.",
    "Alpha paragraph comes first in the markup.",
  ]);
  expect(call?.model.page.mode).toBe("drag");
  expect(call?.model.page.textFragmentStatus).toBe("SUCCESS");
  expect(call?.model.page.textFragmentURL).toBe(`${call?.model.page.url}${DRAG_FRAGMENT}`);
});

test("drag copy link: the drag's fragment URL; URL and title escaped in the HTML", async ({ page }) => {
  await load(page, DRAG_ORDER);
  await begin(page, { ok: true, filename: "x.svg" });
  await drag(page, 40, 50, 700, 230);
  await clickButton(page, "copy-link", "Copied link");
  const [clip] = await clips(page);
  const url = await page.evaluate(() => location.href);
  expect(url).toContain("?a=1&b=2");
  expect(clip?.plain).toBe(`${url}${DRAG_FRAGMENT}`);
  expect(clip?.html).toBe(`<a href="${clip?.plain.replace(/&/g, "&amp;")}">drag &amp; &lt;order&gt;</a>`);
});

// The masthead is fixed and first in the DOM: a link starting there would not
// scroll to the selection. The link starts at the first teaser instead.
test("drag copy link under a fixed masthead: the link starts at the first text that scrolls", async ({
  page,
}) => {
  await load(page, "fragment-teasers.html");
  await begin(page, { ok: true, filename: "x.svg" });
  await drag(page, 30, 10, 700, 150);
  await clickButton(page, "copy-link", "Copied link");
  const [clip] = await clips(page);
  const url = await page.evaluate(() => location.href);
  expect(clip?.plain).toBe(`${url}#:~:text=teaser%20number%201%20of%20the%20front%20page`);
});

test("copy text of text only in a shadow tree: the HTML is the plain text as a paragraph", async ({
  page,
}) => {
  await load(page, DRAG_ORDER);
  await begin(page, { ok: true, filename: "x.svg" });
  await drag(page, 40, 118, 700, 156);
  await clickCopy(page);
  const [clip] = await clips(page);
  expect(clip).toEqual({
    plain: "Shadow tree text between them.",
    html: "<p>Shadow tree text between them.</p>",
  });
});

test("a failed clipboard write shows the copy-failed toast and keeps the overlay", async ({ page }) => {
  await load(page);
  await begin(page, { ok: true, filename: "x.svg" });
  await page.evaluate(() => {
    (window as unknown as TestWindow).__clipFail = true;
  });
  await pickElement(page, "para");
  await clickButton(page, "copy-text", "Copy failed. Try again");
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
});

/** Makes sendSave and writeClipboard hang until release(). */
function hold(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__hold = new Promise((resolve) => {
      w.__release = resolve;
    });
  });
}

const release = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as TestWindow).__release?.());

const shields = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll("snapii-shield").length);

/** Saves the whole viewport with a background that does not answer yet; returns once sendSave runs. */
async function saveHanging(page: Page): Promise<void> {
  await load(page);
  await selectParagraph(page);
  await begin(page, { ok: true, filename: "x.svg" });
  await hold(page);
  await selectViewport(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
}

test("cancel while the background has not answered removes the shield: the page takes clicks again", async ({
  page,
}) => {
  await saveHanging(page);
  // Guard: the shield is up and is what a click on #para would hit.
  expect(await shields(page)).toBe(1);
  const hit = () => page.evaluate(() => document.elementFromPoint(200, 250)?.localName ?? null);
  expect(await hit()).toBe("snapii-shield");
  await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
  expect(await shields(page)).toBe(0);
  expect(await hit()).toBe("p");
  expect(await hostState(page)).toEqual({ attached: false, display: null });
  await release(page);
});

/** Delivers the background's `captured` message to the save in flight. */
const captured = (page: Page, ocr: boolean): Promise<void> =>
  page.evaluate((ocr) => (window as unknown as TestWindow).__onCaptured?.({ type: "captured", ocr }), ocr);

const isOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as TestWindow).__session.isOpen());

test("captured: the page is given back before the reply (shield gone, selection back, overlay closed, OCR toast)", async ({
  page,
}) => {
  await saveHanging(page);
  // Guard: until `captured` the page is blocked.
  expect(await shields(page)).toBe(1);
  expect(await selectedText(page)).toBe("");
  await captured(page, true);
  expect(await shields(page)).toBe(0);
  expect(await selectedText(page)).toContain("Some paragraph text");
  expect(await hostState(page)).toEqual({ attached: false, display: null });
  expect(await toastText(page)).toBe("Saving… (recognizing text)");
  expect(await isOpen(page)).toBe(false);
  // A real click reaches the page while the background still works.
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__paraClicks = 0;
    document.getElementById("para")?.addEventListener("click", () => w.__paraClicks++);
  });
  await page.mouse.click(200, 250);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__paraClicks)).toBe(1);
  await release(page);
  await expect.poll(() => toastText(page)).toBe("Saved x.svg");
});

test("captured without OCR: no toast until the reply's", async ({ page }) => {
  await saveHanging(page);
  await captured(page, false);
  expect(await shields(page)).toBe(0);
  expect(await hostState(page)).toEqual({ attached: false, display: null });
  expect(await toastText(page)).toBeNull();
  await release(page);
  await expect.poll(() => toastText(page)).toBe("Saved x.svg");
});

const LATE_ERRORS: [string, Reply, string][] = [
  [
    "a failed download",
    { ok: false, error: "download-failed" },
    "The SVG was not saved (download failed or was cancelled)",
  ],
  [
    "a render error",
    { ok: false, error: "capture-failed", detail: "render: boom" },
    "The selection was captured, but no SVG came of it. Start snapii again to retry",
  ],
  [
    "a rejected send",
    "throw",
    "The selection was captured, but no SVG came of it. Start snapii again to retry",
  ],
];
for (const [what, reply, toast] of LATE_ERRORS) {
  test(`${what} after captured: a toast that says so, no overlay to retry in`, async ({ page }) => {
    await saveHanging(page);
    await page.evaluate((r) => {
      (window as unknown as TestWindow).__reply = r;
    }, reply);
    await captured(page, true);
    await release(page);
    await expect.poll(() => toastText(page)).toBe(toast);
    expect(await hostState(page)).toEqual({ attached: false, display: null });
    expect(await shields(page)).toBe(0);
    expect(await isOpen(page)).toBe(false);
  });
}

test("a captured that arrives after an error reply leaves the restored overlay alone", async ({ page }) => {
  await saveViewport(page, { ok: false, error: "capture-failed", detail: "tab changed during capture" });
  await expect.poll(() => hostState(page)).toEqual({ attached: true, display: "block" });
  await captured(page, true);
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
  expect(await isOpen(page)).toBe(true);
  expect(await toastText(page)).toBe("Capture failed. Try again or select another area");
});

test("a selection the reader makes after captured survives the reply", async ({ page }) => {
  await saveHanging(page);
  await captured(page, false);
  expect(await selectedText(page)).toContain("Some paragraph text");
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await release(page);
  await expect.poll(() => toastText(page)).toBe("Saved x.svg");
  expect(await selectedText(page)).toBe("");
});

test("captured after a cancel: the selection comes back at once, still no toast", async ({ page }) => {
  await saveHanging(page);
  await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
  await captured(page, true);
  expect(await selectedText(page)).toContain("Some paragraph text");
  expect(await toastText(page)).toBeNull();
  await release(page);
  // Each evaluate is a task of its own: the reply has been handled by now.
  await page.evaluate(() => 0);
  expect(await toastText(page)).toBeNull();
});

test("after captured a toolbar click opens a new session; the first save's toast waits out the second capture", async ({
  page,
}) => {
  type Pending = { onCaptured: (m: CapturedMessage) => void; resolve: (r: SaveResponse) => void };
  type W = TestWindow & { __pending: Pending[] };
  await load(page);
  await page.evaluate(
    ({ settings }) => {
      const w = window as unknown as W;
      w.__calls = [];
      w.__pending = [];
      const toggle = w.__snapii.sessionToggle({
        now: () => new Date(),
        sendSave(model, onCaptured) {
          w.__calls.push({ model } as Call);
          return new Promise((resolve) => w.__pending.push({ onCaptured, resolve }));
        },
        async writeClipboard() {},
      });
      w.__toggle = () => toggle(settings);
    },
    { settings: DEFAULT_SETTINGS },
  );
  const click = (): Promise<void> => page.evaluate(() => (window as unknown as W).__toggle?.());
  /** The i-th save hears `captured` (ocr flag) or its ok reply (filename). */
  const pending = (i: number, act: { ocr: boolean } | { filename: string }): Promise<void> =>
    page.evaluate(
      ({ i, act }) => {
        const p = (window as unknown as W).__pending[i];
        if ("ocr" in act) p?.onCaptured({ type: "captured", ocr: act.ocr });
        else p?.resolve({ ok: true, filename: act.filename });
      },
      { i, act },
    );

  await click();
  await selectViewport(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await pending(0, { ocr: true });
  expect(await toastText(page)).toBe("Saving… (recognizing text)");
  // The first save is still recognising text; the page is free for a second one.
  await click();
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
  await selectViewport(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(2);
  // The second capture is in flight: the first save's "Saved" would be painted into it.
  await pending(0, { filename: "a.svg" });
  expect(await toastText(page)).toBeNull();
  // No OCR in the second save, so its own toast does not replace the held one.
  await pending(1, { ocr: false });
  expect(await toastText(page)).toBe("Saved a.svg");
  await pending(1, { filename: "b.svg" });
  await expect.poll(() => toastText(page)).toBe("Saved b.svg");
});

const LATE_REPLIES: [string, Reply][] = [
  ["answers ok", { ok: true, filename: "x.svg" }],
  ["answers an error", { ok: false, error: "download-failed" }],
  ["rejects", "throw"],
];
for (const [what, reply] of LATE_REPLIES) {
  test(`cancel after the save was sent: no toast when the background ${what}`, async ({ page }) => {
    await saveHanging(page);
    await page.evaluate((r) => {
      (window as unknown as TestWindow).__reply = r;
    }, reply);
    await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
    await release(page);
    // The page selection comes back right before the toast would be shown,
    // so once it is there the session has handled the reply.
    await expect.poll(() => selectedText(page)).toContain("Some paragraph text");
    expect(await toastText(page)).toBeNull();
    expect(await hostState(page)).toEqual({ attached: false, display: null });
    expect(await shields(page)).toBe(0);
  });
}

// A rejected send (messaging failed) has to end the in-flight state too, or
// no toolbar click could open snapii in that tab again.
for (const [what, reply] of [
  ["answers", { ok: true, filename: "x.svg" }],
  ["rejects", "throw"],
] as [string, Reply][]) {
  test(`a toolbar click while a cancelled save is still in flight opens no overlay until the background ${what}`, async ({
    page,
  }) => {
    await load(page);
    await hold(page);
    // sessionToggle is what content/main.ts runs per `start` message.
    await page.evaluate(
      ({ settings, reply }) => {
        const w = window as unknown as TestWindow;
        w.__calls = [];
        const toggle = w.__snapii.sessionToggle({
          now: () => new Date(),
          async sendSave(model) {
            w.__calls.push({ model } as Call);
            await w.__hold;
            if (reply === "throw") throw new Error("Could not establish connection");
            return reply;
          },
          async writeClipboard() {},
        });
        w.__toggle = () => toggle(settings);
      },
      { settings: DEFAULT_SETTINGS, reply },
    );
    const click = (): Promise<void> => page.evaluate(() => (window as unknown as TestWindow).__toggle?.());
    await click();
    expect(await hostState(page)).toEqual({ attached: true, display: "block" });
    await selectViewport(page);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await calls(page)).length).toBe(1);
    // The first click ends the session; the background is still capturing.
    await click();
    expect(await hostState(page)).toEqual({ attached: false, display: null });
    await click();
    expect(await hostState(page)).toEqual({ attached: false, display: null });
    // No toast either: it would be painted into the remaining tiles.
    expect(await toastText(page)).toBeNull();
    // Settled (each evaluate is a task of its own, so the reply's microtasks
    // have run): the next click opens a session again.
    await release(page);
    await click();
    expect(await hostState(page)).toEqual({ attached: true, display: "block" });
  });
}

test("a sendSave that throws synchronously does not lock the toolbar button for good", async ({ page }) => {
  await load(page);
  await page.evaluate(
    ({ settings }) => {
      const w = window as unknown as TestWindow;
      w.__calls = [];
      const toggle = w.__snapii.sessionToggle({
        now: () => new Date(),
        sendSave(model) {
          w.__calls.push({ model } as Call);
          throw new Error("runtime.sendMessage threw");
        },
        async writeClipboard() {},
      });
      w.__toggle = () => toggle(settings);
    },
    { settings: DEFAULT_SETTINGS },
  );
  const click = (): Promise<void> => page.evaluate(() => (window as unknown as TestWindow).__toggle?.());
  await click();
  await selectViewport(page);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  // Close whatever the failed save left open, then start again.
  if ((await hostState(page)).attached) await click();
  expect(await hostState(page)).toEqual({ attached: false, display: null });
  await click();
  expect(await hostState(page)).toEqual({ attached: true, display: "block" });
});

for (const action of ["copy-text", "copy-link"] as const) {
  test(`cancel during ${action}: the copy completes, but no toast`, async ({ page }) => {
    await load(page);
    await begin(page, { ok: true, filename: "x.svg" });
    await hold(page);
    await pickElement(page, "para");
    await clickButton(page, action);
    await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__clipStarted)).toBe(1);
    await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
    await release(page);
    // writeClipboard resolves right after its push; the session's toast
    // would follow in the same task's microtasks.
    await expect.poll(async () => (await clips(page)).length).toBe(1);
    expect(await toastText(page)).toBeNull();
    expect(await hostState(page)).toEqual({ attached: false, display: null });
  });
}

for (const action of ["copy-text", "copy-link"] as const) {
  test(`cancel while ${action} collects the text: the clipboard is not written`, async ({ page }) => {
    await load(page);
    await begin(page, { ok: true, filename: "x.svg" });
    // A drag: Copy link collects runs only in drag mode.
    await drag(page, 140, 210, 600, 310);
    await page.evaluate(() => {
      const w = window as unknown as TestWindow;
      // Collection starts by removing any toast; the observer's microtask
      // runs before the copy resumes after `await collect()`.
      const marker = document.createElement("snapii-toast");
      document.documentElement.append(marker);
      new MutationObserver((_, obs) => {
        if (marker.isConnected) return;
        obs.disconnect();
        w.__session.cancel();
      }).observe(document.documentElement, { childList: true });
    });
    await clickButton(page, action);
    // Guard: the cancel ran.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as TestWindow).__session.isOpen()))
      .toBe(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as TestWindow).__clipStarted)).toBe(0);
    expect(await toastText(page)).toBeNull();
    expect(await hostState(page)).toEqual({ attached: false, display: null });
  });
}

// A saved snapii .svg opened directly: an XML document, where
// document.createElement gives a null-namespace element without `style`.
// Served by route so it really is image/svg+xml.
const SVG_DOC = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <rect x="100" y="100" width="300" height="200" fill="#eef"/>
  <text x="120" y="160" font-size="24">SVG document text</text>
  <script href="/harness.js"/>
</svg>`;

test("save on an SVG document: the hover shield is an HTML element and the save goes out", async ({
  page,
}) => {
  await page.route("**/session-doc.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: SVG_DOC }),
  );
  await page.route("**/harness.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: "dist-test/harness.js" }),
  );
  await page.goto("/fixtures/session-doc.svg");
  await page.waitForFunction(() => document.documentElement.localName === "svg" && "__snapii" in window);
  // snapii does not start on such documents (background check); this covers
  // the session should one run there anyway. The text-fragment setting is on:
  // the generator would hang the page under a non-HTML root (measured: the
  // Enter press never returned), so fragment.ts must not call it here, and
  // this test fails on its own short timeout if it does.
  test.setTimeout(10_000);
  await begin(page, { ok: true, filename: "x.svg" });
  await page.evaluate(() => {
    const w = window as unknown as TestWindow & { __shieldNs: (string | null)[] };
    w.__shieldNs = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof Element && n.localName === "snapii-shield") w.__shieldNs.push(n.namespaceURI);
    }).observe(document.documentElement, { childList: true });
  });
  await page.mouse.click(250, 250);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  expect(call?.model.page).toMatchObject({ textFragmentURL: null, textFragmentStatus: "INVALID_SELECTION" });
  expect(
    await page.evaluate(() => (window as unknown as TestWindow & { __shieldNs: string[] }).__shieldNs),
  ).toEqual(["http://www.w3.org/1999/xhtml"]);
  await expect.poll(() => shields(page)).toBe(0);
});

// Chromium captures the viewport and nothing else: there the session runs
// with viewportOnly, and Save answers only for a selection that is wholly
// visible.
const NOTICE =
  "Only what is visible can be saved in this browser. Scroll the selection fully into view or select a smaller area";

/** What the toolbar's Save button and the overlay's hint say right now. */
function saveState(page: Page): Promise<{ unavailable: boolean; title: string; hint: string | null }> {
  return page.evaluate(() => {
    const root = document.querySelector("snapii-overlay")?.shadowRoot;
    const save = root?.querySelector<HTMLElement>('.toolbar button[data-action="save"]');
    const hint = root?.querySelector<HTMLElement>(".hint");
    return {
      unavailable: save?.getAttribute("aria-disabled") === "true",
      title: save?.title ?? "",
      hint: hint && !hint.hidden ? hint.textContent : null,
    };
  });
}

/** Scrolls so #para (document y 220 to 300) is cut by the top of the viewport, then picks it. */
async function pickCutParagraph(page: Page, viewportOnly: boolean): Promise<void> {
  await load(page);
  await page.evaluate(() => scrollTo(0, 250));
  await begin(page, { ok: true, filename: "x.svg" }, DEFAULT_SETTINGS, viewportOnly);
  await page.mouse.click(250, 30);
  await expect.poll(() => toolbarRect(page)).not.toBeNull();
}

test("viewport-only: a selection reaching beyond the viewport cannot be saved, and the overlay says why", async ({
  page,
}) => {
  await pickCutParagraph(page, true);
  expect(await saveState(page)).toEqual({ unavailable: true, title: NOTICE, hint: NOTICE });
  await page.keyboard.press("Enter");
  await clickButton(page, "save");
  // Long enough for a save to have reached sendSave (extraction plus two frames).
  await page.waitForTimeout(300);
  expect(await calls(page)).toEqual([]);
  expect((await hostState(page)).display).not.toBe("none");
});

test("viewport-only: scrolling the selection into view makes Save available again", async ({ page }) => {
  await pickCutParagraph(page, true);
  await page.evaluate(() => scrollTo(0, 100));
  await expect.poll(() => saveState(page)).toEqual({ unavailable: false, title: "", hint: null });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  const [call] = await calls(page);
  expect(call?.model.region).toEqual({ x: 150, y: 220, width: 400, height: 80 });
});

test("viewport-only: Copy text needs no pixels and works for a selection beyond the viewport", async ({
  page,
}) => {
  await pickCutParagraph(page, true);
  await clickButton(page, "copy-text", "Copied text");
  const clips = await page.evaluate(() => (window as unknown as TestWindow).__clips);
  expect(clips.map((c) => c.plain)).toEqual(["Some paragraph text with a link inside."]);
});

test("without viewport-only the same selection is saved (Firefox captures beyond the viewport)", async ({
  page,
}) => {
  await pickCutParagraph(page, false);
  expect(await saveState(page)).toEqual({ unavailable: false, title: "", hint: null });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).length).toBe(1);
});
