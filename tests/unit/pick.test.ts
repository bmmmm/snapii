// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChainEntry, PICK_LIMITS, pickCandidate } from "../../src/shared/pick.ts";

const VP = { width: 1280, height: 720 };

const e = (tag: string, width: number, height: number, extra: Partial<ChainEntry> = {}): ChainEntry => ({
  tag,
  role: null,
  display: "block",
  width,
  height,
  ...extra,
});

const BODY = e("BODY", 1280, 3000);
const HTML = e("HTML", 1280, 3000);

test("PICK_LIMITS: Firefox Screenshots thresholds", () => {
  assert.equal(PICK_LIMITS.minW, 100);
  assert.equal(PICK_LIMITS.minH, 30);
  // max(client + 100, floor): the floor wins on small viewports.
  assert.equal(PICK_LIMITS.maxW(1280), 1380);
  assert.equal(PICK_LIMITS.maxW(800), 1000);
  assert.equal(PICK_LIMITS.maxH(720), 820);
  assert.equal(PICK_LIMITS.maxH(500), 700);
});

test("the element under the pointer wins when it qualifies", () => {
  assert.equal(pickCandidate([e("P", 600, 80), e("DIV", 800, 400), BODY, HTML], VP), 0);
});

test("too small entries are skipped in either dimension, the boundary itself qualifies", () => {
  assert.equal(pickCandidate([e("SPAN", 99, 80), e("P", 600, 80), BODY], VP), 1);
  assert.equal(pickCandidate([e("DIV", 600, 29), e("P", 600, 80), BODY], VP), 1);
  assert.equal(pickCandidate([e("DIV", 100, 30), e("P", 600, 80), BODY], VP), 0);
});

test("inline and display:contents boxes are skipped", () => {
  const chain = [
    e("A", 300, 40, { display: "inline" }),
    e("DIV", 300, 40, { display: "contents" }),
    e("LI", 300, 40),
    BODY,
  ];
  assert.equal(pickCandidate(chain, VP), 2);
  assert.equal(pickCandidate([e("SPAN", 300, 40, { display: "inline-block" }), BODY], VP), 0);
});

test("H1–H6 are never picked; the walk continues to the enclosing block", () => {
  for (const h of ["H1", "H2", "H3", "H4", "H5", "H6", "h2"]) {
    assert.equal(pickCandidate([e(h, 600, 40), e("SECTION", 800, 300), BODY], VP), 1, h);
  }
});

test("the walk stops at BODY/HTML and at an ancestor above the max", () => {
  assert.equal(pickCandidate([e("SPAN", 20, 10), BODY, HTML], VP), -1);
  assert.equal(pickCandidate([e("SPAN", 20, 10), HTML], VP), -1);
  // 1381 > maxW(1280): the oversized wrapper ends the walk, its parent is never reached.
  assert.equal(pickCandidate([e("SPAN", 20, 10), e("DIV", 1381, 200), e("DIV", 600, 200), BODY], VP), -1);
  assert.equal(pickCandidate([e("SPAN", 20, 10), e("DIV", 600, 821), BODY], VP), -1);
  // Exactly at the max still qualifies.
  assert.equal(pickCandidate([e("DIV", 1380, 820), BODY], VP), 0);
  assert.equal(pickCandidate([], VP), -1);
});

test("an article ancestor within the max is preferred", () => {
  const chain = [e("P", 600, 80), e("DIV", 640, 200), e("ARTICLE", 700, 500), BODY];
  assert.equal(pickCandidate(chain, VP), 2);
  const role = [e("P", 600, 80), e("DIV", 700, 500, { role: "article" }), BODY];
  assert.equal(pickCandidate(role, VP), 1);
});

test("an oversized nearest article is ignored, and only the nearest one counts", () => {
  const big = [e("P", 600, 80), e("ARTICLE", 700, 2000), BODY];
  assert.equal(pickCandidate(big, VP), 0);
  const nested = [e("P", 600, 80), e("ARTICLE", 700, 2000), e("DIV", 700, 300, { role: "article" }), BODY];
  assert.equal(pickCandidate(nested, VP), 0);
});

test("articles above BODY are not considered, nor when nothing qualifies", () => {
  assert.equal(pickCandidate([e("P", 600, 80), BODY, e("ARTICLE", 700, 500)], VP), 0);
  assert.equal(pickCandidate([e("SPAN", 20, 10), e("ARTICLE", 700, 500), BODY], VP), 1);
  assert.equal(pickCandidate([e("SPAN", 20, 10), BODY], VP), -1);
});
