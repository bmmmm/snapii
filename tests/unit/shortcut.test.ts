// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ariaShortcut,
  describeProblem,
  formatShortcut,
  isModifierKey,
  keyEventToShortcut,
  type Platform,
  type ShortcutKeyEvent,
  type ShortcutProblem,
  validateShortcut,
} from "../../src/shared/shortcut.ts";

const ev = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
  key: "",
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

const cases: { name: string; platform: Platform; event: Partial<ShortcutKeyEvent>; want: string | null }[] = [
  {
    name: "Alt+Shift+Y typed on a PC",
    platform: "other",
    event: { key: "Y", code: "KeyY", altKey: true, shiftKey: true },
    want: "Alt+Shift+Y",
  },
  {
    name: "macOS Option+S types ß: the key is still S",
    platform: "mac",
    event: { key: "ß", code: "KeyS", altKey: true },
    want: "Alt+S",
  },
  {
    name: "macOS Option+Shift+S types Í",
    platform: "mac",
    event: { key: "Í", code: "KeyS", altKey: true, shiftKey: true },
    want: "Alt+Shift+S",
  },
  {
    name: "macOS dead key (Option+E)",
    platform: "mac",
    event: { key: "Dead", code: "KeyE", altKey: true },
    want: "Alt+E",
  },
  {
    name: "a QWERTZ keyboard: the key labelled Z is Z, not the physical Y",
    platform: "other",
    event: { key: "z", code: "KeyY", ctrlKey: true },
    want: "Ctrl+Z",
  },
  {
    name: "Shift+1 types ! : the key is 1",
    platform: "other",
    event: { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true },
    want: "Ctrl+Shift+1",
  },
  {
    name: "a non-Latin layout falls back to the physical key",
    platform: "other",
    event: { key: "ы", code: "KeyS", ctrlKey: true },
    want: "Ctrl+S",
  },
  {
    name: "Command on macOS is Ctrl in the syntax",
    platform: "mac",
    event: { key: "k", code: "KeyK", metaKey: true },
    want: "Ctrl+K",
  },
  {
    name: "the Control key on macOS is MacCtrl",
    platform: "mac",
    event: { key: "k", code: "KeyK", ctrlKey: true },
    want: "MacCtrl+K",
  },
  {
    name: "Command+Control on macOS",
    platform: "mac",
    event: { key: "k", code: "KeyK", metaKey: true, ctrlKey: true },
    want: "Ctrl+MacCtrl+K",
  },
  {
    name: "Control on a PC is Ctrl",
    platform: "other",
    event: { key: "k", code: "KeyK", ctrlKey: true },
    want: "Ctrl+K",
  },
  {
    name: "the Windows/Super key has no name",
    platform: "other",
    event: { key: "k", code: "KeyK", metaKey: true },
    want: null,
  },
  { name: "F5 alone", platform: "other", event: { key: "F5", code: "F5" }, want: "F5" },
  { name: "F19", platform: "other", event: { key: "F19", code: "F19" }, want: "F19" },
  {
    name: "arrow",
    platform: "other",
    event: { key: "ArrowUp", code: "ArrowUp", altKey: true },
    want: "Alt+Up",
  },
  {
    name: "comma",
    platform: "other",
    event: { key: ",", code: "Comma", altKey: true },
    want: "Alt+Comma",
  },
  {
    name: "period",
    platform: "other",
    event: { key: ".", code: "Period", altKey: true },
    want: "Alt+Period",
  },
  {
    name: "Page Down",
    platform: "other",
    event: { key: "PageDown", code: "PageDown", ctrlKey: true },
    want: "Ctrl+PageDown",
  },
  {
    name: "Space",
    platform: "other",
    event: { key: " ", code: "Space", ctrlKey: true },
    want: "Ctrl+Space",
  },
  {
    name: "a media key",
    platform: "other",
    event: { key: "MediaPlayPause", code: "MediaPlayPause" },
    want: "MediaPlayPause",
  },
  {
    name: "a media key under its code name",
    platform: "other",
    event: { key: "MediaTrackNext", code: "MediaTrackNext" },
    want: "MediaNextTrack",
  },
  {
    name: "Alt pressed alone",
    platform: "other",
    event: { key: "Alt", code: "AltLeft", altKey: true },
    want: null,
  },
  {
    name: "Shift pressed alone",
    platform: "other",
    event: { key: "Shift", code: "ShiftLeft", shiftKey: true },
    want: null,
  },
  {
    name: "Enter has no name",
    platform: "other",
    event: { key: "Enter", code: "Enter", altKey: true },
    want: null,
  },
  {
    name: "a bracket has no name",
    platform: "other",
    event: { key: "[", code: "BracketLeft", altKey: true },
    want: null,
  },
  {
    name: "a letter without modifier is returned as is (validate refuses it)",
    platform: "other",
    event: { key: "s", code: "KeyS" },
    want: "S",
  },
];

for (const c of cases) {
  test(`keyEventToShortcut: ${c.name}`, () => {
    assert.equal(keyEventToShortcut(ev(c.event), c.platform), c.want);
  });
}

test("isModifierKey: the modifiers pressed alone, nothing else", () => {
  for (const k of ["Alt", "Control", "Shift", "Meta", "AltGraph", "OS"])
    assert.equal(isModifierKey(k), true, k);
  for (const k of ["a", "Enter", "F5", "Tab", "Escape"]) assert.equal(isModifierKey(k), false, k);
});

