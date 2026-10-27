'use strict';

/* remote-files.js — the phone-facing file/relay-side backend of the port.

   One-for-one ports of four Rust modules:

     src-tauri/src/remote_transcript.rs  → transcriptWindow()
     src-tauri/src/remote_replay.rs      → replayProject()
     src-tauri/src/remote_dirs.rs        → listDirs()
     src-tauri/src/remote/settings.rs    → remoteSettingsLoad/Save/phoneMs()

   Parity notes (each mirrors the Rust line it replaces):

   - `transcriptWindow` scans the session `.jsonl` for `message` rows with a
     byte-level, string- and depth-aware scanner — never a first-`"type"`-
     match, because omp's serializer orders keys alphabetically and a nested
     `content[].type` precedes the row's own. Only the window's lines are
     JSON-parsed; the scan is one byte pass and the newest page seeks to the
     window's first row instead of reading the whole file.
   - The cursor is the phone's `sliceWindow` cursor: `nextBefore` is an
     absolute message index, `hasOlder` says whether rows precede the window.
   - Per-block caps (4000 chars + the truncation suffix) bound one block; the
     300 KB wire budget sheds the oldest rows of the window until the reply
     fits, and only the newest row is never shed.
   - `replayProject` drops `rpc_chunk` envelopes (the phone's content comes
     from its transcript window), keeps unparseable text verbatim, bounds the
     reply to the newest 400 surviving events and reports `dropped` so the
     phone refetches the gap.
   - `listDirs` lists one directory level: subdirectories only (symlinks
     followed, like `Path::is_dir`), dot-prefixed entries hidden on unix and
     the two Windows bookkeeping folders hidden on win32, case-insensitive
     sort with the exact name as tie-break, 500-entry cap, and the platform
     roots when `path` is null.
   - `remote.json` keeps serde's exact snake_case field names and defaults;
     every phone entry is `{ ms?: string }`, and an entry without `ms` is a
     pre-v2 pairing, which `phoneMs` reports as unpaired (null). Writes are
     atomic (`<file>.<pid>-<n>.tmp` + fsync + rename, first-write orphan
     sweep) and serialize with serde_json's pretty shape (2-space indent, no
     trailing newline) in struct field order.

   Deliberate differences from the Rust originals:

   - Everything is synchronous. The Electron main process owns these files
     and is single-threaded; the Rust `off_ipc` wrappers exist only to keep
     the Tauri UI thread free, which has no counterpart here.
   - `before`/`limit` are clamped instead of relying on `usize` decoding, and
     `replayProject` accepts either the `replay_events` reply (`{events,
     headSeq, dropped}`) or the journal's entry ring plus `afterSeq` — the
     ring form derives `headSeq`/`dropped` exactly like `EventJournal::since`
     so the connector can hand it either shape.
   - `listDirs`' parent for a relative path is `''` (Rust's empty `Path`
     display) rather than Node's `'.'`.
*/

const fs = require('node:fs');
const path = require('node:path');

const stores = require('./stores');

// ── transcript window ──────────────────────────────────────────────────────

/** Reply size when the caller asks for no particular window. */
const DEFAULT_LIMIT = 200;
/** Smallest window the caller may request (the phone needs at least one row). */
const MIN_LIMIT = 1;
/** Ceiling on one window, in messages. */
const MAX_LIMIT = 1000;
/** Longest block text kept verbatim; longer blocks are cut and marked. */
const MAX_BLOCK_CHARS = 4000;
/** Appended to a capped block so the phone's UI can say why it stops. */
const TRUNCATION_SUFFIX = '\n…[truncated for phone]';
/** Ceiling on one window's serialized size, in bytes (`MAX_WINDOW_BYTES`). */
const MAX_WINDOW_BYTES = 300_000;

