// SPDX-License-Identifier: GPL-3.0-or-later
// Injected on demand. The guard keeps a second injection into the same page
// from registering a second listener; that injection's `start` message then
// reaches the first one, which toggles the open session off.
import { isToContent } from "../shared/messages.ts";
import type { CapturedMessage, CaptureModel, SaveResponse, ToBackground } from "../shared/types.ts";
import { writeClipboard } from "./clipboard.ts";
import { sessionToggle } from "./session.ts";

const GUARD = Symbol.for("snapii.content");
const scope = globalThis as typeof globalThis & { [GUARD]?: true };

/**
 * Where the background's `captured` goes: the save in flight. One at a time,
 * since no session starts while a capture runs (sessionToggle).
 */
let onCaptured: ((message: CapturedMessage) => void) | null = null;

function sendSave(model: CaptureModel, captured: (message: CapturedMessage) => void): Promise<SaveResponse> {
  // Replaces the previous save's, which has its reply by now (a session
  // ignores a `captured` after its reply).
  onCaptured = captured;
  const message: ToBackground = { type: "save", model };
  return browser.runtime.sendMessage(message) as Promise<SaveResponse>;
}

if (!scope[GUARD]) {
  scope[GUARD] = true;
  const toggle = sessionToggle({
    sendSave,
    writeClipboard: (data) => writeClipboard(data),
    now: () => new Date(),
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isToContent(message)) return undefined;
    if (message.type === "start") {
      toggle(message.settings);
    } else {
      const deliver = onCaptured;
      onCaptured = null;
      deliver?.(message);
    }
    return undefined;
  });
}
