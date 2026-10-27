/* electron/backend/terminal.js — Node port of `src-tauri/src/terminal/`
   (mod.rs, wire.rs, settings.rs, shell.rs, shells.rs, pty.rs, threads.rs,
   pump.rs, stream.rs, ring.rs, kill.rs).

   A real shell per tab on a pseudo-terminal, owned by the main process:

   - **Tabs, not shells.** `TerminalManager` keeps one entry per tab (session
     id), registered by `registerTab` with the tab's project folder and
     removed only by `closeTab`/`closeTabs`/`shutdownAll`. Its slot says
     whether the tab has no shell yet, one being spawned, or one (running or
     exited). Callers send ids and view state only: the manager picks the
     working directory (the tab's folder, else the home folder) and the shell
     (the `terminal.json` setting, else the platform default), so no path
     from the renderer reaches a spawn, and an id that is not a registered tab
     is refused.
   - **Events.** `terminal://data/<id>` `{ instance, seq, b64 }` and
     `terminal://exit/<id>` `{ instance, code }` (`code` null = signal death),
     emitted on the manager (an EventEmitter) under the exact Tauri event
     names the frontend subscribes to (`src/live.js`
     `onTerminalData`/`onTerminalExit`), so wiring
     `manager.on(channel, payload => webContents.send(channel, payload))` is a
     pure passthrough. The same chunk also fires the generic `data`/`exit`
     events with `{ tabId, channel, ...payload }`. `instance` numbers every
     shell this manager starts (one counter for all tabs, from 1); `seq`
     numbers every data event of one instance (from 1), so the webview drops
     stale events and fills gaps with `replay`.
   - **Threads → one event loop.** Rust runs a reader, waiter, writer and
     pump thread per shell. Node has no per-shell threads: node-pty delivers
     `data`/`exit` callbacks on the event loop, and this module's pump state
     machine gives them the same shape: ≤ `MAX_EVENT` bytes per event, ≥
     `MIN_INTERVAL_MS` apart, flow control at `HIGH_WATER` unacked bytes,
     ring-buffered before the event goes out.

   Parity deviations (deliberate; each replaces something Node cannot do):

   1. **Tree kill.** Rust kills `getsid(pid) == shell pid` after observing
      the exit *without reaping* (`waitid(WNOWAIT)`), so the pid — hence the
      session id — stays reserved while it signals the session. node-pty's
      native waiter reaps the shell (`waitpid`) before JS sees `exit`, so
      that reservation is impossible here. The Node equivalent used below:
      - while the leader is alive: `process.kill(-sid, signal)` (the shell is
        a session *and group* leader thanks to forkpty, so this is exactly
        Rust's `kill(-sid, …)`), then `/bin/ps -A -o pid= -o sess=` scans,
        killing every pid whose session is `sid`, up to `MAX_PASSES` times;
      - at a natural exit the leader is already reaped, so only the
        membership-validated per-pid passes run, and the leader's own pid is
        never signalled; the session id is forgotten at once afterwards.
      Residual risk (documented, not eliminated): a pid reissued as a *new*
      session leader within the same millisecond would make its children
      indistinguishable from ours. Rust's zombie hold exists to remove this
      window; node-pty's early reap makes it unavoidable in JS.
   2. **What a session look like.** macOS `ps` reports `sess` as the *audit*
      session (0 for a pty child of an app launched from a daemon) and
      `pgrep` has no `-s` here, so the Node scan finds a live terminal's
      session by the leader's process *group* plus the pty's controlling
      *tty* — enough to reach an interactive shell's background jobs, which
      get their own group but keep the tty. Known gap, macOS only: once the
      shell exits the pty hangs up and the kernel drops the tty association
      (`ps` shows `??`), so a job that had put itself in its own process
      group survives a *natural* exit (Rust kills it through `getsid`).
      `closeTab`/`closeTabs`/`shutdownAll` are unaffected (the leader is
      alive when the scan runs), and Linux uses the real session id either
      way.
   3. **Backpressure.** Rust's bounded 64-chunk reader queue blocks the
      reader. Here the pty's read stream is paused (`pty.pause()`, a
      `tty.ReadStream` pause) while a full `MAX_EVENT` frame waits or while
      the pump is stalled on unacked bytes, so the pty throttles the shell
      the same way.
   4. **Input queue.** `pty.write` never blocks (node-pty queues writes in
      its own writer), so Rust's `terminal input backlog` refusal for a full
      1024-write queue has no counterpart; `write` only fails when the shell
      is gone.
   5. `closeTab`/`closeTabs`/`shutdownAll` return a Promise that settles once
      the tree is dead (Rust blocks its `spawn_blocking` worker). Silence
      (`stream.closed`) is immediate, so the tab is already gone and no exit
      event follows.
   6. `terminal.json` writes are atomic (temp + rename) but take no
      cross-process advisory lock: Electron's main process is the only
      writer.
   7. On Windows the tree kill is `taskkill /T /F`; the child PATH keeps the
      inherited one (the registry re-read of `child_path.rs` is not ported).

   CommonJS; no Electron API is required, so the module is testable in plain
   Node (`tests/port-terminal.mjs`). */

'use strict';

const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

// ── constants (src-tauri/src/terminal/{ring,stream,pump,pty,kill}.rs) ───────

