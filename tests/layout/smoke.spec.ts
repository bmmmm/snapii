// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from "@playwright/test";

test("harness injects into a fixture page", async ({ page }) => {
  await page.goto("/fixtures/smoke.html");
  await page.addScriptTag({ path: "dist-test/harness.js" });
  expect(await page.evaluate(() => typeof window.__snapii)).toBe("object");
});
