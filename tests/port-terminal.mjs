/* Port parity tests for electron/backend/terminal.js.

   Mirrors src-tauri/src/terminal/{ring,pump,stream,shell,shells,settings,
   mod}.rs and their #[cfg(test)] cases: the real `sh` on a pty, driven
   through the manager and observed through its events. Run:

     node tests/port-terminal.mjs

   Every case names the Rust test it ports. Where a Rust test pokes private
   state (`Slot::Spawning`), the manager's `_setSlotForTest` hook stands in. */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/terminal.js';

const {
  TerminalManager,
  RING_BYTES,
  HIGH_WATER,
  LOW_WATER,
  MAX_EVENT,
  MIN_INTERVAL_MS,
  OutputRing,
  LOGIN_SHELLS,
  typedPath,
  isExecutableFile,
  mergedPath,
  takesLoginArgs,
  defaultShell,
  resolveShell,
  fallbackLang,
  childEnv,
  availableShells,
  windowsPty,
  requireConpty,
  listSessionMembers,
} = backend;

let checks = 0;

// ── scratch state ──────────────────────────────────────────────────────────

const scratchDirs = [];
const managers = [];

function makeTempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_terminal_${tag}_`));
  scratchDirs.push(dir);
  return dir;
}

/** A plain interactive `sh`. `/bin/sh -l` would read the developer's
 *  `~/.profile` (which may `exec fish`), so the tests run `sh` through a
 *  wrapper whose name (not a POSIX shell's) gets no `-l -i` arguments. */
const shellDir = makeTempDir('plain');
const PLAIN_SHELL = path.join(shellDir, 'plainsh');
fs.writeFileSync(PLAIN_SHELL, '#!/bin/sh\nexec /bin/sh -i\n');
fs.chmodSync(PLAIN_SHELL, 0o755);

function managerWith(shell) {
  const manager = new TerminalManager({});
  manager.setShell(shell);
  managers.push(manager);
  return manager;
}

after(async () => {
  for (const manager of managers) {
    try {
      await manager.shutdownAll();
    } catch {
      // A test may already have shut it down.
    }
  }
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[port-terminal] ${checks} checks passed`);
});

// ── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `test_support::wait_until`. */
async function waitUntil(timeoutMs, condition, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(5);
  }
}

/** Whether process `pid` exists (a zombie counts), by the null signal. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What one tab's events say, collected from the generic `data`/`exit`
 *  events (the channel-scoped ones are checked on their own). */
function attach(manager, tabId) {
  const out = {
    tabId,
    events: [],
    exits: [],
    exitText: null,
    acked: 0,
  };
  out.text = () => Buffer.concat(out.events.map((event) => event.bytes)).toString();
  out.totalBytes = () => out.events.reduce((sum, event) => sum + event.bytes.length, 0);
  out.largestEvent = () => out.events.reduce((max, event) => Math.max(max, event.bytes.length), 0);
  out.seqs = () => out.events.map((event) => [event.instance, event.seq]);
  out.exitCodes = () => out.exits.map((event) => event.code);
  out.ackNew = () => {
    const fresh = out.events.slice(out.acked);
    out.acked = out.events.length;
    for (const event of fresh) manager.ack(tabId, event.instance, event.bytes.length);
  };
  /** The decimal number right after the first `marker` in the output that is
   *  followed by a digit (the shell's echo of the typed command has a `$`
   *  there instead). */
  out.numberAfter = (marker) => {
    const match = out.text().match(new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`));
    return match ? Number.parseInt(match[1], 10) : null;
  };
  manager.on('data', (event) => {
    if (event.tabId !== tabId) return;
    out.events.push({
      instance: event.instance,
      seq: event.seq,
      bytes: Buffer.from(event.b64, 'base64'),
    });
  });
  manager.on('exit', (event) => {
    if (event.tabId !== tabId) return;
    out.exitText = out.text();
    out.exits.push({ instance: event.instance, code: event.code });
  });
  return out;
}

/** `open_with`: the tab registered with the temp dir as its folder. */
function openWith(manager, id) {
  manager.registerTab(id, os.tmpdir());
  const out = attach(manager, id);
  const status = manager.open(id, 80, 24);
  return { manager, out, status };
}

/** The same collector across every tab (Rust's `Collector` is manager-wide). */
function attachAll(manager) {
  const out = {
    events: [],
    exits: [],
    exitText: null,
    acked: 0,
  };
  out.text = () => Buffer.concat(out.events.map((event) => event.bytes)).toString();
  out.numberAfter = (marker) => {
    const match = out.text().match(new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`));
    return match ? Number.parseInt(match[1], 10) : null;
  };
  out.ackNew = () => {
    const fresh = out.events.slice(out.acked);
    out.acked = out.events.length;
    for (const event of fresh) manager.ack(event.tabId, event.instance, event.bytes.length);
  };
  manager.on('data', (event) => {
    out.events.push({
      tabId: event.tabId,
      instance: event.instance,
      seq: event.seq,
      bytes: Buffer.from(event.b64, 'base64'),
    });
  });
  manager.on('exit', (event) => {
    out.exitText = out.text();
    out.exits.push({ tabId: event.tabId, instance: event.instance, code: event.code });
  });
  return out;
}

