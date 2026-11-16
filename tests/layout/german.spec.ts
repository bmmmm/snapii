// SPDX-License-Identifier: GPL-3.0-or-later
// The overlay and the toasts under a German i18n API (the stand-in serves
// src/_locales/de and is in place before the harness loads, as the browser's
// API is before the content script): German labels, and the longer words
// still fit: no button cut off, toolbar and hint inside the viewport.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { startSession } from "../../src/content/session.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { DocRect } from "../../src/shared/types.ts";
import { type Catalogue, installI18n } from "../unit/i18n-stub.ts";

const de: Catalogue = JSON.parse(
  readFileSync(new URL("../../src/_locales/de/messages.json", import.meta.url), "utf8"),
);

// Fixture geometry (document px), see tests/fixtures/overlay.html.
const PARA = { x: 150, y: 220, width: 400, height: 80 };

interface Layout {
  viewport: { width: number; height: number };
  toolbar: DocRect | null;
  hint: (DocRect & { text: string }) | null;
  /** Label, and whether the button's content is wider than the button. */
  buttons: { label: string | null | undefined; clipped: boolean }[];
}

async function load(page: Page): Promise<void> {
  await page.addInitScript(installI18n, de);
  await page.goto("/fixtures/overlay.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  // Open roots, so the page can read the toolbar and the toast.
  await page.evaluate(() => {
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      return orig.call(this, { ...init, mode: "open" });
    };
    const start = window.__snapii.startSession as typeof startSession;
    // biome-ignore lint/suspicious/noExplicitAny: the settings are the test's argument below
    (window as any).__start = (settings: any) =>
      start({
        settings,
        viewportOnly: false,
        now: () => new Date("2026-10-01T12:00:00.000Z"),
        sendSave: async () => ({ ok: true, filename: "Überblick & <b>.svg" }),
        writeClipboard: async () => {},
      });
  });
}

function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const root = document.querySelector("snapii-overlay")?.shadowRoot;
    const rect = (el: Element | null | undefined): DocRect | null => {
      if (!(el instanceof HTMLElement) || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const hint = root?.querySelector(".hint");
    const hintRect = rect(hint);
    return {
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      toolbar: rect(root?.querySelector(".toolbar")),
      hint: hintRect && { ...hintRect, text: hint?.textContent ?? "" },
      buttons: [...(root?.querySelectorAll<HTMLElement>(".toolbar button") ?? [])].map((b) => ({
        label: b.firstChild?.textContent,
        clipped: b.scrollWidth > b.clientWidth || b.scrollHeight > b.clientHeight,
      })),
    };
  });
}

const inside = (r: DocRect, vp: { width: number; height: number }): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height;

for (const width of [1280, 800]) {
  test(`German overlay at ${width} px: labels and hint in German, nothing cut off, all on screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await load(page);
    await page.evaluate(
      (settings) => (window as unknown as { __start(s: unknown): void }).__start(settings),
      {
        ...DEFAULT_SETTINGS,
      },
    );
    const before = await layout(page);
    expect(before.hint?.text).toBe(
      "Element anklicken oder Bereich aufziehen · ↑ ↓ äußeres/inneres Element · Q W E R ausführen · Esc bricht ab",
    );
    expect(before.hint && inside(before.hint, before.viewport)).toBe(true);

    await page.mouse.move(PARA.x + 20, PARA.y + 20);
    await page.mouse.click(PARA.x + 20, PARA.y + 20);
    const shown = await layout(page);
    expect(shown.buttons.map((b) => b.label)).toEqual([
      "SVG speichern",
      "Text kopieren",
      "Elementlink kopieren",
      "Seitenlink kopieren",
      "Abbrechen",
    ]);
    expect(shown.buttons.filter((b) => b.clipped)).toEqual([]);
    expect(shown.toolbar).not.toBeNull();
    expect(shown.toolbar && inside(shown.toolbar, shown.viewport)).toBe(true);
    // One row: every button as high as the first.
    const heights = await page.evaluate(() =>
      [
        ...(document.querySelector("snapii-overlay")?.shadowRoot?.querySelectorAll(".toolbar button") ?? []),
      ].map((b) => Math.round(b.getBoundingClientRect().top)),
    );
    expect(new Set(heights).size).toBe(1);
  });
}

test("German toast: the saved file's name goes in as text, as the page gave it", async ({ page }) => {
  await load(page);
  await page.evaluate((settings) => (window as unknown as { __start(s: unknown): void }).__start(settings), {
    ...DEFAULT_SETTINGS,
  });
  await page.mouse.click(PARA.x + 20, PARA.y + 20);
  await page.keyboard.press("q");
  const toast = () =>
    page.evaluate(() => {
      const box = document.querySelector("snapii-toast")?.shadowRoot?.querySelector(".toast");
      return box ? { text: box.textContent, elements: box.children.length } : null;
    });
  await expect.poll(toast).toEqual({ text: "Überblick & <b>.svg gespeichert", elements: 0 });
});
