// SPDX-License-Identifier: GPL-3.0-or-later
// Which capture API can take the region (decision D1 in docs/development.md). With
// activeTab only, captureVisibleTab is the one path: it captures the selected
// tab of a window and honours an off-viewport `rect` (S1/S2). captureTab does
// not exist without <all_urls> (S3), so it is never a candidate.

import { SPIKE } from "./spike.ts";

export type CaptureStrategy = "visible-tab";

/** The parts of `tabs.Tab` the decision needs. */
export interface StrategyTab {
  /** Whether the tab is the selected tab of its window. */
  active: boolean;
  windowId?: number | undefined;
}

/** The spike facts the decision rests on; a parameter so tests can vary them. */
export interface StrategyFacts {
  visibleTabHonoursRect: boolean;
}

/**
 * `'visible-tab'` when the sender tab is the selected tab of a known window,
 * else `null` — captureVisibleTab would capture another tab or reject with
 * "Missing activeTab permission" (S10). Also `null` if the platform ignored
 * `rect`, because then an off-viewport region would come back wrong.
 */
export function strategyFor(tab: StrategyTab, facts: StrategyFacts = SPIKE): CaptureStrategy | null {
  if (!facts.visibleTabHonoursRect) return null;
  if (!tab.active || tab.windowId === undefined) return null;
  return "visible-tab";
}
