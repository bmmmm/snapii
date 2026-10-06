// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPageUrl } from "../../src/shared/cleanurl.ts";

const cases: [name: string, input: string, want: string][] = [
  ["a clean address stays as it is", "https://example.com/a/b?id=7", "https://example.com/a/b?id=7"],
  [
    "utm_* go, other parameters stay in order",
    "https://example.com/p?id=7&utm_source=x&utm_medium=y&page=2",
    "https://example.com/p?id=7&page=2",
  ],
  [
    "only trackers: the whole query goes, no dangling ?",
    "https://example.com/p?utm_source=x&fbclid=abc",
    "https://example.com/p",
  ],
  [
    "click IDs",
    "https://example.com/?gclid=1&msclkid=2&mc_eid=3&igshid=4&srsltid=5&q=a",
    "https://example.com/?q=a",
  ],
  [
    "names match case-insensitively",
    "https://example.com/?UTM_Source=x&FbClid=1&k=v",
    "https://example.com/?k=v",
  ],
  [
    "a percent-encoded name is read before it is compared",
    "https://example.com/?utm%5Fsource=x&k=v",
    "https://example.com/?k=v",
  ],
  [
    "empty pairs are dropped with the trackers",
    "https://example.com/?&a=1&&utm_x=1&",
    "https://example.com/?a=1",
  ],
  [
    "a malformed percent-escape in a name is kept, not dropped",
    "https://example.com/?%ZZ=1&utm_%ZZ=2&a=2",
    "https://example.com/?%ZZ=1&a=2",
  ],
  ["a name without a value", "https://example.com/?utm_source&k=v", "https://example.com/?k=v"],
  [
    "names that merely contain or resemble one stay",
    "https://example.com/?ref=main&source=a&si=1&my_utm_x=1",
    "https://example.com/?ref=main&source=a&si=1&my_utm_x=1",
  ],
  [
    "the spelling of what stays is kept",
    "https://example.com/?q=a+b%20c&x=%C3%A4&utm_term=t",
    "https://example.com/?q=a+b%20c&x=%C3%A4",
  ],
  [
    "a plain fragment stays",
    "https://example.com/doc?utm_source=x#section-2",
    "https://example.com/doc#section-2",
  ],
  ["a text directive goes", "https://example.com/doc#:~:text=Hello-,world", "https://example.com/doc"],
  [
    "a text directive behind a fragment goes, the fragment stays",
    "https://example.com/doc#intro:~:text=Hello",
    "https://example.com/doc#intro",
  ],
  [
    "a text directive and trackers together",
    "https://example.com/doc?utm_campaign=c&id=1#:~:text=a",
    "https://example.com/doc?id=1",
  ],
  [
    "a single-page app's route in the fragment stays",
    "https://example.com/#/inbox?utm_source=x",
    "https://example.com/#/inbox?utm_source=x",
  ],
  ["http", "http://example.com/?gclid=1", "http://example.com/"],
];
for (const [name, input, want] of cases) {
  test(`cleanPageUrl: ${name}`, () => assert.equal(cleanPageUrl(input), want));
}

test("cleanPageUrl without removeTrackers: the query stays as written, a text directive still goes", () => {
  assert.equal(
    cleanPageUrl("https://example.com/doc?utm_source=x&id=1&#intro:~:text=a", false),
    "https://example.com/doc?utm_source=x&id=1&#intro",
  );
});

test("cleanPageUrl: what is not an http(s) address comes back as it was", () => {
  for (const href of ["mailto:a@b.de?utm_source=x", "file:///tmp/a.html?utm_source=x", "not a url", ""]) {
    assert.equal(cleanPageUrl(href), href);
  }
});
