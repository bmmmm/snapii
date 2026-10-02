// SPDX-License-Identifier: GPL-3.0-or-later
// Test-only content script (checklist item 11). Runs the two styling paths of
// src/content/overlay/styles.ts adoptStyles() from the content-script (Xray)
// world and records which of them takes effect: a constructed sheet in
// adoptedStyleSheets, and the fallback <style> element in a closed shadow
// root. On a page with `style-src 'none'` this tells whether the overlay is
// styled because adoptedStyleSheets works or because the fallback slips past
// the CSP.
const out = { url: location.href };

function probeRoot() {
  const host = document.createElement("snapii-probe");
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  const span = document.createElement("span");
  span.className = "x";
  span.textContent = "probe";
  root.append(span);
  return { host, root, span };
}

const a = probeRoot();
try {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(".x { color: rgb(1, 2, 3); }");
  a.root.adoptedStyleSheets = [sheet];
  out.adoptedAssign = "ok";
} catch (e) {
  out.adoptedAssign = `threw: ${e}`;
}
out.adoptedCount = a.root.adoptedStyleSheets.length;
out.adoptedColor = getComputedStyle(a.span).color;

const b = probeRoot();
const style = document.createElement("style");
style.textContent = ".x { color: rgb(4, 5, 6); }";
b.root.prepend(style);
out.styleElementColor = getComputedStyle(b.span).color;

a.host.remove();
b.host.remove();
document.documentElement.setAttribute("data-csp-probe", JSON.stringify(out));