/** Byte budget of one terminal's output ring (`ring::RING_BYTES`). */
const RING_BYTES = 1024 * 1024;
/** Unacked bytes at which the pump stalls (`stream::HIGH_WATER`). */
const HIGH_WATER = 512 * 1024;
/** A stalled pump resumes once the unacked bytes are below this. */
const LOW_WATER = 128 * 1024;
/** Largest payload of one data event (`pump::MAX_EVENT`). */
const MAX_EVENT = 64 * 1024;
/** Minimum spacing between two events of one terminal (4 ms). */
const MIN_INTERVAL_MS = 4;
/** How long after the exit the reader may take to reach EOF. */
const READER_GRACE_MS = 250;
/** How long closing a terminal waits for the hung-up shell to exit. */
const HANGUP_GRACE_MS = 200;
/** How often that wait checks for the exit. */
const HANGUP_POLL_MS = 5;
/** Passes over the process table when killing a session (`kill::MAX_PASSES`). */
const MAX_PASSES = 8;
/** Shells that take `-l -i` (login, interactive), by file name. */
const LOGIN_SHELLS = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'nu'];
/** `LANG` given to a macOS shell when the app has no locale. */
const FALLBACK_LANG = 'en_US.UTF-8';
/** The pseudo console is `conpty` (there is no winpty backend). */
const CONPTY_BACKEND = 'conpty';

const isWindows = process.platform === 'win32';

// ── program settings (program_setting.rs, child_path.rs) ───────────────────

/**
 * A path setting as the user typed or pasted it: trimmed, and without one
 * pair of surrounding double quotes (Windows Explorer's "Copy as path" adds
 * them). Empty means "unset".
 */
function typedPath(input) {
  const trimmed = String(input ?? '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * An absolute path to an executable file: what a program setting must be, and
 * what a PATH search takes. Unix: one this user may execute
 * (`access(path, X_OK)`, as `execvp` checks it). Windows: any file.
 */
function isExecutableFile(candidate) {
  const p = typeof candidate === 'string' ? candidate : String(candidate);
  if (!p || !path.isAbsolute(p)) return false;
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (isWindows) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The inherited PATH plus the install dirs a Finder/Dock launch lacks. */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin', // Apple-silicon Homebrew
  '/opt/homebrew/sbin',
  '/usr/local/bin', // Intel Homebrew / manual installs
  '/usr/local/sbin',
];

/** `EXTRA_PATH_DIRS` plus the per-user dirs under `home` (child_path.rs). */
function launcherDirs(home) {
  const dirs = EXTRA_PATH_DIRS.slice();
  if (home) dirs.push(`${home}/.local/bin`, `${home}/.cargo/bin`);
  return dirs;
}

/** Windows paths compare case-insensitively, ignoring separator style. */
function pathKey(dir) {
  if (!isWindows) return dir;
  return dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * `current`'s entries, in order, followed by every entry of `extra` it
 * doesn't already hold (`child_path::merged_path`). Inherited entries always
 * come first, so a PATH set on purpose still wins.
 */
function mergedPath(current, extra) {
  const dirs = current ? current.split(path.delimiter).filter((d) => d.length > 0) : [];
  const seen = new Set(dirs.map(pathKey));
  for (const dir of extra) {
    if (!dir) continue;
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}

/**
 * The PATH a child is spawned with: `child_path::child_path()`. Windows keeps
 * the inherited PATH (the registry re-read is a deviation, see the header).
 */
function childPath(env = process.env) {
  if (isWindows) return env.PATH || env.Path || '';
  return mergedPath(env.PATH, launcherDirs(env.HOME));
}

/** The absolute folders of `childPath()`, in lookup order. */
function childPathDirs(env = process.env) {
  return childPath(env)
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir));
}

// ── what a terminal runs (shell.rs) ────────────────────────────────────────

/**
 * Whether the shell file `name` is one of `LOGIN_SHELLS`: the exact name on
 * unix; on Windows the stem of an `.exe`, ignoring case (`bash.exe` of Git for
 * Windows, `NU.EXE`).
 */
function takesLoginArgs(name, windows = isWindows) {
  if (!windows) return LOGIN_SHELLS.includes(name);
  const ext = path.win32.extname(name);
  if (ext.toLowerCase() !== '.exe') return false;
  const stem = path.win32.basename(name, ext).toLowerCase();
  return LOGIN_SHELLS.includes(stem);
}

/**
 * The shell an unset setting runs: `$SHELL` when it is executable, else the
 * account's login shell (`getpwuid` — `os.userInfo().shell` in Node), else
 * `/bin/sh`; on Windows `%ComSpec%`, else `cmd.exe`.
 *
 * The user database matters because `$SHELL` is not guaranteed in the app's
 * environment (a launch from a script, some GUI launch paths): falling
 * straight to `/bin/sh` there starts a different shell than the user's.
 */
function defaultShell(env = process.env) {
  const fromEnv = env.SHELL;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;
  if (!isWindows) {
    try {
      const shell = os.userInfo().shell;
      if (shell && isExecutableFile(shell)) return shell;
    } catch {
      // No user database entry: fall through to the POSIX default.
    }
    return '/bin/sh';
  }
  if (env.ComSpec) return env.ComSpec;
  return 'cmd.exe';
}

/**
 * A shell setting the user typed, already trimmed: an absolute path to an
 * executable file. An empty setting means "default" and is the caller's to
 * handle; here it is refused like any other non-path.
 */
function validateShell(candidate) {
  const p = typedPath(candidate);
  if (!p || !isExecutableFile(p)) {
    throw new Error(
      `terminal shell ${JSON.stringify(p)} is not an absolute path to an executable file`,
    );
  }
  return p;
}

/**
 * The shell to run and its arguments: the user's `preference` (absolute path
 * to an executable file; empty = unset), else `defaultShell()`. Only the
 * preference is an error — it was typed on purpose.
 */
function resolveShell(preference, defaultShellFn = defaultShell) {
  const typed = typedPath(preference);
  const program = typed === '' ? defaultShellFn() : validateShell(typed);
  const args = takesLoginArgs(path.basename(program)) ? ['-l', '-i'] : [];
  return { program, args };
}

/**
 * The `LANG` to give the shell when the app's environment has none of `LANG`,
 * `LC_ALL`, `LC_CTYPE`: `FALLBACK_LANG`. A macOS app started from Finder or
 * the Dock gets no locale, and a shell without one runs in the C locale.
 */
function fallbackLang(isSet) {
  const hasLocale = ['LANG', 'LC_ALL', 'LC_CTYPE'].some((key) => isSet(key));
  return hasLocale ? null : FALLBACK_LANG;
}

/**
 * The shell's environment on top of the app's own (`shell::apply_env`):
 * terminal type, the desktop markers, the extended PATH, `SHELL` = the program
 * actually started, and on macOS a fallback locale.
 */
function childEnv(program, sessionId, env = process.env) {
  const out = { ...env };
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.OMP_DESKTOP = '1';
  out.OMP_DESKTOP_SESSION = sessionId;
  if (!isWindows) out.SHELL = program;
  const childSearchPath = childPath(env);
  if (childSearchPath) out.PATH = childSearchPath;
  if (process.platform === 'darwin') {
    const lang = fallbackLang((key) => Boolean(env[key]));
    if (lang) out.LANG = lang;
  }
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || value === null) delete out[key];
  }
  return out;
}

