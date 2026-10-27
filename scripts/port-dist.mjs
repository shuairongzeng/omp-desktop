#!/usr/bin/env node
/* scripts/port-dist.mjs — inject the port shim into dist/index.html.

   The renderer-main-world half of the `window.__TAURI__` shim
   (electron/port-shim.js) must load BEFORE the app bundle, because live.js
   (bundled into app-bundle.js by build-frontend.mjs) reads
   `window.__TAURI__` at its top-level init. The Tauri build's index.html
   never carries it; this script copies electron/port-shim.js into dist/
   and inserts its <script> tag right before the app-bundle tag,
   idempotently.

   Run after scripts/build-frontend.mjs:  node scripts/port-dist.mjs */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "dist", "index.html");
const shimSrc = join(root, "electron", "port-shim.js");
const shimDst = join(root, "dist", "port-shim.js");

if (!existsSync(htmlPath)) {
  console.error("port-dist: dist/index.html missing — run build-frontend first");
  process.exit(1);
}

copyFileSync(shimSrc, shimDst);

let html = readFileSync(htmlPath, "utf8");
const TAG = '<script src="port-shim.js"></script>';
if (!html.includes(TAG)) {
  const anchor = '<script defer src="app-bundle.js';
  const at = html.indexOf(anchor);
  if (at === -1) {
    console.error("port-dist: app-bundle script tag not found in dist/index.html");
    process.exit(1);
  }
  html = html.slice(0, at) + TAG + "\n  " + html.slice(at);
  writeFileSync(htmlPath, html);
}
console.log("port-dist: shim injected before app-bundle");
