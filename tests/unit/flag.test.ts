// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { flagTab } from "../../src/background/flag.ts";

/**
 * Records every action call in order; each call settles on a later macrotask,
 * like the real API. setBadgeText notes whether the title call had settled by
 * the time the badge was asked for — that is the contract flagTab promises.
 */
function harness() {
  const log: string[] = [];
  let titleSettled = false;
  let badgeAfterSettledTitle: boolean | undefined;
  const action = {
    setBadgeText: async ({ text }: { tabId: number; text: string | null }) => {
      log.push(`badge:${text}`);
      if (text !== null) badgeAfterSettledTitle = titleSettled;
      await sleep(1);
    },
    setTitle: async ({ title }: { tabId: number; title: string | null }) => {
      log.push(`title:${title}`);
      await sleep(1);
      titleSettled = true;
    },
  };
  return { log, action, badgeAfterSettledTitle: () => badgeAfterSettledTitle };
}

test("flagTab: the badge is asked for only once the reason is on the title", async () => {
  const h = harness();
  await flagTab(h.action, 7, "snapii works on HTML pages only", 20);
  assert.deepEqual(h.log, [
    "title:snapii cannot capture this page: snapii works on HTML pages only",
    "badge:×",
  ]);
  assert.equal(h.badgeAfterSettledTitle(), true);
});

test("flagTab: both values are restored to the global ones after the notice", async () => {
  const h = harness();
  await flagTab(h.action, 7, "r", 5);
  assert.equal(h.log.length, 2);
  await sleep(30);
  assert.deepEqual(h.log.slice(2).sort(), ["badge:null", "title:null"]);
});

test("flagTab: a tab that is gone at the start rejects (the caller decides)", async () => {
  const h = harness();
  h.action.setTitle = async () => {
    throw new Error("No tab with id");
  };
  await assert.rejects(flagTab(h.action, 7, "r", 5), /No tab with id/);
});

test("flagTab: a tab that is gone when the notice ends leaves no unhandled rejection", async () => {
  const h = harness();
  await flagTab(h.action, 7, "r", 5);
  let restoreCalls = 0;
  h.action.setBadgeText = async () => {
    restoreCalls++;
    throw new Error("No tab with id");
  };
  h.action.setTitle = async () => {
    restoreCalls++;
    throw new Error("No tab with id");
  };
  await sleep(30); // node:test fails the test on an unhandled rejection
  assert.equal(restoreCalls, 2);
});

test("flagTab: a second notice on the same tab outlives the first one's timer", async () => {
  const h = harness();
  await flagTab(h.action, 7, "a", 5);
  await flagTab(h.action, 7, "b", 40);
  await sleep(20);
  assert.equal(
    h.log.filter((e) => e === "badge:null").length,
    0,
    "the first timer must not clear the second notice",
  );
  await sleep(40);
  assert.equal(h.log.filter((e) => e === "badge:null").length, 1);
});
