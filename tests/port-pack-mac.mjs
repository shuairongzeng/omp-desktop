#!/usr/bin/env node
/* tests/port-pack-mac.mjs — end-to-end check of the macOS release packaging.

   Covers the four pieces of the port's release path that a unit test cannot
   fake:

     1. `scripts/port-dmg.mjs` replaces a stale image and produces a DMG that
        macOS can attach: volume named "OMP Desktop", the app inside, and the
        `/Applications` drag target beside it;
     2. `scripts/port-feed.mjs` generates a 0600/0700 signing key, signs the
        `.dmg` and `.app.tar.gz`, and writes a feed whose shapes `check()`
        parses (preferring `darwin-aarch64-app`) and whose signatures
        `verifySignature()` accepts — and rejects for a foreign key;
     3. the public key printed by port-feed is the one the updater's embedded
        constant (here: the test key via `PORT_UPDATER_PUBKEY`) verifies;
     4. `resolveDefaults()` keeps the upstream Tauri feed/key unless a port
        key is embedded, and switches to the fork's feed when one is.

   Test keys only: the checked-in `electron/backend/updater-keys.js` stays
   empty, and nothing is published. A release build runs `port:build` with
   `PORT_UPDATER_PUBKEY=<base64 of minisign.pub>`, which regenerates that
   module; this test proves the same lookup path by spawning the updater with
   the variable set.

   Run: node tests/port-pack-mac.mjs */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import updater from "../electron/packaging/updater.js";
import generatedKeys from "../electron/backend/updater-keys.js";

const {
  check,
  verifySignature,
  resolveDefaults,
  generateMinisignKeypair,
  UPSTREAM_FEED,
  UPSTREAM_PUBLIC_KEY,
  FORK_FEED,
} = updater;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "release");
const APP = path.join(RELEASE_DIR, "OMP Desktop.app");
const DMG = path.join(RELEASE_DIR, "OMP Desktop.dmg");
const DMG_SCRIPT = path.join(ROOT, "scripts", "port-dmg.mjs");
const FEED_SCRIPT = path.join(ROOT, "scripts", "port-feed.mjs");
const UPDATER = path.join(ROOT, "electron", "packaging", "updater.js");
const VERSION = "9.9.9";

const scratchDirs = [];
function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 600_000, ...options });
}

function assertOk(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} exited ${result.status}\n${result.stderr || ""}${result.stdout || ""}`,
  );
}

function humanBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${n} bytes`;
}

// ── 1. syntax ───────────────────────────────────────────────────────────────

test("the packaging scripts and the updater parse", () => {
  const files = [
    DMG_SCRIPT,
    FEED_SCRIPT,
    UPDATER,
    path.join(ROOT, "electron", "backend", "updater-keys.js"),
    fileURLToPath(import.meta.url),
  ];
  for (const file of files) {
    const result = run(process.execPath, ["--check", file], { timeout: 30_000 });
    assertOk(result, `node --check ${path.relative(ROOT, file)}`);
  }
});

// ── 2. DMG ──────────────────────────────────────────────────────────────────

test("port-dmg builds a mountable image over a stale one", { timeout: 600_000 }, () => {
  assert.ok(
    fs.existsSync(path.join(APP, "Contents", "Info.plist")),
    "release/OMP Desktop.app is missing — run `npm run port:build` first",
  );

  // Prove "rebuild from scratch": a leftover image must not survive.
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(DMG, "stale image, not a disk image");

  const build = run(process.execPath, [DMG_SCRIPT]);
  assertOk(build, "scripts/port-dmg.mjs");

  const stat = fs.statSync(DMG);
  assert.ok(stat.size > 1024 * 1024, `DMG is only ${humanBytes(stat.size)}`);
  const head = Buffer.alloc(16);
  const fd = fs.openSync(DMG, "r");
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(!head.toString().includes("stale"), "stale image survived");

  const info = run("/usr/bin/hdiutil", ["imageinfo", DMG], { timeout: 60_000 });
  assertOk(info, "hdiutil imageinfo");

  const mount = scratch("omp-dmg-mount-");
  const attach = run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, DMG]);
  assertOk(attach, "hdiutil attach");
  try {
    assert.ok(fs.existsSync(path.join(mount, "OMP Desktop.app", "Contents", "Info.plist")),
      "the image has no OMP Desktop.app");
    const link = path.join(mount, "Applications");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the image has no /Applications symlink");
    assert.equal(fs.readlinkSync(link), "/Applications");

    const volume = run("/usr/sbin/diskutil", ["info", mount], { timeout: 60_000 });
    assertOk(volume, "diskutil info");
    assert.match(volume.stdout, /^\s*Volume Name:\s+OMP Desktop\s*$/m);
  } finally {
    const detach = run("/usr/bin/hdiutil", ["detach", mount, "-force"], { timeout: 120_000 });
    assert.equal(detach.status, 0, `hdiutil detach failed: ${detach.stderr || detach.stdout}`);
  }
});