/** `wait_until` while acknowledging the output as it arrives. */
async function waitAcking(manager, out, condition, label) {
  return waitUntil(
    20_000,
    () => {
      out.ackNew();
      return condition();
    },
    label,
  );
}

/** A shell that records its pid in `pidfile` (appending) before it becomes an
 *  interactive `sh`, so a test sees every shell a manager started. */
function recordingShell(tag, body = 'exec /bin/sh -i') {
  const dir = makeTempDir(tag);
  const pidfile = path.join(dir, 'pids');
  const shell = path.join(dir, 'recordsh');
  fs.writeFileSync(shell, `#!/bin/sh\necho $$ >> '${pidfile}'\n${body}\n`);
  fs.chmodSync(shell, 0o755);
  return { dir, shell, pidfile };
}

function recordedPids(pidfile) {
  if (!fs.existsSync(pidfile)) return [];
  return fs
    .readFileSync(pidfile, 'utf8')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid));
}

/** The controlling terminal of `pid` as `ps` prints it (`ttys012`). */
function ttyOf(pid) {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'tty='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const [pidText, tty] = line.trim().split(/\s+/);
    if (Number.parseInt(pidText, 10) === pid) return tty;
  }
  return null;
}

// ── ring.rs ────────────────────────────────────────────────────────────────

test('ring: an empty ring replays nothing at seq zero', () => {
  const ring = new OutputRing();
  const replay = ring.replay(0);
  assert.equal(replay.bytes.length, 0);
  assert.equal(replay.headSeq, 0);
  assert.equal(replay.dropped, false);
  checks += 1;
});

test('ring: seqs count up from one and replay resumes after the given one', () => {
  const ring = new OutputRing();
  assert.equal(ring.push(Buffer.from('ab')), 1);
  assert.equal(ring.push(Buffer.from('cd')), 2);
  assert.equal(ring.push(Buffer.from('ef')), 3);
  const all = ring.replay(0);
  assert.deepEqual([all.bytes.toString(), all.headSeq, all.dropped], ['abcdef', 3, false]);
  const tail = ring.replay(2);
  assert.deepEqual([tail.bytes.toString(), tail.headSeq, tail.dropped], ['ef', 3, false]);
  const none = ring.replay(3);
  assert.deepEqual([none.bytes.length, none.headSeq, none.dropped], [0, 3, false]);
  checks += 1;
});

test('ring: whole chunks are evicted oldest first and reported as dropped', () => {
  const ring = new OutputRing(10);
  ring.push(Buffer.from('1111')); // seq 1
  ring.push(Buffer.from('2222')); // seq 2
  ring.push(Buffer.from('3333')); // seq 3: 12 > 10, seq 1 goes
  const all = ring.replay(0);
  assert.equal(all.bytes.toString(), '22223333', 'evicted mid-chunk or kept too much');
  assert.equal(all.dropped, true, 'seq 1 was evicted');
  assert.equal(all.headSeq, 3);
  const rest = ring.replay(1);
  assert.deepEqual([rest.bytes.toString(), rest.dropped], ['22223333', false]);
  checks += 1;
});

test('ring: an oversized chunk is kept alone', () => {
  const ring = new OutputRing(4);
  ring.push(Buffer.from('ab'));
  ring.push(Buffer.from('0123456789'));
  const all = ring.replay(0);
  assert.deepEqual([all.bytes.toString(), all.headSeq, all.dropped], ['0123456789', 2, true]);
  checks += 1;
});

test('ring: the budget holds over many events', () => {
  const ring = new OutputRing();
  for (let i = 0; i < 40; i += 1) ring.push(Buffer.alloc(64 * 1024, 7));
  const all = ring.replay(0);
  assert.equal(all.bytes.length, RING_BYTES);
  assert.equal(all.headSeq, 40);
  assert.equal(all.dropped, true);
  assert.equal(ring.replay(24).dropped, false, 'seq 25..=40 are all held');
  assert.equal(ring.replay(23).dropped, true, 'seq 24 was evicted');
  checks += 1;
});

// ── shell.rs (pure) ────────────────────────────────────────────────────────

test('shell: a missing locale gets the utf8 fallback', () => {
  assert.equal(fallbackLang(() => false), 'en_US.UTF-8');
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
    assert.equal(fallbackLang((other) => other === key), null, `${key} is set`);
  }
  assert.equal(fallbackLang((other) => other === 'LC_TIME'), 'en_US.UTF-8');
  checks += 1;
});

test('shell: login args follow the file name per platform', () => {
  for (const name of LOGIN_SHELLS) {
    assert.equal(takesLoginArgs(name, false), true, name);
    assert.equal(takesLoginArgs(`${name}.exe`, true), true, name);
  }
  const cases = [
    ['BASH.EXE', true, true],
    ['Nu.Exe', true, true],
    ['bash', true, false],
    ['bash.cmd', true, false],
    ['pwsh.exe', true, false],
    ['cmd.exe', true, false],
    ['bash.exe', false, false],
    ['Bash', false, false],
    ['pwsh', false, false],
  ];
  for (const [name, windows, expected] of cases) {
    assert.equal(takesLoginArgs(name, windows), expected, `${name} ${windows}`);
  }
  checks += 1;
});