// Byte values the scanner compares against (the Rust code works on `&[u8]`).
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE = 0x0a;
/** `"message"` as the value literal the scanner compares (opening quote too). */
const MESSAGE_LITERAL = Buffer.from('"message"', 'latin1');
/** The only top-level key that identifies a message row. */
const TYPE_KEY = 'type';

/** `serde_json`'s UTF-8 rejection: a damaged line is skipped, not fatal. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function isStructuralSpace(byte) {
  return byte === SPACE || byte === TAB || byte === 0x0d /* \r */ || byte === NEWLINE
    || byte === COMMA || byte === COLON;
}

/**
 * Index just past the string starting at `i` (its opening quote).
 * `skip_string` in remote_transcript.rs.
 */
function skipString(b, i) {
  let j = i + 1;
  while (j < b.length) {
    if (b[j] === BACKSLASH) j += 2;
    else if (b[j] === QUOTE) return j + 1;
    else j += 1;
  }
  return b.length;
}

/**
 * Index just past the `[`/`{` run starting at `i`, strings and nesting aware.
 * Literal port of `skip_brackets`, including its treatment of a bracket kind
 * that does not match the run's opener (malformed input stays bounded).
 */
function skipBrackets(b, i) {
  const open = b[i];
  const close = open === LBRACKET ? RBRACKET : RBRACE;
  let j = i + 1;
  let depth = 1;
  while (j < b.length && depth > 0) {
    const c = b[j];
    if (c === QUOTE) {
      j = skipString(b, j);
    } else if (c === open) {
      depth += 1;
      j += 1;
    } else if (c === close) {
      depth -= 1;
      j += 1;
    } else if (c === LBRACKET || c === LBRACE) {
      j = skipBrackets(b, j);
    } else {
      j += 1;
    }
  }
  return j;
}

/** Index just past the scalar/compound value starting at `i` (`skip_value`). */
function skipValue(b, i) {
  const c = b[i];
  if (c === QUOTE) return skipString(b, i);
  if (c === LBRACKET || c === LBRACE) return skipBrackets(b, i);
  let j = i;
  while (j < b.length && b[j] !== COMMA && b[j] !== RBRACE && b[j] !== RBRACKET) j += 1;
  return j;
}

/**
 * Whether a raw jsonl line (bytes, terminator included) is a `message` row,
 * without parsing it: walk the top-level keys and compare the `type` key's
 * string value. String- and depth-aware, so a nested `"type"` never counts.
 * The Rust `is_message_row`.
 */
function isMessageRow(line) {
  const b = line;
  let i = 0;
  let depth = 0;
  for (;;) {
    while (i < b.length && isStructuralSpace(b[i])) i += 1;
    if (i >= b.length) return false;
    const c = b[i];
    if (c === LBRACE) {
      depth += 1;
      i += 1;
    } else if (c === RBRACE) {
      depth -= 1;
      i += 1;
    } else if (c === LBRACKET) {
      i = skipBrackets(b, i);
    } else if (c === RBRACKET) {
      i += 1;
    } else if (c === QUOTE) {
      const end = skipString(b, i);
      if (depth !== 1) {
        i = end;
        continue;
      }
      // Top-level key (machine-written keys carry no escapes).
      const key = b.subarray(i + 1, end - 1);
      i = end;
      while (i < b.length && (b[i] === SPACE || b[i] === TAB || b[i] === COLON)) i += 1;
      if (key.length === TYPE_KEY.length && key.toString('latin1') === TYPE_KEY) {
        if (i + MESSAGE_LITERAL.length > b.length) return false;
        for (let k = 0; k < MESSAGE_LITERAL.length; k += 1) {
          if (b[i + k] !== MESSAGE_LITERAL[k]) return false;
        }
        return true;
      }
      i = skipValue(b, i);
    } else {
      i = skipValue(b, i); // number, true, false, null
    }
  }
}

/**
 * Streaming `BufRead::read_until(b'\n')` reader over a file descriptor,
 * starting at a byte offset. Returns each line including its terminator, and
 * a final unterminated line, exactly like the Rust loop.
 */