// ── 3. feed + signatures ────────────────────────────────────────────────────

test("port-feed signs the artifacts and check() accepts the feed", { timeout: 600_000 }, async () => {
  const dir = scratch("omp-feed-");
  const keyDir = path.join(dir, "keys");
  const feedPath = path.join(dir, "latest.json");
  // Both artifacts live beside the feed so the `file://` URLs resolve; the DMG
  // is the byte-identical output of port-dmg, the archive is a tiny stand-in
  // for the 300 MB .app.tar.gz (this test covers signature plumbing).
  const dmgCopy = path.join(dir, "OMP Desktop.dmg");
  const archive = path.join(dir, "OMP Desktop.app.tar.gz");
  if (!fs.existsSync(DMG)) {
    // Independently runnable: `--test-name-pattern` may skip the build test.
    const build = run(process.execPath, [DMG_SCRIPT]);
    assertOk(build, "scripts/port-dmg.mjs (prerequisite)");
  }
  fs.copyFileSync(DMG, dmgCopy);
  fs.writeFileSync(archive, "pretend this is OMP Desktop.app.tar.gz\n");
  assert.ok(fs.statSync(dmgCopy).size > 0, "the DMG must exist before signing");

  const baseUrl = pathToFileURL(dir).href;
  const feedRun = run(process.execPath, [
    FEED_SCRIPT,
    "--version", `v${VERSION}`,
    "--dmg", dmgCopy,
    "--app-archive", archive,
    "--key-dir", keyDir,
    "--base-url", baseUrl,
    "--notes", "port packaging test",
    "--out", feedPath,
  ]);
  assertOk(feedRun, "scripts/port-feed.mjs");

  // ── key material ──
  const keyFile = path.join(keyDir, "minisign.key");
  const pubFile = path.join(keyDir, "minisign.pub");
  assert.equal(fs.statSync(keyDir).mode & 0o777, 0o700, "key directory must be 0700");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "secret key must be 0600");
  const publicKeyText = fs.readFileSync(pubFile, "utf8");
  assert.match(publicKeyText, /^untrusted comment: minisign public key: [0-9A-F]{16}\n[A-Za-z0-9+/=]+\n$/);
  const publicKeyBase64 = Buffer.from(publicKeyText, "utf8").toString("base64");
  assert.ok(feedRun.stdout.includes(publicKeyText.trim()), "port-feed did not print the public key text");
  assert.ok(feedRun.stdout.includes(publicKeyBase64), "port-feed did not print the base64 public key");

  // The public key is derivable from the secret key (both files agree).
  assert.equal(updater.publicKeyForSecret(fs.readFileSync(keyFile, "utf8")), publicKeyText);

  // ── feed shape ──
  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  assert.equal(feed.version, VERSION);
  assert.equal(feed.notes, "port packaging test");
  assert.match(feed.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(feed.platforms), ["darwin-aarch64-app", "darwin-aarch64"]);
  for (const [key, entry] of Object.entries(feed.platforms)) {
    assert.equal(typeof entry.signature, "string", `${key} has no signature`);
    assert.ok(entry.url.startsWith(`${baseUrl}/`), `${key} url is not under the base URL`);
    assert.ok(fs.existsSync(fileURLToPath(entry.url)), `${key} url does not resolve locally`);
  }
  assert.ok(feed.platforms["darwin-aarch64-app"].url.endsWith(encodeURIComponent("OMP Desktop.app.tar.gz")));
  assert.ok(feed.platforms["darwin-aarch64"].url.endsWith(encodeURIComponent("OMP Desktop.dmg")));

  // GitHub rewrites spaces to dots in uploaded asset names; the default feed
  // URLs must follow, or a published release 404s.
  const githubFeedPath = path.join(dir, "latest-github.json");
  const githubRun = run(process.execPath, [
    FEED_SCRIPT,
    "--version", VERSION,
    "--dmg", dmgCopy,
    "--app-archive", archive,
    "--key-dir", keyDir,
    "--base-url", `https://github.com/shuairongzeng/omp-desktop/releases/download/v${VERSION}`,
    "--out", githubFeedPath,
  ]);
  assertOk(githubRun, "scripts/port-feed.mjs (GitHub URLs)");
  const githubFeed = JSON.parse(fs.readFileSync(githubFeedPath, "utf8"));
  assert.ok(githubFeed.platforms["darwin-aarch64"].url.endsWith("/OMP.Desktop.dmg"));
  assert.ok(githubFeed.platforms["darwin-aarch64-app"].url.endsWith("/OMP.Desktop.app.tar.gz"));

  // ── check() with a local feed ──
  const mockFetch = async (url) => {
    assert.equal(url, feedPath);
    return { ok: true, status: 200, json: async () => feed };
  };
  const update = await check(feedPath, {
    currentVersion: "1.0.0",
    platform: "darwin-aarch64",
    fetchImpl: mockFetch,
    timeoutMs: 0,
  });
  assert.equal(update.available, true);
  assert.equal(update.version, VERSION);
  assert.equal(update.target, "darwin-aarch64-app", "check() must prefer the .app archive");
  assert.equal(update.url, feed.platforms["darwin-aarch64-app"].url);
  assert.equal(update.signature, feed.platforms["darwin-aarch64-app"].signature);

  // Feed URL override through options (the tests' other entry point).
  const viaOption = await check(undefined, {
    feedUrl: feedPath,
    currentVersion: VERSION,
    platform: "darwin-aarch64",
    fetchImpl: mockFetch,
    timeoutMs: 0,
  });
  assert.equal(viaOption.available, false, "an equal version is not an update");

  // ── signatures ──
  const archiveBytes = fs.readFileSync(archive);
  const archiveVerified = verifySignature(
    archiveBytes,
    feed.platforms["darwin-aarch64-app"].signature,
    publicKeyBase64,
    { version: VERSION },
  );
  assert.equal(archiveVerified.version, VERSION);
  assert.match(archiveVerified.trustedComment, /file:OMP Desktop\.app\.tar\.gz/);

  const dmgVerified = verifySignature(
    fs.readFileSync(dmgCopy),
    feed.platforms["darwin-aarch64"].signature,
    publicKeyBase64,
    { version: VERSION },
  );
  assert.equal(dmgVerified.version, VERSION);

  // A foreign key (different key id) is refused outright.
  const foreign = generateMinisignKeypair();
  assert.throws(
    () => verifySignature(archiveBytes, feed.platforms["darwin-aarch64-app"].signature, foreign.publicKeyText),
    { code: "ERRFORMAT" },
  );
  // Same key id, different key material: the Ed25519 check is what fails.
  const keyId = Buffer.from(publicKeyText.split("\n")[1], "base64").subarray(2, 10);
  const forgedBlob = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, foreign.rawKey]);
  const forgedKey = `untrusted comment: minisign public key: ${keyId.toString("hex").toUpperCase()}\n${forgedBlob.toString("base64")}\n`;
  assert.throws(
    () => verifySignature(archiveBytes, feed.platforms["darwin-aarch64-app"].signature, forgedKey),
    { code: "ERRSIGNATURE" },
  );
  // Tampering with the artifact breaks the hash.
  const tampered = Buffer.from(archiveBytes);
  tampered[0] ^= 0xff;
  assert.throws(
    () => verifySignature(tampered, feed.platforms["darwin-aarch64-app"].signature, publicKeyBase64),
    { code: "ERRSIGNATURE" },
  );
});

