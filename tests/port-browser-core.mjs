/* Port parity tests for electron/backend/browser-process.js and
   electron/backend/browser-broker.js.

   Mirrors:
     src-tauri/src/browser/process/{settings,locate,instance,reap,launch,
       pipe,stderr}.rs
     src-tauri/src/browser/broker/{mod,route,outbox,tests,fake}.rs
     src-tauri/src/program_setting.rs (the path rules)

   Run: node tests/port-browser-core.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BP = require('../electron/backend/browser-process.js');
const BB = require('../electron/backend/browser-broker.js');

// ── helpers ──────────────────────────────────────────────────────────────────

const scratch = [];

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_port_${name}_`));
  scratch.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function executable(file, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function textFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
}

function spawnStandIn(profile) {
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 300000)', '--', `--user-data-dir=${profile}`],
    { detached: true, stdio: 'ignore' },
  );
  child.on('error', () => {});
  child.unref();
  return child;
}

async function killAndWait(child) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.once('close', resolve);
    setTimeout(resolve, 1000);
  });
}

/** A Chromium stand-in that answers Browser.getVersion on the CDP pipe. */
function fakeBrowserSource() {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const profileArg = args.find((value) => value.startsWith('--user-data-dir='));
const profile = profileArg ? profileArg.slice('--user-data-dir='.length) : null;
if (profile) fs.mkdirSync(profile, { recursive: true });
if (process.env.FAKE_ARGV_FILE) fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(args));
const chunk = Buffer.alloc(1 << 16);
let pending = '';
for (;;) {
  let read;
  try {
    read = fs.readSync(3, chunk, 0, chunk.length, null);
  } catch {
    process.exit(0);
  }
  if (read === 0) process.exit(0);
  pending += chunk.subarray(0, read).toString('utf8');
  for (;;) {
    const end = pending.indexOf('\\u0000');
    if (end === -1) break;
    const text = pending.slice(0, end);
    pending = pending.slice(end + 1);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    const answer = message.method === 'Browser.getVersion'
      ? {
          id: message.id,
          result: {
            protocolVersion: '1.3',
            product: 'FakeChrome/1.0',
            revision: '@0',
            userAgent: 'FakeChrome',
            jsVersion: '0.0',
          },
        }
      : { id: message.id, result: {} };
    fs.writeSync(4, Buffer.from(JSON.stringify(answer) + '\\u0000'));
  }
}
`;
}

// ── program_setting path rules ───────────────────────────────────────────────

test('a typed path loses whitespace and one pair of quotes', () => {
  const cases = [
    ['  /usr/bin/fish ', '/usr/bin/fish'],
    ['"C:\\Program Files\\Git\\bin\\bash.exe"', 'C:\\Program Files\\Git\\bin\\bash.exe'],
    [' " /x " ', '/x'],
    ['"/x', '"/x'],
    ['/a"b', '/a"b'],
    ['""', ''],
    ['', ''],
  ];
  for (const [typed, expected] of cases) {
    assert.equal(BP.typedPath(typed), expected, JSON.stringify(typed));
  }
});

test('only absolute paths to executable files qualify', () => {
  const dir = tempDir('exec');
  const file = executable(path.join(dir, 'prog'));
  assert.equal(BP.isExecutableFile(file), true);
  assert.equal(BP.isExecutableFile(dir), false, 'a folder');
  assert.equal(BP.isExecutableFile('sh'), false, 'relative');
  assert.equal(BP.isExecutableFile(`${file}.missing`), false);
  const plain = textFile(path.join(dir, 'plain.txt'), 'x');
  fs.chmodSync(plain, 0o644);
  assert.equal(BP.isExecutableFile(plain), false, 'no execute bit');
});

// ── the setting ─────────────────────────────────────────────────────────────

test('setPath validates and normalises, and refusals keep the stored value', () => {
  const configDir = tempDir('settings-config');
  const home = tempDir('settings-home');
  const dir = tempDir('settings-bin');
  const bin = executable(path.join(dir, 'my-chrome'));
  const emptyRoot = tempDir('settings-root');
  const options = { configDir, home, platform: 'macArm', places: { root: emptyRoot, home, xdgCache: null, path: [], installRoots: [] } };

  assert.deepEqual(BP.settingsGet(options), {
    path: '',
    automatic: null,
    installed: [],
    error: null,
  });

  const quoted = `  "${bin}" `;
  const settings = BP.settingsSetPath(quoted, { configDir, home });
  assert.equal(settings.path, bin);
  assert.equal(settings.error, null);
  assert.deepEqual(BP.launchCandidates({ configDir, home }), [bin]);

  const refused = ['chrome', './my-chrome', path.join(dir, 'missing'), dir];
  const plain = textFile(path.join(dir, 'plain.txt'), 'x');
  fs.chmodSync(plain, 0o644);
  refused.push(plain);
  for (const bad of refused) {
    assert.throws(() => BP.settingsSetPath(bad, { configDir, home }), /Settings → Browser/, bad);
    assert.equal(BP.readSetting(path.join(configDir, 'browser.json')), bin, bad);
  }

  for (const automatic of ['', '   ', '""']) {
    BP.settingsSetPath(bin, { configDir, home });
    const next = BP.settingsSetPath(automatic, { configDir, home });
    assert.equal(next.path, '', JSON.stringify(automatic));
    assert.equal(next.error, null);
  }
});

test('a macOS app bundle stands for its executable', () => {
  const configDir = tempDir('bundle-config');
  const home = tempDir('bundle-home');
  const dir = tempDir('bundle');
  const macos = path.join(dir, 'My Browser.app', 'Contents', 'MacOS');
  const bin = executable(path.join(macos, 'My Browser'));
  const bundle = `${path.join(dir, 'My Browser.app')}/`;
  assert.equal(BP.settingsSetPath(bundle, { configDir, home }).path, bin);
  assert.throws(
    () => BP.settingsSetPath(path.join(dir, 'Missing.app'), { configDir, home }),
    /not an absolute path to an executable file/,
  );
});

test('the setting persists and a vanished browser is an error, not a fallback', () => {
  const configDir = tempDir('persist-config');
  const home = tempDir('persist-home');
  const dir = tempDir('persist-bin');
  const file = path.join(configDir, 'browser.json');
  const bin = executable(path.join(dir, 'my-chrome'));

  BP.settingsSetPath(bin, { configDir, home });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.path, bin);

  BP.resetSettingsCache();
  assert.equal(BP.settingsGet({ configDir, home }).path, bin);

  fs.rmSync(bin);
  BP.resetSettingsCache();
  assert.throws(
    () => BP.launchCandidates({ configDir, home }),
    /Settings → Browser/,
  );
  const settings = BP.settingsGet({ configDir, home });
  assert.equal(settings.path, bin, 'kept for the user to see');
  assert.notEqual(settings.error, null);
});

test('an unreadable file reads as unset and is never overwritten', () => {
  const dir = tempDir('unreadable');
  const cases = [
    ['bad.json', '{ not json'],
    ['typed.json', '{ "path": 7 }'],
  ];
  for (const [name, body] of cases) {
    const configDir = path.join(dir, name);
    const file = textFile(path.join(configDir, 'browser.json'), body);
    BP.resetSettingsCache();
    assert.equal(BP.settingsGet({ configDir, home: dir }).path, '', name);
    assert.throws(() => BP.settingsSetPath('/bin/sh', { configDir, home: dir }), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
    assert.equal(fs.readFileSync(file, 'utf8'), body, `${name}: untouched`);
  }
});

test('an unchanged value writes nothing and other keys survive a write', () => {
  const configDir = tempDir('noop');
  const file = path.join(configDir, 'browser.json');
  BP.resetSettingsCache();
  BP.settingsSetPath('', { configDir, home: configDir });
  assert.equal(fs.existsSync(file), false, 'a no-op never creates the file');

  textFile(file, '{ "other": 1 }');
  BP.resetSettingsCache();
  const bin = executable(path.join(tempDir('noop-bin'), 'chrome'));
  BP.settingsSetPath(bin, { configDir, home: configDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { other: 1, path: bin });
});

test('settings serialise in camelCase with the browser list', () => {
  const configDir = tempDir('camel');
  const home = tempDir('camel-home');
  const bin = executable(path.join(tempDir('camel-bin'), 'chrome'));
  BP.settingsSetPath(bin, { configDir, home });
  const settings = BP.settingsGet({ configDir, home });
  assert.deepEqual(Object.keys(settings).sort(), ['automatic', 'error', 'installed', 'path']);
  assert.ok(settings.installed.length >= 1);
  assert.equal(settings.automatic, settings.installed[0]);
  assert.equal(settings.path, bin);
});

// ── discovery ───────────────────────────────────────────────────────────────

test('Chrome for Testing comes first on macOS, newest version first', () => {
  const root = tempDir('locate-root');
  const home = tempDir('locate-home');
  const layout = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const old = executable(path.join(home, '.omp', 'puppeteer', 'chrome', 'mac_arm-120.0.1.0', layout));
  const recent = executable(path.join(home, '.omp', 'puppeteer', 'chrome', 'mac_arm-150.0.7871.24', layout));
  const installed = executable(
    path.join(root, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  );
  const places = { root, home, xdgCache: null, path: [], installRoots: [] };

  const found = BP.discover({ platform: 'macArm', places });
  assert.deepEqual(found.binaries, [recent, old, installed]);
  assert.deepEqual(found.skipped, []);

  const list = BP.candidates('macArm', places);
  assert.equal(list[0], recent);
  assert.ok(list.includes(installed));
});

test('discovery keeps the platform order and skips snap packages and symlinks', () => {
  const root = fs.realpathSync(tempDir('linux-root'));
  const trueBinary = executable(path.join(root, 'usr', 'lib', 'chromium', 'chromium'));
  const snapBinary = executable(path.join(root, 'snap', 'bin', 'chromium'));
  const linkDir = path.join(root, 'usr', 'bin');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(snapBinary, path.join(linkDir, 'chromium'));
  const launcher = executable(
    path.join(linkDir, 'chromium-browser'),
    '#!/bin/sh\nexec /snap/bin/chromium "$@"\n',
  );
  const places = { root, home: null, xdgCache: null, path: [linkDir], installRoots: [] };

  const found = BP.discover({ platform: 'linux', places });
  assert.deepEqual(found.binaries, [trueBinary]);
  const skipped = found.skipped.map((entry) => entry.path);
  assert.ok(skipped.includes(path.join(linkDir, 'chromium')), 'symlink into /snap');
  assert.ok(skipped.includes(launcher), 'launcher script that execs a snap');
  for (const entry of found.skipped) assert.equal(entry.reason, BP.SNAP_REASON);

  // A second name for one file is tried once (Linux launchers on PATH).
  const same = executable(path.join(linkDir, 'google-chrome'));
  fs.symlinkSync(trueBinary, path.join(linkDir, 'google-chrome-stable'));
  const again = BP.discover({ platform: 'linux', places });
  assert.ok(again.binaries.includes(trueBinary));
  assert.ok(again.binaries.includes(same));
  assert.equal(again.binaries.filter((bin) => bin === trueBinary).length, 1);
});

test('discovery on this platform only returns executable absolute files', () => {
  const platform = BP.currentPlatform();
  const expected =
    platform === 'macArm' || platform === 'macX64'
      ? ['macArm', 'macX64']
      : [platform];
  assert.ok(expected.includes(platform));
  const list = BP.candidates(platform);
  assert.ok(list.length > 0);
  if (platform === 'macArm' || platform === 'macX64') {
    assert.ok(
      list.includes(path.join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')),
      'the fixed macOS install path is a candidate',
    );
  }
  const found = BP.discover();
  const reals = new Set();
  for (const bin of found.binaries) {
    assert.ok(path.isAbsolute(bin), bin);
    assert.equal(BP.isExecutableFile(bin), true, bin);
    const real = fs.realpathSync(bin);
    assert.equal(reals.has(real), false, `duplicate ${bin}`);
    reals.add(real);
  }
});

// ── instance files ──────────────────────────────────────────────────────────

test('the overlay names the placeholder port and disables the relay', () => {
  assert.equal(
    BP.overlay(41234),
    'browser:\n  cdpUrl: "http://127.0.0.1:41234"\n  relay: false\n',
  );
  const dir = tempDir('overlay');
  const file = path.join(dir, 'session.yml');
  BP.writeOverlay(file, 41234);
  assert.equal(fs.readFileSync(file, 'utf8'), BP.overlay(41234));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => BP.writeOverlay(file, 1), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), BP.overlay(41234), 'unchanged');
});

test('private files are exclusive and never follow a symlink', () => {
  const dir = tempDir('private');
  const file = path.join(dir, 'profile.pid');
  BP.createPrivateFile(file, '1234\n');
  assert.throws(() => BP.createPrivateFile(file, '5678\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), '1234\n');

  fs.rmSync(file);
  const victim = textFile(path.join(dir, 'victim'), 'untouched');
  fs.symlinkSync(victim, file);
  assert.throws(() => BP.createPrivateFile(file, '5678\n'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
});

test("prepareInstanceDir creates this process's private directory", async () => {
  const root = path.join(tempDir('instance'), 'browser');
  const instance = await BP.prepareInstanceDir(root);
  assert.equal(root, path.dirname(instance));
  assert.equal(instance, path.join(root, String(process.pid)));
  assert.equal(fs.lstatSync(root).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(instance).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(instance).isDirectory(), true);

  const file = path.join(tempDir('instance-not-dir'), 'file');
  textFile(file, 'x');
  await assert.rejects(() => BP.prepareInstanceDir(file), /not a real directory/);
});

// ── reaping ─────────────────────────────────────────────────────────────────

test('prune removes dead instance directories and reaps their browsers', async () => {
  const root = tempDir('prune');
  const app = deadPid();
  const instance = path.join(root, String(app));
  const profiles = path.join(instance, 'profiles');
  const profile = path.join(profiles, 'b-0');
  fs.mkdirSync(profiles, { recursive: true });
  const browser = spawnStandIn(profile);
  textFile(`${profile}.pid`, `${browser.pid}\n`);

  // A live instance and a name that is not a pid are never touched.
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], {
    detached: true,
    stdio: 'ignore',
  });
  live.on('error', () => {});
  live.unref();
  fs.mkdirSync(path.join(root, String(live.pid)));
  fs.mkdirSync(path.join(root, 'not-a-pid'));

  try {
    const pruned = await BP.prune(root);
    assert.equal(pruned, 1);
    assert.equal(fs.existsSync(instance), false, "the dead instance's directory is gone");
    assert.equal(BP.pidIsAlive(browser.pid), false, 'the recorded browser was killed');
    assert.equal(fs.existsSync(path.join(root, String(live.pid))), true);
    assert.equal(fs.existsSync(path.join(root, 'not-a-pid')), true);
  } finally {
    await killAndWait(live);
    await killAndWait(browser);
  }
});

test('prune removes a dead pid directory even with a dead pid file', async () => {
  const root = tempDir('prune-deadfile');
  const app = deadPid();
  const instance = path.join(root, String(app));
  fs.mkdirSync(path.join(instance, 'profiles'), { recursive: true });
  textFile(path.join(instance, 'profiles', 'p-0.pid'), `${deadPid()}\n`);

  const pruned = await BP.prune(root);
  assert.equal(pruned, 1);
  assert.equal(fs.existsSync(instance), false);
});

test('reapOrphans leaves a process that does not use the profile', async () => {
  const instance = path.join(tempDir('reap'), 'instance');
  fs.mkdirSync(path.join(instance, 'profiles'), { recursive: true });
  const otherProfile = path.join(instance, 'profiles', 'other-0');
  const standIn = spawnStandIn(otherProfile);
  textFile(path.join(instance, 'profiles', 'ours-0.pid'), `${standIn.pid}\n`);
  try {
    await delay(50);
    assert.equal(await BP.reapOrphans(instance), true, 'nothing verified to kill');
    assert.equal(BP.pidIsAlive(standIn.pid), true, 'left running');
  } finally {
    await killAndWait(standIn);
  }
  assert.equal(await BP.reapOrphans(path.join(instance, 'missing')), true);
});

test('hasFlag requires NUL or ASCII whitespace boundaries', () => {
  const flag = Buffer.from('--user-data-dir=/cache/profiles/s1-0');
  const cases = [
    ['nul-separated', 'chromium\0--user-data-dir=/cache/profiles/s1-0\0--headless=new\0', true],
    ['rewritten linux title', 'chromium --user-data-dir=/cache/profiles/s1-0 --headless=new\0\0', true],
    ['offset zero', '--user-data-dir=/cache/profiles/s1-0', true],
    ['trailing newline', 'chromium --user-data-dir=/cache/profiles/s1-0\n', true],
    ['numeric prefix collision', 'chromium\0--user-data-dir=/cache/profiles/s1-01\0', false],
    ['hyphen prefix collision', 'chromium --user-data-dir=/cache/profiles/s1-0-other', false],
    ['space boundary suffix', 'chromium --user-data-dir=/cache/profiles/s1-0 x', true],
    ['embedded flag', 'chromium x--user-data-dir=/cache/profiles/s1-0', false],
    ['tab and CR/LF boundaries', '\t--user-data-dir=/cache/profiles/s1-0\r\n', true],
    ['vertical tab is not ascii whitespace', '\v--user-data-dir=/cache/profiles/s1-0\v', false],
    ['later bounded occurrence', 'x--user-data-dir=/cache/profiles/s1-0 --user-data-dir=/cache/profiles/s1-0', true],
    ['no match', 'chromium --headless=new', false],
    ['empty command', '', false],
  ];
  for (const [name, cmdline, expected] of cases) {
    assert.equal(BP.hasFlag(Buffer.from(cmdline), flag), expected, name);
  }
});

test('pid probes refuse our own group', () => {
  assert.equal(BP.pidIsAlive(process.pid), true);
  assert.equal(BP.pidIsAlive(0), false);
  assert.equal(BP.killGroupIfLeader(process.pid), false);
  assert.equal(BP.killGroupIfLeader(0), false);
});

test('tailText keeps the last whole lines', () => {
  assert.equal(BP.tailText(Buffer.from('')), null);
  assert.equal(BP.tailText(Buffer.from('\n  \n')), null);
  assert.equal(
    BP.tailText(Buffer.from('first\n\n  [1:2:ERROR] No usable sandbox!  \n')),
    'first | [1:2:ERROR] No usable sandbox!',
  );
  const long = Buffer.concat([
    Buffer.from('x'.repeat(BP.TAIL_BYTES)),
    Buffer.from('\nthe reason\n'),
  ]);
  assert.equal(BP.tailText(long), 'the reason', 'the cut line is dropped');
  const clipped = Buffer.concat([
    Buffer.from('earlier\n'),
    Buffer.from('z'.repeat(3 * BP.TAIL_BYTES)),
  ]);
  assert.equal(BP.tailText(clipped), 'z'.repeat(BP.TAIL_BYTES));
});

// ── launch ──────────────────────────────────────────────────────────────────

test('the command args carry the isolation flags and no debugging port', () => {
  const args = BP.commandArgs('/tmp/profile', 800, 600);
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--user-data-dir=/tmp/profile'));
  assert.ok(args.includes('--disable-extensions'));
  assert.ok(args.includes('--use-mock-keychain'));
  assert.ok(args.includes('--password-store=basic'));
  assert.equal(args[args.length - 1], 'about:blank');
  assert.equal(args.some((arg) => arg.startsWith('--remote-debugging-port')), false);
  const features = args.filter((arg) => arg.startsWith('--disable-features='));
  assert.equal(features.length, 1);
  assert.ok(features[0].slice('--disable-features='.length).split(',').includes('BackForwardCache'));
});

test('launch starts a browser with the CDP pipe and stops cleanly', async () => {
  const dir = tempDir('launch');
  const fake = executable(path.join(dir, 'fake-chrome'), fakeBrowserSource());
  const instanceDir = path.join(dir, 'instance');
  const argvFile = path.join(dir, 'argv.json');
  const saved = process.env.FAKE_ARGV_FILE;
  process.env.FAKE_ARGV_FILE = argvFile;
  let browser = null;
  try {
    browser = await BP.launch({ binaries: [fake], instanceDir, sessionId: 's1', width: 640, height: 480 });
    assert.equal(typeof browser.pid, 'number');
    assert.equal(browser.instanceDir, instanceDir);
    assert.ok(browser.pipes.fromChromium);
    assert.ok(browser.pipes.toChromium);
    assert.equal(browser.isAlive(), true);

    const version = await browser.broker.request('Browser.getVersion', {}, 5000);
    assert.equal(version.product, 'FakeChrome/1.0');
    assert.equal(browser.broker.id, browser.broker.browserId);
    assert.match(browser.broker.id, /^[0-9a-f]{8}-[0-9a-f]+$/);

    const profile = path.join(instanceDir, 'profiles', 's1-0');
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.ok(argv.includes('--remote-debugging-pipe'), argv.join(' '));
    assert.ok(argv.includes(`--user-data-dir=${profile}`));
    assert.ok(argv.includes('--window-size=640,480'));
    assert.equal(
      argv.some((arg) => arg.startsWith('--remote-debugging-port')),
      false,
      'Chromium opens no debugging port',
    );
    assert.equal(fs.existsSync(path.join(profile, 'DevToolsActivePort')), false);
    assert.equal(fs.existsSync(`${profile}.pid`), true);
    assert.equal(fs.readFileSync(`${profile}.pid`, 'utf8').trim(), String(browser.pid));

    const pid = browser.pid;
    await browser.stop();
    assert.equal(fs.existsSync(profile), false, 'profile removed');
    assert.equal(fs.existsSync(`${profile}.pid`), false, 'pid file removed');
    assert.equal(BP.pidIsAlive(pid), false, 'process reaped when stop returns');
    assert.equal(browser.isAlive(), false);
    assert.equal(browser.broker.isAlive(), false);
    await browser.stop(); // idempotent
    assert.equal(await browser.stderrTailOnDeath(), null);
  } finally {
    if (browser && browser.isAlive()) await browser.stop();
    if (saved === undefined) delete process.env.FAKE_ARGV_FILE;
    else process.env.FAKE_ARGV_FILE = saved;
  }
});

test('launch falls back to the next binary and removes the failed profile', async () => {
  const dir = tempDir('fallback');
  const dies = executable(path.join(dir, 'dies'), '#!/bin/sh\nexit 1\n');
  const works = executable(path.join(dir, 'works'), fakeBrowserSource());
  const instanceDir = path.join(dir, 'instance');
  const browser = await BP.launch({
    binaries: [dies, path.join(dir, 'missing'), works],
    instanceDir,
    sessionId: 's1',
  });
  try {
    assert.equal(browser.isAlive(), true);
    assert.equal(fs.existsSync(path.join(instanceDir, 'profiles', 's1-0')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, 'profiles', 's1-1')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, 'profiles', 's1-2')), true);
  } finally {
    await browser.stop();
  }
});

test('a failed launch cleans up and reports each binary stderr', async () => {
  const dir = tempDir('launch-fail');
  const first = executable(
    path.join(dir, 'first'),
    '#!/bin/sh\necho "No usable sandbox!" >&2\nexit 1\n',
  );
  const second = executable(
    path.join(dir, 'second'),
    '#!/bin/sh\necho "libnss3.so: cannot open" >&2\nexit 127\n',
  );
  const instanceDir = path.join(dir, 'instance');
  const error = await BP.launch({ binaries: [first, second], instanceDir, sessionId: 's1' }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /exited early/);
  assert.match(error.message, /No usable sandbox!/);
  assert.match(error.message, /libnss3.so: cannot open/);
  for (const n of [0, 1]) {
    const profile = path.join(instanceDir, 'profiles', `s1-${n}`);
    assert.equal(fs.existsSync(profile), false, 'profile removed');
    assert.equal(fs.existsSync(`${profile}.pid`), false, 'pid file removed');
  }
});

test('launch gives up after MAX_ATTEMPTS binaries', async () => {
  const dir = tempDir('launch-bounded');
  const bins = [];
  for (let n = 0; n <= BP.MAX_ATTEMPTS; n += 1) {
    bins.push(executable(path.join(dir, `dies-${n}`), '#!/bin/sh\nexit 1\n'));
  }
  const error = await BP.launch({
    binaries: bins,
    instanceDir: path.join(dir, 'instance'),
    sessionId: 's1',
  }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(bins[BP.MAX_ATTEMPTS]), false, error.message);
});

test('a binary that closes its pipe makes way for the next', async () => {
  const dir = tempDir('launch-no-pipe');
  const closes = executable(path.join(dir, 'closes'), '#!/bin/sh\nexit 0\n');
  const works = executable(path.join(dir, 'works'), fakeBrowserSource());
  const instanceDir = path.join(dir, 'instance');
  const browser = await BP.launch({ binaries: [closes, works], instanceDir, sessionId: 's1' });
  try {
    assert.equal(browser.isAlive(), true);
    assert.equal(fs.existsSync(path.join(instanceDir, 'profiles', 's1-0')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, 'profiles', 's1-1')), true);
  } finally {
    await browser.stop();
  }
});

// ── broker: outbox (outbox.rs) ──────────────────────────────────────────────

test('outbox keeps order and queued messages survive close', async () => {
  const outbox = new BB.Outbox();
  assert.equal(outbox.push('a'), true);
  assert.equal(outbox.push('b'), true);
  outbox.close();
  assert.equal(outbox.push('c'), false, 'closed: refused');
  assert.deepEqual(await outbox.recv(0), { type: 'message', text: 'a' });
  assert.deepEqual(await outbox.recv(0), { type: 'message', text: 'b' });
  assert.deepEqual(await outbox.recv(0), { type: 'closed' });
});

test('an empty open outbox times out', async () => {
  const outbox = new BB.Outbox();
  assert.deepEqual(await outbox.recv(10), { type: 'timeout' });
});

test('the message at the head does not count toward overflow', async () => {
  const outbox = new BB.Outbox(10);
  assert.equal(outbox.push('h'.repeat(11)), true, 'alone: accepted');
  assert.equal(outbox.push('x'.repeat(10)), true, 'the head is not counted');
  assert.equal(outbox.push('y'), false, 'a byte over the cap cuts the client');
  assert.equal(outbox.isClosed(), true);
  assert.deepEqual(await outbox.recv(0), { type: 'closed' }, 'the backlog is dropped');
});

test('the cap moves with the head', async () => {
  const outbox = new BB.Outbox(10);
  assert.equal(outbox.push('a'.repeat(6)), true);
  assert.equal(outbox.push('b'.repeat(6)), true);
  assert.deepEqual(await outbox.recv(0), { type: 'message', text: 'a'.repeat(6) });
  assert.equal(outbox.push('c'.repeat(10)), true);
  assert.equal(outbox.push('d'), false);
});

test('offer refuses without closing and close wakes a waiting reader', async () => {
  const outbox = new BB.Outbox(10);
  assert.equal(outbox.offer('h'.repeat(20)), 'ok');
  assert.equal(outbox.offer('x'.repeat(10)), 'ok');
  assert.equal(outbox.offer('y'), 'full');
  assert.equal(outbox.isClosed(), false);
  assert.equal(await outbox.nextUntilClosed(), 'h'.repeat(20));
  assert.equal(outbox.offer('y'), 'ok');
  assert.equal(outbox.offer('z'.repeat(10)), 'full');
  assert.deepEqual(await outbox.recv(0), { type: 'message', text: 'x'.repeat(10) });
  outbox.close();
  assert.equal(outbox.offer('z'), 'closed');
  assert.equal(await outbox.nextUntilClosed(), null, 'closed: the rest is dropped');

  const waiting = new BB.Outbox();
  const read = waiting.recv(30_000);
  const take = waiting.nextUntilClosed();
  await delay(20);
  waiting.close();
  assert.deepEqual(await read, { type: 'closed' });
  assert.equal(await take, null);
});

// ── broker: routing (route.rs, tests.rs) ────────────────────────────────────

test('clients with the same ids each get their own replies', async () => {
  const fake = await BB.FakeBroker.create((request) => [
    { id: request.id, result: { n: request.params.n } },
  ]);
  const a = fake.broker.client();
  const b = fake.broker.client();
  try {
    const [answerA, answerB] = await Promise.all([
      a.send('Echo', { n: 'a' }),
      b.send('Echo', { n: 'b' }),
    ]);
    assert.deepEqual(answerA, { n: 'a' });
    assert.deepEqual(answerB, { n: 'b' });
  } finally {
    a.close();
    b.close();
    fake.broker.close();
  }
});

test('a refused message is answered without reaching chromium', async () => {
  const seen = [];
  const fake = await BB.FakeBroker.create((request) => {
    seen.push(request.method);
    return [{ id: request.id, result: {} }];
  });
  const client = fake.broker.client();
  try {
    await assert.rejects(
      client.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'someone-elses' }),
      (error) => error.code === -32001,
    );
    assert.equal(seen.includes('Runtime.evaluate'), false, 'never reached chromium');
    assert.throws(
      () => fake.broker._outbound(client._id, 'not json', 999),
      (reply) => JSON.parse(reply).error.code === -32700,
    );
    await client.send('Reached', {});
    assert.deepEqual(seen, ['Reached'], 'only the valid one');
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('a command over the pipe limit is refused without reaching chromium', async () => {
  const seen = [];
  const fake = await BB.FakeBroker.create((request) => {
    seen.push(request.method);
    return [{ id: request.id, result: {} }];
  });
  const client = fake.broker.client();
  try {
    const big = 'x'.repeat(BB.MAX_COMMAND);
    await assert.rejects(
      client.send('Big', { pad: big }),
      (error) => error.code === -32600 && /too long/.test(error.message),
    );
    await client.send('Small', {});
    assert.deepEqual(seen, ['Small']);
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('a reply without a session reaches its sender, not a root call', async () => {
  let held = null;
  const fake = await BB.FakeBroker.create((request) => {
    if (request.method === 'Hold') {
      held = request.id;
      return [];
    }
    if (request.method === 'Stale') {
      const answers = [
        {
          id: request.id,
          sessionId: null,
          error: { code: -32001, message: 'Session with given id not found.' },
        },
      ];
      if (held !== null) {
        answers.push({ id: held, sessionId: null, result: { held: true } });
        held = null;
      }
      return answers;
    }
    return [{ id: request.id, result: {} }];
  });
  const client = fake.broker.client();
  try {
    const pending = fake.broker.request('Hold', {});
    await delay(20);
    await assert.rejects(
      client.send('Stale', {}),
      (error) => error.code === -32001,
    );
    assert.deepEqual(await pending, { held: true });
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('closing a client detaches its root and root names are not reused', async () => {
  const fake = await BB.FakeBroker.create((request) => [{ id: request.id, result: {} }]);
  try {
    const client = fake.broker.client();
    await client.send('X', {});
    assert.deepEqual(fake.liveRoots, ['root-1']);
    client.close();
    await delay(20);
    assert.deepEqual(fake.liveRoots, [], 'the root was detached');

    const again = fake.broker.client();
    await again.send('X', {});
    assert.deepEqual(fake.liveRoots, ['root-2'], 'a root name is not reused');
    again.close();
  } finally {
    fake.broker.close();
  }
});

test('a refused attach adds no client', async () => {
  const fake = await BB.FakeBroker.create(
    (request) => [{ id: request.id, result: {} }],
    { refuseBrowserAttach: true },
  );
  const client = fake.broker.client();
  try {
    await assert.rejects(client.send('X', {}), /Browser attach refused/);
    assert.deepEqual(fake.liveRoots, []);
    assert.equal(fake.broker._clients.size, 0);
    assert.equal(fake.broker._attaching.size, 0);
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('chromium going away ends every client and root call', async () => {
  const fake = await BB.FakeBroker.create((request) =>
    request.method === 'Crash' ? null : [{ id: request.id, result: {} }],
  );
  const client = fake.broker.client();
  const closed = new Promise((resolve) => client.on('close', resolve));
  try {
    await client.send('X', {});
    const crashing = client.send('Crash', {});
    await closed;
    await assert.rejects(crashing, /browser connection closed/);
    assert.equal(fake.broker.isAlive(), false);
    await assert.rejects(client.send('Y', {}), /browser connection closed/);
    await assert.rejects(fake.broker.request('Browser.getVersion', {}), /browser connection closed/);
    let refused = null;
    const late = fake.broker.client();
    await late.send('Z', {}).catch((error) => {
      refused = error;
    });
    assert.match(refused.message, /browser connection closed/);
  } finally {
    fake.broker.close();
  }
});

test('a root detach ends the browser client only', async () => {
  const fake = await BB.FakeBroker.create((request) => {
    if (request.method === 'Close') {
      return [
        { sessionId: null, method: 'Target.detachedFromTarget', params: { sessionId: 'root-1' } },
      ];
    }
    return [{ id: request.id, result: {} }];
  });
  const client = fake.broker.client();
  const closed = new Promise((resolve) => client.on('close', resolve));
  try {
    await client.send('X', {});
    const closing = client.send('Close', {});
    await closed;
    await assert.rejects(closing, /browser connection closed/);
    assert.equal(fake.broker.isAlive(), true, 'only the client ends');
  } finally {
    fake.broker.close();
  }
});

test('sessionFor attaches once per target and re-attaches after detach', async () => {
  let attaches = 0;
  const fake = await BB.FakeBroker.create((request) => {
    if (request.method === 'Target.attachToTarget') {
      attaches += 1;
      return [{ id: request.id, result: { sessionId: `child-${attaches}` } }];
    }
    if (request.method === 'Detach') {
      return [
        { method: 'Target.detachedFromTarget', params: { sessionId: 'child-1' } },
        { id: request.id, result: {} },
      ];
    }
    if (request.method === 'Emit') {
      return [
        { id: request.id, result: {} },
        { sessionId: 'child-2', method: 'Page.loadEventFired', params: { timestamp: 1 } },
      ];
    }
    return [{ id: request.id, result: {} }];
  });
  const client = fake.broker.client();
  try {
    const [first, second] = await Promise.all([
      client.sessionFor('T'),
      client.sessionFor('T'),
    ]);
    assert.equal(first, 'child-1');
    assert.equal(second, 'child-1');
    assert.equal(attaches, 1, 'the flattened attach is cached');
    assert.equal(await client.sessionFor('T'), 'child-1');

    const events = [];
    client.on('event', (event) => events.push(event));
    await client.send('Detach', {});
    await delay(10);
    assert.equal(await client.sessionFor('T'), 'child-2', 'a detached session is not reused');
    assert.equal(attaches, 2);
    assert.equal(events.some((event) => event.method === 'Target.detachedFromTarget'), true);

    await client.send('Emit', {});
    await delay(20);
    const delivered = events.find((event) => event.method === 'Page.loadEventFired');
    assert.ok(delivered, 'the event was delivered');
    assert.equal(delivered.sessionId, 'child-2');
    assert.deepEqual(delivered.params, { timestamp: 1 });

    // A command addressed to the flattened session keeps its sessionId.
    const session = await client.sessionFor('T');
    const result = await client.send('Page.enable', {}, { sessionId: session });
    assert.deepEqual(result, {});
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('frames split across chunks are routed', async () => {
  const fake = await BB.FakeBroker.create((request) => [{ id: request.id, result: {} }]);
  const client = fake.broker.client();
  try {
    await client.send('X', {});
    const event = new Promise((resolve) => client.once('event', resolve));
    const text = '{"sessionId":"root-1","method":"Ping","params":{"a":1}}';
    fake.pipePair.from.write(Buffer.from(text.slice(0, 20)));
    await delay(10);
    fake.pipePair.from.write(Buffer.from(`${text.slice(20)}\u0000`));
    const delivered = await event;
    assert.equal(delivered.method, 'Ping');
    assert.deepEqual(delivered.params, { a: 1 });
    assert.equal(delivered.sessionId, undefined, "the client's root session is stripped");
  } finally {
    client.close();
    fake.broker.close();
  }
});

test('an outbox that overflows cuts its client and its sessions', async () => {
  const fake = await BB.FakeBroker.create(
    (request) => {
      if (request.method === 'Flood') {
        const answers = [{ id: request.id, result: {} }];
        for (let n = 0; n < 40; n += 1) {
          answers.push({ method: 'Event', params: { pad: 'x'.repeat(100) } });
        }
        return answers;
      }
      return [{ id: request.id, result: {} }];
    },
    { maxQueuedBytes: 512 },
  );
  const client = fake.broker.client();
  const closed = new Promise((resolve) => client.on('close', resolve));
  try {
    await client.send('Flood', {});
    await closed;
    assert.equal(fake.broker.isAlive(), true);
    await assert.rejects(client.send('X', {}), /browser connection closed/);
    await delay(20);
    assert.deepEqual(fake.liveRoots, [], 'the overflowed client is detached');
  } finally {
    fake.broker.close();
  }
});

test('broker close is idempotent and ends its fake', async () => {
  const fake = await BB.FakeBroker.create((request) => [{ id: request.id, result: {} }]);
  const client = fake.broker.client();
  await client.send('X', {});
  fake.broker.close();
  fake.broker.close();
  assert.equal(fake.broker.isAlive(), false);
  await fake.done;
  assert.equal(fake.finished, true);
});

test('the close of a broker with no clients still ends the fake', async () => {
  const fake = await BB.FakeBroker.create((request) => [{ id: request.id, result: {} }]);
  const roots = fake.broker.request(BB.ROOTS, {});
  assert.deepEqual((await roots).roots, []);
  fake.broker.close();
  await fake.done;
});

test('pipe framing constants mirror Rust', () => {
  assert.equal(BB.MAX_MESSAGE, 256 << 20);
  assert.equal(BB.MAX_COMMAND, (100 << 20) - (64 << 10));
  assert.equal(BB.MAX_QUEUED, 64 << 20);
  assert.equal(BB.ATTACH_TIMEOUT, 10_000);
  assert.equal(BB.ROOTS, 'Fixture.roots');
  assert.equal(BB.ATTACH_REFUSED, 'Fixture.refusedTarget');
  assert.equal(BB.DETACHED_AT_ONCE, 'Fixture.detachedTarget');
});