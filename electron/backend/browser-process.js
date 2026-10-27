'use strict';

/* The Chromium processes behind the browser panel: which browser to run (the
 * user's `browser.json` setting or automatic discovery), starting it with a
 * CDP pipe, the private files of this app instance, and reaping what a crashed
 * earlier run left behind.
 *
 * Port of src-tauri/src/browser/process/{mod,settings,locate,launch,pipe,
 * instance,reap,stderr}.rs, plus the small `program_setting` path rules the
 * browser setting shares with the terminal's shell.
 *
 * ── pipe hand-off, and where Node cannot follow Rust ────────────────────────
 *
 * Chromium is started with `--remote-debugging-pipe`: it reads CDP on fd 3 and
 * writes it on fd 4, and opens NO debugging port (the placeholder port
 * listener in front of it is the proxy's job, not this module's).
 *
 * Rust (`process/pipe.rs`) creates two anonymous pipes and, in the forked
 * child's `pre_exec`, duplicates the child's ends to fd 3/4 with
 * `fcntl(F_DUPFD, 10)` first so neither `dup2` clobbers the other. Node cannot
 * express `pre_exec`, but it does not need to: `spawn` with
 * `stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']` asks libuv for pipes
 * on fd 3 and 4 and libuv duplicates them onto exactly those descriptors in
 * the child. The option list in the batch context spelled stderr as 'ignore';
 * it is 'pipe' here because launch()'s contract includes `stderrTailOnDeath`
 * and Rust pipes Chromium's stderr for the same reason.
 *
 * Gaps versus Rust, on macOS:
 *  - Rust's macOS `attach` creates the pipe under the exclusive spawn gate
 *    (`crate::spawn_gate`), because `std::io::pipe` opens the fds before
 *    setting close-on-exec: no other child may fork in that window. libuv
 *    marks its pipe ends close-on-exec immediately after creating them and
 *    duplicates the child's ends inside the child, so the exposed window is
 *    only libuv-internal — but there is no cross-spawn gate in Node. A child
 *    this app spawns concurrently in that tiny window could inherit a copy of
 *    the ends, which would keep the pipe from reaching EOF when Chromium
 *    dies. The stderr-end watcher (`stderrTailOnDeath`'s reader closes the
 *    broker) and the child's own `exit` event are the backstop.
 *  - On Windows Rust hands Chromium `--remote-debugging-io-pipes=<read>,
 *    <write>` with inheritable handle values, set under the same gate. Node
 *    exposes no way to read a stream's OS HANDLE, so that flag cannot be
 *    built: `launch()` refuses on win32 instead of starting a browser the
 *    app could not talk to.
 *  - Node's `detached: true` puts the child in a new session (`setsid`) where
 *    Rust calls `process_group(0)` (a new process group in this session). Both
 *    leave pid == pgid, so `process-group kill` and the reaper's
 *    "leads its own group" check behave the same; only a controlling terminal
 *    differs, and a headless browser has none.
 *  - No Win32 Job Object: a Windows stop kills the direct child only (the
 *    `reap.js` Job Object gap, stated here once).
 *
 * The setting follows `program_setting.rs`: an absolute path to an executable
 * file, empty for automatic discovery; a macOS `.app` bundle stands for its
 * executable; an unreadable file reads as automatic but a change refuses to
 * overwrite it. A configured browser that stops being executable is a launch
 * error, never a silent fallback.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const { connect } = require('./browser-broker');

const APP_ID = 'dev.ohMyPi.desktop';

/** Longest a fresh Chromium gets to answer on its debugging pipe. */
const LAUNCH_TIMEOUT = 10_000;
const POLL_INTERVAL = 50;

/** How long a browser whose pipe failed at start gets to show it exited. */
const EXIT_GRACE = 1_000;

/** Most binaries one launch tries. */
const MAX_ATTEMPTS = 3;

/** Initial window of every launched Chromium; the panel resizes it later. */
const WINDOW = Object.freeze({ width: 1280, height: 800 });

/** Bytes of stderr kept for a failed start. */
const TAIL_BYTES = 2048;

/** How long settling waits for the stderr reader to see the end. */
const SETTLE = 500;

const SNAP_REASON =
  'a snap package; snap confinement keeps it out of the hidden cache folder its profile lives in';

// ── platform discovery (locate.rs) ──────────────────────────────────────────

const Platform = Object.freeze({
  LINUX: 'linux',
  MAC_ARM: 'macArm',
  MAC_X64: 'macX64',
  WINDOWS: 'windows',
});