test("port-feed builds a missing .app.tar.gz from the bundle", () => {
  const dir = scratch("omp-archive-");
  const app = path.join(dir, "OMP Desktop.app");
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>");
  fs.writeFileSync(path.join(dir, "OMP Desktop.dmg"), "small pretend image");
  const feedPath = path.join(dir, "latest.json");
  const keyDir = path.join(dir, "keys");

  const feedRun = run(process.execPath, [
    FEED_SCRIPT,
    "--version", "8.0.0",
    "--dir", dir,
    "--key-dir", keyDir,
    "--base-url", pathToFileURL(dir).href,
    "--out", feedPath,
  ]);
  assertOk(feedRun, "scripts/port-feed.mjs (archive build)");

  const archive = path.join(dir, "OMP Desktop.app.tar.gz");
  assert.ok(fs.existsSync(archive), "port-feed did not build the archive");
  const list = run("/usr/bin/tar", ["-tzf", archive], { timeout: 30_000 });
  assertOk(list, "tar -tzf");
  assert.match(list.stdout, /OMP Desktop\.app\/Contents\/Info\.plist/);

  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  assert.deepEqual(Object.keys(feed.platforms), ["darwin-aarch64-app", "darwin-aarch64"]);
  const publicKeyText = fs.readFileSync(path.join(keyDir, "minisign.pub"), "utf8");
  assert.equal(
    verifySignature(fs.readFileSync(archive), feed.platforms["darwin-aarch64-app"].signature, publicKeyText, { version: "8.0.0" }).version,
    "8.0.0",
  );
});

