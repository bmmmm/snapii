// SPDX-License-Identifier: GPL-3.0-or-later
// window.__snapii as seen by the layout specs (page.evaluate callbacks) and
// by the harness entry that defines it.
interface Window {
  __snapii: import("./entry.ts").Harness;
  /** Optional fixture hook, awaited right before collection (see fixtures.spec.ts). */
  beforeCollect?: () => unknown;
}
