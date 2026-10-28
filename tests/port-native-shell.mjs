#!/usr/bin/env node
/* Parity tests for electron/backend/native-shell.js.

   Mirrors the Rust behaviour of the native-dialog / launcher commands, then
   covers the headless contract the port adds (no Electron main process ⇒ the
   dialog and shell commands reject with a named error, the pure helpers still
   work):

     external_open.rs   canonical_folder (realpath, `..`, symlinks, not-a-dir),
                        validate_reveal_path (empty / relative / vanished),
                        strip_verbatim (`\\?\`, UNC, volume GUIDs).
     navigation_guard.rs  the http(s)/mailto allow-list against file:, data:,
                        javascript:, tauri: and relative input.
     picked_files.rs    read_file_bytes (name + base64, missing, directory,
                        64 MiB cap), copy_background (single slot, lowercased
                        extension, default png, unrelated files kept), the
                        NSFilenamesPboardType plist (named + numeric entities,
                        non-absolute and malformed input).
     lib.rs             open_project / open_config_folder / take-the-picker
                        cancellation path (null) and the no-electron refusal.

   Run: node tests/port-native-shell.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const scratchDirs = [];
const originalConfigDir = process.env.OMP_PORT_CONFIG_DIR;

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_native_shell_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

function restoreEnv() {
  if (originalConfigDir === undefined) delete process.env.OMP_PORT_CONFIG_DIR;
  else process.env.OMP_PORT_CONFIG_DIR = originalConfigDir;
}

after(() => {
  restoreEnv();
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The module must load under plain node (no Electron runtime).
const nativeShell = require(path.join(root, 'electron/backend/native-shell.js'));
const stores = require(path.join(root, 'electron/backend/stores.js'));

const {
  openProject,
  openProjectAt,
  openConfigFolder,
  revealProjectPath,
  openUrlExternal,
  copiedFilePaths,
  readFileBytes,
  pickBackgroundImage,
  canonicalFolder,
  validateRevealPath,
  isAbsolutePath,
  stripVerbatim,
  parseExternalUrl,
  classifyExternalUrl,
  parseFileListPlist,
  unescapeXml,
  copyBackground,
  MAX_DROPPED_FILE_BYTES,
  BACKGROUND_IMAGE_EXTENSIONS,
} = nativeShell;

// ── the plist clipboard payload (NSFilenamesPboardType) ────────────────────

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<string>/Users/dev/a &amp; b.txt</string>
\t<string>/Users/dev/&lt;tag&gt;/&quot;quoted&quot;.png</string>
\t<string>/Users/dev/&#233;t&#xE9;/file.txt</string>
\t<string>/Users/dev/it&apos;s.txt</string>
\t<string>relative/path.txt</string>
\t<string>   </string>
\t<string></string>
</array>
</plist>`;

test('unescapeXml: named entities, decimal and hex character references', () => {
  assert.equal(unescapeXml('&amp;'), '&');
  assert.equal(unescapeXml('&lt;b&gt;'), '<b>');
  assert.equal(unescapeXml('&quot;x&quot;'), '"x"');
  assert.equal(unescapeXml('&apos;'), "'");
  assert.equal(unescapeXml('&#65;&#66;'), 'AB');
  assert.equal(unescapeXml('&#x41;&#X42;'), 'AB');
  // Single pass: a doubly-encoded ampersand stays encoded.
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
  // Unknown and malformed references are left alone.
  assert.equal(unescapeXml('&nbsp;'), '&nbsp;');
  assert.equal(unescapeXml('&amp'), '&amp');
  assert.equal(unescapeXml('100% & more'), '100% & more');
});

test('parseFileListPlist: string entries, entities, absolute-only filter', () => {
  assert.deepEqual(parseFileListPlist(PLIST), [
    '/Users/dev/a & b.txt',
    '/Users/dev/<tag>/"quoted".png',
    '/Users/dev/été/file.txt',
    "/Users/dev/it's.txt",
  ]);
  // Electron may hand the raw format back as a Buffer.
  assert.deepEqual(parseFileListPlist(Buffer.from(PLIST, 'utf8')), parseFileListPlist(PLIST));
});

test('parseFileListPlist: empty, non-plist and malformed payloads are []', () => {
  assert.deepEqual(parseFileListPlist(''), []);
  assert.deepEqual(parseFileListPlist(null), []);
  assert.deepEqual(parseFileListPlist(undefined), []);
  assert.deepEqual(parseFileListPlist(42), []);
  assert.deepEqual(parseFileListPlist('hello world'), []);
  assert.deepEqual(parseFileListPlist('<plist version="1.0"><array/></plist>'), []);
  assert.deepEqual(parseFileListPlist('<string>/unclosed'), []);
  assert.deepEqual(parseFileListPlist('<string/>'), []);
  assert.deepEqual(parseFileListPlist('<string>nope</string>'), []);
});

// ── url allow-list (navigation_guard::classify / open_external) ────────────

test('classifyExternalUrl: http, https and mailto are the only OS hand-offs', () => {
  for (const url of ['http://example.com', 'https://example.com/a?b=1', 'mailto:dev@example.com']) {
    assert.equal(classifyExternalUrl(new URL(url)), 'open', url);
  }
  for (const url of [
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'tauri://localhost/index.html',
    'ftp://example.com/x',
    'chrome://settings',
  ]) {
    assert.equal(classifyExternalUrl(new URL(url)), 'block', url);
  }
});

test('parseExternalUrl: the url crate error strings', () => {
  assert.throws(() => parseExternalUrl('not a url'), /relative URL without a base/);
  assert.throws(() => parseExternalUrl(''), /relative URL without a base/);
  assert.throws(() => parseExternalUrl('/etc/passwd'), /relative URL without a base/);
  assert.throws(() => parseExternalUrl('http://'), /empty host/);
  assert.throws(() => parseExternalUrl('https:///'), /empty host/);
  assert.equal(parseExternalUrl('https://example.com').href, 'https://example.com/');
  assert.equal(parseExternalUrl('mailto:a@b.c').protocol, 'mailto:');
});

test('open_url_external refuses non-web/mail schemes with the Rust message', async () => {
  await assert.rejects(
    () => openUrlExternal('file:///etc/passwd'),
    /refusing to open file:\/\/\/etc\/passwd externally/,
  );
  await assert.rejects(() => openUrlExternal('javascript:alert(1)'), /refusing to open .* externally/);
  await assert.rejects(() => openUrlExternal('tauri://localhost/'), /refusing to open .* externally/);
  await assert.rejects(() => openUrlExternal('nope'), /relative URL without a base/);
});

// ── path validation ────────────────────────────────────────────────────────

test('canonicalFolder resolves `..` and symlinks, rejects files and gaps', () => {
  const dir = makeTestDir('canon');
  fs.mkdirSync(path.join(dir, 'nested'));
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'x');

  const expected = fs.realpathSync(dir);
  assert.equal(canonicalFolder(path.join(dir, 'nested', '..')), expected);
  assert.equal(canonicalFolder(dir), expected);

  const link = path.join(dir, 'link');
  fs.symlinkSync(dir, link);
  assert.equal(canonicalFolder(link), expected);

  assert.throws(() => canonicalFolder(file), /^Error: not a directory: '/);
  assert.throws(
    () => canonicalFolder(path.join(dir, 'missing')),
    /cannot resolve '.*missing': No such file or directory \(os error 2\)/,
  );
});

test('isAbsolutePath mirrors `Path::is_absolute` for this platform', () => {
  const triple = process.platform === 'win32';
  assert.equal(isAbsolutePath(triple ? 'C:\\proj' : '/Users/dev'), true);
  assert.equal(isAbsolutePath(triple ? '\\\\srv\\share' : '/'), true);
  assert.equal(isAbsolutePath(triple ? '\\rooted' : 'rooted'), false);
  assert.equal(isAbsolutePath(triple ? 'C:relative' : './x'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('stripVerbatim undoes `\\\\?\\` for drive and UNC paths only', () => {
  assert.equal(stripVerbatim('\\\\?\\C:\\proj'), 'C:\\proj');
  assert.equal(stripVerbatim('\\\\?\\c:\\proj'), 'c:\\proj');
  assert.equal(stripVerbatim('\\\\?\\UNC\\server\\share'), '\\\\server\\share');
  assert.equal(stripVerbatim('\\\\?\\Volume{abc}\\'), '\\\\?\\Volume{abc}\\');
  assert.equal(stripVerbatim('/Users/dev/proj'), '/Users/dev/proj');
});

test('validateRevealPath: empty, relative, vanished and file paths', () => {
  const dir = makeTestDir('reveal');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');

  assert.throws(() => validateRevealPath(''), /^Error: empty path$/);
  assert.throws(() => validateRevealPath('   '), /^Error: empty path$/);
  assert.throws(() => validateRevealPath(undefined), /^Error: empty path$/);
  assert.throws(() => validateRevealPath('relative/dir'), /^Error: not an absolute path$/);
  assert.throws(() => validateRevealPath(path.join(dir, 'file.txt')), /^Error: no such folder$/);
  assert.throws(() => validateRevealPath(path.join(dir, 'gone')), /^Error: no such folder$/);
  assert.equal(validateRevealPath(dir), dir);
});

test('open_project_at: absolute directory in, canonical path out', async () => {
  const dir = makeTestDir('at');
  fs.mkdirSync(path.join(dir, 'nested'));
  const expected = fs.realpathSync(dir);

  assert.equal(await openProjectAt(path.join(dir, 'nested', '..')), expected);
  await assert.rejects(() => openProjectAt(''), /^Error: empty path$/);
  await assert.rejects(() => openProjectAt('   '), /^Error: empty path$/);
  await assert.rejects(() => openProjectAt('relative/dir'), /^Error: not an absolute path$/);
  await assert.rejects(() => openProjectAt(7), /^Error: empty path$/);
  await assert.rejects(
    () => openProjectAt(path.join(dir, 'missing')),
    /cannot resolve '.*missing': No such file or directory \(os error 2\)/,
  );
});

// ── read_file_bytes (picked_files::read) ───────────────────────────────────

test('read_file_bytes returns name + base64 and round-trips the bytes', async () => {
  const dir = makeTestDir('read');
  const file = path.join(dir, 'pic.png');
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
  fs.writeFileSync(file, raw);

  const got = await readFileBytes(file);
  assert.equal(got.name, 'pic.png');
  assert.deepEqual(Object.keys(got).sort(), ['data', 'name']); // Rust's DroppedFile
  assert.deepEqual(Buffer.from(got.data, 'base64'), raw);
});

test('read_file_bytes refuses a directory, a gap and a too-large file', async () => {
  const dir = makeTestDir('read_err');
  await assert.rejects(() => readFileBytes(dir), new RegExp(`^Error: not a file: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  const missing = path.join(dir, 'definitely-not-there.png');
  await assert.rejects(
    () => readFileBytes(missing),
    /could not read .*definitely-not-there\.png: No such file or directory \(os error 2\)/,
  );
  await assert.rejects(() => readFileBytes(42), /read_file_bytes: path must be a string/);

  // Sparse file just past the cap: no 64 MiB of writes on disk.
  const big = path.join(dir, 'big.bin');
  const fd = fs.openSync(big, 'w');
  try {
    fs.ftruncateSync(fd, MAX_DROPPED_FILE_BYTES + 1);
  } finally {
    fs.closeSync(fd);
  }
  await assert.rejects(() => readFileBytes(big), /^Error: file too large: /);
  assert.equal(MAX_DROPPED_FILE_BYTES, 64 * 1024 * 1024);
});

// ── copy_background (picked_files::copy_background) ───────────────────────

test('copy_background: single slot under the config dir, lowercased extension', () => {
  const configDir = makeTestDir('bg_config');
  const src = path.join(makeTestDir('bg_src'), 'Wallpaper.PNG');
  fs.writeFileSync(src, 'image-bytes');

  const backgrounds = path.join(configDir, 'backgrounds');
  fs.mkdirSync(backgrounds, { recursive: true });
  fs.writeFileSync(path.join(backgrounds, 'background.jpg'), 'stale');
  fs.writeFileSync(path.join(backgrounds, 'notes.txt'), 'keep me');

  const dest = copyBackground(configDir, src);
  assert.equal(dest, path.join(backgrounds, 'background.png'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'image-bytes');
  assert.equal(fs.existsSync(path.join(backgrounds, 'background.jpg')), false);
  assert.equal(fs.existsSync(path.join(backgrounds, 'notes.txt')), true);
});

test('copy_background: no extension falls back to png', () => {
  const configDir = makeTestDir('bg_noext');
  const srcDir = makeTestDir('bg_noext_src');
  const src = path.join(srcDir, 'shot');
  fs.writeFileSync(src, 'x');
  assert.equal(copyBackground(configDir, src), path.join(configDir, 'backgrounds', 'background.png'));

  // `Path::extension()` is None for a dotfile, too.
  const hidden = path.join(srcDir, '.wallpaper');
  fs.writeFileSync(hidden, 'x');
  assert.equal(copyBackground(configDir, hidden), path.join(configDir, 'backgrounds', 'background.png'));

  // …and Some("") for a trailing dot, which keeps the empty extension.
  const trailing = path.join(srcDir, 'shot.');
  fs.writeFileSync(trailing, 'x');
  assert.equal(copyBackground(configDir, trailing), path.join(configDir, 'backgrounds', 'background.'));
});

test('copy_background: honours OMP_PORT_CONFIG_DIR when driven from configHome', () => {
  const configDir = makeTestDir('bg_env');
  process.env.OMP_PORT_CONFIG_DIR = configDir;
  try {
    assert.equal(stores.configHome(), path.resolve(configDir));
    const src = path.join(makeTestDir('bg_env_src'), 'pic.webp');
    fs.writeFileSync(src, 'webp');
    const dest = copyBackground(stores.configHome(), src);
    assert.equal(dest, path.join(configDir, 'backgrounds', 'background.webp'));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'webp');
  } finally {
    restoreEnv();
  }
});

test('copy_background: a missing source is the Rust copy error', () => {
  const configDir = makeTestDir('bg_missing');
  const src = path.join(configDir, 'nope.png');
  assert.throws(
    () => copyBackground(configDir, src),
    /cannot copy .*nope\.png: No such file or directory \(os error 2\)/,
  );
});

test('the background picker offers the Rust image filter list', () => {
  assert.deepEqual(BACKGROUND_IMAGE_EXTENSIONS, [
    'png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'svg',
  ]);
});

// ── headless: no Electron main process ────────────────────────────────────

test('dialog and launcher commands require the Electron main process', async () => {
  const dir = makeTestDir('headless');
  await assert.rejects(() => openProject(), /^Error: open_project requires the Electron main process$/);
  await assert.rejects(
    () => openConfigFolder(),
    /^Error: open_config_folder requires the Electron main process$/,
  );
  await assert.rejects(
    () => revealProjectPath(dir),
    /^Error: reveal_project_path requires the Electron main process$/,
  );
  await assert.rejects(
    () => openUrlExternal('https://example.com/'),
    /^Error: open_url_external requires the Electron main process$/,
  );
  await assert.rejects(
    () => pickBackgroundImage(),
    /^Error: pick_background_image requires the Electron main process$/,
  );
});

test('copied_file_paths never fails: [] without a clipboard bridge', async () => {
  assert.deepEqual(await copiedFilePaths(), []);
});