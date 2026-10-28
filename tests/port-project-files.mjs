#!/usr/bin/env node
/* Parity tests for electron/backend/project-files.js.

   Mirrors the Rust suites, then covers the port's own edges:

     files.rs          walked tree + skip dirs + hidden rule, fuzzy ranking
                       (consecutive / boundary / basename bonuses, length
                       penalty), tie-breaks, limit clamps, the query byte cap,
                       the entry and depth caps, symlinked dirs not followed,
                       non-UTF-8 names, root resolution.
     project_file.rs   text/image/binary/missing/too-large/outside kinds,
                       relative + absolute paths, traversal and `.git`
                       refusals, symlink-escape refusal (file and `.git`),
                       inside symlinks followed, per-kind inclusive caps,
                       lossy UTF-8, base64 + mime, exact preview shape.
     workspace.rs      validate_path_text / validate_relative_path errors.
     git_browser/mod.rs project_relative error strings.

   Run: node tests/port-project-files.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFiles = require(path.join(root, 'electron/backend/project-files.js'));

const {
  listProjectFiles,
  projectFileRead,
  projectRelative,
  validatePathText,
  validateRelativePath,
  searchPathsCapped,
  fuzzyScore,
  imageMime,
  isBinary,
  clampLimit,
  SKIP_DIRS,
  MAX_ENTRIES,
  MAX_DEPTH,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_QUERY_LEN,
  MAX_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  BINARY_SNIFF_BYTES,
} = projectFiles;

// ── harness ────────────────────────────────────────────────────────────────

const scratchDirs = [];
const originalCwd = process.cwd();

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_project_files_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A file symlink; `false` where the OS refuses one. */
function symlink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

function dirSymlink(target, link) {
  try {
    fs.symlinkSync(target, link, 'dir');
    return true;
  } catch {
    return false;
  }
}

/** A sparse file of `size` bytes (instant, no content written). */
function sparse(dir, rel, size) {
  const file = write(dir, rel, '');
  fs.truncateSync(file, size);
  return file;
}

