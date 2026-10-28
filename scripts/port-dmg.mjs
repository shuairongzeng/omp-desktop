#!/usr/bin/env node
/* scripts/port-dmg.mjs — build `release/OMP Desktop.dmg` from the packaged app.

   The Tauri release pipeline ships a DMG next to the `.app.tar.gz`; the
   Electron port assembles its own with `hdiutil`, no external tooling and no
   network:

     1. copy `release/OMP Desktop.app` into a scratch folder with `ditto`
        (preserves the Electron Framework's symlinks, resource forks and
        executable bits; `cp -R` does not);
     2. add the usual `/Applications` symlink beside it so the image can be
        installed by dragging;
     3. `hdiutil create -format UDZO` (compressed, read-only) with volume name
        `OMP Desktop`;
     4. remove the scratch folder.

   Rebuilding is from scratch: an existing `release/OMP Desktop.dmg` is
   removed first, so a failed build never leaves a stale image that looks
   current. The source `.app` is produced by `npm run port:build`.

   Usage:
     node scripts/port-dmg.mjs
     node scripts/port-dmg.mjs --app <path> --out <path>   (tests / other dirs)

   Output: `release/OMP Desktop.dmg`. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "release");
const APP_NAME = "OMP Desktop";
const VOLUME_NAME = "OMP Desktop";

function fail(message) {
  console.error(`port-dmg: error: ${message}`);
  process.exit(1);
}

function log(...args) {
  console.log("port-dmg:", ...args);
}

function usage() {
  console.log(`usage: node scripts/port-dmg.mjs [--app <X.app>] [--out <file.dmg>] [--volume <name>]`);
}

function parseArgs(argv) {
  const options = {
    app: path.join(RELEASE_DIR, `${APP_NAME}.app`),
    out: path.join(RELEASE_DIR, `${APP_NAME}.dmg`),
    volume: VOLUME_NAME,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--app") options.app = path.resolve(take());
    else if (arg === "--out") options.out = path.resolve(take());
    else if (arg === "--volume") options.volume = take();
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

function run(command, args, what) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) fail(`${what}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${what} failed (${command} exited ${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

function main() {
  if (process.platform !== "darwin") fail("building a DMG needs macOS (hdiutil and ditto)");
  const options = parseArgs(process.argv);

  const app = options.app;
  if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) {
    fail(`no app bundle at ${app} — run \`npm run port:build\` first (or pass --app)`);
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  // Rebuild from scratch: never let a previous image stand in for this build.
  fs.rmSync(options.out, { force: true });

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dmg-"));
  try {
    const stagedApp = path.join(stage, `${APP_NAME}.app`);
    log(`staging ${path.basename(app)}`);
    run("/usr/bin/ditto", [app, stagedApp], "copying the app bundle");
    fs.symlinkSync("/Applications", path.join(stage, "Applications"));
    log('added the "/Applications" shortcut');

    log(`creating ${path.relative(ROOT, options.out)} (UDZO, volume ${JSON.stringify(options.volume)})`);
    run("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-volname", options.volume,
      "-srcfolder", stage,
      "-fs", "HFS+",
      "-format", "UDZO",
      "-ov",
      options.out,
    ], "hdiutil create");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  const stat = fs.statSync(options.out, { throwIfNoEntry: false });
  if (!stat || stat.size === 0) fail(`hdiutil did not produce ${options.out}`);
  const result = spawnSync("/usr/bin/hdiutil", ["imageinfo", options.out], { encoding: "utf8" });
  if (result.status !== 0) fail(`the image at ${options.out} is not readable: ${(result.stderr || "").trim()}`);
  log(`wrote ${options.out} (${humanSize(stat.size)})`);
}

main();