// ── the installed shells menu (shells.rs) ──────────────────────────────────

/**
 * The installed shells the Settings menu offers, in the list's order: a
 * candidate is offered at the first place it is found as an executable file.
 * Unix: `sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `nu` on PATH. Windows:
 * `cmd`/`powershell` under `%SystemRoot%\System32`, `pwsh` in
 * `%ProgramFiles%\PowerShell\7` else on PATH, Git for Windows' `bin\bash.exe`
 * (never `System32\bash.exe`: the WSL launcher), `nu` on PATH.
 */
function availableShells(env = process.env, dirs = childPathDirs(env)) {
  const windowsCandidates = [
    { name: 'cmd', fixed: [['SystemRoot', path.win32.join('System32', 'cmd.exe')]], onPath: null },
    {
      name: 'powershell',
      fixed: [['SystemRoot', path.win32.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]],
      onPath: null,
    },
    {
      name: 'pwsh',
      fixed: [['ProgramFiles', path.win32.join('PowerShell', '7', 'pwsh.exe')]],
      onPath: 'pwsh.exe',
    },
    {
      name: 'bash',
      fixed: [
        ['ProgramFiles', path.win32.join('Git', 'bin', 'bash.exe')],
        ['LOCALAPPDATA', path.win32.join('Programs', 'Git', 'bin', 'bash.exe')],
      ],
      onPath: null,
    },
    { name: 'nu', fixed: [], onPath: 'nu.exe' },
  ];
  const candidates = isWindows
    ? windowsCandidates
    : LOGIN_SHELLS.map((name) => ({ name, fixed: [], onPath: name }));
  const found = [];
  for (const candidate of candidates) {
    const places = [];
    for (const [variable, relative] of candidate.fixed) {
      const root = env[variable];
      if (root) places.push(path.join(root, relative));
    }
    if (candidate.onPath) {
      for (const dir of dirs) places.push(path.join(dir, candidate.onPath));
    }
    const hit = places.find((candidatePath) => isExecutableFile(candidatePath));
    if (hit) found.push({ name: candidate.name, path: hit });
  }
  return found;
}

// ── what xterm.js's `windowsPty` wants (wire.rs) ───────────────────────────

/** The first Windows build with a pseudo console (Windows 10 1809). */
const CONPTY_MIN_BUILD = 17763;

/**
 * The pseudo console of this system: `null` off Windows, else the OS build
 * from `os.release()` (`10.0.22631` → 22631), `null` when unreadable.
 */
function windowsPty() {
  if (!isWindows) return null;
  const parts = os.release().split('.');
  const build = Number.parseInt(parts[2] ?? '', 10);
  if (!Number.isInteger(build)) return null;
  return { backend: CONPTY_BACKEND, buildNumber: build };
}

/**
 * Refuse to spawn on a Windows without a pseudo console: Rust's
 * `portable-pty` panics there, which aborts the app. An unreadable build
 * number is let through — there is nothing to judge by.
 */
function requireConpty(ptyInfo = windowsPty()) {
  if (ptyInfo && ptyInfo.buildNumber < CONPTY_MIN_BUILD) {
    throw new Error(
      `the terminal needs Windows 10 version 1809 (build ${CONPTY_MIN_BUILD}) or later; ` +
        `this is build ${ptyInfo.buildNumber}`,
    );
  }
}

// ── the output ring (ring.rs) ──────────────────────────────────────────────

/**
 * Emitted chunks by seq (1, 2, … per terminal), within a byte budget: whole
 * events, newest last, the oldest evicted as a unit, so a replay never starts
 * inside an escape sequence that one event split.
 */
class OutputRing {
  constructor(budget = RING_BYTES) {
    this.chunks = [];
    this.held = 0;
    this.budget = budget;
    /** The seq of the newest chunk pushed (0 before the first). */
    this.headSeq = 0;
    /** The seq of the newest chunk evicted (0 before the first eviction). */
    this.evictedSeq = 0;
  }

  /**
   * Append `chunk` under the next seq and return that seq, evicting the
   * oldest chunks beyond the budget. A chunk larger than the whole budget is
   * still kept (alone): the newest output is never the one lost.
   */
  push(chunk) {
    this.headSeq += 1;
    this.held += chunk.length;
    this.chunks.push({ seq: this.headSeq, chunk });
    while (this.held > this.budget && this.chunks.length > 1) {
      const old = this.chunks.shift();
      this.held -= old.chunk.length;
      this.evictedSeq = old.seq;
    }
    return this.headSeq;
  }

