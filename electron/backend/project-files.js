'use strict';

/* Project-file backend: the composer's `@`-mention walk and the in-app file
 * preview.
 *
 * Port of two Rust modules and the two Tauri commands that expose them:
 *
 *     src-tauri/src/files.rs          list_project_files { cwd, query, limit }
 *                                     → FileHit[]  (files::list)
 *     src-tauri/src/project_file.rs   project_file_read { sessionId, path }
 *                                     → FilePreview (project_file::read)
 *
 * Rust resolves `cwd` itself; the preview's folder comes from the tab
 * registry, so only `sessionId` + `path` cross the wire there. The dispatcher
 * owns that lookup — `projectFileRead` takes the project root as its first
 * argument and the tab-registry enforcement stays in the command table.
 *
 * ## Parity notes
 *
 * - `listProjectFiles` is a bounded breadth-first walk (`MAX_ENTRIES` dirents,
 *   `MAX_DEPTH` levels, `SKIP_DIRS` pruned). Symlinks are never followed:
 *   a dirent's type is not traversed, so a symlinked directory is reported as
 *   a non-directory hit and never queued — that is also what keeps the walk
 *   acyclic.
 * - Dot-entries stay hidden unless the query names one (`".env"`,
 *   `"src/.env"`).
 * - Ranking is the Rust `fuzzy_score`: case-insensitive subsequence match with
 *   +10 per hit, +12 for a consecutive run, +8 at a segment start, +6 inside
 *   the basename, minus a length penalty (bytes / 4, floored). Ties break on
 *   shorter path, then byte-lexical order.
 * - A name that is not valid UTF-8 cannot round-trip through the payload and
 *   is skipped, as in Rust.
 * - `projectFileRead` normalises the path through `project_relative` (the
 *   textual traversal/`.git` checks plus the symlinked-parent guard; an
 *   absolute path inside the project is accepted, because a tool card carries
 *   whatever path omp's tool was given), then resolves the final component
 *   too — a symlink pointing out of the project, or into its `.git`, is
 *   refused with `kind: "Outside"` rather than followed.
 * - Kinds serialise under the names the webview matches: `Text`, `Image`,
 *   `Binary`, `TooLarge`, `Missing`, `Outside`; the preview object is
 *   `{ path, size, kind, text, data, mimeType }` (camelCase per
 *   `serde(rename_all)`, `text`/`data`/`mimeType` null outside their kinds).
 * - Caps are per kind and inclusive: text over `MAX_TEXT_BYTES` and images
 *   over `MAX_IMAGE_BYTES` answer `TooLarge` with the full size; they are
 *   never truncated, because the Rust original returns a kind instead of a
 *   partial body.
 *
 * Deliberate differences from the Rust originals:
 *
 * - Synchronous. The Electron main process is single-threaded and the Tauri
 *   `off_ipc`/`spawn_blocking` wrappers exist only to keep that UI thread
 *   free.
 * - `limit` is coerced and clamped instead of relying on `usize` decoding, and
 *   a nullish `cwd`/`query` is treated as empty (Rust would reject a missing
 *   required argument before the handler runs).
 * - Text is decoded with a non-fatal UTF-8 decoder, matching
 *   `String::from_utf8_lossy`; every invalid subsequence becomes U+FFFD.
 */

const fs = require('node:fs');
const path = require('node:path');

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Lossy = new TextDecoder('utf-8', { fatal: false });

// ── limits (src-tauri/src/files.rs) ─────────────────────────────────────────

/** Directory names never descended into. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.gradle',
  '.idea',
]);

/** Ceiling on directory entries inspected per query. */
const MAX_ENTRIES = 20_000;
/** Ceiling on directory depth below the search root. */
const MAX_DEPTH = 12;
/** Largest result count a caller may ask for. */
const MAX_LIMIT = 200;
/** Result count when the caller doesn't specify one. */
const DEFAULT_LIMIT = 30;
/** Longest query accepted — beyond this it cannot be a useful path fragment. */
const MAX_QUERY_LEN = 256;

// ── limits (src-tauri/src/project_file.rs, git_browser/file.rs) ─────────────

/** Largest text file shown (highlighting more freezes the webview). */
const MAX_TEXT_BYTES = 1024 * 1024;
/** Largest image shown (base64 over IPC grows it by a third). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** A NUL byte this far into a file makes it binary (`git_browser::is_binary`). */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Characters after which the next char starts a new "word" worth a bonus. */
const BOUNDARY_CHARS = new Set(['/', '\\', '_', '-', '.', ' ']);

