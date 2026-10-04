// SPDX-License-Identifier: GPL-3.0-or-later
// diffRatio: how different two screenshots of the same size look, as the
// share of pixels that differ. A pixel differs when its largest channel
// difference exceeds THRESHOLD against every pixel in the 3×3 neighbourhood
// of the same place in the other image, in either direction: antialiased
// edges one pixel apart do not count. Decoded in the page (canvas), so no
// image library is needed.
import type { Page } from "@playwright/test";

const THRESHOLD = 16;

export interface Diff {
  ratio: number;
  differing: number;
  total: number;
  /** Where the differing pixels are, for a failing spec's message. */
  box: { x: number; y: number; width: number; height: number } | null;
}

export async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<Diff> {
  return page.evaluate(
    async ({ a, b, threshold }) => {
      // Offscreen: the page may be an SVG document, where createElement("canvas") is no canvas.
      const decode = async (url: string) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const [pa, pb] = await Promise.all([decode(a), decode(b)]);
      if (pa.width !== pb.width || pa.height !== pb.height)
        throw new Error(`size differs: ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
      const { width: w, height: h } = pa;
      if (w * h === 0) throw new Error("empty image");
      const near = (p: ImageData, q: ImageData, x: number, y: number): boolean => {
        const i = (y * w + x) * 4;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = (yy * w + xx) * 4;
            let max = 0;
            for (let k = 0; k < 4; k++)
              max = Math.max(max, Math.abs((p.data[i + k] ?? 0) - (q.data[j + k] ?? 0)));
            if (max <= threshold) return true;
          }
        }
        return false;
      };
      let differing = 0;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (near(pa, pb, x, y) && near(pb, pa, x, y)) continue;
          differing++;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      return {
        ratio: differing / (w * h),
        differing,
        total: w * h,
        box: differing ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
      };
    },
    {
      a: `data:image/png;base64,${a.toString("base64")}`,
      b: `data:image/png;base64,${b.toString("base64")}`,
      threshold: THRESHOLD,
    },
  );
}