/** The platform this build runs on. */
function currentPlatform() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? Platform.MAC_ARM : Platform.MAC_X64;
  if (process.platform === 'win32') return Platform.WINDOWS;
  return Platform.LINUX;
}

function cftPrefixes(platform) {
  switch (platform) {
    case Platform.LINUX:
      return ['linux'];
    case Platform.MAC_ARM:
      return ['mac_arm'];
    case Platform.MAC_X64:
      return ['mac', 'mac_x64'];
    case Platform.WINDOWS:
      return ['win64', 'win32'];
    default:
      return [];
  }
}

function cftLayout(platform) {
  switch (platform) {
    case Platform.LINUX:
      return 'chrome-linux64/chrome';
    case Platform.MAC_ARM:
      return 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    case Platform.MAC_X64:
      return 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    case Platform.WINDOWS:
      return 'chrome-win64/chrome.exe';
    default:
      return '';
  }
}

/** Linux browser binaries that are not wrapper scripts, by package layout. */
const LINUX_BINARIES = [
  'opt/google/chrome/chrome',
  'usr/lib/chromium/chromium',
  'usr/lib/chromium-browser/chromium-browser',
  'usr/lib64/chromium-browser/chromium-browser',
  'usr/lib64/chromium/chromium',
  'opt/google/chrome-beta/chrome',
  'opt/google/chrome-unstable/chrome',
  'opt/microsoft/msedge/msedge',
  'opt/brave.com/brave/brave',
];

/** Linux launcher names on PATH; last resort (their flag files would leak in). */
const LINUX_LAUNCHERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

/** macOS app bundles, under `/Applications` and `~/Applications`. */
const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
  'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

/** Windows installs, under each install root. */
const WINDOWS_INSTALLS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'Chromium\\Application\\chrome.exe',
  'Google\\Chrome Beta\\Application\\chrome.exe',
];

function childPathDirs() {
  const raw = process.env.PATH || '';
  return raw
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.isAbsolute(dir));
}

function windowsInstallRoots() {
  return ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
    .map((name) => process.env[name])
    .filter((value) => typeof value === 'string' && value !== '');
}

/**
 * Where discovery looks. `options` overrides any field (tests point them into
 * a temp dir); defaults are the running system, like `Places::current`.
 */
function places(options = {}) {
  const home = 'home' in options ? options.home : os.homedir();
  const xdgCache = 'xdgCache' in options ? options.xdgCache : process.env.XDG_CACHE_HOME || null;
  return {
    root: options.root ?? '/',
    home,
    xdgCache,
    path: options.path ?? childPathDirs(),
    installRoots: options.installRoots ?? windowsInstallRoots(),
  };
}

