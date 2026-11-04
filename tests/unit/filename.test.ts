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

test("makeFilename: at most 120 UTF-8 bytes including the extension, surrogate pairs kept whole", () => {
  for (const title of [
    "x".repeat(500),
    "😀".repeat(200),
    `${"y".repeat(88)}😀tail`,
    "word ".repeat(100),
    "日本語".repeat(60),
    "ä".repeat(300),
  ]) {
    const name = makeFilename(page({ title }));
    assert.ok(name.length <= MAX_FILENAME_LENGTH, `${name.length}: ${name}`);
    assert.ok(Buffer.byteLength(name) <= MAX_FILENAME_LENGTH, `${Buffer.byteLength(name)} bytes: ${name}`);
    assert.equal(MAX_FILENAME_LENGTH, 120);
    assert.ok(name.endsWith(" 2026-10-01 14-03-04.svg"), name);
    assert.doesNotMatch(name, /[\ud800-\udbff](?![\udc00-\udfff])/u, "lone high surrogate");
    assert.doesNotMatch(name, /\s{2}/u);
  }
  assert.equal(makeFilename(page({ title: "x".repeat(500) })).length, 120);
});

test("makeFilename: noncharacters and lone surrogates from the title are removed", () => {
  // With U+FFFE or U+FDD0 in the name the file cannot be created and
  // downloads.download() never settles; a lone surrogate is refused
  // (measured on macOS, Firefox 157).
  const name = makeFilename(page({ title: "Report￾﷐ Q\uD83D3\uDE00 end" }));
  assert.equal(name, "snapii Report Q 3 end 2026-10-01 14-03-04.svg");
  assert.doesNotMatch(name, /[\p{Cn}\p{Cs}]/u);
  assert.doesNotMatch(name, /[\ud800-\udfff]/u, "lone surrogate");
});

test("makeFilename: the title is cut by its UTF-8 bytes, 1, 2, 3 or 4 per code point", () => {
  // 120 bytes less "snapii ", " 2026-10-01 14-03-04" and ".svg" leave 89 for the title.
  const fits = (cp: number): number => {
    const unit = String.fromCodePoint(cp);
    const name = makeFilename(page({ title: unit.repeat(100) }));
    return [...name.slice("snapii ".length, -" 2026-10-01 14-03-04.svg".length)].length;
  };
  // At each end of a width: the first code point a title keeps (U+0000-U+00A0 are
  // control characters or whitespace) and the last before the next width.
  for (const [cp, count] of [
    [0x21, 89],
    [0x7e, 89],
    [0xa1, 44],
    [0x7ff, 44],
    [0x800, 29],
    [0xfffd, 29],
    [0x10000, 22],
    [0x10fffd, 22],
  ] as [number, number][]) {
    assert.equal(fits(cp), count, `U+${cp.toString(16)}`);
  }
});

test("makeFilename: without a time the title gets its bytes", () => {
  const name = makeFilename(page({ title: "x".repeat(200), capturedAt: "not a date" }));
  assert.equal(name, `snapii ${"x".repeat(109)}.svg`);
  assert.equal(name.length, MAX_FILENAME_LENGTH);
});
