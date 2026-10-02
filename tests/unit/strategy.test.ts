// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { strategyFor } from "../../src/shared/strategy.ts";

test("strategyFor: D1 decision matrix", () => {
  const cases = [
    { tab: { active: true, windowId: 1 }, honours: true, want: "visible-tab" },
    { tab: { active: false, windowId: 1 }, honours: true, want: null },
    { tab: { active: true, windowId: undefined }, honours: true, want: null },
    { tab: { active: true, windowId: 1 }, honours: false, want: null },
    { tab: { active: false, windowId: 1 }, honours: false, want: null },
  ] as const;
  for (const c of cases) {
    assert.equal(
      strategyFor(c.tab, { visibleTabHonoursRect: c.honours }),
      c.want,
      `active=${c.tab.active} windowId=${c.tab.windowId} honours=${c.honours}`,
    );
  }
});

test("strategyFor: the measured facts (SPIKE) select captureVisibleTab for the selected tab only", () => {
  assert.equal(strategyFor({ active: true, windowId: 3 }), "visible-tab");
  assert.equal(strategyFor({ active: false, windowId: 3 }), null);
});