// ── path validation (workspace.rs, git_browser/mod.rs) ──────────────────────

/**
 * The textual half of `workspace::validate_path_text`: no absolute paths, no
 * Windows drive letters, no `..`/empty components, no `.git` component.
 * Returns the normalised `/`-separated path.
 */
function validatePathText(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('path must not be empty');
  }
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error('path must not be absolute');
  }
  if (rel.length >= 2 && /[A-Za-z]/.test(rel[0]) && rel[1] === ':') {
    throw new Error('path must not be a drive-letter path');
  }
  const normalized = process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..' || seg === '')) {
    throw new Error("path must not contain '..' or empty components");
  }
  if (segments.some((seg) => seg.toLowerCase() === '.git')) {
    throw new Error('path must not reference the .git directory');
  }
  return normalized;
}

/**
 * Canonicalise the longest existing ancestor of `abs`, then re-append what
 * does not exist yet — `workspace::weakly_canonicalize`.
 */
function weaklyCanonicalize(abs) {
  let existing = abs;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const name = path.basename(existing);
    if (!name) break;
    missing.push(name);
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let resolved = fs.realpathSync(existing);
  for (let i = missing.length - 1; i >= 0; i -= 1) resolved = path.join(resolved, missing[i]);
  return resolved;
}

/** `p` relative to `root` when `p` lies inside it, else null (lexical). */
function stripPrefix(root, p) {
  if (p === root) return '';
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

/**
 * `workspace::validate_relative_path`: the textual checks plus a symlink
 * escape guard on every parent directory (the final component is never
 * resolved — a symlink there is the tracked entry itself).
 * Returns `{ abs, rel }`.
 */
function validateRelativePath(workDir, rel) {
  const normalized = validatePathText(rel);
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(workDir);
  } catch (e) {
    throw new Error(`failed to canonicalize repository root: ${e.message}`);
  }
  const candidate = path.join(canonicalRoot, ...normalized.split('/'));
  const name = path.basename(candidate);
  if (!name) throw new Error('path must not be empty');
  let parentResolved;
  try {
    parentResolved = weaklyCanonicalize(path.dirname(candidate));
  } catch (e) {
    throw new Error(`failed to resolve path: ${e.message}`);
  }
  if (stripPrefix(canonicalRoot, parentResolved) === null) {
    throw new Error('path escapes repository root');
  }
  const abs = path.join(parentResolved, name);
  const rest = stripPrefix(canonicalRoot, abs);
  if (rest === null) throw new Error('path escapes repository root');
  return { abs, rel: rest.split(path.sep).join('/') };
}

/**
 * `Path::file_name` + `Path::parent` for an absolute path: `null` when Rust's
 * `file_name` would be `None` (a root, or a trailing `..`/`.`); trailing
 * separators are ignored.
 */
function fileAndParent(absPath) {
  let p = absPath;
  for (;;) {
    while (p.length > 1 && p.endsWith(path.sep)) p = p.slice(0, -1);
    if (p.length > 1 && p.endsWith(path.sep + '.')) {
      p = p.slice(0, -2);
      continue;
    }
    break;
  }
  const idx = p.lastIndexOf(path.sep);
  const name = idx < 0 ? p : p.slice(idx + 1);
  if (name === '' || name === '.' || name === '..') return null;
  const parent = idx < 0 ? '' : idx === 0 ? path.sep : p.slice(0, idx);
  if (parent === '') return null;
  return { parent, name };
}

/**
 * `git_browser::project_relative`: a relative path goes through validation; an
 * absolute one (an edit card's target) is accepted when it lies inside the
 * work dir.
 */
function projectRelative(workDir, relPath) {
  if (typeof relPath !== 'string') throw new TypeError('path must be a string');
  if (!path.isAbsolute(relPath)) return validateRelativePath(workDir, relPath).rel;

  const outside = () => new Error(`${relPath} is outside the repository`);
  const split = fileAndParent(relPath);
  if (!split) throw outside();
  let root;
  try {
    root = fs.realpathSync(workDir);
  } catch (e) {
    throw new Error(`failed to resolve work dir: ${e.message}`);
  }
  let resolved;
  try {
    resolved = path.join(weaklyCanonicalize(split.parent), split.name);
  } catch (e) {
    throw new Error(`failed to resolve path: ${e.message}`);
  }
  const rest = stripPrefix(root, resolved);
  if (rest === null) throw outside();
  return validateRelativePath(workDir, rest.split(path.sep).join('/')).rel;
}