class LineReader {
  constructor(file, start) {
    this.fd = fs.openSync(file, 'r');
    this.pos = start;
    this.buf = Buffer.alloc(0);
    this.eof = false;
  }

  next() {
    for (;;) {
      const nl = this.buf.indexOf(NEWLINE);
      if (nl >= 0) {
        const line = this.buf.subarray(0, nl + 1);
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.eof) {
        if (this.buf.length === 0) return null;
        const line = this.buf;
        this.buf = Buffer.alloc(0);
        return line;
      }
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const read = fs.readSync(this.fd, chunk, 0, chunk.length, this.pos);
      if (read === 0) {
        this.eof = true;
        continue;
      }
      this.pos += read;
      const filled = chunk.subarray(0, read);
      this.buf = this.buf.length === 0 ? filled : Buffer.concat([this.buf, filled]);
    }
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      // Best-effort, like the Rust reader dropping the handle.
    }
  }
}

/** `scan_messages`: byte offset of every `message` row, oldest first. */
function scanMessages(file) {
  let reader;
  try {
    reader = new LineReader(file, 0);
  } catch (err) {
    throw new Error(`open ${file}: ${err.message}`);
  }
  const offsets = [];
  let offset = 0;
  try {
    for (;;) {
      let line;
      try {
        line = reader.next();
      } catch (err) {
        throw new Error(`read ${file}: ${err.message}`);
      }
      if (line === null) break;
      const start = offset;
      offset += line.length;
      try {
        UTF8.decode(line);
      } catch {
        continue; // not UTF-8: a damaged line must not hide the rest
      }
      if (isMessageRow(line)) offsets.push(start);
    }
  } finally {
    reader.close();
  }
  return offsets;
}

/** Whether `text` has more than `max` Unicode scalar values (char count). */
function exceedsChars(text, max) {
  let count = 0;
  for (const _ of text) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/** `text` cut to `max` Unicode scalar values (Rust `&text[..cut]`). */
function prefixChars(text, max) {
  let count = 0;
  let index = 0;
  for (const ch of text) {
    if (count === max) break;
    count += 1;
    index += ch.length;
  }
  return text.slice(0, index);
}

/**
 * Cap every long text block in `message.content` in place. Only the block
 * types that render as text are touched; ids, roles, images and unknown
 * fields pass through untouched (`cap_blocks`).
 */
function capBlocks(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
  const blocks = message.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const kind = block.type;
    let field;
    if (kind === 'text') field = 'text';
    else if (kind === 'thinking') field = 'thinking';
    else if (kind === 'toolResult') field = 'content';
    else continue;
    const value = block[field];
    if (typeof value !== 'string') continue;
    if (!exceedsChars(value, MAX_BLOCK_CHARS)) continue;
    block[field] = capped(value);
  }
}

/** `capped`: cut to the char cap plus the truncation suffix. */
function capped(text) {
  return prefixChars(text, MAX_BLOCK_CHARS) + TRUNCATION_SUFFIX;
}

/**
 * `load_from`: `count` message rows from byte offset `from`, oldest first,
 * capped. Rows of other types and rows that do not parse are skipped.
 */
function loadFrom(file, from, count) {
  let reader;
  try {
    reader = new LineReader(file, from);
  } catch (err) {
    throw new Error(`open ${file}: ${err.message}`);
  }
  const messages = [];
  try {
    while (messages.length < count) {
      let line;
      try {
        line = reader.next();
      } catch (err) {
        throw new Error(`read ${file}: ${err.message}`);
      }
      if (line === null) break;
      let text;
      try {
        text = UTF8.decode(line);
      } catch {
        continue;
      }
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        continue;
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      if (row.type !== 'message') continue;
      if (!Object.prototype.hasOwnProperty.call(row, 'message')) continue;
      const message = row.message;
      capBlocks(message);
      messages.push(message);
    }
  } finally {
    reader.close();
  }
  return messages;
}

