/* Port parity tests for electron/backend/widgets/{run,context}.js.

   Mirrors src-tauri/src/widgets/{run,context}.rs and their #[cfg(test)]
   cases, with REAL child processes (no timers standing in for a process) and
   fixture repositories built by the real `git` binary (setup only — the code
   under test never starts git).

     node tests/port-widgets-run.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import runBackend from '../electron/backend/widgets/run.js';
import contextBackend from '../electron/backend/widgets/context.js';
import { pidIsAlive } from '../electron/backend/browser-process.js';

const {
  runWidget,
  STDOUT_CAP_BYTES,
  STDERR_KEEP_BYTES,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clampTimeout,
} = runBackend;

const {
  gitContext,
  pluginContext,
  bounded,
  urlWithoutPassword,
  CONTEXT_FIELD_MAX_BYTES,
} = contextBackend;

const scratch = [];
let counter = 0;

function tmpDir(tag) {
  counter += 1;
  const dir = path.join(
    os.tmpdir(),
    `omp-port-widgets-${tag}-${process.pid}-${counter}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function runGit(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout;
}

/** Pids whose command line contains `marker` (`pgrep -f`). */
function pgrep(marker) {
  const out = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  if (out.status !== 0 || out.stdout.trim() === '') return [];
  return out.stdout.trim().split('\n').map(Number);
}

async function eventually(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readPids(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number);
}

// ── run.rs: happy path, stdin context, environment ─────────────────────────

test('happy_path_returns_stdout_stderr_and_exit', async () => {
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'echo hello; echo oops >&2; exit 0'],
    timeoutMs: 5000,
  });
  assert.equal(r.stdout, 'hello\n');
  assert.equal(r.stderr, 'oops\n');
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.overflowed, false);
  assert.equal(r.cancelled, false);
  assert.equal(r.error, null);
  assert.ok(Number.isInteger(r.durationMs));
});

test('stdin_carries_the_context_json_and_env_reaches_the_plugin', async () => {
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'cat; printf "\\n%s|%s" "$OMP_WIDGET_TRIGGER" "$OMP_WIDGET_PROJECT"'],
    context: {
      project: '/p',
      branch: 'main',
      remote: 'git@host:me/app.git',
      session: 's1',
      trigger: 'manual',
    },
    env: { OMP_WIDGET_TRIGGER: 'manual', OMP_WIDGET_PROJECT: '/p' },
    timeoutMs: 5000,
  });
  assert.equal(r.exitCode, 0, r.error || '');
  const [line, tail] = r.stdout.split('\n');
  assert.deepEqual(JSON.parse(line), {
    version: 1,
    project: '/p',
    branch: 'main',
    remote: 'git@host:me/app.git',
    session: 's1',
    trigger: 'manual',
  });
  // stdin was closed after the payload, so `cat` terminated by itself.
  assert.equal(tail, 'manual|/p');
});

test('a_plugin_that_ignores_stdin_still_terminates', async () => {
  const dir = tmpDir('stdin');
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'read ignored; echo done'],
    context: { project: dir, branch: '', remote: '', session: 's', trigger: 'manual' },
    timeoutMs: 5000,
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'done\n');
});

test('nonzero_exit_keeps_the_real_stderr', async () => {
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'echo \'{"version":1}\'; echo boom >&2; exit 3'],
    timeoutMs: 5000,
  });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, '{"version":1}\n');
  assert.equal(r.stderr, 'boom\n');
  assert.equal(r.error, null); // error text is the host's, this layer reports facts
});

test('missing_executable_reports_a_spawn_error', async () => {
  const r = await runWidget({
    scriptPath: '/nonexistent/omp-widget-does-not-exist-9f3a',
    timeoutMs: 5000,
  });
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, false);
  assert.match(r.error, /^could not start \/nonexistent\/omp-widget-does-not-exist-9f3a: /);
});

// ── run.rs: timeout kills the whole tree (child and grandchild) ────────────

