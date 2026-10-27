/* Unit tests for electron/packaging/updater.js — the port's updater.

   The Tauri updater verifies Minisign signatures via `minisign-verify` 0.2.5
   (see the header of electron/packaging/updater.js for the byte layout and
   `.github/scripts/updater-json.mjs` for how signatures reach the feed). These
   tests cover the pieces that can be proven without a network or a packaged
   bundle:

     - semver precedence as `semver::Version` orders it (the Tauri updater's
       comparison);
     - Minisign verification against (a) the reference vectors shipped in
       `minisign-verify`'s own test suite — an implementation-independent
       interoperability check — and (b) keypairs generated in-test, including
       the failure modes (bad data, bad key id, tampered trusted comment,
       version binding);
     - `check()` feed parsing and platform fallback against a mock fetch;
     - the manual build's contract pieces that are cheap to assert (the build
       script's documented layout constants, no asar, updater wiring lives
       only in the dispatcher).

   It deliberately does not run the full 250 MB build (that is
   `node electron/packaging/build-app.mjs`); tests/port-packaging.mjs exists to
   run in the normal suite.

     node tests/port-packaging.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import updater from '../electron/packaging/updater.js';

const { check, verifySignature, compareVersions, install } = updater;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── minisign fixtures ───────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** base64 of a whole `.sig` file text, the form the Tauri feed carries. */
const feedSignature = (text) => Buffer.from(text).toString('base64');
/** base64 of a whole `minisign.pub` text, the form tauri.conf.json carries. */
const feedPublicKey = (text) => Buffer.from(text).toString('base64');

function publicKeyFile(algorithm, keyId, rawKey) {
  const blob = Buffer.concat([Buffer.from(algorithm, 'latin1'), keyId, rawKey]);
  assert.equal(blob.length, 42);
  const id = keyId.toString('hex').toUpperCase();
  return `untrusted comment: minisign public key: ${id}\n${blob.toString('base64')}\n`;
}

/**
 * A signer whose output is byte-for-byte what `tauri signer sign` produces
 * (base64 of the 4-line Minisign signature file, "ED" prehashed by default).
 */
function makeSigner({ prehashed = true, trustedComment = 'timestamp:1700000000\tfile:OMP Desktop.app.tar.gz\tversion:1.2.3' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawKey = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const keyId = crypto.randomBytes(8);
  // Minisign public keys themselves are always "Ed"; only signatures use "ED".
  const pubText = publicKeyFile('Ed', keyId, rawKey);

  return {
    keyId,
    rawKey,
    publicKey,
    pubText,
    pubKeyFeed: feedPublicKey(pubText),
    pubKeyLine: pubText.split('\n')[1],
    sign(data, { comment = trustedComment, prehashed: pre } = {}) {
      const isPre = pre ?? prehashed;
      const message = isPre ? crypto.createHash('blake2b512').update(data).digest() : Buffer.from(data);
      const sig = crypto.sign(null, message, privateKey);
      const line = Buffer.concat([Buffer.from(isPre ? 'ED' : 'Ed', 'latin1'), keyId, sig]).toString('base64');
      const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      return {
        text: `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
        feed: feedSignature(
          `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
        ),
        sig,
        comment,
      };
    },
  };
}

// Reference vectors from minisign-verify 0.2.5's own tests (lib.rs). Using
// them proves our Node implementation reads the same bytes as the Rust crate
// the Tauri updater runs, not merely a format we invented together.
const REFERENCE_KEY_FILE =
  'untrusted comment: minisign public key E7620F1842B4E81F\n' +
  'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n';
const REFERENCE_KEY_LINE = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
const REFERENCE_LEGACY_SIG =
  'untrusted comment: signature from minisign secret key\n' +
  'RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n' +
  'trusted comment: timestamp:1555779966\tfile:test\n' +
  'QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==';
const REFERENCE_PREHASHED_SIG =
  'untrusted comment: signature from minisign secret key\n' +
  'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n' +
  'trusted comment: timestamp:1556193335\tfile:test\n' +
  'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==';

// ── compareVersions (semver::Version precedence) ───────────────────────────

test('compareVersions: equal versions, v-prefix and build metadata ignored', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3+build.7', 'v1.2.3+other'), 0);
});

test('compareVersions: major/minor/patch compare numerically', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.11.0', '0.10.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('compareVersions: prerelease ordering follows SemVer 2.0.0 §11', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
  }
});

