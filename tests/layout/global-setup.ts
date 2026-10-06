// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";

// Every run bundles the harness from the current source: a bare
// `playwright test` on a stale dist-test/ passes against old code, which
// once let a reverted fix stay green.
export default function globalSetup(): void {
  execFileSync(process.execPath, ["scripts/build.mjs", "--test"], { stdio: "inherit" });
}