/**
 * One contiguous, oldest-first page of a session's messages:
 * `{messages, hasOlder, nextBefore}` — the `TranscriptWindow` wire shape.
 *
 * `before` is the exclusive end cursor (absent = the newest page), `limit`
 * the page size (default 200, clamped to 1..=1000). Throws when the file
 * cannot be opened or read, with the Rust message shape.
 */
function transcriptWindow(sessionFile, before = null, limit = null) {
  const requested = limit === null || limit === undefined ? DEFAULT_LIMIT : Number(limit);
  const pageLimit = Number.isFinite(requested)
    ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(requested)))
    : DEFAULT_LIMIT;
  const offsets = scanMessages(sessionFile);
  const len = offsets.length;
  const rawCursor = before === null || before === undefined ? len : Number(before);
  const cursor = Number.isFinite(rawCursor) ? Math.max(0, Math.trunc(rawCursor)) : len;
  const end = Math.min(cursor, len);
  let start = Math.max(0, end - pageLimit);
  const from = start < offsets.length ? offsets[start] : 0;
  const messages = loadFrom(sessionFile, from, end - start);

  // Shed the oldest rows until the serialized window fits the uplink budget.
  // Each row is serialized once; the cursor follows what was actually sent.
  const sizes = messages.map((message) => {
    try {
      return Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch {
      return 0;
    }
  });
  let total = sizes.reduce((sum, size) => sum + size, 0);
  while (messages.length > 1 && total > MAX_WINDOW_BYTES) {
    total -= sizes.shift();
    messages.shift();
    start += 1;
  }

  return { messages, hasOlder: start > 0, nextBefore: start };
}

// ── projected replay ───────────────────────────────────────────────────────

/** Most events a projected replay carries (`MAX_PROJECTED_EVENTS`). */
const MAX_PROJECTED_EVENTS = 400;

/** `is_rpc_chunk`: text parses to a JSON object with `type == "rpc_chunk"`. */
function isRpcChunk(text) {
  if (typeof text !== 'string') return false;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false; // unparseable text is not a chunk
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.type === 'rpc_chunk';
}

/**
 * Remove the frames the phone cannot use and bound the count
 * (`project_replay`).
 *
 * `replay` is either the `replay_events` reply (`{events, headSeq, dropped}`,
 * events already filtered by the journal) or the journal's entry ring (an
 * array of `{seq, text}`), in which case `afterSeq` filters it and
 * `headSeq`/`dropped` are derived like `EventJournal::since`.
 *
 * Returns `{events, headSeq, dropped}`: `rpc_chunk` envelopes removed, the
 * newest 400 surviving events kept, and `dropped` set when the projection
 * itself removed events (any existing `dropped` passes through).
 */
function replayProject(replay, afterSeq = 0) {
  const rawCursor = Number(afterSeq);
  const cursor = Number.isFinite(rawCursor) ? Math.max(0, Math.trunc(rawCursor)) : 0;
  let source;
  let headSeq;
  let dropped;
  if (Array.isArray(replay)) {
    const entries = replay;
    headSeq = entries.reduce(
      (max, entry) => (entry && Number(entry.seq) > max ? Number(entry.seq) : max),
      0,
    );
    const oldest = entries.length > 0 && entries[0] ? entries[0].seq : null;
    dropped = oldest === null ? cursor < headSeq : oldest > cursor + 1;
    source = entries.filter((entry) => entry && entry.seq > cursor);
  } else {
    const reply = replay || {};
    source = Array.isArray(reply.events) ? reply.events : [];
    headSeq = typeof reply.headSeq === 'number' ? reply.headSeq : 0;
    dropped = Boolean(reply.dropped);
  }

  // Walk newest-first so the cap stops the work early: a long replay is
  // mostly chunks the phone will never see.
  const kept = [];
  let capped = false;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const event = source[i];
    if (isRpcChunk(event.text)) continue;
    if (kept.length === MAX_PROJECTED_EVENTS) {
      capped = true;
      break;
    }
    kept.push(event);
  }
  kept.reverse();
  return {
    events: kept.map((event) => ({ seq: event.seq, text: event.text })),
    headSeq,
    dropped: dropped || capped,
  };
}

