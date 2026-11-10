// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for the browser's i18n API that serves one catalogue, for the
// German path in node (tests/unit/i18n-de.test.ts) and in a layout page
// (page.addInitScript, so it must not close over anything). Written apart
// from src/shared/i18n.ts on purpose: it checks what the code asks the API
// for, not the fallback's own substitution.

export type Catalogue = Record<
  string,
  { message: string; placeholders?: Record<string, { content: string }> }
>;

export function installI18n(catalogue: Catalogue, language = "de"): void {
  const getMessage = (name: string, substitutions?: string | string[]): string => {
    const entry = catalogue[name];
    if (!entry) return "";
    const subs =
      substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    return entry.message.replace(/\$\$|\$(\w+)\$/g, (all, placeholder: string | undefined) => {
      if (placeholder === undefined) return "$";
      const content = entry.placeholders?.[placeholder.toLowerCase()]?.content;
      if (content === undefined) return all;
      return content.replace(/\$([1-9])/g, (_, n: string) => subs[Number(n) - 1] ?? "");
    });
  };
  const target = globalThis as { browser?: Record<string, unknown> };
  target.browser = { ...target.browser, i18n: { getMessage, getUILanguage: () => language } };
}
