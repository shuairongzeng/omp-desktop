#!/usr/bin/env node
/* electron/packaging/build-app.mjs — assemble `release/OMP Desktop.app`.

   The Tauri build produces one ~16 MB `.app`; this is the Electron equivalent
   for the M5 target (darwin arm64), assembled by hand with no
   electron-builder / electron-packager dependency and no network:

     1. copy `node_modules/electron/dist/Electron.app` verbatim (frameworks,
        helper apps, locales, icns, plist — the standard manual layout);
     2. rename `Contents/MacOS/Electron` to `Contents/MacOS/OMP Desktop` and
        point `CFBundleExecutable` at it;
     3. write the payload to `Contents/Resources/app/` — the directory Electron
        loads as the app when there is no `app.asar`:
          package.json        main: electron/main.js (+ prod deps)
          electron/           main.js, preload.js, backend/**, updater.js
          dist/               the compiled frontend (same build as the Tauri app)
          node_modules/       runtime dependencies only (ws, node-pty, …)
     4. delete `Contents/Resources/default_app.asar` (Electron's own fallback
        app would otherwise shadow nothing but waste 2 MB and confuse
        inspection);
     5. set the bundle identity in Info.plist (CFBundleName/DisplayName/
        Identifier/Executable/IconFile, versions, LSMinimumSystemVersion) and
        install `src-tauri/icons/icon.icns` for icon parity with Tauri;
     6. ad-hoc codesign the whole bundle (`codesign --force --deep -s -`), the
        local-install equivalent of Tauri's `signingIdentity: "-"`.

   App layout produced:

     release/OMP Desktop.app/
       Contents/
         Info.plist
         MacOS/OMP Desktop                 renamed Electron binary
         Frameworks/                       Electron Framework + * Helper apps
         Resources/
           app/{package.json,electron/,dist/,node_modules/}
           icon.icns
           *.lproj, v8_context_snapshot.bin, …  (copied from Electron.app)

   No asar archive: the payload stays inspectable and the frontend's
   `loadFile(__dirname/../dist/index.html)` path is unchanged between `npx
   electron .` and the bundled app. `release/` is a build artifact.

   Offline: the only prerequisites are an installed `node_modules/electron`
   and a built `dist/` (built here via `scripts/build-frontend.mjs` if absent).

   Usage: node electron/packaging/build-app.mjs */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_DIR = path.join(ROOT, "release");
const BUNDLE = path.join(RELEASE_DIR, "OMP Desktop.app");
const CONTENTS = path.join(BUNDLE, "Contents");
const PAYLOAD = path.join(CONTENTS, "Resources", "app");
const ELECTRON_APP = path.join(ROOT, "node_modules", "electron", "dist", "Electron.app");
// The port's own mark (electron/packaging/icon.svg, rasterized to icns):
// the Tauri checkout's upstream icon is not this product's brand.
const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), "icon.icns");
const APP_NAME = "OMP Desktop";
const BUNDLE_ID = "dev.ohMyPi.desktop.electron";
/** Electron 45 ships `LSMinimumSystemVersion` 13.0; keep it explicit. */
const MIN_MACOS = "13.0";
/** Never shipped into `Resources/app/node_modules`: build tooling / vendor CLIs. */
const SKIP_DEPENDENCIES = new Set(["electron", "@tauri-apps/cli"]);

const log = (...args) => console.log("[package]", ...args);

