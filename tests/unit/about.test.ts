// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutLine, chromiumLabel } from "../../src/shared/about.ts";

const BUILT = "2026-10-01T17:40:12.345Z";

test("aboutLine: version, commit, build time in minutes (UTC) and Firefox", () => {
  assert.equal(
    aboutLine("0.1.0", { commit: "c26a3cd", dirty: false, builtAt: BUILT }, "Firefox 157.0"),
    "snapii 0.1.0 · c26a3cd · built 2026-10-01 17:40 UTC · Firefox 157.0",
  );
});

test("aboutLine: a build from a dirty tree says so", () => {
  assert.equal(
    aboutLine("0.1.0", { commit: "c26a3cd", dirty: true, builtAt: BUILT }, null),
    "snapii 0.1.0 · c26a3cd (+ local changes) · built 2026-10-01 17:40 UTC",
  );
});

test("aboutLine: no build info (a rebuild without git) still names the version", () => {
  assert.equal(aboutLine("0.1.0", null, null), "snapii 0.1.0");
  assert.equal(
    aboutLine("0.1.0", { commit: null, dirty: false, builtAt: BUILT }, "Firefox 157.0"),
    "snapii 0.1.0 · built 2026-10-01 17:40 UTC · Firefox 157.0",
  );
});

test("chromiumLabel: the browser's own brand and version, Chromium when it has no other", () => {
  const userAgent =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
  const notABrand = { brand: "Not_A Brand", version: "8" };
  const chromium = { brand: "Chromium", version: "153" };
  assert.equal(
    chromiumLabel({ userAgent, userAgentData: { brands: [chromium, notABrand] } }),
    "Chromium 153",
  );
  assert.equal(
    chromiumLabel({
      userAgent,
      userAgentData: { brands: [notABrand, chromium, { brand: "Microsoft Edge", version: "153" }] },
    }),
    "Microsoft Edge 153",
  );
  // No brand list (an older or stripped-down build): the Chrome/ token.
  assert.equal(chromiumLabel({ userAgent }), "Chromium 153.0.0.0");
  assert.equal(chromiumLabel({ userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/157.0" }), null);
});
