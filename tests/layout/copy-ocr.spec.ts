// SPDX-License-Identifier: GPL-3.0-or-later
// Copy text with the OCR setting on, the background stubbed: whether the
// content script asks for the words in the selection's images, in which
// state the page is when it does, what comes back to the screen and when,
// and what reaches the clipboard. The stub "recognises" the same words in
// tests/fixtures/copy-ocr.html's picture every time, where the request's
// region shows them.
import { expect, type Page, test } from "@playwright/test";
import type { ClipboardData } from "../../src/content/clipboard.ts";
import type { SessionDeps, SessionHandle } from "../../src/content/session.ts";
import { isToBackground } from "../../src/shared/messages.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { RecognizeRequest, RecognizeResponse, TextRun } from "../../src/shared/types.ts";

interface Ask {
  request: RecognizeRequest;
  /** Computed display of the overlay host when sendRecognize ran. */
  display: string | null;
  /** Page text selection ranges at that moment. */
  rangeCount: number;
  /** Animation frames between the host's hide and sendRecognize. */
  framesSinceHide: number;
  shields: number;
  /** A toast on screen would be in the capture. */
  toast: boolean;
}
/** "words": what the picture says; "throw": messaging failed. */
type Reply = "words" | "throw" | RecognizeResponse;
type TestWindow = Window & {
  __asks: Ask[];
  __clips: ClipboardData[];
  /** writeClipboard calls that started. */
  __clipStarted: number;
  /** The overlay host's display at each sendSave. */
  __saves: (string | null)[];
  __reply: Reply;
  /** Whether the stubbed background sends `captured` (a capture that fails sends none). */
  __tellsCaptured: boolean;
  /** While set, the stub waits here before `captured` (the capture), and before its reply (the reading). */
  __capture?: Promise<void>;
  __reading?: Promise<void>;
  __captureDone?: () => void;
  __readingDone?: () => void;
  __session: SessionHandle;
  __toggle?: () => void;
  __frames: number;
  __framesAtHide: number;
};

// The picture is 400 × 100 at document (100, 140). Its two lines, picture-relative, each word 20 px high.
const WORDS = [
  [
    { text: "Summer", x: 20, y: 20, width: 80 },
    { text: "Sale", x: 120, y: 20, width: 50 },
    { text: "Today", x: 300, y: 20, width: 60 },
  ],
  [
    { text: "Half", x: 20, y: 60, width: 50 },
    { text: "price", x: 80, y: 60, width: 60 },
  ],
];
const PICTURE = { x: 100, y: 140, width: 400, height: 100 };
const DOM_TEXT = "Text above the picture.\n\nOn it.\n\nText below the picture.";
const ALL_TEXT =
  "Text above the picture.\n\nSummer Sale Today\nHalf price\n\nOn it.\n\nText below the picture.";
const NOT_RECOGNIZED = "Copied text. Text in images was not recognized";

