/* electron/backend/widgets/trust.js — Node port of
   `src-tauri/src/widgets/trust.rs`.

   One-time approval of widget plugins: a plugin never runs until the user
   approved its exact fingerprint (argv plus the contents of every script the
   argv names), and any change to either needs approval again. The threat
   model, and what approval does *not* protect against, are in
   `docs/widgets.md` ("Trust and permission model") — unchanged by the port.

   The fingerprint's byte layout is the Rust one, so a fingerprint computed
   by a Tauri build matches this one:

     sha256( "omp-widget-v1\0" ‖ u64le(argv.len) ‖ for each arg: arg ‖ 0x00
             ‖ for each absolute-regular-file arg: u64le(index) ‖ u64le(size)
               ‖ "large\0" ‖ u64le(mtime_ns)        // over 8 MiB
               or "file\0" ‖ contents ‖ u64le(bytes_read) )

   Approvals live in `<app config>/widget-approvals.json` as
   `{ "version": 1, "approved": { "<id>": "<fingerprint>" } }`. Entries of
   plugins no longer in `widgets.json` are kept, so removing and re-adding an
   unchanged plugin needs no new approval.

   Deviation: Rust revokes by the user editing/deleting the file; this port
   also exposes `revoke(id)` — the same read-modify-write `approve` does, so
   a revocation made on disk is kept and an unusable file is never
   overwritten. */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stores = require('../stores.js');

// ── constants (`trust.rs`) ──────────────────────────────────────────────────

/** Domain separator, bumped if the hashed layout ever changes. */
const DOMAIN = Buffer.from('omp-widget-v1\0', 'utf8');
/** Scripts larger than this contribute `len + mtime` instead of their bytes. */
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
/** Read chunk for streaming a script into the hash, and for comparing copies. */
const CHUNK_BYTES = 16 * 1024;
const APPROVALS_VERSION = 1;
/** Length of `fingerprint`'s lowercase hex digest. */
const FINGERPRINT_HEX_LEN = 64;
const APPROVALS_FILE = 'widget-approvals.json';
const UNREADABLE = Buffer.from('unreadable\0', 'utf8');
const LARGE = Buffer.from('large\0', 'utf8');
const FILE = Buffer.from('file\0', 'utf8');

const U64_MAX = (1n << 64n) - 1n;

// ── hashing (`trust.rs`) ────────────────────────────────────────────────────

/** A little-endian u64, as Rust's `u64::to_le_bytes`. */
function u64le(value) {
  const buffer = Buffer.alloc(8);
  let big;
  if (typeof value === 'bigint') {
    big = value;
  } else {
    if (!Number.isInteger(value)) throw new Error(`${value} is not an integer`);
    big = BigInt(value);
  }
  if (big < 0n) big = 0n;
  if (big > U64_MAX) big = U64_MAX;
  buffer.writeBigUInt64LE(big);
  return buffer;
}

/** A hasher fed the domain separator and the argv (`trust::hash_argv`). */
function hashArgv(entry) {
  const hasher = crypto.createHash('sha256');
  hasher.update(DOMAIN);
  hasher.update(u64le(entry.command.length));
  for (const arg of entry.command) {
    hasher.update(Buffer.from(arg, 'utf8'));
    hasher.update(Buffer.from([0]));
  }
  return hasher;
}

/**
 * Hash what argv element `index` contributes besides its text, if it is an
 * absolute path to a regular file (`trust::hash_file_header`). A returned
 * path means its contents go in next, through `hashContents`; a file over
 * `MAX_HASHED_FILE_BYTES` is complete after its size and mtime, so `null`.
 */
function hashFileHeader(hasher, index, arg) {
  if (!path.isAbsolute(arg)) return null;
  let meta;
  try {
    // `stat` follows symlinks: the target's contents are what runs.
    meta = fs.statSync(arg, { bigint: true });
  } catch {
    return null;
  }
  if (!meta.isFile()) return null;
  hasher.update(u64le(index));
  hasher.update(u64le(meta.size));
  if (meta.size > BigInt(MAX_HASHED_FILE_BYTES)) {
    // `mtime` before the epoch (or unknown) contributes 0, as in Rust.
    const mtime = meta.mtimeNs !== undefined && meta.mtimeNs > 0n ? meta.mtimeNs : 0n;
    hasher.update(LARGE);
    hasher.update(u64le(mtime));
    return null;
  }
  hasher.update(FILE);
  return { path: arg, size: meta.size };
}

/**
 * Stream `filePath` into `hasher` one chunk at a time, handing each chunk to
 * `sink` as it is hashed, then the byte count actually read
 * (`trust::hash_contents`). An unreadable file hashes a marker instead, so it
 * never matches its content, and throws; so does a throwing `sink`, which
 * leaves the hash without its byte count.
 */
function hashContents(filePath, hasher, sink) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    hasher.update(UNREADABLE);
    throw error;
  }
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0n;
  try {
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      } catch (error) {
        if (error && error.code === 'EINTR') continue;
        hasher.update(UNREADABLE);
        throw error;
      }
      if (n === 0) break;
      const bytes = chunk.subarray(0, n);
      hasher.update(bytes);
      if (sink) sink(bytes);
      total += BigInt(n);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  }
  hasher.update(u64le(total));
}

