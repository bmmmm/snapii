// SPDX-License-Identifier: GPL-3.0-or-later
// The selection toolbar (built into the overlay's shadow root) and the
// short-lived toast shown after the overlay is gone.
import { adoptStyles, createHtml, styleHost, TOAST_CSS } from "./styles.ts";

export type ToolbarButton = "save" | "copy-text" | "copy-link" | "copy-page-link" | "cancel";

// Action, label and its key: the left hand's top row in toolbar order, so
// after the capture shortcut nothing needs the mouse.
const BUTTONS: [ToolbarButton, string, string][] = [
  ["save", "Save SVG", "Q"],
  ["copy-text", "Copy text", "W"],
  ["copy-link", "Copy element link", "E"],
  ["copy-page-link", "Copy page link", "R"],
  ["cancel", "Cancel", "F"],
];

/**
 * The button a bare key press stands for, or null. Matched on `key` (the
 * character typed, so the badge is what the user presses on any layout);
 * Shift and Caps Lock give the capital, which counts the same.
 */
export function buttonForKey(key: string): ToolbarButton | null {
  const upper = key.toUpperCase();
  return BUTTONS.find(([, , k]) => k === upper)?.[0] ?? null;
}

export interface Toolbar {
  readonly el: HTMLElement;
  /**
   * Button under a client point. The overlay swallows every mouse event at
   * the window before it reaches the shadow tree, so it routes clicks by
   * geometry instead of by DOM listeners on the buttons.
   */
  buttonAt(x: number, y: number): ToolbarButton | null;
  setBusy(busy: boolean): void;
  /** Marks Save as unavailable for the current selection (`reason` is its tooltip), or available again. */
  setSaveBlocked(reason: string | null): void;
}

export function createToolbar(): Toolbar {
  const el = createHtml("div");
  el.className = "toolbar";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "snapii");
  el.hidden = true;
  const buttons = BUTTONS.map(([action, label, key]) => {
    const b = createHtml("button");
    b.type = "button";
    const kbd = createHtml("kbd");
    kbd.textContent = key;
    // The badge is decoration; aria-keyshortcuts carries the key.
    kbd.setAttribute("aria-hidden", "true");
    b.append(label, kbd);
    b.setAttribute("aria-keyshortcuts", key);
    b.dataset.action = action;
    if (action === "save") b.className = "primary";
    el.append(b);
    return { action, b };
  });
  return {
    el,
    buttonAt(x, y) {
      if (el.hidden) return null;
      for (const { action, b } of buttons) {
        const r = b.getBoundingClientRect();
        if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return action;
      }
      return null;
    },
    setBusy(busy) {
      el.setAttribute("aria-busy", String(busy));
      for (const { b } of buttons) b.disabled = busy;
    },
    setSaveBlocked(reason) {
      const save = buttons.find(({ action }) => action === "save")?.b;
      if (!save) return;
      // aria-disabled, not disabled: setBusy owns that one.
      if (reason === null) save.removeAttribute("aria-disabled");
      else save.setAttribute("aria-disabled", "true");
      save.title = reason ?? "";
    },
  };
}

let toast: { host: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** Shows `message` bottom-centre for `ms`, replacing any toast still showing. */
export function showToast(message: string, ms = 2000): void {
  if (toast) {
    clearTimeout(toast.timer);
    toast.host.remove();
  }
  const host = createHtml("snapii-toast");
  styleHost(host, {
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    // Never in the way of hit-testing or clicks on the page.
    "pointer-events": "none",
  });
  const root = host.attachShadow({ mode: "closed" });
  adoptStyles(root, TOAST_CSS);
  const box = createHtml("div");
  box.className = "toast";
  box.setAttribute("role", "status");
  box.textContent = message;
  root.append(box);
  document.documentElement.append(host);
  const current = {
    host,
    timer: setTimeout(() => {
      host.remove();
      if (toast === current) toast = null;
    }, ms),
  };
  toast = current;
}
