// SPDX-License-Identifier: GPL-3.0-or-later
// The catalogues in src/_locales against the code: every key the source,
// the pages and the manifest use exists in both languages, nothing else does,
// and a message takes the same values in both. Keys are read from the
// source files, not from a list kept here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { msg } from "../../src/shared/i18n.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

interface Entry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}
type Catalogue = Record<string, Entry>;

const catalogue = (lang: string): Catalogue =>
  JSON.parse(readFileSync(join(SRC, "_locales", lang, "messages.json"), "utf8"));
const LOCALES = readdirSync(join(SRC, "_locales")).sort();
const en = catalogue("en");
const de = catalogue("de");

const files = (ext: string): string[] =>
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(ext))
    .map((f) => join(SRC, f));

/** Every key the extension asks for, with where it is asked for. */
function usedKeys(): { keys: Map<string, string>; dynamic: string[] } {
  const keys = new Map<string, string>();
  const dynamic: string[] = [];
  for (const file of files(".ts")) {
    const text = readFileSync(file, "utf8");
    // Every call of msg (its own declaration aside) and what follows the parenthesis.
    for (const m of text.matchAll(/(?<![\w.]|function )msg\(\s*/g)) {
      const literal = /^"(\w+)"/.exec(text.slice((m.index ?? 0) + m[0].length));
      if (literal?.[1]) keys.set(literal[1], file);
      else dynamic.push(`${file}: ${text.slice(m.index, (m.index ?? 0) + 40)}`);
    }
  }
  for (const file of files(".html")) {
    for (const m of readFileSync(file, "utf8").matchAll(/data-i18n(?:-placeholder)?="([^"]*)"/g)) {
      if (m[1] !== undefined) keys.set(m[1], file);
    }
  }
  for (const m of readFileSync(join(SRC, "manifest.json"), "utf8").matchAll(/__MSG_(\w+)__/g)) {
    if (m[1] !== undefined) keys.set(m[1], "manifest.json");
  }
  return { keys, dynamic };
}

test("i18n: the shipped languages are English and German, English the default", () => {
  assert.deepEqual(LOCALES, ["de", "en"]);
  const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
});

test("i18n: every key is a literal in the source, so this test can see it", () => {
  const { keys, dynamic } = usedKeys();
  assert.deepEqual(dynamic, []);
  // The scan found the source at all (one key from each kind of file).
  for (const key of ["toolbarSave", "popupCapture", "extensionDescription"]) assert.ok(keys.has(key), key);
});

test("i18n: every key used in code, pages and manifest exists in each language", () => {
  const { keys } = usedKeys();
  for (const lang of LOCALES) {
    const messages = catalogue(lang);
    const missing = [...keys].filter(([key]) => !(key in messages)).map(([key, file]) => `${key} (${file})`);
    assert.deepEqual(missing, [], `missing in _locales/${lang}`);
  }
});

test("i18n: both languages have the same keys, and none is unused", () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  const { keys } = usedKeys();
  assert.deepEqual(
    Object.keys(en).filter((key) => !keys.has(key)),
    [],
  );
});

test("i18n: key names and messages follow the WebExtension rules", () => {
  for (const lang of LOCALES) {
    for (const [key, entry] of Object.entries(catalogue(lang))) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `${lang}: ${key}`);
      assert.doesNotMatch(key, /^@@/, `${lang}: ${key} is reserved`);
      assert.equal(typeof entry.message, "string", `${lang}: ${key}`);
      assert.notEqual(entry.message.trim(), "", `${lang}: ${key} is empty`);
    }
  }
});

/** The placeholders a message names, and the substitution each one takes. */
function placeholders(entry: Entry): Record<string, string> {
  const named = [...entry.message.matchAll(/\$(\w+)\$/g)].map((m) => (m[1] ?? "").toLowerCase()).sort();
  const declared = Object.keys(entry.placeholders ?? {}).sort();
  assert.deepEqual(named, declared, `"${entry.message}" names exactly its placeholders`);
  // A bare $1 in the message would bypass the placeholders compared below.
  assert.doesNotMatch(entry.message.replace(/\$(\w+)\$/g, ""), /\$\d/, `"${entry.message}"`);
  return Object.fromEntries(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name, p.content]));
}

test("i18n: a message takes the same values in both languages", () => {
  for (const [key, entry] of Object.entries(en)) {
    const german = de[key];
    if (!german) continue; // reported by the key tests
    assert.deepEqual(placeholders(german), placeholders(entry), key);
  }
});

test("i18n: a message whose purpose is not obvious from its words has a description in English", () => {
  for (const [key, entry] of Object.entries(en)) {
    if (entry.placeholders) assert.ok(entry.description || hasExamples(entry), `${key} has values`);
  }
  function hasExamples(entry: Entry): boolean {
    return Object.values(entry.placeholders ?? {}).every((p) => p.example !== undefined);
  }
});

test("i18n: without a browser the English catalogue answers, substitutions included", () => {
  assert.equal(typeof (globalThis as { browser?: unknown }).browser, "undefined");
  assert.equal(msg("toolbarSave"), "Save SVG");
  assert.equal(msg("toastSaved", "Example Domain.svg"), "Saved Example Domain.svg");
  assert.equal(msg("shortcutRefused", "Shift+S", "why"), "Shift+S: why");
  // A value is inserted as it is, never read as a placeholder or as markup.
  assert.equal(msg("toastSaved", "$FILENAME$ $1 $$ <b>"), "Saved $FILENAME$ $1 $$ <b>");
});

test("i18n: the manifest reads as before in English", () => {
  const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
  const resolve = (s: string): string =>
    s.replace(/__MSG_(\w+)__/g, (_, key: string) => en[key]?.message ?? "");
  assert.equal(manifest.name, "snapii");
  assert.equal(
    resolve(manifest.description),
    "Save a page region as SVG with real, selectable text and clickable links.",
  );
  assert.equal(resolve(manifest.action.default_title), "snapii: capture region as SVG");
  assert.equal(resolve(manifest.commands["start-capture"].description), "Capture a region");
  assert.equal(resolve(manifest.commands._execute_action.description), "Open the snapii menu");
});