test('compareVersions: numeric identifiers sort below alphanumeric ones', () => {
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1);
});

test('compareVersions: a release outranks its prereleases', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
});

test('compareVersions: invalid versions are rejected like Version::from_str', () => {
  assert.throws(() => compareVersions('1.2', '1.2.3'), /not a semantic version/);
  assert.throws(() => compareVersions('banana', '1.2.3'), /not a semantic version/);
  assert.throws(() => compareVersions('1.2.3', 7), /version must be a string/);
});

// ── verifySignature: reference vectors (interop with minisign-verify) ──────

test('verifySignature: real minisign legacy "Ed" vector verifies', () => {
  const result = verifySignature(Buffer.from('test'), feedSignature(REFERENCE_LEGACY_SIG), feedPublicKey(REFERENCE_KEY_FILE));
  assert.equal(result.trustedComment, 'timestamp:1555779966\tfile:test');
  assert.equal(result.version, null);
});

test('verifySignature: real minisign prehashed "ED" vector verifies', () => {
  const result = verifySignature(Buffer.from('test'), feedSignature(REFERENCE_PREHASHED_SIG), feedPublicKey(REFERENCE_KEY_FILE));
  assert.equal(result.trustedComment, 'timestamp:1556193335\tfile:test');
});

test('verifySignature: reference prehashed vector rejects different data', () => {
  assert.throws(
    () => verifySignature(Buffer.from('Test'), feedSignature(REFERENCE_PREHASHED_SIG), feedPublicKey(REFERENCE_KEY_FILE)),
    { code: 'ERRSIGNATURE' },
  );
});

test('verifySignature: reference vector accepts the bare 42-byte key and its base64', () => {
  const raw = Buffer.from(REFERENCE_KEY_LINE, 'base64');
  assert.equal(raw.length, 42);
  for (const key of [raw, REFERENCE_KEY_LINE, REFERENCE_KEY_FILE]) {
    assert.doesNotThrow(() => verifySignature(Buffer.from('test'), REFERENCE_LEGACY_SIG, key));
  }
});

// ── verifySignature: generated keypairs and failure modes ──────────────────

test('verifySignature: generated prehashed signature verifies and reports its version', () => {
  const signer = makeSigner();
  const artifact = Buffer.from('pretend this is OMP Desktop.app.tar.gz');
  const signed = signer.sign(artifact);
  const result = verifySignature(artifact, signed.feed, signer.pubKeyFeed);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.trustedComment, signed.comment);
});

test('verifySignature: generated legacy "Ed" signature verifies', () => {
  const signer = makeSigner({ prehashed: false });
  const artifact = Buffer.from('legacy-mode artifact');
  const result = verifySignature(artifact, signer.sign(artifact).feed, signer.pubKeyFeed);
  assert.equal(result.version, '1.2.3');
});

test('verifySignature: tampered artifact is rejected', () => {
  const signer = makeSigner();
  const artifact = Buffer.from('real bytes');
  const signed = signer.sign(artifact);
  assert.throws(
    () => verifySignature(Buffer.from('real byts'), signed.feed, signer.pubKeyFeed),
    { code: 'ERRSIGNATURE' },
  );
});

test('verifySignature: a signature from another key is rejected by key id', () => {
  const signer = makeSigner();
  const other = makeSigner();
  const artifact = Buffer.from('bytes');
  assert.throws(
    () => verifySignature(artifact, signer.sign(artifact).feed, other.pubKeyFeed),
    /different key/,
  );
});

test('verifySignature: same key id but different key material is rejected', () => {
  const signer = makeSigner();
  const imposter = makeSigner();
  // Re-key the public key to the imposter's material under signer's key id:
  // the id check passes, Ed25519 must be what refuses it.
  const forgedKey = publicKeyFile('Ed', signer.keyId, imposter.rawKey);
  const artifact = Buffer.from('bytes');
  assert.throws(
    () => verifySignature(artifact, signer.sign(artifact).feed, forgedKey),
    { code: 'ERRSIGNATURE' },
  );
});

test('verifySignature: tampered trusted comment breaks the global signature', () => {
  const signer = makeSigner();
  const artifact = Buffer.from('bytes');
  const signed = signer.sign(artifact);
  const tampered = signed.text.replace('version:1.2.3', 'version:9.9.9');
  assert.notEqual(tampered, signed.text);
  assert.throws(() => verifySignature(artifact, tampered, signer.pubKeyFeed), { code: 'ERRSIGNATURE' });
});