test('timeout_kills_the_tree_and_reports_timed_out', async () => {
  const dir = tmpDir('timeout');
  const pidfile = path.join(dir, 'pids');
  const marker = `omp-widget-gc-${process.pid}-${Date.now()}`;
  // `wait` keeps the direct child alive; the background shell is a
  // grandchild in the same process group (and has no `exec` optimisation
  // because it is compound).
  const script = [
    'echo $$ > "$1"',
    `sh -c 'sleep 30; :' '${marker}' &`,
    'echo $! >> "$1"',
    'wait',
  ].join('\n');

  const started = Date.now();
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', script, 'sh', pidfile],
    timeoutMs: 1000,
  });
  const elapsed = Date.now() - started;

  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.equal(r.error, 'timed out after 1000 ms');
  assert.ok(elapsed < 5000, `must not wait for sleep (${elapsed} ms)`);

  const pids = readPids(pidfile);
  assert.equal(pids.length, 2, 'the script recorded the child and grandchild pids');
  await eventually(() => pids.every((pid) => !pidIsAlive(pid)));
  assert.deepEqual(pids.filter((pid) => pidIsAlive(pid)), [], 'child and grandchild must die');
  await eventually(() => pgrep(marker).length === 0);
  assert.deepEqual(pgrep(marker), [], 'pgrep must find no process left in the run');
});

