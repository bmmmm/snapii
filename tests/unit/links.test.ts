// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LinkCandidate, linkFor } from "../../src/shared/links.ts";

const PAGE = "https://p/a";
const a = (href: string | null, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
  tag: "a",
  href,
  role: null,
  baseURL: PAGE,
  pageURL: PAGE,
  ...extra,
});

// The linkFor() table, one row per case.
const rows: [string, LinkCandidate | null, string | null][] = [
  ['a href="/x" on https://p/a', a("/x"), "https://p/x"],
  ["#sec on the same page", a("#sec"), null],
  ["bare #", a("#"), null],
  ["same page, other hash", a("https://p/a#other"), null],
  ["/a#:~:text=foo keeps its text directive", a("/a#:~:text=foo"), "https://p/a#:~:text=foo"],
  ["javascript:void 0", a("javascript:void 0"), null],
  ["mailto:x@y", a("mailto:x@y"), "mailto:x@y"],
  ['href=""', a(""), null],
  ["no href", a(null), null],
  ["a role=button href=https://q", a("https://q", { role: "button" }), "https://q/"],
  ["button formaction=/s", a("/s", { tag: "button", formaction: true }), null],
  ["[role=button] without href", a(null, { tag: "span", role: "button" }), null],
  ["div data-href", a("/x", { tag: "div" }), null],
  ["area href=ftp://h", a("ftp://h", { tag: "area" }), null],
  ["area href=/map", a("/map", { tag: "AREA" }), "https://p/map"],
  ["data: URL", a("data:text/html,x"), null],
  ["blob: URL", a("blob:https://p/123"), null],
  ["file: URL", a("file:///etc/hosts"), null],
  ["other query is another page", a("/a?q=1"), "https://p/a?q=1"],
  ["resolved against <base>, not the page", a("x", { baseURL: "https://cdn/b/" }), "https://cdn/b/x"],
  ["unparsable", a("http://["), null],
  ["no candidate", null, null],
];

for (const [name, candidate, expected] of rows) {
  test(`linkFor: ${name}`, () => {
    assert.equal(linkFor(candidate), expected);
  });
}
