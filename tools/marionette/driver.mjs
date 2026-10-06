// SPDX-License-Identifier: GPL-3.0-or-later
// Driving an extension's in-page UI through Marionette, shared by the glue
// tests (tests/glue/env.mjs) and the interactive driver (tools/drive/).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./firefox.mjs";
import { decodePng, parseSvg } from "./svg.mjs";

// WebDriver key codes (Private Use Area code points).
export const KEYS = {
  Backspace: "\uE003",
  Tab: "\uE004",
  Enter: "\uE007",
  Shift: "\uE008",
  Control: "\uE009",
  Alt: "\uE00A",
  Escape: "\uE00C",
  Space: "\uE00D",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
  End: "\uE010",
  Home: "\uE011",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  Delete: "\uE017",
  Meta: "\uE03D",
};

/**
 * Page-level driving of one extension in a Marionette session: real (trusted)
 * pointer and key input, the overlay's closed shadow root, toasts, downloads.
 */
export class Driver {
  /**
   * @param {import("./firefox.mjs").Session} s
   * @param {{ addonId: string, downloads: string }} o
   */
  constructor(s, { addonId, downloads }) {
    this.s = s;
    this.addonId = addonId;
    this.downloads = downloads;
  }

  /** Loads a page and waits until it has painted. */
  async open(url) {
    await this.s.navigate(url);
    await this.frames();
  }

  /** Two animation frames in the page: style, layout and paint have happened. */
  async frames() {
    try {
      await this.s.execAsync(
        "content",
        "const done = arguments[0]; requestAnimationFrame(() => requestAnimationFrame(() => done(true)));",
      );
    } catch (e) {
      // The input navigated (a link click): there is no frame to wait for.
      if (!/Document was unloaded/.test(String(e))) throw e;
    }
  }

  content(script, ...args) {
    return this.s.content(script, ...args);
  }

  /**
   * Runs a function body in the page with Marionette's system-principal
   * sandbox: unlike a page script it reaches closed shadow roots
   * (openOrClosedShadowRoot), which the overlay and toast use.
   */
  async system(script, ...args) {
    await this.s.context("content");
    return (await this.s.send("WebDriver:ExecuteScript", { script, args, sandbox: "system" })).value;
  }

