/* electron/packaging/updater.js — the port's in-app update check and install.

   Mirrors the Tauri updater (`src-tauri/src/updater.rs` +
   `tauri-plugin-updater` 2.13.1) for the macOS arm64 port. Wired nowhere yet:
   `main.js` does not require this module; M5's caller is a later change.

   ── The feed ────────────────────────────────────────────────────────────────
   `latest.json` on the newest published, non-prerelease GitHub release:

     { "version": "0.11.0",
       "notes":   "…markdown…",
       "pub_date": "2026-10-27T…Z",
       "platforms": {
         "darwin-aarch64":     { "signature": "<base64>", "url": "https://…" },
         "darwin-aarch64-app": { "signature": "<base64>", "url": "https://…" },
         … } }

   The plugin looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`
   (`Updater::get_urls`). A macOS `.app` bundle is installer `app`, so this
   module tries `darwin-aarch64-app` before `darwin-aarch64`.

   ── The signature scheme (verified, not assumed) ────────────────────────────
   Tauri does *not* use its own format: the release workflow runs
   `tauri signer sign`, which emits a Minisign signature, and
   `.github/scripts/updater-json.mjs` only copies each `*.sig` asset into the
   feed. Tauri v2's `*.sig` assets are base64 of the whole Minisign signature
   *file text*, and `plugins.updater.pubkey` in `tauri.conf.json` is base64 of
   the whole Minisign public-key file text. `tauri-plugin-updater` base64-
   decodes both and hands them to `minisign-verify` 0.2.5:

     public key   42 bytes: alg("Ed" | "ED") + key id (8) + ed25519 key (32)
     signature    74 bytes: alg + key id (8) + ed25519 signature (64)
     trusted comment line "trusted comment: <text>", text usually
                   "timestamp:<unix>\tfile:<name>[\tversion:<x.y.z>]"
     global sig   64 bytes: ed25519 over signature(64) || trusted-comment-text

   "ED" (prehashed) signs blake2b-512(data); "Ed" (legacy) signs data itself.
   `minisign-verify`'s `verify(..., allow_legacy = true)` — what the plugin
   calls — accepts both, and requires the signature key id to equal the public
   key's. The plugin additionally compares the `version:` field of the trusted
   comment against the feed's announced version when the app opts in
   (`require_signed_version`), so a tampered feed cannot pair a new version
   string with an old artifact. Both behaviours are reproduced here.

   The Ed25519 and blake2b-512 primitives come from `node:crypto` (OpenSSL);
   the Minisign framing is implemented here, and `tests/port-packaging.mjs`
   checks it against the reference vectors in `minisign-verify`'s own test
   suite as well as against a keypair generated in-test.

   ── Differences from the Tauri updater (deliberate) ─────────────────────────
   - No Rust plugin, so the download/verify/extract/replace sequence is
     re-expressed in Node. Verification happens before extraction and uses the
     exact Minisign rules above; the archive is an upstream `.app.tar.gz`.
   - Install swaps the whole `.app` bundle from a detached relaunch script
     (wait for this pid, rename old aside, rename new into place, relaunch).
     Tauri's macOS installer does an in-place bundle replace inside the plugin;
     the observable contract — "the running bundle is replaced and the app
     comes back up" — is the same.
   - Only macOS `.app` bundles are supported (the M5 scope). A `.dmg`- or
     package-manager-owned install, or a `npx electron .` dev run, is refused
     with a clear error instead of being overwritten: `install()` requires
     `…/X.app/Contents/Resources/app/package.json`, the marker this port's
     `build-app.mjs` writes.
   - The feed endpoint is the upstream one, whose artifacts are *Tauri* builds.
     A real Electron release must publish its own `latest.json` (same schema)
     pointing at its own `.app.tar.gz`; `check()` takes the feed URL as its
     first argument so the caller decides. `DEFAULT_FEED` exists only so the
     unwired module has a parity default.

   Public surface: { check, verifySignature, compareVersions, install }. */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/** Same feed the Tauri build ships with (`tauri.conf.json` `plugins.updater`). */
const DEFAULT_FEED =
  "https://github.com/apoc/omp-desktop/releases/latest/download/latest.json";

