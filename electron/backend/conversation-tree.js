/* electron/backend/conversation-tree.js — Node port of
   `src-tauri/src/conversation_tree/` (`mod.rs` + `family.rs` + `parse.rs`),
   the `conversation_tree` command behind the conversation-tree navigator
   (`src/app/conversation-tree.js`).

   The active conversation and every file it was branched/forked from or into,
   merged into one entry graph. omp's `branch`/`fork` write a new `.jsonl` next
   to the old one whose `session` header names the origin in `parentSession`;
   a family is the connected component of those links among the `.jsonl`
   files of ONE directory (subagent sessions live in a sub-folder named after
   their parent file and never join).

   Parity notes (each mirrors the Rust line it replaces):
   - Only the entries the navigator draws are kept: user/assistant messages,
     compactions and `cache-warm` `model_usage` records. Everything else
     (tool results, custom entries, model changes, …) collapses: its children
     point to its nearest kept ancestor.
   - Files merge in family order (current first, then oldest by name), and
     entries merge by id, so a branched/forked prefix is listed once with
     `inCurrent` telling whether the current file carries it.
   - `clip` keeps the first 300 code points, `trim_end`s, and maps empty to
     null; message `content` is read only as far as the first non-empty text
     block (a string body included).
   - `ttl` comes from `cttl` (`ephemeral1h` → 3600, else `ephemeral5m` → 300,
     only when > 0); per-token cache costs from `cost`.
   - Labels are keyed by their raw target (an empty label deletes that target
     only), then each kept entry takes its latest surviving label.
   - Line deserialisation is strict about declared types: one wrong-typed
     field drops the whole line, exactly like `serde`'s typed `Line`.
   - Errors carry the Rust strings; an I/O error is rendered Rust-style
     ("<strerror> (os error <n>)").
   - `fork`/`branch` themselves are omp RPC commands (`{type:"fork"}`), not
     Tauri commands: this module ports the tree read only.
*/

'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const savedSessions = require('./saved-sessions');
const stores = require('./stores');

const { canonicalIdFromStem, sessionsRootFor } = savedSessions;

/** `family::MAX_FAMILY_FILES` — closest files to the current one win. */
const MAX_FAMILY_FILES = 32;
/** `parse::MAX_TEXT_CHARS` — longest prompt/reply text kept per entry. */
const MAX_TEXT_CHARS = 300;
/** `family::HEADER_LINES` — `title`, `session`, and a little slack. */
const HEADER_LINES = 4;
/** `family::HEADER_BYTES` — so a malformed file cannot be read whole. */
const HEADER_BYTES = 64 * 1024;

const CHUNK_BYTES = 64 * 1024;

// ── io error rendering ─────────────────────────────────────────────────────

/** `io::Error`'s Display texts, keyed by Node's errno code. */
const IO_ERRORS = {
  EPERM: ['Operation not permitted', 1],
  ENOENT: ['No such file or directory', 2],
  EACCES: ['Permission denied', 13],
  ENOTDIR: ['Not a directory', 20],
  EISDIR: ['Is a directory', 21],
  ENAMETOOLONG: ['File name too long', 36],
  ELOOP: ['Too many levels of symbolic links', 62],
  EMFILE: ['Too many open files', 24],
  ENFILE: ['Too many open files in system', 23],
  EROFS: ['Read-only file system', 30],
  ENOSPC: ['No space left on device', 28],
  EIO: ['Input/output error', 5],
};

/** Rust's `io::Error` Display: `"<strerror> (os error <n>)"`. */
function ioMessage(err) {
  const entry = err && err.code ? IO_ERRORS[err.code] : undefined;
  if (entry) {
    const errno = typeof err.errno === 'number' ? Math.abs(err.errno) : entry[1];
    return `${entry[0]} (os error ${errno})`;
  }
  return err && err.message ? err.message : String(err);
}

// ── path helpers ───────────────────────────────────────────────────────────