/** An absolute path to an executable file (`program_setting::is_executable_file`). */
function isExecutableFile(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The numeric version of a `<platform>-<version>` directory name. */
function versionOf(name) {
  const dash = name.indexOf('-');
  if (dash === -1) return null;
  const parts = name.slice(dash + 1).split('.');
  const version = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
    version.push(Number(part));
  }
  return version;
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** The Chrome for Testing binaries under `root` built for `platform`, newest first. */
function chromeForTesting(platform, root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const dash = entry.name.indexOf('-');
    if (dash === -1) continue;
    const prefix = entry.name.slice(0, dash);
    if (!cftPrefixes(platform).includes(prefix)) continue;
    const version = versionOf(entry.name);
    if (version === null) continue;
    const binary = path.join(root, entry.name, cftLayout(platform));
    let stat;
    try {
      stat = fs.statSync(binary);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    found.push({ version, binary });
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found.map((entry) => entry.binary);
}

/** Every candidate path for `platform`, best first. Existence is not checked. */
function candidates(platform, p = places()) {
  const cftRoots = [];
  if (platform !== Platform.WINDOWS && p.xdgCache) {
    const omp = path.join(p.xdgCache, 'omp');
    if (isDirectory(omp)) cftRoots.push(path.join(omp, 'puppeteer', 'chrome'));
  }
  if (p.home) cftRoots.push(path.join(p.home, '.omp', 'puppeteer', 'chrome'));
  const cft = () => {
    const out = [];
    for (const root of cftRoots) out.push(...chromeForTesting(platform, root));
    return out;
  };
  switch (platform) {
    case Platform.LINUX: {
      const out = LINUX_BINARIES.map((rel) => path.join(p.root, rel));
      out.push(...cft());
      for (const name of LINUX_LAUNCHERS) {
        for (const dir of p.path) out.push(path.join(dir, name));
      }
      return out;
    }
    case Platform.MAC_ARM:
    case Platform.MAC_X64: {
      const out = cft();
      const appDirs = [path.join(p.root, 'Applications')];
      if (p.home) appDirs.push(path.join(p.home, 'Applications'));
      for (const apps of appDirs) {
        for (const rel of MAC_APPS) out.push(path.join(apps, rel));
      }
      return out;
    }
    case Platform.WINDOWS: {
      const out = cft();
      for (const rel of WINDOWS_INSTALLS) {
        for (const root of p.installRoots) out.push(path.join(root, rel));
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * Whether `candidate` (resolving to `real`) starts a snap package: it resolves
 * into `<root>/snap` or to `snap` itself, or it is a small `#!` script that
 * execs one.
 */
function isSnap(candidate, real, root) {
  const SCRIPT_CAP = 16 * 1024;
  if (real === path.join(root, 'snap') || real.startsWith(`${path.join(root, 'snap')}${path.sep}`)) {
    return true;
  }
  if (path.basename(real) === 'snap') return true;
  let head;
  try {
    const fd = fs.openSync(candidate, 'r');
    try {
      head = Buffer.alloc(SCRIPT_CAP);
      const read = fs.readSync(fd, head, 0, SCRIPT_CAP, 0);
      head = head.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return head.length >= 2 && head[0] === 0x23 && head[1] === 0x21 && head.includes('/snap/');
}

/**
 * The executable candidates for `platform`, each file once, minus snap
 * packages. `{binaries, skipped: [{path, reason}]}`.
 */
function discover(options = {}) {
  const platform = options.platform ?? currentPlatform();
  const p = options.places ?? places(options);
  const found = { binaries: [], skipped: [] };
  const seen = new Set();
  for (const candidate of candidates(platform, p)) {
    if (!isExecutableFile(candidate)) continue;
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      real = candidate;
    }
    if (seen.has(real)) continue;
    if (platform === Platform.LINUX && isSnap(candidate, real, p.root)) {
      found.skipped.push({ path: candidate, reason: SNAP_REASON });
    } else {
      found.binaries.push(candidate);
    }
    seen.add(real);
  }
  return found;
}

// ── the setting (settings.rs + program_setting.rs) ──────────────────────────

/** `browser.json` values read in this process, keyed by file (`<memory>` when
 *  there is none): reads never touch the disk again, like ProgramSetting. */
const settingsCache = new Map();
const MEMORY = '\u0000memory';
let tempCounter = 0;

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** The per-user app config folder this port uses, or null when there is none.
 *  `OMP_PORT_CONFIG_DIR` overrides it (tests, and the packaged app's own
 *  choice). Mirrors Rust `config_dir`: an absolute path only. */
function resolveConfigDir(options = {}) {
  if ('configDir' in options) {
    if (options.configDir === null) return null;
    if (!path.isAbsolute(options.configDir)) {
      throw new Error('app config dir is not an absolute path');
    }
    return options.configDir;
  }
  const override = process.env.OMP_PORT_CONFIG_DIR;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new Error('OMP_PORT_CONFIG_DIR is not an absolute path');
    }
    return override;
  }
  const home = options.home ?? os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_ID);
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    const base = appdata && path.isAbsolute(appdata) ? appdata : path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_ID);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, APP_ID);
}

function settingsFile(configDir) {
  return configDir === null ? null : path.join(configDir, 'browser.json');
}

/** A path setting as the user typed it: trimmed, one pair of surrounding
 *  double quotes dropped (Windows "Copy as path"). */
function typedPath(input) {
  const text = String(input).trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** The executable of the macOS app bundle `bundle`, or null when it is not a
 *  `.app` directory. */
function appBundleBinary(bundlePath) {
  const bundle = String(bundlePath).replace(/\/+$/, '');
  const name = path.basename(bundle);
  if (!name.endsWith('.app')) return null;
  if (!isDirectory(bundle)) return null;
  return `${bundle}/Contents/MacOS/${name.slice(0, -'.app'.length)}`;
}

/** A configured browser path: an absolute path to an executable file. */
function configuredBinary(browserPath) {
  if (isExecutableFile(browserPath)) return browserPath;
  throw new Error(
    `the browser ${JSON.stringify(browserPath)} set in Settings → Browser is not an absolute path to an executable file`,
  );
}

function readStrictObject(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const value = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('not a JSON object');
  }
  return value;
}

function writeAtomic(file, text) {
  const temp = path.join(
    path.dirname(file),
    `${path.basename(file)}.${process.pid}-${(tempCounter += 1)}.tmp`,
  );
  let fd = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Never created, or already gone.
    }
    throw error;
  }
}

