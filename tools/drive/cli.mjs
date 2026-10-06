// SPDX-License-Identifier: GPL-3.0-or-later
// Interactive driver: one persistent Firefox (the installed release) with
// dist/ as a temporary add-on, driven one command per process through
// Marionette. Every command reconnects, runs, prints one JSON line on stdout
// and disconnects; Firefox, its tabs and the add-on stay between calls.
//
//   pnpm drive start [--headed] [--dpr 2] [--width 1280 --height 800] [--port N] [--force]
//   pnpm drive open <url> | snap ... | save | copy-text | copy-link | copy-page-link | ... | stop
//
// State (profile, downloads, screenshots, Firefox log, state.json) lives in
// SNAPII_DRIVE_DIR, default /tmp/snapii-drive-<hash of the repo path>: stable
// inside and outside a process sandbox (unlike $TMPDIR) and separate per
// checkout. Firefox must run outside the sandbox. See `pnpm drive help`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "../marionette/driver.mjs";
import { attachFirefox, launchFirefox, sleep } from "../marionette/firefox.mjs";
import { clearClipboard, readClipboard } from "../marionette/helpers.mjs";
import { pngSize } from "../marionette/png.mjs";
import { parseSvg } from "../marionette/svg.mjs";
import { timingScript } from "./timing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist");
const DIR = resolve(
  process.env.SNAPII_DRIVE_DIR ??
    `/tmp/snapii-drive-${createHash("sha1").update(ROOT).digest("hex").slice(0, 8)}`,
);
const STATE = join(DIR, "state.json");
const PORTS = [2990, 2999];
const PAGE_LOAD_MS = 30_000;

class UsageError extends Error {}

// ---------------------------------------------------------------- arguments

/**
 * Splits argv into positionals and --flags. `arity` names flags that take
 * values (number of values); every other --flag is boolean.
 */
function parse(argv, arity = {}) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    const n = arity[name] ?? 0;
    if (n === 0) flags[name] = true;
    else {
      const vals = argv.slice(i + 1, i + 1 + n);
      if (vals.length < n) throw new UsageError(`--${name} needs ${n} value(s)`);
      flags[name] = n === 1 ? vals[0] : vals;
      i += n;
    }
  }
  return { pos, flags };
}

function num(v, what) {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) throw new UsageError(`${what} must be a number`);
  return n;
}

// ---------------------------------------------------------------- state

function readState() {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, "utf8"));
}

function writeState(state) {
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Whether something listens on 127.0.0.1:port (a bind attempt, not a connect). */
function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

function requireState() {
  const st = readState();
  if (!st) throw new UsageError(`no driver Firefox (no ${STATE}); run: pnpm drive start`);
  if (!alive(st.pid)) {
    cleanup(st);
    throw new UsageError(`driver Firefox (pid ${st.pid}) is gone; state cleaned up, run: pnpm drive start`);
  }
  return st;
}

function cleanup(st) {
  rmSync(st.profile, { recursive: true, force: true });
  rmSync(STATE, { force: true });
}

/** Runs fn with a fresh session on the running Firefox; always disconnects. */
async function withDriver(fn, timeouts) {
  const st = requireState();
  let s;
  try {
    s = await attachFirefox(st.port, timeouts);
  } catch (e) {
    throw new Error(
      `cannot open a Marionette session on port ${st.port} (${e.message}); is another drive command running?`,
    );
  }
  try {
    return await fn(new Driver(s, { addonId: st.addonId, downloads: st.downloads }), st);
  } finally {
    await s.detach();
  }
}

// ---------------------------------------------------------------- helpers

function build() {
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts/build.mjs")], { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    throw new Error(`build failed:\n${e.stderr?.toString() ?? e.message}`);
  }
  return Date.now() - t0;
}

const cut = (s, n) => (s == null ? s : s.length > n ? `${s.slice(0, n)}…` : s);

/** Page facts after a navigation or input. */
function pageInfo(d) {
  return d.content(`return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    scroll: { x: scrollX, y: scrollY },
    scrollSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    devicePixelRatio,
  };`);
}

