// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidSetting, loadSettings } from "../../src/background/settings.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { Settings } from "../../src/shared/types.ts";

const stored = (values: Record<string, unknown>) => async () => values;

// Valid and different from every default, so a kept value is distinguishable.
const GOOD: Settings = {
  format: "jpeg",
  jpegQuality: 0.5,
  maxTotalPixels: 50_000_000,
  maxTilePixels: 8_000_000,
  saveAs: true,
  saveFolder: "Pages/snapii",
  occlusionCheck: true,
  textFragment: false,
  ocr: true,
};

test("loadSettings: valid stored values replace the defaults", async () => {
  for (const [key, value] of Object.entries(GOOD)) {
    assert.notDeepEqual(value, DEFAULT_SETTINGS[key as keyof Settings], key);
  }
  assert.deepEqual(await loadSettings(stored({ ...GOOD })), GOOD);
  // Range edges are inclusive for the quality.
  assert.equal((await loadSettings(stored({ jpegQuality: 0 }))).jpegQuality, 0);
  assert.equal((await loadSettings(stored({ jpegQuality: 1 }))).jpegQuality, 1);
});

test("loadSettings: nothing stored gives the defaults", async () => {
  assert.deepEqual(await loadSettings(stored({})), DEFAULT_SETTINGS);
});

// Each bad value falls back to its own default; every other field keeps the stored value.
const BAD: Array<[keyof Settings, unknown]> = [
  ["format", "webp"],
  ["format", "PNG"],
  ["format", 1],
  ["jpegQuality", 1.01],
  ["jpegQuality", -0.1],
  ["jpegQuality", Number.NaN],
  ["jpegQuality", "0.5"],
  ["maxTotalPixels", 0],
  ["maxTotalPixels", -5],
  ["maxTotalPixels", Number.POSITIVE_INFINITY],
  ["maxTotalPixels", Number.NaN],
  ["maxTotalPixels", "100"],
  ["maxTilePixels", 0],
  ["maxTilePixels", Number.POSITIVE_INFINITY],
  ["maxTilePixels", null],
  ["saveAs", "true"],
  ["saveAs", 1],
  ["saveFolder", 5],
  ["saveFolder", null],
  ["saveFolder", "/etc"],
  ["saveFolder", "C:\\Users"],
  ["saveFolder", "../x"],
  ["saveFolder", "a/../b"],
  ["saveFolder", "a:b"],
  ["saveFolder", "x".repeat(81)],
  ["saveFolder", ".hidden"],
  ["saveFolder", "100%"],
  ["saveFolder", "a\u00a0b"],
  ["saveFolder", "a."],
  // Valid once normalised, but the pages store the normalised form only.
  ["saveFolder", " snapii"],
  ["saveFolder", "a//b"],
  ["saveFolder", "a\\b"],
  ["saveFolder", "a/"],
  ["occlusionCheck", null],
  ["occlusionCheck", 0],
  ["textFragment", "false"],
  ["textFragment", {}],
  ["ocr", "true"],
  ["ocr", 1],
  ["ocr", null],
];

test("loadSettings: a bad type or range falls back for that field only", async () => {
  for (const [key, value] of BAD) {
    const settings = await loadSettings(stored({ ...GOOD, [key]: value }));
    assert.deepEqual(settings, { ...GOOD, [key]: DEFAULT_SETTINGS[key] }, `${key} = ${String(value)}`);
  }
});

test("loadSettings: a storage error gives the defaults", async () => {
  const settings = await loadSettings(async () => {
    throw new Error("storage unavailable");
  });
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  // A fresh object: callers may not mutate the shared defaults through it.
  assert.notEqual(settings, DEFAULT_SETTINGS);
});

test("isValidSetting: the same per-field verdicts loadSettings applies", () => {
  for (const [key, value] of Object.entries(GOOD)) {
    assert.equal(isValidSetting(key as keyof Settings, value), true, key);
  }
  for (const [key, value] of BAD)
    assert.equal(isValidSetting(key, value), false, `${key} = ${String(value)}`);
});