test('shell: a preference wins and an empty one runs the default', () => {
  const fallback = () => '/the/default';
  for (const empty of ['', '  ']) {
    assert.equal(resolveShell(empty, fallback).program, '/the/default', JSON.stringify(empty));
  }
  const typed = ` ${PLAIN_SHELL} `;
  let called = false;
  const resolved = resolveShell(typed, () => {
    called = true;
    return fallback();
  });
  assert.equal(resolved.program, PLAIN_SHELL, 'trimmed preference');
  assert.deepEqual(resolved.args, [], 'not a login shell');
  assert.equal(called, false, 'the default is not resolved for a preference');
  for (const bad of ['sh', './sh', '/definitely/not/a/shell', '/etc/hosts', '/bin']) {
    assert.throws(() => resolveShell(bad, fallback), undefined, bad);
  }
  checks += 1;
});

test('shell: a quoted preference resolves', () => {
  const quoted = ` "${PLAIN_SHELL}" `;
  assert.equal(resolveShell(quoted, () => '').program, PLAIN_SHELL);
  assert.equal(typedPath('""'), '');
  assert.equal(typedPath('" /x '), '" /x');
  checks += 1;
});

test('shell: the default shell is resolved in process', () => {
  const shell = defaultShell();
  assert.equal(path.isAbsolute(shell), true, shell);
  assert.equal(isExecutableFile(shell), true, shell);
  checks += 1;
});

test('shell: the child environment carries the terminal markers', () => {
  const env = childEnv(PLAIN_SHELL, 'sess-1', { PATH: '/usr/bin:/bin', HOME: '/home/x' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.OMP_DESKTOP, '1');
  assert.equal(env.OMP_DESKTOP_SESSION, 'sess-1');
  assert.equal(env.SHELL, PLAIN_SHELL);
  assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'), 'homebrew appended');
  assert.ok(env.PATH.indexOf('/usr/bin') < env.PATH.indexOf('/opt/homebrew/bin'));
  if (process.platform === 'darwin') {
    assert.equal(env.LANG, 'en_US.UTF-8', 'no locale set → fallback');
    const withLang = childEnv(PLAIN_SHELL, 's', { PATH: '/bin', LANG: 'de_DE.UTF-8' });
    assert.equal(withLang.LANG, 'de_DE.UTF-8', 'a set locale is never overridden');
  }
  checks += 1;
});

// ── child_path.rs ──────────────────────────────────────────────────────────

test('child_path: extra dirs are appended after the inherited ones and deduped', () => {
  const merged = mergedPath('/usr/bin:/bin:/opt/homebrew/bin', ['/opt/homebrew/bin', '/usr/local/bin']);
  const dirs = merged.split(':');
  assert.deepEqual(dirs.slice(0, 3), ['/usr/bin', '/bin', '/opt/homebrew/bin']);
  assert.equal(dirs.filter((dir) => dir === '/opt/homebrew/bin').length, 1, 'deduped');
  assert.ok(dirs.includes('/usr/local/bin'));
  checks += 1;
});

// ── shells.rs ──────────────────────────────────────────────────────────────

test('shells: only installed shells are offered, in list order', () => {
  const first = makeTempDir('pathfirst');
  const second = makeTempDir('pathsecond');
  fs.writeFileSync(path.join(first, 'zsh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(first, 'zsh'), 0o755);
  fs.writeFileSync(path.join(second, 'bash'), '#!/bin/sh\n');
  fs.chmodSync(path.join(second, 'bash'), 0o755);
  // A non-executable file is not offered.
  fs.writeFileSync(path.join(first, 'fish'), '');
  const found = availableShells({ PATH: '/usr/bin' }, [first, second]);
  assert.deepEqual(found.map((choice) => choice.name), ['bash', 'zsh'], 'list order');
  assert.equal(found[0].path, path.join(second, 'bash'), 'first PATH hit wins');
  assert.equal(found[1].path, path.join(first, 'zsh'));
  checks += 1;
});

test('shells: the system shells are found', () => {
  const names = managerWith(PLAIN_SHELL).shellsList().map((choice) => choice.name);
  for (const name of process.platform === 'win32' ? ['cmd', 'powershell'] : ['sh']) {
    assert.ok(names.includes(name), `${name} in ${JSON.stringify(names)}`);
  }
  checks += 1;
});

// ── wire.rs ────────────────────────────────────────────────────────────────

test('wire: a windows without conpty is refused', () => {
  const build = (buildNumber) => ({ backend: 'conpty', buildNumber });
  assert.throws(() => requireConpty(build(17134)), /17763.*17134/);
  assert.doesNotThrow(() => requireConpty(build(17763)));
  assert.doesNotThrow(() => requireConpty(build(22631)));
  assert.doesNotThrow(() => requireConpty(null), 'unknown build');
  assert.equal(windowsPty(), null, 'no pseudo console off Windows');
  checks += 1;
});

// ── mod.rs / pty.rs / pump.rs (real shell) ─────────────────────────────────

test('shell output and exit code are emitted', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'echo');
  manager.write('echo', 'echo hel""lo; exit 3\n');
  await waitUntil(20_000, () => out.exits.length > 0, 'exit event');
  assert.ok(out.text().includes('hello'), `output: ${JSON.stringify(out.text())}`);
  assert.deepEqual(out.exitCodes(), [3]);
  checks += 1;
});

test('shell gets the registered folder and terminal env', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'env');
  manager.write(
    'env',
    'echo T=$TERM C=$COLORTERM O=$OMP_DESKTOP S=$OMP_DESKTOP_SESSION SH=$SHELL; pwd -P\n',
  );
  const wanted = `T=xterm-256color C=truecolor O=1 S=env SH=${PLAIN_SHELL}`;
  await waitUntil(20_000, () => out.text().includes(wanted), `output ${JSON.stringify(out.text())}`);
  const cwd = fs.realpathSync(os.tmpdir());
  await waitUntil(20_000, () => out.text().includes(`${cwd}\r`), 'pwd output');
  checks += 1;
});

