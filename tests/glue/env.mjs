// SPDX-License-Identifier: GPL-3.0-or-later
// Shared setup of the end-to-end glue tests: one headless Firefox (the
// installed release, DPR 2) per test file with dist/ as a temporary add-on,
// a fixture server over tests/, downloads into a temp dir without a dialog,
// and the input/screenshot/SVG helpers the checklist items need.
//
// Ports: fixture server 8460+n, Marionette 2960+n (n = the file's slot), so
// the files can run in parallel; SNAPII_GLUE_PORT_OFFSET shifts both, so a
// second checkout can run the suite at the same time. Firefox must run
// outside a process sandbox. SNAPII_GLUE_OUT keeps profiles, logs and
// downloads somewhere known.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "../../tools/marionette/driver.mjs";
import { launchFirefox, sleep } from "../../tools/marionette/firefox.mjs";
import { startServer } from "../../tools/marionette/server.mjs";

export { boundsOf, decodeDataUrl, decodePng, parseSvg } from "../../tools/marionette/svg.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ADDON_ID = "snapii@qmmq.de";
export const PROBE_EXT = join(ROOT, "tests/glue/probe-ext");
export { sleep };

// Headless screen in device px; with devPixelsPerPx 2 the window is 1280x800
// CSS px and the viewport 1280x715 (measured on Firefox 157).
const HEADLESS_ENV = { MOZ_HEADLESS_WIDTH: "2560", MOZ_HEADLESS_HEIGHT: "1600" };

/** The strict policy of checklist item 11, as an HTTP header (meta tags cannot set every directive). */
export const STRICT_CSP = "style-src 'none'; script-src 'none'";

const PORT_OFFSET = Number(process.env.SNAPII_GLUE_PORT_OFFSET ?? 0);

/**
 * Starts server + Firefox for one test file. Call `close()` in `after`.
 * @param {number} slot 0–9
 */
export async function startGlue(slot, { prefs = {} } = {}) {
  const out = process.env.SNAPII_GLUE_OUT
    ? join(process.env.SNAPII_GLUE_OUT, `slot${slot}`)
    : mkdtempSync(join(tmpdir(), `snapii-glue-${slot}-`));
  const downloads = join(out, "downloads");
  mkdirSync(downloads, { recursive: true });
  const server = await startServer({
    root: join(ROOT, "tests"),
    port: 8460 + PORT_OFFSET + slot,
    headers: (url) =>
      url.pathname === "/glue/fixtures/csp.html" ? { "content-security-policy": STRICT_CSP } : undefined,
  });
  let s;
  try {
    s = await launchFirefox({
      port: 2960 + PORT_OFFSET + slot,
      profileRoot: join(out, "profiles"),
      env: HEADLESS_ENV,
      prefs: {
        "layout.css.devPixelsPerPx": "2",
        "browser.download.folderList": 2,
        "browser.download.dir": downloads,
        "browser.download.useDownloadDir": true,
        // Keeps the downloads panel from opening over the page after each save.
        "browser.download.alwaysOpenPanel": false,
        ...prefs,
      },
    });
    await s.installAddon(join(ROOT, "dist"));
  } catch (e) {
    await s?.quit();
    await server.close();
    throw e;
  }
  return new Glue(s, server, out, downloads);
}

/** A Driver plus the fixture server; `open` takes paths relative to it. */
export class Glue extends Driver {
  constructor(s, server, out, downloads) {
    super(s, { addonId: ADDON_ID, downloads });
    this.server = server;
    this.base = server.url;
    this.out = out;
  }

  async close() {
    await this.s.quit();
    await this.server.close();
  }

  /** Loads a page and waits until it has painted. */
  async open(path) {
    await super.open(path.includes(":") ? path : `${this.base}${path}`);
  }
}