// ── list_project_files (files.rs) ───────────────────────────────────────────

/** ASCII-fast, Unicode-correct case-insensitive char comparison. */
function eqFold(a, b) {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * Case-insensitive subsequence score, or null when `needle` (an array of
 * code points) isn't a subsequence of `candidate`.
 *
 * `nameStart` is the index of the last path segment, in the same units as the
 * iteration index (UTF-16 code units here; byte offsets in Rust, which is
 * identical for ASCII paths).
 */
function fuzzyScore(candidate, needle, nameStart) {
  let matched = 0;
  let score = 0;
  let prevEnd = -1;
  let index = 0;

  for (const c of candidate) {
    const i = index;
    index += c.length;
    if (matched >= needle.length) break;
    if (!eqFold(c, needle[matched])) continue;
    score += 10;
    if (i === prevEnd) score += 12;
    if (i === 0 || BOUNDARY_CHARS.has(candidate[i - 1])) score += 8;
    if (i >= nameStart) score += 6;
    prevEnd = i + c.length;
    matched += 1;
  }

  if (matched < needle.length) return null;
  const penalty = Math.trunc(Buffer.byteLength(candidate, 'utf8') / 4);
  return score - penalty;
}

/** A dirent name as a string, or null when it is not valid UTF-8. */
function decodeName(raw) {
  if (typeof raw === 'string') return raw;
  try {
    return utf8.decode(raw);
  } catch {
    return null;
  }
}

/** Score desc, then shorter path, then byte-lexical — fully deterministic. */
function compareHits(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  const la = Buffer.byteLength(a.hit.path, 'utf8');
  const lb = Buffer.byteLength(b.hit.path, 'utf8');
  if (la !== lb) return la - lb;
  return Buffer.compare(Buffer.from(a.hit.path, 'utf8'), Buffer.from(b.hit.path, 'utf8'));
}

/**
 * Bounded breadth-first walk of `root`, keeping the `limit` best fuzzy matches
 * for `query`.
 *
 * `maxEntries` is a parameter only so the entry cap is reachable from a test
 * without materializing 20,000 real dirents; production callers go through
 * `listProjectFiles`, which always passes `MAX_ENTRIES`.
 */
function searchPathsCapped(root, query, limit, maxEntries) {
  const needle = Array.from(query);
  // Dot-entries stay hidden unless the query explicitly names one.
  const showHidden = query.startsWith('.') || query.includes('/.');
  const scored = [];
  const queue = [{ dir: root, prefix: '', depth: 0 }];
  let head = 0;
  let seen = 0;

  walk: while (head < queue.length) {
    const { dir, prefix, depth } = queue[head];
    head += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { encoding: 'buffer', withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break walk;
      seen += 1;
      const name = decodeName(entry.name);
      // Non-UTF-8 names can't round-trip through the IPC payload.
      if (name === null) continue;
      if (name.startsWith('.') && !showHidden) continue;
      const isDir = entry.isDirectory();
      if (isDir && SKIP_DIRS.has(name)) continue;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const nameStart = rel.length - name.length;
      const score = fuzzyScore(rel, needle, nameStart);
      if (isDir && depth < MAX_DEPTH) {
        queue.push({ dir: path.join(dir, name), prefix: rel, depth: depth + 1 });
      }
      if (score !== null) scored.push({ score, hit: { path: rel, name, isDir } });
    }
  }

  scored.sort(compareHits);
  const kept = scored.length > limit ? scored.slice(0, limit) : scored;
  return kept.map((entry) => entry.hit);
}

/**
 * `list_project_files`: project-relative file/directory paths matching
 * `query`, best first.
 *
 * Throws with the Rust messages: `query too long (max 256 bytes)`,
 * `cannot resolve working directory: <err>`, `not a directory: <path>`.
 */
function listProjectFiles(cwd, query, limit) {
  const text = query === null || query === undefined ? '' : String(query);
  if (Buffer.byteLength(text, 'utf8') > MAX_QUERY_LEN) {
    throw new Error(`query too long (max ${MAX_QUERY_LEN} bytes)`);
  }
  let root;
  if (cwd === null || cwd === undefined || cwd === '') {
    try {
      root = process.cwd();
    } catch (e) {
      throw new Error(`cannot resolve working directory: ${e.message}`);
    }
  } else {
    root = String(cwd);
  }
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`not a directory: ${root}`);
  return searchPathsCapped(root, text, clampLimit(limit), MAX_ENTRIES);
}

