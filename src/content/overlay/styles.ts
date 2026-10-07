// SPDX-License-Identifier: GPL-3.0-or-later
// Styling that survives hostile pages: the host gets CSSOM inline styles
// marked !important (a page CSP's style-src blocks style attributes and
// <style> elements, not CSSOM), the shadow content a constructed stylesheet
// via adoptedStyleSheets (not subject to style-src either).

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * An HTML element in any document. document.createElement on an XML or SVG
 * document (a saved snapii .svg opened directly) gives a null-namespace
 * element without `style` or `attachShadow`; the XHTML namespace does not.
 */
export function createHtml<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
export function createHtml(tag: string): HTMLElement;
export function createHtml(tag: string): HTMLElement {
  return document.createElementNS(XHTML, tag) as HTMLElement;
}

/** Sets each property inline with !important, so page rules cannot override it. */
export function setImportant(el: HTMLElement, props: Record<string, string>): void {
  for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value, "important");
}

/** Base styles of a full-viewport host element; `all:initial` first so it cannot inherit page CSS. */
export function styleHost(host: HTMLElement, extra: Record<string, string> = {}): void {
  setImportant(host, { all: "initial" });
  setImportant(host, {
    display: "block",
    position: "fixed",
    "z-index": "2147483647",
    ...extra,
  });
}

export function adoptStyles(root: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    // Last resort where constructed sheets are unavailable; a strict page
    // CSP blocks this one, which leaves the UI unstyled but working.
    const style = createHtml("style");
    style.textContent = css;
    root.prepend(style);
  }
}

const ACCENT = "#0a84ff";

export const OVERLAY_CSS = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.glass {
  position: fixed; inset: 0;
  cursor: crosshair;
  pointer-events: auto;
}
.box {
  position: fixed;
  pointer-events: none;
  border: 2px solid ${ACCENT};
  background: rgba(10, 132, 255, 0.08);
  /* Dims everything outside the box without a second layer. */
  box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.3);
}
.box.drag { border-style: dashed; }
.hint {
  position: fixed; top: 12px; left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(32, 32, 36, 0.9);
  color: #fff;
  font: 13px/1.3 system-ui, sans-serif;
  white-space: nowrap;
}
.toolbar {
  position: fixed;
  display: flex; gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  font: 13px/1 system-ui, sans-serif;
}
.toolbar button {
  all: unset;
  padding: 8px 12px;
  border-radius: 5px;
  color: #15141a;
  cursor: pointer;
  white-space: nowrap;
}
.toolbar button:hover { background: #e8e8ed; }
.toolbar button kbd {
  margin-left: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  font: 11px/1 system-ui, sans-serif;
  background: rgba(0, 0, 0, 0.08);
}
.toolbar button.primary kbd { background: rgba(255, 255, 255, 0.25); }
.toolbar button.primary { background: ${ACCENT}; color: #fff; }
.toolbar button.primary:hover { background: #0060df; }
.toolbar button:disabled { opacity: 0.5; cursor: progress; }
.toolbar button[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.hint.notice {
  max-width: calc(100vw - 24px);
  white-space: normal;
  text-align: center;
}
`;

export const TOAST_CSS = `
.toast {
  padding: 10px 16px;
  border-radius: 8px;
  background: rgba(32, 32, 36, 0.92);
  color: #fff;
  font: 14px/1.3 system-ui, sans-serif;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  white-space: nowrap;
}
`;
