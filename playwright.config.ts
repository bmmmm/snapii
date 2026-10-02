// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

// Overridable so parallel checkouts never reuse each other's fixture server
// (reuseExistingServer would silently serve the other tree's tests/).
const PORT = Number(process.env.SNAPII_PORT ?? 8438);

export default defineConfig({
  testDir: "tests/layout",
  // Pinned, not defaulted: Playwright imports whatever it matches, and the
  // default pattern would also collect the node:test suites in tests/unit.
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    // 127.0.0.1, not localhost: a machine that resolves localhost to ::1
    // first spends a connect timeout per navigation before falling back.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "firefox", use: { ...devices["Desktop Firefox"] } }],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory tests`,
    url: `http://127.0.0.1:${PORT}/fixtures/smoke.html`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    timeout: 30_000,
  },
});
