#!/usr/bin/env node
// Regenerates src/noble-e2e.js, the pure-JS crypto bundle for the R8 E2E
// phone shim (docs/architecture/remote-e2e-contract.md). The phone is a
// plain browser served by the relay, often over a self-signed cert — not a
// secure context, so window.crypto.subtle is unavailable; the noble
// libraries are dependency-free pure JS and need no secure context.
//
// Locked versions (bump all three together; they release in lockstep):
//
//   @noble/curves   2.4.0
//   @noble/ciphers  2.4.0
//   @noble/hashes   2.4.0
//
// The script npm-installs those exact versions into a temp dir, then
// esbuild-bundles (npx esbuild, IIFE) one entry that imports exactly the
// primitives the E2E contract needs and exposes them as one global:
//
//   window.NOBLE_E2E = { x25519, hkdf, sha256, hmac, gcm }
//
// (x25519: keygen/getSharedSecret/getPublicKey; gcm(key, nonce, aad) from
// @noble/ciphers returns a cipher object with encrypt/decrypt; nonce is
// 12 bytes per the contract.)
//
// The output carries a `/*!` version banner (any later minifier keeps it).
// Never hand-edit the output; re-run this script with new versions instead.
// CSP check: the minified bundle must not contain eval or new Function
// (the relay serves it under script-src 'self' with no 'unsafe-eval') —
// the script fails the build if either appears.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const VERSIONS = {
  "@noble/curves": "2.4.0",
  "@noble/ciphers": "2.4.0",
  "@noble/hashes": "2.4.0",
};

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const outFile = join(outDir, "noble-e2e.js");
const work = mkdtempSync(join(tmpdir(), "vendor-noble-"));

try {
  // Without a manifest of its own, npm walks up from `work` to the first
  // ancestor holding a package.json/node_modules and installs *there*.
  writeFileSync(join(work, "package.json"), '{ "private": true }\n');
  const install = spawnSync(
    "npm",
    [
      "install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts",
      ...Object.entries(VERSIONS).map(([name, v]) => `${name}@${v}`),
    ],
    // npm is a .cmd shim on Windows, which only a shell can run.
    { cwd: work, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (install.status !== 0) throw new Error("npm install failed");

  const pkgVersion = (name) =>
    JSON.parse(readFileSync(join(work, "node_modules", name, "package.json"), "utf8")).version;
  for (const [name, want] of Object.entries(VERSIONS)) {
    if (pkgVersion(name) !== want) {
      throw new Error(`${name}: resolved ${pkgVersion(name)}, expected ${want}`);
    }
  }

  // The entry imports exactly the primitives the contract uses; esbuild
  // tree-shakes everything else out of the IIFE bundle.
  const entry = join(work, "noble-entry.mjs");
  writeFileSync(
    entry,
    [
      'import { x25519 } from "@noble/curves/ed25519.js";',
      'import { hkdf } from "@noble/hashes/hkdf.js";',
      'import { sha256 } from "@noble/hashes/sha2.js";',
      'import { hmac } from "@noble/hashes/hmac.js";',
      'import { gcm } from "@noble/ciphers/aes.js";',
      "",
      "// One global (src/app/remote-crypto.js is the only consumer).",
      "window.NOBLE_E2E = { x25519, hkdf, sha256, hmac, gcm };",
      "",
    ].join("\n"),
  );

  const bundle = join(work, "noble-e2e.js");
  const built = spawnSync(
    "npx",
    [
      "esbuild", entry,
      "--bundle", "--format=iife", "--target=es2020", "--minify",
      "--outfile=" + bundle,
      "--log-level=warning",
    ],
    // npx resolves the locally installed esbuild (a .cmd shim on Windows).
    { cwd: work, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (built.status !== 0) throw new Error("esbuild failed");
  let code = readFileSync(bundle, "utf8");

  // The strict CSPs (release Tauri, the relay) allow no 'unsafe-eval'.
  // Scan for the eval family so a dependency regression fails the vendoring
  // instead of shipping a bundle the page cannot run.
  for (const bad of [/\beval\s*\(/, /new\s+Function\b/, /Function\s*\(\s*["'`]/]) {
    if (bad.test(code)) throw new Error("bundle contains eval/new Function (CSP violation)");
  }

  // `/*!` so any later minifier keeps it. All three packages share the
  // same MIT license text.
  const license = readFileSync(join(work, "node_modules", "@noble", "curves", "LICENSE"), "utf8").trim();
  const banner = [
    `/*! noble-e2e.js ${Object.values(VERSIONS).join("/")}, bundled from the official npm`,
    "packages (@noble/curves, @noble/ciphers, @noble/hashes; MIT) by",
    "scripts/vendor-noble.mjs with esbuild. Do not edit; regenerate instead.",
    "",
    ...license.split("\n"),
  ]
    .map((line, i) => (i === 0 ? line : line ? ` * ${line}` : " *"))
    .join("\n") + "\n */\n";

  writeFileSync(outFile, banner + code);
  const bytes = statSync(outFile).size;
  console.log(`src/noble-e2e.js ← noble entry (${bytes} bytes, versions ${Object.entries(VERSIONS).map(([n, v]) => `${n}@${v}`).join(", ")})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
