/* electron/backend/saved-sessions.js — Node port of the read half of
   `src-tauri/src/saved_sessions/` (scan/parse, no delete/rename).

   Reads omp's persisted session history for the conversation-history panel:
   `<agent dir>/sessions/<folder>/<filesystem-safe-ISO8601>_<uuid>.jsonl`.
   The agent dir mirrors `profiles::agent_dir_for`: `~/.omp/agent` for the
   built-in profile (`PI_CODING_AGENT_DIR` overrides it, and only it) and
   `~/.omp/profiles/<id>/agent` for a named one.

   Parity notes (all deliberate, each mirrors the Rust line it replaces):
   - `updatedAt` is the max over `message` top-level `timestamp` and `title`
     `updatedAt` only. Lifecycle events (`session`, `custom` `session_exit`,
     `model_change`, …) never bump it, so resuming a dormant session and
     closing the tab without sending a message doesn't reorder history.
   - `preview` is the text of the LATEST user/assistant message (capped at
     120 chars); the fallback title is the FIRST user text (capped at 60).
   - `messageCount` and both preview/title ignore `toolResult` entries.
   - The search corpus is built only when a query is present, is lowercased
     as it is collected, and stops at 100 KiB — then `matchSnippet` returns
     the hit plus 40 chars of context per side.
   - Sessions sort newest-first by `updatedAt ?? timestamp` (plain string
     comparison: every omp timestamp is the same ISO-8601 UTC shape, which
     sorts chronologically), matching `scan_dir`.

   Files are read line-by-line from a streaming reader: the Rust scanner
   JSON-parses one line at a time, never the whole file, and never keeps the
   file in memory. */

'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PROFILE_ID = 'default';
const UNTITLED_TITLE = 'Untitled conversation';
const UNTITLED_PROJECT = 'Default';

/** Byte cap for the per-file search corpus (`TEXT_BLOB_CAP_BYTES`). */
const TEXT_BLOB_CAP_BYTES = 100 * 1024;
/** Chars kept from the first user message as the fallback title. */
const TITLE_CHARS = 60;
/** Chars kept from the latest message text as the preview line. */
const PREVIEW_CHARS = 120;
/** Context chars kept on each side of a `matchSnippet` hit. */
const SNIPPET_CONTEXT_CHARS = 40;
/** `profiles::MAX_ID_LEN`. */
const MAX_PROFILE_ID_LEN = 48;

// ── profile / sessions-directory resolution ────────────────────────────────

/** `profiles::is_default` — blank and `"default"` both mean the built-in. */
function isDefaultProfile(profile) {
  return profile == null || profile === '' || profile === DEFAULT_PROFILE_ID;
}

/**
 * `profiles::validate_id` (shape only — membership lives in the profiles
 * store). Applied to a `profile` argument before it reaches a path join, the
 * same confinement `ProfileStore::resolve` provides on the Rust side.
 */
function isValidProfileId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROFILE_ID_LEN) return false;
  if (!/^[a-z0-9]/.test(id)) return false;
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  if (id.endsWith('.')) return false;
  const stem = id.split('.')[0];
  if (stem === 'con' || stem === 'prn' || stem === 'aux' || stem === 'nul') return false;
  if (/^(com|lpt)[0-9]$/.test(stem)) return false;
  return true;
}

/**
 * `profiles::agent_dir_for`: `<home>/.omp/agent`, or
 * `<home>/.omp/profiles/<id>/agent` for a named profile. `envDir`
 * (`PI_CODING_AGENT_DIR`) is honoured for the built-in profile only — omp's
 * own precedence gives `--profile` the win, verified against the binary, so
 * reading the env override for a named profile would point at a tree that
 * profile never writes.
 */
function agentDirFor(home, profile, envDir) {
  const id = profile == null || profile === '' ? null : profile;
  if (id === null && envDir) return envDir;
  const omp = path.join(home, '.omp');
  return id === null ? path.join(omp, 'agent') : path.join(omp, 'profiles', id, 'agent');
}

/** `saved_sessions::sessions_root_for` — the agent dir's `sessions/` child. */
function sessionsRootFor(home, profile, envDir) {
  return path.join(agentDirFor(home, profile, envDir), 'sessions');
}