/** Shadow roots forced open, as in session.spec.ts: the spec reads the toolbar and the toast. */
async function load(page: Page): Promise<void> {
  await page.goto("/fixtures/copy-ocr.html");
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
  o: { ocr?: boolean; viewportOnly?: boolean; reply?: Reply; captured?: boolean; toggle?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    ({ settings, viewportOnly, reply, captured, toggle, words }) => {
      const w = window as unknown as TestWindow;
      w.__asks = [];
      w.__clips = [];
      w.__clipStarted = 0;
      w.__saves = [];
      w.__reply = reply;
      w.__tellsCaptured = captured;
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
      const hostDisplay = (): string | null => {
        const host = document.querySelector("snapii-overlay");
        return host ? getComputedStyle(host).display : null;
      };
      /** The words the request's region shows whole, one run per word as the background answers. */
      const read = (request: RecognizeRequest): TextRun[] => {
        const pic = (document.getElementById("pic") as HTMLElement).getBoundingClientRect();
        const dx = pic.x + scrollX - request.region.x;
        const dy = pic.y + scrollY - request.region.y;
        return words.flatMap((line, i) => {
          const seen = line
            .map((word) => ({ ...word, x: word.x + dx, y: word.y + dy }))
            .filter(
              (word) =>
                word.x >= 0 &&
                word.y >= 0 &&
                word.x + word.width <= request.region.width &&
                word.y + 20 <= request.region.height,
            );
          return seen.map(
            (word, n): TextRun => ({
              text: n < seen.length - 1 ? `${word.text} ` : word.text,
              x: word.x,
              y: word.y + 16,
              top: word.y,
              width: word.width,
              height: 20,
              fontFamily: "sans-serif",
              fontSize: 20,
              fontWeight: 400,
              fontStyle: "normal",
              color: "#000",
              lang: null,
              dir: "ltr",
              href: null,
              line: i,
              block: 0,
            }),
          );
        });
      };
      const deps: Omit<SessionDeps, "settings"> = {
        viewportOnly,
        now: () => new Date("2026-10-01T12:00:00.000Z"),
        // A save that is captured and never answered: its overlay stays hidden.
        sendSave() {
          w.__saves.push(hostDisplay());
          return new Promise(() => {});
        },
        async sendRecognize(request, onCaptured) {
          w.__asks.push({
            // A copy: nothing later can change what was sent.
            request: JSON.parse(JSON.stringify(request)),
            display: hostDisplay(),
            rangeCount: getSelection()?.rangeCount ?? -1,
            framesSinceHide: w.__framesAtHide < 0 ? -1 : w.__frames - w.__framesAtHide,
            shields: document.querySelectorAll("snapii-shield").length,
            toast: document.querySelector("snapii-toast") !== null,
          });
          await w.__capture;
          if (w.__reply === "throw") throw new Error("Could not establish connection");
          if (w.__tellsCaptured) onCaptured({ type: "captured", ocr: true });
          await w.__reading;
          return w.__reply === "words" ? { ok: true, runs: read(request) } : w.__reply;
        },
        async writeClipboard(data) {
          w.__clipStarted++;
          w.__clips.push(data);
        },
      };
      if (toggle) {
        const click = w.__snapii.sessionToggle(deps);
        w.__toggle = () => click(settings);
        w.__toggle();
      } else {
        w.__session = w.__snapii.startSession({ ...deps, settings });
      }
    },
    {
      settings: { ...DEFAULT_SETTINGS, ocr: o.ocr ?? true },
      viewportOnly: o.viewportOnly ?? false,
      reply: o.reply ?? "words",
      captured: o.captured ?? true,
      toggle: o.toggle ?? false,
      words: WORDS,
    },
  );
}

/** The stubbed background takes its time over the capture, the reading, or both, until told. */
function hold(page: Page, what: ("capture" | "reading")[]): Promise<void> {
  return page.evaluate((what) => {
    const w = window as unknown as TestWindow;
    if (what.includes("capture")) {
      w.__capture = new Promise((resolve) => {
        w.__captureDone = resolve;
      });
    }
    if (what.includes("reading")) {
      w.__reading = new Promise((resolve) => {
        w.__readingDone = resolve;
      });
    }
  }, what);
}
const captureDone = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as TestWindow).__captureDone?.());
const readingDone = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as TestWindow).__readingDone?.());

const asks = (page: Page): Promise<Ask[]> => page.evaluate(() => (window as unknown as TestWindow).__asks);
/** What writeClipboard was handed; the HTML without the page's line breaks between its paragraphs. */
const clips = async (page: Page): Promise<ClipboardData[]> =>
  (await page.evaluate(() => (window as unknown as TestWindow).__clips)).map((c) => ({
    plain: c.plain,
    html: c.html.replace(/>\s+</g, "><").trim(),
  }));
const clipStarted = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as TestWindow).__clipStarted);
const shields = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll("snapii-shield").length);
const selectedText = (page: Page): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? "");
const everHidden = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as TestWindow).__framesAtHide >= 0);

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
const SHOWN = { attached: true, display: "block" };
const GONE = { attached: false, display: null };