/** File name (last component, either separator) of a `parentSession` path. */
function baseName(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

/** `Path::extension` — the portion after the last dot of the file name. */
function fileExtension(p) {
  const base = baseName(p);
  if (base === '' || base === '.' || base === '..') return null;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return base.slice(dot + 1);
}

/** `Path::extension == Some("jsonl")`, case-sensitive like the Rust check. */
function isJsonl(p) {
  return fileExtension(p) === 'jsonl';
}

/** `Path::starts_with`: component-wise, not a raw prefix. */
function isInside(child, root) {
  if (child === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(prefix);
}

// ── typed line reading ─────────────────────────────────────────────────────

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sentinel for "the field is present with a type serde would reject". */
const BAD = Symbol('bad');

/**
 * `Option<String>`: absent or `null` → null, a string → the string, anything
 * else → [`BAD`] (serde fails the whole line).
 */
function optString(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = obj[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : BAD;
}

/** `Option<RawValue>`: any present non-null JSON value. */
function optRaw(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  return obj[key];
}

/** `u64` with serde's integer check (default when absent). */
function optU64(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return 0;
  const value = obj[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : BAD;
}

/** `Option<f64>` (JSON can still overflow to Infinity, which serde rejects). */
function optF64(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const value = obj[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : BAD;
}

/** `usage.cost` — a struct, so `null` is a type error. */
function readCost(value) {
  if (!isObject(value)) return BAD;
  const read = optF64(value, 'cacheRead');
  if (read === BAD) return BAD;
  const write = optF64(value, 'cacheWrite');
  if (write === BAD) return BAD;
  return { cacheRead: read, cacheWrite: write };
}

/** `usage.cttl` — a struct, so `null` is a type error. */
function readCttl(value) {
  if (!isObject(value)) return BAD;
  const five = optF64(value, 'ephemeral5m');
  if (five === BAD) return BAD;
  const hour = optF64(value, 'ephemeral1h');
  if (hour === BAD) return BAD;
  return { ephemeral5m: five, ephemeral1h: hour };
}

/** `parse::Usage` — `#[serde(default)]`, unknown fields ignored. */
function readUsage(value) {
  if (!isObject(value)) return BAD;
  const input = optU64(value, 'input');
  if (input === BAD) return BAD;
  const output = optU64(value, 'output');
  if (output === BAD) return BAD;
  const cacheRead = optU64(value, 'cacheRead');
  if (cacheRead === BAD) return BAD;
  const cacheWrite = optU64(value, 'cacheWrite');
  if (cacheWrite === BAD) return BAD;
  let cost = { cacheRead: null, cacheWrite: null };
  if (Object.prototype.hasOwnProperty.call(value, 'cost')) {
    cost = readCost(value.cost);
    if (cost === BAD) return BAD;
  }
  let cttl = { ephemeral5m: null, ephemeral1h: null };
  if (Object.prototype.hasOwnProperty.call(value, 'cttl')) {
    cttl = readCttl(value.cttl);
    if (cttl === BAD) return BAD;
  }
  return { input, output, cacheRead, cacheWrite, cost, cttl };
}

/** `parse::Message`. */
function readMessage(value) {
  if (!isObject(value)) return BAD;
  const role = optString(value, 'role');
  if (role === BAD) return BAD;
  const attribution = optString(value, 'attribution');
  if (attribution === BAD) return BAD;
  let synthetic = null;
  if (Object.prototype.hasOwnProperty.call(value, 'synthetic')) {
    const raw = value.synthetic;
    if (raw === null) synthetic = null;
    else if (typeof raw === 'boolean') synthetic = raw;
    else return BAD;
  }
  let usage = null;
  if (Object.prototype.hasOwnProperty.call(value, 'usage')) {
    if (value.usage !== null) {
      usage = readUsage(value.usage);
      if (usage === BAD) return BAD;
    }
  }
  return {
    role,
    // Lenient raw values: a malformed timestamp must not cost the entry.
    timestamp: optRaw(value, 'timestamp'),
    content: optRaw(value, 'content'),
    attribution,
    synthetic,
    usage,
  };
}

/**
 * `parse::Line`: `null` when the line is not an object or any declared field
 * has a type serde would reject (the caller drops the line).
 */
function readLine(value) {
  if (!isObject(value)) return null;
  if (typeof value.type !== 'string') return null;
  const line = { type: value.type };
  for (const key of [
    'id',
    'parentId',
    'timestamp',
    'purpose',
    'targetId',
    'label',
    'title',
    'updatedAt',
    'firstKeptEntryId',
    'cwd',
  ]) {
    const field = optString(value, key);
    if (field === BAD) return null;
    line[key] = field;
  }
  line.message = null;
  if (Object.prototype.hasOwnProperty.call(value, 'message') && value.message !== null) {
    const message = readMessage(value.message);
    if (message === BAD) return null;
    line.message = message;
  }
  return line;
}

// ── text ───────────────────────────────────────────────────────────────────

/** Trim, keep the first [`MAX_TEXT_CHARS`] code points, `trim_end`; null if empty. */
function clip(text) {
  const trimmed = text.trim();
  let seen = 0;
  let end = trimmed.length;
  let offset = 0;
  for (const ch of trimmed) {
    if (seen === MAX_TEXT_CHARS) {
      end = offset;
      break;
    }
    seen += 1;
    offset += ch.length;
  }
  const cut = trimmed.slice(0, end).trimEnd();
  return cut === '' ? null : cut;
}

/**
 * First non-empty text of a message `content`: a string body, or the first
 * text block with string text. A structurally invalid block array maps to
 * null, mirroring `serde_json::from_str::<Vec<Block>>`.
 */
function firstText(content) {
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content)) return null;
  const blocks = [];
  for (const block of content) {
    if (!isObject(block)) return null;
    let kind = null;
    if (Object.prototype.hasOwnProperty.call(block, 'type') && block.type !== null) {
      if (typeof block.type !== 'string') return null;
      kind = block.type;
    }
    blocks.push({ kind, hasText: Object.prototype.hasOwnProperty.call(block, 'text'), text: block.text });
  }
  for (const block of blocks) {
    if (block.kind !== 'text' || !block.hasText) continue;
    if (typeof block.text !== 'string') continue;
    const text = clip(block.text);
    if (text !== null) return text;
  }
  return null;
}

// ── entries ────────────────────────────────────────────────────────────────

/** A kept entry with every optional facet empty (`TreeEntry::new`). */
function newEntry(id, parentId, kind, at) {
  return {
    id,
    parentId,
    kind,
    ts: null,
    at,
    text: null,
    agent: false,
    usage: null,
    firstKeptId: null,
    firstKeptExact: false,
    label: null,
    inCurrent: false,
  };
}

/** `From<Usage> for TreeUsage`. */
function treeUsage(usage) {
  const live = (v) => v !== null && v > 0;
  let ttl = null;
  if (live(usage.cttl.ephemeral1h)) ttl = 3600;
  else if (live(usage.cttl.ephemeral5m)) ttl = 300;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ttl,
    costRead: usage.cost.cacheRead,
    costWrite: usage.cost.cacheWrite,
  };
}

/** Fill the message facets of a freshly built user/assistant `entry`. */
function fillMessage(entry, message) {
  entry.ts =
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : null;
  entry.text = message.content !== null ? firstText(message.content) : null;
  if (entry.kind === 'user') {
    entry.agent = message.attribution === 'agent' || message.synthetic === true;
  } else {
    entry.usage = message.usage !== null ? treeUsage(message.usage) : null;
  }
}

/** Which kept kind a line is, decided before anything is allocated. */
function keptKind(line) {
  if (line.type === 'message') {
    const role = line.message === null ? null : line.message.role;
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    return null;
  }
  if (line.type === 'compaction') return 'compaction';
  if (line.type === 'model_usage' && line.purpose === 'cache-warm') return 'warm';
  return null;
}

// ── one file ───────────────────────────────────────────────────────────────

function newState() {
  return {
    cwd: null,
    /** `{at, title}` of the newest non-empty title seen. */
    title: null,
    /** Every entry id → nearest kept ancestor-or-self index (or null). */
    keptOf: new Map(),
    entries: [],
    /** `{target, label}` in file order. */
    labels: [],
    /** Kept ancestor-or-self index of the last line that had an id. */
    leaf: null,
  };
}

/** Index of the kept ancestor-or-self of the entry `id`. */
function keptIndex(state, id) {
  const kept = state.keptOf.get(id);
  return kept === undefined ? null : kept;
}

function considerTitle(state, at, title) {
  const text = title === null ? '' : title.trim();
  if (text === '') return;
  const stamp = at === null ? '' : at;
  // The header line is rewritten on every retitle and carries the newest
  // `updatedAt`; ties go to the later line.
  if (state.title === null || stamp >= state.title.at) state.title = { at: stamp, title: text };
}

/** Push the kept entry for `line`; returns its index. */
function pushKept(state, id, kind, parent, line) {
  const parentId = parent === null ? null : state.entries[parent].id;
  const entry = newEntry(id, parentId, kind, line.timestamp);
  if (kind === 'user' || kind === 'assistant') {
    if (line.message !== null) fillMessage(entry, line.message);
  } else if (kind === 'compaction') {
    if (line.firstKeptEntryId !== null) {
      const kept = keptIndex(state, line.firstKeptEntryId);
      entry.firstKeptId = kept === null ? null : state.entries[kept].id;
      entry.firstKeptExact = kept !== null && state.entries[kept].id === line.firstKeptEntryId;
    }
  }
  state.entries.push(entry);
  return state.entries.length - 1;
}

function applyLine(state, line) {
  if (line.type === 'title') return considerTitle(state, line.updatedAt, line.title);
  if (line.type === 'session') {
    state.cwd = line.cwd;
    return;
  }
  const id = line.id;
  if (id === null) return;
  const parent = line.parentId === null ? null : keptIndex(state, line.parentId);
  let kept;
  const kind = keptKind(line);
  if (kind !== null) {
    kept = pushKept(state, id, kind, parent, line);
  } else {
    if (line.type === 'title_change') considerTitle(state, line.timestamp, line.title);
    else if (line.type === 'label' && line.targetId !== null) {
      state.labels.push({ target: line.targetId, label: line.label === null ? '' : line.label });
    }
    kept = parent;
  }
  state.keptOf.set(id, kept);
  state.leaf = kept;
}

/** `State::finish` — labels, leaf id, and the `TreeFile` header facts. */
function finish(state, filePath) {
  // omp keys a label by its raw target: an empty one removes that target's
  // label only, never another entry collapsed into the same kept ancestor.
  const byTarget = new Map();
  state.labels.forEach((item, order) => {
    const label = item.label.trim();
    if (label === '') byTarget.delete(item.target);
    else byTarget.set(item.target, { order, label });
  });
  // Per kept entry the label of the latest line wins.
  const latest = new Map();
  for (const [target, record] of byTarget) {
    const kept = keptIndex(state, target);
    if (kept === null) continue;
    const prev = latest.get(kept);
    if (prev === undefined || record.order > prev.order) latest.set(kept, record);
  }
  for (const [kept, record] of latest) state.entries[kept].label = record.label;

  return {
    file: {
      path: filePath,
      cwd: state.cwd,
      title: state.title === null ? null : state.title.title,
      leafId: state.leaf === null ? null : state.entries[state.leaf].id,
      current: false,
    },
    entries: state.entries,
  };
}

function decodeLine(bytes, decoder) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    // Not UTF-8: the line is consumed, move on to the next.
    return null;
  }
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * The lines of `filePath` (terminator and CR stripped), skipping invalid
 * UTF-8 lines and ending quietly on a mid-file read error. Open failures
 * throw (the caller maps them to "cannot read").
 */
async function* linesOf(filePath) {
  const handle = await fsp.open(filePath, 'r');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  /** Pieces of a line that spans chunks; joined once per line. */
  let pending = null;
  try {
    for (;;) {
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(buf, 0, buf.length, null));
      } catch {
        return;
      }
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      let nl = chunk.indexOf(0x0a, start);
      while (nl !== -1) {
        let piece = chunk.subarray(start, nl);
        if (pending !== null) {
          pending.push(piece);
          piece = Buffer.concat(pending);
          pending = null;
        }
        const line = decodeLine(piece, decoder);
        if (line !== null) yield line;
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) {
        // `buf` is reused by the next read, so the tail is copied now.
        const rest = Buffer.from(chunk.subarray(start));
        if (pending === null) pending = [rest];
        else pending.push(rest);
      }
    }
    if (pending !== null) {
      const line = decodeLine(Buffer.concat(pending), decoder);
      if (line !== null) yield line;
    }
  } finally {
    try {
      await handle.close();
    } catch {
      /* already closed / gone */
    }
  }
}

