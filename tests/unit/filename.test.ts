// SPDX-License-Identifier: GPL-3.0-or-later
// Each test file runs in its own process, so pinning the zone here is local.
process.env.TZ = "Europe/Berlin";

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FILENAME_LENGTH, makeFilename } from "../../src/shared/filename.ts";
import type { PageMeta } from "../../src/shared/types.ts";

const page = (over: Partial<PageMeta>): PageMeta => ({
  url: "https://www.example.com/path?q=1",
  title: "Example",
  lang: "en",
  textFragmentURL: null,
  textFragmentStatus: "DISABLED",
  viewport: { width: 1280, height: 715 },
  scroll: { x: 0, y: 0 },
  devicePixelRatio: 2,
  // 12:03:04 UTC is 14:03:04 in Berlin (CEST).
  capturedAt: "2026-10-01T12:03:04.000Z",
  mode: "drag",
  skippedFrames: 0,
  skippedVertical: 0,
  ...over,
});

// \p{Cc} = C0, DEL and C1 control characters.
const FORBIDDEN = /[/\\:*?"<>|\p{Cc}]/u;

test("makeFilename: title and local time", () => {
  assert.equal(makeFilename(page({})), "snapii Example 2026-10-01 14-03-04.svg");
});

test("makeFilename: falls back to the host when the title is empty or only unsafe characters", () => {
  assert.equal(makeFilename(page({ title: "" })), "snapii www.example.com 2026-10-01 14-03-04.svg");
  assert.equal(makeFilename(page({ title: ' /:*?"<>| ' })), "snapii www.example.com 2026-10-01 14-03-04.svg");
  assert.equal(makeFilename(page({ title: "", url: "about:blank" })), "snapii 2026-10-01 14-03-04.svg");
  assert.equal(makeFilename(page({ title: "", url: "nonsense", capturedAt: "x" })), "snapii.svg");
});

test('makeFilename: no / \\ : * ? " < > | or control characters, whitespace collapsed', () => {
  const titles = [
    'a/b\\c:d*e?f"g<h>i|j',
    "../../etc/passwd",
    "tab\there\nnewline\r\u0000nul\u007fdel\u0085nel",
    "C:\\Windows\\system32",
    "bidi \u202egvs.exe\u202c",
    "line\u2028sep\u2029para",
  ];
  for (const title of titles) {
    const name = makeFilename(page({ title }));
    assert.doesNotMatch(name, FORBIDDEN, name);
    assert.doesNotMatch(name, /[\u202a-\u202e\u2028\u2029]|\s{2}/u, name);
    assert.ok(name.endsWith(".svg"));
  }
  assert.equal(makeFilename(page({ title: "a/b" })), "snapii a b 2026-10-01 14-03-04.svg");
});

test("makeFilename: at most 120 characters including the extension, surrogate pairs kept whole", () => {
  for (const title of ["x".repeat(500), "😀".repeat(200), `${"y".repeat(88)}😀tail`, "word ".repeat(100)]) {
    const name = makeFilename(page({ title }));
    assert.ok(name.length <= MAX_FILENAME_LENGTH, `${name.length}: ${name}`);
    assert.equal(MAX_FILENAME_LENGTH, 120);
    assert.ok(name.endsWith(" 2026-10-01 14-03-04.svg"), name);
    assert.doesNotMatch(name, /[\ud800-\udbff](?![\udc00-\udfff])/u, "lone high surrogate");
    assert.doesNotMatch(name, /\s{2}/u);
  }
  assert.equal(makeFilename(page({ title: "x".repeat(500) })).length, 120);
});