/** The stored path: '' when the file is missing or unreadable (ProgramSetting). */
function readSetting(file) {
  const key = file === null ? MEMORY : file;
  if (settingsCache.has(key)) return settingsCache.get(key);
  let value = '';
  if (file !== null) {
    try {
      const stored = readStrictObject(file).path;
      if (stored === undefined) value = '';
      else if (typeof stored === 'string') value = stored;
      else throw new Error(`\`path\` is not a string: ${JSON.stringify(stored)}`);
    } catch (error) {
      console.warn(`[omp-desktop] ${file} unreadable, using the default: ${error.message}`);
      value = '';
    }
  }
  settingsCache.set(key, value);
  return value;
}

/** Store `value`; refuses to replace a file it cannot read; keeps other keys;
 *  an unchanged value writes nothing. */
function writeSetting(file, value) {
  const key = file === null ? MEMORY : file;
  if (file === null) {
    settingsCache.set(key, value);
    return;
  }
  let data;
  try {
    data = readStrictObject(file);
  } catch (error) {
    throw new Error(`${file} is unreadable: ${error.message}`);
  }
  if ('path' in data && typeof data.path !== 'string') {
    throw new Error(`${file} is unreadable: \`path\` is not a string: ${JSON.stringify(data.path)}`);
  }
  if ((data.path ?? '') === value) {
    settingsCache.set(key, value);
    return;
  }
  data.path = value;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, JSON.stringify(data, null, 2));
  settingsCache.set(key, value);
}

/** Forget the in-memory copies (tests; Rust has no equivalent). */
function resetSettingsCache() {
  settingsCache.clear();
}

/**
 * `{path, automatic, installed, error}` — what the Settings → Browser rows
 * show. Checks files.
 */
function settingsGet(options = {}) {
  const file = 'file' in options ? options.file : settingsFile(resolveConfigDir(options));
  const stored = readSetting(file);
  const discovered = discover(options);
  const installed = discovered.binaries;
  let error = null;
  if (stored !== '') {
    try {
      configuredBinary(stored);
    } catch (failure) {
      error = failure.message;
    }
  }
  return {
    path: stored,
    automatic: installed.length > 0 ? installed[0] : null,
    installed,
    error,
  };
}

/**
 * Store `input` (typed path rules; a macOS `.app` bundle stands for its
 * executable; empty = automatic) and return the new settings. Refuses a value
 * that is not an absolute path to an executable file, and a file it cannot
 * read.
 */
function settingsSetPath(input, options = {}) {
  const file = 'file' in options ? options.file : settingsFile(resolveConfigDir(options));
  const typed = typedPath(input === undefined || input === null ? '' : input);
  const bundled = appBundleBinary(typed);
  const value = bundled === null ? typed : bundled;
  if (value !== '') configuredBinary(value);
  writeSetting(file, value);
  return settingsGet({ ...options, file });
}

/**
 * The binaries one launch may try, best first: the configured one alone (an
 * error when it is no longer executable: the user chose it, so no other
 * browser stands in), else what automatic discovery finds.
 */
function launchCandidates(options = {}) {
  const file = 'file' in options ? options.file : settingsFile(resolveConfigDir(options));
  const stored = readSetting(file);
  if (stored !== '') return [configuredBinary(stored)];
  const found = discover(options);
  if (found.binaries.length > 0) return found.binaries;
  const skipped = found.skipped
    .map((entry) => ` (skipped ${entry.path}: ${entry.reason})`)
    .join('');
  throw new Error(
    `no Chromium found${skipped}: install Google Chrome or Chromium, or choose a browser in Settings → Browser`,
  );
}

// ── this instance's private files (instance.rs, private_fs.rs) ──────────────

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function privateMkdir(directory, recursive) {
  fs.mkdirSync(directory, { recursive, mode: 0o700 });
}

/** Create `file` exclusively with `contents`, private to the user (0600). */
function createPrivateFile(file, contents) {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // Half-written file already gone.
    }
    throw error;
  }
  fs.closeSync(fd);
}

/** The settings overlay omp takes as `--config=<path>` (instance.rs overlay). */
function overlay(port) {
  return `browser:\n  cdpUrl: "http://127.0.0.1:${port}"\n  relay: false\n`;
}

function writeOverlay(file, port) {
  createPrivateFile(file, Buffer.from(overlay(port), 'utf8'));
}

async function removeDirRetrying(directory) {
  const attempts = process.platform === 'win32' ? 10 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await delay(100);
    }
  }
}

