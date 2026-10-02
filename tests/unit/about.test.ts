// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutLine } from "../../src/shared/about.ts";

const BUILT = "2026-10-01T17:40:12.345Z";

test("aboutLine: version, commit, build time in minutes (UTC) and Firefox", () => {
  assert.equal(
    aboutLine("0.1.0", { commit: "c26a3cd", dirty: false, builtAt: BUILT }, "157.0"),
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
    aboutLine("0.1.0", { commit: null, dirty: false, builtAt: BUILT }, "157.0"),
    "snapii 0.1.0 · built 2026-10-01 17:40 UTC · Firefox 157.0",
  );
});
