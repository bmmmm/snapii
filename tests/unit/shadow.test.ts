// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { outerShadows, spreadRadius } from "../../src/content/extract/shadow.ts";

test("outerShadows: each shadow as numbers, top one first, colours in any form parseColor reads", () => {
  // As both engines write them (measured).
  assert.deepEqual(outerShadows("rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.2) 0px 2px 4px -2px"), [
    { paint: { r: 0, g: 0, b: 0, a: 0.1 }, x: 0, y: 4, blur: 6, spread: -1 },
    { paint: { r: 0, g: 0, b: 0, a: 0.2 }, x: 0, y: 2, blur: 4, spread: -2 },
  ]);
  assert.deepEqual(outerShadows("rgb(255, 0, 0) 2.5px -2px 0px 0px"), [
    { paint: { r: 255, g: 0, b: 0, a: 1 }, x: 2.5, y: -2, blur: 0, spread: 0 },
  ]);
  const ok = outerShadows("oklch(0.6 0.2 30) 0px 0px 0px 3px");
  assert.equal(ok?.length, 1);
  assert.equal(ok?.[0]?.spread, 3);
});

test("outerShadows: fully transparent shadows paint nothing and are left out", () => {
  // Tailwind's ring and shadow utilities stack transparent placeholders.
  assert.deepEqual(
    outerShadows(
      "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px",
    ),
    [{ paint: { r: 0, g: 0, b: 0, a: 0.1 }, x: 0, y: 1, blur: 3, spread: 0 }],
  );
  assert.deepEqual(outerShadows("rgba(0, 0, 0, 0) 0px 0px 0px 0px"), []);
  // Still only an outer shadow this reads: an inset one keeps the whole value null.
  assert.equal(outerShadows("rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(0, 0, 0) 0px 1px 0px 0px inset"), null);
});

test("outerShadows: an inset shadow, or any form this does not read, is null", () => {
  for (const value of [
    "rgb(208, 215, 222) 0px -1px 0px 0px inset",
    "rgba(0, 0, 0, 0.5) 0px 2px 6px 0px, rgb(0, 0, 0) 0px 1px 0px 0px inset",
    "rgb(0, 0, 0) 0px 2px",
    "rgb(0, 0, 0) 1em 2px 3px 0px",
    "rgb(0, 0, 0) calc(1px + 2px) 0px 0px 0px",
    "rgb(x, y, z) 0px 0px 0px 0px",
    "",
  ])
    assert.equal(outerShadows(value), null, value);
});

test("spreadRadius: grows with the spread, less where the radius is smaller than it, never below zero", () => {
  // At least the spread: plain addition.
  assert.equal(spreadRadius(10, 4), 14);
  assert.equal(spreadRadius(4, 4), 8);
  // Smaller: r + s * (1 + (r / s - 1)^3); a square corner stays square.
  assert.equal(spreadRadius(2, 4), 2 + 4 * (1 + (0.5 - 1) ** 3));
  assert.equal(spreadRadius(0, 4), 0);
  // A negative spread shrinks the radius, down to zero.
  assert.equal(spreadRadius(10, -4), 6);
  assert.equal(spreadRadius(3, -4), 0);
  assert.equal(spreadRadius(5, 0), 5);
});
