// SPDX-License-Identifier: GPL-3.0-or-later
// Keyboard shortcuts in the syntax of browser.commands ("Alt+Shift+S"): the
// conversion of a recorded key event, the validity rules and the display text.
// The rules mirror Firefox's ShortcutUtils.validate (the check behind
// commands.update), so the options page can say why a combination is refused
// before the browser does; the browser stays the authority.

/**
 * The manifest command of the keyboard shortcut that starts a capture directly
 * (the toolbar button opens the popup instead). Shown in the popup, changed
 * in the options page.
 */
export const CAPTURE_COMMAND = "start-capture";

/**
 * The command Firefox binds to opening the toolbar popup. Before the popup
 * existed the capture shortcut lived here, and a key the user had recorded
 * stays bound to it across updates (see background/legacy-shortcut.ts).
 */
export const MENU_COMMAND = "_execute_action";

export type Platform = "mac" | "other";

/**
 * A command's key in the manifest for one platform: its own entry, else
 * "default". macOS has its own because "Ctrl" there is Command, and the key
 * wanted is the Control key (MacCtrl).
 */
export function suggestedKeyFor(
  suggested: { default?: string; mac?: string } | undefined,
  platform: Platform,
): string {
  return (platform === "mac" ? suggested?.mac : undefined) ?? suggested?.default ?? "";
}

/** The fields of a KeyboardEvent the conversion reads. */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type ShortcutProblem =
  | "invalid-modifier"
  | "modifier-required"
  | "duplicate-modifier"
  | "too-many-modifiers"
  | "invalid-key";

export type ShortcutCheck = { ok: true } | { ok: false; reason: ShortcutProblem };

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "OS", "Shift"]);

/** True for the key event of a modifier pressed alone: the user is still building the combination. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

// KeyboardEvent.code -> Firefox key name, for every key that is not a letter,
// digit or function key.
const NAMED_KEYS: Record<string, string> = {
  Comma: "Comma",
  Period: "Period",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Space: "Space",
  Insert: "Insert",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  MediaTrackNext: "MediaNextTrack",
  MediaPlayPause: "MediaPlayPause",
  MediaTrackPrevious: "MediaPrevTrack",
  MediaStop: "MediaStop",
};

const MEDIA_KEY = /^(MediaNextTrack|MediaPlayPause|MediaPrevTrack|MediaStop)$/;
const BASIC_KEY = /^([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
// commands.update accepts F13-F19 as well as the manifest's F1-F12.
const FUNCTION_KEY = /^F([1-9]|1[0-9])$/;

function keyName(e: ShortcutKeyEvent): string | null {
  // The produced character first: Firefox matches a letter key by the
  // character it types, so on a QWERTZ keyboard the key labelled Z is "Z".
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  // Otherwise the physical key: Option+S on macOS types "ß" and shifted digits
  // type punctuation, but the key is still S / 1.
  const letter = /^Key([A-Z])$/.exec(e.code) ?? /^Digit([0-9])$/.exec(e.code);
  if (letter) return letter[1] ?? null;
  if (FUNCTION_KEY.test(e.code)) return e.code;
  return NAMED_KEYS[e.code] ?? null;
}

/**
 * The shortcut a key event stands for, in the order Ctrl, Alt, MacCtrl, Shift
 * (Ctrl is Command on macOS, MacCtrl the Control key there), or null when the
 * key is a modifier alone or has no name in the syntax. The result is not
 * necessarily valid: run it through validateShortcut.
 */
export function keyEventToShortcut(e: ShortcutKeyEvent, platform: Platform): string | null {
  const key = keyName(e);
  if (key === null) return null;
  const mac = platform === "mac";
  // The Windows/Super key has no name in the syntax.
  if (!mac && e.metaKey) return null;
  const modifiers: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) modifiers.push("Ctrl");
  if (e.altKey) modifiers.push("Alt");
  if (mac && e.ctrlKey) modifiers.push("MacCtrl");
  if (e.shiftKey) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}