  /**
   * The held output of every chunk with a seq after `afterSeq`:
   * `{ bytes, headSeq, dropped }`, `dropped` = some output after `afterSeq`
   * was already evicted.
   */
  replay(afterSeq) {
    const wanted = this.chunks.filter((entry) => entry.seq > afterSeq);
    return {
      bytes: wanted.length ? Buffer.concat(wanted.map((entry) => entry.chunk)) : Buffer.alloc(0),
      headSeq: this.headSeq,
      dropped: this.evictedSeq > afterSeq,
    };
  }
}

// ── one terminal's shared output state (stream.rs) ─────────────────────────

/**
 * The output ring, the flow-control debt, the closed flag and the shell's
 * exit — what Rust's pump, waiter and `Pty` share. Single-threaded here: the
 * event loop serialises every access.
 */
class Stream {
  constructor() {
    this.closed = false;
    /** Bytes emitted minus bytes acked (never negative). */
    this.unacked = 0;
    this.ring = new OutputRing();
    /** Whether the exit was recorded, and with which code (null = signal). */
    this.exitSet = false;
    this.exitCode = null;
  }

  /** `true` while the shell runs; `{ exited: true, code }` after the exit. */
  shellState() {
    return this.exitSet ? { exited: true, code: this.exitCode } : { exited: false, code: null };
  }

  /** Record the shell's exit code (the first one set wins). */
  setExit(code) {
    if (!this.exitSet) {
      this.exitSet = true;
      this.exitCode = code ?? null;
    }
  }

  /** The webview has rendered `bytes` more of the emitted output. */
  ack(bytes) {
    this.unacked = Math.max(0, this.unacked - Math.max(0, bytes));
  }

  /** The held output after `afterSeq`; forgives the whole debt. */
  replay(afterSeq) {
    const replay = this.ring.replay(afterSeq);
    this.unacked = 0;
    return replay;
  }

  /** Silence the terminal for good: no event is emitted after this. */
  close() {
    this.closed = true;
  }

  /**
   * Append `chunk` to the ring and charge it to the debt; `{ seq, chunk }`,
   * or null when the terminal is closed. Into the ring before the event goes
   * out, so a replay racing the event covers it.
   */
  record(chunk) {
    if (this.closed) return null;
    this.unacked += chunk.length;
    const seq = this.ring.push(chunk);
    return { seq, chunk };
  }
}

// ── killing a shell's tree (kill.rs) ───────────────────────────────────────

/**
 * Pids belonging to the terminal's session: `[pid, session]` pairs in Rust
 * (Linux `/proc`, macOS `proc_listallpids`, other Unixes `/bin/ps`). Here one
 * `/bin/ps` pass.
 *
 * macOS's `ps` reports `sess` as 0 for a pty child (and `pgrep` has no `-s`),
 * so the session is approximated there by the two things a terminal's
 * processes share: the leader's process *group* (the shell and its foreground
 * jobs, and every child of a shell without job control) and the controlling
 * *tty* (interactive jobs get their own group but keep the tty). Linux's
 * `sess` is the real session id. Empty on failure.
 */
function listSessionMembers(sid, tty) {
  if (isWindows || !(sid > 1)) return [];
  const linux = process.platform === 'linux';
  let out;
  try {
    out = execFileSync(
      '/bin/ps',
      linux ? ['-A', '-o', 'pid=', '-o', 'sess='] : ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'tty='],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    return [];
  }
  const members = [];
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[0], 10);
    if (!(pid > 1) || pid === process.pid) continue;
    if (linux) {
      if (Number.parseInt(fields[1], 10) === sid) members.push(pid);
      continue;
    }
    const pgid = Number.parseInt(fields[1], 10);
    const processTty = fields[2];
    const sameGroup = pgid === sid;
    const sameTty = Boolean(tty) && processTty === tty;
    if (sameGroup || sameTty) members.push(pid);
  }
  return members;
}

/**
 * SIGKILL every process of session `sid` (`kill::kill_sessions`): first the
 * leader's process group when the leader is still ours to signal, then every
 * listed member, repeating (up to `MAX_PASSES`) until a pass finds none that
 * was not signalled before — a job may fork between listing and signal.
 *
 * `leaderAlive: false` (a natural exit, the leader already reaped) skips the
 * group signal and never signals the leader's pid: it may belong to someone
 * else now. Returns how many pids were signalled.
 */
function killSession(sid, { leaderAlive = true, tty = null } = {}) {
  if (isWindows) return 0;
  if (!(sid > 1) || sid === process.pid) return 0;
  const killed = new Set();
  if (leaderAlive) {
    // SAFETY-analogue: `sid > 1` names a session we started, so `-sid` names
    // only its process group; a failure (ESRCH, the group is empty) is not
    // actionable.
    try {
      process.kill(-sid, 'SIGKILL');
    } catch {
      // The group is gone; the per-pid passes below still reach what is left.
    }
    killed.add(sid);
  }
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const members = listSessionMembers(sid, tty).filter(
      (pid) => pid !== process.pid && !killed.has(pid),
    );
    if (members.length === 0) break;
    for (const pid of members) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Just exited; not actionable.
      }
    }
    for (const pid of members) killed.add(pid);
  }
  return killed.size;
}

/**
 * Hang the terminal up: SIGHUP the session leader's process group, as a
 * closing terminal emulator does, so the shell can save its history and hang
 * up its jobs before the kill. Returns whether a signal went out.
 */
