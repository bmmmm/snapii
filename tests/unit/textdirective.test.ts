// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeTextDirective, withTextDirective } from "../../src/shared/textdirective.ts";

test("serializeTextDirective: start only", () => {
  assert.equal(serializeTextDirective({ textStart: "sphinx of quartz" }), "text=sphinx%20of%20quartz");
});

test("serializeTextDirective: '-', ',' and '&' are encoded in every part", () => {
  assert.equal(
    serializeTextDirective({ prefix: "a-b", textStart: "x,y", textEnd: "p&q", suffix: "-z" }),
    "text=a%2Db-,x%2Cy,p%26q,-%2Dz",
  );
});

test("serializeTextDirective: prefix and suffix carry their dashes, empty parts are left out", () => {
  assert.equal(
    serializeTextDirective({ prefix: "The", textStart: "quick fox", suffix: "jumps" }),
    "text=The-,quick%20fox,-jumps",
  );
  assert.equal(serializeTextDirective({ prefix: "", textStart: "a", textEnd: "", suffix: "" }), "text=a");
  assert.equal(serializeTextDirective({ textStart: "a", textEnd: "b" }), "text=a,b");
});

test("serializeTextDirective: non-ASCII is percent-encoded as UTF-8", () => {
  assert.equal(serializeTextDirective({ textStart: "Straße" }), "text=Stra%C3%9Fe");
});

test("withTextDirective: appends to a URL without hash", () => {
  assert.equal(withTextDirective("https://p/a?q=1", "text=x"), "https://p/a?q=1#:~:text=x");
});

test("withTextDirective: keeps the existing hash", () => {
  assert.equal(withTextDirective("https://p/a#sec", "text=x"), "https://p/a#sec:~:text=x");
  assert.equal(withTextDirective("https://p/a#", "text=x"), "https://p/a#:~:text=x");
});

test("withTextDirective: strips a previous directive", () => {
  assert.equal(withTextDirective("https://p/a#:~:text=old", "text=x"), "https://p/a#:~:text=x");
  assert.equal(
    withTextDirective("https://p/a#sec:~:text=old&text=older", "text=x"),
    "https://p/a#sec:~:text=x",
  );
});