/** The app cache folder browsers live under: `<app cache dir>/browser`. */
function browserRoot(options = {}) {
  const override = options.cacheDir ?? process.env.OMP_PORT_CACHE_DIR;
  if (override !== undefined && override !== null && override !== '') {
    if (!path.isAbsolute(override)) throw new Error('browser cache dir is not an absolute path');
    return path.join(override, 'browser');
  }
  const home = options.home ?? os.homedir();
  let base;
  if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Caches', APP_ID);
  } else if (process.platform === 'win32') {
    const local = options.localAppData ?? process.env.LOCALAPPDATA;
    base = path.join(local && path.isAbsolute(local) ? local : path.join(home, 'AppData', 'Local'), APP_ID, 'cache');
  } else {
    const xdg = options.xdgCache ?? process.env.XDG_CACHE_HOME;
    base = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache'), APP_ID);
  }
  return path.join(base, 'browser');
}

// ── pid probes and orphan reaping (reap.rs, supervisor.rs) ──────────────────

/** Whether `pid` is still alive; any inconclusive outcome counts as alive. */
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** The process group `pid` leads, or -1 (Rust `getpgid`; Node has no binding). */
function processGroupOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return -1;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close === -1) return -1;
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const group = Number(fields[2]);
      return Number.isInteger(group) ? group : -1;
    } catch {
      return -1;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const text = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (text === '') return -1;
      const group = Number(text);
      return Number.isInteger(group) ? group : -1;
    } catch {
      return -1;
    }
  }
  return -1;
}

/**
 * SIGKILL the whole process group `pid` leads, if it leads its own group and
 * that group is not ours. False when it is not such a leader (or is gone).
 */
function killGroupIfLeader(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const group = processGroupOf(pid);
  const own = processGroupOf(process.pid);
  if (!(pid === group && group !== own)) return false;
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** `has_flag` in reap.rs: the flag is delimited by NUL or ASCII whitespace
 *  (Rust's ASCII whitespace: space, tab, LF, FF, CR — not vertical tab). */
function hasFlag(cmdline, flag) {
  if (flag.length === 0) return false;
  const isBoundary = (byte) =>
    byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
  let offset = cmdline.indexOf(flag, 0);
  while (offset !== -1) {
    const before = offset === 0 || isBoundary(cmdline[offset - 1]);
    const afterIndex = offset + flag.length;
    const after = afterIndex >= cmdline.length || isBoundary(cmdline[afterIndex]);
    if (before && after) return true;
    offset = cmdline.indexOf(flag, offset + 1);
  }
  return false;
}

/** Whether `pid` was started with exactly `profile` as its user-data dir. */
function usesProfile(pid, profile) {
  const flag = Buffer.from(`--user-data-dir=${profile}`, 'utf8');
  let command;
  if (process.platform === 'linux') {
    try {
      command = fs.readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      return false;
    }
  } else if (process.platform === 'darwin') {
    try {
      command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'buffer',
        maxBuffer: 4 << 20,
      });
    } catch {
      return false;
    }
  } else {
    return false;
  }
  return hasFlag(command, flag);
}

function pidFromText(text) {
  const match = /^\+?([0-9]+)$/.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  return pid > 0 && pid <= 0xffffffff ? pid : null;
}

/**
 * Kill the browser `pidFile` names if it is still the one we launched (alive,
 * started with exactly that profile, leading its own group). False only while
 * it survives the kill.
 */
async function reapBrowser(pidFile) {
  let text;
  try {
    text = fs.readFileSync(pidFile, 'utf8');
  } catch {
    return true;
  }
  const pid = pidFromText(text);
  if (pid === null) return true;
  const extension = path.extname(pidFile);
  const profile = extension === '' ? pidFile : pidFile.slice(0, -extension.length);
  if (!pidIsAlive(pid) || !usesProfile(pid, profile)) return true;
  if (!killGroupIfLeader(pid)) return true;
  const deadline = Date.now() + 2000;
  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

/**
 * Reap the browsers an instance directory recorded (`profiles/*.pid`); false
 * if a verified browser could still be running, so the directory must stay.
 */
async function reapOrphans(instanceDir) {
  const profiles = path.join(instanceDir, 'profiles');
  let stat;
  try {
    stat = fs.lstatSync(profiles);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
  if (!stat.isDirectory()) return false;
  let entries;
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true });
  } catch {
    return false;
  }
  let stopped = true;
  for (const entry of entries) {
    if (path.extname(entry.name) !== '.pid' || !entry.isFile()) continue;
    stopped = (await reapBrowser(path.join(profiles, entry.name))) && stopped;
  }
  return stopped;
}