// ── line streaming ─────────────────────────────────────────────────────────

const CHUNK_BYTES = 64 * 1024;

function decodeLine(buf) {
  const line = buf.toString('utf8');
  // `BufRead::lines` strips a trailing CR as well as the LF.
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Yield the lines of `filePath` without ever holding the whole file: one
 * reusable chunk buffer, with the partial tail copied only when a line spans
 * chunks. Open/read failures end the stream quietly (`File::open` failure is
 * `None` in Rust; a mid-file read error ends iteration there too).
 */
async function* readLines(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return;
  }
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending = null;
  try {
    for (;;) {
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(buf, 0, buf.length, null));
      } catch {
        break;
      }
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      let nl = chunk.indexOf(0x0a, start);
      while (nl !== -1) {
        let piece = chunk.subarray(start, nl);
        if (pending) {
          piece = Buffer.concat([pending, piece]);
          pending = null;
        }
        yield decodeLine(piece);
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) {
        const rest = Buffer.from(chunk.subarray(start));
        pending = pending ? Buffer.concat([pending, rest]) : rest;
      }
    }
    if (pending) yield decodeLine(pending);
  } finally {
    try {
      await handle.close();
    } catch {
      /* already closed / gone */
    }
  }
}

// ── parsing ────────────────────────────────────────────────────────────────

/**
 * `extract_text_from_content`: first non-blank `text` block of a block array
 * (blank text blocks are skipped, later ones still count), or a trimmed
 * string body.
 */
function extractTextFromContent(content) {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string'
      ) {
        const trimmed = block.text.trim();
        if (trimmed !== '') return trimmed;
      }
    }
    return null;
  }
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** Truncate on code-point boundaries like `chars().take(n)` + `…`. */
function truncateChars(text, max) {
  let seen = 0;
  let cut = 0;
  for (const ch of text) {
    if (seen === max) return `${text.slice(0, cut)}…`;
    seen += 1;
    cut += ch.length;
  }
  return text;
}

/** `update_last_activity`: keep the lexicographically latest timestamp. */
function maxTimestamp(current, candidate) {
  if (current === null || candidate > current) return candidate;
  return current;
}

/**
 * `apply_message_event`: only `user`/`assistant` turns count towards the
 * turn count, the fallback title and the preview — `toolResult` bodies are
 * raw tool output and must not leak into a history row.
 */
function applyMessageEvent(val, state, blob) {
  const msg = val !== null && typeof val === 'object' ? val.message : undefined;
  const role =
    msg !== null && typeof msg === 'object' && typeof msg.role === 'string' ? msg.role : '';
  if (role !== 'user' && role !== 'assistant') return;
  state.messageCount += 1;

  const text = msg !== null && typeof msg === 'object' ? extractTextFromContent(msg.content) : null;
  if (text === null) return;

  if (role === 'user' && state.fallbackTitle === '') {
    state.fallbackTitle = truncateChars(text, TITLE_CHARS);
  }
  if (blob !== null && blob.bytes < TEXT_BLOB_CAP_BYTES) {
    const lower = text.toLowerCase();
    blob.parts.push(lower);
    blob.bytes += Buffer.byteLength(lower, 'utf8') + 1; // + the '\n' separator
  }
  state.preview = truncateChars(text, PREVIEW_CHARS);
}

/** `canonical_id_from_stem`: the durable uuid in `<timestamp>_<uuid>.jsonl`. */
function canonicalIdFromStem(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length);
  const idx = stem.lastIndexOf('_');
  if (idx === -1) return null;
  const uuid = stem.slice(idx + 1);
  if (uuid.length < 32 || uuid.length > 36) return null;
  return /^[0-9a-fA-F-]+$/.test(uuid) ? uuid : null;
}

/** `Path::file_name` with the Rust fallback to the raw cwd string. */
function projectNameOf(cwd) {
  const base = path.basename(cwd);
  return base === '' || base === '.' || base === '..' ? cwd : base;
}