function hangUpSession(sid) {
  if (!(sid > 1) || sid === process.pid) return false;
  try {
    process.kill(-sid, 'SIGHUP');
  } catch {
    try {
      process.kill(sid, 'SIGHUP');
    } catch {
      return false;
    }
  }
  return true;
}

/** Windows: end the shell and every descendant (`taskkill /T /F`). */
function killWindowsTree(pid) {
  if (!(pid > 0)) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Already gone.
  }
}

// ── one shell: spawn, pump, exit, kill (pty.rs, threads.rs, pump.rs) ───────

/** `check_size`: a pty size is two positive `u16`s. */
function checkSize(cols, rows) {
  const ok = (n) => Number.isInteger(n) && n > 0 && n <= 65535;
  if (!ok(cols) || !ok(rows)) {
    throw new Error(`invalid terminal size ${cols}x${rows}`);
  }
}

/**
 * Where a tab's shell starts: its folder when that is an absolute path to an
 * existing directory, else the home folder.
 */
function tabCwd(folder) {
  if (folder && path.isAbsolute(folder) && isDirectory(folder)) return folder;
  const home = os.homedir();
  if (home && path.isAbsolute(home) && isDirectory(home)) return home;
  throw new Error('no folder for the terminal: the home folder is not set');
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One running (or exited) shell: what the manager keeps per tab. Spawns the
 * program on a new pty, then pumps node-pty's `data` callbacks through the
 * same pacing, ring and flow control Rust's pump threads provide.
 */
class Shell {
  constructor(manager, tabId, instance, program, spec) {
    this.manager = manager;
    this.tabId = tabId;
    this.instance = instance;
    this.program = program;
    this.stream = new Stream();
    this.pending = [];
    this.pendingBytes = 0;
    this.lastEmitAt = 0;
    this.emitCount = 0;
    this.timer = null;
    this.stalled = false;
    this.ptyPaused = false;
    this.exitObserved = false;
    this.exitEmitted = false;
    this.exitCode = null;
    this.closed = false;
    this.closePromise = null;
    this.pty = null;
    this.sid = 0;

    let child;
    try {
      child = pty.spawn(spec.program, spec.args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: spec.env,
        // Bytes, not a decoded string: xterm reassembles split UTF-8 itself,
        // and the wire carries base64 of exactly what the pty produced.
        encoding: null,
      });
    } catch (error) {
      throw new Error(`spawn ${spec.program}: ${error && error.message ? error.message : error}`);
    }
    this.pty = child;
    this.sid = child.pid > 1 ? child.pid : 0;
    // The controlling terminal's short name (`ttys012`): how the Darwin kill
    // scan finds the session's processes once the leader is gone.
    this.tty = (child.ptsName || '').replace(/^\/dev\//, '') || null;
    // node-pty rethrows a socket error unless two 'error' listeners are
    // attached (`listeners('error').length < 2`). Any error here means the
    // shell is gone, which the exit event reports — never a reason to take the
    // main process down.
    child.on('error', () => {});
    child.on('error', () => {});
    child.onData((chunk) => this._onData(chunk));
    child.onExit(({ exitCode, signal }) => this._onExit(signal ? null : exitCode));
  }

  // ── status ──────────────────────────────────────────────────────────────

  /** `TerminalStatus` for this shell (`live_status`). */
  status() {
    return {
      instance: this.instance,
      shell: this.program,
      state: this.stream.exitSet ? 'exited' : 'running',
      exitCode: this.stream.exitSet ? this.stream.exitCode : null,
      windowsPty: windowsPty(),
    };
  }

  // ── input / view ────────────────────────────────────────────────────────

  write(data) {
    // Rust's writer thread stops at the shell's end, so its queue reports the
    // terminal as closed from then on.
    if (!this.pty || this.stream.closed || this.stream.exitSet) {
      throw new Error('terminal input is closed');
    }
    this.pty.write(typeof data === 'string' ? data : Buffer.from(data ?? ''));
  }

  resize(cols, rows) {
    if (!this.pty || this.stream.closed) throw new Error('terminal is closed');
    try {
      this.pty.resize(cols, rows);
    } catch (error) {
      throw new Error(`resize terminal: ${error && error.message ? error.message : error}`);
    }
  }

  /** The webview rendered `bytes` more of the emitted output. */
  ack(bytes) {
    if (this.stream.closed) return;
    this.stream.ack(bytes);
    if (this.stalled && this.stream.unacked < LOW_WATER) {
      this.stalled = false;
      this._syncPtyFlow();
      this._schedule(0);
    }
  }

  /** Held output after `afterSeq`; also lets a stalled pump resume. */
  replay(afterSeq) {
    const replay = this.stream.replay(afterSeq);
    if (this.stalled) {
      this.stalled = false;
      this._syncPtyFlow();
      this._schedule(0);
    }
    return replay;
  }

  // ── pump ────────────────────────────────────────────────────────────────

  _onData(chunk) {
    // After the exit event nothing more goes out (Rust abandons the reader
    // and drops its late output); dropping here also keeps a job that still
    // holds the slave from growing `pending` forever.
    if (this.closed || this.exitEmitted) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '', 'utf8');
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    // Rust's bounded queue stops draining at a full frame; pausing the pty's
    // read stream is the Node equivalent (the pty then throttles the shell).
    this._syncPtyFlow();
    this._schedule(0);
  }

  _onExit(code) {
    // Record it even while closing: `close` polls this to skip the rest of
    // the hang-up grace (Rust's waiter sets the state before its cleanup,
    // closed or not).
    this.exitObserved = true;
    this.exitCode = code ?? null;
    if (this.closed) return;
    // Before the pump hears of it, as in Rust: `status()` is current once the
    // exit event is out.
    this.stream.setExit(this.exitCode);
    // node-pty reaps the shell before this callback, so the session id is no
    // longer reserved: end what the shell left behind right away (the pty has
    // already reached EOF, so no output is lost) and forget the id.
    this._cleanupAfterExit();
    this._schedule(0);
  }

  _schedule(delay) {
    if (this.timer !== null || this.closed || this.exitEmitted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, Math.max(0, delay));
  }

  _flush() {
    if (this.closed || this.exitEmitted) return;
    if (this.stream.closed) return;
    if (this.exitObserved && this.pendingBytes === 0) {
      // The exit is neither paced nor flow-controlled: with nothing left to
      // emit it goes out at once, even while the pump is stalled (Rust breaks
      // out of its loop before it asks for credit).
      this.stalled = false;
      this._syncPtyFlow();
      this._maybeExit();
      return;
    }
    if (this.stalled) {
      if (this.stream.unacked >= LOW_WATER) {
        this._syncPtyFlow();
        return;
      }
      this.stalled = false;
      this._syncPtyFlow();
    }
    for (;;) {
      if (this.closed || this.exitEmitted || this.stream.closed) return;
      if (this.pendingBytes === 0) break;
      if (this.stream.unacked >= HIGH_WATER) {
        this.stalled = true;
        this._syncPtyFlow();
        break;
      }
      const now = Date.now();
      const readyAt = this.emitCount === 0 ? now : this.lastEmitAt + MIN_INTERVAL_MS;
      if (readyAt > now) {
        this._syncPtyFlow();
        this._schedule(readyAt - now);
        return;
      }
      const chunk = this._takeChunk();
      const recorded = this.stream.record(chunk);
      if (!recorded) return; // closed mid-flush: emit nothing further
      this.lastEmitAt = Date.now();
      this.emitCount += 1;
      this._emitData(recorded.seq, recorded.chunk);
    }
    this._syncPtyFlow();
    this._maybeExit();
  }

  /** The next event's bytes: at most `MAX_EVENT`, in order. */
  _takeChunk() {
    const take = Math.min(this.pendingBytes, MAX_EVENT);
    let need = take;
    const parts = [];
    while (need > 0) {
      const head = this.pending[0];
      if (head.length <= need) {
        parts.push(head);
        this.pending.shift();
        need -= head.length;
      } else {
        // A copy: a subarray would keep the whole read chunk alive in the ring.
        parts.push(Buffer.from(head.subarray(0, need)));
        this.pending[0] = head.subarray(need);
        need = 0;
      }
    }
    this.pendingBytes -= take;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, take);
  }

  /** Pause the pty while a full frame waits or the pump is stalled. */
  _syncPtyFlow() {
    const want = this.pendingBytes >= MAX_EVENT || this.stalled;
    if (want === this.ptyPaused) return;
    this.ptyPaused = want;
    if (!this.pty || this.stream.closed) return;
    try {
      if (want) this.pty.pause();
      else this.pty.resume();
    } catch {
      // The pty is gone (shell exited); nothing to throttle.
    }
  }

  _emitData(seq, bytes) {
    const channel = `terminal://data/${this.tabId}`;
    const payload = { instance: this.instance, seq, b64: bytes.toString('base64') };
    this.manager.emit(channel, payload);
    this.manager.emit('data', { tabId: this.tabId, channel, ...payload });
  }

  /** The exit event, once, after all output (`pump::pump`'s tail). */
  _maybeExit() {
    if (this.exitEmitted || !this.exitObserved || this.pendingBytes > 0) return;
    if (this.stream.closed) return;
    this.exitEmitted = true;
    this.manager.emit(`terminal://exit/${this.tabId}`, {
      instance: this.instance,
      code: this.exitCode,
    });
    this.manager.emit('exit', {
      tabId: this.tabId,
      channel: `terminal://exit/${this.tabId}`,
      instance: this.instance,
      code: this.exitCode,
    });
  }

  /** After a natural exit: end what the shell left behind, forget the id. */
  _cleanupAfterExit() {
    if (isWindows) {
      killWindowsTree(this.sid);
      this.sid = 0;
      return;
    }
    killSession(this.sid, { leaderAlive: false, tty: this.tty });
    this.sid = 0;
  }

  // ── close ───────────────────────────────────────────────────────────────

  /**
   * End the terminal the way closing a terminal window does: silence it at
   * once (no further event, not even the exit), hang the shell up, give it
   * `HANGUP_GRACE_MS` to exit, then kill what is left. Resolves once the tree
   * is dead.
   */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.stream.close();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    // A paused read stream never notices the hang-up (and never closes), which
    // would keep its handle — and the process — alive: resume it so the pty
    // reaches EOF once the tree is dead.
    this.ptyPaused = false;
    try {
      if (this.pty) this.pty.resume();
    } catch {
      // Already closed.
    }
    const sid = this.sid;
    if (!(sid > 1)) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    if (isWindows) {
      this._cleanupAfterExit();
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    if (!this.exitObserved) hangUpSession(sid);
    this.closePromise = new Promise((resolve) => {
      const finish = () => {
        const leaderAlive = !this.exitObserved;
        killSession(sid, { leaderAlive, tty: this.tty });
        if (leaderAlive) {
          // Belt and braces: the group kill covers the session leader, but a
          // pty that ignores SIGKILL (uninterruptible) must not keep the fd.
          try {
            if (this.pty) this.pty.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
        this.sid = 0;
        resolve();
      };
      if (this.exitObserved) {
        finish();
        return;
      }
      const started = Date.now();
      const poll = () => {
        if (this.exitObserved || Date.now() - started >= HANGUP_GRACE_MS) {
          finish();
          return;
        }
        setTimeout(poll, HANGUP_POLL_MS);
      };
      poll();
    });
    return this.closePromise;
  }
}

// ── settings: <config dir>/terminal.json (settings.rs) ─────────────────────

let tempCounter = 0;

/**
 * A JSON file read the way `json_store::read_strict` does: missing → `{}`;
 * unreadable or malformed → `"<path> is unreadable: …"`.
 */
function readJsonStrict(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`${file} is unreadable: ${error && error.message ? error.message : error}`);
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not a JSON object');
    }
    return data;
  } catch (error) {
    throw new Error(`${file} is unreadable: ${error && error.message ? error.message : error}`);
  }
}

