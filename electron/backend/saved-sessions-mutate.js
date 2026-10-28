/* electron/backend/saved-sessions-mutate.js — Node port of the history
   governance half (delete / rename) of `src-tauri/src/saved_sessions/`.

   `saved-sessions.js` ports the read half (scan/parse); this module ports the
   two write commands the history modal calls:

   - `delete_saved_session`: move the file into `<its directory>/.trash/`,
     creating the directory, with `.1`, `.2`, … suffixes for name conflicts —
     never an overwrite. The scan half skips `.trash/` by name, so a deleted
     session disappears from the list the moment the file lands there.
   - `rename_saved_session`: rewrite only the FIRST line (the `title` event)
     with the cleaned title, leaving every byte after the first newline
     untouched, via a temp-file + rename write.

   Both validate the incoming path exactly like the Rust side
   (`canonical_session_path`): not flag-shaped, must canonicalise, must
   canonicalise to a `.jsonl` file strictly inside the resolved sessions
   root.

   Parity notes (each mirrors the Rust line it replaces):
   - The title is cleaned by dropping control characters (Rust
     `char::is_control`, i.e. U+0000–U+001F and U+007F–U+009F), trimming,
     then keeping the first 120 code points — in that order.
   - The rewritten first line is serde_json's compact re-serialization of the
     parsed `Value`. This crate builds serde_json WITHOUT `preserve_order`,
     so object keys come out sorted (byte order) at every nesting level; the
     port sorts the same way so a Tauri-written and a port-written rename are
     byte-identical. Numbers follow JS `JSON.stringify` formatting (a
     non-integral value such as `1.0` would print as `1`, where serde_json
     prints `1.0`; real title events only carry the integer `v`).
   - Error strings keep Rust's wording and shape, including the io suffix
     (`… (No such file or directory (os error 2))`). The system message is
     taken from a small POSIX strerror table with Node's errno map as the
     fallback, and `{:?}` string quoting is mirrored by `rustDebugString`.
   - Deviation: `profile` is checked for a valid id shape only (the same
     rule `listSavedSessions` applies) instead of `ProfileStore::resolve`'s
     membership check, so the read and write halves always agree on which
     tree a profile id names. Deviation: the Rust `write_atomic` also
     sweeps orphan temp files on the first write to a destination; the port
     relies on its own unique temp name and its failure-path unlink (no
     stale temp can outlive a crashed process of THIS run, and a sweep for
     files created by an earlier Tauri process is not this module's job). */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getSystemErrorMap } = require('node:util');

const {
  isDefaultProfile,
  isValidProfileId,
  sessionsRootFor,
} = require('./saved-sessions');

/** `rename_saved_session`'s `.chars().take(120)`. */
const TITLE_MAX_CHARS = 120;

// ── error-text parity ──────────────────────────────────────────────────────

/**
 * strerror texts Rust's `io::Error` Display prints for the failures these
 * commands can hit (both glibc and macOS libc agree on these strings; Node's
 * `getSystemErrorMap` uses libuv's lowercase wording instead, e.g. "file
 * already exists" for EEXIST).
 */
const STRERROR = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  EXDEV: 'Cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EBUSY: 'Resource busy',
};

const SYSTEM_ERRORS = getSystemErrorMap();

/** `io::Error` Display: `"<strerror> (os error <errno>)"`. */
function ioErrorText(err) {
  if (err === null || typeof err !== 'object') return String(err);
  let errno = typeof err.errno === 'number' ? err.errno : null;
  if (errno === null) return typeof err.message === 'string' ? err.message : String(err);
  const number = Math.abs(errno);
  const known = typeof err.code === 'string' ? STRERROR[err.code] : undefined;
  if (known !== undefined) return `${known} (os error ${number})`;
  const entry = SYSTEM_ERRORS.get(errno) ?? SYSTEM_ERRORS.get(number);
  if (entry !== undefined) {
    const message = entry[1];
    return `${message.charAt(0).toUpperCase()}${message.slice(1)} (os error ${number})`;
  }
  // Unknown code: Node's own message is more informative than "os error N".
  return typeof err.message === 'string' && err.message.length > 0
    ? err.message
    : `os error ${number}`;
}

/**
 * Rust's `{:?}` for a `&str` (quotes, backslash/quote escapes, `\0`, `\n`,
 * `\r`, `\t`, other Cc as `\u{…}`). Grapheme-extended escaping of exotic
 * combining marks is not mirrored — session paths are plain filesystem text.
 */
