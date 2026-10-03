// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkFolder,
  describeFolderProblem,
  type FolderProblem,
  MAX_FOLDER_LENGTH,
} from "../../src/shared/folder.ts";

const folder = (input: string): string | FolderProblem => {
  const check = checkFolder(input);
  return check.ok ? check.folder : check.reason;
};

test("checkFolder: nothing, blanks and bare dots are the download folder itself", () => {
  for (const input of ["", "   ", ".", "./", " . / . "])
    assert.equal(folder(input), "", JSON.stringify(input));
});

test("checkFolder: a plain or nested name is kept, written with forward slashes", () => {
  assert.equal(folder("snapii"), "snapii");
  assert.equal(folder("Pages/snapii"), "Pages/snapii");
  assert.equal(folder("My Pages/2026 Q4"), "My Pages/2026 Q4");
  assert.equal(folder("a  b"), "a  b");
  assert.equal(folder("Ünï/日本語"), "Ünï/日本語");
  assert.equal(folder("a.b/x.y/c..d"), "a.b/x.y/c..d");
});

test("checkFolder: the typed form is normalised (trim, backslash, doubled and trailing separators, ./)", () => {
  assert.equal(folder("  snapii  "), "snapii");
  assert.equal(folder("a\\b"), "a/b");
  assert.equal(folder("a//b/"), "a/b");
  assert.equal(folder("./a/./b"), "a/b");
  assert.equal(folder(" a / b "), "a/b");
});

test("checkFolder: a single letter and a colon at the start is a drive, not a name", () => {
  assert.equal(folder("a:b"), "absolute");
  assert.equal(folder("ab:c"), "unsafe");
});

test("checkFolder: an absolute path is refused, since add-ons cannot leave the download folder", () => {
  for (const input of [
    "/",
    "//",
    "/etc",
    "\\share\\x",
    "~",
    "~/Pictures",
    "~\\Pictures",
    "C:\\Users",
    "c:/x",
    "  /x",
  ]) {
    assert.equal(folder(input), "absolute", JSON.stringify(input));
  }
  // A name that merely starts with a tilde is a name.
  assert.equal(folder("~notes"), "~notes");
});

test("checkFolder: `..` is refused wherever it stands", () => {
  for (const input of ["..", "../x", "a/..", "a/../b", "a\\..\\b", "a/ .. /b"]) {
    assert.equal(folder(input), "parent", JSON.stringify(input));
  }
});

test("checkFolder: a name that starts or ends with a dot is refused (Firefox refuses it)", () => {
  for (const input of [".hidden", "a/.hidden", "a.", "a./b", "...", "..a", "a..", "a/b ./c"]) {
    assert.equal(folder(input), "dot", JSON.stringify(input));
  }
});

test("checkFolder: one refused character in any segment refuses the folder", () => {
  for (const ch of [
    ":",
    "*",
    "?",
    '"',
    "<",
    ">",
    "|",
    "\u0000",
    "\u001f",
    "\u007f",
    "\u0085",
    "\u202e",
    "\u2028",
    "\u2029",
    "%",
    // Spaces but the plain one: no-break, em, hair, narrow no-break, ideographic.
    "\u00a0",
    "\u2003",
    "\u200a",
    "\u202f",
    "\u3000",
  ]) {
    assert.equal(folder(`ok/ab${ch}c`), "unsafe", JSON.stringify(ch));
    assert.equal(folder(`ab${ch}c/ok`), "unsafe", JSON.stringify(ch));
  }
});

test("checkFolder: the length limit counts the normalised path", () => {
  const edge = "x".repeat(MAX_FOLDER_LENGTH);
  assert.equal(folder(edge), edge);
  assert.equal(folder(`${edge}y`), "too-long");
  // Blanks and a trailing separator are dropped before counting.
  assert.equal(folder(` ${edge}/ `), edge);
});

test("describeFolderProblem: every problem has its own sentence", () => {
  const problems: FolderProblem[] = ["absolute", "parent", "dot", "unsafe", "reserved", "too-long"];
  const texts = problems.map((problem) => describeFolderProblem(problem));
  assert.equal(new Set(texts).size, problems.length);
  for (const text of texts) assert.ok(text.length > 10, text);
});

// What Chromium's downloads.download refused as a folder on top of the rules
// above (measured on Chromium 153, 2026-10-03; tests/glue-chromium pins it
// against the real API).
test("checkFolder for Chromium: names its download API reserves are refused", () => {
  for (const name of [
    "~a",
    "a~",
    "CON",
    "con",
    "prn",
    "aux",
    "nul",
    "nul.txt",
    "con.a.b",
    "com1",
    "LPT9",
    "clock$",
    "conin$",
    "x.lnk",
    "a.LNK",
    "a.local",
    "a.scf",
    "a.url",
    "desktop.ini",
    "Desktop.ini",
    "thumbs.db",
    "a.{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}",
  ]) {
    assert.deepEqual(checkFolder(name, "chromium"), { ok: false, reason: "reserved" }, name);
    assert.deepEqual(checkFolder(`Pages/${name}`, "chromium"), { ok: false, reason: "reserved" }, name);
  }
});

test("checkFolder for Chromium: names that only look reserved are accepted", () => {
  for (const name of [
    "a~b",
    "console",
    "com0",
    "com10",
    "a.lnk.x",
    "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}",
    "ünï",
    "a b",
  ]) {
    assert.deepEqual(checkFolder(name, "chromium"), { ok: true, folder: name }, name);
  }
});

test("checkFolder for Firefox: Chromium's reserved names stay accepted", () => {
  for (const name of ["~a", "CON", "x.lnk", "desktop.ini"]) {
    assert.deepEqual(checkFolder(name, "firefox"), { ok: true, folder: name }, name);
    assert.deepEqual(checkFolder(name), { ok: true, folder: name }, name);
  }
});

test("describeFolderProblem: each browser is named as itself", () => {
  assert.match(
    describeFolderProblem("absolute", "firefox"),
    /^Firefox lets add-ons save only inside its Downloads folder/,
  );
  assert.match(
    describeFolderProblem("absolute", "chromium"),
    /^The browser lets extensions save only inside its Downloads folder/,
  );
  assert.match(describeFolderProblem("reserved", "chromium"), /reserved/);
});
