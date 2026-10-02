// SPDX-License-Identifier: GPL-3.0-or-later
// "Copy text" as text/html: the selected structure (paragraphs, emphasis,
// lists, tables, links) without anything that runs, styles or tracks. The
// result is pasted into rich editors, so every attribute that survives is
// on an allow-list and every string is escaped. Works on a structural tree
// (SNode) so Node tests can build inputs without a DOM.
import { linkFor } from "./links.ts";

export type SNode =
  | { kind: "text"; text: string }
  | { kind: "comment" }
  | { kind: "element"; tag: string; attrs: Record<string, string>; children: SNode[] };

export interface SanitizeContext {
  /** Base URL relative hrefs resolve against (document.baseURI). */
  baseURL: string;
  /** URL of the page, to recognise same-page anchors. */
  pageURL: string;
}

// Content that is code, chrome, form state or a separate document: dropped
// together with everything inside it.
const DROP = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "canvas",
  "svg",
  "math",
  "input",
  "select",
  "textarea",
  "button",
  "head",
  "title",
  "meta",
  "link",
]);

// Structure worth keeping; everything not listed is unwrapped (content kept).
const KEEP = new Set([
  "p",
  "div",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "sub",
  "sup",
  "code",
  "pre",
  "kbd",
  "q",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "tr",
  "td",
  "th",
  "a",
  "abbr",
  "span",
]);

const VOID = new Set(["br"]);
// Cells keep their place even when empty, or the table's columns shift.
const KEEP_EMPTY = new Set(["br", "td", "th"]);

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Allowed attributes of a kept element, in output order; null = unwrap it. */
function keptAttrs(
  tag: string,
  attrs: Record<string, string>,
  ctx: SanitizeContext,
): [string, string][] | null {
  const out: [string, string][] = [];
  if (tag === "a") {
    const href = linkFor({
      tag,
      href: attrs.href ?? null,
      role: attrs.role ?? null,
      baseURL: ctx.baseURL,
      pageURL: ctx.pageURL,
    });
    // A link that leads nowhere outside the page is plain text there.
    if (href === null) return null;
    out.push(["href", href]);
  }
  if (tag === "abbr" && attrs.title !== undefined) out.push(["title", attrs.title]);
  const before = out.length;
  for (const name of ["lang", "dir"]) {
    const value = attrs[name];
    if (value !== undefined) out.push([name, value]);
  }
  // A bare span carries nothing but styling hooks.
  if (tag === "span" && out.length === before) return null;
  return out;
}

function serialize(nodes: readonly SNode[], ctx: SanitizeContext): string {
  let html = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      html += escapeText(node.text);
      continue;
    }
    if (node.kind === "comment") continue;
    const tag = node.tag.toLowerCase();
    if (DROP.has(tag)) continue;
    const inner = serialize(node.children, ctx);
    const attrs = KEEP.has(tag) ? keptAttrs(tag, node.attrs, ctx) : null;
    // Elements whose text was all hidden would paste as empty paragraphs.
    if (attrs === null || (!KEEP_EMPTY.has(tag) && inner.trim() === "")) {
      html += inner;
      continue;
    }
    const open = `<${tag}${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}>`;
    html += VOID.has(tag) ? open : `${open}${inner}</${tag}>`;
  }
  return html;
}

/** Clean, escaped HTML for the given trees. */
export function fragmentToCleanHtml(root: readonly SNode[], ctx: SanitizeContext): string {
  return serialize(root, ctx);
}

// nodeType values, spelled out so this module loads in Node without a DOM.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

function toSNode(node: Node): SNode {
  if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
    return { kind: "text", text: (node as CharacterData).data };
  }
  if (node.nodeType !== ELEMENT_NODE) return { kind: "comment" };
  const el = node as Element;
  const attrs: Record<string, string> = {};
  for (const a of el.attributes) attrs[a.name.toLowerCase()] = a.value;
  return {
    kind: "element",
    tag: el.localName.toLowerCase(),
    attrs,
    children: [...el.childNodes].map(toSNode),
  };
}

/** DOM -> SNode trees: a fragment or document yields its children, any other node its own tree. */
export function toSNodes(fragment: DocumentFragment | Node): SNode[] {
  const t = fragment.nodeType;
  if (t === DOCUMENT_FRAGMENT_NODE || t === DOCUMENT_NODE) return [...fragment.childNodes].map(toSNode);
  return [toSNode(fragment)];
}
