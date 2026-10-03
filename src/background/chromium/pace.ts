// SPDX-License-Identifier: GPL-3.0-or-later
// Chromium allows two captureVisibleTab calls a second (C3 in
// src/shared/spike.ts); calls are started one after the other, an interval apart.

export function createPacer(
  intervalMs: number,
  clock: { now(): number; sleep(ms: number): Promise<void> },
): <T>(call: () => Promise<T>) => Promise<T> {
  let last = Number.NEGATIVE_INFINITY;
  let turn: Promise<void> = Promise.resolve();
  return (call) => {
    const mine = turn.then(async () => {
      const wait = last + intervalMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      last = clock.now();
    });
    turn = mine;
    return mine.then(call);
  };
}