/** Base64 of `minisign.pub` as committed in `src-tauri/tauri.conf.json`. */
const DEFAULT_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwRTg1QkEyNjE2NjVEREYK" +
  "UldUZlhXWmhvbHZvVUJzQkROakpTdHhvcWdQdVRoMnNZNDl3T3ZKeEZJenNzc1p4RzArekIrcnoK";

/** Upper bound for the feed request (mirrors `updater::CHECK_TIMEOUT`). */
const CHECK_TIMEOUT_MS = 30_000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// ── versions ────────────────────────────────────────────────────────────────

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Semantic-version precedence, as `semver::Version` (and therefore the Tauri
 * updater) defines it: numeric fields compared numerically, a prerelease
 * sorting below its release, prerelease identifiers compared field by field
 * (numeric identifiers numerically and below alphanumeric ones), build
 * metadata ignored, leading `v` accepted.
 *
 * @returns {-1|0|1}
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const lp = left.prerelease;
  const rp = right.prerelease;
  if (!lp.length && !rp.length) return 0;
  if (!lp.length) return 1; // a release outranks its prereleases
  if (!rp.length) return -1;
  const n = Math.max(lp.length, rp.length);
  for (let i = 0; i < n; i += 1) {
    // A shorter identifier list sorts first when every shared field matches.
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    if (lp[i] === rp[i]) continue;
    const ln = /^\d+$/.test(lp[i]);
    const rn = /^\d+$/.test(rp[i]);
    if (ln && rn) return Number(lp[i]) < Number(rp[i]) ? -1 : 1;
    if (ln) return -1; // numeric identifiers sort below alphanumeric ones
    if (rn) return 1;
    return lp[i] < rp[i] ? -1 : 1;
  }
  return 0;
}

