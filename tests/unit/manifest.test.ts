// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
    suggested_key: { default: "Alt+Shift+S" },
    description: "Capture a region",
  });
  // Declared without a key, so a user can bind "open the popup" in about:addons.
  assert.deepEqual(manifest.commands._execute_action, { description: "Open the snapii menu" });
  assert.deepEqual(Object.keys(manifest.commands).sort(), ["_execute_action", "start-capture"]);
});
