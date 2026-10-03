// SPDX-License-Identifier: GPL-3.0-or-later
// Shared setup of the Chromium glue tests, the counterpart of
// tests/glue/env.mjs: one headless Chromium (Playwright's pinned build,
// device scale factor 2) per test file with dist-chromium/ loaded, the same
// fixture server over tests/ and downloads into a temp dir.
//
// Ports: fixture server 8470+n, DevTools 2970+n (n = the file's slot);
// SNAPII_GLUE_PORT_OFFSET shifts both. snapii.test resolves to 127.0.0.1 and
// is, unlike it, no secure origin.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver, launchChromium, sleep } from "../../tools/chromium/driver.mjs";
import { startServer } from "../../tools/marionette/server.mjs";

export { boundsOf, decodeDataUrl, decodePng, parseSvg } from "../../tools/marionette/svg.mjs";
export { sleep };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NON_SECURE_HOST = "snapii.test";

const PORT_OFFSET = Number(process.env.SNAPII_GLUE_PORT_OFFSET ?? 0);

/**
 * Starts server + Chromium for one test file. Call `close()` in `after`.
 * @param {number} slot 0–9
 */
export async function startGlue(slot) {
  const out = process.env.SNAPII_GLUE_OUT
    ? join(process.env.SNAPII_GLUE_OUT, `chromium-slot${slot}`)
    : mkdtempSync(join(tmpdir(), `snapii-glue-chromium-${slot}-`));
  const downloads = join(out, "downloads");
  mkdirSync(downloads, { recursive: true });
  const server = await startServer({ root: join(ROOT, "tests"), port: 8470 + PORT_OFFSET + slot });
  try {
    const driver = await launchChromium({
      extension: join(ROOT, "dist-chromium"),
      profile: join(out, "profile"),
      downloads,
      debugPort: 2970 + PORT_OFFSET + slot,
      hostRules: `MAP ${NON_SECURE_HOST} 127.0.0.1`,
    });
    return new Glue(driver, server, out);
  } catch (e) {
    await server.close();
    throw e;
  }
}

/** A Driver plus the fixture server; `open` takes paths relative to it. */
export class Glue extends Driver {
  constructor(driver, server, out) {
    super(driver);
    this.server = server;
    this.base = server.url;
    this.out = out;
  }

  async close() {
    await this.quit();
    await this.server.close();
  }

  async open(path) {
    await super.open(path.includes(":") ? path : `${this.base}${path}`);
  }
}