test('abort_signal_kills_the_tree', async () => {
  const dir = tmpDir('abort');
  const pidfile = path.join(dir, 'pids');
  const marker = `omp-widget-abort-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: [
      '-c',
      `sh -c 'sleep 30; :' '${marker}' & echo $$ > "${pidfile}"; echo $! >> "${pidfile}"; wait`,
    ],
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  clearTimeout(timer);
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(pgrep(marker), []);
});

test('a_background_holder_of_stdout_does_not_stall_the_result', async () => {
  const marker = `omp-widget-bg-${process.pid}-${Date.now()}`;
  const started = Date.now();
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', `sh -c 'sleep 30; :' '${marker}' & echo '{}'`],
    timeoutMs: 5000,
  });
  const elapsed = Date.now() - started;
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '{}\n');
  assert.equal(r.timedOut, false);
  assert.ok(elapsed < 4000, `must not wait for the background child (${elapsed} ms)`);
  await eventually(() => pgrep(marker).length === 0);
  assert.deepEqual(pgrep(marker), []);
});

// ── run.rs: caps ───────────────────────────────────────────────────────────

test('default_stdout_cap_keeps_the_head_and_reports_overflow', async () => {
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'yes 0123456789abcdef | head -c 400000'],
    timeoutMs: 5000,
  });
  assert.equal(Buffer.byteLength(r.stdout), STDOUT_CAP_BYTES);
  assert.equal(r.overflowed, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.error, 'stdout exceeds 256 KiB');
  assert.ok(r.stdout.startsWith('0123456789abcdef'));
});

test('a_custom_stdout_cap_is_applied_exactly', async () => {
  const over = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'printf abcdefghijklmnop'],
    stdoutCap: 10,
    timeoutMs: 5000,
  });
  assert.equal(over.stdout, 'abcdefghij');
  assert.equal(over.overflowed, true);
  assert.equal(over.error, 'stdout exceeds 10 bytes');

  const exact = await runWidget({
    scriptPath: '/bin/sh',
    args: ['-c', 'printf abcdefghij'],
    stdoutCap: 10,
    timeoutMs: 5000,
  });
  assert.equal(exact.stdout, 'abcdefghij');
  assert.equal(exact.overflowed, false);
  assert.equal(exact.exitCode, 0);
});

test('stderr_keeps_the_tail_not_the_head', async () => {
  const r = await runWidget({
    scriptPath: '/bin/sh',
    args: [
      '-c',
      'yes log | head -c 200000 >&2; printf FINAL-MARKER >&2; exit 2',
    ],
    stderrCap: 1024,
    timeoutMs: 5000,
  });
  assert.equal(r.exitCode, 2);
  assert.ok(Buffer.byteLength(r.stderr) <= 1024, `${Buffer.byteLength(r.stderr)} bytes`);
  assert.ok(r.stderr.endsWith('FINAL-MARKER'), JSON.stringify(r.stderr.slice(-40)));
  assert.equal(STDERR_KEEP_BYTES, 64 * 1024);
});

// ── run.rs: argument checks ────────────────────────────────────────────────

test('run_widget_rejects_a_missing_script_path', async () => {
  await assert.rejects(() => runWidget({}), TypeError);
  await assert.rejects(() => runWidget({ scriptPath: '' }), TypeError);
});

test('timeout_clamp_matches_config_rs', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
  assert.equal(MIN_TIMEOUT_MS, 1000);
  assert.equal(MAX_TIMEOUT_MS, 60_000);
  assert.equal(clampTimeout(undefined), 10_000);
  assert.equal(clampTimeout(5), 1000);
  assert.equal(clampTimeout(99_999), 60_000);
});

// ── context.rs: the repository read and the bounded payload ────────────────

function initRepo(tag, remoteUrl) {
  const dir = tmpDir(tag);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'first']);
  runGit(dir, ['remote', 'add', 'origin', remoteUrl]);
  return dir;
}

test('no_project_and_non_repo_yield_the_empty_context', async () => {
  assert.deepEqual(await gitContext(''), {
    project: '',
    branch: '',
    remote: '',
    dirty: null,
  });
  assert.deepEqual(await gitContext(undefined), {
    project: '',
    branch: '',
    remote: '',
    dirty: null,
  });
  const plain = tmpDir('plain');
  assert.deepEqual(await gitContext(plain), {
    project: plain,
    branch: '',
    remote: '',
    dirty: null,
  });
});

test('git_context_matches_git_status_and_branch', async () => {
  const repo = initRepo('ctx', 'https://user:secret@example.com/me/app.git');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');

  const ctx = await gitContext(repo);
  const branch = runGit(repo, ['branch', '--show-current']).trim();
  const dirty = runGit(repo, ['status', '--porcelain'])
    .trim()
    .split('\n')
    .filter(Boolean).length;
  const remote = runGit(repo, ['remote', 'get-url', 'origin']).trim();

  assert.equal(ctx.project, repo);
  assert.equal(ctx.branch, branch);
  assert.equal(ctx.branch, 'main');
  assert.equal(ctx.dirty, dirty);
  assert.equal(ctx.dirty, 2);
  assert.equal(ctx.remote, remote.replace('user:secret@', 'user@'));
  assert.equal(ctx.remote, 'https://user@example.com/me/app.git');
});

test('git_context_discoveries_from_a_subdirectory_and_a_detached_head', async () => {
  const repo = initRepo('sub', 'git@host:me/app.git');
  const sub = path.join(repo, 'nested');
  fs.mkdirSync(sub);
  const nested = await gitContext(sub);
  assert.equal(nested.project, sub);
  assert.equal(nested.branch, 'main');
  assert.equal(nested.remote, 'git@host:me/app.git');

  runGit(repo, ['checkout', '--detach', 'HEAD']);
  const detached = await gitContext(repo);
  assert.equal(detached.branch, '');
  assert.equal(detached.remote, 'git@host:me/app.git'); // falls back to origin
  assert.equal(runGit(repo, ['branch', '--show-current']).trim(), '');
});

test('the_branch_remote_wins_over_origin', async () => {
  const repo = initRepo('remote', 'https://origin.example/x.git');
  runGit(repo, ['remote', 'add', 'backup', 'ssh://git@backup.example/x.git']);
  runGit(repo, ['config', 'branch.main.remote', 'backup']);
  const ctx = await gitContext(repo);
  assert.equal(ctx.remote, 'ssh://git@backup.example/x.git');
});

test('url_without_password_matches_the_documented_rewrite', () => {
  assert.equal(
    urlWithoutPassword('https://x-access-token:secret@host/me/app.git'),
    'https://x-access-token@host/me/app.git',
  );
  assert.equal(urlWithoutPassword('https://user@host/x'), 'https://user@host/x');
  assert.equal(urlWithoutPassword('git@host:me/app.git'), 'git@host:me/app.git');
  assert.equal(urlWithoutPassword('ssh://git@host/x'), 'ssh://git@host/x');
  assert.equal(urlWithoutPassword(''), '');
});

test('plugin_context_bounds_all_but_project', () => {
  const long = 'x'.repeat(100 * 1024);
  const ctx = pluginContext(
    { project: 'p'.repeat(3 * CONTEXT_FIELD_MAX_BYTES), branch: long, remote: long, dirty: 7 },
    long,
    'turn_end',
  );
  assert.equal(ctx.project.length, 3 * CONTEXT_FIELD_MAX_BYTES);
  assert.equal(Buffer.byteLength(ctx.branch), CONTEXT_FIELD_MAX_BYTES);
  assert.equal(Buffer.byteLength(ctx.remote), CONTEXT_FIELD_MAX_BYTES);
  assert.equal(Buffer.byteLength(ctx.session), CONTEXT_FIELD_MAX_BYTES);
  assert.equal(ctx.trigger, 'turn_end');
  assert.equal('dirty' in ctx, false, 'extensions never reach the plugin payload');
});

test('bounding_cuts_on_a_character_boundary', () => {
  assert.equal(bounded('short'), 'short');
  const multi = 'a' + '€'.repeat(1000); // 1 + 3000 bytes
  const cut = bounded(multi);
  assert.ok(Buffer.byteLength(cut) <= CONTEXT_FIELD_MAX_BYTES);
  assert.equal(cut.includes('\uFFFD'), false);
  assert.ok(cut.endsWith('€'));
  assert.equal(cut, multi.slice(0, cut.length));
});