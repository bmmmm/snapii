// SPDX-License-Identifier: GPL-3.0-or-later
// Streaming PNG decoder (8-bit RGB/RGBA, non-interlaced: what Firefox's
// captureTab/captureVisibleTab produce), for the glue tests and the
// interactive driver.
import { createInflate } from "node:zlib";

/** @param {Buffer} buf */
export function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function unfilter(filter, cur, prev, bpp) {
  const n = cur.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) cur[i] = cur[i] + cur[i - bpp];
      return;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = cur[i] + prev[i];
      return;
    case 3:
      for (let i = 0; i < n; i++) cur[i] = cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      return;
    default:
      throw new Error(`bad PNG filter ${filter}`);
  }
}

/**
 * Calls onRow(y, row, bpp) for every scanline; `row` is reused between calls.
 * @param {Buffer} buf
 */
export async function decodeRows(buf, onRow) {
  pngSize(buf);
  let off = 8;
  let ihdr;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[ihdr.colorType];
  if (!bpp || ihdr.bitDepth !== 8 || ihdr.interlace)
    throw new Error(`unsupported PNG ${JSON.stringify(ihdr)}`);
  const stride = ihdr.width * bpp;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let filter = -1;
  let pos = 0;
  let y = 0;
  const inflate = createInflate({ chunkSize: 1 << 20 });
  const done = new Promise((resolve, reject) => {
    inflate.on("end", resolve);
    inflate.on("error", reject);
  });
  inflate.on("data", (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (filter < 0) {
        filter = chunk[i++];
        pos = 0;
        continue;
      }
      const n = Math.min(stride - pos, chunk.length - i);
      chunk.copy(cur, pos, i, i + n);
      pos += n;
      i += n;
      if (pos === stride) {
        unfilter(filter, cur, prev, bpp);
        onRow(y++, cur, bpp);
        const t = prev;
        prev = cur;
        cur = t;
        filter = -1;
      }
    }
  });
  for (const d of idat) inflate.write(d);
  inflate.end();
  await done;
  return { ...ihdr, rowsDecoded: y };
}