// What the modifier is for Firefox's duplicate check: Ctrl and Command are one.
const MODIFIER_KIND: Record<string, string> = {
  Alt: "alt",
  Command: "accel",
  Ctrl: "accel",
  MacCtrl: "control",
  Shift: "shift",
};

/** Firefox's rules for commands.update; "" (no shortcut) is accepted like there. */
export function validateShortcut(shortcut: string): ShortcutCheck {
  if (shortcut === "") return { ok: true };
  if (MEDIA_KEY.test(shortcut.trim())) return { ok: true };
  const parts = shortcut.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const kinds = parts.map((m) => MODIFIER_KIND[m]);
  if (kinds.some((k) => k === undefined)) return { ok: false, reason: "invalid-modifier" };
  const isFunctionKey = FUNCTION_KEY.test(key);
  switch (kinds.length) {
    case 0:
      // No modifier at all is only allowed for function keys.
      if (!isFunctionKey) return { ok: false, reason: "modifier-required" };
      break;
    case 1:
      // Shift on its own is no modifier for anything but function keys.
      if (kinds[0] === "shift" && !isFunctionKey) return { ok: false, reason: "modifier-required" };
      break;
    case 2:
      if (kinds[0] === kinds[1]) return { ok: false, reason: "duplicate-modifier" };
      break;
    default:
      return { ok: false, reason: "too-many-modifiers" };
  }
  if (!BASIC_KEY.test(key) && !isFunctionKey) return { ok: false, reason: "invalid-key" };
  return { ok: true };
}

/** Why a combination is refused, for a status line. */
export function describeProblem(reason: ShortcutProblem, platform: Platform): string {
  const ctrl = platform === "mac" ? "Command, Option or Control" : "Ctrl or Alt";
  switch (reason) {
    case "invalid-modifier":
      return "Unknown modifier key.";
    case "modifier-required":
      return `Add ${ctrl} (Shift alone is not enough); only function keys work without a modifier.`;
    case "duplicate-modifier":
      return "Use each modifier key only once.";
    case "too-many-modifiers":
      return "Use at most two modifier keys.";
    case "invalid-key":
      return "This key cannot be used. Use a letter, digit, F1-F19, arrow, Home, End, Page Up/Down, Insert, Delete, Space, comma or period.";
  }
}

const MAC_MODIFIERS: Record<string, string> = { MacCtrl: "⌃", Alt: "⌥", Shift: "⇧", Ctrl: "⌘", Command: "⌘" };
const MAC_ORDER = ["MacCtrl", "Alt", "Shift", "Ctrl", "Command"];
const MAC_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};
const OTHER_MODIFIERS: Record<string, string> = { Command: "Ctrl" };

/** Display text: "⌥⇧S" on macOS (the order of the menus), "Alt+Shift+S" elsewhere; "" for no shortcut. */
export function formatShortcut(shortcut: string, platform: Platform): string {
  if (shortcut === "") return "";
  const parts = shortcut.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  if (platform === "mac") {
    const glyphs = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_MODIFIERS[m]);
    return `${glyphs.join("")}${MAC_KEYS[key] ?? key}`;
  }
  return [...parts.map((m) => OTHER_MODIFIERS[m] ?? m), key].join("+");
}

const ARIA_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

/**
 * The aria-keyshortcuts value (KeyboardEvent.key names joined by "+"), so a
 * screen reader announces the shortcut as one rather than reading the
 * displayed glyphs; "" for no shortcut.
 */
export function ariaShortcut(shortcut: string, platform: Platform): string {
  if (shortcut === "") return "";
  const parts = shortcut.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const modifier = (m: string): string => {
    if (m === "Command" || (m === "Ctrl" && platform === "mac")) return "Meta";
    if (m === "Ctrl" || m === "MacCtrl") return "Control";
    return m;
  };
  return [...parts.map(modifier), ARIA_KEYS[key] ?? key].join("+");
}
