'use strict';

/* Widget plugin runner: the Node port of `src-tauri/src/widgets/run.rs`.

   One widget plugin is ONE process:

     runWidget({scriptPath, args, env, cwd, timeoutMs, stdoutCap, stderrCap,
                context, signal})
       → {stdout, stderr, exitCode, signal, timedOut, overflowed, cancelled,
          error, durationMs}

   `scriptPath` is the argv[0] the approval check produced — normally the
   verified copy under `widget-runs/store/<fingerprint>/`, never the checked
   script's own path (that replacement is the approval/snapshot slice's job,
   see `snapshot.rs`). `args` are the remaining argv entries.

   ## Process group

   The child is spawned `detached` on POSIX, so it leads its own session and
   pid == pgid (the same model as `ProcessSupervisor::prepare` /
   `process_group(0)`, and as `browser-process.js`). A `sh -c 'sleep 30 & …'`
   plugin therefore leaves a grandchild in the group, and the timeout/cap kill
   takes the whole group down. `killGroupIfLeader` confirms the pid leads the
   group; after the leader has been reaped that check can no longer see the
   group (`getpgid` on a dead pid fails), so the group id recorded at spawn is
   signalled directly in that case. Windows has no process-group kill in Node:
   `taskkill /T /F` walks the tree instead (the Rust Job Object has no Node
   equivalent).

   ## Caps (exact Rust `child.rs` semantics)

   - stdout keeps the HEAD of the stream, at most `stdoutCap` bytes (default
     `STDOUT_CAP_BYTES` = 256 KiB). The byte that would exceed the cap raises
     `overflowed`, stops buffering and kills the tree — Rust's reader stops and
     raises the shared flag the wait loop polls.
   - stderr keeps a rolling TAIL of at most `stderrCap` bytes (default
     `STDERR_KEEP_BYTES` = 64 KiB); the rest is drained and dropped, so a
     verbose plugin never blocks on a full pipe.

   ## Exit and draining

   The plugin's own exit is the outcome: the tree is killed at once (a
   background child still holding stdout would otherwise stall the result
   until the deadline), then the pipes get `DRAIN_GRACE_MS` to deliver the
   bytes that were already written. Bytes in a pipe survive the writer, so a
   plugin that finishes at its deadline is reported by its real exit, not as a
   timeout. A descendant that escaped the group (`setsid`) can only delay the
   result by the grace, never past it: the streams are destroyed afterwards.

   ## Refusal paths

   The Rust runner returns `Ok` only for JSON stdout. This module is the
   process layer below that: it never parses stdout (`require_json` and the
   redacted error text belong to the host). It does report the refusal facts
   the host needs, with the same wording:

     error = "timed out after <n> ms"    (timedOut: true)
     error = "stdout exceeds <n> KiB"   (overflowed: true, stdout cut at cap)
     error = "could not start <path>: <os error>"
     error = null                        (the plugin ran and exited)

   A non-zero `exitCode`, a `signal`, or `timedOut` is never hidden.
*/

const { spawn, spawnSync } = require('node:child_process');

const { pidIsAlive, killGroupIfLeader } = require('../browser-process');

/** `run.rs::STDOUT_CAP_BYTES`: stdout is cut at 256 KiB. */
const STDOUT_CAP_BYTES = 256 * 1024;
/** `run.rs::STDERR_KEEP_BYTES`: only this much stderr is kept (rolling tail). */
const STDERR_KEEP_BYTES = 64 * 1024;
/** `run.rs::DRAIN_GRACE`: how long the pipes may still deliver after the exit. */
const DRAIN_GRACE_MS = 200;
/** How long a killed child gets to report its exit before the wait gives up. */
const KILL_GRACE_MS = 2000;
/** `config.rs` default and clamp for `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

function clampTimeout(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

function capValue(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Kill the process tree under `pid`.
 *
 * The group id is the pid because the child was spawned `detached` (a new
 * session/group, pgid == pid). `killGroupIfLeader` is the normal path and the
 * one that keeps us from ever signalling a group we do not lead; it needs a
 * live leader to read the pgid, so once the leader exited (its background
 * children still hold the group) the recorded id is killed directly.
 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // No taskkill: the direct `child.kill` in the caller is the fallback.
    }
    return;
  }
  if (killGroupIfLeader(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone (normal exit, empty group).
  }
}

/** Wording of `run.rs::cap_error`. */
function capError(cap) {
  return cap % 1024 === 0
    ? `stdout exceeds ${cap / 1024} KiB`
    : `stdout exceeds ${cap} bytes`;
}

/**
 * Run one widget plugin.
 *
 * @param {object} options
 * @param {string} options.scriptPath argv[0]: the command, normally the
 *   verified copy from the approval store.
 * @param {string[]} [options.args] the remaining argv entries.
 * @param {object} [options.env] variables added on top of the inherited
 *   environment (Rust inherits the whole environment, then sets the
 *   `OMP_WIDGET_*` ones).
 * @param {string} [options.cwd] working directory (the plugin's project);
 *   omitted means the app's own cwd.
 * @param {number} [options.timeoutMs] wall clock, default 10000, clamped
 *   1000..60000 like `config.rs`.
 * @param {number} [options.stdoutCap] kept head bytes, default 256 KiB.
 * @param {number} [options.stderrCap] kept tail bytes, default 64 KiB.
 * @param {object} [options.context] the `PluginContext`; written to stdin as
 *   `{"version":1, …}` and then closed (a `cat`-style plugin terminates).
 * @param {AbortSignal} [options.signal] cancels the run and kills the tree.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null,
 *   signal: string|null, timedOut: boolean, overflowed: boolean,
 *   cancelled: boolean, error: string|null, durationMs: number}>}
 */