test('a missing folder falls back to home', async () => {
  const home = fs.realpathSync(os.homedir());
  const manager = managerWith(PLAIN_SHELL);
  const folders = [null, '/definitely/not/a/dir', 'relative/dir'];
  for (const [n, folder] of folders.entries()) {
    const id = `home${n}`;
    manager.registerTab(id, folder);
    const out = attach(manager, id);
    manager.open(id, 80, 24);
    manager.write(id, `echo H${n}=$(pwd -P)\n`);
    await waitUntil(
      20_000,
      () => out.text().includes(`H${n}=${home}`),
      `folder ${folder}: ${JSON.stringify(out.text())}`,
    );
  }
  checks += 1;
});

test('burst output is coalesced into capped, spaced events', async () => {
  const started = Date.now();
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'burst');
  manager.write('burst', 'yes | head -c 2000000; exit\n');
  await waitAcking(manager, out, () => out.exits.length > 0, 'no exit event');
  const took = Date.now() - started;
  assert.ok(out.totalBytes() >= 2_000_000, `bytes: ${out.totalBytes()}`);
  const most = Math.floor(took / MIN_INTERVAL_MS) + 1;
  assert.ok(out.events.length <= most, `${out.events.length} events in ${took}ms`);
  assert.ok(out.largestEvent() <= MAX_EVENT, `largest event: ${out.largestEvent()}`);
  // The exit event came after the whole burst.
  assert.ok(out.exitText.length >= 2_000_000, `exit before the data: ${out.exitText.length} bytes`);
  checks += 1;
});

test('a pump stops at high water and resumes below low water', async () => {
  const manager = managerWith(PLAIN_SHELL);
  const { out } = openWith(manager, 'stall');
  manager.write('stall', "head -c 1600000 /dev/zero | tr '\\0' x; echo END; exit\n");
  await waitUntil(20_000, () => out.totalBytes() >= HIGH_WATER, 'high water');
  const stalledAt = out.totalBytes();
  assert.ok(
    stalledAt <= HIGH_WATER + 2 * MAX_EVENT,
    `${stalledAt} emitted before the stall (over ${HIGH_WATER + 2 * MAX_EVENT})`,
  );
  await sleep(250);
  assert.equal(out.totalBytes(), stalledAt, 'the pump kept emitting while stalled');
  assert.equal(out.exits.length, 0, 'the exit event came while stalled');

  // Down to exactly LOW_WATER is not enough.
  manager.ack('stall', out.events[0].instance, stalledAt - LOW_WATER);
  await sleep(150);
  assert.equal(out.totalBytes(), stalledAt, 'resumed at LOW_WATER');

  // One byte more and it runs again, up to the next stall.
  manager.ack('stall', out.events[0].instance, 1);
  await waitUntil(5_000, () => out.totalBytes() > stalledAt, 'did not resume');

  // Drain the rest and let the shell exit.
  await waitAcking(manager, out, () => out.exits.length > 0, 'no exit after draining');
  assert.ok(out.totalBytes() >= 1_600_000, `bytes: ${out.totalBytes()}`);
  checks += 1;
});

test('a replay forgives the debt', async () => {
  const manager = managerWith(PLAIN_SHELL);
  const { out } = openWith(manager, 'forgive');
  const status = manager.status('forgive');
  manager.write('forgive', "head -c 1600000 /dev/zero | tr '\\0' y; echo END; exit\n");
  await waitUntil(20_000, () => out.totalBytes() >= HIGH_WATER, 'high water');
  const stalledAt = out.totalBytes();
  const replay = manager.replay('forgive', status.instance, 0);
  const replayed = Buffer.from(replay.b64, 'base64').length;
  assert.equal(replayed, stalledAt, 'ring lags the events');
  await waitUntil(5_000, () => out.totalBytes() > stalledAt, 'the replay did not resume the pump');
  await waitAcking(manager, out, () => out.exits.length > 0, 'no exit after draining');
  checks += 1;
});