/** The lowercase hex digest (`trust::finish`). */
function finish(hasher) {
  return hasher.digest('hex');
}

/**
 * Hex SHA-256 over the argv and every regular file an absolute argv element
 * names (`trust::fingerprint`). `entry` only needs `{ command: string[] }`.
 */
function fingerprint(entry) {
  const hasher = hashArgv(entry);
  entry.command.forEach((arg, index) => {
    const header = hashFileHeader(hasher, index, arg);
    if (header === null) return;
    try {
      hashContents(header.path, hasher, null);
    } catch {
      // An unreadable file hashed its marker instead; nothing to report.
    }
  });
  return finish(hasher);
}

/** Whether `s` has the shape of a fingerprint: 64 lowercase hex digits. */
function isFingerprint(s) {
  return typeof s === 'string' && s.length === FINGERPRINT_HEX_LEN && /^[0-9a-f]+$/.test(s);
}

// ── approvals file (`trust.rs::read_file` / `write`) ────────────────────────

/** The approvals file inside `configDir` (default `stores.configHome()`), or null. */
function approvalsPath(configDir) {
  const dir = configDir === undefined || configDir === null ? stores.configHome() : configDir;
  return dir ? path.join(dir, APPROVALS_FILE) : null;
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

/**
 * The approvals in the file at `filePath`. A missing file, or one without a
 * version and approvals (`{}`), is empty; an unreadable or malformed file, or
 * one with another version, throws an error naming the file.
 *
 * @returns {Map<string, string>}
 */
function readApprovalFile(filePath) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return new Map();
    throw new Error(`${filePath}: ${messageOf(error)}`);
  }
  let document;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${filePath}: ${messageOf(error)}`);
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  const version = document.version === null || document.version === undefined ? 0 : document.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    version > 4294967295
  ) {
    throw new Error(`${filePath}: invalid type for "version"`);
  }
  const rawApproved = document.approved === null || document.approved === undefined ? {} : document.approved;
  if (rawApproved === null || typeof rawApproved !== 'object' || Array.isArray(rawApproved)) {
    throw new Error(`${filePath}: invalid type for "approved"`);
  }
  const approved = new Map();
  for (const [id, value] of Object.entries(rawApproved)) {
    if (typeof value !== 'string') {
      throw new Error(`${filePath}: "approved.${id}" is not a string`);
    }
    approved.set(id, value);
  }
  if (version === APPROVALS_VERSION || (version === 0 && approved.size === 0)) return approved;
  throw new Error(`${filePath}: unsupported version ${version}`);
}

/** An own enumerable property, so an id like `__proto__` is kept as data. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `serde_json::to_vec_pretty` of `ApprovalFileRef`: 2-space indent, sorted ids. */
function serializeApprovals(approved) {
  const sorted = {};
  for (const id of [...approved.keys()].sort()) setOwn(sorted, id, approved.get(id));
  return JSON.stringify({ version: APPROVALS_VERSION, approved: sorted }, null, 2);
}

/** `json_store::write_atomic`: a private temp file beside `filePath`, then rename. */
function writeApprovals(filePath, approved) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`${path.dirname(filePath)}: ${messageOf(error)}`);
  }
  const temp = `${filePath}.${process.pid}-${Date.now()}-${Math.trunc(Math.random() * 1e6)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, serializeApprovals(approved));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filePath);
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
    throw new Error(`${filePath}: ${messageOf(error)}`);
  }
}

// ── approval state (`trust::Approval` / `ApprovalStore`) ────────────────────

/** Approval state of one plugin's current fingerprint. */
const APPROVAL = Object.freeze({
  APPROVED: 'approved',
  /** Never approved. */
  PENDING: 'pending',
  /** Approved under another fingerprint: argv or a script changed. */
  CHANGED: 'changed',
});

/**
 * `<app config>/widget-approvals.json`, loaded once (missing file = empty;
 * an unusable file approves nothing and is reported in `.error`). Mirrors
 * Rust's `ApprovalStore`; `filePath` null means "no app config dir", so
 * nothing can be approved.
 */
class ApprovalStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.entries = new Map();
    this.error = null;
  }

  /** Load the store at `filePath`, recording a read error instead of throwing. */
  static load(filePath = null) {
    const store = new ApprovalStore(filePath);
    store.reloadError();
    return store;
  }

  /**
   * Re-read the file, replacing the in-memory approvals. A file that cannot
   * be used approves nothing; the error is returned (null on success) so the
   * caller can surface it — a silently un-approved every-plugin state is
   * otherwise indistinguishable from the user never having approved anything.
   */
  reloadError() {
    try {
      this.entries = this.filePath === null ? new Map() : readApprovalFile(this.filePath);
      this.error = null;
    } catch (error) {
      this.entries = new Map();
      this.error = messageOf(error);
    }
    return this.error;
  }

  /** `reloadError`, but throwing like Rust's `reload() -> Result<(), String>`. */
  reload() {
    const error = this.reloadError();
    if (error !== null) throw new Error(error);
  }

  /** The fingerprint `id` was approved under, if any. */
  approved(id) {
    const value = this.entries.get(id);
    return value === undefined ? null : value;
  }

  /** Whether some plugin is approved under `fingerprint`. */
  holds(fingerprintValue) {
    for (const value of this.entries.values()) if (value === fingerprintValue) return true;
    return false;
  }

  /** `approved` | `pending` | `changed` for `id` under `fingerprintValue`. */
  status(id, fingerprintValue) {
    const approved = this.approved(id);
    if (approved === null) return APPROVAL.PENDING;
    return approved === fingerprintValue ? APPROVAL.APPROVED : APPROVAL.CHANGED;
  }

  /**
   * Approve `id` under `current` (the freshly computed fingerprint) and
   * persist atomically. `presented` is what the user saw on the approval
   * card; a mismatch means the plugin changed after the card was drawn, so
   * the approval is refused rather than granted for something unseen.
   *
   * Only `id` is written, into the file as it is on disk now: the in-memory
   * map can be older than the file (the user deleted an entry to revoke it
   * and has not reloaded yet), and writing it back would undo that.
   */
  approve(id, presented, current) {
    if (presented !== current) {
      throw new Error(`widget "${id}" changed since it was shown — review it again`);
    }
    if (this.filePath === null) {
      throw new Error('no app config directory: widget approvals cannot be saved');
    }
    let onDisk;
    try {
      onDisk = readApprovalFile(this.filePath);
    } catch (error) {
      throw new Error(`${messageOf(error)}: fix or delete it to approve widgets`);
    }
    onDisk.set(id, current);
    writeApprovals(this.filePath, onDisk);
    this.entries.set(id, current);
  }

  /**
   * Withdraw `id`'s approval, writing the file as it is on disk now (same
   * rule as `approve`). Returns whether an entry was removed. Not in Rust:
   * there the user edits the file by hand, with the same on-disk shape.
   */
  revoke(id) {
    if (this.filePath === null) {
      throw new Error('no app config directory: widget approvals cannot be saved');
    }
    let onDisk;
    try {
      onDisk = readApprovalFile(this.filePath);
    } catch (error) {
      throw new Error(`${messageOf(error)}: fix or delete it to revoke widgets`);
    }
    const removed = onDisk.delete(id);
    if (removed) writeApprovals(this.filePath, onDisk);
    this.entries.delete(id);
    return removed;
  }
}

// ── config-dir convenience (reads the file as it is now) ────────────────────

/**
 * The approvals file for `configDir` as it is on disk now.
 * @returns {{approved: Object<string, string>, error: string|null, path: string|null}}
 */
function readApprovals(configDir) {
  const filePath = approvalsPath(configDir);
  const out = { approved: {}, error: null, path: filePath };
  if (filePath === null) {
    out.error = 'no app config directory';
    return out;
  }
  try {
    for (const [id, value] of readApprovalFile(filePath)) setOwn(out.approved, id, value);
  } catch (error) {
    out.error = messageOf(error);
  }
  return out;
}

/** `approved` | `pending` | `changed`, read from the file on disk now. */
function approvalStatus(id, fingerprintValue, configDir) {
  const store = ApprovalStore.load(approvalsPath(configDir));
  return store.status(id, fingerprintValue);
}

/** Whether `id` is approved under exactly `fingerprintValue` (file read now). */
function isApproved(id, fingerprintValue, configDir) {
  return approvalStatus(id, fingerprintValue, configDir) === APPROVAL.APPROVED;
}

/**
 * Approve `id` under `fingerprintValue`.
 *
 * @param {string} id
 * @param {string} fingerprintValue
 * @param {string|{presented?: string, configDir?: string}} [meta] what the
 *   approval card showed; a value other than `fingerprintValue` refuses the
 *   approval. A string is the `presented` fingerprint.
 */
function approve(id, fingerprintValue, meta = undefined) {
  let presented = fingerprintValue;
  let configDir;
  if (typeof meta === 'string') {
    presented = meta;
  } else if (meta !== null && typeof meta === 'object') {
    if (meta.presented !== undefined) presented = meta.presented;
    if (meta.configDir !== undefined) configDir = meta.configDir;
  }
  const store = ApprovalStore.load(approvalsPath(configDir));
  store.approve(id, presented, fingerprintValue);
  return store.approved(id);
}

/** Withdraw `id`'s approval; returns whether it was approved. */
function revoke(id, configDir) {
  const store = ApprovalStore.load(approvalsPath(configDir));
  return store.revoke(id);
}

module.exports = {
  // constants
  DOMAIN,
  MAX_HASHED_FILE_BYTES,
  CHUNK_BYTES,
  APPROVALS_VERSION,
  APPROVALS_FILE,
  APPROVAL,
  // hashing
  u64le,
  hashArgv,
  hashFileHeader,
  hashContents,
  finish,
  fingerprint,
  isFingerprint,
  // approvals
  ApprovalStore,
  approvalsPath,
  readApprovalFile,
  serializeApprovals,
  readApprovals,
  approvalStatus,
  isApproved,
  approve,
  revoke,
};