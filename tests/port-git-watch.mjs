/* Port parity tests for electron/backend/git-watch.js.

   Mirrors src-tauri/src/git_watcher.rs (the per-session `.git/HEAD` watcher)
   with repositories and linked worktrees built by the real `git` binary in
   temp dirs (setup only — the code under test never runs git):

     node tests/port-git-watch.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/git-watch.js';

const { createGitWatch, locateGitHead, SETTLE_MS } = backend;

const scratch = [];

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-git-watch-'));
  scratch.push(dir);
  return dir;
}

function git(cwd, args) {
  const out = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      // macOS' osxkeychain helper cannot prompt in this environment; nothing
      // here talks to a remote, but keep git from reaching for it anyway.
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  assert.equal(out.status, 0, `git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout;
}

function makeRepo() {
  const dir = tmp();
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'port@example.com']);
  git(dir, ['config', 'user.name', 'Port']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function counter() {
  const state = { count: 0 };
  return { state, onChange: () => { state.count += 1; } };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longer than any debounced call could still be in flight. */
const QUIET = SETTLE_MS * 8;

async function waitFor(predicate, what, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ── discovery (git.rs::probe) ───────────────────────────────────────────────

test('discovery finds .git and returns <git dir>/HEAD', () => {
  const repo = makeRepo();
  assert.deepEqual(locateGitHead(repo), {
    gitDir: path.join(repo, '.git'),
    headPath: path.join(repo, '.git', 'HEAD'),
  });

  // Rust's `discover` accepts any depth inside the working tree.
  const nested = path.join(repo, 'pkg', 'src');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(locateGitHead(nested).headPath, path.join(repo, '.git', 'HEAD'));
});

test('discovery of a non-repository is null', () => {
  const plain = tmp();
  assert.equal(locateGitHead(plain), null);
  assert.equal(locateGitHead(path.join(plain, 'missing', 'deeper')), null);
});

// ── behaviour ───────────────────────────────────────────────────────────────

test('branch switch fires onChange exactly once', async () => {
  const repo = makeRepo();
  const { state, onChange } = counter();
  const watch = createGitWatch(repo, onChange);
  try {
    await delay(QUIET);
    assert.equal(state.count, 0, 'arming the watch must not fire');

    git(repo, ['checkout', '-q', '-b', 'x']);
    await waitFor(() => state.count === 1, 'the checkout event');
    await delay(QUIET);
    assert.equal(state.count, 1, 'one HEAD change, one fire');

    // A second distinct HEAD change fires again — the watcher is not a latch.
    git(repo, ['checkout', '-q', '-b', 'y']);
    await waitFor(() => state.count === 2, 'the second checkout event');
    await delay(QUIET);
    assert.equal(state.count, 2);
  } finally {
    watch.close();
  }
});

test('unrelated .git writes never fire', async () => {
  const repo = makeRepo();
  const { state, onChange } = counter();
  const watch = createGitWatch(repo, onChange);
  try {
    const gitDir = path.join(repo, '.git');
    fs.writeFileSync(path.join(gitDir, 'omp-unrelated'), 'x');
    fs.appendFileSync(path.join(gitDir, 'config'), '\n# port\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD.lock'), 'junk');
    fs.rmSync(path.join(gitDir, 'HEAD.lock'));
    // Real git traffic that is not a branch change: index refresh + a commit
    // on the current branch leaves HEAD byte-identical.
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-q', '-m', 'second']);

    await delay(QUIET);
    assert.equal(state.count, 0);
  } finally {
    watch.close();
  }
});

test('a direct HEAD write fires once; an identical rewrite does not', async () => {
  const repo = makeRepo();
  const headPath = path.join(repo, '.git', 'HEAD');
  const { state, onChange } = counter();
  const watch = createGitWatch(repo, onChange);
  try {
    fs.writeFileSync(headPath, 'ref: refs/heads/direct\n');
    await waitFor(() => state.count === 1, 'the direct write');
    await delay(QUIET);
    assert.equal(state.count, 1);

    // Rewriting the same value is not a HEAD change (the content check is
    // what collapses duplicate OS events too).
    fs.writeFileSync(headPath, fs.readFileSync(headPath));
    await delay(QUIET);
    assert.equal(state.count, 1);
  } finally {
    watch.close();
  }
});

test('close() stops further fires and is idempotent', async () => {
  const repo = makeRepo();
  const { state, onChange } = counter();
  const watch = createGitWatch(repo, onChange);

  git(repo, ['checkout', '-q', '-b', 'first']);
  await waitFor(() => state.count === 1, 'the pre-close event');

  watch.close();
  watch.close();

  git(repo, ['checkout', '-q', '-b', 'second']);
  await delay(QUIET);
  assert.equal(state.count, 1);
});

test('close() cancels a pending debounced fire', async () => {
  const repo = makeRepo();
  const { state, onChange } = counter();
  const watch = createGitWatch(repo, onChange);

  git(repo, ['checkout', '-q', '-b', 'pending']);
  watch.close();
  await delay(QUIET);
  assert.equal(state.count, 0);
});

test('non-repo path yields a silent no-op watch', async () => {
  const plain = tmp();
  // A file named HEAD outside git is not a HEAD, and creating one must not
  // fabricate a repo.
  fs.writeFileSync(path.join(plain, 'HEAD'), 'ref: refs/heads/nope\n');
  const { state, onChange } = counter();

  const watch = createGitWatch(plain, onChange);
  assert.equal(typeof watch.close, 'function');
  fs.writeFileSync(path.join(plain, 'HEAD'), 'ref: refs/heads/other\n');
  fs.mkdirSync(path.join(plain, 'sub'));
  await delay(QUIET);
  watch.close();
  watch.close();
  assert.equal(state.count, 0);

  // A path that does not exist at all: still a no-op, never a throw.
  const missing = createGitWatch(path.join(plain, 'missing', 'deeper'), onChange);
  missing.close();
  assert.equal(state.count, 0);
});

test('linked worktree watches its own git dir HEAD', async () => {
  const repo = makeRepo();
  const holder = tmp();
  const worktree = path.join(holder, 'wt');
  git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', worktree]);

  // `repo.git_dir()` for a linked worktree is `…/.git/worktrees/<name>`.
  const located = locateGitHead(worktree);
  assert.equal(
    fs.realpathSync(located.headPath),
    fs.realpathSync(path.join(repo, '.git', 'worktrees', 'wt', 'HEAD')),
  );
  assert.notEqual(fs.realpathSync(located.headPath), fs.realpathSync(path.join(repo, '.git', 'HEAD')));

  const { state, onChange } = counter();
  const watch = createGitWatch(worktree, onChange);
  try {
    git(worktree, ['checkout', '-q', '-b', 'wt-next']);
    await waitFor(() => state.count === 1, 'the worktree checkout');
    await delay(QUIET);
    assert.equal(state.count, 1);
  } finally {
    watch.close();
  }
});

test('a project in a subdirectory watches the repository HEAD', async () => {
  const repo = makeRepo();
  const sub = path.join(repo, 'pkg');
  fs.mkdirSync(sub);
  const { state, onChange } = counter();
  const watch = createGitWatch(sub, onChange);
  try {
    git(sub, ['checkout', '-q', '-b', 'from-sub']);
    await waitFor(() => state.count === 1, 'the checkout seen from a subdirectory');
    await delay(QUIET);
    assert.equal(state.count, 1);
  } finally {
    watch.close();
  }
});