/** Clicks a toolbar button and waits for its toast (none: does not wait). */
async function clickButton(
  page: Page,
  action: "save" | "copy-text" | "copy-page-link",
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

/** Element pick of #id (pointer on it, ArrowUp `up` times). */
async function pick(page: Page, id: string, up = 0): Promise<void> {
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

/** The whole fixture: both paragraphs, the picture and the caption on it. */
const pickAll = (page: Page): Promise<void> => pick(page, "outro", 1);

async function drag(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
}

/** Selects the first paragraph's text the way a reader would have before starting snapii. */
function selectIntro(page: Page): Promise<void> {
  return page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("intro") as HTMLElement);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
}

test("OCR off: Copy text asks the background for nothing and the overlay never leaves the screen", async ({
  page,
}) => {
  await load(page);
  await begin(page, { ocr: false });
  await pickAll(page);
  await clickButton(page, "copy-text", "Copied text");
  expect(await asks(page)).toEqual([]);
  expect(await everHidden(page)).toBe(false);
  expect(await clips(page)).toEqual([
    { plain: DOM_TEXT, html: "<p>Text above the picture.</p><p>On it.</p><p>Text below the picture.</p>" },
  ]);
});

test("OCR on, no image in the selection: nothing is asked, nothing hidden", async ({ page }) => {
  await load(page);
  await begin(page);
  await pick(page, "outro");
  await clickButton(page, "copy-text", "Copied text");
  expect(await asks(page)).toEqual([]);
  expect(await everHidden(page)).toBe(false);
  expect((await clips(page)).map((c) => c.plain)).toEqual(["Text below the picture."]);
});

test("OCR on, an image in the selection: asked once snapii is off the screen, back with the selection while the images are read, then DOM text and recognised words", async ({
  page,
}) => {
  await load(page);
  await selectIntro(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["capture", "reading"]);
  await clickButton(page, "copy-text");
  await expect.poll(async () => (await asks(page)).length).toBe(1);
  const [ask] = await asks(page);
  if (!ask) throw new Error("no sendRecognize call");

  // The capture: no overlay, no text selection, no toast in the pixels; the page under a shield.
  expect(ask.display).toBe("none");
  expect(ask.rangeCount).toBe(0);
  expect(ask.framesSinceHide).toBeGreaterThanOrEqual(2);
  expect(ask.shields).toBe(1);
  expect(ask.toast).toBe(false);
  expect(isToBackground({ type: "recognize", request: ask.request })).toBe(true);
  expect(ask.request.region).toEqual(PICTURE);
  expect(ask.request.areas).toEqual([{ x: 0, y: 0, width: 400, height: 100, kind: "img" }]);
  // Only the DOM text on the picture goes along: words recognised under it are dropped.
  expect(ask.request.runs.map((r) => r.text)).toEqual(["On it."]);
  expect(ask.request.runs[0]?.x).toBeCloseTo(300, 0);
  expect(await toastText(page)).toBeNull();

  // The pixels are taken: everything is back while the reading goes on.
  await captureDone(page);
  await expect.poll(() => hostState(page)).toEqual(SHOWN);
  expect(await shields(page)).toBe(0);
  expect(await selectedText(page)).toBe("Text above the picture.");
  expect(await toastText(page)).toBe("Copying… (recognizing text)");
  expect(await clipStarted(page)).toBe(0);

  await readingDone(page);
  await expect.poll(() => toastText(page)).toBe("Copied text");
  expect(await clips(page)).toEqual([
    {
      plain: ALL_TEXT,
      html: "<p>Text above the picture.</p><p>On it.</p><p>Text below the picture.</p><p>Summer Sale Today<br>Half price</p>",
    },
  ]);
  expect(await hostState(page)).toEqual(SHOWN);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__session.isOpen())).toBe(true);
  expect(await selectedText(page)).toBe("Text above the picture.");
});

test("a recognised word the selection's edge cuts is copied whole, one beside or below it is not", async ({
  page,
}) => {
  await load(page);
  await begin(page);
  // In the picture's first line: from the middle of "Summer" (120–200) to the middle of "Sale" (220–270).
  await drag(page, 150, 150, 240, 185);
  await clickButton(page, "copy-text", "Copied text");
  const [ask] = await asks(page);
  // The picture is read to its sides, and above and below as far as a word of the selection can reach.
  expect(ask?.request.region).toEqual({ x: 100, y: 140, width: 400, height: 80 });
  expect(await clips(page)).toEqual([{ plain: "Summer Sale", html: "<p>Summer Sale</p>" }]);
});

test("a selection on the picture that reaches no word: no text", async ({ page }) => {
  await load(page);
  await begin(page);
  // Between "Sale" and "Today" (400–460).
  await drag(page, 290, 150, 390, 185);
  await clickButton(page, "copy-text", "No text in the selection");
  expect((await asks(page)).length).toBe(1);
  expect(await clipStarted(page)).toBe(0);
  expect(await hostState(page)).toEqual(SHOWN);
});