function rustDebugString(value) {
  if (typeof value !== 'string') return JSON.stringify(value) ?? String(value);
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

// ── session path validation ────────────────────────────────────────────────

/** `Path::starts_with`: component-wise, never a bare string prefix. */
function isUnder(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * `canonical_session_path`: prove `sessionPath` is a `.jsonl` file inside
 * `root`, canonicalising both. Order matches Rust: flag check, path
 * canonicalise, root canonicalise, confinement, extension.
 */
async function canonicalSessionPath(root, sessionPath) {
  if (typeof sessionPath !== 'string') {
    throw new Error(`invalid session path: ${rustDebugString(sessionPath)}`);
  }
  // A flag-shaped value could be re-tokenised as an option by omp's parser.
  if (sessionPath.startsWith('-')) {
    throw new Error(`invalid session path: ${rustDebugString(sessionPath)}`);
  }

  let canonical;
  try {
    canonical = await fsp.realpath(sessionPath);
  } catch (err) {
    throw new Error(
      `session path does not exist: ${rustDebugString(sessionPath)} (${ioErrorText(err)})`,
    );
  }

  let canonicalRoot;
  try {
    canonicalRoot = await fsp.realpath(root);
  } catch (err) {
    throw new Error(`sessions directory unavailable: ${ioErrorText(err)}`);
  }

  if (!isUnder(canonicalRoot, canonical)) {
    throw new Error(
      `session path ${rustDebugString(sessionPath)} is outside the sessions directory`,
    );
  }
  // Rust compares `Path::extension()` case-sensitively.
  if (path.extname(canonical).slice(1) !== 'jsonl') {
    throw new Error(`session path ${rustDebugString(sessionPath)} is not a .jsonl session file`);
  }
  return canonical;
}

/** `Path::exists` (follows symlinks, any stat failure reads as absent). */
async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

// ── atomic write ───────────────────────────────────────────────────────────

/** Unique sibling temp path, the `json_store::temp_path_for` shape. */
function tempPathFor(file) {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${rand}.tmp`,
  );
}

/**
 * `json_store::write_atomic`: write a uniquely-named sibling temp file,
 * fsync it, rename it over the destination. The destination is never left
 * partially written, and the temp file is removed on every failure path.
 */
function atomicWrite(file, bytes) {
  const temp = tempPathFor(file);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort; the original error must win
    }
    throw err;
  }
}

// ── serde_json::Value re-serialization ────────────────────────────────────

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * serde_json's compact output for a parsed `Value`, with object keys sorted
 * byte-wise (this crate does not enable `preserve_order`, so `Value::Object`
 * is a BTreeMap).
 */
function serialiseJsonValue(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serialiseJsonValue).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).sort(compareUtf8);
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${serialiseJsonValue(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return 'null';
}

// ── delete ─────────────────────────────────────────────────────────────────

/**
 * `delete_saved_session(root, path)`: move the validated session file into
 * `<its directory>/.trash/`, creating the directory when missing. A
 * same-named file already in the trash gets the first free numeric suffix
 * (`.1`, `.2`, …) instead of an overwrite. Recovery is manual.
 */
async function deleteSavedSessionAt(root, sessionPath) {
  const canonical = await canonicalSessionPath(root, sessionPath);
  const parent = path.dirname(canonical);
  const trash = path.join(parent, '.trash');
  try {
    await fsp.mkdir(trash, { recursive: true });
  } catch (err) {
    throw new Error(`failed to create ${trash}: ${ioErrorText(err)}`);
  }

  const name = path.basename(canonical);
  const ext = path.extname(name);
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
  let target = path.join(trash, name);
  let n = 1;
  while (await exists(target)) {
    target = path.join(trash, `${stem}.${n}.jsonl`);
    n += 1;
  }

  try {
    await fsp.rename(canonical, target);
  } catch (err) {
    throw new Error(`failed to move ${canonical} into ${target}: ${ioErrorText(err)}`);
  }
}

// ── rename ─────────────────────────────────────────────────────────────────

/** `str::trim`: Rust's White_Space set (JS `trim` also strips U+FEFF, Rust does not). */
const RUST_WHITESPACE = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

function rustTrim(text) {
  return text.replace(RUST_WHITESPACE, '');
}

/**
 * Clean a title the way Rust does: drop control characters, trim, cap at
 * 120 code points. Returns `''` for a title that cleans away entirely.
 */
function cleanTitle(title) {
  let withoutControls = '';
  for (const ch of title) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    withoutControls += ch;
  }
  return Array.from(rustTrim(withoutControls)).slice(0, TITLE_MAX_CHARS).join('');
}

/**
 * `rename_saved_session(root, path, title)`: replace the `title` field of
 * the first line (the `title` event — omp always keeps it physically first)
 * and preserve every other byte of the file verbatim. A file whose single
 * line had no trailing newline gets one, so the result stays line-oriented.
 */
async function renameSavedSessionAt(root, sessionPath, title) {
  const canonical = await canonicalSessionPath(root, sessionPath);
  if (typeof title !== 'string') {
    throw new Error(`invalid title: ${rustDebugString(title)}`);
  }
  const cleaned = cleanTitle(title);
  if (cleaned === '') throw new Error('title must not be empty');

  let bytes;
  try {
    bytes = await fsp.readFile(canonical);
  } catch (err) {
    throw new Error(`failed to read ${canonical}: ${ioErrorText(err)}`);
  }

  let firstLineEnd = bytes.indexOf(0x0a);
  if (firstLineEnd === -1) firstLineEnd = bytes.length;
  const firstText = bytes.subarray(0, firstLineEnd).toString('utf8');
  const rest = bytes.subarray(firstLineEnd);

  let val;
  try {
    val = JSON.parse(rustTrim(firstText));
  } catch (err) {
    // serde_json's own parse text isn't reproducible from Node's JSON.parse;
    // the wrapper wording is.
    throw new Error(`session first line is not valid JSON: ${err.message}`);
  }

  const isObject = val !== null && typeof val === 'object' && !Array.isArray(val);
  if (!isObject || val.type !== 'title') {
    throw new Error(`session first line is not a title event: ${canonical}`);
  }
  if (typeof val.title !== 'string') {
    throw new Error(`session first line has no title field: ${canonical}`);
  }
  // Only the title field changes; type, id, updatedAt, … survive as parsed.
  val.title = cleaned;

  const head = Buffer.from(serialiseJsonValue(val), 'utf8');
  // `rest` starts with the newline that ended the first line when there was
  // one; only a single-line file with no trailing newline needs it appended.
  const parts = rest[0] === 0x0a ? [head, rest] : [head, Buffer.from('\n'), rest];
  try {
    atomicWrite(canonical, Buffer.concat(parts));
  } catch (err) {
    throw new Error(`failed to write ${canonical}: ${ioErrorText(err)}`);
  }
}

// ── command surface ────────────────────────────────────────────────────────

/**
 * Resolve `args.profile` to a sessions root, the same way
 * `listSavedSessions` does: null/`""`/`"default"` is the built-in tree
 * (`PI_CODING_AGENT_DIR` overrides it), a named profile resolves to
 * `<home>/.omp/profiles/<id>/agent/sessions` and ignores the env override.
 */
function resolveSessionsRoot(args) {
  const { profile = null } = args || {};
  let named = null;
  if (!isDefaultProfile(profile)) {
    if (!isValidProfileId(profile)) {
      throw new Error(`invalid profile id: ${JSON.stringify(profile)}`);
    }
    named = profile;
  }
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return sessionsRootFor(os.homedir(), named, envDir ? envDir : null);
}

/**
 * `delete_saved_session` backend. Args are the Tauri command's `{ path,
 * profile }` (the history modal's `session.path` plus `activeProfile()`).
 * Resolves to `null` (`Ok(())` serializes as unit), rejects with the Rust
 * error string.
 */
async function deleteSavedSession(args = {}) {
  const { path: sessionPath = null } = args || {};
  const root = resolveSessionsRoot(args);
  await deleteSavedSessionAt(root, sessionPath);
  return null;
}

/**
 * `rename_saved_session` backend. Args are `{ path, title, profile }`.
 * Resolves to `null` (`Ok(())`), rejects with the Rust error string.
 */
async function renameSavedSession(args = {}) {
  const { path: sessionPath = null, title = '' } = args || {};
  const root = resolveSessionsRoot(args);
  await renameSavedSessionAt(root, sessionPath, title);
  return null;
}

module.exports = {
  deleteSavedSession,
  renameSavedSession,
  // Exported for tests and for callers that resolve a tree explicitly.
  deleteSavedSessionAt,
  renameSavedSessionAt,
  canonicalSessionPath,
  cleanTitle,
  ioErrorText,
};