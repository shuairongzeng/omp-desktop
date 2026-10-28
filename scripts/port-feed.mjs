#!/usr/bin/env node
/* scripts/port-feed.mjs — sign the release artifacts and write `latest.json`.

   The Tauri release workflow signs each updatable artifact with
   `tauri signer sign` (Minisign) and `.github/scripts/updater-json.mjs` maps
   the `*.sig` files onto the feed's platform keys. This is the Electron port's
   equivalent, offline:

     - the `.app.tar.gz` (which `install()` can actually unpack) goes under
       `darwin-aarch64-app`, the key `check()` looks up first;
     - the `.dmg` goes under `darwin-aarch64`, the plugin's fallback key and
       the artifact a human downloads from the release page.

   Signatures are the reference form: base64 of the whole 4-line Minisign
   `.sig` text, exactly what `verifySignature()` in
   `electron/packaging/updater.js` decodes (the signing half lives there too,
   so producer and verifier share one framing implementation).

   Signing key: `--key <path>` uses an existing secret key. Without it the key
   at `~/.omp-port/release-signing/minisign.key` is used, and generated on the
   first run (directory 0700, private file 0600, public file beside it). The
   public key is printed in both forms; the base64 form is what a release
   build embeds:

     PORT_UPDATER_PUBKEY=<base64> npm run port:build

   (`port:build` writes it into `electron/backend/updater-keys.js`, which
   switches the app to the fork's own feed. See `resolveDefaults()`.)

   Usage:
     node scripts/port-feed.mjs --version 0.4.0 [--notes-file CHANGELOG.md]
     node scripts/port-feed.mjs --version 0.4.0 --key /secure/minisign.key \
       --dmg release/"OMP Desktop.dmg" --app-archive release/"OMP Desktop.app.tar.gz"

   Nothing here publishes anything: the feed is a local file meant to be
   uploaded with the assets. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import updater from "../electron/packaging/updater.js";

const { generateMinisignKeypair, publicKeyForSecret, signMinisign } = updater;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "release");
const APP_NAME = "OMP Desktop";
const DEFAULT_KEY_DIR = path.join(os.homedir(), ".omp-port", "release-signing");
const FEED_REPO = "shuairongzeng/omp-desktop";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`port-feed: error: ${message}`);
  process.exit(1);
}

function log(...args) {
  console.log("port-feed:", ...args);
}

function usage() {
  console.log(`usage: node scripts/port-feed.mjs --version <x.y.z> [options]

  --version <x.y.z>     version the artifacts were built for (required)
  --key <path>          existing secret key (default: ~/.omp-port/release-signing/minisign.key)
  --key-dir <dir>       where a missing key pair is generated
  --dir <dir>           release directory (default: <repo>/release)
  --dmg <path>          disk image to sign
  --app-archive <path>  .app.tar.gz to sign (built from the .app when missing)
  --no-app-archive      skip the archive; the feed then points at the .dmg only
  --app <path>          .app used to build a missing archive
  --base-url <url>      download base for asset URLs
                        (default: https://github.com/${FEED_REPO}/releases/download/v<version>)
  --dmg-url <url>       exact URL for the .dmg entry (overrides --base-url)
  --archive-url <url>   exact URL for the .app.tar.gz entry (overrides --base-url)
  --notes <text>        release notes for the feed
  --notes-file <path>   read the notes from a file
  --out <path>          feed path (default: <dir>/latest.json)`);
}

function parseArgs(argv) {
  const options = {
    version: "",
    key: null,
    keyDir: DEFAULT_KEY_DIR,
    dir: RELEASE_DIR,
    dmg: null,
    appArchive: null,
    appArchiveMode: "auto",
    app: null,
    baseUrl: null,
    dmgUrl: null,
    archiveUrl: null,
    notes: "",
    notesFile: null,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--version") options.version = take();
    else if (arg === "--key") options.key = path.resolve(take());
    else if (arg === "--key-dir") options.keyDir = path.resolve(take());
    else if (arg === "--dir") options.dir = path.resolve(take());
    else if (arg === "--dmg") options.dmg = path.resolve(take());
    else if (arg === "--app-archive") {
      options.appArchive = path.resolve(take());
      options.appArchiveMode = "explicit";
    } else if (arg === "--no-app-archive") options.appArchiveMode = "skip";
    else if (arg === "--app") options.app = path.resolve(take());
    else if (arg === "--base-url") options.baseUrl = take();
    else if (arg === "--dmg-url") options.dmgUrl = take();
    else if (arg === "--archive-url") options.archiveUrl = take();
    else if (arg === "--notes") options.notes = take();
    else if (arg === "--notes-file") options.notesFile = path.resolve(take());
    else if (arg === "--out") options.out = path.resolve(take());
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

function normalizeVersion(text) {
  const version = String(text || "").trim().replace(/^v/, "");
  if (!SEMVER.test(version)) fail(`not a semantic version: ${JSON.stringify(text)}`);
  return version;
}

/** The secret-key file, generating the pair on first use. */
function loadKey(options) {
  let secretPath = options.key;
  let secretKeyText;
  let generated = false;

  if (!secretPath) {
    fs.mkdirSync(options.keyDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(options.keyDir, 0o700);
    secretPath = path.join(options.keyDir, "minisign.key");
    if (fs.existsSync(secretPath)) {
      secretKeyText = fs.readFileSync(secretPath, "utf8");
    } else {
      const pair = generateMinisignKeypair();
      fs.writeFileSync(secretPath, pair.secretKeyText, { mode: 0o600 });
      generated = true;
      secretKeyText = pair.secretKeyText;
    }
    // A key that predates this check (or was copied in) must not be group- or
    // world-readable; this also makes a re-run idempotent.
    fs.chmodSync(secretPath, 0o600);
    fs.writeFileSync(path.join(options.keyDir, "minisign.pub"), publicKeyForSecret(secretKeyText), {
      mode: 0o644,
    });
  } else {
    if (!fs.existsSync(secretPath)) fail(`no secret key at ${secretPath}`);
    secretKeyText = fs.readFileSync(secretPath, "utf8");
  }

  const publicKeyText = publicKeyForSecret(secretKeyText);
  return { secretPath, secretKeyText, publicKeyText, generated };
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

/**
 * GitHub rewrites spaces in uploaded asset names to dots ("OMP Desktop.dmg" →
 * "OMP.Desktop.dmg"), so a feed whose URLs kept `%20` would 404. Any other
 * base (a `file://` directory for local dry runs, another host) keeps the real
 * file name. Both can be bypassed with `--dmg-url` / `--archive-url`.
 */
function assetUrl(baseUrl, file, override) {
  if (override) return override;
  const base = baseUrl.replace(/\/+$/, "");
  const github = /^https:\/\/github\.com\//i.test(base);
  const name = github ? path.basename(file).replace(/ /g, ".") : path.basename(file);
  return `${base}/${encodeURIComponent(name)}`;
}

function signedEntry(file, secretKeyText, version, url) {
  const bytes = fs.readFileSync(file);
  const signature = signMinisign(bytes, secretKeyText, {
    file: path.basename(file),
    version,
  });
  log(`signed ${path.basename(file)} (${humanSize(bytes.length)})`);
  return { signature: signature.feed, url };
}

/** Build `X.app.tar.gz` from the bundle when the release has none yet. */
function ensureAppArchive(options) {
  if (options.appArchiveMode === "skip") return null;
  const archive = options.appArchive || path.join(options.dir, `${APP_NAME}.app.tar.gz`);
  if (fs.existsSync(archive)) return archive;

  if (options.appArchiveMode === "explicit") fail(`no app archive at ${archive}`);

  const app = options.app || path.join(options.dir, `${APP_NAME}.app`);
  if (!fs.existsSync(path.join(app, "Contents", "Info.plist"))) {
    fail(`no app bundle at ${app} to build ${path.basename(archive)} from`);
  }
  log(`building ${path.basename(archive)} from ${path.basename(app)}`);
  const tar = spawnSync(
    "/usr/bin/tar",
    ["-czf", archive, "-C", path.dirname(app), path.basename(app)],
    { encoding: "utf8" },
  );
  if (tar.error) fail(`tar: ${tar.error.message}`);
  if (tar.status !== 0) fail(`tar exited ${tar.status}: ${(tar.stderr || "").trim()}`);
  return archive;
}

function main() {
  const options = parseArgs(process.argv);
  if (!options.version) {
    usage();
    fail("--version is required");
  }
  const version = normalizeVersion(options.version);
  const baseUrl = options.baseUrl
    || `https://github.com/${FEED_REPO}/releases/download/v${version}`;
  const dmg = options.dmg || path.join(options.dir, `${APP_NAME}.dmg`);
  const out = options.out || path.join(options.dir, "latest.json");
  const notes = options.notesFile
    ? fs.readFileSync(options.notesFile, "utf8")
    : options.notes;

  if (!fs.existsSync(dmg)) fail(`no disk image at ${dmg} — run \`node scripts/port-dmg.mjs\` first`);
  if (!fs.statSync(dmg).size) fail(`${dmg} is empty`);

  const key = loadKey(options);
  log(
    `${key.generated ? "generated" : "using"} signing key ${key.secretPath}` +
      (key.generated ? " (keep it backed up; rotating it strands installed copies)" : ""),
  );

  const archive = ensureAppArchive(options);
  if (!archive) {
    log("warning: no .app.tar.gz in the feed — `install()` cannot apply a .dmg; pass one or drop --no-app-archive");
  }

  const platforms = {};
  // `check()` tries `{os}-{arch}-app` first; that archive is the only
  // artifact `install()` can unpack, so it must be the preferred entry.
  if (archive) {
    platforms["darwin-aarch64-app"] = signedEntry(
      archive,
      key.secretKeyText,
      version,
      assetUrl(baseUrl, archive, options.archiveUrl),
    );
  }
  platforms["darwin-aarch64"] = signedEntry(
    dmg,
    key.secretKeyText,
    version,
    assetUrl(baseUrl, dmg, options.dmgUrl),
  );

  const feed = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);

  const publicKeyBase64 = Buffer.from(key.publicKeyText, "utf8").toString("base64");
  console.log("");
  console.log("public key:");
  process.stdout.write(key.publicKeyText);
  console.log("");
  console.log("public key (base64, for PORT_UPDATER_PUBKEY):");
  console.log(publicKeyBase64);
  console.log("");
  log(`wrote ${out} (version ${version}, ${Object.keys(platforms).join(", ")})`);
  log("embed it in the app with: PORT_UPDATER_PUBKEY=<base64 above> npm run port:build");
}

main();