test('close tab kills background jobs', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'jobs');
  manager.write('jobs', 'sleep 1000 & echo JOB=$!\n');
  await waitUntil(20_000, () => out.numberAfter('JOB=') !== null, 'job pid');
  const job = out.numberAfter('JOB=');
  assert.equal(processAlive(job), true, 'background job did not start');

  await manager.closeTab('jobs');

  await waitUntil(3_000, () => !processAlive(job), `background job ${job} survived closeTab`);
  assert.deepEqual(manager.tabIds(), [], 'tab kept');
  // Closing is silent: the tab is gone, nobody listens for the exit.
  await sleep(300);
  assert.equal(out.exits.length, 0, 'a closed terminal emitted its exit');
  checks += 1;
});

test('close tab kills a fake sleep shell', async () => {
  const sleeper = recordingShell('sleeper', 'exec sleep 60');
  const manager = managerWith(sleeper.shell);
  manager.registerTab('sleep', os.tmpdir());
  const out = attach(manager, 'sleep');
  manager.open('sleep', 80, 24);
  await waitUntil(5_000, () => recordedPids(sleeper.pidfile).length > 0, 'shell never started');
  const pid = recordedPids(sleeper.pidfile)[0];
  assert.equal(processAlive(pid), true);
  await manager.closeTab('sleep');
  await waitUntil(3_000, () => !processAlive(pid), `shell ${pid} survived closeTab`);
  assert.equal(out.exits.length, 0, 'a closed terminal emitted its exit');
  checks += 1;
});

test('close tab hangs the shell up before killing it', async () => {
  const dir = makeTempDir('hup');
  const marker = path.join(dir, 'hung');
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'hup');
  // The trap is set by a non-interactive `sh` that replaces the prompt (same
  // pid, still the session leader) and then waits in the `wait` builtin,
  // which a trapped signal interrupts at once (POSIX).
  manager.write(
    'hup',
    `exec sh -c 'trap "echo hung > ${marker}; exit" HUP; sleep 30 & echo TR""APPED; wait'\n`,
  );
  await waitUntil(20_000, () => out.text().includes('TRAPPED'), 'trap installed');

  await manager.closeTab('hup');

  await waitUntil(3_000, () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'hung\n', 'the HUP trap did not run');
  checks += 1;
});

test('ctrl-c reaches the foreground process', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'ctrlc');
  manager.write('ctrlc', 'sh -c \'echo RUN""NING; exec sleep 30\'\n');
  await waitUntil(20_000, () => out.text().includes('RUNNING'));
  await sleep(100);

  manager.write('ctrlc', '\x03');
  manager.write('ctrlc', 'echo DONE$?\n');

  await waitUntil(2_000, () => out.text().includes('DONE130'), `output: ${JSON.stringify(out.text())}`);
  checks += 1;
});

test('open is idempotent while alive and respawns after exit', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'again');
  const first = manager.status('again');
  manager.write('again', 'echo A=$$\n');
  await waitUntil(20_000, () => out.numberAfter('A=') !== null);
  const firstPid = out.numberAfter('A=');

  const second = manager.open('again', 80, 24);
  assert.equal(second.instance, first.instance, 'second open respawned');
  manager.write('again', 'echo B=$$\n');
  await waitUntil(20_000, () => out.numberAfter('B=') !== null);
  assert.equal(out.numberAfter('B='), firstPid, 'second open respawned');

  manager.write('again', 'exit\n');
  await waitUntil(20_000, () => out.exits.length > 0);

  const third = manager.open('again', 80, 24);
  assert.ok(third.instance > first.instance, `${JSON.stringify(third)} after ${JSON.stringify(first)}`);
  assert.equal(third.state, 'running');
  manager.write('again', 'echo C=$$\n');
  await waitUntil(20_000, () => out.numberAfter('C=') !== null);
  assert.notEqual(out.numberAfter('C='), firstPid, 'no new shell');

  const seqs = out.seqs();
  for (const instance of [first.instance, third.instance]) {
    const mine = seqs.filter(([i]) => i === instance).map(([, seq]) => seq);
    const expected = mine.map((_, index) => index + 1);
    assert.deepEqual(mine, expected, `instance ${instance}`);
  }
  checks += 1;
});

test('re-registering a tab keeps its shell', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'keep');
  const before = manager.status('keep');
  manager.write('keep', 'echo A=$$\n');
  await waitUntil(20_000, () => out.numberAfter('A=') !== null);

  manager.registerTab('keep', '/');
  const after = manager.open('keep', 80, 24);

  assert.equal(after.instance, before.instance);
  manager.write('keep', 'echo B=$$\n');
  await waitUntil(20_000, () => out.numberAfter('B=') !== null);
  assert.equal(out.numberAfter('B='), out.numberAfter('A='));
  checks += 1;
});