/** Write-to-temp-then-rename, so a crash mid-write never corrupts the file. */
function writeAtomic(file, bytes) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  tempCounter += 1;
  const temp = path.join(dir, `${path.basename(file)}.${process.pid}-${tempCounter}.tmp`);
  try {
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/** The value `stored` holds under `shell`: a string, or unset when absent. */
function storedShell(stored) {
  const value = stored.shell;
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`\`shell\` is not a string: ${JSON.stringify(value)}`);
  return value;
}

/**
 * `terminal.json` plus its in-memory copy. `file` null keeps the setting in
 * memory only (no config folder); a missing or unreadable file reads as the
 * default and is never silently overwritten.
 */
class SettingsStore {
  constructor(file) {
    this.file = file || null;
    this.value = '';
    if (this.file) {
      try {
        this.value = storedShell(readJsonStrict(this.file));
      } catch {
        // A missing or unreadable file reads as the default (logged by Rust).
        this.value = '';
      }
    }
  }

  /** The stored shell; empty = the default. */
  get() {
    return this.value;
  }

  /** Store `shell` (already normalised/validated) and return the new value. */
  set(shell) {
    if (!this.file) {
      this.value = shell;
      return;
    }
    const stored = readJsonStrict(this.file);
    let now;
    try {
      now = storedShell(stored);
    } catch (error) {
      throw new Error(`${this.file} is unreadable: ${error.message}`);
    }
    if (now !== shell) {
      stored.shell = shell;
      try {
        writeAtomic(this.file, `${JSON.stringify(stored, null, 2)}\n`);
      } catch (error) {
        throw new Error(`${this.file} is unreadable: ${error && error.message ? error.message : error}`);
      }
    }
    this.value = shell;
  }
}

