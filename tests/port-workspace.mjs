/* Port parity tests for electron/backend/workspace.js.

   Mirrors src-tauri/src/workspace.rs (accept / reject / path validation /
   discovery) and the `stop_git_watch` no-op, with real repositories built by
   the `git` binary (fixture setup only; the module under test resolves and
   spawns `git` itself).

     node tests/port-workspace.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/workspace.js';

const {
  workspaceAccept,
  workspaceReject,
  stopGitWatch,
  accept,
  reject,
  discover,
  validatePathText,
  validateRelativePath,
  weaklyCanonicalize,
  resolveFileTarget,
  gitSearchDirs,
  resolveGit,
} = backend;

const scratch = [];
let counter = 0;

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function tempDir(tag) {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-workspace-${tag}-${process.pid}-${counter}-`));
  scratch.push(dir);
  return dir;
}

function runGit(cwd, args, env) {
  const out = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(
    out.status,
    0,
    `git ${args.join(' ')} failed in ${cwd}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`,
  );
  return out.stdout;
}

/** A real throwaway repo with one committed file — like `init_repo`. */
function initRepo(tag = 'repo') {
  const dir = tempDir(tag);
  runGit(dir, ['init', '-q']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'base content\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function cachedNames(dir) {
  return runGit(dir, ['diff', '--cached', '--name-only']).split('\n').filter((line) => line !== '');
}

function worktreeNames(dir) {
  return runGit(dir, ['diff', '--name-only']).split('\n').filter((line) => line !== '');
}

// ── path validation (workspace::validate_path_text) ─────────────────────────

test('validate_path_text rejects the same shapes as Rust', () => {
  assert.throws(() => validatePathText(''), /path must not be empty/);
  assert.throws(() => validatePathText('/etc/passwd'), /path must not be absolute/);
  assert.throws(() => validatePathText('\\\\server\\share\\x'), /path must not be absolute/);
  assert.throws(() => validatePathText('//server/share/x'), /path must not be absolute/);
  assert.throws(() => validatePathText('C:\\Windows\\x'), /path must not be a drive-letter path/);
  assert.throws(() => validatePathText('src/../../etc/passwd'), /path must not contain '\.\.' or empty components/);
  assert.throws(() => validatePathText('src//a.txt'), /path must not contain '\.\.' or empty components/);
  assert.throws(() => validatePathText('src/.git/config'), /path must not reference the \.git directory/);
  assert.throws(() => validatePathText('.GIT/HEAD'), /path must not reference the \.git directory/);
  // Accepted shapes come back unchanged on POSIX.
  assert.equal(validatePathText('src/a.txt'), 'src/a.txt');
  assert.equal(validatePathText('..foo/a.txt'), '..foo/a.txt');
  assert.equal(validatePathText('.gitignore'), '.gitignore');
});

test('validate_relative_path keeps the final component unresolved', () => {
  const dir = initRepo('symlink');
  const outside = tempDir('outside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  fs.symlinkSync(outside, path.join(dir, 'escape'));

  // A symlinked parent directory resolves outside the work tree.
  assert.throws(
    () => validateRelativePath(dir, 'escape/secret.txt'),
    /path escapes repository root/,
  );
  // A symlinked *file* is the tracked entry itself and stays valid.
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'tracked-link'));
  const target = validateRelativePath(dir, 'tracked-link');
  assert.equal(target.rel, 'tracked-link');
  assert.equal(target.abs, path.join(fs.realpathSync(dir), 'tracked-link'));
});

test('weakly_canonicalize re-appends a non-existent tail', () => {
  const dir = initRepo('weak');
  const resolved = weaklyCanonicalize(path.join(dir, 'missing', 'deeper', 'file.txt'));
  assert.equal(resolved, path.join(fs.realpathSync(dir), 'missing', 'deeper', 'file.txt'));
});

// ── discovery (workspace::discover) ─────────────────────────────────────────

test('discover finds the work-tree root, including from a subdirectory', () => {
  const dir = initRepo('discover');
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  assert.equal(discover(dir), fs.realpathSync(dir));
  assert.equal(discover(path.join(dir, 'src', 'nested', '.')), fs.realpathSync(dir));
});

