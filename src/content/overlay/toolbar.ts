// SPDX-License-Identifier: GPL-3.0-or-later
// The selection toolbar (built into the overlay's shadow root) and the
// short-lived toast shown after the overlay is gone.
import { adoptStyles, createHtml, styleHost, TOAST_CSS } from "./styles.ts";

export type ToolbarButton = "save" | "copy-text" | "copy-link" | "cancel";

const BUTTONS: [ToolbarButton, string][] = [
  ["save", "Save SVG"],
  ["copy-text", "Copy text"],
  ["copy-link", "Copy link"],
  ["cancel", "Cancel"],
];

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
  const buttons = BUTTONS.map(([action, label]) => {
    const b = createHtml("button");
    b.type = "button";
    b.textContent = label;
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
