// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal Marionette client: length-prefixed JSON over TCP ("<len>:<json>").
// Commands are [0, id, name, params]; replies are [1, id, error, result].
import net from "node:net";

export class MarionetteError extends Error {
  constructor(command, err) {
    super(`${command}: ${err.error ?? "error"}: ${err.message ?? ""}`);
    this.name = "MarionetteError";
    this.error = err.error;
    this.remoteStack = err.stacktrace;
  }
}

/**
 * Connects once; rejects if nothing listens on the port.
 * @param {number} port
 * @returns {Promise<{send: (name: string, params?: object) => Promise<any>, close: () => void, hello: object}>}
 */
export function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let nextId = 0;
    let hello = null;
    const pending = new Map();
    const api = {
      send(name, params = {}) {
        const id = ++nextId;
        const body = JSON.stringify([0, id, name, params]);
        sock.write(`${Buffer.byteLength(body)}:${body}`);
        return new Promise((res, rej) => pending.set(id, { res, rej, name }));
      },
      close() {
        sock.end();
      },
      get hello() {
        return hello;
      },
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(58);
        if (colon < 0) return;
        const len = Number(buf.subarray(0, colon).toString());
        if (buf.length < colon + 1 + len) return;
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString());
        buf = buf.subarray(colon + 1 + len);
        if (!hello) {
          hello = msg;
          resolve(api);
          continue;
        }
        const [, id, err, result] = msg;
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        if (err) p.rej(new MarionetteError(p.name, err));
        else p.res(result);
      }
    });
    sock.on("error", (e) => {
      if (!hello) reject(e);
      for (const p of pending.values()) p.rej(e);
      pending.clear();
    });
    sock.on("close", () => {
      for (const p of pending.values()) p.rej(new Error("marionette connection closed"));
      pending.clear();
    });
  });
}