test('status goes from starting to running to exited', async () => {
  const manager = managerWith(PLAIN_SHELL);
  const out = attach(manager, 'states');
  manager.registerTab('states', os.tmpdir());
  assert.equal(manager.status('states'), null);

  const pending = {
    instance: 999,
    shell: '/bin/pending',
    state: 'starting',
    exitCode: null,
    windowsPty: null,
  };
  manager._setSlotForTest('states', { kind: 'spawning', instance: 999, shell: '/bin/pending' });
  assert.deepEqual(manager.status('states'), pending);
  assert.deepEqual(
    manager.open('states', 80, 24),
    pending,
    'an open during a pending spawn must not spawn again',
  );
  assert.throws(() => manager.write('states', 'x'), /no terminal for tab states/, 'no shell yet');

  manager._setSlotForTest('states', { kind: 'idle' });
  const running = manager.open('states', 80, 24);
  assert.equal(running.state, 'running');
  assert.equal(running.shell, PLAIN_SHELL);
  assert.equal(running.exitCode, null);
  assert.deepEqual(manager.status('states'), running);
  assert.deepEqual(Object.keys(running).sort(), [
    'exitCode',
    'instance',
    'shell',
    'state',
    'windowsPty',
  ]);
  assert.equal(running.windowsPty, null, 'no pseudo console off Windows');

  manager.write('states', 'exit 4\n');
  await waitUntil(20_000, () => out.exits.length > 0, 'no exit event');
  const exited = manager.status('states');
  assert.equal(exited.instance, running.instance);
  assert.equal(exited.state, 'exited');
  assert.equal(exited.exitCode, 4);
  checks += 1;
});

test('replay returns the held output', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'replay');
  const status = manager.status('replay');
  manager.write('replay', 'echo RE""PLAYED\n');
  await waitUntil(20_000, () => out.text().includes('REPLAYED'));
  await sleep(200); // settle: no further output while comparing

  const decode = (b64) => Buffer.from(b64, 'base64').toString();
  const all = manager.replay('replay', status.instance, 0);
  assert.equal(all.instance, status.instance);
  assert.equal(all.dropped, false);
  assert.equal(decode(all.b64), out.text());
  assert.equal(all.headSeq, out.seqs().at(-1)[1], 'head is the last emitted seq');

  const noneNewer = manager.replay('replay', status.instance, all.headSeq);
  assert.equal(noneNewer.b64, '', 'nothing after the head');

  const stale = manager.replay('replay', status.instance + 100, all.headSeq);
  assert.equal(stale.instance, status.instance);
  assert.equal(decode(stale.b64), out.text(), 'a stale instance gets all');

  // The two-argument form implies the tab's current shell.
  assert.equal(manager.replay('replay', 0).headSeq, all.headSeq);
  assert.equal(manager.replay('nope', 1, 0), null);
  checks += 1;
});

test('resize changes the pty size', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'size');
  manager.resize('size', 100, 40);
  manager.write('size', 'stty size\n');
  await waitUntil(20_000, () => out.text().includes('40 100'), `output: ${JSON.stringify(out.text())}`);
  checks += 1;
});

test('shutdown all kills every shell and leaves the manager usable', async () => {
  const manager = managerWith(PLAIN_SHELL);
  const out = attachAll(manager);
  manager.registerTab('down1', os.tmpdir());
  manager.registerTab('down2', null);
  manager.open('down1', 80, 24);
  manager.open('down2', 80, 24);
  manager.write('down1', 'echo SA=$$\n');
  manager.write('down2', 'echo SB=$$\n');
  await waitUntil(20_000, () => out.numberAfter('SA=') !== null && out.numberAfter('SB=') !== null);
  const shells = [out.numberAfter('SA='), out.numberAfter('SB=')];

  await manager.shutdownAll();

  for (const shell of shells) {
    await waitUntil(3_000, () => !processAlive(shell), `shell ${shell} survived shutdownAll`);
  }
  assert.deepEqual(manager.tabIds(), [], 'tabs kept');
  assert.throws(() => manager.write('down1', 'x'), /no tab down1/, 'entry not removed');

  manager.registerTab('down1', null);
  const out2 = attach(manager, 'down1');
  manager.open('down1', 80, 24);
  manager.write('down1', 'echo AG""AIN\n');
  await waitUntil(20_000, () => out2.text().includes('AGAIN'));
  checks += 1;
});

test('close tabs ends only the listed tabs', async () => {
  const manager = managerWith(PLAIN_SHELL);
  const out = attachAll(manager);
  for (const id of ['listed1', 'listed2', 'later']) {
    manager.registerTab(id, os.tmpdir());
    manager.open(id, 80, 24);
  }
  manager.write('listed1', 'echo LA=$$\n');
  manager.write('listed2', 'echo LB=$$\n');
  manager.write('later', 'echo LC=$$\n');
  await waitUntil(
    20_000,
    () => ['LA=', 'LB=', 'LC='].every((marker) => out.numberAfter(marker) !== null),
  );
  const closed = [out.numberAfter('LA='), out.numberAfter('LB=')];
  const kept = out.numberAfter('LC=');

  await manager.closeTabs(['listed1', 'listed2', 'never-registered']);

  for (const shell of closed) {
    await waitUntil(3_000, () => !processAlive(shell), `shell ${shell} survived closeTabs`);
  }
  assert.deepEqual(manager.tabIds(), ['later']);
  assert.equal(processAlive(kept), true, "an unlisted tab's shell was killed");
  manager.write('later', 'echo ST""ILL\n');
  await waitUntil(20_000, () => out.text().includes('STILL'));
  checks += 1;
});

