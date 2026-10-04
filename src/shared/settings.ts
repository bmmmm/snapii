// SPDX-License-Identifier: GPL-3.0-or-later
import type { Settings } from "./types.ts";

export const DEFAULT_SETTINGS: Settings = {
  format: "png",
  jpegQuality: 0.92,
  // Device-pixel budget for one capture; the scale is lowered to stay below it.
  maxTotalPixels: 100_000_000,
  // One <image> per band; Firefox's own Screenshots stitches at far larger sizes.
  maxTilePixels: 32_000_000,
  saveAs: false,
  saveFolder: "",
  occlusionCheck: false,
  textFragment: true,
  // Opt-in: every save with images then starts an 8 MB engine (dist/ocr/).
  ocr: false,
  // The raster file is the public contract; vector output is opt-in while it is in beta.
  output: "raster",
};