/** `limit.unwrap_or(30).clamp(1, 200)`. */
function clampLimit(limit) {
  if (limit === null || limit === undefined) return DEFAULT_LIMIT;
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

// ── project_file_read (project_file.rs) ────────────────────────────────────

/** The image MIME type for a project-relative path, by extension. */
const IMAGE_MIMES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
]);

/**
 * `project_file::image_mime`: SVG included (an `<img>` never runs its
 * scripts); the last `.` anywhere in the path decides, as in Rust.
 */
function imageMime(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return IMAGE_MIMES.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** A preview without a body — `FilePreview::empty`. */
function emptyPreview(rel, size, kind) {
  return { path: rel, size, kind, text: null, data: null, mimeType: null };
}

/** `git_browser::is_binary`: a NUL in the first `BINARY_SNIFF_BYTES`. */
function isBinary(bytes) {
  return bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES)).includes(0);
}

/** Read at most `cap + 1` bytes, so a file that grew is still caught. */
function readCapped(file, cap, rel) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(cap + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return buffer.subarray(0, total);
  } catch (e) {
    throw new Error(`failed to read ${rel}: ${e.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `true` when `file` resolves out of `root` or into its `.git`. */
function resolvesOutside(root, file) {
  const rest = stripPrefix(root, file);
  if (rest === null) return true;
  if (rest === '') return false;
  return rest.split(path.sep).some((seg) => seg.toLowerCase() === '.git');
}

/**
 * `project_file_read`: one project file for the preview.
 *
 * `root` is the tab's project folder (the dispatcher resolves `sessionId`);
 * `relPath` may also be absolute inside it.
 *
 * Returns the `FilePreview` JSON, or throws with the Rust message
 * (`"<given> is outside the repository"`, `"<rel> is not a file"`,
 * `"failed to resolve <rel>: <err>"`, …).
 */
function projectFileRead(root, relPath) {
  const rel = projectRelative(root, relPath);
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch (e) {
    throw new Error(`failed to resolve project: ${e.message}`);
  }
  const target = path.join(canonicalRoot, ...rel.split('/'));
  let file;
  try {
    file = fs.realpathSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return emptyPreview(rel, 0, 'Missing');
    throw new Error(`failed to resolve ${rel}: ${e.message}`);
  }
  if (resolvesOutside(canonicalRoot, file)) return emptyPreview(rel, 0, 'Outside');

  let meta;
  try {
    meta = fs.statSync(file);
  } catch (e) {
    throw new Error(`failed to read ${rel}: ${e.message}`);
  }
  if (!meta.isFile()) throw new Error(`${rel} is not a file`);

  const size = meta.size;
  const mime = imageMime(rel);
  const cap = mime === null ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
  if (size > cap) return emptyPreview(rel, size, 'TooLarge');

  const bytes = readCapped(file, cap, rel);
  if (bytes.length > cap) return emptyPreview(rel, bytes.length, 'TooLarge');

  if (mime !== null) {
    return {
      path: rel,
      size,
      kind: 'Image',
      text: null,
      data: bytes.toString('base64'),
      mimeType: mime,
    };
  }
  if (isBinary(bytes)) return emptyPreview(rel, size, 'Binary');
  return {
    path: rel,
    size,
    kind: 'Text',
    text: utf8Lossy.decode(bytes),
    data: null,
    mimeType: null,
  };
}

module.exports = {
  // The wire-facing surface.
  listProjectFiles,
  projectFileRead,
  // Path normalisation, exported for parity tests.
  projectRelative,
  validatePathText,
  validateRelativePath,
  // Pure helpers, exported for parity tests.
  searchPathsCapped,
  fuzzyScore,
  imageMime,
  isBinary,
  clampLimit,
  // Constants (mirror the Rust items).
  SKIP_DIRS,
  MAX_ENTRIES,
  MAX_DEPTH,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_QUERY_LEN,
  MAX_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  BINARY_SNIFF_BYTES,
};