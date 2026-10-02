// SPDX-License-Identifier: GPL-3.0-or-later
// text-fragments-polyfill ships plain JS without types; only what snapii
// calls is declared. The package root installs the polyfill as a side
// effect, so it is deliberately not declared and cannot be imported.

declare module "text-fragments-polyfill/dist/fragment-generation-utils.js" {
  export interface GeneratedTextFragment {
    textStart: string;
    textEnd?: string;
    prefix?: string;
    suffix?: string;
  }
  export const GenerateFragmentStatus: {
    readonly SUCCESS: 0;
    readonly INVALID_SELECTION: 1;
    readonly AMBIGUOUS: 2;
    readonly TIMEOUT: 3;
    readonly EXECUTION_FAILED: 4;
  };
  /** Generation gives up with TIMEOUT after this many ms. */
  export function setTimeout(ms: number): void;
  /** Note: moves the range's edges to word bounds and text nodes. */
  export function generateFragmentFromRange(
    range: Range,
    startTime?: number,
  ): { status: number; fragment?: GeneratedTextFragment };
}

// Test-only re-finder (tests/harness); never bundled into the extension.
declare module "text-fragments-polyfill/text-fragment-utils" {
  export interface ParsedTextFragment {
    textStart: string;
    textEnd: string;
    prefix: string;
    suffix: string;
  }
  export function getFragmentDirectives(hash: string): { text?: string[] };
  export function parseFragmentDirectives(directives: { text?: string[] }): { text?: ParsedTextFragment[] };
  export function processFragmentDirectives(
    parsed: { text?: ParsedTextFragment[] },
    documentToProcess?: Document,
    root?: Element,
  ): { text?: HTMLElement[][] };
}