test('verifySignature: version binding rejects a mismatched feed version', () => {
  const signer = makeSigner();
  const artifact = Buffer.from('bytes');
  const signed = signer.sign(artifact);
  assert.throws(
    () => verifySignature(artifact, signed.feed, signer.pubKeyFeed, { version: '1.2.4' }),
    { code: 'ERRVERSION' },
  );
  // A "v" prefix is the same version (the plugin compares parsed semvers).
  assert.doesNotThrow(() =>
    verifySignature(artifact, signed.feed, signer.pubKeyFeed, { version: 'v1.2.3' }),
  );
});

test('verifySignature: missing signed version is tolerated unless required', () => {
  const signer = makeSigner({ trustedComment: 'timestamp:1700000000\tfile:OMP Desktop.app.tar.gz' });
  const artifact = Buffer.from('bytes');
  const signed = signer.sign(artifact);
  const result = verifySignature(artifact, signed.feed, signer.pubKeyFeed, { version: '1.2.3' });
  assert.equal(result.version, null);
  assert.throws(
    () => verifySignature(artifact, signed.feed, signer.pubKeyFeed, { version: '1.2.3', requireSignedVersion: true }),
    { code: 'ERRVERSION' },
  );
});

test('verifySignature: malformed signature and key are rejected', () => {
  const signer = makeSigner();
  assert.throws(() => verifySignature(Buffer.from('x'), 'not base64 !!', signer.pubKeyFeed), { code: 'ERRFORMAT' });
  assert.throws(() => verifySignature(Buffer.from('x'), 'AAAA', signer.pubKeyFeed), { code: 'ERRFORMAT' });
  assert.throws(() => verifySignature(Buffer.from('x'), signer.sign(Buffer.from('x')).feed, 'AAAA'), { code: 'ERRFORMAT' });
});

test('verifySignature: a signature without its trusted comment is refused', () => {
  const signer = makeSigner();
  const artifact = Buffer.from('bytes');
  const signed = signer.sign(artifact);
  const raw = Buffer.from(signed.text.split('\n')[1], 'base64');
  assert.equal(raw.length, 74);
  assert.throws(() => verifySignature(artifact, raw, signer.pubKeyFeed), { code: 'ERRFORMAT' });
});

// ── check(): feed parsing and platform fallback (no network) ───────────────

function mockFetch(feed, status = 200) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => feed,
    };
  };
  impl.seen = seen;
  return impl;
}

const artifact = (tag) => ({
  signature: `signature-of-${tag}`,
  url: `https://example.test/OMP.Desktop.${tag}.app.tar.gz`,
});

const feedOf = (version, platforms) => ({
  version,
  notes: 'notes body',
  pub_date: '2026-10-27T06:00:00Z',
  platforms,
});

test('check: prefers the {os}-{arch}-app entry, like the plugin', async () => {
  const fetchImpl = mockFetch(
    feedOf('1.3.0', { 'darwin-aarch64': artifact('bare'), 'darwin-aarch64-app': artifact('app') }),
  );
  const update = await check('https://example.test/latest.json', { currentVersion: '1.2.0', fetchImpl });
  assert.equal(update.available, true);
  assert.equal(update.target, 'darwin-aarch64-app');
  assert.equal(update.url, artifact('app').url);
  assert.equal(update.version, '1.3.0');
  assert.equal(update.notes, 'notes body');
  assert.equal(update.date, '2026-10-27T06:00:00Z');
  assert.deepEqual(fetchImpl.seen, ['https://example.test/latest.json']);
});

test('check: falls back to the bare {os}-{arch} entry', async () => {
  const update = await check('https://example.test/latest.json', {
    currentVersion: '1.2.0',
    platform: 'darwin-aarch64',
    fetchImpl: mockFetch(feedOf('1.3.0', { 'darwin-aarch64': artifact('bare') })),
  });
  assert.equal(update.target, 'darwin-aarch64');
  assert.equal(update.url, artifact('bare').url);
});

test('check: no update when the feed version is not newer', async () => {
  for (const version of ['1.2.0', '1.1.9', 'v1.2.0']) {
    const update = await check('https://example.test/latest.json', {
      currentVersion: '1.2.0',
      platform: 'darwin-aarch64',
      fetchImpl: mockFetch(feedOf(version, { 'darwin-aarch64': artifact('bare') })),
    });
    assert.equal(update.available, false, version);
  }
});