after(() => {
  process.chdir(originalCwd);
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fuzzy score (files.rs::fuzzy_score) ────────────────────────────────────

test('fuzzy_score: exact hand-counted scores', () => {
  // 'a' at i=0: +10 match, +8 segment start, +6 basename.
  // 'b' at i=1: +10 match, +12 consecutive, +6 basename. Length 2 / 4 = 0.
  assert.equal(fuzzyScore('ab', ['a', 'b'], 0), 52);
  // Folding: the needle is compared case-insensitively.
  assert.equal(fuzzyScore('AB', ['a', 'b'], 0), 52);
  // 'y' at i=2 follows a boundary: +10 +8 +6, length 3 / 4 = 0.
  assert.equal(fuzzyScore('x/y', ['y'], 2), 24);
  // Not a subsequence in order.
  assert.equal(fuzzyScore('ba', ['a', 'b'], 0), null);
  assert.equal(fuzzyScore('abc', [], 0), 0);
});

test('fuzzy_score: consecutive, boundary and basename bonuses', () => {
  const consecutive = fuzzyScore('abc', ['a', 'b', 'c'], 0);
  const spread = fuzzyScore('a-b-c', ['a', 'b', 'c'], 0);
  assert.ok(consecutive > spread, 'a consecutive run outranks a spread match');

  const inName = fuzzyScore('x/ab', ['a', 'b'], 2);
  const inDir = fuzzyScore('ab/x', ['a', 'b'], 3);
  assert.ok(inName > inDir, 'a basename hit outranks a directory hit');

  // Boundary bonus: '-' starts a new word.
  assert.ok(
    fuzzyScore('a-b', ['b'], 2) > fuzzyScore('aab', ['b'], 2),
    'a segment start outranks a mid-word hit',
  );
});

test('fuzzy_score: longer paths are penalised (bytes / 4, floored)', () => {
  const short = fuzzyScore('ab', ['a', 'b'], 0);
  const long = fuzzyScore('ab/'.padEnd(20, 'x'), ['a', 'b'], 0);
  assert.equal(short - long, Math.trunc(20 / 4) - 0);
});

// ── search_paths (files.rs::search_paths_capped) ───────────────────────────

test('search walks files and dirs and never enters SKIP_DIRS', () => {
  const dir = makeTestDir('walk');
  write(dir, 'README.md', '# hi\n');
  write(dir, 'src/app.js', 'x\n');
  write(dir, 'src/deep/lib.js', 'x\n');
  write(dir, 'docs/guide.md', 'x\n');
  for (const skipped of ['node_modules/dep/index.js', 'dist/out.js', 'target/x.rs', 'build/b.js', '.next/p.js']) {
    write(dir, skipped, 'x\n');
  }

  const all = listProjectFiles(dir, '');
  const paths = all.map((hit) => hit.path);
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/app.js'));
  assert.ok(paths.includes('src/deep'));
  assert.ok(paths.includes('src/deep/lib.js'));
  for (const hit of all) {
    assert.ok(!/node_modules|(^|\/)dist(\/|$)|(^|\/)target(\/|$)|(^|\/)build(\/|$)|\.next/.test(hit.path), hit.path);
  }
  // Directories are flagged so the menu can drill down.
  assert.deepEqual(
    all.find((hit) => hit.path === 'src'),
    { path: 'src', name: 'src', isDir: true },
  );
  assert.deepEqual(
    all.find((hit) => hit.path === 'src/app.js'),
    { path: 'src/app.js', name: 'app.js', isDir: false },
  );

  // A query that only the skipped trees would answer stays empty.
  assert.deepEqual(listProjectFiles(dir, 'index'), []);
  assert.deepEqual(listProjectFiles(dir, 'out'), []);
});

test('hidden entries stay hidden unless the query names one', () => {
  const dir = makeTestDir('hidden');
  write(dir, '.env', 'A=1\n');
  write(dir, '.hidden/secret.js', 'x\n');
  write(dir, 'visible.txt', 'x\n');

  const all = listProjectFiles(dir, '').map((hit) => hit.path);
  assert.deepEqual(all, ['visible.txt']);

  const dotQuery = listProjectFiles(dir, '.hid').map((hit) => hit.path);
  assert.ok(dotQuery.includes('.hidden'));
  assert.ok(dotQuery.includes('.hidden/secret.js'));

  const explicit = listProjectFiles(dir, '.env').map((hit) => hit.path);
  assert.ok(explicit.includes('.env'));
});

test('results are ranked by score, then shorter path, then lexically', () => {
  const dir = makeTestDir('rank');
  write(dir, 'app.ts', 'x\n');
  write(dir, 'src/components/app.ts', 'x\n');
  write(dir, 'src/apple-notes.md', 'x\n');

  const hits = listProjectFiles(dir, 'app');
  assert.equal(hits[0].path, 'app.ts', 'the shallow, boundary-start hit wins');
  assert.equal(hits[1].path, 'src/apple-notes.md');
  assert.equal(hits[2].path, 'src/components/app.ts');
});

test('limit clamps to [1, 200] and defaults to 30', () => {
  const dir = makeTestDir('limit');
  for (let i = 0; i < 5; i += 1) write(dir, `f${i}.txt`, 'x\n');

  assert.equal(listProjectFiles(dir, 'f').length, 5);
  assert.equal(listProjectFiles(dir, 'f', undefined).length, 5);
  assert.equal(listProjectFiles(dir, 'f', 2).length, 2);
  assert.equal(listProjectFiles(dir, 'f', 0).length, 1);
  assert.equal(listProjectFiles(dir, 'f', -9).length, 1);
  assert.equal(clampLimit(999), MAX_LIMIT);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit(Number.NaN), DEFAULT_LIMIT);
});

test('the query byte cap and root errors use the Rust messages', () => {
  const dir = makeTestDir('errors');
  assert.throws(() => listProjectFiles(dir, 'x'.repeat(MAX_QUERY_LEN + 1)), {
    message: `query too long (max ${MAX_QUERY_LEN} bytes)`,
  });
  // Bytes, not chars: 128 × 'é' is exactly 256 bytes and passes.
  assert.deepEqual(listProjectFiles(dir, '\u00e9'.repeat(MAX_QUERY_LEN / 2)), []);
  assert.throws(() => listProjectFiles(dir, '\u00e9'.repeat(MAX_QUERY_LEN / 2 + 1)), {
    message: `query too long (max ${MAX_QUERY_LEN} bytes)`,
  });

  const file = write(dir, 'a.txt', 'x');
  assert.throws(() => listProjectFiles(file, ''), { message: `not a directory: ${file}` });
  const gone = path.join(dir, 'nope');
  assert.throws(() => listProjectFiles(gone, ''), { message: `not a directory: ${gone}` });
});

test('an empty cwd falls back to the process working directory', () => {
  const dir = makeTestDir('cwd');
  write(dir, 'only.txt', 'x\n');
  process.chdir(dir);
  try {
    assert.deepEqual(listProjectFiles('', 'only').map((hit) => hit.path), ['only.txt']);
    assert.deepEqual(listProjectFiles(undefined, 'only').map((hit) => hit.path), ['only.txt']);
  } finally {
    process.chdir(originalCwd);
  }
});

test('the entry cap stops the walk', () => {
  const dir = makeTestDir('entries');
  for (let i = 0; i < 6; i += 1) write(dir, `e${i}.txt`, 'x\n');

  assert.equal(searchPathsCapped(dir, 'e', 30, MAX_ENTRIES).length, 6);
  assert.equal(searchPathsCapped(dir, 'e', 30, 0).length, 0);
  assert.equal(searchPathsCapped(dir, 'e', 30, 1).length, 1);
  assert.ok(searchPathsCapped(dir, 'e', 30, 3).length <= 3);
});

test('directories below MAX_DEPTH are not descended into', () => {
  const dir = makeTestDir('depth');
  const nest = (n) => Array.from({ length: n }, (_, i) => `d${i + 1}`).join(path.sep);
  // A file whose parent sits at depth MAX_DEPTH is still listed; one level
  // deeper is not.
  write(dir, `${nest(MAX_DEPTH)}/edge.txt`, 'x\n');
  write(dir, `${nest(MAX_DEPTH + 1)}/deep.txt`, 'x\n');

  const paths = listProjectFiles(dir, 'txt').map((hit) => hit.path);
  assert.ok(paths.some((p) => p.endsWith('/edge.txt')), 'depth 12 file is found');
  assert.ok(!paths.some((p) => p.endsWith('/deep.txt')), 'depth 13 file is not');
});

test('symlinked directories are listed but never followed', () => {
  const dir = makeTestDir('symlink-dir');
  const outside = makeTestDir('symlink-dir-out');
  write(outside, 'needle-in-share.txt', 'x\n');
  if (!dirSymlink(outside, path.join(dir, 'share'))) {
    return; // symlinks not permitted here
  }
  write(dir, 'own.txt', 'x\n');

  const share = listProjectFiles(dir, 'share');
  assert.deepEqual(share, [{ path: 'share', name: 'share', isDir: false }]);
  assert.ok(!listProjectFiles(dir, 'needle').some((hit) => hit.path.includes('needle')));
});

test('non-UTF-8 names are skipped', () => {
  const dir = makeTestDir('utf8');
  write(dir, 'ok.txt', 'x\n');
  // APFS rejects invalid UTF-8 names; the case is only reachable elsewhere.
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0xff, 0xfe])]), 'x');
  } catch {
    return;
  }
  for (const hit of listProjectFiles(dir, '')) assert.equal(typeof hit.path, 'string');
});

