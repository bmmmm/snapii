// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny static file server with a POST hook, for fixture pages and for an
// extension under test to report results back to the driver (CORS "*").

import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".xhtml": "application/xhtml+xml",
  ".png": "image/png",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

/**
 * @param {object} o
 * @param {string} o.root directory served for GET
 * @param {number} o.port
 * @param {string} [o.host]
 * @param {(url: URL, body: Buffer) => Promise<unknown> | unknown} [o.onPost] JSON-serialisable reply
 * @param {(url: URL) => Record<string, string> | undefined} [o.headers] extra response headers per GET
 *   (e.g. a Content-Security-Policy that only an HTTP header can set fully)
 */
export function startServer({
  root,
  port,
  host = "127.0.0.1",
  onPost = () => ({}),
  headers = () => undefined,
}) {
  const base = normalize(root + sep);
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const out = await onPost(url, Buffer.concat(chunks));
        res.writeHead(200, { ...CORS, "content-type": "application/json" });
        res.end(JSON.stringify(out ?? {}));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(String(e));
      }
      return;
    }
    const path = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!path.startsWith(base)) {
      res.writeHead(403, CORS);
      res.end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        ...CORS,
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        "cache-control": "no-store",
        ...headers(url),
      });
      res.end(body);
    } catch {
      res.writeHead(404, CORS);
      res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      resolve({
        url: `http://${host}:${port}`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      }),
    );
  });
}