/**
 * Parse one `.jsonl` session file.
 *
 * Returns `{ session, textBlob }`: `session` is the `SavedSession` row (or
 * `null` when the file has neither a `session` id nor timestamp, or can't be
 * read); `textBlob` is the lowercased user/assistant corpus when
 * `collectText` was requested (mirroring the Rust `&mut String` slot, it is
 * filled even for a file that yields no row).
 */
async function parseSessionFile(filePath, { collectText = false } = {}) {
  const blob = collectText ? { parts: [], bytes: 0 } : null;
  const state = { messageCount: 0, fallbackTitle: '', preview: null };
  let sessionId = '';
  let explicitTitle = '';
  let timestamp = '';
  let updatedAt = null;
  let cwd = '';

  for await (const line of readLines(filePath)) {
    if (line === '') continue;
    let val;
    try {
      val = JSON.parse(line);
    } catch {
      continue; // malformed line: skipped, not fatal
    }
    if (val === null || typeof val !== 'object' || Array.isArray(val)) continue;
    const eventType = typeof val.type === 'string' ? val.type : '';

    switch (eventType) {
      case 'title': {
        if (typeof val.title === 'string') {
          const trimmed = val.title.trim();
          if (trimmed !== '') explicitTitle = trimmed;
        }
        if (typeof val.updatedAt === 'string') {
          updatedAt = maxTimestamp(updatedAt, val.updatedAt);
        }
        break;
      }
      case 'session': {
        if (typeof val.id === 'string') sessionId = val.id;
        if (typeof val.timestamp === 'string') timestamp = val.timestamp;
        if (typeof val.cwd === 'string') cwd = val.cwd;
        break;
      }
      case 'message': {
        applyMessageEvent(val, state, blob);
        if (typeof val.timestamp === 'string') {
          updatedAt = maxTimestamp(updatedAt, val.timestamp);
        }
        break;
      }
      default:
        break; // every other event type is deliberately ignored
    }
  }

  const textBlob = blob === null ? null : blob.parts.join('');

  if (sessionId === '' && timestamp === '') return { session: null, textBlob };

  const title =
    explicitTitle !== ''
      ? explicitTitle
      : state.fallbackTitle !== ''
        ? state.fallbackTitle
        : UNTITLED_TITLE;

  const session = {
    id: canonicalIdFromStem(filePath) ?? sessionId,
    title,
    timestamp,
    updatedAt,
    cwd,
    projectName: cwd === '' ? UNTITLED_PROJECT : projectNameOf(cwd),
    path: filePath,
    messageCount: state.messageCount,
    matchSnippet: null,
    preview: state.preview,
  };
  return { session, textBlob };
}

// ── query support ──────────────────────────────────────────────────────────

