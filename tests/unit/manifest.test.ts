// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { manifestFor } from "../../src/shared/manifest.ts";
import { suggestedKeyFor, validateShortcut } from "../../src/shared/shortcut.ts";

const manifest = JSON.parse(readFileSync(new URL("../../src/manifest.json", import.meta.url), "utf8"));

test("manifest: MV3 event page, injected on demand, no data collection", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ["background.js"] });
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, "snapii@qmmq.de");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, {
    required: ["none"],
  });
});

test("manifest: D1 activeTab only, no host permissions, exact permission set", () => {
  // Decision D1 (docs/development.md): captureVisibleTab under activeTab covers every
  // region, so any host access would be an install-time prompt for nothing.
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "scripting",
    "downloads",
    "clipboardWrite",
    "storage",
  ]);
});

test("manifest: extension pages may compile WebAssembly (OCR) and keep Firefox's upgrade-insecure-requests", () => {
  // Firefox's MV3 default is "script-src 'self'; upgrade-insecure-requests;";
  // a policy of our own replaces it whole, so the directive is restated.
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self' 'wasm-unsafe-eval'; upgrade-insecure-requests",
  );
});

test("manifest: the toolbar button opens popup.html; the shortcut is its own command and starts a capture", () => {
  assert.equal(manifest.action.default_popup, "popup.html");
  // With a popup, _execute_action would only open the popup: the default key
  // belongs to start-capture, which the background handles in commands.onCommand.
  assert.deepEqual(manifest.commands["start-capture"], {
    suggested_key: { default: "Ctrl+Alt+S", mac: "Command+Shift+E" },
    description: "Capture a region",
  });
  // Command+Shift+E on a Mac (free there; Ctrl+Shift+E elsewhere is Firefox's
  // Network Monitor, and a built-in key wins), Ctrl+Alt+S elsewhere; both are
  // keys the browser accepts.
  const key = manifest.commands["start-capture"].suggested_key;
  assert.equal(suggestedKeyFor(key, "mac"), "Command+Shift+E");
  assert.equal(suggestedKeyFor(key, "other"), "Ctrl+Alt+S");
  for (const platform of ["mac", "other"] as const) {
    assert.deepEqual(validateShortcut(suggestedKeyFor(key, platform)), { ok: true });
  }
  // Declared without a key, so a user can bind "open the popup" in about:addons.
  assert.deepEqual(manifest.commands._execute_action, { description: "Open the snapii menu" });
  assert.deepEqual(Object.keys(manifest.commands).sort(), ["_execute_action", "start-capture"]);
});

test("manifest for Firefox: the source manifest with the package version, nothing else changed", () => {
  assert.deepEqual(manifestFor("firefox", manifest, "1.2.3"), { ...manifest, version: "1.2.3" });
});

test("manifest for Chromium: a service worker, the offscreen permission, no host access", () => {
  const chromium = manifestFor("chromium", manifest, "1.2.3");
  assert.equal(chromium.version, "1.2.3");
  assert.deepEqual(chromium.background, { service_worker: "background.js" });
  assert.deepEqual(chromium.permissions, [
    "activeTab",
    "scripting",
    "downloads",
    "clipboardWrite",
    "storage",
    "offscreen",
  ]);
  assert.equal(chromium.host_permissions, undefined);
  assert.equal(chromium.optional_host_permissions, undefined);
  assert.equal(chromium.content_scripts, undefined);
});

test("manifest for Chromium: no Gecko block, a minimum version, PNG icons", () => {
  const chromium = manifestFor("chromium", manifest, "1.2.3");
  assert.equal(chromium.browser_specific_settings, undefined);
  // The Chromium facts in src/shared/spike.ts were measured on 151 and 153.
  assert.equal(chromium.minimum_chrome_version, "151");
  const icons = {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  };
  assert.deepEqual(chromium.icons, icons);
  assert.deepEqual(chromium.action, { ...manifest.action, default_icon: icons });
  for (const file of Object.values(icons)) {
    assert.ok(existsSync(new URL(`../../src/${file}`, import.meta.url)), `${file} exists`);
  }
});

test("manifest for Chromium: the capture command keeps Alt+Shift+S, which Chromium loads, and the Mac key; nothing else of the commands changes", () => {
  const chromium = manifestFor("chromium", manifest, "1.2.3");
  const commands = chromium.commands as Record<string, unknown>;
  assert.deepEqual(commands["start-capture"], {
    suggested_key: { default: "Alt+Shift+S", mac: "Command+Shift+E" },
    description: "Capture a region",
  });
  assert.deepEqual(commands._execute_action, manifest.commands._execute_action);
  assert.deepEqual(Object.keys(commands).sort(), ["_execute_action", "start-capture"]);
});

test("manifest for Chromium: popup, options page and CSP are the Firefox ones", () => {
  const chromium = manifestFor("chromium", manifest, "1.2.3");
  for (const key of ["manifest_version", "name", "description", "options_ui", "content_security_policy"]) {
    assert.deepEqual(chromium[key], manifest[key], key);
  }
});