test('discover fails like Rust outside a repository and inside a bare one', () => {
  const plain = tempDir('nonrepo');
  assert.throws(
    () => discover(plain),
    /^Error: not a git repository: Did not find a git repository in '.*' or in any of its parents$/,
  );
  assert.throws(() => discover(path.join(plain, 'does-not-exist')), /^Error: not a git repository: /);

  const bare = tempDir('bare');
  runGit(bare, ['init', '-q', '--bare']);
  assert.throws(() => discover(bare), /repository has no working tree/);
});

// ── accept ──────────────────────────────────────────────────────────────────

test('accept stages a modified file', async () => {
  const dir = initRepo('accept');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'changed\n');

  assert.equal(await accept(dir, 'committed.txt'), null);
  assert.deepEqual(cachedNames(dir), ['committed.txt']);
  assert.deepEqual(worktreeNames(dir), []);
  assert.equal(await workspaceAccept(dir, 'committed.txt'), null);
});

test('accept resolves the work tree when given a subdirectory', async () => {
  const dir = initRepo('accept-sub');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'one\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'sub']);
  fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'two\n');

  // `path` only locates the repository: `relPath` stays work-tree-relative,
  // exactly like `workspace::resolve_file_target`.
  await accept(path.join(dir, 'sub'), 'sub/f.txt');
  assert.deepEqual(cachedNames(dir), ['sub/f.txt']);

  // Not rebased against the subdirectory the caller passed.
  await assert.rejects(
    accept(path.join(dir, 'sub'), 'f.txt'),
    /^Error: git add failed: .*f\.txt/,
  );
});

test('accept treats a path as data, never a pathspec expression', async () => {
  const dir = initRepo('literal');
  fs.writeFileSync(path.join(dir, 'star*.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'b\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'glob fixtures']);
  fs.writeFileSync(path.join(dir, 'star*.txt'), 'a changed\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'b changed\n');

  await accept(dir, 'star*.txt');
  assert.deepEqual(cachedNames(dir), ['star*.txt']);
});

test('accept refuses traversal, .git paths and directories', async () => {
  const dir = initRepo('accept-refuse');
  fs.mkdirSync(path.join(dir, 'sub'));

  await assert.rejects(accept(dir, '../outside.txt'), /path must not contain '\.\.'/);
  await assert.rejects(accept(dir, '.git/config'), /path must not reference the \.git directory/);
  await assert.rejects(accept(dir, 'sub'), /sub is a directory, not a file/);
  assert.deepEqual(cachedNames(dir), []);
});

// ── reject ──────────────────────────────────────────────────────────────────

test('reject restores a tracked file from HEAD', async () => {
  const dir = initRepo('reject-tracked');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'changed\n');

  assert.equal(await reject(dir, 'committed.txt'), null);
  assert.equal(fs.readFileSync(path.join(dir, 'committed.txt'), 'utf8'), 'base content\n');
  assert.deepEqual(cachedNames(dir), []);
});