/** `normalize_cwd`: forward slashes, no trailing slash, case-insensitive. */
function normalizeCwd(cwd) {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * `match_snippet`: the `needle` hit plus ~40 chars of context per side, cut
 * on code-point boundaries and collapsed to one line. `null` when `needle`
 * isn't in `blob` — a title/project hit keeps the row's `preview` instead.
 */
function matchSnippet(blob, needle) {
  if (typeof blob !== 'string' || typeof needle !== 'string') return null;
  const start = blob.indexOf(needle);
  if (start === -1) return null;
  const end = start + needle.length;

  // Code-point start offsets, mirroring `char_indices()` (which also never
  // yields `blob.len()`; the missing final boundary is why the end snap
  // falls back to the blob length).
  const starts = [];
  let offset = 0;
  for (const ch of blob) {
    starts.push(offset);
    offset += ch.length;
  }

  let lastBefore = -1;
  while (lastBefore + 1 < starts.length && starts[lastBefore + 1] <= start) lastBefore += 1;
  const snapStart =
    lastBefore >= SNIPPET_CONTEXT_CHARS ? starts[lastBefore - SNIPPET_CONTEXT_CHARS] : 0;

  let firstAfter = lastBefore + 1;
  while (firstAfter < starts.length && starts[firstAfter] < end) firstAfter += 1;
  const snapEnd =
    firstAfter + SNIPPET_CONTEXT_CHARS < starts.length
      ? starts[firstAfter + SNIPPET_CONTEXT_CHARS]
      : blob.length;

  return blob.slice(snapStart, snapEnd).replace(/\n/g, ' ').trim();
}

// ── directory scan ─────────────────────────────────────────────────────────

/** Follow symlinks the way `Path::is_dir`/`is_file` do. */
async function entryKind(fullPath, dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) {
    try {
      const st = await fsp.stat(fullPath);
      if (st.isDirectory()) return 'dir';
      if (st.isFile()) return 'file';
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `scan_dir`: walk `root` one level deep (`root/<folder>/*.jsonl`), filter
 * by cwd and query, and sort newest-first by `updatedAt ?? timestamp`.
 *
 * `cwdFilter` is compared slash/case-insensitively; a non-empty trimmed
 * `query` is matched case-insensitively against title/project/cwd and the
 * message corpus, and fills `matchSnippet` on a text hit.
 */
async function scanDir(root, cwdFilter, query) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw new Error(`failed to read ${root}: ${err.message}`);
  }

  const normFilter =
    typeof cwdFilter === 'string' && cwdFilter !== '' ? normalizeCwd(cwdFilter) : null;
  const needle =
    typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : null;

  const sessions = [];

  for (const entry of entries) {
    const folder = path.join(root, entry.name);
    if ((await entryKind(folder, entry)) !== 'dir') continue;
    // `delete_saved_session` parks trashed files here; they must not
    // reappear in the history list.
    if (entry.name === '.trash') continue;

    let files;
    try {
      files = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const fileEntry of files) {
      const filePath = path.join(folder, fileEntry.name);
      if (!/\.jsonl$/i.test(fileEntry.name)) continue;
      if ((await entryKind(filePath, fileEntry)) !== 'file') continue;

      const { session, textBlob } = await parseSessionFile(filePath, {
        collectText: needle !== null,
      });
      if (!session) continue;
      if (normFilter !== null && normalizeCwd(session.cwd) !== normFilter) continue;

      if (needle !== null) {
        const fieldHit =
          session.title.toLowerCase().includes(needle) ||
          session.projectName.toLowerCase().includes(needle) ||
          session.cwd.toLowerCase().includes(needle);
        const snippet = textBlob === null ? null : matchSnippet(textBlob, needle);
        if (!fieldHit && snippet === null) continue;
        session.matchSnippet = snippet;
      }

      sessions.push(session);
    }
  }

  sessions.sort((a, b) => {
    const keyA = a.updatedAt ?? a.timestamp;
    const keyB = b.updatedAt ?? b.timestamp;
    if (keyA === keyB) return 0;
    return keyB < keyA ? -1 : 1; // newest first
  });

  return sessions;
}

// ── command surface ────────────────────────────────────────────────────────

/**
 * `list_saved_sessions` backend. Args are the Tauri command's
 * `{ cwd, query, profile }` (plus nothing else):
 * - `cwd: null` (or `""`) lists every project; otherwise only sessions whose
 *   cwd matches (slash/case-insensitive).
 * - `query: null` (or blank) is the unfiltered list and leaves
 *   `matchSnippet` null everywhere.
 * - `profile`: null/`""`/`"default"` is the built-in tree; a named profile
 *   resolves to its own tree (and never sees `PI_CODING_AGENT_DIR`).
 *
 * A root that doesn't exist yet scans as `[]` (fresh install). Unreadable
 * roots reject, like the Rust command's `Err`.
 */
async function listSavedSessions(args = {}) {
  const { cwd = null, profile = null, query = null } = args || {};
  let named = null;
  if (!isDefaultProfile(profile)) {
    if (!isValidProfileId(profile)) throw new Error(`invalid profile id: ${JSON.stringify(profile)}`);
    named = profile;
  }
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const root = sessionsRootFor(os.homedir(), named, envDir ? envDir : null);
  return scanDir(root, cwd, query);
}

module.exports = {
  listSavedSessions,
  // Exported for tests and for callers that resolve a tree explicitly.
  scanDir,
  parseSessionFile,
  extractTextFromContent,
  matchSnippet,
  normalizeCwd,
  canonicalIdFromStem,
  agentDirFor,
  sessionsRootFor,
  isDefaultProfile,
  isValidProfileId,
};