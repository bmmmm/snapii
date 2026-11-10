// SPDX-License-Identifier: GPL-3.0-or-later
// Every user-visible string, through the browser's i18n API: the language is
// the browser's UI language, the catalogues are src/_locales/*/messages.json.
// Code that runs without the API (unit tests under node, the layout harness
// in a plain page, a stand-in `browser` without i18n) gets the English
// catalogue, bundled from the same file the browser reads, so English exists
// once. A message is data: it goes into textContent or an attribute, never
// into markup, since getMessage does not escape the page values it is given.

import en from "../_locales/en/messages.json" with { type: "json" };

export type MessageKey = keyof typeof en;

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const english: Record<string, Entry> = en;

/** The browser's rules: `$name$` is its placeholder's content, in which `$1`…`$9` are the substitutions; `$$` is "$". */
function format(entry: Entry, subs: readonly string[]): string {
  const substitute = (content: string): string =>
    content.replace(/\$([1-9])/g, (_, n: string) => subs[Number(n) - 1] ?? "");
  return entry.message.replace(/\$\$|\$(\w+)\$/g, (all, name: string | undefined) => {
    if (name === undefined) return "$";
    const placeholder = entry.placeholders?.[name.toLowerCase()];
    return placeholder ? substitute(placeholder.content) : all;
  });
}

function lookup(key: string, subs: readonly string[]): string {
  const api = typeof browser === "undefined" ? undefined : (browser.i18n as typeof browser.i18n | undefined);
  // "" is the API's answer for an unknown key.
  const text = api?.getMessage(key, [...subs]) ?? "";
  if (text !== "") return text;
  const entry = english[key];
  return entry ? format(entry, subs) : key;
}

/** The message `key` in the browser's UI language, `subs` filling its placeholders in order. */
export function msg(key: MessageKey, ...subs: string[]): string {
  return lookup(key, subs);
}

/**
 * Fills the popup's or the settings page's static text: `data-i18n` names the
 * element's text, `data-i18n-placeholder` an input's placeholder.
 */
export function localizePage(doc: Document): void {
  doc.documentElement.lang = msg("htmlLang");
  for (const el of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = lookup(el.dataset.i18n ?? "", []);
  }
  for (const el of doc.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    el.placeholder = lookup(el.dataset.i18nPlaceholder ?? "", []);
  }
}