test('bad requests are rejected', () => {
  const manager = managerWith(PLAIN_SHELL);
  manager.registerTab('bad', null);

  assert.throws(() => manager.open('unknown', 80, 24), (error) => error.message === 'no tab unknown');
  assert.throws(() => manager.open('bad', 0, 24), /invalid terminal size 0x24/);
  assert.throws(() => manager.open('bad', 80, 0), /invalid terminal size 80x0/);
  assert.equal(manager.status('unknown'), null);
  assert.throws(() => manager.write('unknown', 'x'), /no tab unknown/);
  assert.throws(() => manager.write('bad', 'x'), /no terminal for tab bad/, 'no shell yet');
  assert.throws(() => manager.resize('unknown', 80, 24), /no tab unknown/);
  manager.ack('unknown', 1, 10); // ignored
  manager.closeTab('unknown'); // closing an unknown tab is a no-op
  assert.deepEqual(manager.tabIds(), ['bad']);
  checks += 1;
});

test('settings are validated, persisted and reloaded', async () => {
  const guard = makeTempDir('settings');
  const dir = path.join(guard, 'config');
  const file = path.join(dir, 'terminal.json');
  const reopen = () => new TerminalManager({ settingsPath: file });
  managers.push(reopen());

  const manager = reopen();
  const settings = manager.settingsPayload();
  assert.equal(settings.shell, '');
  assert.equal(path.isAbsolute(settings.defaultShell), true);
  assert.ok(Array.isArray(settings.shells));

  for (const bad of ['sh', './sh', '/definitely/not/a/shell', '/etc/hosts', '/bin']) {
    assert.throws(() => manager.setShell(bad), undefined, `${bad} must be refused`);
  }
  assert.equal(fs.existsSync(file), false, 'a refused setting was written');

  const set = manager.setShell(`  ${PLAIN_SHELL}  `);
  assert.equal(set.shell, PLAIN_SHELL, 'stored trimmed');
  assert.equal(manager.settingsPayload().shell, PLAIN_SHELL);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).shell, PLAIN_SHELL);
  const reloaded = reopen();
  managers.push(reloaded);
  assert.equal(reloaded.settingsPayload().shell, PLAIN_SHELL);

  // The setting is what the next shell runs.
  reloaded.registerTab('set', null);
  const status = reloaded.open('set', 80, 24);
  assert.equal(status.shell, PLAIN_SHELL);
  await reloaded.closeTab('set');

  assert.equal(reloaded.setShell('').shell, '');
  assert.equal(reopen().settingsPayload().shell, '');

  // A corrupt file reads as the default and is never overwritten.
  fs.writeFileSync(file, '{ not json');
  const corrupt = new TerminalManager({ settingsPath: file });
  managers.push(corrupt);
  assert.equal(corrupt.settingsPayload().shell, '');
  assert.throws(() => corrupt.setShell(PLAIN_SHELL), /terminal\.json is unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  checks += 1;
});

test('all output is out before the exit event', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'drain');
  manager.write(
    'drain',
    "echo A\"\"1; head -c 1500000 /dev/zero | tr '\\0' z; echo END\"\"9; exit 0\n",
  );
  await waitAcking(manager, out, () => out.exits.length > 0, 'no exit event');
  const seen = out.exitText;
  assert.ok(seen.includes('A1'), `before exit: ${JSON.stringify(seen.slice(0, 200))}`);
  assert.ok(seen.includes('END9'), `tail lost: ${JSON.stringify(seen.slice(-100))}`);
  assert.deepEqual(out.exitCodes(), [0]);
  checks += 1;
});

test('the exit code is read without reaping the shell', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'code7');
  manager.write('code7', 'exit 7\n');
  await waitUntil(20_000, () => out.exits.length > 0, 'no exit event');
  assert.deepEqual(out.exitCodes(), [7]);
  // Rust's writer thread is gone by now: input is refused, not queued.
  assert.throws(() => manager.write('code7', 'x'), /terminal input is closed/);

  const second = openWith(managerWith(PLAIN_SHELL), 'signalled');
  second.manager.write('signalled', 'kill -9 $$\n');
  await waitUntil(20_000, () => second.out.exits.length > 0, 'no exit event');
  assert.deepEqual(second.out.exitCodes(), [null], 'a signal has no exit code');
  const status = second.manager.status('signalled');
  assert.equal(status.state, 'exited');
  assert.equal(status.exitCode, null);
  checks += 1;
});

