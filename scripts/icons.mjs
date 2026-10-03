// SPDX-License-Identifier: GPL-3.0-or-later
// Rasterises src/icons/icon.svg into the PNGs the Chromium manifest names
// (Chromium takes no SVG icons). Run by hand after the SVG changes:
//   node scripts/icons.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "icons");
const svg = await readFile(join(icons, "icon.svg"), "utf8");

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: join(icons, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