async function runWidget(options = {}) {
  const {
    scriptPath,
    args = [],
    env,
    cwd,
    timeoutMs,
    stdoutCap,
    stderrCap,
    context,
    signal,
  } = options || {};

  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new TypeError('runWidget: scriptPath must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new TypeError('runWidget: args must be an array');
  }

  const timeout = clampTimeout(timeoutMs);
  const outCap = capValue(stdoutCap, STDOUT_CAP_BYTES);
  const errCap = capValue(stderrCap, STDERR_KEEP_BYTES);

  // The Rust feeder serialises `{version:1, flatten(ctx)}` after the spawn; a
  // payload that cannot be encoded is a caller bug and fails the run, not a
  // half-started plugin.
  let payload = null;
  if (context !== undefined && context !== null) {
    if (typeof context !== 'object') {
      throw new TypeError('runWidget: context must be an object');
    }
    try {
      payload = JSON.stringify({ version: 1, ...context });
    } catch (error) {
      throw new Error(`could not encode context: ${error.message}`);
    }
  }

  const spawnEnv = env === undefined ? process.env : { ...process.env, ...env };
  for (const key of Object.keys(spawnEnv)) {
    if (spawnEnv[key] === undefined) delete spawnEnv[key];
  }

  const startedAt = Date.now();
  const child = spawn(scriptPath, args.map(String), {
    cwd: cwd === undefined || cwd === null || cwd === '' ? undefined : cwd,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own session/process group on POSIX (pgid == pid); Windows hides the
    // console instead and is killed through `taskkill /T`.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  let outChunks = [];
  let outLength = 0;
  let overflowed = false;
  let errChunks = [];
  let errLength = 0;
  let exitInfo = null;
  let spawnError = null;
  let killReason = null;

  let notifyKill = null;
  const killRequested = new Promise((resolve) => {
    notifyKill = resolve;
  });

  /** Kill the tree once; later kill requests are ignored. */
  const terminate = (reason) => {
    if (killReason !== null) return;
    killReason = reason;
    killTree(child.pid);
    if (pidIsAlive(child.pid)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    (notifyKill || (() => {}))();
  };

  // stdout: keep the head; the byte past the cap is the overflow.
  child.stdout.on('data', (chunk) => {
    if (overflowed) return; // reader stopped, like the Rust drain thread
    if (outLength + chunk.length > outCap) {
      const room = outCap - outLength;
      if (room > 0) outChunks.push(chunk.subarray(0, room));
      outLength = outCap;
      overflowed = true;
      terminate('overflow');
      return;
    }
    outChunks.push(chunk);
    outLength += chunk.length;
  });

  // stderr: rolling tail, the writer never blocks on a full pipe.
  child.stderr.on('data', (chunk) => {
    errChunks.push(chunk);
    errLength += chunk.length;
    while (errChunks.length > 1 && errLength - errChunks[0].length >= errCap) {
      errLength -= errChunks.shift().length;
    }
    if (errLength > errCap) {
      errChunks[0] = errChunks[0].subarray(errLength - errCap);
      errLength = errCap;
    }
  });

  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdin.on('error', () => {}); // EPIPE from a plugin that closed stdin
  try {
    child.stdin.end(payload === null ? undefined : payload);
  } catch {
    // The spawn error path reports the failure; stdin is unusable there.
  }

  let exitedResolve = null;
  let settled = false;
  const exited = new Promise((resolve) => {
    exitedResolve = resolve;
  });
  const settle = (info) => {
    if (settled) return;
    settled = true;
    if (info !== undefined) exitInfo = info;
    exitedResolve();
  };
  child.once('exit', (code, sig) => settle({ code, sig }));
  child.once('error', (error) => {
    spawnError = error;
    settle(null);
  });
  // 'close' fires after both pipes are closed: the drain is complete.
  const closed = new Promise((resolve) => child.once('close', resolve));

  const deadline = setTimeout(() => terminate('timeout'), timeout);

  let onAbort = null;
  if (signal) {
    onAbort = () => terminate('abort');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let killFallback = null;
  killRequested.then(() => {
    // SIGKILL cannot be ignored; the bound only covers a waitpid that never
    // reports (a broken pipe/child state) so the promise always settles.
    killFallback = setTimeout(() => settle(null), KILL_GRACE_MS);
  });

  await exited;
  clearTimeout(deadline);
  clearTimeout(killFallback);
  if (signal && onAbort) signal.removeEventListener('abort', onAbort);

  // The plugin is done: whatever it left behind dies now rather than when a
  // background holder of a pipe decides to read the deadline.
  killTree(child.pid);

  // Bytes already in the pipe survive the writer; give the drains the grace.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, DRAIN_GRACE_MS);
    closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  // A descendant that escaped the group (`setsid`) may still hold the read
  // ends; close them so neither this process nor the caller waits on it.
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream.destroy();
    } catch {
      // Already destroyed.
    }
  }
  try {
    child.stdin.destroy();
  } catch {
    // Already destroyed.
  }

  const stdout = Buffer.concat(outChunks, outLength).toString('utf8');
  const stderr = Buffer.concat(errChunks, errLength).toString('utf8');

  let error = null;
  if (spawnError) {
    error = `could not start ${scriptPath}: ${spawnError.message}`;
  } else if (killReason === 'timeout') {
    error = `timed out after ${timeout} ms`;
  } else if (killReason === 'overflow') {
    error = capError(outCap);
  }

  return {
    stdout,
    stderr,
    exitCode: exitInfo ? exitInfo.code : null,
    signal: exitInfo ? exitInfo.sig : null,
    timedOut: killReason === 'timeout',
    overflowed,
    cancelled: killReason === 'abort',
    error,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  runWidget,
  killTree,
  clampTimeout,
  STDOUT_CAP_BYTES,
  STDERR_KEEP_BYTES,
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};