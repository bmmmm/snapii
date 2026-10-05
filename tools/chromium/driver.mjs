// SPDX-License-Identifier: GPL-3.0-or-later
// Drives the real extension (dist-chromium/) in a real Chromium, with the
// method names of tools/marionette/driver.mjs where the two browsers allow
// the same thing. Playwright launches the browser and sends real input;
// what Playwright has no word for goes over the DevTools protocol:
//   - the toolbar action (Extensions.triggerAction, which opens the popup and
//     grants activeTab like a click),
//   - the popup, a page target Playwright does not list (its own DevTools
//     socket, hence the remote debugging port),
//   - the content script's world, the only place that sees the overlay's
//     closed shadow tree (browser.dom.openOrClosedShadowRoot).
// There is no way to press a command's key: the shortcut stays manual.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { decodePng, parseSvg } from "../marionette/svg.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts Chromium with the unpacked extension. `SNAPII_CHROMIUM` names another
 * binary than Playwright's pinned Chromium (branded Chrome no longer takes
 * --load-extension).
 */
export async function launchChromium({
  extension,
  profile,
  downloads,
  debugPort,
  dpr = 2,
  headless = true,
  hostRules = "",
}) {
  const executablePath = process.env.SNAPII_CHROMIUM;
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--force-device-scale-factor=${dpr}`,
      "--window-size=1280,800",
      `--remote-debugging-port=${debugPort}`,
      ...(hostRules ? [`--host-resolver-rules=${hostRules}`] : []),
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const browserCdp = await context.browser().newBrowserCDPSession();
    // Playwright's own download handling stores every file under a GUID; the
    // browser's (into the profile's download folder, set above) keeps the name
    // and the folder the extension asked for.
    await browserCdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const page = context.pages()[0] ?? (await context.newPage());
    return new Driver({
      context,
      page,
      browserCdp,
      extensionId: new URL(worker.url()).host,
      downloads,
      debugPort,
    });
  } catch (e) {
    await context.close();
    throw e;
  }
}

export class Driver {
  constructor({ context, page, browserCdp, extensionId, downloads, debugPort }) {
    this.context = context;
    this.page = page;
    this.browserCdp = browserCdp;
    this.extensionId = extensionId;
    this.downloads = downloads;
    this.debugPort = debugPort;
    /** Execution contexts of the page, to find the content script's world. */
    this.contexts = [];
    this.cdp = null;
  }

  async quit() {
    await this.context.close();
  }

  /** The service worker, started again if the browser had shut it down. */
  async worker() {
    const running = this.context.serviceWorkers()[0];
    if (running) return running;
    const woken = this.context.waitForEvent("serviceworker");
    const page = await this.context.newPage();
    await page.goto(`chrome-extension://${this.extensionId}/popup.html`);
    await page.close();
    return woken;
  }

  /** Shuts the service worker down, as the browser does after half a minute without events. */
  async stopWorker() {
    const workers = async () =>
      (await this.browserCdp.send("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${this.extensionId}/`),
      );
    for (const { targetId } of await workers())
      await this.browserCdp.send("Target.closeTarget", { targetId });
    await this.until(async () => (await workers()).length === 0, "the service worker to stop");
  }

  /**
   * Fires a command of the extension for the selected tab. There is no way to
   * press its key, so this is the event without the key press: it does not
   * grant activeTab the way the real shortcut does.
   *
   * The selected tab is the active one, not the one in the last focused
   * window: on macOS, once Extensions.triggerAction has opened the popup,
   * that query mostly finds no tab (headless). The browser has one window.
   */
  command(name) {
    return this.background(async (name) => {
      const [tab] = await chrome.tabs.query({ active: true });
      chrome.commands.onCommand.dispatch(name, tab);
    }, name);
  }

  /** Runs `fn` in the service worker (extension APIs under `chrome`). */
  async background(fn, arg) {
    return (await this.worker()).evaluate(fn, arg);
  }

  /** Loads a page and waits until it has painted. */
  async open(url) {
    if (!this.cdp) {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdp.on("Runtime.executionContextCreated", (e) => this.contexts.push(e.context));
      this.cdp.on("Runtime.executionContextDestroyed", (e) => {
        this.contexts = this.contexts.filter((c) => c.id !== e.executionContextId);
      });
      this.cdp.on("Runtime.executionContextsCleared", () => {
        this.contexts = [];
      });
      await this.cdp.send("Runtime.enable");
    }
    await this.page.goto(url);
    await this.page.bringToFront();
    await this.frames();
  }

  /** Two animation frames in the page: style, layout and paint have happened. */
  async frames() {
    await this.page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))),
    );
  }

  /** Runs a function body in the page, like the Firefox driver's `content`. */
  content(script, ...args) {
    return this.page.evaluate(([body, values]) => new Function(body)(...values), [script, args]);
  }

  /** Evaluates an expression in the content script's world of the selected page, or throws if none is there. */
  async extension(expression) {
    const world = this.contexts.findLast((c) => c.origin === `chrome-extension://${this.extensionId}`);
    if (!world) throw new Error("the content script is not in this page");
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
      contextId: world.id,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /** The overlay's toolbar buttons with their client centres, or [] without a toolbar on screen. */
  async toolbar() {
    try {
      return await this.extension(`(() => {
        const host = document.querySelector("snapii-overlay");
        const bar = host && browser.dom.openOrClosedShadowRoot(host).querySelector(".toolbar");
        if (!bar || bar.hidden) return [];
        return [...bar.querySelectorAll("button")].map((b) => {
          const r = b.getBoundingClientRect();
          return {
            action: b.dataset.action,
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            unavailable: b.getAttribute("aria-disabled") === "true",
            title: b.title,
          };
        });
      })()`);
    } catch {
      return [];
    }
  }

  /** Clicks a button of the overlay's toolbar ("save", "copy-text", "copy-link", "cancel"). */
  async clickToolbar(action) {
    const button = await this.until(
      async () => (await this.toolbar()).find((b) => b.action === action),
      `the ${action} button`,
    );
    await this.click(button.x, button.y);
  }

  /** The overlay's hint or notice text, or null while it is hidden. */
  hint() {
    return this.extension(`(() => {
      const host = document.querySelector("snapii-overlay");
      const hint = host && browser.dom.openOrClosedShadowRoot(host).querySelector(".hint");
      return hint && !hint.hidden ? hint.textContent : null;
    })()`);
  }

  /** Text of the snapii toast on screen, or null. */
  async toast() {
    try {
      return await this.extension(`(() => {
        const host = document.querySelector("snapii-toast");
        return host ? browser.dom.openOrClosedShadowRoot(host).textContent : null;
      })()`);
    } catch {
      return null;
    }
  }

  overlayPresent() {
    return this.page.evaluate(() => {
      const host = document.querySelector("snapii-overlay");
      return !!host && getComputedStyle(host).display !== "none";
    });
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

  /** One DevTools call on the popup's own socket; throws if no popup is open. */
  async #popup(expression) {
    const targets = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
    const popup = targets.find((t) => t.url === `chrome-extension://${this.extensionId}/popup.html`);
    if (!popup) throw new Error("no popup is open");
    const socket = new WebSocket(popup.webSocketDebuggerUrl);
    try {
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("could not reach the popup"));
      });
      const reply = await new Promise((resolve) => {
        socket.onmessage = (m) => {
          const data = JSON.parse(m.data);
          if (data.id === 1) resolve(data);
        };
        const params = { expression, returnByValue: true, awaitPromise: true };
        socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params }));
      });
      if (reply.error) throw new Error(reply.error.message);
      if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
      return reply.result.result.value;
    } finally {
      socket.close();
    }
  }

  /** Clicks the toolbar button for the selected tab: the popup opens and the tab gets activeTab. */
  async openPopup() {
    const { targetInfos } = await this.browserCdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const tab = targetInfos.find((t) => t.url === this.page.url());
    if (!tab) throw new Error(`no tab shows ${this.page.url()}`);
    await this.browserCdp.send("Extensions.triggerAction", { id: this.extensionId, targetId: tab.targetId });
    // The probe has answered once the button is no longer busy.
    await this.until(
      () =>
        this.#popup(`document.getElementById("capture").getAttribute("aria-busy") === null`).catch(
          () => false,
        ),
      "the popup",
    );
  }

  /** What the open popup shows (see src/popup/popup.html), or throws if none is open. */
  async popupState() {
    return JSON.parse(
      await this.#popup(`JSON.stringify({
        captureDisabled: document.getElementById("capture").disabled,
        status: document.getElementById("status").textContent,
        shortcut: document.getElementById("capture-shortcut").textContent,
        about: document.getElementById("about")?.textContent ?? null,
        ocrDisabled: document.querySelector('input[name="ocr"]').disabled,
      })`),
    );
  }

  /** Opens the popup and clicks "Capture region" (the popup closes when the capture starts). */
  async trigger() {
    await this.openPopup();
    await this.#popup(`document.getElementById("capture").click()`);
  }

  /** Triggers and waits for the overlay host to appear. */
  async startOverlay() {
    await this.trigger();
    await this.until(() => this.overlayPresent(), "the overlay");
    await this.frames();
  }

  async move(x, y) {
    await this.page.mouse.move(x, y);
    await this.frames();
  }

  /** Press and release without moving: an element pick. */
  async click(x, y) {
    await this.page.mouse.move(x, y);
    await this.frames();
    await this.page.mouse.down();
    await this.page.mouse.up();
    await this.frames();
  }

  async drag(x0, y0, x1, y1) {
    await this.page.mouse.move(x0, y0);
    await this.page.mouse.down();
    await this.page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2);
    await this.page.mouse.move(x1, y1);
    await this.page.mouse.up();
    await this.frames();
  }

  /** One key (Playwright's key names) with optional modifiers held. */
  async key(name, modifiers = []) {
    await this.page.keyboard.press([...modifiers, name].join("+"));
    await this.frames();
  }

  /** Client rect (CSS px) of the first element matching `selector`. */
  rect(selector) {
    return this.page.evaluate((selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
  }

  async scrollTo(y) {
    await this.page.evaluate((y) => scrollTo(0, y), y);
    await this.frames();
  }

  /** Content viewport at device px, decoded. */
  async screenshot() {
    return decodePng(await this.page.screenshot());
  }

  /** Every .svg under the download folder, as paths relative to it. */
  svgFiles() {
    return readdirSync(this.downloads, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".svg"));
  }

  /** Waits for a .svg that was not in `before` and returns its path and text. */
  async newDownload(before, ms = 15_000) {
    const name = await this.until(() => this.svgFiles().find((f) => !before.includes(f)), "a new .svg", ms);
    const path = join(this.downloads, name);
    const text = await this.until(() => {
      const t = readFileSync(path, "utf8");
      return t.trimEnd().endsWith("</svg>") ? t : null;
    }, `${name} to be complete`);
    return { name, path, text, svg: parseSvg(text) };
  }

  /** Text of the extension's toolbar badge and title for the selected tab (see `command`). */
  action() {
    return this.background(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      return {
        badge: await chrome.action.getBadgeText({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }),
      };
    });
  }

  /** Page zoom of the selected tab. */
  async setZoom(zoom) {
    await this.background(async (zoom) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.setZoom(tab.id, zoom);
    }, zoom);
    await this.frames();
  }

  /** The settings as the options page would store them. */
  setSettings(values) {
    return this.background((values) => chrome.storage.sync.set(values), values);
  }

  /** The extension's own pages (options.html, popup.html) open in a tab. */
  extensionUrl(path) {
    return `chrome-extension://${this.extensionId}/${path}`;
  }

  /** Whether the extension's offscreen document exists right now. */
  offscreenOpen() {
    return this.background(
      async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0,
    );
  }

  /**
   * The clipboard's flavours, read by a page at `url` (a secure origin) in a
   * tab of its own: reading needs the focus and the clipboard-read grant.
   */
  async readClipboard(url) {
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(url).origin,
    });
    const page = await this.context.newPage();
    try {
      await page.goto(url);
      await page.bringToFront();
      return await page.evaluate(async () => {
        const out = {};
        for (const item of await navigator.clipboard.read()) {
          for (const type of item.types) out[type] = await (await item.getType(type)).text();
        }
        return out;
      });
    } finally {
      await page.close();
      await this.page.bringToFront();
    }
  }

  /** Puts plain text on the clipboard, so a test can tell a later write from what was there. */
  async writeClipboard(url, text) {
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(url).origin,
    });
    const page = await this.context.newPage();
    try {
      await page.goto(url);
      await page.bringToFront();
      await page.evaluate((text) => navigator.clipboard.writeText(text), text);
    } finally {
      await page.close();
      await this.page.bringToFront();
    }
  }
}