function parseVersion(text) {
  if (typeof text !== "string") throw new TypeError(`version must be a string, got ${typeof text}`);
  const m = SEMVER.exec(text.trim());
  if (!m) throw new Error(`not a semantic version: ${JSON.stringify(text)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

// ── minisign ────────────────────────────────────────────────────────────────

/**
 * Verify `data` against a Minisign signature, with the rules
 * `tauri-plugin-updater` applies (algorithm match, key-id match, blake2b-512
 * prehash for "ED", and the global signature over signature || trusted
 * comment).
 *
 * @param {Buffer|Uint8Array|string} data            the downloaded artifact
 * @param {string} signature  base64 of the `.sig` file text (feed form) or the
 *                            raw 4-line Minisign signature text
 * @param {string|Buffer} publicKey  base64 of `minisign.pub` (Tauri config
 *                            form), the raw 2-line public-key text, or the
 *                            base64 of the 42-byte key
 * @param {{ version?: string, requireSignedVersion?: boolean }} [options]
 *        `version` binds the feed's announced version to the signature's
 *        trusted comment (Tauri's `require_signed_version`); with
 *        `requireSignedVersion` a signature carrying no `version:` field is
 *        rejected too.
 * @returns {{ trustedComment: string, version: string|null }}
 * @throws {Error} `err.code` is one of `ERRSIGNATURE`, `ERRFORMAT`,
 *        `ERRVERSION`.
 */
function verifySignature(data, signature, publicKey, options = {}) {
  const key = decodePublicKey(publicKey);
  const sig = decodeSignature(signature);
  // The algorithm is a property of the signature, not the key: minisign keys
  // are all "Ed", while "ED" says the signature covers the blake2b-512 digest
  // (minisign-verify reads `signature.is_prehashed` and never compares it with
  // the key's algorithm byte).
  if (!sig.keyId.equals(key.keyId)) {
    throw signatureError("ERRFORMAT", "the signature was created with a different key than the provided public key");
  }
  const message = Buffer.from(data);
  const signed = sig.algorithm === "ED"
    ? crypto.createHash("blake2b512").update(message).digest()
    : message;
  if (!ed25519Verify(signed, key.key, sig.signature)) {
    throw signatureError("ERRSIGNATURE", "the signature does not match the downloaded artifact");
  }
  const globalInput = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519Verify(globalInput, key.key, sig.globalSignature)) {
    throw signatureError("ERRSIGNATURE", "the signature's trusted comment is not covered by its global signature");
  }
  const signedVersion = signedVersionOf(sig.trustedComment);
  if (options.version !== undefined) {
    if (signedVersion === null) {
      if (options.requireSignedVersion) {
        throw signatureError("ERRVERSION", "the signature carries no signed version");
      }
    } else if (compareVersions(signedVersion, options.version) !== 0) {
      throw signatureError(
        "ERRVERSION",
        `the artifact was signed for version ${signedVersion}, not ${options.version}`,
      );
    }
  }
  return { trustedComment: sig.trustedComment, version: signedVersion };
}

function signatureError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function ed25519Verify(message, rawKey, signature) {
  const keyObject = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
  try {
    return crypto.verify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}

function decodeBase64Strict(text, what) {
  const compact = text.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw signatureError("ERRFORMAT", `${what} is not valid base64`);
  }
  return Buffer.from(compact, "base64");
}

function decodePublicKey(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buf.length === 42 && isKeyAlgorithm(buf.subarray(0, 2))) return splitPublicKey(buf);
  if (buf.length === 32) {
    // Bare ed25519 key: useful for tests and in-process keys; no key id, so the
    // signature's id must then also be absent (checked by the caller's form).
    throw signatureError("ERRFORMAT", "a bare ed25519 key carries no key id; pass a minisign public key instead");
  }
  const text = buf.toString("utf8");
  if (text.includes("untrusted comment:")) {
    const keyLine = text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("untrusted comment:"));
    if (!keyLine) throw signatureError("ERRFORMAT", "public key has no key line");
    return splitPublicKey(decodeBase64Strict(keyLine, "public key line"));
  }
  // Either base64 of the whole `minisign.pub` text (Tauri config form) or
  // base64 of the bare 42-byte key (the line itself).
  const decoded = decodeBase64Strict(text, "public key");
  if (decoded.length === 42 && isKeyAlgorithm(decoded.subarray(0, 2))) return splitPublicKey(decoded);
  const inner = decoded.toString("utf8");
  if (!inner.includes("untrusted comment:")) {
    throw signatureError("ERRFORMAT", "public key is neither minisign text nor base64 of it");
  }
  const keyLine = inner.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("untrusted comment:"));
  if (!keyLine) throw signatureError("ERRFORMAT", "public key has no key line");
  return splitPublicKey(decodeBase64Strict(keyLine, "public key line"));
}

function isKeyAlgorithm(bytes) {
  const alg = bytes.toString("latin1");
  return alg === "Ed" || alg === "ED";
}

function splitPublicKey(raw) {
  if (raw.length !== 42) throw signatureError("ERRFORMAT", `minisign public key must be 42 bytes, got ${raw.length}`);
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (!isKeyAlgorithm(raw.subarray(0, 2))) {
    throw signatureError("ERRFORMAT", `unsupported minisign key algorithm ${JSON.stringify(algorithm)}`);
  }
  return { algorithm, keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

function decodeSignature(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  let text;
  if (Buffer.isBuffer(input) && buf.length === 74) {
    throw signatureError("ERRFORMAT", "a signature without its trusted comment cannot be used; pass the .sig text");
  }
  const asText = buf.toString("utf8");
  if (asText.includes("trusted comment:")) {
    text = asText;
  } else {
    // Reference/feed form: base64 of the whole `.sig` file text.
    text = decodeBase64Strict(asText, "signature").toString("utf8");
    if (!text.includes("trusted comment:")) {
      throw signatureError("ERRFORMAT", "signature is neither minisign text nor base64 of it");
    }
  }
  const lines = text.split(/\r?\n/);
  const sigIndex = lines.findIndex((line) => line && !line.startsWith("untrusted comment:"));
  if (sigIndex < 0) throw signatureError("ERRFORMAT", "signature has no signature line");
  const trustedIndex = lines.findIndex((line) => line.startsWith("trusted comment: "));
  if (trustedIndex < 0) throw signatureError("ERRFORMAT", "signature has no trusted comment");
  const globalLine = lines.slice(trustedIndex + 1).find((line) => line.trim());
  if (!globalLine) throw signatureError("ERRFORMAT", "signature has no global signature");
  const raw = decodeBase64Strict(lines[sigIndex], "signature line");
  if (raw.length !== 74) throw signatureError("ERRFORMAT", `signature line must be 74 bytes, got ${raw.length}`);
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (!isKeyAlgorithm(raw.subarray(0, 2))) {
    throw signatureError("ERRFORMAT", `unsupported minisign signature algorithm ${JSON.stringify(algorithm)}`);
  }
  const global = decodeBase64Strict(globalLine, "global signature");
  if (global.length !== 64) throw signatureError("ERRFORMAT", `global signature must be 64 bytes, got ${global.length}`);
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: lines[trustedIndex].slice("trusted comment: ".length),
    globalSignature: global,
  };
}

function signedVersionOf(trustedComment) {
  for (const field of trustedComment.split("\t")) {
    if (field.startsWith("version:")) return field.slice("version:".length);
  }
  return null;
}

// ── check ───────────────────────────────────────────────────────────────────

/**
 * Ask a `latest.json` feed whether a newer version exists. Mirrors
 * `Updater::check`: the announced version is compared with the running app's
 * version, and the platform entry is resolved with the plugin's fallback
 * order. The artifact is not downloaded here (the plugin doesn't either); its
 * signature is verified by `install()` once the bytes are in hand.
 *
 * @param {string} [feedUrl]
 * @param {{ currentVersion: string, publicKey?: string, platform?: string,
 *           target?: string, fetchImpl?: Function, timeoutMs?: number }} options
 *        `platform` overrides the derived key (e.g. `"darwin-aarch64"`);
 *        `target` behaves like the plugin's `updater_target` (looked up
 *        verbatim). `fetchImpl` exists for tests; it defaults to `fetch`.
 * @returns {Promise<{ available: boolean, currentVersion: string,
 *   version: string, notes: string, date: string|null, url: string,
 *   signature: string, target: string }>}
 */
async function check(feedUrl = DEFAULT_FEED, options = {}) {
  const currentVersion = options.currentVersion;
  if (!currentVersion) throw new Error("check() needs options.currentVersion");
  // Validate up front: a garbage local version would otherwise make every
  // comparison silently wrong.
  parseVersion(currentVersion);
  if (!feedUrl) throw new Error("check() needs a feed URL");

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const signal = timeoutMs > 0 && typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  const response = await fetchImpl(feedUrl, {
    redirect: "follow",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`update feed request failed: HTTP ${response.status}`);
  }
  const feed = await response.json();
  if (!feed || typeof feed !== "object") throw new Error("update feed is not a JSON object");
  if (typeof feed.version !== "string") throw new Error("update feed has no version");
  const platforms = feed.platforms;
  if (!platforms || typeof platforms !== "object") throw new Error("update feed has no platforms");

  const targets = options.target
    ? [options.target]
    : platformKeys(options.platform || currentPlatform());
  let entry = null;
  let target = null;
  for (const key of targets) {
    const candidate = platforms[key];
    if (candidate && typeof candidate.url === "string" && typeof candidate.signature === "string") {
      entry = candidate;
      target = key;
      break;
    }
  }
  if (!entry) {
    throw new Error(`update feed has no artifact for ${targets.join(" or ")}`);
  }

  return {
    available: compareVersions(feed.version, currentVersion) > 0,
    currentVersion,
    version: feed.version,
    notes: typeof feed.notes === "string" ? feed.notes : "",
    date: typeof feed.pub_date === "string" ? feed.pub_date : null,
    url: entry.url,
    signature: entry.signature,
    target,
  };
}

/** The plugin's `{os}-{arch}-{installer}` then `{os}-{arch}` order. */
function platformKeys(platform) {
  return platform.endsWith("-app") ? [platform] : [`${platform}-app`, platform];
}

function currentPlatform() {
  const osName = process.platform === "darwin" ? "darwin"
    : process.platform === "win32" ? "windows"
    : process.platform === "linux" ? "linux"
    : process.platform;
  const arch = process.arch === "arm64" ? "aarch64"
    : process.arch === "x64" ? "x86_64"
    : process.arch === "ia32" ? "i686"
    : process.arch;
  return `${osName}-${arch}`;
}

// ── install ─────────────────────────────────────────────────────────────────

/** The `.app` this process runs from, or null when it isn't a bundled app. */
function currentAppPath() {
  const exe = process.execPath;
  const macos = path.dirname(exe);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.extname(bundle) !== ".app") return null;
  if (!fs.existsSync(path.join(contents, "Resources", "app", "package.json"))) return null;
  return bundle;
}

/**
 * Download, verify and install an update announced by `check()`, then relaunch
 * through a detached script. Returns after the script is spawned; the caller
 * must quit the app (`options.quit` is invoked for exactly that). The script
 * waits for this process to exit, swaps the bundle, launches the new one and
 * removes its scratch directory.
 *
 * @param {{ url: string, signature: string, version: string }} update
 * @param {{ publicKey?: string, appPath?: string, workDir?: string,
 *           requireSignedVersion?: boolean, relaunch?: boolean,
 *           quit?: Function|null, fetchImpl?: Function, log?: Function }} [options]
 * @returns {Promise<{ appPath: string, staged: string, script: string, version: string }>}
 */
async function install(update, options = {}) {
  const log = options.log || (() => {});
  if (!update || typeof update.url !== "string" || typeof update.signature !== "string") {
    throw new Error("install() needs the { url, signature, version } of a checked update");
  }
  const appPath = options.appPath || currentAppPath();
  if (!appPath) {
    throw new Error(
      "not running from a packaged .app (…/X.app/Contents/Resources/app/package.json is missing); " +
        "refusing to self-update — use the release page instead",
    );
  }
  if (process.platform !== "darwin") throw new Error("self-install is implemented for macOS .app bundles only");

  const workDir = options.workDir || (await fsp.mkdtemp(path.join(os.tmpdir(), "omp-desktop-update-")));
  const archive = path.join(workDir, "update.tar.gz");
  log(`downloading ${update.url}`);
  await download(update.url, archive, options.fetchImpl || globalThis.fetch);

  const bytes = await fsp.readFile(archive);
  verifySignature(bytes, update.signature, options.publicKey || DEFAULT_PUBLIC_KEY, {
    version: update.version,
    requireSignedVersion: options.requireSignedVersion === true,
  });
  log("signature verified");

  const extractDir = path.join(workDir, "extracted");
  await fsp.mkdir(extractDir, { recursive: true });
  // bsdtar ships with macOS and needs no network; it also preserves the
  // bundle's symlinks (the Frameworks / Current links matter to launch).
  const tar = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", extractDir], { encoding: "utf8" });
  if (tar.status !== 0) {
    throw new Error(`could not unpack the update: ${tar.stderr || `tar exited ${tar.status}`}`);
  }
  const staged = findAppBundle(extractDir);
  if (!staged) throw new Error("the update archive contains no .app bundle");

  const script = path.join(workDir, "install.sh");
  await fsp.writeFile(script, relaunchScript({
    pid: process.pid,
    target: appPath,
    staged,
    workDir,
    relaunch: options.relaunch !== false,
  }), { mode: 0o755 });

  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
  child.unref();
  log(`relaunch script running as pid ${child.pid}; quitting to let it swap the bundle`);
  if (typeof options.quit === "function") options.quit();
  return { appPath, staged, script, version: update.version };
}

async function download(url, file, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`update download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("update download has no body");
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
}

/** First `*.app` (with an Info.plist) under `dir`, breadth-first, depth ≤ 4. */
function findAppBundle(dir) {
  let level = [dir];
  for (let depth = 0; depth < 4 && level.length; depth += 1) {
    const next = [];
    for (const current of level) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(current, entry.name);
        if (entry.name.endsWith(".app") && fs.existsSync(path.join(full, "Contents", "Info.plist"))) {
          return full;
        }
        next.push(full);
      }
    }
    level = next;
  }
  return null;
}

/** POSIX single-quote a path for a `/bin/sh` script. */
function shQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function relaunchScript({ pid, target, staged, workDir, relaunch }) {
  // Everything is quoted: paths contain spaces ("OMP Desktop.app") and the
  // scratch directory is user-controlled by the OS.
  return `#!/bin/sh
# Written by electron/packaging/updater.js. Wait for the updater process to
# exit, swap the bundle, relaunch, clean up.
set -u
target=${shQuote(target)}
staged=${shQuote(staged)}
backup="$target.omp-old"
while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done
rm -rf "$backup"
mv "$target" "$backup" || exit 1
if mv "$staged" "$target"; then
  rm -rf "$backup"
else
  rm -rf "$target" 2>/dev/null
  mv "$backup" "$target"
  exit 1
fi
${relaunch ? 'open "$target"' : ":"}
rm -rf ${shQuote(workDir)}
`;
}

module.exports = { check, verifySignature, compareVersions, install, DEFAULT_FEED };