test('SKIP_DIRS carries the whole Rust list', () => {
  assert.deepEqual(
    [...SKIP_DIRS].sort(),
    [
      '.cache',
      '.git',
      '.gradle',
      '.idea',
      '.next',
      '.nuxt',
      '.turbo',
      '.venv',
      'build',
      'dist',
      'node_modules',
      'target',
      'venv',
      '__pycache__',
    ].sort(),
  );
});

// ── path validation (workspace.rs, git_browser/mod.rs) ─────────────────────

test('validate_path_text mirrors the Rust refusals', () => {
  assert.throws(() => validatePathText(''), { message: 'path must not be empty' });
  assert.throws(() => validatePathText('/etc/passwd'), { message: 'path must not be absolute' });
  assert.throws(() => validatePathText('\\\\server\\share'), { message: 'path must not be absolute' });
  assert.throws(() => validatePathText('C:/x'), { message: 'path must not be a drive-letter path' });
  assert.throws(() => validatePathText('../x'), {
    message: "path must not contain '..' or empty components",
  });
  assert.throws(() => validatePathText('a//b'), {
    message: "path must not contain '..' or empty components",
  });
  assert.throws(() => validatePathText('.git/config'), {
    message: 'path must not reference the .git directory',
  });
  assert.throws(() => validatePathText('a/.GIT/config'), {
    message: 'path must not reference the .git directory',
  });
  assert.equal(validatePathText('src/a.js'), 'src/a.js');
});