const valid = [
  "Alt+Shift+S",
  "Shift+Alt+S",
  "Ctrl+Shift+Y",
  "Ctrl+Alt+Y",
  "MacCtrl+Alt+Y",
  "Ctrl+MacCtrl+Y",
  "Command+Shift+Y",
  "Alt+0",
  "Ctrl+Comma",
  "Ctrl+Period",
  "Alt+Home",
  "Alt+End",
  "Alt+PageUp",
  "Alt+PageDown",
  "Alt+Space",
  "Alt+Insert",
  "Alt+Delete",
  "Alt+Up",
  "Alt+Down",
  "Alt+Left",
  "Alt+Right",
  "F1",
  "F12",
  "F13",
  "F19",
  "Shift+F5",
  "Alt+F5",
  "MediaPlayPause",
  "MediaNextTrack",
  "MediaPrevTrack",
  "MediaStop",
  "Alt + Shift + S",
  "",
];
for (const s of valid) {
  test(`validateShortcut accepts ${JSON.stringify(s)}`, () => {
    assert.deepEqual(validateShortcut(s), { ok: true });
  });
}

const invalid: [string, ShortcutProblem][] = [
  // Every rule has its own rows, so a mutant of one rule turns exactly its rows red.
  ["Hyper+S", "invalid-modifier"],
  ["Alt+Super+S", "invalid-modifier"],
  ["alt+S", "invalid-modifier"],
  ["S", "modifier-required"],
  ["Comma", "modifier-required"],
  ["Enter", "modifier-required"],
  ["Shift+S", "modifier-required"],
  ["Shift+Space", "modifier-required"],
  ["Alt+Alt+S", "duplicate-modifier"],
  ["Shift+Shift+S", "duplicate-modifier"],
  ["Ctrl+Command+S", "duplicate-modifier"],
  ["Ctrl+Alt+Shift+S", "too-many-modifiers"],
  ["Ctrl+Alt+Shift+Enter", "too-many-modifiers"],
  ["Alt+Enter", "invalid-key"],
  ["Alt+Tab", "invalid-key"],
  ["Alt+s", "invalid-key"],
  ["Alt+F20", "invalid-key"],
  ["Alt+F0", "invalid-key"],
  ["Alt+Plus", "invalid-key"],
  ["Alt+", "invalid-key"],
  ["Ctrl+Alt+Enter", "invalid-key"],
];
for (const [s, reason] of invalid) {
  test(`validateShortcut rejects ${JSON.stringify(s)}: ${reason}`, () => {
    assert.deepEqual(validateShortcut(s), { ok: false, reason });
  });
}

test("validateShortcut: a key with a modifier that keyEventToShortcut yields on every platform is valid", () => {
  for (const platform of ["mac", "other"] as const) {
    const s = keyEventToShortcut(ev({ key: "y", code: "KeyY", altKey: true, shiftKey: true }), platform);
    assert.ok(s);
    assert.deepEqual(validateShortcut(s), { ok: true });
  }
});

test("describeProblem: a text for every reason, naming the platform's modifiers", () => {
  const reasons: ShortcutProblem[] = [
    "invalid-modifier",
    "modifier-required",
    "duplicate-modifier",
    "too-many-modifiers",
    "invalid-key",
  ];
  const texts = new Set(reasons.map((r) => describeProblem(r, "other")));
  assert.equal(texts.size, reasons.length);
  assert.match(describeProblem("modifier-required", "other"), /Ctrl or Alt/);
  assert.match(describeProblem("modifier-required", "mac"), /Command, Option or Control/);
});

test("formatShortcut: symbols in the menu order on macOS, plus-joined names elsewhere", () => {
  assert.equal(formatShortcut("Alt+Shift+S", "mac"), "⌥⇧S");
  assert.equal(formatShortcut("Shift+Alt+S", "mac"), "⌥⇧S");
  assert.equal(formatShortcut("Ctrl+MacCtrl+Shift+Alt+K", "mac"), "⌃⌥⇧⌘K");
  assert.equal(formatShortcut("Command+Up", "mac"), "⌘↑");
  assert.equal(formatShortcut("Alt+Comma", "mac"), "⌥,");
  assert.equal(formatShortcut("F5", "mac"), "F5");
  assert.equal(formatShortcut("Alt+Shift+S", "other"), "Alt+Shift+S");
  assert.equal(formatShortcut("Command+Shift+Y", "other"), "Ctrl+Shift+Y");
  assert.equal(formatShortcut("Alt+Comma", "other"), "Alt+Comma");
  assert.equal(formatShortcut("", "mac"), "");
  assert.equal(formatShortcut("", "other"), "");
});

test("ariaShortcut: the aria-keyshortcuts value (Ctrl is Command on macOS, MacCtrl is Control)", () => {
  assert.equal(ariaShortcut("Alt+Shift+S", "mac"), "Alt+Shift+S");
  assert.equal(ariaShortcut("Alt+Shift+S", "other"), "Alt+Shift+S");
  assert.equal(ariaShortcut("Ctrl+Shift+Y", "mac"), "Meta+Shift+Y");
  assert.equal(ariaShortcut("Ctrl+Shift+Y", "other"), "Control+Shift+Y");
  assert.equal(ariaShortcut("MacCtrl+Alt+Comma", "mac"), "Control+Alt+,");
  assert.equal(ariaShortcut("Command+Up", "mac"), "Meta+ArrowUp");
  assert.equal(ariaShortcut("Alt+Period", "other"), "Alt+.");
  assert.equal(ariaShortcut("Ctrl+Space", "other"), "Control+Space");
  assert.equal(ariaShortcut("F7", "other"), "F7");
  assert.equal(ariaShortcut("", "mac"), "");
});