const FAILURES: [string, Reply, boolean][] = [
  ["the reading ran out of time", { ok: false, error: "timeout" }, true],
  ["the reading failed", { ok: false, error: "failed" }, true],
  ["the capture failed", { ok: false, error: "capture-failed", detail: "tab changed during capture" }, false],
  ["the background did not answer", "throw", false],
];
for (const [name, reply, captured] of FAILURES) {
  test(`${name}: the DOM text is copied, the toast says the images were not read, the overlay is back`, async ({
    page,
  }) => {
    await load(page);
    await selectIntro(page);
    await begin(page, { reply, captured });
    await pickAll(page);
    await clickButton(page, "copy-text", NOT_RECOGNIZED);
    expect((await clips(page)).map((c) => c.plain)).toEqual([DOM_TEXT]);
    expect(await hostState(page)).toEqual(SHOWN);
    expect(await shields(page)).toBe(0);
    expect(await selectedText(page)).toBe("Text above the picture.");
    expect(await page.evaluate(() => (window as unknown as TestWindow).__session.isOpen())).toBe(true);
  });
}

test("the images could not be read and the selection has no DOM text: nothing is copied, and the toast says so", async ({
  page,
}) => {
  await load(page);
  await begin(page, { reply: { ok: false, error: "timeout" } });
  await drag(page, 150, 150, 240, 185);
  await clickButton(page, "copy-text", "Nothing copied. Text in images was not recognized");
  expect(await clipStarted(page)).toBe(0);
  expect(await hostState(page)).toEqual(SHOWN);
});

test("OCR switched off since the session started: the DOM text is copied without a word about images", async ({
  page,
}) => {
  await load(page);
  await begin(page, { reply: { ok: false, error: "disabled" }, captured: false });
  await pickAll(page);
  await clickButton(page, "copy-text", "Copied text");
  expect((await clips(page)).map((c) => c.plain)).toEqual([DOM_TEXT]);
  expect(await hostState(page)).toEqual(SHOWN);
});

test("cancel while the images are read: the clipboard is not written, the toast goes", async ({ page }) => {
  await load(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["reading"]);
  await clickButton(page, "copy-text", "Copying… (recognizing text)");
  await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
  expect(await toastText(page)).toBeNull();
  expect(await hostState(page)).toEqual(GONE);
  await readingDone(page);
  await page.waitForTimeout(300);
  expect(await clipStarted(page)).toBe(0);
  expect(await toastText(page)).toBeNull();
  expect(await shields(page)).toBe(0);
});

test("Escape while the images are read ends the session: the clipboard is not written", async ({ page }) => {
  await load(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["reading"]);
  await clickButton(page, "copy-text", "Copying… (recognizing text)");
  await page.keyboard.press("Escape");
  await expect.poll(() => hostState(page)).toEqual(GONE);
  await readingDone(page);
  await page.waitForTimeout(300);
  expect(await clipStarted(page)).toBe(0);
  expect(await toastText(page)).toBeNull();
});

test("cancel while the images are captured: no shield stays, the reader's selection comes back, nothing is written", async ({
  page,
}) => {
  await load(page);
  await selectIntro(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["capture"]);
  await clickButton(page, "copy-text");
  await expect.poll(async () => (await asks(page)).length).toBe(1);
  expect(await shields(page)).toBe(1);
  await page.evaluate(() => (window as unknown as TestWindow).__session.cancel());
  expect(await shields(page)).toBe(0);
  expect(await hostState(page)).toEqual(GONE);
  await captureDone(page);
  await expect.poll(() => selectedText(page)).toBe("Text above the picture.");
  await page.waitForTimeout(300);
  expect(await clipStarted(page)).toBe(0);
  expect(await toastText(page)).toBeNull();
  expect(await hostState(page)).toEqual(GONE);
  expect(await shields(page)).toBe(0);
});

test("cancel in the frames before the capture: the background is not asked", async ({ page }) => {
  await load(page);
  await selectIntro(page);
  await begin(page);
  await pickAll(page);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    new MutationObserver((_, obs) => {
      const host = document.querySelector("snapii-overlay") as HTMLElement | null;
      if (host?.style.display !== "none") return;
      obs.disconnect();
      w.__session.cancel();
    }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["style"] });
  });
  await clickButton(page, "copy-text");
  await expect.poll(() => hostState(page)).toEqual(GONE);
  await page.waitForTimeout(300);
  expect(await asks(page)).toEqual([]);
  expect(await clipStarted(page)).toBe(0);
  expect(await shields(page)).toBe(0);
  expect(await selectedText(page)).toBe("Text above the picture.");
});

