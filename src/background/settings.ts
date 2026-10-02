// SPDX-License-Identifier: GPL-3.0-or-later
// Settings = defaults overlaid with the user's stored values. storage.sync is
// written by the options page (M4) and can hold anything an older or newer
// version wrote, so each value is checked and dropped if it does not fit.

import { checkFolder } from "../shared/folder.ts";
import { DEFAULT_SETTINGS } from "../shared/settings.ts";
import type { Settings } from "../shared/types.ts";

const isPositive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
/** Only what the pages store: a folder already in its normalised form. */
const isFolder = (x: unknown): x is string => {
  if (typeof x !== "string") return false;
  const check = checkFolder(x);
  return check.ok && check.folder === x;
};

const VALID: { [K in keyof Settings]: (x: unknown) => x is Settings[K] } = {
  format: (x): x is Settings["format"] => x === "png" || x === "jpeg",
  jpegQuality: (x): x is number => typeof x === "number" && x >= 0 && x <= 1,
  maxTotalPixels: isPositive,
  maxTilePixels: isPositive,
  saveAs: isBool,
  saveFolder: isFolder,
  occlusionCheck: isBool,
  textFragment: isBool,
  ocr: isBool,
};

/** The per-field check loadSettings applies; the options page writes only what passes it. */
export function isValidSetting<K extends keyof Settings>(key: K, value: unknown): value is Settings[K] {
  return VALID[key](value);
}

/** Reads stored values by key; a parameter so unit tests run without `browser`. */
export type StorageGet = (keys: string[]) => Promise<Record<string, unknown>>;

export async function loadSettings(
  get: StorageGet = (keys) => browser.storage.sync.get(keys),
): Promise<Settings> {
  let stored: Record<string, unknown>;
  try {
    stored = await get(Object.keys(DEFAULT_SETTINGS));
  } catch {
    // Storage unavailable (e.g. a broken profile): capturing still works.
    return { ...DEFAULT_SETTINGS };
  }
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(VALID) as Array<keyof Settings>) {
    const value = stored[key];
    if (isValidSetting(key, value)) (settings as Record<keyof Settings, unknown>)[key] = value;
  }
  return settings;
}
