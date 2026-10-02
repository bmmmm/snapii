// SPDX-License-Identifier: GPL-3.0-or-later
// Launches a throw-away Firefox profile with Marionette enabled and wraps the
// commands the extension glue tests need (chrome/content script evaluation,
// temporary add-on install, toolbar click and keyboard shortcut with the same
// activeTab grant a user gesture gives).
//
// Firefox must run outside a process sandbox (a sandboxed parent breaks it).
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./client.mjs";

export const FIREFOX_BIN = process.env.SNAPII_FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same rule as ExtensionCommon.makeWidgetId: used for toolbar widget and keyset ids. */
export const widgetId = (addonId) => addonId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

const BASE_PREFS = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "app.update.disabledForTesting": true,
};

async function portIsFree(port) {
  try {
    const c = await connect(port);
    c.close();
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {object} o
 * @param {number} o.port Marionette port
 * @param {string} o.profileRoot directory that receives the fresh profile and the Firefox log
 * @param {Record<string, string|number|boolean>} [o.prefs] extra user.js prefs
 * @param {Record<string, string>} [o.env] extra environment for the Firefox process
 * @param {boolean} [o.headless] default true
 * @param {boolean} [o.detached] let Firefox outlive this Node process (log written
 *   straight to the file, the child unref'd); the Session then holds no pipes
 * @param {string} [o.profile] use (and create) this profile directory instead of a fresh temp one
 * @returns {Promise<Session>}
 */
export async function launchFirefox({
  port,
  profileRoot,
  prefs = {},
  env = {},
  firefox = FIREFOX_BIN,
  headless = true,
  detached = false,
  profile: fixedProfile,
}) {
  if (!(await portIsFree(port))) throw new Error(`marionette port ${port} is already in use`);
  mkdirSync(profileRoot, { recursive: true });
  const profile = fixedProfile ?? mkdtempSync(join(profileRoot, "prof-"));
  mkdirSync(profile, { recursive: true });
  const all = { ...BASE_PREFS, "marionette.port": port, ...prefs };
  writeFileSync(
    join(profile, "user.js"),
    Object.entries(all)
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`)
      .join(""),
  );
  const logFile = join(profileRoot, `firefox-${port}.log`);
  const args = ["--marionette", "--remote-allow-system-access", ...(headless ? ["-headless"] : [])];
  args.push("-no-remote", "-profile", profile);
  let proc;
  if (detached) {
    const fd = openSync(logFile, "a");
    proc = spawn(firefox, args, {
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...env },
      detached: true,
    });
    closeSync(fd);
    proc.unref();
  } else {
    const log = createWriteStream(logFile);
    proc = spawn(firefox, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    proc.stdout.pipe(log);
    proc.stderr.pipe(log);
  }
  let spawnError = null;
  proc.on("error", (e) => {
    spawnError = e;
  });
  let client;
  for (let i = 0; i < 120 && !client; i++) {
    if (spawnError) throw new Error(`cannot start ${firefox}: ${spawnError.message}`);
    if (proc.exitCode !== null) throw new Error(`firefox exited early (${proc.exitCode}), see ${logFile}`);
    try {
      client = await connect(port);
    } catch {
      await sleep(500);
    }
  }
  if (!client) {
    proc.kill();
    throw new Error(`marionette did not come up on ${port}, see ${logFile}`);
  }
  const session = new Session(client, proc, profile, logFile);
  try {
    session.capabilities = (await session.send("WebDriver:NewSession", { capabilities: {} })).capabilities;
    await session.send("WebDriver:SetTimeouts", { script: 900_000, pageLoad: 60_000 });
  } catch (e) {
    await session.quit();
    throw e;
  }
  return session;
}

/**
 * A new WebDriver session on an already running Firefox (one launched with
 * `detached`). Marionette ends a session when its client disconnects, but
 * tabs, the selected tab and temporary add-ons stay (measured on Fx157), so
 * every short-lived client can start its own session.
 * @param {number} port
 * @param {{ script?: number, pageLoad?: number }} [timeouts]
 */
export async function attachFirefox(port, { script = 900_000, pageLoad = 60_000 } = {}) {
  const client = await connect(port);
  const session = new Session(client, null, null, null);
  try {
    session.capabilities = (await session.send("WebDriver:NewSession", { capabilities: {} })).capabilities;
    await session.send("WebDriver:SetTimeouts", { script, pageLoad });
  } catch (e) {
    client.close();
    throw e;
  }
  return session;
}

export class Session {
  constructor(client, proc, profile, logFile) {
    this.client = client;
    this.proc = proc;
    this.profile = profile;
    this.logFile = logFile;
    this.ctx = "content";
  }

  send(name, params) {
    return this.client.send(name, params);
  }

  async context(ctx) {
    if (this.ctx === ctx) return;
    await this.send("Marionette:SetContext", { value: ctx });
    this.ctx = ctx;
  }

  /** Runs a function body in the given context; a returned promise is awaited. */
  async exec(ctx, script, args = []) {
    await this.context(ctx);
    const r = await this.send("WebDriver:ExecuteScript", { script, args });
    return r.value;
  }

  /** Runs a function body whose last argument is the resolve callback. */
  async execAsync(ctx, script, args = []) {
    await this.context(ctx);
    const r = await this.send("WebDriver:ExecuteAsyncScript", { script, args });
    return r.value;
  }

  chrome(script, ...args) {
    return this.exec("chrome", script, args);
  }

  content(script, ...args) {
    return this.exec("content", script, args);
  }

  async navigate(url) {
    await this.context("content");
    await this.send("WebDriver:Navigate", { url });
  }

  /**
   * WebDriver input actions in the content context. In chrome context the
   * same coordinates would be relative to the browser window (toolbars
   * included), so the context is switched first.
   */
  async perform(actions) {
    await this.context("content");
    await this.send("WebDriver:PerformActions", { actions });
    await this.send("WebDriver:ReleaseActions", {});
  }

  /** PNG (Buffer) of the content viewport at device pixels. */
  async screenshot() {
    await this.context("content");
    const r = await this.send("WebDriver:TakeScreenshot", { full: false, hash: false });
    return Buffer.from(r.value, "base64");
  }

  async installAddon(path) {
    const r = await this.send("Addon:Install", { path, temporary: true });
    return r.value;
  }

  /**
   * Clicks the extension's toolbar action the way a user does: Firefox's
   * browserAction.triggerAction() grants activeTab and opens the action's
   * popup (or dispatches onClicked when there is none; a second call while
   * the popup is open closes it). The CustomizableUI widget node is not
   * clickable: MV3 actions live in the unified-extensions panel.
   */
  triggerAction(addonId) {
    return this.chrome(
      `const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
       const ext = WebExtensionPolicy.getByID(arguments[0]).extension;
       ExtensionParent.apiManager.global.browserActionFor(ext).triggerAction(window);
       return true;`,
      addonId,
    );
  }

  /**
   * Fires the add-on's keyboard shortcut through its XUL <key> element, the
   * path a real key press takes (commands.onCommand, with the activeTab grant).
   * Firefox builds one <key> per bound command and gives it no name, so an
   * add-on with more than one bound shortcut is refused rather than guessed.
   */
  triggerShortcut(addonId) {
    return this.chrome(
      `const keys = document.querySelectorAll("#ext-keyset-id-" + arguments[0] + " > key");
       if (keys.length !== 1) throw new Error(keys.length + " shortcut <key> elements for " + arguments[0]);
       const key = keys[0];
       key.dispatchEvent(new CustomEvent("command", { bubbles: true }));
       return { key: key.getAttribute("key"), modifiers: key.getAttribute("modifiers") };`,
      widgetId(addonId),
    );
  }

  /**
   * Alt+Shift+<letter> as key events of the browser window, through its
   * TextInputProcessor: the path of a physical key press, on which every bound
   * command's XUL <key> listens. triggerShortcut instead fires the `command`
   * event of one <key>, which cannot tell which of two keys on the same
   * combination a press would reach.
   * @param {string} letter one letter, A-Z
   */
  pressAltShift(letter) {
    return this.chrome(
      `const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
       if (!tip.beginInputTransactionForTests(window)) throw new Error("no input transaction");
       const letter = arguments[0].toUpperCase();
       const key = (key, code, keyCode) => new KeyboardEvent("", { key, code, keyCode });
       const alt = key("Alt", "AltLeft", 18);
       const shift = key("Shift", "ShiftLeft", 16);
       const main = key(letter, "Key" + letter, letter.charCodeAt(0));
       tip.keydown(alt);
       tip.keydown(shift);
       tip.keydown(main);
       tip.keyup(main);
       tip.keyup(shift);
       tip.keyup(alt);
       return true;`,
      letter,
    );
  }

  /** Number of open extension action popups (their <browser> in the browser window). */
  popupCount() {
    return this.chrome(`return document.querySelectorAll(".webextension-popup-browser").length;`);
  }

  /**
   * State of the panel around the popup: "animating" while it slides in
   * (else the panel's own state: "showing", "open", ...), or null without a
   * popup. Clicks before "open" do not reach the popup (measured on Fx157).
   */
  popupPanelState() {
    return this.chrome(
      `const p = document.querySelector(".webextension-popup-browser")?.closest("panel");
       return p ? (p.hasAttribute("animating") ? "animating" : p.state) : null;`,
    );
  }

  /**
   * Runs `fn(window, ...args)` in the open action popup and returns its
   * (JSON-able) result. The popup is a remote <browser> in a panel, which
   * Marionette cannot switch into (SwitchToFrame: "Unable to locate frame",
   * measured on Fx157); a frame script loaded into it runs with chrome
   * privileges in the popup's process and reports back by message.
   * @param {Function} fn serialised with toString(): no closures
   */
  async inPopup(fn, ...args) {
    const r = await this.execAsync(
      "chrome",
      `const [src, args, done] = arguments;
       const b = document.querySelector(".webextension-popup-browser");
       if (!b) return done({ error: "no open popup" });
       const mm = b.messageManager;
       const name = "marionette-popup:" + Math.random();
       mm.addMessageListener(name, function reply(m) {
         mm.removeMessageListener(name, reply);
         done(m.data);
       });
       const script = "(async () => { let r; try { r = { value: await (" + src + ")(content, ..." +
         JSON.stringify(args) + ") }; } catch (e) { r = { error: String(e) }; } sendAsyncMessage(" +
         JSON.stringify(name) + ", r); })()";
       mm.loadFrameScript("data:," + encodeURIComponent(script), false);`,
      [fn.toString(), args],
    );
    if (r.error) throw new Error(`in popup: ${r.error}`);
    return r.value;
  }

  /**
   * A real (trusted) mouse click on the element matching `selector` in the
   * open popup: WebDriver pointer actions in the chrome context at the
   * element's position in the browser window. Firefox routes them into the
   * panel and on to the popup's process like a user's click.
   */
  async clickInPopup(selector) {
    const at = await this.inPopup((w, sel) => {
      const el = w.document.querySelector(sel);
      if (!el) throw new Error(`no ${sel} in the popup`);
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector);
    const origin = await this.chrome(
      `const b = document.querySelector(".webextension-popup-browser");
       return { x: b.screenX - window.mozInnerScreenX, y: b.screenY - window.mozInnerScreenY };`,
    );
    const x = Math.round(origin.x + at.x);
    const y = Math.round(origin.y + at.y);
    await this.context("chrome");
    await this.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "pointer",
          id: "popup-mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x, y, origin: "viewport" },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.send("WebDriver:ReleaseActions", {});
  }

  /**
   * A trusted key press in the open popup, to its focused element. Chrome
   * context key actions go to the browser window's widget, not the panel's
   * (measured: Enter there never reached the popup), so the popup's own
   * TextInputProcessor dispatches it, as a keyboard would.
   * @param {string} key a KeyboardEvent.key value ("Enter", " ", "Tab")
   */
  keyInPopup(key) {
    return this.inPopup((w, k) => {
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(w)) throw new Error("no input transaction");
      const codes = { Enter: ["Enter", 13], Tab: ["Tab", 9], " ": ["Space", 32] };
      const [code, keyCode] = codes[k] ?? [k, 0];
      const ev = new w.KeyboardEvent("", { key: k, code, keyCode });
      tip.keydown(ev);
      tip.keyup(ev);
      return true;
    }, key);
  }

  /**
   * Types `text` into the popup's focused element, key by key as a keyboard
   * would. Letters, digits, space, "/" and "." only: the key names of the rest
   * are not worth guessing here.
   */
  typeInPopup(text) {
    return this.inPopup((w, text) => {
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(w)) throw new Error("no input transaction");
      for (const ch of text) {
        let code;
        let keyCode;
        if (/^[a-z]$/i.test(ch)) [code, keyCode] = [`Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0)];
        else if (/^[0-9]$/.test(ch)) [code, keyCode] = [`Digit${ch}`, ch.charCodeAt(0)];
        else if (ch === " ") [code, keyCode] = ["Space", 32];
        else if (ch === "/") [code, keyCode] = ["Slash", 191];
        else if (ch === ".") [code, keyCode] = ["Period", 190];
        else throw new Error(`cannot type ${JSON.stringify(ch)}`);
        const ev = new w.KeyboardEvent("", { key: ch, code, keyCode });
        tip.keydown(ev);
        tip.keyup(ev);
      }
      return true;
    }, text);
  }

  /** PNG (Buffer) of the open popup's page at device pixels, as the panel shows it. */
  async popupScreenshot() {
    const url = await this.chrome(
      `const b = document.querySelector(".webextension-popup-browser");
       if (!b) throw new Error("no open popup");
       return (async () => {
         const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(null, window.devicePixelRatio, "white");
         const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
         canvas.width = bitmap.width;
         canvas.height = bitmap.height;
         canvas.getContext("2d").drawImage(bitmap, 0, 0);
         return canvas.toDataURL("image/png");
       })();`,
    );
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  }

  /** "starting" | "running" | "suspending" | "stopped" (event page lifecycle). */
  backgroundState(addonId) {
    return this.chrome(
      "return WebExtensionPolicy.getByID(arguments[0])?.extension?.backgroundState ?? null;",
      addonId,
    );
  }

  async quit() {
    try {
      await Promise.race([this.send("Marionette:Quit", { flags: ["eForceQuit"] }), sleep(5000)]);
    } catch {
      // the connection drops while Firefox exits
    }
    this.client.close();
    await sleep(300);
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
  }

  /** Ends this client's session and connection; Firefox keeps running. */
  async detach() {
    try {
      await Promise.race([this.send("WebDriver:DeleteSession", {}), sleep(2000)]);
    } catch {
      // the session is gone with the connection anyway
    }
    this.client.close();
  }
}
