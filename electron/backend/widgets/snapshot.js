/* electron/backend/widgets/snapshot.js — Node port of
   `src-tauri/src/widgets/snapshot.rs`.

   Verified copies of the files a plugin's fingerprint hashes, so a run
   executes the bytes its approval check saw. Checking the files and then
   starting the plugin by their paths leaves a window in which a script can
   be swapped; instead a run gets an argv naming copies whose bytes were
   compared with, or copied from, the bytes hashed to the approved
   fingerprint in this same pass.

   Layout under `<storeRoot>` (Rust `<app cache>/widget-runs`):
   - `store/<fingerprint>/<argv index>/<file name>`: the copies of one
     approved fingerprint, reused by every run while it stays approved, so a
     tool that keys a cache by script path (uv's per-script environments)
     sees one stable path. Reuse is never on trust: each stored copy is
     compared with its original chunk by chunk while the original is hashed,
     and the entry must be a real directory holding exactly the copies as
     real files. If the originals still match the approval but the entry does
     not (a copy planted, tampered with or truncated by a crash; a module
     planted beside a copy; a link), the entry is removed and built again.
   - `staging/<pid>/<n>/`: copies being built, each file streamed through the
     hash and into staging at once. Only if the result equals the approved
     fingerprint is the directory renamed into `store/`. If that rename fails,
     this run executes the staging copy, which `run.dispose()` removes.

   A run without copies to make creates no directory at all.

   What is not copied, and so still runs from its own path: the program
   itself (`argv[0]`) when it is a native executable of this platform, a file
   over the fingerprint's 8 MiB limit, and anything that is not a regular
   file when the run starts. A copy keeps its file name and, on unix, its
   owner-execute bit; its directory is not the original's.

   `prune` (at startup) deletes the staging directories of dead processes and
   the store entries no plugin is approved under. */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trust = require('./trust.js');

// ── constants (`snapshot.rs`) ───────────────────────────────────────────────

const STAGING = 'staging';
const STORE = 'store';
const NO_STORE =
  'the app cache directory could not be resolved — widget scripts cannot be copied for the run';
/** Attempts at a fresh staging directory name before giving up. */
const STAGING_ATTEMPTS = 16;

/** The headers of an executable this platform's loader runs (`is_native_image`). */
const NATIVE_MAGICS = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // \x7fELF
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
];
const MZ = Buffer.from('MZ', 'ascii');

// ── store root (`storeRoot` / `setStoreRoot`) ───────────────────────────────

let rootOverride = null;

/**
 * The folder holding `store/` and `staging/`: `OMP_PORT_WIDGET_STORE` when
 * set, else `<os.tmpdir()>/omp-port-widget-runs` (the port has no app cache
 * dir, so the tmp dir stands in for it; scripts still never run from here
 * unless they were verified into `store/`).
 */
function storeRoot() {
  const override = process.env.OMP_PORT_WIDGET_STORE;
  if (override !== undefined && override !== '') return path.resolve(override);
  if (rootOverride !== null) return rootOverride;
  return path.join(os.tmpdir(), 'omp-port-widget-runs');
}

/** Override the store root for tests (`null` restores the default). */
function setStoreRoot(dir) {
  rootOverride = dir === undefined || dir === null ? null : path.resolve(dir);
  return storeRoot();
}

// ── small filesystem helpers (`private_fs.rs`, snapshot.rs) ─────────────────

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Create a private (`0700`) directory, recursively. */
function privateMkdir(directory, recursive = true) {
  fs.mkdirSync(directory, { recursive, mode: 0o700 });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** `remove_dir_retrying`: retried on Windows for about a second; missing is success. */
function removeDirRetrying(target) {
  const attempts = process.platform === 'win32' ? 10 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      if (attempt >= attempts) throw error;
      sleepSync(100);
    }
  }
}