// ── directory listing ──────────────────────────────────────────────────────

/** Ceiling on the subdirectories one listing returns (`MAX_ENTRIES`). */
const MAX_ENTRIES = 500;

/** `Path::is_dir`: true only for an existing directory (symlinks followed). */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** `is_hidden`: dot-prefixed on unix, two bookkeeping folders on Windows. */
function isHiddenName(name) {
  if (process.platform !== 'win32') return name.startsWith('.');
  const lower = name.toLowerCase();
  return lower === '$recycle.bin' || lower === 'system volume information';
}

/** Candidate roots before the existence check (`root_candidates`). */
function rootCandidates() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let code = 65; code <= 90; code += 1) {
      roots.push(`${String.fromCharCode(code)}:\\`);
    }
    const profile = process.env.USERPROFILE;
    if (profile) roots.push(profile);
    return roots;
  }
  const roots = ['/'];
  for (const dir of ['/Users', '/home']) {
    if (isDirectory(dir)) roots.push(dir);
  }
  const home = process.env.HOME;
  if (home) roots.push(home);
  return roots;
}

/** The roots listing: existing starting points, deduplicated, fixed order. */
function roots() {
  const seen = new Set();
  const entries = [];
  for (const candidate of rootCandidates()) {
    if (!isDirectory(candidate)) continue;
    const entryPath = String(candidate);
    if (seen.has(entryPath)) continue;
    const base = path.basename(entryPath);
    const name = base.length > 0 ? base : entryPath;
    seen.add(entryPath);
    entries.push({ name, path: entryPath });
  }
  return entries;
}

/** `Path::parent` display: `null` at a filesystem root, `''` when relative. */
function rustParent(target) {
  if (!path.isAbsolute(target)) return '';
  const parsed = path.parse(target);
  if (parsed.root === target) return null;
  const dir = path.dirname(target);
  return dir === target ? null : dir;
}

/**
 * `remote_list_dirs`: the subdirectories of `target`, or the platform roots
 * when it is null/undefined.
 *
 * Throws with the Rust message shape (`"<path>: <io error>"`,
 * `"<path>: not a directory"`) when the path cannot be listed.
 */
function listDirs(target) {
  if (target === null || target === undefined) {
    return { parent: null, entries: roots() };
  }
  if (typeof target !== 'string') {
    throw new TypeError('remote_list_dirs: path must be a string');
  }
  let meta;
  try {
    meta = fs.statSync(target);
  } catch (err) {
    throw new Error(`${target}: ${err.message}`);
  }
  if (!meta.isDirectory()) throw new Error(`${target}: not a directory`);
  let names;
  try {
    names = fs.readdirSync(target);
  } catch (err) {
    throw new Error(`${target}: ${err.message}`);
  }

  const entries = [];
  for (const name of names) {
    // `entry_path.is_dir()` follows symlinks, so a symlinked directory is
    // offered as a browsable folder.
    const entryPath = path.join(target, name);
    if (!isDirectory(entryPath)) continue;
    if (isHiddenName(name)) continue;
    entries.push({ name, path: entryPath });
  }
  // Case-insensitive primary key; the exact name breaks ties.
  entries.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  entries.length = Math.min(entries.length, MAX_ENTRIES);
  return { parent: rustParent(target), entries };
}

// ── remote.json (`remote/settings.rs`) ─────────────────────────────────────