test("a second start while the images are captured ends the session; a new one waits for the pixels", async ({
  page,
}) => {
  await load(page);
  await begin(page, { toggle: true });
  await pickAll(page);
  await hold(page, ["capture", "reading"]);
  await clickButton(page, "copy-text");
  await expect.poll(async () => (await asks(page)).length).toBe(1);
  const click = (): Promise<void> => page.evaluate(() => (window as unknown as TestWindow).__toggle?.());
  await click();
  expect(await hostState(page)).toEqual(GONE);
  expect(await shields(page)).toBe(0);
  // The capture is still in flight: an overlay now would be in its pixels.
  await click();
  expect(await hostState(page)).toEqual(GONE);
  await captureDone(page);
  await page.waitForTimeout(100);
  expect(await toastText(page)).toBeNull();
  await click();
  expect(await hostState(page)).toEqual(SHOWN);
  await readingDone(page);
  await page.waitForTimeout(300);
  expect(await clipStarted(page)).toBe(0);
  expect(await hostState(page)).toEqual(SHOWN);
});

test("a later copy wins: the text whose images were still being read is not written over it", async ({
  page,
}) => {
  await load(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["reading"]);
  await clickButton(page, "copy-text", "Copying… (recognizing text)");
  await clickButton(page, "copy-page-link", "Copied page link");
  await readingDone(page);
  await page.waitForTimeout(300);
  expect((await clips(page)).map((c) => c.plain)).toEqual([await page.evaluate(() => location.href)]);
  expect(await toastText(page)).toBe("Copied page link");
});

test("Save while the images are read: the copy completes and leaves the save's hidden overlay and shield alone", async ({
  page,
}) => {
  await load(page);
  await begin(page);
  await pickAll(page);
  await hold(page, ["reading"]);
  await clickButton(page, "copy-text", "Copying… (recognizing text)");
  await clickButton(page, "save");
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__saves)).toEqual(["none"]);
  await readingDone(page);
  await expect.poll(async () => (await clips(page)).map((c) => c.plain)).toEqual([ALL_TEXT]);
  expect(await hostState(page)).toEqual({ attached: true, display: "none" });
  expect(await shields(page)).toBe(1);
  // The save's capture is still under way: no toast may get into it.
  expect(await toastText(page)).toBeNull();
});

test("viewport-only: of a picture the viewport cuts, the part in it is asked for; the DOM text beyond is copied whole", async ({
  page,
}) => {
  await load(page);
  await begin(page, { viewportOnly: true });
  // The viewport starts 40 px into the picture: its first line is cut away, the intro is far above.
  await page.evaluate(() => scrollTo(0, 180));
  await pickAll(page);
  await clickButton(page, "copy-text", "Copied text");
  const [ask] = await asks(page);
  expect(ask?.request.region).toEqual({ x: 100, y: 180, width: 400, height: 60 });
  expect(ask?.request.page.scroll).toEqual({ x: 0, y: 180 });
  expect((await clips(page)).map((c) => c.plain)).toEqual([
    "Text above the picture.\n\nHalf price\n\nOn it.\n\nText below the picture.",
  ]);
});

test("without viewport-only the same selection has the whole picture read (Firefox captures beyond the viewport)", async ({
  page,
}) => {
  await load(page);
  await begin(page);
  await page.evaluate(() => scrollTo(0, 180));
  await pickAll(page);
  await clickButton(page, "copy-text", "Copied text");
  const [ask] = await asks(page);
  expect(ask?.request.region).toEqual(PICTURE);
  expect((await clips(page)).map((c) => c.plain)).toEqual([ALL_TEXT]);
});

test("viewport-only: a picture scrolled out of the viewport is not asked for, the DOM text is copied", async ({
  page,
}) => {
  await load(page);
  await begin(page, { viewportOnly: true });
  await page.evaluate(() => scrollTo(0, 260));
  await pickAll(page);
  await clickButton(page, "copy-text", "Copied text");
  expect(await asks(page)).toEqual([]);
  expect(await everHidden(page)).toBe(false);
  expect((await clips(page)).map((c) => c.plain)).toEqual([DOM_TEXT]);
});