/**
 * Parse one session `.jsonl` → `{file, entries}` (kept entries in file order,
 * every parent before its children), skipping unreadable and malformed lines.
 * Throws when the file cannot be opened.
 */
async function parseFile(filePath) {
  const state = newState();
  for await (const raw of linesOf(filePath)) {
    let value;
    try {
      value = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const line = readLine(value);
    if (line !== null) applyLine(state, line);
  }
  return finish(state, filePath);
}

// ── family ─────────────────────────────────────────────────────────────────

/** The fields `family::Head` declares; a wrong type rejects the line. */
function readHead(value) {
  if (!isObject(value) || typeof value.type !== 'string') return null;
  const id = optString(value, 'id');
  if (id === BAD) return null;
  const parent = optString(value, 'parentSession');
  if (parent === BAD) return null;
  return { type: value.type, id, parentSession: parent };
}

/**
 * The `session` header of `filePath` (first [`HEADER_LINES`] lines within
 * [`HEADER_BYTES`]); empty for an unreadable or absent header.
 */
async function headerOf(filePath) {
  const empty = { id: null, parent: null };
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return empty;
  }
  let bytes;
  try {
    const buf = Buffer.allocUnsafe(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    bytes = buf.subarray(0, bytesRead);
  } catch {
    return empty;
  } finally {
    try {
      await handle.close();
    } catch {
      /* gone */
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  let taken = 0;
  while (taken < HEADER_LINES) {
    let end = bytes.indexOf(0x0a, start);
    const last = end === -1;
    if (last) end = bytes.length;
    // A trailing newline closes the final line; nothing follows it.
    if (!(last && start === bytes.length)) {
      taken += 1;
      let text;
      try {
        text = decoder.decode(bytes.subarray(start, end));
      } catch {
        // `map_while(Result::ok)` stops at the first unreadable line.
        break;
      }
      if (text.endsWith('\r')) text = text.slice(0, -1);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      const head = value === undefined ? null : readHead(value);
      if (head !== null && head.type === 'session') return { id: head.id, parent: head.parentSession };
    }
    if (last) break;
    start = end + 1;
  }
  return empty;
}

/**
 * File names of the family of `current` (a `.jsonl` name inside `dir`):
 * `current` first, the rest oldest first by name, at most
 * [`MAX_FAMILY_FILES`]. Throws when `dir` cannot be listed.
 */
async function familyOf(dir, current) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const files = new Map();
  for (const item of dirents) {
    // `DirEntry::file_type` does not follow symlinks: only regular files join.
    if (!item.isFile()) continue;
    if (fileExtension(item.name) !== 'jsonl') continue;
    files.set(item.name, await headerOf(path.join(dir, item.name)));
  }
  const names = [...files.keys()].sort();

  // The file-name id is the durable one (a header `id` can be stale), so it
  // is inserted last and wins a clash.
  const byId = new Map();
  for (const name of names) {
    const id = files.get(name).id;
    if (id !== null) byId.set(id, name);
  }
  for (const name of names) {
    const id = canonicalIdFromStem(name);
    if (id !== null) byId.set(id, name);
  }

  const links = new Map();
  for (const name of names) {
    const raw = files.get(name).parent;
    if (raw === null) continue;
    const parent = resolveParent(raw, files, byId);
    if (parent === null) continue;
    if (!links.has(name)) links.set(name, []);
    links.get(name).push(parent);
    if (!links.has(parent)) links.set(parent, []);
    links.get(parent).push(name);
  }
  for (const neighbours of links.values()) neighbours.sort();

  const seen = new Set([current]);
  const queue = [current];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of links.get(queue[head]) ?? []) {
      if (seen.size < MAX_FAMILY_FILES && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const rest = [...seen].filter((name) => name !== current).sort();
  rest.unshift(current);
  return rest;
}

/**
 * The listed file a `parentSession` value names. A value with a path
 * separator or a `.jsonl` suffix is a path and links by file name; omp's TUI
 * `/fork`, `--fork` and move-off write the parent's bare session id instead.
 */
function resolveParent(raw, files, byId) {
  const suffix = fileExtension(raw);
  const hasSuffix = suffix !== null && suffix.toLowerCase() === 'jsonl';
  if (raw.includes('/') || raw.includes('\\') || hasSuffix) {
    const base = baseName(raw);
    return files.has(base) ? base : null;
  }
  return byId.has(raw) ? byId.get(raw) : null;
}

// ── validation + build ─────────────────────────────────────────────────────

/**
 * Require `sessionFile` to be a `.jsonl` file under `root` and return its
 * directory and file name, or `null` for a file omp has not written yet.
 *
 * omp creates the session file lazily, once the first assistant message
 * exists, yet `get_state().sessionFile` reports the path from the start. Such
 * a path is accepted (as an empty tree) only while it still is a `.jsonl`
 * name that is not a dangling link, in an existing directory under `root`.
 * Paths stay in the caller's spelling so they match what omp reported.
 */
async function validateSessionFile(root, sessionFile) {
  const shown = sessionFile;
  let rootPath;
  try {
    rootPath = await fsp.realpath(root);
  } catch (err) {
    throw new Error(`sessions directory unavailable: ${ioMessage(err)}`);
  }
  const outside = () => new Error(`session file ${shown} is outside the sessions directory`);
  const notJsonl = () => new Error(`${shown} is not a .jsonl session file`);

  const name = path.basename(sessionFile);
  // `Path::file_name` is None for a trailing separator, `.` and `..`.
  if (name === '' || name === '.' || name === '..') {
    throw new Error(`${shown} has no usable file name`);
  }
  const hasSeparator =
    process.platform === 'win32' ? /[\\/]/.test(sessionFile) : sessionFile.includes('/');
  if (!hasSeparator) throw new Error(`${shown} has no directory`);
  const dir = path.dirname(sessionFile);

  let resolved;
  try {
    resolved = await fsp.realpath(sessionFile);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw new Error(`session file unavailable: ${shown} (${ioMessage(err)})`);
    }
    // The lazily written path branch.
    if (!isJsonl(sessionFile)) throw notJsonl();
    let dangling = true;
    try {
      await fsp.lstat(sessionFile);
    } catch {
      dangling = false;
    }
    if (dangling) throw new Error(`session file ${shown} is a dangling link`);
    let parent;
    try {
      parent = await fsp.realpath(dir);
    } catch (err2) {
      throw new Error(`session file does not exist: ${shown} (${ioMessage(err2)})`);
    }
    if (!isInside(parent, rootPath)) throw outside();
    let stat;
    try {
      stat = await fsp.stat(parent);
    } catch {
      stat = null;
    }
    if (stat === null || !stat.isDirectory()) {
      throw new Error(`session file does not exist: ${shown}`);
    }
    return null;
  }

  if (!isInside(resolved, rootPath)) throw outside();
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isFile() || !isJsonl(resolved)) throw notJsonl();
  return { dir, name };
}

/**
 * Build the tree of `sessionFile`'s family under sessions `root` (see
 * [`conversationTree`]). Exported so tests can drive it against a fixture
 * root the way the Rust unit tests do.
 */
async function buildTree(root, sessionFile) {
  const valid = await validateSessionFile(root, sessionFile);
  // A conversation omp has not written yet has no tree.
  if (valid === null) return { files: [], entries: [] };
  const { dir, name } = valid;

  let names;
  try {
    names = await familyOf(dir, name);
  } catch (err) {
    throw new Error(`cannot list ${dir}: ${ioMessage(err)}`);
  }

  const files = [];
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < names.length; index += 1) {
    const isCurrent = index === 0;
    const filePath = path.join(dir, names[index]);
    let parsed;
    try {
      parsed = await parseFile(filePath);
    } catch (err) {
      if (isCurrent) throw new Error(`cannot read ${filePath}: ${ioMessage(err)}`);
      // A relative that cannot be read is left out of the family.
      continue;
    }
    const file = parsed.file;
    file.current = isCurrent;
    files.push(file);
    for (const entry of parsed.entries) {
      // Checked before inserting: most of a relative is the shared prefix.
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entry.inCurrent = isCurrent;
      entries.push(entry);
    }
  }
  return { files, entries };
}