/** State of the overlay in the page (closed shadow root, read via the system sandbox). */
function overlayState(d) {
  return d.system(`
    const host = document.querySelector("snapii-overlay");
    const root = host?.openOrClosedShadowRoot;
    if (!root) return { open: false };
    const box = root.querySelector(".box");
    const tb = root.querySelector(".toolbar");
    const out = { open: true, state: tb && !tb.hidden ? "selected" : "hover", selection: null, element: null };
    if (!box || box.hidden) return out;
    const r = box.getBoundingClientRect();
    out.mode = box.classList.contains("drag") ? "drag" : "element";
    const rect = { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    out[out.state === "selected" ? "selection" : "hover"] = rect;
    if (out.mode === "element") {
      // Best effort: the element whose box the overlay draws.
      const same = (e) => {
        const q = e.getBoundingClientRect();
        return Math.abs(q.x - r.x) < 1 && Math.abs(q.y - r.y) < 1 &&
          Math.abs(q.width - r.width) < 1 && Math.abs(q.height - r.height) < 1;
      };
      const cx = Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1);
      for (let e of document.elementsFromPoint(cx, cy)) {
        for (; e; e = e.parentElement) {
          if (e.localName.startsWith("snapii-")) break;
          if (same(e)) {
            out.element = e.localName + (e.id ? "#" + e.id : "") +
              [...e.classList].slice(0, 3).map((c) => "." + c).join("");
            break;
          }
        }
        if (out.element) break;
      }
    }
    return out;`);
}

async function removeToasts(d) {
  await d.system(`for (const t of document.querySelectorAll("snapii-toast")) t.remove(); return true;`);
}