// ── the manager (mod.rs) ───────────────────────────────────────────────────

/** A tab's slot (`Slot`): no shell yet, one spawning, or one (running/exited). */
const IDLE = Object.freeze({ kind: 'idle' });

/** What `open` returns when a shell is already spawning or running. */
function currentStatus(slot) {
  const status = slotStatus(slot);
  return status && status.state !== 'exited' ? status : null;
}

function slotStatus(slot) {
  if (slot.kind === 'idle') return null;
  if (slot.kind === 'spawning') {
    return {
      instance: slot.instance,
      shell: slot.shell,
      state: 'starting',
      exitCode: null,
      windowsPty: windowsPty(),
    };
  }
  return slot.shell.status();
}

/**
 * Managed state: the tabs and their shells. Extends `EventEmitter`, which
 * carries the `terminal://data/<id>` / `terminal://exit/<id>` events plus the
 * generic `data`/`exit` convenience events.
 */
class TerminalManager extends EventEmitter {
  /**
   * `options.settingsPath` = the `terminal.json` path (read once here);
   * omitted keeps the shell setting in memory only.
   */
  constructor(options = {}) {
    super();
    // One listener per tab on `data`/`exit` (or per channel) is normal: the
    // default warning at 11 would fire on any busy workspace.
    this.setMaxListeners(0);
    const settingsPath = typeof options === 'string' ? options : options.settingsPath;
    this.tabs = new Map();
    this.nextInstance = 1;
    this.settings = new SettingsStore(settingsPath || null);
  }

  /**
   * Make `id` a tab whose shell starts in `folder`, or update the folder of an
   * existing one, keeping its shell (a profile switch restarts omp under the
   * same id; the tab and its terminal stay).
   */
  registerTab(id, folder) {
    const folderPath = folder == null ? null : String(folder);
    const tab = this.tabs.get(id);
    if (tab) tab.folder = folderPath;
    else this.tabs.set(id, { folder: folderPath, slot: IDLE });
  }

  /** Every registered tab id. */
  tabIds() {
    return [...this.tabs.keys()];
  }

  /** The project folder registered for `id` (null for unknown/none). */
  folder(id) {
    const tab = this.tabs.get(id);
    return tab ? tab.folder : null;
  }