/** Create this process's private directory `<root>/<pid>`, reaping a crashed
 *  earlier run that used the same pid. */
async function prepareInstanceDir(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat !== undefined) {
    if (!stat.isDirectory()) throw new Error('not a real directory');
  } else {
    privateMkdir(root, true);
  }
  const instance = path.join(root, String(process.pid));
  let inside;
  try {
    inside = fs.lstatSync(instance);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (inside !== undefined) {
    if (!inside.isDirectory()) throw new Error('instance path is not a real directory');
    if (!(await reapOrphans(instance))) {
      throw new Error('a browser of an earlier run with this pid is still running');
    }
    await removeDirRetrying(instance);
  }
  privateMkdir(instance, false);
  return instance;
}

/**
 * Delete the instance directories under `root` whose process no longer
 * exists, after reaping the browsers they recorded. Live processes' and our
 * own are never touched; neither are names that are not pids.
 */
async function prune(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    const pid = pidFromText(entry.name);
    if (pid === null || pid === process.pid || !entry.isDirectory()) continue;
    if (pidIsAlive(pid)) continue;
    const directory = path.join(root, entry.name);
    if (!(await reapOrphans(directory))) continue;
    await removeDirRetrying(directory);
    pruned += 1;
  }
  return pruned;
}

// ── stderr tail (stderr.rs) ─────────────────────────────────────────────────

function joinNonblank(lines) {
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '') kept.push(trimmed);
  }
  return kept.length === 0 ? null : kept.join(' | ');
}

/** The last TAIL_BYTES as one line; a line cut at the front is dropped unless
 *  it is all there is. */
function tailText(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const cut = Math.max(0, buffer.length - TAIL_BYTES);
  const text = buffer.subarray(cut).toString('utf8');
  const lineCut = cut > 0 && buffer[cut - 1] !== 0x0a;
  const whole = lineCut
    ? text.includes('\n')
      ? text.slice(text.indexOf('\n') + 1)
      : ''
    : text;
  return joinNonblank(whole.split('\n')) ?? joinNonblank(text.split('\n'));
}

class StderrTail {
  constructor(stream) {
    this._kept = Buffer.alloc(0);
    this._ended = false;
    this._callbacks = [];
    this._endPromise = new Promise((resolve) => {
      this._resolveEnd = resolve;
    });
    if (!stream) {
      this._ended = true;
      this._resolveEnd();
      return;
    }
    stream.on('data', (chunk) => {
      this._keep(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    const end = () => {
      if (this._ended) return;
      this._ended = true;
      this._resolveEnd();
      for (const callback of this._callbacks.splice(0)) {
        try {
          callback();
        } catch {
          // A watcher's failure must not take the reader down.
        }
      }
    };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', end);
  }

  _keep(chunk) {
    this._kept = Buffer.concat([this._kept, chunk]);
    if (this._kept.length > 2 * TAIL_BYTES) {
      const excess = this._kept.length - (TAIL_BYTES + 1);
      this._kept = this._kept.subarray(excess);
    }
  }

  onEnd(callback) {
    if (this._ended) queueMicrotask(callback);
    else this._callbacks.push(callback);
  }

  /** Once the process is gone: give the reader a moment to see the end, then
   *  the kept lines as one line. */
  async settle() {
    if (!this._ended) {
      await Promise.race([
        this._endPromise,
        delay(SETTLE),
      ]);
    }
    return tailText(this._kept);
  }
}

// ── launch (launch.rs) ──────────────────────────────────────────────────────

/** Why one binary did not start, and whether the next one may. */
class Failure extends Error {
  constructor(message, fatal) {
    super(message);
    this.name = 'Failure';
    this.fatal = Boolean(fatal);
  }
}

function exitStatus(child) {
  if (child.exitCode !== null) return `code ${child.exitCode}`;
  return `signal ${child.signalCode}`;
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    child.once('close', done);
    child.once('error', done);
  });
}

function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') return; // no Job Object; stop kills the child
  killGroupIfLeader(child.pid);
}

/** The command starting `binary` with the panel's flags (no pipe flag yet). */
function commandArgs(profile, width, height) {
  return [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-features=BackForwardCache',
    `--window-size=${width},${height}`,
    '--use-mock-keychain',
    '--password-store=basic',
    'about:blank',
  ];
}