test('reject recreates a tracked file deleted from the work tree', async () => {
  const dir = initRepo('reject-deleted');
  fs.rmSync(path.join(dir, 'committed.txt'));

  await reject(dir, 'committed.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'committed.txt'), 'utf8'), 'base content\n');
});

test('reject deletes an untracked file', async () => {
  const dir = initRepo('reject-untracked');
  const target = path.join(dir, 'new.txt');
  fs.writeFileSync(target, 'brand new\n');

  assert.equal(await workspaceReject(dir, 'new.txt'), null);
  assert.equal(fs.existsSync(target), false);
});

test('reject deletes a staged-but-never-committed file', async () => {
  const dir = initRepo('reject-staged');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
  runGit(dir, ['add', '--', 'new.txt']);

  await reject(dir, 'new.txt');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  assert.deepEqual(cachedNames(dir), []);
});

test('reject restores a rename source instead of deleting the content', async () => {
  const dir = initRepo('reject-rename');
  fs.renameSync(path.join(dir, 'committed.txt'), path.join(dir, 'renamed.txt'));
  runGit(dir, ['add', '-A']);

  assert.equal(await reject(dir, 'renamed.txt'), null);
  assert.equal(fs.readFileSync(path.join(dir, 'committed.txt'), 'utf8'), 'base content\n');
  assert.equal(fs.existsSync(path.join(dir, 'renamed.txt')), false);
  assert.deepEqual(cachedNames(dir), []);
});

test('reject on an untracked symlink removes the link, never its target', async () => {
  const dir = initRepo('reject-symlink');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b uncommitted change\n');
  fs.symlinkSync('b.txt', path.join(dir, 'link_a'));

  await reject(dir, 'link_a');
  assert.throws(() => fs.lstatSync(path.join(dir, 'link_a')), /ENOENT/);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b uncommitted change\n');
});

test('reject treats a glob-metacharacter path literally', async () => {
  const dir = initRepo('reject-literal');
  fs.writeFileSync(path.join(dir, 'a?.txt'), 'a base\n');
  fs.writeFileSync(path.join(dir, 'ab.txt'), 'ab base\n');
  runGit(dir, ['add', 'a?.txt', 'ab.txt']);
  runGit(dir, ['commit', '-q', '-m', 'add a? and ab']);
  fs.writeFileSync(path.join(dir, 'a?.txt'), 'a changed\n');
  fs.writeFileSync(path.join(dir, 'ab.txt'), 'ab changed\n');

  await reject(dir, 'a?.txt');
  // Without `--literal-pathspecs`, "a?.txt" would also match "ab.txt".
  assert.equal(fs.readFileSync(path.join(dir, 'a?.txt'), 'utf8'), 'a base\n');
  assert.equal(fs.readFileSync(path.join(dir, 'ab.txt'), 'utf8'), 'ab changed\n');
});

// ── git resolution + error surfacing ────────────────────────────────────────

test('git resolves to an absolute binary ahead of the inherited PATH', () => {
  const found = resolveGit();
  assert.ok(path.isAbsolute(found.binary));
  assert.ok(fs.existsSync(found.binary));
  assert.equal(found.path, gitSearchDirs().join(path.delimiter));

  const head = gitSearchDirs()[0];
  assert.ok(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].includes(head));
});

test('a missing git is a clear error, not a silent success', async () => {
  const dir = initRepo('no-git');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'changed\n');
  const message =
    'git was not found in any absolute PATH folder (relative entries are ignored). ' +
    'Make sure git is installed and on PATH.';

  assert.throws(() => resolveGit([]), (error) => error.message === message);
  await assert.rejects(
    accept(dir, 'committed.txt', { searchDirs: [] }),
    (error) => error.message === message,
  );
  await assert.rejects(
    reject(dir, 'committed.txt', { searchDirs: [] }),
    (error) => error.message === message,
  );
  // The refusal happened before any mutation.
  assert.equal(fs.readFileSync(path.join(dir, 'committed.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(cachedNames(dir), []);
});

test('discovery runs before git resolution, so a non-repo says so', async () => {
  const plain = tempDir('order');
  await assert.rejects(
    accept(plain, 'whatever.txt', { searchDirs: [] }),
    /not a git repository: /,
  );
});

test('a failing git subcommand surfaces its stderr under the Rust label', async () => {
  const dir = initRepo('failure');
  // A held index lock makes the mutating command fail for real; `add` needs
  // the index, so the label is the call-site one, not the probe.
  const lock = path.join(dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'changed\n');
  try {
    await assert.rejects(accept(dir, 'committed.txt'), (error) => {
      assert.match(error.message, /^git add failed: /);
      assert.match(error.message, /index\.lock/);
      return true;
    });
  } finally {
    fs.rmSync(lock, { force: true });
  }
  // The lock was the only obstacle.
  assert.deepEqual(cachedNames(dir), []);
  await accept(dir, 'committed.txt');
  assert.deepEqual(cachedNames(dir), ['committed.txt']);
});

// ── resolve_file_target ordering ────────────────────────────────────────────

test('resolve_file_target applies discovery, validation, then the directory check', () => {
  const dir = initRepo('order-target');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(resolveFileTarget(dir, 'committed.txt').rel, 'committed.txt');
  assert.throws(() => resolveFileTarget(dir, ''), /path must not be empty/);
  assert.throws(() => resolveFileTarget(dir, 'sub'), /sub is a directory, not a file/);
  assert.throws(() => resolveFileTarget(tempDir('order-plain'), 'a.txt'), /not a git repository: /);
});

// ── watcher teardown ────────────────────────────────────────────────────────

test('stop_git_watch is an explicit null no-op', () => {
  assert.equal(stopGitWatch(), null);
  assert.equal(stopGitWatch({ sessionId: 'anything' }), null);
});