test('check: prerelease feed for a release install is not an upgrade chain', async () => {
  const update = await check('https://example.test/latest.json', {
    currentVersion: '1.3.0',
    platform: 'darwin-aarch64',
    fetchImpl: mockFetch(feedOf('1.3.0-rc.1', { 'darwin-aarch64': artifact('bare') })),
  });
  assert.equal(update.available, false);
});

test('check: unknown platform is an error naming the targets it tried', async () => {
  await assert.rejects(
    check('https://example.test/latest.json', {
      currentVersion: '1.2.0',
      platform: 'darwin-aarch64',
      fetchImpl: mockFetch(feedOf('1.3.0', { 'linux-x86_64': artifact('linux') })),
    }),
    /darwin-aarch64-app or darwin-aarch64/,
  );
});

test('check: target option is looked up verbatim', async () => {
  const update = await check('https://example.test/latest.json', {
    currentVersion: '1.2.0',
    target: 'darwin-aarch64-app',
    fetchImpl: mockFetch(feedOf('1.3.0', { 'darwin-aarch64-app': artifact('app') })),
  });
  assert.equal(update.target, 'darwin-aarch64-app');
});

test('check: HTTP failure and malformed feeds are errors', async () => {
  await assert.rejects(
    check('https://example.test/latest.json', { currentVersion: '1.2.0', fetchImpl: mockFetch({}, 503) }),
    /HTTP 503/,
  );
  await assert.rejects(
    check('https://example.test/latest.json', { currentVersion: '1.2.0', fetchImpl: mockFetch({ version: '1.3.0' }) }),
    /no platforms/,
  );
  await assert.rejects(
    check('https://example.test/latest.json', { currentVersion: '1.2.0', fetchImpl: mockFetch({ platforms: {} }) }),
    /no version/,
  );
});

test('check: currentVersion is required and validated', async () => {
  await assert.rejects(check('https://example.test/latest.json', { fetchImpl: mockFetch({}) }), /currentVersion/);
  await assert.rejects(
    check('https://example.test/latest.json', { currentVersion: '0.11', fetchImpl: mockFetch({}) }),
    /not a semantic version/,
  );
});

test('check: default platform key matches this machine (darwin-aarch64)', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const update = await check('https://example.test/latest.json', {
    currentVersion: '0.11.0',
    fetchImpl: mockFetch(feedOf('0.12.0', { 'darwin-aarch64': artifact('bare') })),
  });
  assert.equal(update.target, 'darwin-aarch64');
});

// ── install(): guard rails (the bundle swap itself is proven by the build) ──

test('install: refuses to run outside a packaged .app', async () => {
  assert.equal(typeof install, 'function');
  await assert.rejects(
    install({ url: 'https://example.test/a.app.tar.gz', signature: 'sig', version: '1.0.0' }, { appPath: null }),
    /not running from a packaged \.app/,
  );
});

// ── build contract (static, no 250 MB assembly) ─────────────────────────────

test('build-app.mjs documents the manual layout and needs no packaging dependency', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron', 'packaging', 'build-app.mjs'), 'utf8');
  assert.match(source, /Contents\/Resources\/app/);
  assert.match(source, /codesign", \["--force", "--deep", "--sign", "-"/);
  assert.match(source, /dev\.ohMyPi\.desktop\.electron/);
  assert.match(source, /CFBundleExecutable/);
  assert.match(source, /LSMinimumSystemVersion/);
  // No packager dependency: the documented manual layout is the whole build.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.doesNotMatch(name, /^(electron-builder|electron-packager|@electron\/packager)$/);
  }
  assert.doesNotMatch(source, /https?:\/\//, 'the build must not fetch anything');
});

test('the dispatcher wires app_update_check to the updater (M5)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron/stub-backend.js'), 'utf8');
  assert.match(source, /require\("\.\/packaging\/updater"\)/, 'the dispatcher requires the updater');
  assert.match(source, /app_update_check:/, 'app_update_check is dispatched');
  // The renderer and preload stay updater-free: the check is a backend
  // command, exactly like the Tauri app's `app_update_check`.
  for (const file of ['electron/main.js', 'electron/preload.js']) {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(s, /packaging\/updater/, file);
  }
});