// ── 4. default feed/key selection ──────────────────────────────────────────

test("resolveDefaults keeps upstream without a port key", () => {
  assert.equal(generatedKeys.publicKey, "", "the checked-in key module must stay empty");

  const upstream = resolveDefaults({ keys: null, env: {} });
  assert.equal(upstream.feed, UPSTREAM_FEED);
  assert.equal(upstream.publicKey, UPSTREAM_PUBLIC_KEY);
  assert.equal(upstream.custom, false);

  // The checked-in module itself resolves upstream.
  assert.equal(resolveDefaults({ keys: generatedKeys, env: {} }).feed, UPSTREAM_FEED);

  // An empty environment variable is not a key.
  assert.equal(resolveDefaults({ keys: null, env: { PORT_UPDATER_PUBKEY: "  " } }).feed, UPSTREAM_FEED);
});

test("PORT_UPDATER_PUBKEY switches the embedded key and the feed", () => {
  const keypair = generateMinisignKeypair();
  const publicKeyBase64 = Buffer.from(keypair.publicKeyText, "utf8").toString("base64");

  // Environment form (what port:build consumes).
  const custom = resolveDefaults({ keys: null, env: { PORT_UPDATER_PUBKEY: publicKeyBase64 } });
  assert.equal(custom.feed, FORK_FEED);
  assert.equal(custom.publicKey, publicKeyBase64);
  assert.equal(custom.custom, true);

  // Generated-module form (what a packaged app actually loads), authoritative
  // even when the environment is clean.
  const viaModule = resolveDefaults({ keys: { publicKey: publicKeyBase64 }, env: {} });
  assert.equal(viaModule.feed, FORK_FEED);
  assert.equal(viaModule.publicKey, publicKeyBase64);

  // An explicit feed in the module wins over the derived one.
  assert.equal(
    resolveDefaults({ keys: { publicKey: publicKeyBase64, feed: "https://example.test/latest.json" }, env: {} }).feed,
    "https://example.test/latest.json",
  );
});

test("the embedded key verifies generator signatures across processes", { timeout: 120_000 }, () => {
  const dir = scratch("omp-probe-");
  const artifact = path.join(dir, "artifact.bin");
  fs.writeFileSync(artifact, "bytes the generator signed");
  const keypair = generateMinisignKeypair();
  const signature = updater.signMinisign(fs.readFileSync(artifact), keypair.secretKeyText, { version: VERSION });
  const sigPath = path.join(dir, "artifact.sig");
  fs.writeFileSync(sigPath, signature.feed);

  const probe = path.join(dir, "probe.cjs");
  fs.writeFileSync(probe, `"use strict";
const fs = require("node:fs");
const [updaterPath, artifactPath, signaturePath, version] = process.argv.slice(2);
const u = require(updaterPath);
let verified;
try {
  verified = u.verifySignature(fs.readFileSync(artifactPath), fs.readFileSync(signaturePath, "utf8"), u.DEFAULT_PUBLIC_KEY, { version }).version;
} catch (error) {
  verified = "ERROR:" + (error.code || error.message);
}
process.stdout.write(JSON.stringify({ feed: u.DEFAULT_FEED, publicKey: u.DEFAULT_PUBLIC_KEY, custom: u.resolveDefaults().custom, verified }));
`);

  const runProbe = (env) => {
    const result = run(process.execPath, [probe, UPDATER, artifact, sigPath, VERSION], { env });
    assertOk(result, "updater probe");
    return JSON.parse(result.stdout);
  };

  // Absent: the checked-in module carries no key, so the upstream identity
  // stands and cannot verify a test-key signature.
  const absentEnv = { ...process.env };
  delete absentEnv.PORT_UPDATER_PUBKEY;
  const absent = runProbe(absentEnv);
  assert.equal(absent.feed, UPSTREAM_FEED);
  assert.equal(absent.publicKey, UPSTREAM_PUBLIC_KEY);
  assert.equal(absent.custom, false);
  assert.match(absent.verified, /^ERROR:/, "upstream key must not verify a port signature");

  // Present: this is the "embedded constant verifies the generator" check.
  const publicKeyBase64 = Buffer.from(keypair.publicKeyText, "utf8").toString("base64");
  const present = runProbe({ ...absentEnv, PORT_UPDATER_PUBKEY: publicKeyBase64 });
  assert.equal(present.feed, FORK_FEED);
  assert.equal(present.publicKey, publicKeyBase64);
  assert.equal(present.custom, true);
  assert.equal(present.verified, VERSION);
});