  /** Clicks a button of the overlay's toolbar ("save", "copy-text", "copy-link", "copy-page-link", "cancel"). */
  async clickToolbar(action) {
    const c = await this.system(
      `const b = document.querySelector("snapii-overlay")?.openOrClosedShadowRoot
         ?.querySelector('[data-action="' + arguments[0] + '"]');
       if (!b || b.closest(".toolbar").hidden) return null;
       const r = b.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
      action,
    );
    if (!c) throw new Error(`no visible toolbar button ${action}`);
    await this.click(c.x, c.y);
  }

  /** Text of the snapii toast on screen, or null. */
  toast() {
    return this.system(
      `return document.querySelector("snapii-toast")?.openOrClosedShadowRoot?.querySelector(".toast")?.textContent ?? null;`,
    );
  }

  /** Opens url in a new foreground tab, runs fn there, then closes the tab and returns to this one. */
  async inNewTab(url, fn) {
    const orig = (await this.s.send("WebDriver:GetWindowHandle", {})).value;
    const { handle } = await this.s.send("WebDriver:NewWindow", { type: "tab", focus: true });
    await this.s.send("WebDriver:SwitchToWindow", { handle, focus: true });
    try {
      await this.open(url);
      return await fn();
    } finally {
      await this.s.send("WebDriver:CloseWindow", {});
      await this.s.send("WebDriver:SwitchToWindow", { handle: orig, focus: true });
    }
  }

  overlayPresent() {
    return this.content(`return document.querySelectorAll("snapii-overlay").length;`);
  }

  /** Polls `fn` until it returns a truthy value (returned) or `ms` pass (throws). */
  async until(fn, what, ms = 10_000) {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
      await sleep(100);
    }
  }

  /**
   * Starts (or, with the overlay open, ends) a capture session the way a user
   * does, with the activeTab grant that comes with it: `shortcut` fires the
   * start-capture key (Ctrl+Alt+S by default, MacCtrl+Alt+S on macOS), `popup` clicks the toolbar
   * button and then "Capture region" in the popup, and waits until the popup
   * has closed (it does once the background has started; a refused start
   * keeps it open with the reason). Returns the shortcut's <key> attributes,
   * or the popup's state before the click.
   */
  async trigger(how = "shortcut") {
    if (how === "shortcut") return this.s.triggerShortcut(this.addonId);
    if (how !== "popup") throw new Error(`unknown trigger ${how}`);
    const state = await this.openPopup();
    await this.s.clickInPopup("#capture");
    await this.popupClosed();
    return state;
  }

  /** Waits until no action popup is open. */
  popupClosed() {
    return this.until(async () => (await this.s.popupCount()) === 0, "the popup to close");
  }

  /**
   * Clicks the toolbar button and waits until its panel has settled and the
   * popup has asked the page whether it can be captured and shows the stored
   * settings; returns popupState(). Throws if a popup is already open (the
   * click would close it).
   */
  async openPopup() {
    if ((await this.s.popupCount()) > 0) throw new Error("a popup is already open");
    await this.s.triggerAction(this.addonId);
    return this.until(async () => {
      if ((await this.s.popupPanelState()) !== "open") return null;
      const st = await this.popupState().catch(() => null);
      return st?.ready ? st : null;
    }, "the popup to be ready");
  }

  /** What the open popup shows (see src/popup/popup.html), or throws if none is open. */
  popupState() {
    return this.s.inPopup((w) => {
      const d = w.document;
      const $ = (id) => d.getElementById(id);
      if (d.readyState !== "complete" || !$("capture")) return { ready: false };
      const box = (name) => d.querySelector(`input[name="${name}"]`).checked;
      return {
        // aria-busy: the popup is still asking the page whether it can be captured.
        ready:
          !$("toggles").disabled && $("about").textContent !== "" && !$("capture").hasAttribute("aria-busy"),
        focused: d.activeElement?.id || d.activeElement?.localName || null,
        capture: {
          disabled: $("capture").disabled,
          text: $("capture").textContent.replace(/\s+/g, " ").trim(),
        },
        shortcut: $("capture-shortcut").textContent,
        keyshortcuts: $("capture").getAttribute("aria-keyshortcuts"),
        shortcutHidden: $("capture-shortcut").getAttribute("aria-hidden") === "true",
        status: $("status").textContent,
        toggles: {
          ocr: box("ocr"),
          textFragment: box("textFragment"),
          removeTrackers: box("removeTrackers"),
          saveAs: box("saveAs"),
        },
        folder: {
          value: $("folder").value,
          error: $("folder-error").hidden ? "" : $("folder-error").textContent,
          invalid: $("folder").getAttribute("aria-invalid") === "true",
        },
        about: $("about").textContent,
      };
    });
  }

  /** Triggers and waits for the overlay host to appear. */
  async startOverlay(how = "shortcut") {
    const info = await this.trigger(how);
    await this.until(async () => (await this.overlayPresent()) === 1, "the overlay");
    await this.frames();
    return info;
  }

  async move(x, y) {
    await this.s.perform([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" }],
      },
    ]);
    // The overlay updates the hover pick in the next animation frame.
    await this.frames();
  }

  /** Press and release without moving: an element pick. */
  async click(x, y) {
    await this.s.perform([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" },
          { type: "pause", duration: 50 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await this.frames();
  }

  async drag(x0, y0, x1, y1) {
    const steps = 5;
    const moves = [];
    for (let i = 1; i <= steps; i++) {
      moves.push({
        type: "pointerMove",
        x: Math.round(x0 + ((x1 - x0) * i) / steps),
        y: Math.round(y0 + ((y1 - y0) * i) / steps),
        origin: "viewport",
      });
    }
    await this.s.perform([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: x0, y: y0, origin: "viewport" },
          { type: "pointerDown", button: 0 },
          ...moves,
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await this.frames();
  }

  /** One key (name from KEYS) with optional modifiers held. */
  async key(name, modifiers = []) {
    const down = modifiers.map((m) => ({ type: "keyDown", value: KEYS[m] }));
    const up = modifiers.map((m) => ({ type: "keyUp", value: KEYS[m] })).reverse();
    const value = KEYS[name] ?? name;
    await this.s.perform([
      {
        type: "key",
        id: "keyboard",
        actions: [...down, { type: "keyDown", value }, { type: "keyUp", value }, ...up],
      },
    ]);
    await this.frames();
  }

  /** Client rect (CSS px) of the first element matching `selector`. */
  rect(selector) {
    return this.content(
      `const r = document.querySelector(arguments[0]).getBoundingClientRect();
       return { x: r.x, y: r.y, width: r.width, height: r.height };`,
      selector,
    );
  }

  async scrollTo(y) {
    await this.content("window.scrollTo(0, arguments[0]); return window.scrollY;", y);
    await this.frames();
  }

  /** Content viewport at device px, decoded. */
  async screenshot() {
    return decodePng(await this.s.screenshot());
  }

  svgFiles() {
    return readdirSync(this.downloads).filter((f) => f.endsWith(".svg"));
  }

  /** Waits for a .svg that was not in `before` and returns its path and text. */
  async newDownload(before, ms = 15_000) {
    const name = await this.until(() => this.svgFiles().find((f) => !before.includes(f)), "a new .svg", ms);
    const path = join(this.downloads, name);
    // The download is written to its final name when complete; read it once
    // it parses as a whole document.
    const text = await this.until(() => {
      const t = readFileSync(path, "utf8");
      return t.trimEnd().endsWith("</svg>") ? t : null;
    }, `${name} to be complete`);
    return { name, path, text, svg: parseSvg(text) };
  }

  /** Whether the extension holds activeTab for the selected tab (Firefox's own bookkeeping). */
  hasActiveTab() {
    return this.s.chrome(
      `const ext = WebExtensionPolicy.getByID(arguments[0]).extension;
       return ext.tabManager.hasActiveTabPermission(gBrowser.selectedTab);`,
      this.addonId,
    );
  }

  /** Text of the extension's toolbar badge and title for the selected tab. */
  action() {
    return this.s.chrome(
      `const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const ext = WebExtensionPolicy.getByID(arguments[0]).extension;
       const action = ExtensionParent.apiManager.global.browserActionFor(ext).action;
       const tab = gBrowser.selectedTab;
       return { badge: action.getProperty(tab, "badgeText"), title: action.getProperty(tab, "title") };`,
      this.addonId,
    );
  }

  /**
   * Every browser-console error (not warning/info) since `sinceMs`. Not
   * filtered by source on purpose: an unhandled rejection of a WebExtension
   * API promise in the background is reported from chrome code with source
   * "undefined" and no window (measured), so a moz-extension:// filter would
   * miss exactly the errors this is for.
   */
  consoleErrors(sinceMs) {
    return this.s.chrome(
      `const since = arguments[0];
       return Services.console.getMessageArray()
         .filter((m) => m instanceof Ci.nsIScriptError && (m.timeStamp ?? 0) >= since)
         .filter((e) => !(e.flags & Ci.nsIScriptError.warningFlag) && !(e.flags & Ci.nsIScriptError.infoFlag))
         .map((e) => ({ message: e.errorMessage, source: e.sourceName, category: e.category }));`,
      sinceMs,
    );
  }

  /** Page zoom of the selected tab, as tabs.setZoom would set it. */
  async setZoom(zoom) {
    await this.s.chrome(
      `ZoomManager.setZoomForBrowser(gBrowser.selectedBrowser, arguments[0]); return ZoomManager.getZoomForBrowser(gBrowser.selectedBrowser);`,
      zoom,
    );
    await this.frames();
  }
}