test('project_relative accepts relative and inside-absolute paths only', () => {
  const dir = makeTestDir('relative');
  write(dir, 'src/a.rs', 'x\n');

  assert.equal(projectRelative(dir, 'src/a.rs'), 'src/a.rs');
  assert.equal(projectRelative(dir, path.join(dir, 'src', 'a.rs')), 'src/a.rs');

  const outside = makeTestDir('relative-out');
  const secret = write(outside, 'secret.txt', 's\n');
  assert.throws(() => projectRelative(dir, secret), {
    message: `${secret} is outside the repository`,
  });
  assert.throws(() => projectRelative(dir, '../outside'), {
    message: "path must not contain '..' or empty components",
  });

  // Symlinked parent escaping the project: the guard is on the parents.
  if (dirSymlink(outside, path.join(dir, 'link'))) {
    assert.throws(() => validateRelativePath(dir, 'link/secret.txt'), {
      message: 'path escapes repository root',
    });
  }
});

// ── project_file_read (project_file.rs) ────────────────────────────────────

test('text files read by relative and absolute path', () => {
  const dir = makeTestDir('text');
  write(dir, 'src/a.rs', 'fn main() {}\n');

  const rel = projectFileRead(dir, 'src/a.rs');
  assert.deepEqual(rel, {
    path: 'src/a.rs',
    size: 13,
    kind: 'Text',
    text: 'fn main() {}\n',
    data: null,
    mimeType: null,
  });

  const abs = projectFileRead(dir, path.join(dir, 'src', 'a.rs'));
  assert.equal(abs.path, 'src/a.rs');
  assert.equal(abs.kind, 'Text');
  assert.equal(abs.text, 'fn main() {}\n');
});

test('preview objects keep the serde key order and camelCase', () => {
  const dir = makeTestDir('shape');
  write(dir, 'a.txt', 'x');
  const preview = projectFileRead(dir, 'a.txt');
  assert.deepEqual(Object.keys(preview), ['path', 'size', 'kind', 'text', 'data', 'mimeType']);
  assert.equal(typeof preview.size, 'number');
});

test('images come back as base64 with their mime', () => {
  const dir = makeTestDir('image');
  write(dir, 'shot.PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const file = projectFileRead(dir, 'shot.PNG');
  assert.equal(file.kind, 'Image');
  assert.equal(file.mimeType, 'image/png');
  assert.equal(file.data, 'iVBORwAB');
  assert.equal(file.text, null);
  assert.equal(file.size, 6);
});

test('image_mime covers the Rust table and nothing else', () => {
  const table = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    svg: 'image/svg+xml',
  };
  for (const [ext, mime] of Object.entries(table)) {
    assert.equal(imageMime(`a.${ext}`), mime);
    assert.equal(imageMime(`a.${ext.toUpperCase()}`), mime);
  }
  assert.equal(imageMime('a.txt'), null);
  assert.equal(imageMime('a.tar.gz'), null);
  assert.equal(imageMime('noext'), null);
});

test('binary, missing and oversized files are kinds, not errors', () => {
  const dir = makeTestDir('kinds');
  write(dir, 'app.bin', Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x64, 0x61, 0x74, 0x61]));
  write(dir, 'src/big.txt', Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));

  const binary = projectFileRead(dir, 'app.bin');
  assert.deepEqual(binary, {
    path: 'app.bin',
    size: 8,
    kind: 'Binary',
    text: null,
    data: null,
    mimeType: null,
  });

  const gone = projectFileRead(dir, 'src/gone.rs');
  assert.deepEqual(gone, {
    path: 'src/gone.rs',
    size: 0,
    kind: 'Missing',
    text: null,
    data: null,
    mimeType: null,
  });

  // Rust refuses an over-cap body outright — it never truncates, so the
  // reply is the TooLarge kind carrying the full size and no text.
  const big = projectFileRead(dir, 'src/big.txt');
  assert.equal(big.kind, 'TooLarge');
  assert.equal(big.size, MAX_TEXT_BYTES + 1);
  assert.equal(big.text, null);
  assert.equal(big.data, null);
});