/** A distro launcher script (`#!`), not a binary. */
function isScript(binary) {
  let fd;
  try {
    fd = fs.openSync(binary, 'r');
    const head = Buffer.alloc(2);
    const read = fs.readSync(fd, head, 0, 2, 0);
    return read === 2 && head[0] === 0x23 && head[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function scriptEnvironment(profile) {
  const env = { ...process.env };
  env.XDG_CONFIG_HOME = path.join(profile, 'xdg-config');
  delete env.CHROME_USER_FLAGS;
  delete env.CHROMIUM_FLAGS;
  return env;
}

function spawnOrError(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(new Failure(`cannot run: ${error.message}`, false));
    };
    const cleanup = () => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function removeQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Not there (already removed, or never created).
  }
}

async function pipeFailed(child, reason) {
  const deadline = Date.now() + EXIT_GRACE;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(10);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return new Failure(`exited early (${exitStatus(child)})`, false);
  }
  return new Failure(reason, false);
}

/** Ask the browser for its version until it answers, exits, or the timeout hits. */
async function waitForBrowser(child, broker) {
  const deadline = Date.now() + LAUNCH_TIMEOUT;
  let failure = null;
  const version = broker.request('Browser.getVersion', {}, null).then(
    () => 'ok',
    (error) => {
      failure = error;
      return 'error';
    },
  );
  for (;;) {
    const settled = await Promise.race([version, delay(POLL_INTERVAL).then(() => 'tick')]);
    if (settled === 'ok') return;
    if (settled === 'error') {
      if (broker.isAlive()) throw new Failure(`Browser.getVersion: ${failure.message}`, false);
      throw await pipeFailed(child, 'closed its debugging pipe');
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Failure(`exited early (${exitStatus(child)})`, false);
    }
    if (Date.now() >= deadline) {
      throw new Failure(
        `no answer on the debugging pipe after ${LAUNCH_TIMEOUT / 1000}s`,
        true,
      );
    }
  }
}

/**
 * Launch `binary` headless with a CDP pipe over `profile`, and wait for it to
 * answer. On any failure the process tree is killed, our files removed, and
 * the end of its stderr attached to the reason.
 */
async function start(binary, profile, width, height) {
  if (process.platform === 'win32') {
    // Rust passes --remote-debugging-io-pipes=<read>,<write> with inheritable
    // handle values; Node exposes no way to read a stream's OS HANDLE, so the
    // browser could open its pipe ends where this process cannot reach them.
    throw new Failure(
      'the CDP pipe hand-off is not implemented on Windows in the Node port',
      true,
    );
  }
  const args = commandArgs(profile, width, height);
  // The CDP pipe itself: no port. Appended last, as Rust's `attach` does.
  args.push('--remote-debugging-pipe');
  const options = {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  };
  if (isScript(binary)) options.env = scriptEnvironment(profile);
  let child;
  try {
    child = spawn(binary, args, options);
  } catch (error) {
    throw new Failure(`cannot run: ${error.message}`, false);
  }
  const stderr = new StderrTail(child.stderr);
  const pidFile = `${profile}.pid`;
  let pidOwned = false;
  let broker = null;
  try {
    await spawnOrError(child);
    child.on('error', () => {
      // A kill of an already-gone child: nothing to report.
    });
    createPrivateFile(pidFile, `${child.pid}\n`);
    pidOwned = true;
    const from = child.stdio[4];
    const to = child.stdio[3];
    if (!from || !to) throw new Failure('cdp pipe: stdio descriptors 3 and 4 are missing', true);
    try {
      broker = await connect({ from, to });
    } catch (error) {
      throw new Failure(`cdp pipe reader: ${error.message}`, true);
    }
    // The end of Chromium's stderr means the process tree is gone even when
    // the pipe never reports its end: close the broker with it.
    const connection = broker;
    stderr.onEnd(() => connection.close());
    await waitForBrowser(child, broker);
    return handle(child, broker, stderr, pidFile, profile);
  } catch (error) {
    if (broker !== null) broker.close();
    killTree(child);
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await waitExit(child);
    if (pidOwned) removeQuiet(pidFile);
    await removeDirRetrying(profile);
    const said = await stderr.settle();
    const failure = error instanceof Failure ? error : new Failure(error.message, true);
    throw new Failure(said ? `${failure.message}: ${said}` : failure.message, failure.fatal);
  }
}

