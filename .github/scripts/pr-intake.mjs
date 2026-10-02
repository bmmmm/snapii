// SPDX-License-Identifier: GPL-3.0-or-later
// Advisory PR-body check. Reads the body from $PR_BODY (never from argv or a
// shell interpolation — it is attacker-controlled text from a fork) and
// writes a checklist of what is still open to the job summary. Never fails a
// build: it is a reading aid for the reviewer, not a gate.
import { appendFile, readFile } from "node:fs/promises";

const body = (process.env.PR_BODY ?? "").replace(/\r\n?/g, "\n");
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

/**
 * Text of a `## Heading` section, up to the next heading of the same level.
 * Split rather than matched: a lookahead would need an end-of-input anchor,
 * and JS has none — the last section on the page would always come back empty.
 */
function section(name) {
  for (const part of body.split(/^##[ \t]+/m).slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    if (heading.toLowerCase() === name.toLowerCase()) {
      return (nl === -1 ? "" : part.slice(nl + 1)).trim();
    }
  }
  return "";
}

/**
 * Strip HTML comments — template guidance must not count as filled in. An
 * unterminated `<!--` swallows the rest, so the template's own prose can never
 * pass for the author's.
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
}

// The template's example claims sit inside a comment, so an untouched
// template has no bullets here at all.
const claims = stripComments(section("Claims"))
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^[*+-][^\S\n]+\S/.test(l) && !/^[*+-][^\S\n]+\[[ x]\]/i.test(l));

const verification = stripComments(section("Verification"));
// The template ships commands as `$ ...` lines and asks for more of them;
// only what is neither a fence nor a command counts as pasted output.
const outputLines = verification
  .split("\n")
  .filter((l) => l.trim() && !/^(```|\$[^\S\n])/.test(l.trim())).length;

const tests = stripComments(section("Tests"));
// `\s` would match the newline and count the *next* line as an answer, so an
// empty field would read as filled in. Match only same-line content.
const SAME_LINE = "[^\\S\\n]*\\S";
const testsAnswered =
  new RegExp(`added / changed:${SAME_LINE}`, "i").test(tests) ||
  new RegExp(`fails on \`?main\`?[^\\n]*:${SAME_LINE}`, "i").test(tests);

const contracts = section("Public contracts");
const ticked = (contracts.match(/^- \[x\]/gim) ?? []).length;
const boxes = (contracts.match(/^- \[[ x]\]/gim) ?? []).length;
// Deleting the unticked lines must not read as "all confirmed": compare with
// the template's own count (0 when the template cannot be read).
let templateBoxes = 0;
try {
  const template = await readFile(new URL("../PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
  const part = template.split(/^##[ \t]+Public contracts/m)[1]?.split(/^##[ \t]/m)[0] ?? "";
  templateBoxes = (part.match(/^- \[ \]/gm) ?? []).length;
} catch {
  // Reading aid only: without the template, fall back to the body's own count.
}
const requiredBoxes = Math.max(boxes, templateBoxes, 1);

const risk = stripComments(section("Risk and rollback"));
const riskAnswered = new RegExp(`:${SAME_LINE}`).test(risk);

const assistance = section("Assistance");
const assistanceTicked = (assistance.match(/^- \[x\]/gim) ?? []).length;

const whatWhy = stripComments(section("What and why"));
// GitHub's closing keywords, also with a colon or an owner/repo prefix; not
// inside template comments, and never across a line break.
const CLOSING =
  /\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?[^\S\n]+(([\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;
const linksIssue = CLOSING.test(stripComments(body));

const checks = [
  {
    ok: claims.length > 0,
    name: "Claims",
    detail: claims.length
      ? `${claims.length} claim${claims.length === 1 ? "" : "s"}`
      : "no bullets outside the template comment",
  },
  {
    ok: whatWhy.length >= 40,
    name: "What and why",
    detail: whatWhy.length ? `${whatWhy.length} characters` : "empty",
  },
  {
    ok: outputLines > 0,
    name: "Verification output",
    detail: outputLines > 0 ? "contains output, not just the commands" : "commands only — no output pasted",
  },
  {
    ok: testsAnswered,
    name: "Tests",
    detail: testsAnswered ? "answered" : "neither the test nor a reason for its absence is filled in",
  },
  {
    ok: ticked >= requiredBoxes,
    name: "Public contracts",
    detail: boxes ? `${ticked}/${requiredBoxes} confirmed` : "section missing",
  },
  {
    ok: riskAnswered,
    name: "Risk and rollback",
    detail: riskAnswered ? "answered" : "empty",
  },
  {
    ok: assistanceTicked === 2,
    name: "Assistance",
    detail: `${assistanceTicked}/2 confirmed`,
  },
  {
    ok: linksIssue,
    name: "Linked issue",
    detail: linksIssue ? "found" : "no `Closes #N` — fine for trivial fixes",
  },
];

/**
 * Render PR-body text so it cannot forge the summary around it: a claim line
 * can carry the HTML subset the summary renders and fake a row above the real
 * ones. The fence outgrows the longest backtick run in the content, so the
 * text cannot close it either.
 */
function quoted(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

const missing = checks.filter((c) => !c.ok);
const lines = [
  "## PR intake",
  "",
  missing.length === 0
    ? "Everything the review needs is here."
    : `${missing.length} of ${checks.length} items still open. This check never fails a build — it is a reading aid for the reviewer.`,
  "",
  "| | Item | Notes |",
  "|---|---|---|",
  ...checks.map((c) => `| ${c.ok ? "✓" : "○"} | ${c.name} | ${c.detail} |`),
  "",
];
if (claims.length) {
  lines.push(
    "### Claims to check against the diff",
    "",
    ...quoted(claims.map((c) => c.replace(/^[*+-][^\S\n]+/, "- ")).join("\n")),
    "",
  );
}

const out = `${lines.join("\n")}\n`;
if (summaryFile) await appendFile(summaryFile, out);
else process.stdout.write(out);