function imageSize(buf, mime) {
  if (mime === "image/png") return pngSize(buf);
  if (mime === "image/jpeg") {
    // SOFn marker: FFC0–FFCF except C4 (DHT), C8 (JPG), CC (DAC).
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** What the orchestrator needs to know about a saved SVG. */
function summarizeSvg(path, text) {
  const svg = parseSvg(text);
  const images = svg.images.map((im) => {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(im.href);
    if (!m) return { href: cut(im.href, 60) };
    const buf = Buffer.from(m[2], "base64");
    return {
      format: m[1],
      bytes: buf.length,
      pixels: imageSize(buf, m[1]),
      width: im.width,
      height: im.height,
    };
  });
  // The whole text layer in document order, line separators included.
  const layer = [...text.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("");
  const plain = layer
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  const c = svg.capture ?? {};
  return {
    path,
    bytes: statSync(path).size,
    source: svg.dc.source ?? null,
    relation: svg.dc.relation ?? null,
    title: svg.dc.title ?? null,
    textFragmentStatus: c.textFragmentStatus ?? null,
    selection: c.selection ?? null,
    runs: svg.tspans.length,
    links: svg.hrefs.length,
    images,
    tiles: c.tiles ?? null,
    skippedFrames: c.skippedFrames ?? null,
    skippedVertical: c.skippedVertical ?? null,
    text: cut(plain, 300),
    textLength: plain.length,
  };
}

/** Clicks a toolbar button and waits for the toast it causes. */
async function toolbarAction(d, action, ms) {
  await removeToasts(d);
  const t0 = Date.now();
  await d.clickToolbar(action);
  const toast = await d.until(() => d.toast(), `a toast after ${action}`, ms);
  return { toast, ms: Date.now() - t0 };
}

const body = (html) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html;

async function copy(d, action) {
  await clearClipboard(d.s);
  const { toast, ms } = await toolbarAction(d, action, 15_000);
  const out = { toast, ms, text: null, html: null };
  if (toast.startsWith("Copied")) {
    const clip = await d.until(
      async () => {
        const c = await readClipboard(d.s);
        return c["text/plain"] ? c : null;
      },
      "the clipboard to be written",
      5000,
    );
    out.text = cut(clip["text/plain"], 4000);
    out.textLength = clip["text/plain"].length;
    out.html = cut(clip["text/html"] && body(clip["text/html"]), 500);
  }
  out.overlay = (await overlayState(d)).open;
  return out;
}

/** "Meta+a", "Shift+Tab", "Escape" → [name, modifiers]. */
function parseKey(spec) {
  const parts = spec.split("+");
  const name = parts.pop() || "+";
  return [name, parts];
}

/** A JS snippet as an ExecuteScript function body: a bare expression gets a return. */
function asBody(js) {
  if (/\breturn\b/.test(js)) return js;
  try {
    new Function(`return (${js});`);
    return `return (${js});`;
  } catch {
    return js;
  }
}

// ---------------------------------------------------------------- commands

async function start(argv) {
  const { flags } = parse(argv, { dpr: 1, width: 1, height: 1, port: 1 });
  const dpr = flags.dpr === undefined ? 2 : num(flags.dpr, "--dpr");
  const width = flags.width === undefined ? 1280 : num(flags.width, "--width");
  const height = flags.height === undefined ? 800 : num(flags.height, "--height");
  const headless = !flags.headed;
  const old = readState();
  if (old && alive(old.pid)) {
    if (!flags.force)
      throw new UsageError(`already running (pid ${old.pid}, port ${old.port}); use --force or stop first`);
    await stop();
  } else if (old) cleanup(old);

  let port;
  if (flags.port !== undefined) port = num(flags.port, "--port");
  else {
    for (let p = PORTS[0]; p <= PORTS[1] && port === undefined; p++) if (await portFree(p)) port = p;
    if (port === undefined) throw new Error(`no free Marionette port in ${PORTS[0]}–${PORTS[1]}`);
  }
  const buildMs = build();

  mkdirSync(DIR, { recursive: true });
  const profile = join(DIR, "profile");
  const downloads = join(DIR, "downloads");
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  let s;
  try {
    s = await launchFirefox({
      port,
      profileRoot: DIR,
      profile,
      headless,
      detached: true,
      env: headless
        ? {
            MOZ_HEADLESS_WIDTH: String(Math.round(width * dpr)),
            MOZ_HEADLESS_HEIGHT: String(Math.round(height * dpr)),
          }
        : {},
      prefs: {
        "layout.css.devPixelsPerPx": String(dpr),
        "browser.download.folderList": 2,
        "browser.download.dir": downloads,
        "browser.download.useDownloadDir": true,
        "browser.download.alwaysOpenPanel": false,
        "browser.translations.automaticallyPopup": false,
      },
    });
    const addonId = await s.installAddon(DIST);
    if (!headless) await s.send("WebDriver:SetWindowRect", { width, height });
    const now = await s.chrome("return Date.now();");
    const state = {
      pid: s.proc.pid,
      port,
      addonId,
      headless,
      dpr,
      window: { width, height },
      dir: DIR,
      profile,
      downloads,
      log: s.logFile,
      startedAt: new Date().toISOString(),
      consoleSince: now,
      shots: 0,
    };
    writeState(state);
    const d = new Driver(s, { addonId, downloads });
    const info = await pageInfo(d);
    await s.detach();
    return {
      started: true,
      pid: state.pid,
      port,
      addonId,
      headless,
      dpr,
      buildMs,
      viewport: info.viewport,
      dir: DIR,
    };
  } catch (e) {
    if (s) await s.quit();
    rmSync(profile, { recursive: true, force: true });
    rmSync(STATE, { force: true });
    throw e;
  }
}

async function stop() {
  const st = readState();
  if (!st) return { stopped: false, reason: "not running" };
  let how = "quit";
  if (alive(st.pid)) {
    try {
      const s = await attachFirefox(st.port);
      await s.quit();
    } catch {
      how = "SIGTERM";
      process.kill(st.pid, "SIGTERM");
    }
    for (let i = 0; i < 50 && alive(st.pid); i++) await sleep(200);
    if (alive(st.pid)) {
      how = "SIGKILL";
      process.kill(st.pid, "SIGKILL");
      for (let i = 0; i < 25 && alive(st.pid); i++) await sleep(200);
    }
  } else how = "already gone";
  cleanup(st);
  return { stopped: true, pid: st.pid, how, kept: st.dir };
}

async function status() {
  const st = readState();
  if (!st) return { running: false, dir: DIR };
  if (!alive(st.pid)) return { running: false, stale: true, pid: st.pid, dir: DIR };
  const page = await withDriver(async (d) => ({ ...(await pageInfo(d)), overlay: await overlayState(d) }));
  return { running: true, pid: st.pid, port: st.port, headless: st.headless, dpr: st.dpr, dir: DIR, page };
}

async function open(argv) {
  const { pos } = parse(argv);
  const url = pos[0];
  if (!url) throw new UsageError("usage: open <url>");
  return withDriver(
    async (d) => {
      let loadTimeout = false;
      const t0 = Date.now();
      try {
        await d.s.navigate(url);
      } catch (e) {
        if (e.error !== "timeout") throw e;
        loadTimeout = true;
      }
      const loadMs = Date.now() - t0;
      await d.frames();
      return { ...(await pageInfo(d)), loadMs, ...(loadTimeout ? { loadTimeout } : {}) };
    },
    { pageLoad: PAGE_LOAD_MS },
  );
}

async function reloadAddon() {
  const buildMs = build();
  return withDriver(async (d, st) => {
    await d.s.send("Addon:Uninstall", { id: st.addonId });
    const addonId = await d.s.installAddon(DIST);
    return { reloaded: addonId, buildMs };
  });
}

async function snap(argv) {
  const { flags } = parse(argv, { element: 1, drag: 4, up: 1 });
  // The keyboard shortcut is the fast default; --popup goes through the toolbar popup's button.
  const via = flags.popup ? "popup" : "shortcut";
  if (flags.element && flags.drag) throw new UsageError("snap takes --element or --drag, not both");
  const up = flags.up === undefined ? 0 : num(flags.up, "--up");
  const drag = flags.drag?.map((v, i) => num(v, `--drag value ${i + 1}`));
  return withDriver(async (d) => {
    let replaced = false;
    if ((await d.overlayPresent()) > 0) {
      await d.key("Escape");
      replaced = true;
    }
    let target = null;
    if (flags.element) {
      target = await d.content(
        `const el = document.querySelector(arguments[0]);
         if (!el) return null;
         el.scrollIntoView({ block: "center", inline: "center" });
         return true;`,
        flags.element,
      );
      if (!target) throw new Error(`no element matches ${flags.element}`);
      await d.frames();
      target = await d.content(
        `const r = document.querySelector(arguments[0]).getBoundingClientRect();
         return { x: r.x, y: r.y, width: r.width, height: r.height };`,
        flags.element,
      );
      if (target.width === 0 || target.height === 0) throw new Error(`${flags.element} has no box`);
    }
    await d.startOverlay(via);
    let point = null;
    if (target) {
      const vp = await d.content(
        "return [document.documentElement.clientWidth, document.documentElement.clientHeight];",
      );
      point = {
        x: Math.min(Math.max(target.x + target.width / 2, 1), vp[0] - 1),
        y: Math.min(Math.max(target.y + target.height / 2, 1), vp[1] - 1),
      };
      await d.move(point.x, point.y);
      await d.click(point.x, point.y);
    } else if (drag) {
      await d.drag(...drag.map(Math.round));
    }
    for (let i = 0; i < up; i++) await d.key("ArrowUp");
    const overlay = await overlayState(d);
    return {
      ...overlay,
      ...(target ? { target, point } : {}),
      ...(replaced ? { replacedOverlay: true } : {}),
    };
  });
}

async function save() {
  return withDriver(async (d) => {
    const before = d.svgFiles();
    let { toast, ms } = await toolbarAction(d, "save", 60_000);
    // With OCR the page is given back before the file is made; the reply's
    // toast follows the "recognizing" one.
    const recognizingMs = toast.startsWith("Saving") ? ms : undefined;
    if (recognizingMs !== undefined) {
      const t0 = Date.now() - ms;
      toast = await d.until(
        async () => {
          const t = await d.toast();
          return t && !t.startsWith("Saving") ? t : null;
        },
        "the toast after recognizing",
        60_000,
      );
      ms = Date.now() - t0;
    }
    if (!toast.startsWith("Saved "))
      return { saved: false, toast, ms, overlay: (await overlayState(d)).open };
    const file = await d.newDownload(before, 30_000);
    return { saved: true, toast, ms, recognizingMs, ...summarizeSvg(file.path, file.text) };
  });
}

/** Opens the toolbar popup on the selected tab, reports what it shows with a screenshot, and closes it. */
async function popup() {
  return withDriver(async (d, st) => {
    const state = await d.openPopup();
    try {
      const buf = await d.s.popupScreenshot();
      mkdirSync(join(DIR, "shots"), { recursive: true });
      st.shots = (st.shots ?? 0) + 1;
      writeState(st);
      const file = join(DIR, "shots", `popup-${String(st.shots).padStart(3, "0")}.png`);
      writeFileSync(file, buf);
      const { ready: _, ...shown } = state;
      return { popup: shown, screenshot: { path: file, ...pngSize(buf) } };
    } finally {
      // A second toolbar click closes it, as for a user.
      await d.s.triggerAction(d.addonId);
      await d.popupClosed();
    }
  });
}

async function cancel() {
  return withDriver(async (d) => {
    await d.key("Escape");
    return { overlay: (await d.overlayPresent()) > 0 };
  });
}

async function key(argv) {
  const { pos, flags } = parse(argv, { times: 1 });
  if (!pos[0]) throw new UsageError("usage: key <name|Mod+name> [--times N]");
  const [name, mods] = parseKey(pos[0]);
  const times = flags.times === undefined ? 1 : num(flags.times, "--times");
  return withDriver(async (d) => {
    for (let i = 0; i < times; i++) await d.key(name, mods);
    return { key: pos[0], times, overlay: await overlayState(d) };
  });
}

async function click(argv) {
  const { pos } = parse(argv);
  const x = num(pos[0], "x");
  const y = num(pos[1], "y");
  return withDriver(async (d) => {
    await d.click(x, y);
    await sleep(200);
    return {
      clicked: { x, y },
      url: await d.content("return location.href;"),
      overlay: await overlayState(d),
    };
  });
}

async function scroll(argv) {
  const { pos } = parse(argv);
  const x = num(pos[0], "x");
  const y = num(pos[1], "y");
  return withDriver(async (d) => {
    await d.content("window.scrollTo(arguments[0], arguments[1]); return true;", x, y);
    await d.frames();
    return { scroll: await d.content("return { x: scrollX, y: scrollY };") };
  });
}

async function screenshot(argv) {
  const { pos } = parse(argv);
  return withDriver(async (d, st) => {
    const buf = await d.s.screenshot();
    let file = pos[0] ? resolve(pos[0]) : null;
    if (!file) {
      st.shots = (st.shots ?? 0) + 1;
      writeState(st);
      mkdirSync(join(DIR, "shots"), { recursive: true });
      file = join(DIR, "shots", `shot-${String(st.shots).padStart(3, "0")}.png`);
    }
    writeFileSync(file, buf);
    return { path: file, ...pngSize(buf), dpr: st.dpr };
  });
}

async function evaluate(argv, ctx) {
  // The script is taken verbatim: only a leading --system is a flag.
  const system = ctx === "content" && argv[0] === "--system";
  const js = (system ? argv.slice(1) : argv).join(" ");
  if (!js) throw new UsageError(`usage: ${ctx === "chrome" ? "eval-chrome" : "eval"} <js>`);
  return withDriver(async (d) => {
    const script = asBody(js);
    let value;
    if (ctx === "chrome") value = await d.s.chrome(script);
    else if (system) value = await d.system(script);
    else value = await d.content(script);
    return { value: value === undefined ? null : value };
  });
}

async function consoleCmd(argv) {
  const { flags } = parse(argv, { limit: 1 });
  const limit = flags.limit === undefined ? 100 : num(flags.limit, "--limit");
  return withDriver(async (d, st) => {
    const since = st.consoleSince ?? 0;
    const now = await d.s.chrome("return Date.now();");
    // Script errors and warnings of every process (forwarded to the parent).
    const scriptErrors = await d.s.chrome(
      `const since = arguments[0];
       return Services.console.getMessageArray()
         .filter((m) => m instanceof Ci.nsIScriptError && (m.timeStamp ?? 0) >= since)
         .filter((e) => !(e.flags & Ci.nsIScriptError.infoFlag))
         .map((e) => ({
           t: e.timeStamp,
           level: e.flags & Ci.nsIScriptError.warningFlag ? "warning" : "error",
           kind: "script",
           message: e.errorMessage,
           source: e.sourceName ? e.sourceName + ":" + e.lineNumber : null,
           category: e.category,
         }));`,
      since,
    );
    // console.error/warn calls of the page and of content scripts: they stay
    // in the tab's content process.
    let consoleCalls = [];
    try {
      consoleCalls = await d.system(
        `const since = arguments[0];
         const storage = Components.classes["@mozilla.org/consoleAPI-storage;1"]
           .getService(Components.interfaces.nsIConsoleAPIStorage);
         return storage.getEvents()
           .filter((e) => (e.level === "error" || e.level === "warn") && e.timeStamp >= since)
           .map((e) => ({
             t: e.timeStamp,
             level: e.level === "warn" ? "warning" : "error",
             kind: "console",
             message: e.arguments.map((a) => {
               try { return typeof a === "string" ? a : String(a?.stack ?? a); } catch { return "?"; }
             }).join(" "),
             source: e.filename ? e.filename + ":" + e.lineNumber : null,
           }));`,
        since,
      );
    } catch (e) {
      consoleCalls = [
        { t: now, level: "error", kind: "driver", message: `content console unreadable: ${e.message}` },
      ];
    }
    st.consoleSince = now + 1;
    writeState(st);
    const all = [...scriptErrors, ...consoleCalls]
      .sort((a, b) => a.t - b.t)
      .map((m) => ({ ...m, message: cut(m.message, 500) }));
    return {
      since: new Date(since).toISOString(),
      errors: all.filter((m) => m.level === "error").length,
      warnings: all.filter((m) => m.level === "warning").length,
      messages: all.slice(-limit),
    };
  });
}

async function timing(argv) {
  const { flags } = parse(argv, { runs: 1 });
  const runs = flags.runs === undefined ? 3 : num(flags.runs, "--runs");
  const script = await timingScript(ROOT);
  return withDriver(async (d) => {
    const ov = await overlayState(d);
    if (!ov.selection) throw new Error("no selection: run snap first");
    return d.content(script, ov.selection, ov.mode, runs);
  });
}

const HELP = `pnpm drive <command> — persistent Firefox with snapii loaded; one JSON line per command.
State dir: ${DIR} (SNAPII_DRIVE_DIR overrides). Global: --timeout <ms> (default 90000).
  start [--headed] [--dpr 2] [--width 1280 --height 800] [--port N] [--force]
  status | stop
  open <url>                      navigate the selected tab, wait for load (30 s)
  reload-addon                    rebuild dist/ and reinstall the add-on
  snap [--element <css> | --drag x1 y1 x2 y2] [--up N] [--popup]
                                  open the overlay (the start-capture shortcut; --popup: the toolbar
                                  popup's Capture region) and select
  popup                           open the toolbar popup: what it shows + screenshot, then close it
  save | copy-text | copy-link | copy-page-link
                                  click the toolbar button, wait for the toast
  cancel | key <name|Mod+name> [--times N] | click x y | scroll x y
  screenshot [file.png]           content viewport at device px
  eval [--system] <js>            in the page; an expression, or statements with return (--system:
                                  Marionette's system sandbox, sees closed shadow roots)
  eval-chrome <js>                in the browser chrome
  console [--limit N]             errors and warnings since the last call
  timing [--runs N]               text-fragment generation time for the current selection`;

const COMMANDS = {
  start,
  stop,
  status,
  open,
  "reload-addon": reloadAddon,
  snap,
  popup,
  save,
  "copy-text": () => withDriver((d) => copy(d, "copy-text")),
  "copy-link": () => withDriver((d) => copy(d, "copy-link")),
  "copy-page-link": () => withDriver((d) => copy(d, "copy-page-link")),
  cancel,
  key,
  click,
  scroll,
  screenshot,
  eval: (argv) => evaluate(argv, "content"),
  "eval-chrome": (argv) => evaluate(argv, "chrome"),
  console: consoleCmd,
  timing,
};

async function main() {
  let argv = process.argv.slice(2);
  let timeoutMs = 90_000;
  const ti = argv.indexOf("--timeout");
  if (ti >= 0 && argv[0] !== "eval" && argv[0] !== "eval-chrome") {
    timeoutMs = num(argv[ti + 1], "--timeout");
    argv = [...argv.slice(0, ti), ...argv.slice(ti + 2)];
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw new UsageError(`unknown command ${cmd}; see: pnpm drive help`);
  let timer;
  const result = await Promise.race([
    fn(rest),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${cmd} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    process.exit(e instanceof UsageError ? 2 : 1);
  },
);