/** File name inside the app config folder (`config_file("remote.json")`). */
const REMOTE_SETTINGS_FILE = 'remote.json';
/** Scalar fields in the Rust struct's declaration (= serialization) order. */
const SETTINGS_STRINGS = ['server', 'device_id', 'device_token', 'pinned_cert_pem', 'device_name'];

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function logUnreadable(file, reason) {
  process.stderr.write(`[omp-desktop] ${file} unreadable, reading as empty: ${reason}\n`);
}

/** `RemoteSettings::default()` with serde's snake_case field names. */
function emptySettings() {
  return {
    enabled: false,
    server: '',
    device_id: '',
    device_token: '',
    pinned_cert_pem: '',
    device_name: '',
    phones: {},
  };
}

/** The absolute `remote.json` this module reads and writes. */
function remoteSettingsPath() {
  return path.join(stores.configHome(), REMOTE_SETTINGS_FILE);
}

/**
 * `phones` map → `{ [ph]: { ms? } }`, sorted by `ph` like the Rust
 * `BTreeMap`. Returns null when the value is not the struct's shape
 * (serde would reject the whole file).
 */
function normalizePhones(value) {
  if (!isPlainObject(value)) return null;
  const pairs = [];
  for (const ph of Object.keys(value).sort()) {
    const entry = value[ph];
    if (!isPlainObject(entry)) return null;
    if (!has(entry, 'ms') || entry.ms === null) {
      // Pre-v2 pairing: serde's `Option<String>` is None and serializes back
      // as `"ms": null` (the struct has no skip_serializing_if).
      pairs.push([ph, { ms: null }]);
      continue;
    }
    if (typeof entry.ms !== 'string') return null;
    pairs.push([ph, { ms: entry.ms }]);
  }
  return Object.fromEntries(pairs);
}

/**
 * A parsed `remote.json` normalized to `RemoteSettings` (unknown keys
 * dropped, missing fields defaulted), or null when serde would reject it.
 */
function normalizeSettings(value) {
  if (!isPlainObject(value)) return null;
  const out = emptySettings();
  if (has(value, 'enabled')) {
    if (typeof value.enabled !== 'boolean') return null;
    out.enabled = value.enabled;
  }
  for (const key of SETTINGS_STRINGS) {
    if (!has(value, key)) continue;
    if (typeof value[key] !== 'string') return null;
    out[key] = value[key];
  }
  if (has(value, 'phones')) {
    const phones = normalizePhones(value.phones);
    if (phones === null) return null;
    out.phones = phones;
  }
  return out;
}

/**
 * `json_store::read_or_default` over `remote.json`: missing, unreadable or
 * malformed reads as the default settings (logged), so the next write
 * replaces a bad file.
 */
function remoteSettingsLoad() {
  const file = remoteSettingsPath();
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err && err.code !== 'ENOENT') logUnreadable(file, err.message);
    return emptySettings();
  }
  let value;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch (err) {
    logUnreadable(file, err.message);
    return emptySettings();
  }
  const settings = normalizeSettings(value);
  if (settings === null) {
    logUnreadable(file, 'invalid remote settings shape');
    return emptySettings();
  }
  return settings;
}

/** serde_json's `to_vec_pretty`: 2-space indent, struct order, no newline. */
function serializeSettings(settings) {
  const ordered = {
    enabled: settings.enabled,
    server: settings.server,
    device_id: settings.device_id,
    device_token: settings.device_token,
    pinned_cert_pem: settings.pinned_cert_pem,
    device_name: settings.device_name,
    phones: Object.fromEntries(
      Object.keys(settings.phones).sort().map((ph) => [ph, settings.phones[ph]]),
    ),
  };
  return JSON.stringify(ordered, null, 2);
}

let tempCounter = 0;
const sweptDestinations = new Set();