test('events use the channels the frontend subscribes to', async () => {
  const manager = managerWith(PLAIN_SHELL);
  manager.registerTab('wire', os.tmpdir());
  const channels = [];
  const payloads = [];
  const generic = [];
  manager.on('terminal://data/wire', (payload) => {
    channels.push('data');
    payloads.push(payload);
  });
  manager.on('terminal://exit/wire', (payload) => {
    channels.push('exit');
    payloads.push(payload);
  });
  manager.on('data', (event) => generic.push(event));
  manager.open('wire', 80, 24);
  manager.write('wire', 'echo WI""RED; exit 2\n');
  await waitUntil(20_000, () => channels.includes('exit'), 'exit event');

  const data = payloads.find((payload) => payload.b64 !== undefined);
  assert.deepEqual(Object.keys(data).sort(), ['b64', 'instance', 'seq']);
  const dataText = payloads
    .filter((payload) => payload.b64 !== undefined)
    .map((payload) => Buffer.from(payload.b64, 'base64').toString())
    .join('');
  assert.equal(dataText.includes('WIRED'), true, JSON.stringify(dataText));
  const exit = payloads.find((payload) => payload.code !== undefined);
  assert.deepEqual(Object.keys(exit).sort(), ['code', 'instance']);
  assert.equal(exit.code, 2);
  assert.equal(generic[0].tabId, 'wire');
  assert.equal(generic[0].channel, 'terminal://data/wire');
  checks += 1;
});

test('overlapping opens start one shell', async () => {
  const recorder = recordingShell('open-open');
  const manager = managerWith(recorder.shell);
  for (let round = 0; round < 5; round += 1) {
    manager.registerTab('twice', os.tmpdir());
    const first = manager.open('twice', 80, 24);
    const second = manager.open('twice', 80, 24);
    assert.equal(first.instance, second.instance, `round ${round}: two instances`);

    const expected = round + 1;
    await waitUntil(5_000, () => recordedPids(recorder.pidfile).length >= expected, 'shell never started');
    await sleep(100);
    assert.equal(recordedPids(recorder.pidfile).length, expected, `round ${round}: a second shell`);
    await manager.closeTab('twice');
  }
  checks += 1;
});

test('tree kill finds the session members of a live shell', async () => {
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'members');
  manager.write('members', 'sleep 1000 &\n');
  await sleep(100);
  manager.write('members', 'echo JOB=$!\n');
  await sleep(100);
  manager.write('members', 'echo MP=$$\n');
  await waitUntil(
    20_000,
    () => out.numberAfter('MP=') !== null && out.numberAfter('JOB=') !== null,
    'shell and job pids',
  );
  const shellPid = out.numberAfter('MP=');
  const jobPid = out.numberAfter('JOB=');
  const byGroup = listSessionMembers(shellPid, null);
  assert.ok(byGroup.includes(shellPid), `session members ${JSON.stringify(byGroup)} of ${shellPid}`);
  // An interactive shell gives the job its own process group: only the
  // controlling terminal ties it to the terminal.
  const tty = ttyOf(shellPid);
  assert.ok(tty && tty !== '?' && tty !== '??', `no tty for ${shellPid}: ${tty}`);
  const members = listSessionMembers(shellPid, tty);
  assert.ok(members.includes(jobPid), `job ${jobPid} not in ${JSON.stringify(members)}`);
  checks += 1;
});

test('a job in the shell group dies with its exited shell without any close', async () => {
  // Deviation from `a_background_job_dies_with_its_exited_shell_without_any_close`:
  // on macOS the pty hangs up at the leader's exit and the kernel drops the
  // job's tty association, so a job that moved itself into another process
  // group cannot be found any more (see the module header). A job that stays
  // in the shell's group — `set +m`, or any shell without job control — is
  // reached by the group kill.
  const { manager, out } = openWith(managerWith(PLAIN_SHELL), 'orphan');
  manager.write('orphan', 'set +m; sleep 1000 &\n');
  await sleep(100);
  manager.write('orphan', 'echo JOB=$!\n');
  await waitUntil(20_000, () => out.numberAfter('JOB=') !== null);
  const job = out.numberAfter('JOB=');
  manager.write('orphan', 'exit\n');
  await waitUntil(20_000, () => out.exits.length > 0, 'no exit event');
  // Nobody closes or replaces the terminal: the exit alone ends the job.
  await waitUntil(3_000, () => !processAlive(job), `job ${job} outlived its shell`);
  checks += 1;
});
test('a failed spawn leaves the slot idle and reports the error', async () => {
  const manager = managerWith(PLAIN_SHELL);
  manager.registerTab('fail', os.tmpdir());
  const ptyModule = createRequire(import.meta.url)('node-pty');
  const realSpawn = ptyModule.spawn;
  ptyModule.spawn = () => {
    throw new Error('posix_spawnp failed.');
  };
  try {
    assert.throws(() => manager.open('fail', 80, 24), /spawn .*posix_spawnp failed/);
  } finally {
    ptyModule.spawn = realSpawn;
  }
  assert.equal(manager.status('fail'), null, 'the slot is idle again, not stuck starting');

  // The tab stays usable once the shell resolves.
  const out = attach(manager, 'fail');
  assert.equal(manager.open('fail', 80, 24).state, 'running');
  manager.write('fail', 'echo RE""COVERED\n');
  await waitUntil(20_000, () => out.text().includes('RECOVERED'));
  checks += 1;
});
