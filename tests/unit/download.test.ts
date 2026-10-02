// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDownloader } from "../../src/background/download.ts";

interface Call {
  url: string;
  resolve(id: number): void;
  reject(e: Error): void;
}

/** A downloader on stubbed APIs; each download() waits until the test settles it. */
function harness() {
  const calls: Call[] = [];
  const revoked: string[] = [];
  let n = 0;
  const d = createDownloader({
    download: ({ url }) =>
      new Promise<number>((resolve, reject) => {
        calls.push({ url, resolve, reject });
      }),
    createObjectURL: () => `blob:test/${++n}`,
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
  });
  const changed = (id: number, current: string) => d.onChanged({ id, state: { current } });
  return { d, calls, revoked, changed };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

test("download: revoked on complete, never before download() resolves", async () => {
  const { d, calls, revoked, changed } = harness();
  const saved = d.saveSvg("<svg/>", "a.svg", false);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(revoked, []);
  calls[0]?.resolve(7);
  assert.equal(await saved, 7);
  // Resolved but still downloading: the URL must stay alive.
  assert.deepEqual(revoked, []);
  changed(7, "in_progress");
  assert.deepEqual(revoked, []);
  changed(7, "complete");
  assert.deepEqual(revoked, ["blob:test/1"]);
  // A repeated terminal event does not revoke twice.
  changed(7, "complete");
  assert.deepEqual(revoked, ["blob:test/1"]);
});

test("download: revoked on interrupted", async () => {
  const { d, calls, revoked, changed } = harness();
  const saved = d.saveSvg("<svg/>", "a.svg", false);
  await flush();
  calls[0]?.resolve(3);
  await saved;
  changed(3, "interrupted");
  assert.deepEqual(revoked, ["blob:test/1"]);
});

test("download: revoked when download() rejects (Save-as cancel), error passed on", async () => {
  const { d, calls, revoked } = harness();
  const saved = d.saveSvg("<svg/>", "a.svg", true);
  await flush();
  assert.deepEqual(revoked, []);
  calls[0]?.reject(new Error("Download canceled by the user"));
  await assert.rejects(saved, /canceled/);
  assert.deepEqual(revoked, ["blob:test/1"]);
});

test("download: a terminal state before download() resolves revokes on resolve, not before", async () => {
  const { d, calls, revoked, changed } = harness();
  const saved = d.saveSvg("<svg/>", "a.svg", false);
  await flush();
  changed(9, "complete");
  assert.deepEqual(revoked, []);
  calls[0]?.resolve(9);
  await saved;
  assert.deepEqual(revoked, ["blob:test/1"]);
});

test("download: unrelated downloads are not retained", async () => {
  const { d, calls, revoked, changed } = harness();
  // Download ids never repeat in Firefox; reusing them here is the probe: a
  // remembered id would make saveSvg revoke while its download still runs.
  // Finished while nothing of ours was pending (some other download).
  changed(50, "complete");
  const first = d.saveSvg("<svg/>", "a.svg", false);
  await flush();
  calls[0]?.resolve(50);
  await first;
  assert.deepEqual(revoked, []);
  // Finished while one of ours was pending, but not ours.
  const second = d.saveSvg("<svg/>", "b.svg", false);
  await flush();
  changed(51, "interrupted");
  calls[1]?.resolve(2);
  await second;
  const third = d.saveSvg("<svg/>", "c.svg", false);
  await flush();
  calls[2]?.resolve(51);
  await third;
  assert.deepEqual(revoked, []);
  changed(50, "complete");
  changed(51, "complete");
  assert.deepEqual(revoked, ["blob:test/1", "blob:test/3"]);
});

test("download: concurrent calls each get their early terminal state", async () => {
  const { d, calls, revoked, changed } = harness();
  const a = d.saveSvg("<svg/>", "a.svg", false);
  const b = d.saveSvg("<svg/>", "b.svg", false);
  await flush();
  changed(2, "complete");
  calls[0]?.resolve(1);
  await a;
  assert.deepEqual(revoked, []);
  // b's early event survives a's settling.
  calls[1]?.resolve(2);
  await b;
  assert.deepEqual(revoked, ["blob:test/2"]);
  changed(1, "complete");
  assert.deepEqual(revoked, ["blob:test/2", "blob:test/1"]);
});
