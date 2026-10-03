// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { chromiumAction } from "../../../src/background/chromium/action.ts";
import { flagTab } from "../../../src/background/flag.ts";

/** Chromium's action API as measured (C13): a null badge text is fine, a null title rejects. */
function chromium() {
  const log: string[] = [];
  return {
    log,
    action: {
      async setBadgeText({ text }: { tabId: number; text: string | null }) {
        log.push(`badge:${text}`);
      },
      async setTitle(details: { tabId: number; title: string }) {
        if (typeof details.title !== "string") throw new Error("Missing required property 'title'.");
        log.push(`title:${details.title}`);
      },
    },
  };
}

test("chromiumAction: the notice ends with the manifest's title back on the button", async () => {
  const c = chromium();
  await flagTab(chromiumAction(c.action, "snapii: capture region as SVG"), 7, "reason", 5);
  await sleep(30);
  assert.deepEqual(c.log.slice(0, 2), ["title:snapii cannot capture this page: reason", "badge:×"]);
  assert.deepEqual(c.log.slice(2).sort(), ["badge:null", "title:snapii: capture region as SVG"]);
});
