// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { runsToPlainText } from "../../src/shared/plaintext.ts";
import type { TextRun } from "../../src/shared/types.ts";

const run = (text: string, line: number, block: number): TextRun => ({
  text,
  x: 0,
  y: 0,
  top: 0,
  width: 1,
  height: 1,
  fontFamily: "serif",
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  color: "rgb(0, 0, 0)",
  lang: null,
  dir: "ltr",
  href: null,
  line,
  block,
});

test("runsToPlainText: empty selection is empty text", () => {
  assert.equal(runsToPlainText([]), "");
});

test("runsToPlainText: runs of one line join without separator", () => {
  assert.equal(runsToPlainText([run("Hello ", 0, 0), run("world", 0, 0), run(".", 0, 0)]), "Hello world.");
});

test("runsToPlainText: lines of one block are separated by one newline, blocks by an empty line", () => {
  const runs = [
    run("First line of the", 0, 0),
    run("first paragraph.", 1, 0),
    run("Second ", 2, 1),
    run("paragraph.", 2, 1),
    run("Third.", 3, 2),
  ];
  assert.equal(runsToPlainText(runs), "First line of the\nfirst paragraph.\n\nSecond paragraph.\n\nThird.");
});

test("runsToPlainText: a line made of several blocks (inline-block) stays one line", () => {
  assert.equal(runsToPlainText([run("a ", 0, 0), run("b", 0, 1), run("c", 1, 1)]), "a b\nc");
});
