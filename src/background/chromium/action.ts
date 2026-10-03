// SPDX-License-Identifier: GPL-3.0-or-later
// The toolbar button's notice in Chromium. flagTab restores the tab's badge
// and title by setting null; Chromium clears a badge that way but rejects a
// null title ("Missing required property 'title'", C13 in src/shared/spike.ts),
// so the manifest's own title is set again.

import type { FlagDeps } from "../flag.ts";

interface ChromiumAction {
  setBadgeText(details: { tabId: number; text: string | null }): Promise<void>;
  setTitle(details: { tabId: number; title: string }): Promise<void>;
}

export function chromiumAction(action: ChromiumAction, defaultTitle: string): FlagDeps {
  return {
    setBadgeText: (details) => action.setBadgeText(details),
    setTitle: ({ tabId, title }) => action.setTitle({ tabId, title: title ?? defaultTitle }),
  };
}