/** The handle a successful launch returns. */
function handle(child, broker, stderr, pidFile, profile) {
  let stopping = null;
  return {
    pid: child.pid,
    pipes: { fromChromium: child.stdio[4], toChromium: child.stdio[3] },
    profileDir: profile,
    broker,
    child,
    /** The browser process is running and its pipe works. */
    isAlive: () => broker.isAlive() && child.exitCode === null && child.signalCode === null,
    /** Kill the tree, reap it and remove the profile. Idempotent; concurrent
     *  callers share the first call's completion. */
    stop: () => {
      if (stopping === null) {
        stopping = (async () => {
          broker.close();
          killTree(child);
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          await waitExit(child);
          removeQuiet(pidFile);
          await removeDirRetrying(profile);
        })();
      }
      return stopping;
    },
    /** Once the browser dies: the end of its stderr as one line (null when
     *  it wrote nothing), to explain a failure. */
    stderrTailOnDeath: async () => {
      await waitExit(child);
      return stderr.settle();
    },
  };
}

/**
 * Start the first of `options.binaries` (at most MAX_ATTEMPTS) that comes up,
 * each in a fresh profile under `<instance dir>/profiles/<sessionId>-<n>`.
 * A configured browser that cannot be launched is an error, never a fallback.
 *
 * `options`: `binaries`, `configDir`/`file`/`home`/`platform`/`places` (the
 * browser setting), `instanceDir`, `root`, `sessionId` (default "browser"),
 * `width`, `height`, `maxAttempts`.
 */
async function launch(options = {}) {
  const binaries = options.binaries ?? launchCandidates(options);
  const instanceDir =
    options.instanceDir ??
    (await prepareInstanceDir(options.root ?? browserRoot(options)));
  const sessionId = options.sessionId ?? 'browser';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  }
  const width = options.width ?? WINDOW.width;
  const height = options.height ?? WINDOW.height;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const profiles = path.join(instanceDir, 'profiles');
  privateMkdir(profiles, true);
  const failures = [];
  let attempt = 0;
  for (const binary of binaries.slice(0, maxAttempts)) {
    const profile = path.join(profiles, `${sessionId}-${attempt}`);
    attempt += 1;
    try {
      const started = await start(binary, profile, width, height);
      if (failures.length > 0) {
        console.warn(`[omp-desktop] browser: started ${binary} after: ${failures.join('; ')}`);
      }
      return { ...started, instanceDir };
    } catch (failure) {
      if (!(failure instanceof Failure)) throw failure;
      failures.push(`${binary}: ${failure.message}`);
      if (failure.fatal) break;
    }
  }
  if (failures.length === 0) throw new Error('chromium did not start: no browser to launch');
  throw new Error(`chromium did not start: ${failures.join('; ')}`);
}

/**
 * Spawn Chromium with the CDP pipe and NO reader attached yet, so the
 * caller controls reader order. Measured (2026-10-27): the FIRST reader on
 * the pipe decides whether large replies (screenshots, screencast frames)
 * ever arrive — the broker as first reader starves them, a plain reader
 * first delivers to every reader. `start()`/`launch()` keep their internal
 * handshake broker for callers that do not need the panel path.
 */
function spawnChromium(binary, profile, width = WINDOW.width, height = WINDOW.height) {
  const args = commandArgs(profile, width, height);
  args.push('--remote-debugging-pipe');
  const options = {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  };
  if (isScript(binary)) options.env = scriptEnvironment(profile);
  const child = spawn(binary, args, options);
  const stderr = new StderrTail(child.stderr);
  return {
    child,
    from: child.stdio[4],
    to: child.stdio[3],
    stderr,
    stop: async () => {
      killTree(child);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await waitExit(child);
    },
  };
}

module.exports = {
  spawnChromium,
  // setting
  settingsGet,
  settingsSetPath,
  launchCandidates,
  settingsFile,
  resolveConfigDir,
  resetSettingsCache,
  typedPath,
  isExecutableFile,
  appBundleBinary,
  configuredBinary,
  readSetting,
  writeSetting,
  // discovery
  discover,
  candidates,
  places,
  currentPlatform,
  Platform,
  chromeForTesting,
  versionOf,
  SNAP_REASON,
  // instance files and reaping
  browserRoot,
  prepareInstanceDir,
  prune,
  reapOrphans,
  reapBrowser,
  overlay,
  writeOverlay,
  createPrivateFile,
  removeDirRetrying,
  pidIsAlive,
  killGroupIfLeader,
  processGroupOf,
  usesProfile,
  hasFlag,
  // launch
  launch,
  commandArgs,
  isScript,
  tailText,
  StderrTail,
  LAUNCH_TIMEOUT,
  EXIT_GRACE,
  MAX_ATTEMPTS,
  WINDOW,
  TAIL_BYTES,
};