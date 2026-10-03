// SPDX-License-Identifier: GPL-3.0-or-later
// Bundles the extension into dist/ (Firefox) and dist-chromium/ (and, with
// --test, the layout-test harness into dist-test/). One IIFE per entry,
// unminified so store reviewers can read it.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { manifestFor } from "../src/shared/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const test = process.argv.includes("--test");

const common = {
  bundle: true,
  format: "iife",
  minify: false,
  legalComments: "inline",
  logLevel: "warning",
};

// tesseract.js's index.js pulls in regenerator-runtime for browsers without
// async functions; Firefox 140 has them, and the polyfill's Function()
// fallback is a DANGEROUS_EVAL warning in web-ext lint. It is replaced by an
// empty module (only in our bundle; the shipped worker.min.js stays as released).
const noRegenerator = {
  name: "no-regenerator",
  setup(b) {
    b.onResolve({ filter: /^regenerator-runtime\/runtime$/ }, (args) => ({
      path: args.path,
      namespace: "empty",
    }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "" }));
  },
};

function buildInfo() {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    return {
      commit: git("rev-parse", "--short", "HEAD"),
      dirty: git("status", "--porcelain") !== "",
      builtAt: new Date().toISOString(),
    };
  } catch {
    return { commit: null, dirty: false, builtAt: new Date().toISOString() };
  }
}

// Chromium 151 is the oldest the Chromium facts in src/shared/spike.ts were measured on.
const TARGETS = {
  firefox: { outdir: "dist", esbuild: "firefox140", background: "src/background/main.ts" },
  chromium: { outdir: "dist-chromium", esbuild: "chrome151", background: "src/background/chromium/main.ts" },
};

if (test) {
  const outdir = join(root, "dist-test");
  await rm(outdir, { recursive: true, force: true });
  await build({
    ...common,
    target: TARGETS.firefox.esbuild,
    entryPoints: { harness: join(root, "tests/harness/entry.ts") },
    outdir,
  });
} else {
  const info = buildInfo();
  for (const target of Object.keys(TARGETS)) await buildExtension(target, info);
}

async function buildExtension(target, info) {
  const config = TARGETS[target];
  const outdir = join(root, config.outdir);
  await rm(outdir, { recursive: true, force: true });
  await build({
    ...common,
    target: config.esbuild,
    // src/shared/target.ts reads it: the pages and the content script are the
    // same source for both browsers.
    define: { SNAPII_TARGET: JSON.stringify(target) },
    entryPoints: {
      background: join(root, config.background),
      content: join(root, "src/content/main.ts"),
      options: join(root, "src/options/options.ts"),
      popup: join(root, "src/popup/popup.ts"),
      // What a service worker cannot do runs in Chromium's offscreen document.
      ...(target === "chromium" ? { offscreen: join(root, "src/offscreen/main.ts") } : {}),
    },
    outdir,
    plugins: [noRegenerator],
  });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const source = JSON.parse(await readFile(join(root, "src/manifest.json"), "utf8"));
  const manifest = manifestFor(target, source, pkg.version);
  await writeFile(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Shown at the bottom of the options page and the popup to tell builds apart. Data, not
  // code, so a rebuild from a source archive (no git) only differs here.
  await writeFile(join(outdir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  for (const f of ["options.html", "options.css"])
    await copyFile(join(root, "src/options", f), join(outdir, f));
  for (const f of ["popup.html", "popup.css"]) await copyFile(join(root, "src/popup", f), join(outdir, f));
  if (target === "chromium") {
    await copyFile(join(root, "src/offscreen/offscreen.html"), join(outdir, "offscreen.html"));
  }
  await mkdir(join(outdir, "icons"), { recursive: true });
  for (const icon of new Set(Object.values(manifest.icons))) {
    await copyFile(join(root, "src", icon), join(outdir, icon));
  }
  for (const f of ["LICENSE", "NOTICE"]) await copyFile(join(root, f), join(outdir, f));
  // content.js bundles the polyfill's code; Apache-2.0 §4(a) wants its
  // license text shipped along.
  await mkdir(join(outdir, "LICENSES"), { recursive: true });
  await copyFile(
    join(root, "node_modules/text-fragments-polyfill/LICENSE"),
    join(outdir, "LICENSES/text-fragments-polyfill.txt"),
  );
  await copyOcr(outdir);
}

/**
 * The OCR engine, copied unmodified from the official npm releases (AMO wants
 * third-party minified files byte-identical to a published release): the
 * Web Worker script, one Tesseract core (SIMD, LSTM-only: every Firefox
 * since 89 has WASM SIMD, and the LSTM-only build is the one the int
 * language models need) and the gzipped "best_int" language models.
 * background.js (in Chromium offscreen.js) bundles tesseract.js's own
 * (readable) source.
 */
async function copyOcr(outdir) {
  const nm = (p) => join(root, "node_modules", p);
  const ocr = join(outdir, "ocr");
  await mkdir(join(ocr, "lang"), { recursive: true });
  await copyFile(nm("tesseract.js/dist/worker.min.js"), join(ocr, "worker.min.js"));
  await copyFile(
    nm("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"),
    join(ocr, "tesseract-core-simd-lstm.wasm.js"),
  );
  for (const lang of ["deu", "eng"]) {
    await copyFile(
      nm(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`),
      join(ocr, "lang", `${lang}.traineddata.gz`),
    );
  }
  await copyFile(nm("tesseract.js/LICENSE.md"), join(outdir, "LICENSES/tesseract.js.txt"));
  await copyFile(nm("tesseract.js-core/LICENSE"), join(outdir, "LICENSES/tesseract.js-core.txt"));
  // The language models are Apache-2.0 (tesseract-ocr/tessdata_best); their
  // npm packages carry no license file, so the same Apache-2.0 text is used.
  await copyFile(nm("tesseract.js-core/LICENSE"), join(outdir, "LICENSES/tessdata.txt"));
  // The notices of what webpack bundled into worker.min.js (Buffer, ieee754,
  // regenerator-runtime, zlib.js).
  await copyFile(
    nm("tesseract.js/dist/worker.min.js.LICENSE.txt"),
    join(outdir, "LICENSES/worker.min.js.txt"),
  );
  // The full license texts of the rest of worker.min.js, from tesseract.js's
  // own dependencies as installed (pnpm keeps them next to it, npm at the
  // top level; either way beside the real path). The bundle was built from
  // idb-keyval 6.2.x and wasm-feature-detect 1.8.0, whose license files are
  // byte-identical to the installed 6.3.0 and 1.9.0 (compared).
  const deps = dirname(realpathSync(nm("tesseract.js")));
  for (const [pkg, file] of [
    ["bmp-js", "LICENSE"],
    ["idb-keyval", "LICENCE"],
    ["is-url", "LICENSE-MIT"],
    ["regenerator-runtime", "LICENSE"],
    ["wasm-feature-detect", "LICENSE"],
    ["zlibjs", "LICENSE"],
  ]) {
    await copyFile(join(deps, pkg, file), join(outdir, "LICENSES", `${pkg}.txt`));
  }
  // Texts with no installed package: what the WebAssembly core links in
  // (Tesseract, Leptonica, its image libraries, openlibm) and buffer,
  // base64-js and ieee754 (dev dependencies of tesseract.js, bundled into
  // the worker). Copied unmodified from upstream; sources in NOTICE.
  for (const f of await readdir(join(root, "licenses"))) {
    await copyFile(join(root, "licenses", f), join(outdir, "LICENSES", f));
  }
}