function fail(message) {
  console.error(`[package] error: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = rootPackage.version || "0.0.0";

// ── prerequisites ───────────────────────────────────────────────────────────

if (!fs.existsSync(path.join(ELECTRON_APP, "Contents", "MacOS", "Electron"))) {
  fail(`Electron.app not found at ${ELECTRON_APP}; run npm install (--cache /tmp/m5-npm-cache)`);
}
if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  log("dist/ is missing — building the frontend with scripts/build-frontend.mjs");
  run(process.execPath, [path.join(ROOT, "scripts", "build-frontend.mjs")]);
}

// ── prod dependency closure ─────────────────────────────────────────────────

function readPackageJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

/** Node's lookup algorithm, used here to find where a dependency really lives. */
function resolveModuleDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every runtime package reachable from package.json `dependencies`, keyed by
 * its directory under the root `node_modules` (nested installs keep their
 * nested path, so the copied tree resolves exactly like the source tree).
 */
function runtimeDependencies() {
  const rootNodeModules = path.join(ROOT, "node_modules");
  const found = new Map(); // source dir -> path relative to node_modules
  const queue = Object.keys(rootPackage.dependencies || {})
    .filter((name) => !SKIP_DEPENDENCIES.has(name))
    .map((name) => ({ name, from: ROOT }));
  const missing = new Set();
  while (queue.length) {
    const { name, from } = queue.shift();
    if (SKIP_DEPENDENCIES.has(name)) continue;
    const dir = resolveModuleDir(name, from);
    if (!dir) {
      missing.add(name);
      continue;
    }
    if (found.has(dir)) continue;
    const relative = path.relative(rootNodeModules, dir);
    found.set(dir, relative.startsWith("..") ? path.join("node_modules", name) : path.join("node_modules", relative));
    const pkg = readPackageJson(dir);
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, from: dir });
    for (const dep of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: dep, from: dir });
  }
  if (missing.size) log(`warning: not installed, skipped: ${[...missing].join(", ")}`);
  return found;
}

// ── assemble ────────────────────────────────────────────────────────────────

log(`assembling ${path.relative(ROOT, BUNDLE)} (Electron ${fs.readFileSync(path.join(ROOT, "node_modules", "electron", "dist", "version"), "utf8").trim()})`);
fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// 1. The Electron app, kept whole: frameworks, helpers, locales, icns, plist.
fs.cpSync(ELECTRON_APP, BUNDLE, { recursive: true, verbatimSymlinks: true });

// 2. Swap the executable name. Info.plist is fixed further down.
const electronBinary = path.join(CONTENTS, "MacOS", "Electron");
const appBinary = path.join(CONTENTS, "MacOS", APP_NAME);
if (!fs.existsSync(electronBinary)) fail(`missing ${electronBinary}`);
fs.renameSync(electronBinary, appBinary);

// 3. Payload under Resources/app (no asar).
fs.mkdirSync(PAYLOAD, { recursive: true });
const copySkipBuildScript = (source) => path.basename(source) !== "build-app.mjs";
fs.cpSync(path.join(ROOT, "electron"), path.join(PAYLOAD, "electron"), {
  recursive: true,
  verbatimSymlinks: true,
  filter: copySkipBuildScript,
});
fs.cpSync(path.join(ROOT, "dist"), path.join(PAYLOAD, "dist"), {
  recursive: true,
  verbatimSymlinks: true,
});

const dependencies = runtimeDependencies();
for (const [source, destination] of dependencies) {
  const target = path.join(PAYLOAD, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Nested node_modules trees are copied as their own entries; skipping them
  // here keeps each package's copy to just that package.
  fs.cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (file) => {
      const parts = path.relative(source, file).split(path.sep);
      return !parts.includes("node_modules");
    },
  });
}
log(`payload: electron/ + dist/ + ${dependencies.size} runtime packages`);

fs.writeFileSync(
  path.join(PAYLOAD, "package.json"),
  JSON.stringify(
    {
      name: rootPackage.name,
      productName: APP_NAME,
      version: VERSION,
      private: true,
      main: "electron/main.js",
      description: rootPackage.description,
      dependencies: Object.fromEntries(
        Object.entries(rootPackage.dependencies || {}).filter(([name]) => !SKIP_DEPENDENCIES.has(name)),
      ),
    },
    null,
    2,
  ) + "\n",
);

// 4. Drop Electron's own fallback app.
fs.rmSync(path.join(CONTENTS, "Resources", "default_app.asar"), { force: true });

// 5. Bundle identity.
const plist = path.join(CONTENTS, "Info.plist");
function setPlist(key, value) {
  const replace = spawnSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  if (replace.status === 0) return;
  run("/usr/bin/plutil", ["-insert", key, "-string", value, plist]);
}
setPlist("CFBundleName", APP_NAME);
setPlist("CFBundleDisplayName", APP_NAME);
setPlist("CFBundleIdentifier", BUNDLE_ID);
setPlist("CFBundleExecutable", APP_NAME);
setPlist("CFBundleShortVersionString", VERSION);
setPlist("CFBundleVersion", VERSION);
setPlist("LSMinimumSystemVersion", MIN_MACOS);
if (fs.existsSync(ICON)) {
  fs.copyFileSync(ICON, path.join(CONTENTS, "Resources", "icon.icns"));
  setPlist("CFBundleIconFile", "icon.icns");
} else {
  log(`warning: ${path.relative(ROOT, ICON)} missing; keeping Electron's icon`);
}

// 6. Ad-hoc signature (`signingIdentity: "-"` in Tauri terms). `--deep` covers
//    the nested frameworks and helper apps; the binary is renamed, so the
//    original Electron signature is invalid by construction.
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", BUNDLE]);

const info = spawnSync("/usr/bin/codesign", ["-dv", BUNDLE], { encoding: "utf8" });
const signatureText = `${info.stdout || ""}${info.stderr || ""}`;
if (!/Signature=adhoc/.test(signatureText)) fail(`ad-hoc signature missing:\n${signatureText}`);

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
    // Symlinks (framework `Current` / `Versions/Current` links) add no bytes.
  }
  return total;
}

const megabytes = directorySize(BUNDLE) / (1024 * 1024);
const payloadMegabytes = directorySize(PAYLOAD) / (1024 * 1024);
log(`built ${path.relative(ROOT, BUNDLE)} — ${megabytes.toFixed(1)} MB (payload ${payloadMegabytes.toFixed(1)} MB), ad-hoc signed`);
console.log(`\n  open "${BUNDLE}"`);