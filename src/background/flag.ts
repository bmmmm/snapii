// SPDX-License-Identifier: GPL-3.0-or-later
// The shortcut on a page snapii cannot run on (about:, AMO, the PDF viewer,
// view-source:, non-HTML documents): say so on the button for a moment
// instead of failing silently. Tab-specific values, so null restores the
// global ones.
//
// Title first, badge second: the badge is what a reader (and the glue tests)
// take as the signal that a reason is there, so the title has to be in place
// before the badge appears. The other order lost that race twice on
// 2026-10-02 (badge "×" seen with the default title).

/** The action-API calls flagTab needs; parameters so unit tests run without `browser`. */
export interface FlagDeps {
  setBadgeText(details: { tabId: number; text: string | null }): Promise<void>;
  setTitle(details: { tabId: number; title: string | null }): Promise<void>;
}

export const ERROR_BADGE_MS = 3000;

// One notice per tab at a time: a second shortcut press restarts the clock.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export async function flagTab(
  action: FlagDeps,
  tabId: number,
  reason: string,
  badgeMs = ERROR_BADGE_MS,
): Promise<void> {
  await action.setTitle({ tabId, title: `snapii cannot capture this page: ${reason}` });
  await action.setBadgeText({ tabId, text: "×" });
  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      // The tab may be gone by then; nothing to restore in that case.
      action.setBadgeText({ tabId, text: null }).catch(() => {});
      action.setTitle({ tabId, title: null }).catch(() => {});
    }, badgeMs),
  );
}