/** Whether a process still exists; any inconclusive outcome counts as alive. */
function pidIsAlive(pid) {
  // Reuses the ported supervisor probe (`browser-process.js`) rather than a
  // second copy of the same three lines.
  return require('../browser-process.js').pidIsAlive(pid);
}

/** The subdirectories of `dir` with that name, like Rust's `subdirs`. */
function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => [entry.name, path.join(dir, entry.name)]);
}

/** `pid_dirs`: the subdirectories of `root` named by a process id. */
function pidDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\+?\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isSafeInteger(pid) || pid > 0xffffffff) continue;
    out.push([pid, path.join(root, entry.name)]);
  }
  return out;
}

/** Remove a store entry, or whatever sits in its place, without following a link. */
function discard(entry) {
  const meta = lstatOrNull(entry);
  if (meta === null) return;
  try {
    if (meta.isDirectory() && !meta.isSymbolicLink()) {
      fs.rmSync(entry, { recursive: true, force: true });
    } else {
      fs.unlinkSync(entry);
    }
  } catch {
    try {
      fs.unlinkSync(entry);
    } catch {
      // Already gone.
    }
  }
}

/** Number of entries in `dir`, or null when it cannot be read. */
function countEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` holds exactly `copies`, each a real file in a real directory:
 * nothing planted beside a copy (a sibling `json.py` or `node_modules` an
 * interpreter would load first) and no copy that is a link (`holds_only`).
 */
function holdsOnly(dir, copies) {
  return (
    countEntries(dir) === copies.length &&
    copies.every(({ relative }) => {
      const copy = path.join(dir, relative);
      const slot = path.dirname(copy);
      const slotMeta = lstatOrNull(slot);
      const copyMeta = lstatOrNull(copy);
      return (
        slotMeta !== null &&
        slotMeta.isDirectory() &&
        !slotMeta.isSymbolicLink() &&
        countEntries(slot) === 1 &&
        copyMeta !== null &&
        copyMeta.isFile()
      );
    })
  );
}

/** Only the program is loaded by the OS (`may_run_natively`). */
function mayRunNatively(index, arg) {
  const namedExe = process.platform !== 'win32' || arg.toLowerCase().endsWith('.exe');
  return index === 0 && namedExe;
}

/** The header of an executable this platform's loader runs (`is_native_image`). */
function isNativeImage(head) {
  if (process.platform === 'win32') return head.length >= 2 && head.subarray(0, 2).equals(MZ);
  return NATIVE_MAGICS.some((magic) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic));
}

/** `reads_as`: whether the next bytes of `fd` are `expected`. */
function readsAs(fd, expected) {
  let offset = 0;
  const buffer = Buffer.allocUnsafe(trust.CHUNK_BYTES);
  while (offset < expected.length) {
    const want = Math.min(expected.length - offset, trust.CHUNK_BYTES);
    let n;
    try {
      n = fs.readSync(fd, buffer, 0, want, null);
    } catch {
      return false;
    }
    if (n !== want) return false;
    if (!buffer.subarray(0, want).equals(expected.subarray(offset, offset + want))) return false;
    offset += want;
  }
  return true;
}

// ── one hashed file while its bytes stream through the hash ────────────────

const PENDING = 'pending';
const NATIVE = 'native';
const COPIED = 'copied';
const WRITE = 'write';
const COMPARE = 'compare';
const DIFFERS = 'differs';

/**
 * `HashedFile`: whether a file runs from a copy is decided by its first
 * chunk. `open()` is called at most once, when the first chunk arrives (or
 * for an empty file, from `finish`), and returns a sink.
 */
class HashedFile {
  constructor(mayBeNative, limit) {
    this.state = PENDING;
    this.mayBeNative = mayBeNative;
    /** The size `metadata` reported: a file that grows past it is refused. */
    this.limit = limit;
    this.sink = null;
    this.read = 0;
  }

  feed(chunk, open) {
    if (this.state === PENDING) {
      if (this.mayBeNative && chunk.length > 0 && isNativeImage(chunk)) {
        this.state = NATIVE;
      } else {
        this.openSink(open);
      }
    }
    if (this.state !== COPIED) return;
    this.read += chunk.length;
    if (this.read > this.limit) throw new Error('the file changed while it was read');
    if (this.sink.kind === WRITE) {
      fs.writeSync(this.sink.fd, chunk);
    } else if (this.sink.kind === COMPARE && !readsAs(this.sink.fd, chunk)) {
      this.dropSink(DIFFERS);
    }
  }

  openSink(open) {
    this.state = COPIED;
    this.sink = open();
  }

  dropSink(kind) {
    const fd = this.sink === null ? null : this.sink.fd;
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    this.sink = { kind };
  }

  /**
   * `null` for a native executable, else whether its copy is good: written
   * now, or compared equal to the end. An empty file never saw a chunk and is
   * opened (copied empty, or compared) here.
   */
  finish(open) {
    this.feed(Buffer.alloc(0), open);
    if (this.state !== COPIED) return null;
    if (this.sink.kind === WRITE) {
      fs.closeSync(this.sink.fd);
      return true;
    }
    if (this.sink.kind === COMPARE) {
      let atEof = false;
      try {
        atEof = fs.readSync(this.sink.fd, Buffer.allocUnsafe(1), 0, 1, null) === 0;
      } catch {
        atEof = false;
      }
      this.dropSink(DIFFERS);
      return atEof;
    }
    return false;
  }

  /** Close whatever is still open (an error path in `pass`). */
  dispose() {
    if (this.state === COPIED && this.sink !== null) {
      const fd = this.sink.fd;
      if (fd !== null && fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
    this.sink = null;
  }
}

// ── staging (`snapshot.rs::Staging`, `Run`) ────────────────────────────────

/**
 * One pass's staging directory, created on its first copy. `commit` renames
 * it into the store; on failure the directory is handed back so this run can
 * execute from it and remove it afterwards.
 */
class Staging {
  constructor(store) {
    this.store = store;
    this.dir = null;
  }

  /** Create `staging/<pid>/<n>`; the caller then writes `<relative>` inside. */
  ensureDir() {
    if (this.dir !== null) return this.dir;
    this.dir = this.store.stagingDir();
    return this.dir;
  }

  /**
   * Create the empty copy `<relative>` exclusively; unix mode `0500` if the
   * original is owner-executable, else `0400` (the open handle can still
   * write it).
   */
  create(relative, executable) {
    const dir = this.ensureDir();
    const target = path.join(dir, relative);
    privateMkdir(path.dirname(target), true);
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      executable ? 0o500 : 0o400,
    );
    return { kind: WRITE, fd };
  }

  /**
   * Rename the staged copies to `target`. A failure hands them back, to run
   * from where they are this once.
   */
  commit(target) {
    if (this.dir === null) return { ok: true, scratch: null };
    try {
      privateMkdir(path.dirname(target), true);
      fs.renameSync(this.dir, target);
      this.dir = null;
      return { ok: true, scratch: null };
    } catch (error) {
      const scratch = this.dir;
      this.dir = null;
      process.stderr.write(
        `[omp-desktop] widget script copies not stored, running them once from staging: ${error.message}\n`,
      );
      return { ok: false, scratch };
    }
  }

  /** Remove the staging directory (an error path in `prepare`). */
  dispose() {
    if (this.dir !== null) {
      try {
        removeDirRetrying(this.dir);
      } catch {
        // Best effort: `prune` sweeps what is left.
      }
      this.dir = null;
    }
  }
}

/** The argv a run executes: each hashed script replaced by its verified copy. */
function makeRun(entry, copies, dir, scratch) {
  const argv = entry.command.slice();
  for (const { index, relative } of copies) argv[index] = path.join(dir, relative);
  let done = false;
  return {
    argv,
    dispose() {
      if (done || scratch === null) return;
      done = true;
      try {
        removeDirRetrying(scratch);
      } catch {
        // Best effort: `prune` sweeps what is left.
      }
    },
  };
}

// ── the store ──────────────────────────────────────────────────────────────

/**
 * The verified copies of widget scripts: `<root>/store`, `<root>/staging`.
 * `root` null means "no app cache directory": a run that needs a copy fails.
 */
class ScriptStore {
  constructor(root = storeRoot()) {
    this.root = root === undefined || root === null ? null : path.resolve(root);
    this.next = 0;
  }

  /**
   * Delete the staging directories of processes that no longer exist and our
   * own pid's, and every store entry whose fingerprint `approved` rejects.
   * Staging directories of live app instances and names that are not pids are
   * left alone. Call before the first run.
   *
   * @param {(fingerprint: string) => boolean|Set<string>|string[]} approved
   */
  prune(approved) {
    if (this.root === null) return;
    const keep =
      typeof approved === 'function'
        ? approved
        : (() => {
            const set = new Set(approved);
            return (value) => set.has(value);
          })();
    const staging = path.join(this.root, STAGING);
    for (const [pid, dir] of pidDirs(staging)) {
      if (pid === process.pid || !pidIsAlive(pid)) {
        try {
          removeDirRetrying(dir);
        } catch {
          // Left for the next start.
        }
      }
    }
    for (const [name, dir] of subdirs(path.join(this.root, STORE))) {
      if (!keep(name)) {
        try {
          removeDirRetrying(dir);
        } catch {
          // Left for the next start.
        }
      }
    }
  }

  /** A fresh `staging/<pid>/<n>`, created exclusively. */
  stagingDir() {
    if (this.root === null) throw new Error(NO_STORE);
    const instance = path.join(this.root, STAGING, String(process.pid));
    privateMkdir(instance, true);
    for (let attempt = 1; ; attempt += 1) {
      const dir = path.join(instance, String(this.next));
      this.next += 1;
      try {
        privateMkdir(dir, false);
        return dir;
      } catch (error) {
        // A leftover of a crashed process with our pid, never reused.
        if (error && error.code === 'EEXIST' && attempt < STAGING_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  /**
   * Hash `entry` as `trust.fingerprint` does and, if that equals `approved`,
   * the run: argv naming the copies in `store/<approved>`, verified against
   * the originals in this pass or made from them now.
   *
   * @returns {{kind: 'ready', fingerprint: string, argv: string[], run: {argv: string[], dispose(): void}}
   *          | {kind: 'changed', fingerprint: string}}
   * @throws when a file cannot be read or copied, or when a copy is needed
   *   but there is no store root: the run must not fall back to the original.
   */
  prepare(entry, approved) {
    // `approved` comes from the approvals file: a path component only once it
    // has a fingerprint's shape.
    const stored =
      this.root !== null && trust.isFingerprint(approved)
        ? path.join(this.root, STORE, approved)
        : null;
    const staging = new Staging(this);
    try {
      if (stored !== null) {
        const meta = lstatOrNull(stored);
        if (meta !== null && meta.isDirectory() && !meta.isSymbolicLink()) {
          const pass = this.pass(entry, stored, staging);
          if (pass.fingerprint !== approved) {
            // The original changed; the entry still holds the approved bytes
            // for runs in flight.
            return { kind: 'changed', fingerprint: pass.fingerprint };
          }
          if (pass.verified && holdsOnly(stored, pass.copies)) {
            return this.ready(entry, pass.copies, stored, pass.fingerprint, null);
          }
          discard(stored);
        } else if (meta !== null) {
          // A file, symlink or junction where the entry belongs.
          discard(stored);
        }
      }
      const pass = this.pass(entry, null, staging);
      if (pass.fingerprint !== approved) {
        // The staging copy goes with the failed approval check.
        return { kind: 'changed', fingerprint: pass.fingerprint };
      }
      if (pass.copies.length === 0) return this.ready(entry, [], '', pass.fingerprint, null);
      if (stored === null) throw new Error(NO_STORE);
      const committed = staging.commit(stored);
      return this.ready(
        entry,
        pass.copies,
        committed.ok ? stored : committed.scratch,
        pass.fingerprint,
        committed.ok ? null : committed.scratch,
      );
    } finally {
      // Every exit but the staging fallback leaves nothing behind: `commit`
      // hands its directory to the run (or removes it) before returning.
      staging.dispose();
    }
  }

  ready(entry, copies, dir, fingerprintValue, scratch) {
    const run = makeRun(entry, copies, dir, scratch);
    return { kind: 'ready', fingerprint: fingerprintValue, argv: run.argv, run };
  }

  /**
   * Hash `entry`, comparing each copied file with its copy in `verifyDir`
   * or, without one, writing it into `staging`.
   */
  pass(entry, verifyDir, staging) {
    const hasher = trust.hashArgv(entry);
    const copies = [];
    let verified = true;
    for (let index = 0; index < entry.command.length; index += 1) {
      const arg = entry.command[index];
      const header = trust.hashFileHeader(hasher, index, arg);
      if (header === null) continue;
      const name = path.basename(arg);
      if (name === '' || name === '.' || name === '..') throw new Error(`${arg} has no file name`);
      const relative = path.join(String(index), name);
      const executable = isOwnerExecutable(arg);
      const open = () => {
        if (verifyDir === null) return staging.create(relative, executable);
        const copy = path.join(verifyDir, relative);
        let fd;
        try {
          fd = fs.openSync(copy, 'r');
        } catch {
          // A missing or unreadable copy is a mismatch, not an error.
          return { kind: DIFFERS };
        }
        return { kind: COMPARE, fd };
      };
      const file = new HashedFile(mayRunNatively(index, arg), Number(header.size));
      try {
        trust.hashContents(header.path, hasher, (chunk) => file.feed(chunk, open));
        const fromCopy = file.finish(open);
        if (fromCopy !== null) {
          verified = verified && fromCopy;
          copies.push({ index, relative });
        }
      } catch (error) {
        file.dispose();
        throw new Error(`could not read or copy ${arg} for the run: ${error.message}`);
      }
      file.dispose();
    }
    return { fingerprint: trust.finish(hasher), copies, verified };
  }

  /**
   * The verified copy of one script under `fingerprintValue`:
   * `store/<fingerprint>/<index>/<basename>`.
   *
   * The file is hashed and, on the first use or whenever the stored copy no
   * longer matches it, copied from those same bytes; on every later call the
   * stored copy is re-hashed and compared, so a tampered copy is never
   * returned — it is replaced by the original's bytes, or the call fails.
   *
   * `prepare` is the authoritative path: it binds every script to the whole
   * approved fingerprint. This helper checks the copy against the original
   * read in this call; pass `expectedSha256` (the content hash recorded with
   * the approval) to also refuse a changed original.
   *
   * @param {string} scriptPath
   * @param {string} fingerprintValue
   * @param {{index?: number, expectedSha256?: string}} [options]
   * @returns {string} the copy's absolute path
   */
  verifiedCopy(scriptPath, fingerprintValue, options = {}) {
    if (!trust.isFingerprint(fingerprintValue)) {
      throw new Error(`${scriptPath}: "${fingerprintValue}" is not a widget fingerprint`);
    }
    if (this.root === null) throw new Error(NO_STORE);
    const index = options.index ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new Error(`${scriptPath}: bad argv index ${index}`);
    const expected = options.expectedSha256 ?? null;
    let meta;
    try {
      meta = fs.statSync(scriptPath, { bigint: true });
    } catch (error) {
      throw new Error(`${scriptPath}: ${error.message}`);
    }
    if (!meta.isFile()) throw new Error(`${scriptPath} is not a regular file`);
    if (meta.size > BigInt(trust.MAX_HASHED_FILE_BYTES)) {
      throw new Error(`${scriptPath} is over the 8 MiB hashing limit and is never copied`);
    }
    const name = path.basename(scriptPath);
    const relative = path.join(String(index), name);
    const entryDir = path.join(this.root, STORE, fingerprintValue);
    const copyPath = path.join(entryDir, relative);
    const originalHash = hashFile(scriptPath);
    if (expected !== null && originalHash !== expected) {
      throw new Error(`${scriptPath} changed since it was approved`);
    }
    // Re-verify a stored copy before trusting it; anything but this one real
    // file in its slot means the entry is rebuilt.
    const copyMeta = lstatOrNull(copyPath);
    const slotMeta = lstatOrNull(path.dirname(copyPath));
    if (
      copyMeta !== null &&
      copyMeta.isFile() &&
      slotMeta !== null &&
      slotMeta.isDirectory() &&
      !slotMeta.isSymbolicLink() &&
      countEntries(path.dirname(copyPath)) === 1 &&
      hashFile(copyPath) === originalHash
    ) {
      return copyPath;
    }
    const staging = new Staging(this);
    let built = null;
    try {
      const sink = staging.create(relative, isOwnerExecutable(scriptPath));
      const copied = copyWhileHashing(scriptPath, sink.fd);
      if (copied.hash !== originalHash || copied.bytes !== meta.size) {
        // The copy is complete but differs from the pass just hashed: the
        // file changed under us, so its bytes are not the approved ones.
        throw new Error(`${scriptPath} changed while it was read`);
      }
      built = staging.dir;
      staging.dir = null;
      discard(entryDir);
      privateMkdir(path.dirname(entryDir), true);
      fs.renameSync(built, entryDir);
      built = null;
      return copyPath;
    } catch (error) {
      staging.dispose();
      if (built !== null) {
        try {
          removeDirRetrying(built);
        } catch {
          // Best effort: `prune` sweeps what is left.
        }
      }
      throw error;
    }
  }
}

/**
 * Stream `source` into `destFd` while hashing it: `{hash, bytes}`. Used by
 * `verifiedCopy` for its copy (the Rust pass hashes and copies in one read;
 * `trust.hashContents` cannot, because it appends the byte count to the hash).
 */
function copyWhileHashing(source, destFd) {
  const fd = fs.openSync(source, 'r');
  const hasher = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(trust.CHUNK_BYTES);
  let bytes = 0n;
  try {
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buffer, 0, trust.CHUNK_BYTES, null);
      } catch (error) {
        if (error && error.code === 'EINTR') continue;
        throw error;
      }
      if (n === 0) break;
      const chunk = buffer.subarray(0, n);
      hasher.update(chunk);
      fs.writeSync(destFd, chunk);
      bytes += BigInt(n);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      fs.closeSync(destFd);
    } catch {
      // Already closed.
    }
  }
  return { hash: hasher.digest('hex'), bytes };
}

/** SHA-256 of a file's bytes (lowercase hex); throws when unreadable. */
function hashFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const hasher = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(trust.CHUNK_BYTES);
  try {
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buffer, 0, trust.CHUNK_BYTES, null);
      } catch (error) {
        if (error && error.code === 'EINTR') continue;
        throw error;
      }
      if (n === 0) break;
      hasher.update(buffer.subarray(0, n));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  }
  return hasher.digest('hex');
}

/** Whether the file's owner-execute bit is set (false off unix). */
function isOwnerExecutable(filePath) {
  if (process.platform === 'win32') return false;
  try {
    return (fs.statSync(filePath).mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

module.exports = {
  STAGING,
  STORE,
  NO_STORE,
  storeRoot,
  setStoreRoot,
  ScriptStore,
  holdsOnly,
  discard,
  subdirs,
  pidDirs,
  mayRunNatively,
  isNativeImage,
  isOwnerExecutable,
  hashFile,
};