// ── command ────────────────────────────────────────────────────────────────

/**
 * `conversation_tree`: the conversation tree of `args.sessionFile` for
 * `args.profile`. Mirrors the Rust command: the profile is resolved through
 * the profile store (an unknown one is an error), the sessions root comes
 * from the profile's agent dir, and every error is the Rust string.
 */
async function conversationTree(args) {
  const { sessionFile, profile = null } = args ?? {};
  if (typeof sessionFile !== 'string' || sessionFile === '') {
    throw new Error('missing sessionFile');
  }
  const resolved = stores.resolveProfile(profile ?? null);
  const home = os.homedir();
  if (!home) throw new Error('home directory unavailable');
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const root = sessionsRootFor(home, resolved, envDir ? envDir : null);
  return buildTree(root, sessionFile);
}

module.exports = {
  conversationTree,
  buildTree,
  validateSessionFile,
  familyOf,
  parseFile,
  headerOf,
  clip,
  firstText,
  resolveParent,
  baseName,
  fileExtension,
  ioMessage,
  MAX_FAMILY_FILES,
  MAX_TEXT_CHARS,
  HEADER_LINES,
  HEADER_BYTES,
  // Re-exported so callers can resolve the sessions root the command uses
  // without a second require.
  sessionsRootFor,
};