  /**
   * Start the tab's shell and return its status. While one is starting or
   * running, returns that one's status instead (no second spawn); an exited
   * one is replaced, and its leftovers are killed.
   */
  open(id, cols = 80, rows = 24) {
    checkSize(cols, rows);
    if (isWindows) requireConpty(windowsPty());
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no tab ${id}`);
    const current = currentStatus(tab.slot);
    if (current) return current;

    // Both may touch the disk (and the default shell may query the user
    // database): resolve before the slot changes, as Rust does.
    const { program, args } = resolveShell(this.settings.get());
    const cwd = tabCwd(tab.folder);

    const instance = this.nextInstance;
    this.nextInstance += 1;
    const previous = tab.slot;
    tab.slot = { kind: 'spawning', instance, shell: program };
    // The exited shell's leftovers, silenced and killed. `close` never emits.
    if (previous.kind === 'live') previous.shell.close();

    const env = childEnv(program, id);
    let shell;
    try {
      shell = new Shell(this, id, instance, program, {
        program,
        args,
        cwd,
        cols,
        rows,
        env,
      });
    } catch (error) {
      if (this.tabs.get(id) === tab && tab.slot.kind === 'spawning' && tab.slot.instance === instance) {
        tab.slot = IDLE;
      }
      throw error;
    }
    // Node spawns synchronously, so the tab cannot have been closed meanwhile;
    // the re-check stays for parity with Rust's unlocked spawn and for a
    // future async spawn.
    const stillOurs = this.tabs.get(id) === tab && tab.slot.kind === 'spawning' && tab.slot.instance === instance;
    if (stillOurs) {
      tab.slot = { kind: 'live', shell };
      return shell.status();
    }
    shell.close();
    throw new Error('tab closed');
  }

  /** The tab's shell, null for an unknown tab or one without a shell. */
  status(id) {
    const tab = this.tabs.get(id);
    return tab ? slotStatus(tab.slot) : null;
  }

  /** The tab's shell (running or exited), outside any lock. */
  _live(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no tab ${id}`);
    if (tab.slot.kind !== 'live') throw new Error(`no terminal for tab ${id}`);
    return tab.slot.shell;
  }

  /**
   * Queue `data` for the shell, exactly as given; node-pty writes it in
   * order and never blocks.
   */
  write(id, data) {
    this._live(id).write(data);
  }

  /** Tell the shell its window is now `cols` × `rows` characters. */
  resize(id, cols, rows) {
    checkSize(cols, rows);
    this._live(id).resize(cols, rows);
  }

  /**
   * The output the tab's shell still holds after event `afterSeq` of
   * `instance`: `{ instance, b64, headSeq, dropped }`; null while the tab has
   * no shell. An `instance` that is not the current shell's asks for
   * everything the current one holds. Two-argument form (the tab's current
   * instance implied): `replay(id, afterSeq)`.
   */
  replay(id, instance, afterSeq) {
    const tab = this.tabs.get(id);
    if (!tab || tab.slot.kind !== 'live') return null;
    const shell = tab.slot.shell;
    const current = shell.instance;
    let after;
    if (afterSeq === undefined) {
      after = instance === undefined ? 0 : instance;
    } else {
      after = instance === current ? afterSeq : 0;
    }
    const replay = shell.replay(after);
    return {
      instance: current,
      b64: replay.bytes.toString('base64'),
      headSeq: replay.headSeq,
      dropped: replay.dropped,
    };
  }

  /**
   * The webview has rendered `bytes` more of `instance`'s output (flow
   * control). Ignored for any other instance (an old shell's late ack).
   */
  ack(id, instance, bytes) {
    const tab = this.tabs.get(id);
    if (!tab || tab.slot.kind !== 'live') return;
    const shell = tab.slot.shell;
    if (shell.instance === instance) shell.ack(bytes);
  }

  /** End one tab: forget it and kill its shell's tree. Resolves when dead. */
  closeTab(id) {
    return this.closeTabs([id]);
  }

  /**
   * End exactly these tabs: forget them, hang their shells up, and kill what
   * is left after `HANGUP_GRACE_MS` at most. Silent (no exit event). Unknown
   * tabs are ignored, and a tab registered meanwhile is left alone. All the
   * shells share one grace, as in `Pty::close_all`.
   */
  closeTabs(ids) {
    const shells = [];
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      this.tabs.delete(id);
      if (tab.slot.kind === 'live') shells.push(tab.slot.shell);
    }
    return Promise.all(shells.map((shell) => shell.close())).then(() => undefined);
  }

  /**
   * End every tab, for the paths where the process ends without running
   * destructors (app exit, an update's relaunch). The manager stays usable.
   */
  shutdownAll() {
    return this.closeTabs([...this.tabs.keys()]);
  }

  /** The shell setting, its default and the installed shells. */
  settingsPayload() {
    return {
      shell: this.settings.get(),
      defaultShell: defaultShell(),
      shells: availableShells(),
    };
  }

  /**
   * Validate and store the shell setting (empty = default); used by the next
   * shell started. Returns the new `TerminalSettings`.
   */
  setShell(shell) {
    const typed = typedPath(shell);
    if (typed !== '') validateShell(typed);
    this.settings.set(typed);
    return this.settingsPayload();
  }

  /** The installed shells for the Settings menu: `[{ name, path }]`. */
  shellsList() {
    return availableShells();
  }

  // ── test-only parity hooks (Rust's tests poke the private slot) ──────────

  /** `#[cfg(test)]`-only in Rust: force a tab's slot. */
  _setSlotForTest(id, slot) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no tab ${id}`);
    if (slot.kind === 'spawning') {
      tab.slot = { kind: 'spawning', instance: slot.instance, shell: slot.shell };
    } else if (slot.kind === 'idle') {
      tab.slot = IDLE;
    } else {
      throw new Error(`unsupported test slot ${slot.kind}`);
    }
  }
}

module.exports = {
  TerminalManager,
  // Constants the wire contract pins (exported for tests and callers).
  RING_BYTES,
  HIGH_WATER,
  LOW_WATER,
  MAX_EVENT,
  MIN_INTERVAL_MS,
  READER_GRACE_MS,
  HANGUP_GRACE_MS,
  HANGUP_POLL_MS,
  CONPTY_MIN_BUILD,
  LOGIN_SHELLS,
  FALLBACK_LANG,
  // The ring, with its own parity tests.
  OutputRing,
  // Shell resolution, the child environment and the installed shells.
  typedPath,
  isExecutableFile,
  childPath,
  mergedPath,
  takesLoginArgs,
  defaultShell,
  resolveShell,
  fallbackLang,
  childEnv,
  availableShells,
  windowsPty,
  requireConpty,
  // The kill scan, for tests and for callers that diagnose a stuck shell.
  listSessionMembers,
};