// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DataUrlDownloadDeps, saveSvgAsDataURL } from "../../../src/background/chromium/download.ts";

type Item = { state: string; error?: string };

/** Chromium's downloads API as measured (C16): download() resolves at once, the outcome comes later. */
function deps(states: (Item | undefined)[]) {
  const log: string[] = [];
  const d: DataUrlDownloadDeps = {
    async toDataURL(svg) {
      return `data:${svg}`;
    },
    async download(options) {
      log.push(`download:${JSON.stringify(options)}`);
      return 5;
    },
    async find(id) {
      assert.equal(id, 5);
      const item = states.length > 1 ? states.shift() : states[0];
      log.push(`find:${item?.state}`);
      return item;
    },
    async sleep() {
      log.push("sleep");
    },
  };
  return { d, log };
}

test("saveSvgAsDataURL: the SVG goes out as a data: URL and the save ends when the download is complete", async () => {
  const { d, log } = deps([{ state: "complete" }]);
  assert.equal(await saveSvgAsDataURL("<svg/>", "Pages/x.svg", false, d), 5);
  assert.deepEqual(log, [
    'download:{"url":"data:<svg/>","filename":"Pages/x.svg","saveAs":false}',
    "find:complete",
  ]);
});

test("saveSvgAsDataURL: while the Save-as dialog is open the save waits", async () => {
  const { d, log } = deps([{ state: "in_progress" }, { state: "in_progress" }, { state: "complete" }]);
  assert.equal(await saveSvgAsDataURL("<svg/>", "x.svg", true, d), 5);
  assert.deepEqual(log.slice(1), ["find:in_progress", "sleep", "find:in_progress", "sleep", "find:complete"]);
});

test("saveSvgAsDataURL: a cancelled Save-as dialog rejects, like Firefox's download()", async () => {
  const { d } = deps([{ state: "in_progress" }, { state: "interrupted", error: "USER_CANCELED" }]);
  await assert.rejects(
    saveSvgAsDataURL("<svg/>", "x.svg", true, d),
    new Error("Download canceled by the user"),
  );
});

test("saveSvgAsDataURL: any other interruption rejects with the browser's reason", async () => {
  const { d } = deps([{ state: "interrupted", error: "FILE_NO_SPACE" }]);
  await assert.rejects(
    saveSvgAsDataURL("<svg/>", "x.svg", false, d),
    new Error("the download was interrupted: FILE_NO_SPACE"),
  );
});

test("saveSvgAsDataURL: a download the browser no longer knows rejects", async () => {
  const { d } = deps([undefined]);
  await assert.rejects(saveSvgAsDataURL("<svg/>", "x.svg", false, d), /no longer knows the download/);
});
