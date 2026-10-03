// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPacer } from "../../../src/background/chromium/pace.ts";

/** A clock that only moves when the pacer sleeps. */
function clock() {
  let now = 1000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

test("createPacer: calls made at the same moment start at least the interval apart", async () => {
  const c = clock();
  const paced = createPacer(550, c);
  const starts: number[] = [];
  await Promise.all([1, 2, 3].map(() => paced(async () => void starts.push(c.now()))));
  assert.deepEqual(starts, [1000, 1550, 2100]);
});

test("createPacer: a call after a pause starts at once, and a failed call does not block the next", async () => {
  const c = clock();
  const paced = createPacer(550, c);
  await assert.rejects(
    paced(async () => {
      throw new Error("quota");
    }),
    /quota/,
  );
  await c.sleep(2000);
  const t = c.now();
  assert.equal(await paced(async () => c.now()), t);
});