test('caps are inclusive and per kind', () => {
  const dir = makeTestDir('caps');
  write(dir, 'exact.txt', Buffer.alloc(MAX_TEXT_BYTES, 0x61));
  write(dir, 'big.png', Buffer.alloc(MAX_TEXT_BYTES + 1, 0x01));
  sparse(dir, 'huge.png', MAX_IMAGE_BYTES + 1);

  assert.equal(projectFileRead(dir, 'exact.txt').kind, 'Text');
  assert.equal(projectFileRead(dir, 'exact.txt').text.length, MAX_TEXT_BYTES);

  // Over the text cap but under the image cap: still an image.
  const bigPng = projectFileRead(dir, 'big.png');
  assert.equal(bigPng.kind, 'Image');
  assert.equal(bigPng.size, MAX_TEXT_BYTES + 1);
  assert.ok(bigPng.data.length > 0);

  const huge = projectFileRead(dir, 'huge.png');
  assert.equal(huge.kind, 'TooLarge');
  assert.equal(huge.size, MAX_IMAGE_BYTES + 1);
});

test('paths leaving the project are refused', () => {
  const dir = makeTestDir('escape');
  const outside = makeTestDir('escape-outside');
  const secret = write(outside, 'secret.txt', 's\n');
  write(dir, '.git/config', '[remote]\n');
  fs.mkdirSync(path.join(dir, 'src'));

  assert.throws(() => projectFileRead(dir, '../escape-outside/secret.txt'), {
    message: "path must not contain '..' or empty components",
  });
  assert.throws(() => projectFileRead(dir, secret), {
    message: `${secret} is outside the repository`,
  });
  assert.throws(() => projectFileRead(dir, '.git/config'), {
    message: 'path must not reference the .git directory',
  });
  assert.throws(() => projectFileRead(dir, 'src'), { message: 'src is not a file' });
  assert.throws(() => projectFileRead(dir, ''), { message: 'path must not be empty' });
});

test('a symlinked file pointing out of the project is refused', () => {
  const dir = makeTestDir('file-symlink');
  const outside = makeTestDir('file-symlink-out');
  const secret = write(outside, 'secret.txt', 's\n');
  if (!symlink(secret, path.join(dir, 'link'))) return; // symlinks not permitted here

  assert.deepEqual(projectFileRead(dir, 'link'), {
    path: 'link',
    size: 0,
    kind: 'Outside',
    text: null,
    data: null,
    mimeType: null,
  });

  // One that stays inside is followed.
  const real = write(dir, 'src/real.txt', 'r\n');
  assert.ok(symlink(real, path.join(dir, 'inside')));
  const inside = projectFileRead(dir, 'inside');
  assert.equal(inside.path, 'inside');
  assert.equal(inside.kind, 'Text');
  assert.equal(inside.text, 'r\n');

  // One into `.git` is refused, though the path as written is not `.git/…`.
  write(dir, '.git/config', '[remote]\n');
  assert.ok(symlink(path.join(dir, '.git', 'config'), path.join(dir, 'gitcfg')));
  const git = projectFileRead(dir, 'gitcfg');
  assert.deepEqual([git.kind, git.text], ['Outside', null]);
});

test('invalid UTF-8 text is shown lossily', () => {
  const dir = makeTestDir('latin1');
  write(dir, 'l1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const file = projectFileRead(dir, 'l1.txt');
  assert.equal(file.kind, 'Text');
  assert.equal(file.text, 'caf\uFFFD\n');
  assert.equal(file.size, 5);
});

test('is_binary sniffs only the first 8 KiB', () => {
  assert.equal(isBinary(Buffer.from([0x4d, 0x5a])), false);
  assert.equal(isBinary(Buffer.from([0x4d, 0x00])), true);
  const late = Buffer.alloc(BINARY_SNIFF_BYTES + 8, 0x61);
  late[BINARY_SNIFF_BYTES + 4] = 0;
  assert.equal(isBinary(late), false);
  const early = Buffer.alloc(4, 0x61);
  early[2] = 0;
  assert.equal(isBinary(early), true);
  assert.equal(isBinary(Buffer.alloc(0)), false);
});