/** Remove leftover `<base>.*.tmp` files from a crashed writer; best-effort. */
function sweepOrphanTempFiles(dir, baseName) {
  const prefix = `${baseName}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (path.extname(name).toLowerCase() !== '.tmp') continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Best-effort, like the Rust sweep.
    }
  }
}

/**
 * `json_store::write_atomic`: unique temp file in the destination directory,
 * fsync, rename over the target. The first write to a destination also
 * sweeps that destination's orphan temp files.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!sweptDestinations.has(file)) {
    sweptDestinations.add(file);
    sweepOrphanTempFiles(dir, base);
  }

  const temp = path.join(dir, `${base}.${process.pid}-${tempCounter++}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // ignore: the original error is what the caller needs
    }
    throw err;
  }
}

/**
 * Merge `patch` onto the current settings: known scalar fields replace when
 * present, and `phones` is merged per phone (an entry is `{ms}`; a missing or
 * null `ms` stores a pre-v2 `{}`), so pairing one phone never drops another.
 * Unknown fields are ignored and bad types throw.
 */
function applyPatch(current, patch) {
  if (!isPlainObject(patch)) {
    throw new TypeError('remote settings patch must be an object');
  }
  const next = { ...current };
  if (has(patch, 'enabled')) {
    if (typeof patch.enabled !== 'boolean') {
      throw new TypeError('remote settings: enabled must be a boolean');
    }
    next.enabled = patch.enabled;
  }
  for (const key of SETTINGS_STRINGS) {
    if (!has(patch, key)) continue;
    if (typeof patch[key] !== 'string') {
      throw new TypeError(`remote settings: ${key} must be a string`);
    }
    next[key] = patch[key];
  }
  if (has(patch, 'phones')) {
    if (!isPlainObject(patch.phones)) {
      throw new TypeError('remote settings: phones must be an object');
    }
    const merged = new Map(Object.entries(current.phones));
    for (const ph of Object.keys(patch.phones)) {
      const entry = patch.phones[ph];
      if (!isPlainObject(entry)) {
        throw new TypeError(`remote settings: phones.${ph} must be an object`);
      }
      if (!has(entry, 'ms') || entry.ms === null) {
        merged.set(ph, { ms: null });
      } else if (typeof entry.ms === 'string') {
        merged.set(ph, { ms: entry.ms });
      } else {
        throw new TypeError(`remote settings: phones.${ph}.ms must be a string`);
      }
    }
    next.phones = Object.fromEntries(merged);
  }
  return next;
}

/**
 * Read-modify-write `remote.json` with `patch` and return the settings that
 * were written (`RemoteSettings` field names, serde's pretty shape).
 */
function remoteSettingsSave(patch = {}) {
  const next = applyPatch(remoteSettingsLoad(), patch);
  writeAtomic(remoteSettingsPath(), serializeSettings(next));
  return next;
}

/**
 * The b64 master secret stored for phone `ph` (`RemoteSettings::phone_ms`),
 * or null when the phone is unknown or paired pre-v2 — both mean "not
 * e2e-paired".
 */
function phoneMs(ph) {
  if (typeof ph !== 'string') return null;
  const settings = remoteSettingsLoad();
  if (!has(settings.phones, ph)) return null;
  const entry = settings.phones[ph];
  return entry && typeof entry.ms === 'string' ? entry.ms : null;
}

// ── exports ────────────────────────────────────────────────────────────────

module.exports = {
  // The wire-facing surface.
  transcriptWindow,
  replayProject,
  listDirs,
  remoteSettingsLoad,
  remoteSettingsSave,
  phoneMs,
  // Constants and internals the parity suite pins (mirror the Rust items).
  isMessageRow,
  isRpcChunk,
  capBlocks,
  capped,
  remoteSettingsPath,
  emptySettings,
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
  MAX_BLOCK_CHARS,
  TRUNCATION_SUFFIX,
  MAX_WINDOW_BYTES,
  MAX_PROJECTED_EVENTS,
  MAX_ENTRIES,
  REMOTE_SETTINGS_FILE,
};