'use strict';

/* Git browser backend: the project tree with status marks, the full-file
 * inline diff, the commit graph, a commit's touched files and one of those
 * files as of the commit.
 *
 * Port of src-tauri/src/git_browser/{mod,status,file,log,graph,commit}.rs and
 * the five `git_browser_*` Tauri commands. One async function per command,
 * each returning exactly the JSON the Rust structs serialise (`camelCase`
 * per `serde(rename_all)`); every path crossing the boundary is
 * project-relative to the repository's work dir and `/`-separated.
 *
 *     git_browser_status(path)            → StatusView
 *     git_browser_file(path, relPath)     → FileView
 *     git_browser_log(path)               → LogView
 *     git_browser_commit(path, sha)       → CommitView
 *     git_browser_commit_file(path, sha, relPath) → FileView
 *
 * ## Why the filter-driver invariant holds by construction
 *
 * Rust drops the repository's own `filter.<name>.clean`/`smudge`/`process`
 * drivers before reading (`git_browser::open`) because gix runs a driver's
 * command whenever it reads a work-tree file: a repository that ships its own
 * config could make a mere preview execute code.
 *
 * isomorphic-git never runs external processes and implements no filter
 * drivers at all (no `.gitattributes` handling, no clean/smudge, no
 * `working-tree-encoding`), so there is nothing to strip and no path from
 * this module to a subprocess: the invariant holds for every read here,
 * including the ones gix would have routed through the pipeline.
 *
 * The submodule rule is mirrored explicitly instead: a submodule's work tree
 * is never read (status reports a submodule as changed only when a different
 * commit is checked out, `ignore = dirty`; status walks prune the submodule
 * directory, and every read of a gitlink path answers "absent").
 *
 * ## Linked worktrees
 *
 * Every read picks the right git dir: a worktree's `HEAD` and index come from
 * its own git dir (`…/.git/worktrees/<name>`), while objects, refs and config
 * come from the common dir it names in `commondir`.
 *
 * ## Behaviour differences from the Rust implementation
 *
 * - `.gitattributes` is not consulted (isomorphic-git has no attributes
 *   parser). Line-ending differences between the work tree and the blob are
 *   therefore detected by content: a work-tree file whose only difference
 *   from its blob is CRLF vs LF counts as unchanged (Rust reaches the same
 *   result through `text`/`eol` attributes and `core.autocrlf`). A genuine
 *   line-ending-only edit to a file without text attributes is invisible
 *   here; Rust would report it modified.
 * - Line-level diff is a patience/unique-anchor implementation with a
 *   bounded LCS fallback, not gix's histogram algorithm. Counts and hunks
 *   agree on unambiguous edits; when several equally short edit scripts
 *   exist the placement of removals/additions may differ.
 * - Rename detection is exact-content (a rename whose destination was edited
 *   after `git mv` shows as add+delete). gix uses similarity detection.
 * - Global excludes (`core.excludesFile`) are not honoured by the status
 *   walk; `.gitignore` files and `.git/info/exclude` are.
 * - A blob bigger than MAX_SIDE_BYTES is inflated before the cap is applied
 *   (isomorphic-git has no header-size read); the work-tree side is stat'ed
 *   first, as in Rust.
 * - The status comparison trusts the index's stat data (that is what keeps it
 *   fast); an edit that keeps a file's size and leaves its timestamps equal to
 *   the index entry's is not noticed until the file is touched again. Git
 *   re-hashes such a "racily clean" entry, isomorphic-git does not.
 */

const fs = require('node:fs');
const path = require('node:path');
const git = require('isomorphic-git');

// ── limits (src-tauri/src/git_browser/mod.rs, file.rs, log.rs, graph.rs) ────

/** Files a tree carries before it is cut off and marked `truncated`. */
const MAX_FILES = 20_000;
/** A diff side bigger than this (in git form) is not diffed. */
const MAX_SIDE_BYTES = 2 * 1024 * 1024;
/** Lines emitted before the rest is dropped and the view marked `truncated`. */
const MAX_LINES = 20_000;
/** Characters kept per line; a longer one is cut and the view truncated. */
const MAX_LINE_CHARS = 500;
/** A NUL byte this far into either side makes the file binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Commits listed before the history is cut off and marked `truncated`. */
const MAX_COMMITS = 500;
/** Lanes a graph may show before the rest is squashed onto the last one. */
const MAX_LANES = 12;
/** Id of the synthetic working-tree row on top of the log. */
const WORKTREE_ROW = '@';

/** A file's change against the comparison base, as `StatusKind` serialises. */
const StatusKind = Object.freeze({
  Modified: 'Modified',
  Added: 'Added',
  Deleted: 'Deleted',
  Renamed: 'Renamed',
  Untracked: 'Untracked',
});

/** Precedence when both layers report a path, first match wins. */
const RANK = { Untracked: 4, Added: 3, Deleted: 2, Renamed: 1, Modified: 0 };

// ── repository discovery ────────────────────────────────────────────────────

/**
 * The nearest repository containing `dir`: `{ workDir, gitdir }`.
 *
 * Rust's `git_browser::open` (via `workspace::discover` + `spawn_gate`) also
 * strips the repository's own filter drivers; isomorphic-git runs no filters
 * at all, so there is nothing to strip (see the module header).
 */
async function openRepo(dir) {
  let workDir;
  try {
    workDir = await git.findRoot({ fs, filepath: path.resolve(dir) });
  } catch (e) {
    throw new Error(`not a git repository: ${e.message}`);
  }
  const gitdir = gitdirOf(workDir);
  if (!gitdir) throw new Error('repository has no working tree');
  // A linked worktree's git dir holds HEAD and the index; its objects, refs
  // and config live in the common dir (`commondir` file). isomorphic-git
  // reads all of them from one `gitdir`, so the module picks the right one
  // per read.
  const commonDir = path.resolve(gitdir, readCommonDir(gitdir) ?? '.');
  // One object cache per command: isomorphic-git re-parses a pack index on
  // every uncached read, which turns a history walk into seconds.
  return { workDir, gitdir, commonDir, cache: {} };
}

/** `<workDir>/.git`, following a `.git` file (worktree, submodule). */
function gitdirOf(workDir) {
  const dotgit = path.join(workDir, '.git');
  let stat;
  try {
    stat = fs.statSync(dotgit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotgit;
  if (!stat.isFile()) return null;
  const line = fs.readFileSync(dotgit, 'utf8');
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(line);
  if (!match) return null;
  return path.resolve(workDir, match[1]);
}

/** The `commondir` a linked worktree's git dir points at, or `null`. */
function readCommonDir(gitdir) {
  try {
    const text = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

// ── path validation (workspace.rs) ──────────────────────────────────────────

/**
 * The textual half of `workspace::validate_path_text`: no absolute paths, no
 * drive letters, no `..`/empty components, no `.git` component. Returns the
 * normalised `/`-separated path.
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
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      const name = path.basename(existing);
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.push(name);
      existing = parent;
    }
  }
  let resolved = fs.realpathSync(existing);
  for (let i = missing.length - 1; i >= 0; i--) resolved = path.join(resolved, missing[i]);
  return resolved;
}

/**
 * `workspace::validate_relative_path`: the textual checks plus a symlink
 * escape guard on every parent directory (the final component is never
 * resolved — a symlink there is the tracked entry itself).
 * Returns `{ abs, rel }`.
 */
function validateRelativePath(workDir, rel) {
  const normalized = validatePathText(rel);
  const root = fs.realpathSync(workDir);
  const abs = path.join(root, ...normalized.split('/'));
  const parentResolved = weaklyCanonicalize(path.dirname(abs));
  if (parentResolved !== root && !parentResolved.startsWith(root + path.sep)) {
    throw new Error('path escapes repository root');
  }
  const resolvedAbs = path.join(parentResolved, path.basename(abs));
  const relResolved = path.relative(root, resolvedAbs).split(path.sep).join('/');
  return { abs: resolvedAbs, rel: relResolved };
}

/**
 * `git_browser::project_relative`: a relative path goes through validation; an
 * absolute one (an edit card's target) is accepted when it lies inside the
 * work dir.
 */
function projectRelative(workDir, relPath) {
  if (!path.isAbsolute(relPath)) {
    return validateRelativePath(workDir, relPath).rel;
  }
  const outside = () => {
    throw new Error(`${relPath} is outside the repository`);
  };
  const name = path.basename(relPath);
  const parent = path.dirname(relPath);
  if (!name || !parent) outside();
  const root = fs.realpathSync(workDir);
  let resolved;
  try {
    resolved = path.join(weaklyCanonicalize(parent), name);
  } catch (e) {
    throw new Error(`failed to resolve path: ${e.message}`);
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) outside();
  const rest = path.relative(root, resolved).split(path.sep).join('/');
  if (rest === '') outside();
  return validateRelativePath(workDir, rest).rel;
}

// ── commit message helpers (mod.rs) ─────────────────────────────────────────

/** A commit message's first line and everything after it. */
function splitLines(message) {
  const i = message.indexOf('\n');
  return i < 0 ? [message, ''] : [message.slice(0, i), message.slice(i + 1)];
}

/** A commit's subject: the first line, trailing whitespace trimmed. */
function subject(message) {
  return splitLines(message)[0].replace(/\s+$/, '');
}

/** A commit's body: the rest, without leading blank lines and trailing space. */
function body(message) {
  return splitLines(message)[1].replace(/^[\r\n]+/, '').replace(/\s+$/, '');
}

// ── object access ───────────────────────────────────────────────────────────

/**
 * Full id of `HEAD`, or `null` when it is unborn. `HEAD` itself lives in the
 * worktree's git dir; the ref it names lives in the common dir.
 */
async function headId(repo) {
  const head = readHeadFile(repo.gitdir);
  if (!head) return null;
  if (head.ref) {
    try {
      return await git.resolveRef({
        fs,
        dir: repo.workDir,
        gitdir: repo.commonDir,
        ref: head.ref,
        cache: repo.cache,
      });
    } catch {
      return null;
    }
  }
  return head.oid;
}

/** `{ ref }` for a symbolic HEAD, `{ oid }` for a detached one. */
function readHeadFile(gitdir) {
  let text;
  try {
    text = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const symbolic = /^ref:\s*(\S+)$/.exec(text);
  if (symbolic) return { ref: symbolic[1] };
  return /^[0-9a-f]{40}$/.test(text) ? { oid: text } : null;
}

/** The ref `HEAD` points at (`refs/heads/main`), or `null` when detached. */
function headRefName(gitdir) {
  const head = readHeadFile(gitdir);
  return head && head.ref ? head.ref : null;
}

/** A ref's short display name; `refs/heads/x` → `x`, `refs/tags/x` → `x`. */
function shortenRef(fullName) {
  return fullName.replace(/^refs\/(?:heads|tags|remotes)\//, '');
}

async function readCommitObj(repo, oid) {
  try {
    const { commit } = await git.readCommit({
      fs,
      dir: repo.workDir,
      gitdir: repo.commonDir,
      oid,
      cache: repo.cache,
    });
    return commit;
  } catch (e) {
    throw new Error(`failed to read commit: ${e.message}`);
  }
}

/** Parse a full hex commit id from the frontend. */
function parseId(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(sha)) {
    throw new Error(`invalid commit id: ${sha}`);
  }
  return sha.toLowerCase();
}

async function readBlobBytes(repo, oid) {
  try {
    const { blob } = await git.readBlob({
      fs,
      dir: repo.workDir,
      gitdir: repo.commonDir,
      oid,
      cache: repo.cache,
    });
    return Buffer.from(blob);
  } catch (e) {
    throw new Error(`failed to read blob: ${e.message}`);
  }
}

/** Every loose and packed ref: full name → `{ oid }` or `{ symbolic }`. */
function readAllRefs(gitdir) {
  const refs = new Map();
  try {
    const packed = fs.readFileSync(path.join(gitdir, 'packed-refs'), 'utf8');
    for (const raw of packed.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const match = /^([0-9a-f]{40}) (.+)$/.exec(line);
      if (match) refs.set(match[2], { oid: match[1] });
    }
  } catch {
    // No packed-refs.
  }
  const walk = (dir, prefix) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, name);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.lock')) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8').trim();
      } catch {
        continue;
      }
      const symbolic = /^ref:\s*(\S+)$/.exec(text);
      if (symbolic) {
        refs.set(`refs/${name}`, { symbolic: symbolic[1] });
      } else if (/^[0-9a-f]{40}$/.test(text)) {
        refs.set(`refs/${name}`, { oid: text });
      }
    }
  };
  walk(path.join(gitdir, 'refs'), '');
  return refs;
}

/** Peel an object id to a commit id, or `null` when it is not a commit. */
async function peelToCommit(repo, oid) {
  let current = oid;
  for (let i = 0; i < 10; i++) {
    let object;
    try {
      object = await git.readObject({
        fs,
        dir: repo.workDir,
        gitdir: repo.commonDir,
        oid: current,
        cache: repo.cache,
      });
    } catch {
      return null;
    }
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = object.object && object.object.object;
    if (typeof target !== 'string') return null;
    current = target;
  }
  return null;
}

// ── tree helpers ────────────────────────────────────────────────────────────

const TYPE_TREE = 'tree';
const TYPE_COMMIT = 'commit';

function isBlobLike(entry) {
  return entry && entry.type !== TYPE_TREE && entry.type !== TYPE_COMMIT;
}

/** `cat-file`-style lookup of one path in a tree; `null` when absent. */
async function treeEntryAt(repo, treeOid, rel, cache) {
  const parts = rel.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const entries = await readTreeEntries(repo, current, cache);
    const entry = entries.find((e) => e.path === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
    if (entry.type !== TYPE_TREE) return null;
    current = entry.oid;
  }
  return null;
}

function readTreeEntries(repo, treeOid, cache) {
  if (!treeOid) return Promise.resolve([]);
  const hit = cache.get(treeOid);
  if (hit) return hit;
  const pending = git
    .readTree({ fs, dir: repo.workDir, gitdir: repo.commonDir, oid: treeOid, cache: repo.cache })
    .then(({ tree }) => tree)
    .catch((e) => {
      throw new Error(`failed to read tree: ${e.message}`);
    });
  cache.set(treeOid, pending);
  return pending;
}

/**
 * One side of a file view: absent, too large for the diff, or its bytes in
 * git form.
 */
const ABSENT = Object.freeze({ kind: 'absent' });
const TOO_LARGE = Object.freeze({ kind: 'tooLarge' });

/** The blob at `rel` in `treeOid`; absent for a directory or submodule. */
async function blobAt(repo, treeOid, rel, cache) {
  if (!treeOid) return ABSENT;
  const entry = await treeEntryAt(repo, treeOid, rel, cache);
  if (!entry || !isBlobLike(entry)) return ABSENT;
  const bytes = await readBlobBytes(repo, entry.oid);
  if (bytes.length > MAX_SIDE_BYTES) return TOO_LARGE;
  return { kind: 'bytes', bytes };
}

// ── work-tree side ──────────────────────────────────────────────────────────

function isBinary(bytes) {
  return bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES)).includes(0);
}

/** Strip the CR of every CRLF pair. */
function stripCr(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

/**
 * isomorphic-git runs no filters, so a work-tree file checked out with CRLF
 * line endings would differ from its LF blob. Compare in the same normal form
 * the diff and status use: CRLF is folded to LF when the blob side carries no
 * CRLF at all (the shape a `text`/`eol` attribute leaves).
 */
function sameIgnoringLineEndings(workBytes, baseBytes) {
  if (!workBytes.includes('\r\n')) return workBytes.equals(baseBytes);
  return !baseBytes.includes('\r\n') && stripCr(workBytes).equals(baseBytes);
}

/**
 * Read the work-tree side of `rel` (`file::read_worktree`): a symlink's target
 * as git stores it, otherwise the file. A file over twice MAX_SIDE_BYTES is
 * not read at all (end-of-line conversion at most halves it).
 */
function readWorktree(workDir, rel, baseBytes) {
  const abs = path.join(workDir, ...rel.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ABSENT;
    throw new Error(`failed to read ${abs}: ${e.message}`);
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'bytes', bytes: Buffer.from(fs.readlinkSync(abs), 'utf8') };
  }
  if (!stat.isFile()) return ABSENT;
  if (stat.size > 2 * MAX_SIDE_BYTES) return TOO_LARGE;
  const raw = fs.readFileSync(abs);
  const bytes = baseBytes ? trimWorktreeLineEndings(raw, baseBytes) : stripCrIfText(raw);
  return bytes.length > MAX_SIDE_BYTES ? TOO_LARGE : { kind: 'bytes', bytes };
}

/** Fold CRLF to LF when the work-tree content is the blob's in every other way. */
function trimWorktreeLineEndings(raw, base) {
  return sameIgnoringLineEndings(raw, base) && !raw.equals(base) ? stripCr(raw) : raw;
}

/** An untracked file has no blob to compare against: fold CRLF, as `text` would. */
function stripCrIfText(raw) {
  return isBinary(raw) || !raw.includes('\r\n') ? raw : stripCr(raw);
}

// ── line diff ───────────────────────────────────────────────────────────────

/** Split `buf` into lines, each keeping its `\n`; the last may lack one. */
function tokenize(buf) {
  const tokens = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      tokens.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) tokens.push(buf.subarray(start));
  return tokens;
}

function internInto(interner, tokens) {
  const ids = new Int32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i].toString('latin1');
    let id = interner.get(key);
    if (id === undefined) {
      id = interner.size;
      interner.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

/**
 * Matched `[beforeIndex, afterIndex]` pairs, ascending on both sides.
 *
 * Common prefix and suffix are matched directly; the rest is split on lines
 * that occur exactly once on each side (the longest increasing run of them),
 * and a region without such anchors is solved with an exact LCS when it is
 * small enough, else taken as a wholesale replacement. Bounded in memory for
 * any input size, unlike a full Myers trace.
 */
function matchedLines(a, b) {
  const matches = [];
  const rec = (aLo, aHi, bLo, bHi) => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      matches.push([aLo, bLo]);
      aLo++;
      bLo++;
    }
    let aEnd = aHi;
    let bEnd = bHi;
    while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    if (aLo < aEnd && bLo < bEnd) {
      const anchors = uniqueAnchors(a, aLo, aEnd, b, bLo, bEnd);
      if (anchors.length) {
        let pa = aLo;
        let pb = bLo;
        for (const [ai, bi] of anchors) {
          rec(pa, ai, pb, bi);
          matches.push([ai, bi]);
          pa = ai + 1;
          pb = bi + 1;
        }
        rec(pa, aEnd, pb, bEnd);
      } else if ((aEnd - aLo) * (bEnd - bLo) <= 250_000) {
        for (const pair of lcsGrid(a, aLo, aEnd, b, bLo, bEnd)) matches.push(pair);
      }
    }
    for (let i = 0; aEnd + i < aHi; i++) matches.push([aEnd + i, bEnd + i]);
  };
  rec(0, a.length, 0, b.length);
  return matches;
}

/** Lines occurring exactly once in both ranges, longest increasing run. */
function uniqueAnchors(a, aLo, aHi, b, bLo, bHi) {
  const countA = new Map();
  const firstA = new Map();
  for (let i = aLo; i < aHi; i++) {
    countA.set(a[i], (countA.get(a[i]) || 0) + 1);
    if (!firstA.has(a[i])) firstA.set(a[i], i);
  }
  const countB = new Map();
  const firstB = new Map();
  for (let i = bLo; i < bHi; i++) {
    countB.set(b[i], (countB.get(b[i]) || 0) + 1);
    if (!firstB.has(b[i])) firstB.set(b[i], i);
  }
  const candidates = [];
  for (const [id, count] of countA) {
    if (count === 1 && countB.get(id) === 1) candidates.push([firstA.get(id), firstB.get(id)]);
  }
  candidates.sort((x, y) => x[0] - y[0]);
  // Longest increasing subsequence on the after-side positions.
  const tails = [];
  const back = new Int32Array(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]][1] < candidates[i][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  let cursor = tails.length ? tails[tails.length - 1] : -1;
  while (cursor >= 0) {
    out.push(candidates[cursor]);
    cursor = back[cursor];
  }
  return out.reverse();
}

/** Exact LCS matches for two small ranges. */
function lcsGrid(a, aLo, aHi, b, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[aLo + i] === b[bLo + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aLo + i] === b[bLo + j]) {
      out.push([aLo + i, bLo + j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/** Change blocks: unmatched before-lines then unmatched after-lines. */
function hunksFromMatches(matches, beforeLen, afterLen) {
  const hunks = [];
  let a = 0;
  let b = 0;
  for (const [ma, mb] of matches) {
    if (ma > a || mb > b) {
      hunks.push({ beforeStart: a, beforeEnd: ma, afterStart: b, afterEnd: mb });
    }
    a = ma + 1;
    b = mb + 1;
  }
  if (a < beforeLen || b < afterLen) {
    hunks.push({ beforeStart: a, beforeEnd: beforeLen, afterStart: b, afterEnd: afterLen });
  }
  return hunks;
}

/**
 * One line's display text: the line break stripped, lossily decoded, cut to
 * MAX_LINE_CHARS characters. The second value says whether it was cut.
 */
function lineText(token) {
  let end = token.length;
  if (end > 0 && token[end - 1] === 0x0a) end--;
  if (end > 0 && token[end - 1] === 0x0d) end--;
  const head = token.subarray(0, Math.min(end, MAX_LINE_CHARS * 4));
  const text = head.toString('utf8');
  const chars = Array.from(text);
  if (chars.length > MAX_LINE_CHARS) {
    return [chars.slice(0, MAX_LINE_CHARS).join(''), true];
  }
  return [text, head.length < end];
}

/** An empty `Text` view of `relPath`. */
function emptyView(relPath, status) {
  return { path: relPath, kind: 'Text', status: status ?? null, adds: 0, rems: 0, lines: [], truncated: false };
}

/**
 * Render `before` → `after` as one full-file view. `null` means the side does
 * not exist (an added or deleted file); both `null` is `Missing`.
 */
function view(relPath, status, before, after) {
  const out = emptyView(relPath, status);
  if (before == null && after == null) {
    out.kind = 'Missing';
    return out;
  }
  const beforeBytes = before ?? Buffer.alloc(0);
  const afterBytes = after ?? Buffer.alloc(0);
  if (beforeBytes.length > MAX_SIDE_BYTES || afterBytes.length > MAX_SIDE_BYTES) {
    out.kind = 'TooLarge';
    return out;
  }
  if (isBinary(beforeBytes) || isBinary(afterBytes)) {
    out.kind = 'Binary';
    return out;
  }

  const beforeTokens = tokenize(beforeBytes);
  const afterTokens = tokenize(afterBytes);
  const interner = new Map();
  const beforeIds = internInto(interner, beforeTokens);
  const afterIds = internInto(interner, afterTokens);
  const hunks = hunksFromMatches(
    matchedLines(beforeIds, afterIds),
    beforeIds.length,
    afterIds.length,
  );
  for (const hunk of hunks) {
    out.adds += hunk.afterEnd - hunk.afterStart;
    out.rems += hunk.beforeEnd - hunk.beforeStart;
  }

  const lines = [];
  let truncated = false;
  let old = 0;
  let next = 0;
  const plan = hunks.concat([
    {
      beforeStart: beforeIds.length,
      beforeEnd: beforeIds.length,
      afterStart: afterIds.length,
      afterEnd: afterIds.length,
    },
  ]);
  emit: for (const hunk of plan) {
    while (old < hunk.beforeStart) {
      if (lines.length === MAX_LINES) {
        truncated = true;
        break emit;
      }
      const [text, cut] = lineText(afterTokens[next]);
      truncated = truncated || cut;
      lines.push({ kind: 'ctx', old: old + 1, new: next + 1, text });
      old++;
      next++;
    }
    for (let o = hunk.beforeStart; o < hunk.beforeEnd; o++) {
      if (lines.length === MAX_LINES) {
        truncated = true;
        break emit;
      }
      const [text, cut] = lineText(beforeTokens[o]);
      truncated = truncated || cut;
      lines.push({ kind: 'rem', old: o + 1, new: null, text });
    }
    for (let n = hunk.afterStart; n < hunk.afterEnd; n++) {
      if (lines.length === MAX_LINES) {
        truncated = true;
        break emit;
      }
      const [text, cut] = lineText(afterTokens[n]);
      truncated = truncated || cut;
      lines.push({ kind: 'add', old: null, new: n + 1, text });
    }
    old = hunk.beforeEnd;
    next = hunk.afterEnd;
  }
  out.lines = lines;
  out.truncated = truncated;
  return out;
}

/** `file::render`: `TooLarge` wins over the diff; otherwise diff the sides. */
function render(relPath, status, before, after) {
  if ((before && before.kind === 'tooLarge') || (after && after.kind === 'tooLarge')) {
    const out = emptyView(relPath, status);
    out.kind = 'TooLarge';
    return out;
  }
  return view(relPath, status, before ? before.bytes : null, after ? after.bytes : null);
}

// ── status ──────────────────────────────────────────────────────────────────

/** Byte-order string comparison — git's sort order, not UTF-16's. */
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Fold status events into one kind per path (precedence per `RANK`).
 * Pure, so the precedence is testable without a repository.
 */
function merge(events) {
  const kinds = new Map();
  const sources = new Map();
  for (const event of events) {
    if (event.from != null) sources.set(event.path, event.from);
    const current = kinds.get(event.path);
    if (current === undefined || RANK[event.kind] > RANK[current]) {
      kinds.set(event.path, event.kind);
    }
  }
  return { kinds, sources };
}

/**
 * Every changed path first (so `cap` only ever drops unchanged ones), then the
 * `tracked` paths. Returns `{ files, truncated }`.
 */
function listed(changed, tracked, cap) {
  const files = new Map();
  for (const [relPath, kind] of changed) {
    if (files.size === cap) return { files, truncated: true };
    files.set(relPath, kind);
  }
  for (const relPath of tracked) {
    if (files.has(relPath)) continue;
    if (files.size === cap) return { files, truncated: true };
    files.set(relPath, null);
  }
  return { files, truncated: false };
}


function insertTreePath(root, relPath, status) {
  let node = root;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i];
    let child = node.dirs.get(name);
    if (!child) {
      child = { dirs: new Map(), files: new Map() };
      node.dirs.set(name, child);
    }
    node = child;
  }
  node.files.set(parts[parts.length - 1], status);
}

function joinPath(dir, name) {
  return dir === '' ? name : `${dir}/${name}`;
}

function intoNode(node, name, relPath) {
  const children = [];
  let changed = 0;
  for (const dirName of [...node.dirs.keys()].sort(byteCompare)) {
    const childPath = joinPath(relPath, dirName);
    const child = intoNode(node.dirs.get(dirName), dirName, childPath);
    changed += child.changed;
    children.push(child);
  }
  for (const fileName of [...node.files.keys()].sort(byteCompare)) {
    const status = node.files.get(fileName);
    if (status) changed += 1;
    children.push({
      path: joinPath(relPath, fileName),
      name: fileName,
      dir: false,
      status,
      changed: 0,
      children: [],
    });
  }
  return { name, path: relPath, dir: true, status: null, changed, children };
}

/**
 * Fold `/`-separated project-relative file paths into a tree rooted at `""`:
 * directories first, then files, each in byte order; every directory's
 * `changed` counts the files with a status below it.
 */
function fold(files) {
  const root = { dirs: new Map(), files: new Map() };
  for (const [relPath, status] of files) insertTreePath(root, relPath, status ?? null);
  return intoNode(root, '', '');
}

/** The commit a submodule has checked out, or `null` when unreadable. */
async function submoduleHead(repo, subPath) {
  const dir = path.join(repo.workDir, ...subPath.split('/'));
  let gitdir = path.join(dir, '.git');
  try {
    const stat = fs.lstatSync(gitdir);
    if (stat.isFile()) {
      const line = fs.readFileSync(gitdir, 'utf8');
      const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(line);
      if (!match) return null;
      gitdir = path.resolve(dir, match[1]);
    } else if (!stat.isDirectory()) {
      return null;
    }
    return await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
  } catch {
    return null;
  }
}

/**
 * The working tree's changes against `HEAD`, one kind per path, plus the
 * rename sources, the index's paths and the submodule entries —
 * `status::changes`.
 *
 * Three reads merged by path: `HEAD`'s tree, the index, the work tree
 * (untracked files listed individually; ignored never). A submodule is never
 * descended into and counts as changed only when a different commit is
 * checked out.
 */
async function scanChanges(repo) {
  const treeOid = await headTreeOid(repo);
  const [headEntries, indexEntries] = await Promise.all([
    listTreeFiles(repo, treeOid, new Map()),
    listIndexEntries(repo),
  ]);

  const gitlinks = new Map();
  for (const [relPath, entry] of headEntries) {
    if (entry.type === TYPE_COMMIT) {
      gitlinks.set(relPath, { path: relPath, head: entry.oid, stage: null });
    }
  }
  const tracked = new Set();
  for (const [relPath, entry] of indexEntries) {
    if (entry.type === TYPE_COMMIT) {
      const link = gitlinks.get(relPath) || { path: relPath, head: null, stage: null };
      link.stage = entry.oid;
      gitlinks.set(relPath, link);
      continue;
    }
    tracked.add(relPath);
  }

  const workEntries = await listWorktree(
    repo,
    tracked,
    trackedDirs(tracked),
    new Set(gitlinks.keys()),
  );

  const events = [];
  const paths = new Set([...headEntries.keys(), ...indexEntries.keys(), ...workEntries.keys()]);
  for (const relPath of paths) {
    if (gitlinks.has(relPath)) continue;
    const head = headEntries.get(relPath);
    const stage = indexEntries.get(relPath);
    const work = workEntries.get(relPath);
    const headBlob = Boolean(head && head.type === 'blob');
    const stageBlob = Boolean(stage && stage.type === 'blob');
    const workBlob = Boolean(work);

    if (!headBlob && !stageBlob) {
      if (workBlob) events.push({ path: relPath, kind: StatusKind.Untracked, oid: null });
      continue;
    }
    if (!headBlob) {
      // In the index, not in HEAD: added (regardless of later work-tree edits).
      events.push({ path: relPath, kind: StatusKind.Added, oid: stage.oid, mode: stage.mode });
      continue;
    }
    if (!stageBlob) {
      // Gone from the index: deleted — and untracked again when still on disk.
      events.push({ path: relPath, kind: StatusKind.Deleted, oid: head.oid, mode: head.mode });
      if (workBlob) events.push({ path: relPath, kind: StatusKind.Untracked, oid: null });
      continue;
    }
    if (!workBlob) {
      events.push({ path: relPath, kind: StatusKind.Deleted, oid: head.oid, mode: head.mode });
      continue;
    }
    const modeDiffers = stage.mode != null && work.mode != null && stage.mode !== work.mode;
    if (work.oid !== stage.oid || modeDiffers) {
      if (!modeDiffers && stage.oid && (await crlfOnlyChange(repo, relPath, stage.oid))) {
        continue; // line endings only: the filters gix would run agree
      }
      events.push({ path: relPath, kind: StatusKind.Modified, oid: work.oid, mode: work.mode });
    }
  }

  // Rename tracking for HEAD → index (exact content; see the header).
  const detected = detectRenames(events);

  for (const link of gitlinks.values()) {
    let kind = null;
    if (link.head != null && link.stage != null && link.head !== link.stage) {
      kind = StatusKind.Modified;
    } else if (link.stage != null) {
      const checkedOut = await submoduleHead(repo, link.path);
      if (checkedOut && checkedOut !== link.stage) kind = StatusKind.Modified;
    }
    if (kind) detected.push({ path: link.path, kind, from: null });
  }

  const merged = merge(detected);
  return {
    kinds: merged.kinds,
    sources: merged.sources,
    tracked: [...indexEntries.keys()],
  };
}

/** The tree of `HEAD`'s commit, or `null` when the branch is unborn. */
async function headTreeOid(repo) {
  const head = await headId(repo);
  if (!head) return null;
  return (await readCommitObj(repo, head)).tree;
}

/** Every file (never a directory) in a tree: path → `{ oid, mode, type }`. */
async function listTreeFiles(repo, treeOid, cache) {
  const files = new Map();
  if (!treeOid) return files;
  const visit = async (oid, prefix) => {
    const entries = await readTreeEntries(repo, oid, cache);
    const subtrees = [];
    for (const entry of entries) {
      const relPath = prefix + entry.path;
      if (entry.type === TYPE_TREE) {
        subtrees.push([entry.oid, `${relPath}/`]);
        continue;
      }
      files.set(relPath, { oid: entry.oid, mode: modeNumber(entry.mode), type: entry.type });
    }
    await Promise.all(subtrees.map(([subOid, subPrefix]) => visit(subOid, subPrefix)));
  };
  await visit(treeOid, '');
  return files;
}

/** `"100644"` → `0o100644`; tree entry modes arrive as strings. */
function modeNumber(mode) {
  if (typeof mode === 'number') return mode;
  return typeof mode === 'string' ? parseInt(mode, 8) : null;
}

/** Every index entry: path → `{ oid, mode, type }`. */
async function listIndexEntries(repo) {
  const entries = new Map();
  await git.walk({
    fs,
    dir: repo.workDir,
    gitdir: repo.gitdir,
    cache: repo.cache,
    trees: [git.STAGE()],
    map: async (relPath, [entry]) => {
      if (relPath === '.' || !entry) return undefined;
      let type;
      try {
        type = await entry.type();
      } catch {
        return undefined;
      }
      if (type === TYPE_TREE) return undefined;
      try {
        entries.set(relPath, { oid: await entry.oid(), mode: await entry.mode(), type });
      } catch {
        // A broken index entry: ignored, as git would want it re-added.
      }
      return undefined;
    },
  });
  return entries;
}

/** Every directory containing a tracked path, as a `Set` of path prefixes. */
function trackedDirs(tracked) {
  const dirs = new Set();
  for (const relPath of tracked) {
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

/**
 * The work tree's files: path → `{ mode, oid }`, the oid only for tracked
 * paths (the index stat cache answers those without re-hashing). Ignored paths
 * are pruned and a submodule's directory is never descended into.
 */
async function listWorktree(repo, tracked, dirs, gitlinks) {
  const files = new Map();
  const { workDir, gitdir } = repo;
  await git.walk({
    fs,
    dir: workDir,
    gitdir,
    cache: repo.cache,
    trees: [git.WORKDIR({ refresh: false })],
    map: async (relPath, [entry]) => {
      if (relPath === '.' || !entry) return undefined;
      if (gitlinks.has(relPath)) return null;
      let type;
      try {
        type = await entry.type();
      } catch {
        return null;
      }
      if (type === TYPE_TREE) {
        if (dirs.has(relPath)) return undefined;
        const ignored = await git.isIgnored({
          fs,
          dir: workDir,
          gitdir: repo.commonDir,
          filepath: relPath,
        });
        return ignored ? null : undefined;
      }
      if (type !== 'blob') return null; // socket, fifo: not a file git lists
      const isTracked = tracked.has(relPath);
      const ignored =
        !isTracked &&
        (await git.isIgnored({ fs, dir: workDir, gitdir: repo.commonDir, filepath: relPath }));
      if (ignored) return null;
      try {
        const mode = await entry.mode();
        const oid = isTracked ? await entry.oid() : null;
        files.set(relPath, { mode, oid });
      } catch {
        return null; // vanished or unreadable: treated as absent
      }
      return undefined;
    },
  });
  return files;
}

/** Whether a work-tree file differs from its staged blob only in line endings. */
async function crlfOnlyChange(repo, relPath, stageOid) {
  const abs = path.join(repo.workDir, ...relPath.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  let raw;
  try {
    raw = fs.readFileSync(abs);
  } catch {
    return false;
  }
  if (!raw.includes('\r\n')) return false;
  const base = await readBlobBytes(repo, stageOid);
  return sameIgnoringLineEndings(raw, base);
}

/**
 * Pair deleted paths with added paths of the same blob content: a staged
 * `git mv` shows as one rename instead of a deletion plus an addition.
 */
function detectRenames(events) {
  const deletions = events
    .filter((e) => e.kind === StatusKind.Deleted && e.oid)
    .sort((a, b) => byteCompare(a.path, b.path));
  if (deletions.length === 0) return events;
  const byOid = new Map();
  for (const event of deletions) {
    const queue = byOid.get(event.oid);
    if (queue) queue.push(event);
    else byOid.set(event.oid, [event]);
  }
  const consumed = new Set();
  const renames = new Map();
  for (const event of events) {
    if (event.kind !== StatusKind.Added || !event.oid) continue;
    const queue = byOid.get(event.oid);
    if (!queue || queue.length === 0) continue;
    const source = queue.shift();
    consumed.add(source);
    renames.set(event.path, source.path);
  }
  if (consumed.size === 0) return events;
  const out = [];
  for (const event of events) {
    if (consumed.has(event)) continue;
    const from = renames.get(event.path);
    if (from !== undefined && event.kind === StatusKind.Added) {
      out.push({ path: event.path, kind: StatusKind.Renamed, from });
    } else {
      out.push(event);
    }
  }
  return out;
}

// ── commit graph lanes (graph.rs) ───────────────────────────────────────────

/** Lane index as the payload carries it, squashed onto the last lane. */
function shownLane(lane) {
  return Math.min(lane, MAX_LANES - 1);
}

function pushEdge(edges, from, to) {
  const edge = { from: shownLane(from), to: shownLane(to) };
  if (!edges.some((e) => e.from === edge.from && e.to === edge.to)) edges.push(edge);
}

function freeLane(active) {
  const index = active.indexOf(null);
  return index < 0 ? active.length : index;
}

function putLane(active, lane, id) {
  if (lane === active.length) active.push(id);
  else active[lane] = id;
}

/**
 * Lay `commits` (`[id, parents]`, newest first) onto lanes: the first parent
 * keeps its child's lane, every other parent takes the leftmost free lane,
 * and a lane whose commit turns up in another lane bends into it.
 */
function layout(commits) {
  const active = [];
  const rows = [];
  let width = 0;
  for (const [id, parentIds] of commits) {
    let lane = active.indexOf(id);
    if (lane < 0) {
      lane = freeLane(active);
      putLane(active, lane, id);
    }
    const edges = [];
    const parents = parentIds.slice();
    if (parents.length === 0) {
      active[lane] = null;
    } else {
      const first = parents.shift();
      const waiting = active.indexOf(first);
      if (waiting >= 0) {
        active[lane] = null;
        pushEdge(edges, lane, waiting);
      } else {
        active[lane] = first;
        pushEdge(edges, lane, lane);
      }
    }
    const claimed = [];
    for (const parent of parents) {
      let k = active.indexOf(parent);
      if (k < 0) {
        k = freeLane(active);
        putLane(active, k, parent);
        claimed.push(k);
      }
      pushEdge(edges, lane, k);
    }
    for (let j = 0; j < active.length; j++) {
      if (j !== lane && active[j] !== null && !claimed.includes(j)) pushEdge(edges, j, j);
    }
    while (active.length > 0 && active[active.length - 1] === null) active.pop();
    width = Math.max(width, lane + 1, active.length);
    rows.push({ lane: shownLane(lane), edges });
  }
  return { rows, width: Math.min(width, MAX_LANES) };
}

// ── history ─────────────────────────────────────────────────────────────────

/** Read every commit reachable from `tips`: oid → `{ parents, at, … }`. */
async function readCommitGraph(repo, tips) {
  const commits = new Map();
  const stack = tips.slice();
  while (stack.length > 0) {
    const oid = stack.pop();
    if (commits.has(oid)) continue;
    let commit;
    try {
      commit = await readCommitObj(repo, oid);
    } catch {
      continue;
    }
    commits.set(oid, {
      oid,
      parents: commit.parent || [],
      committerAt: commit.committer ? commit.committer.timestamp : 0,
      author: commit.author && commit.author.name ? commit.author.name : '',
      at: commit.author ? commit.author.timestamp : 0,
      subject: subject(commit.message || ''),
    });
    for (const parent of commit.parent || []) {
      if (!commits.has(parent)) stack.push(parent);
    }
  }
  return commits;
}

/** A max-heap of commit ids ordered by committer time, then id. */
class CommitHeap {
  constructor(commits) {
    this.commits = commits;
    this.items = [];
  }

  static before(commits, a, b) {
    const ta = commits.get(a) ? commits.get(a).committerAt : 0;
    const tb = commits.get(b) ? commits.get(b).committerAt : 0;
    if (ta !== tb) return ta > tb;
    return a < b;
  }

  push(id) {
    this.items.push(id);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!CommitHeap.before(this.commits, this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let best = i;
        if (left < this.items.length && CommitHeap.before(this.commits, this.items[left], this.items[best])) best = left;
        if (right < this.items.length && CommitHeap.before(this.commits, this.items[right], this.items[best])) best = right;
        if (best === i) break;
        [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
        i = best;
      }
    }
    return top;
  }
}

const REF_KIND_ORDER = { head: 0, branch: 1, remote: 2, tag: 3 };

/**
 * Every ref pointing at a commit: the walk tips and, per commit, its
 * decorations — head first, then branches, remotes and tags, each by name.
 * Symbolic refs and refs that do not peel to a commit are skipped.
 */
async function decorations(repo, head) {
  const headRef = headRefName(repo.gitdir);
  const tips = [];
  const refs = head && !headRef ? new Map([[head, [{ name: 'HEAD', kind: 'head' }]]]) : new Map();
  const all = readAllRefs(repo.commonDir);
  if (repo.gitdir !== repo.commonDir) {
    for (const [name, target] of readAllRefs(repo.gitdir)) all.set(name, target);
  }
  for (const [fullName, target] of all) {
    if (target.symbolic) continue;
    const id = await peelToCommit(repo, target.oid);
    if (!id) continue;
    tips.push(id);
    let kind = null;
    if (fullName.startsWith('refs/heads/')) {
      kind = fullName === headRef ? 'head' : 'branch';
    } else if (fullName.startsWith('refs/remotes/')) {
      kind = 'remote';
    } else if (fullName.startsWith('refs/tags/')) {
      kind = 'tag';
    }
    if (!kind) continue;
    const list = refs.get(id);
    const ref = { name: shortenRef(fullName), kind };
    if (list) list.push(ref);
    else refs.set(id, [ref]);
  }
  for (const list of refs.values()) {
    list.sort((a, b) => {
      const byKind = REF_KIND_ORDER[a.kind] - REF_KIND_ORDER[b.kind];
      return byKind !== 0 ? byKind : byteCompare(a.name, b.name);
    });
  }
  return { tips, refs };
}

/** `git_browser_log(path)`: the graph of everything reachable from every ref. */
async function gitBrowserLog(dir) {
  const repo = await openRepo(dir);
  const head = await headId(repo);
  return logView(repo, head);
}

async function logView(repo, head) {
  const { tips, refs } = await decorations(repo, head);
  const commits = await readCommitGraph(repo, tips.concat(head ? [head] : []));

  const rows = [];
  if (head) {
    rows.push({
      id: WORKTREE_ROW,
      short: '',
      parents: [head],
      subject: '',
      author: '',
      at: 0,
      refs: [],
      lane: 0,
      edges: [],
    });
  }

  const childCount = new Map();
  for (const commit of commits.values()) {
    for (const parent of commit.parents) {
      if (commits.has(parent)) childCount.set(parent, (childCount.get(parent) || 0) + 1);
    }
  }
  // A commit is ready once every child has been emitted. The synthetic `@`
  // row is the only child of `HEAD`, so `HEAD` starts ready (as the walk's
  // first tip in Rust).
  const heap = new CommitHeap(commits);
  for (const oid of commits.keys()) if (!childCount.get(oid)) heap.push(oid);

  const limit = MAX_COMMITS + (head ? 1 : 0);
  let truncated = false;
  while (heap.items.length > 0) {
    if (rows.length === limit) {
      truncated = true;
      break;
    }
    const oid = heap.pop();
    const commit = commits.get(oid);
    rows.push({
      id: oid,
      short: oid.slice(0, 7),
      parents: commit.parents.slice(),
      subject: commit.subject,
      author: commit.author,
      at: commit.at,
      refs: refs.get(oid) || [],
      lane: 0,
      edges: [],
    });
    for (const parent of commit.parents) {
      if (!commits.has(parent)) continue;
      const remaining = (childCount.get(parent) || 0) - 1;
      childCount.set(parent, remaining);
      if (remaining === 0) heap.push(parent);
    }
  }

  const placed = layout(rows.map((row) => [row.id, row.parents]));
  for (let i = 0; i < rows.length; i++) {
    rows[i].lane = placed.rows[i].lane;
    rows[i].edges = placed.rows[i].edges;
  }
  return { rows, width: placed.width, truncated };
}

/** Commits reachable from `oid` (inclusive). */
async function reachable(repo, oid, cache) {
  const seen = new Set();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let commit = cache.get(current);
    if (!commit) {
      try {
        commit = await readCommitObj(repo, current);
      } catch {
        continue;
      }
      cache.set(current, commit);
    }
    for (const parent of commit.parent || []) if (!seen.has(parent)) stack.push(parent);
  }
  return seen;
}

/**
 * Branch `headRef` (at `head`)'s commits ahead of and behind its upstream;
 * `null` without an upstream configured, or when the upstream ref is missing.
 */
async function aheadBehind(repo, head, headRef) {
  if (!headRef || !headRef.startsWith('refs/heads/')) return null;
  const name = headRef.slice('refs/heads/'.length);
  const get = (key) =>
    git
      .getConfig({ fs, dir: repo.workDir, gitdir: repo.commonDir, path: key, cache: repo.cache })
      .catch(() => undefined);
  const remote = await get(`branch.${name}.remote`);
  const merge = await get(`branch.${name}.merge`);
  if (!remote || !merge || !merge.startsWith('refs/heads/')) return null;
  const short = merge.slice('refs/heads/'.length);
  const upstreamRef = remote === '.' ? `refs/heads/${short}` : `refs/remotes/${remote}/${short}`;
  let upstream;
  try {
    upstream = await git.resolveRef({
      fs,
      dir: repo.workDir,
      gitdir: repo.commonDir,
      ref: upstreamRef,
      cache: repo.cache,
    });
  } catch {
    return null;
  }
  const cache = new Map();
  const ours = await reachable(repo, head, cache);
  const theirs = await reachable(repo, upstream, cache);
  let ahead = 0;
  for (const oid of ours) if (!theirs.has(oid)) ahead++;
  let behind = 0;
  for (const oid of theirs) if (!ours.has(oid)) behind++;
  return { ahead, behind };
}

// ── commands ────────────────────────────────────────────────────────────────

/** `git_browser_status(path)`: the repo header plus the folded file tree. */
async function gitBrowserStatus(dir) {
  const repo = await openRepo(dir);
  const head = await headId(repo);
  const headRef = headRefName(repo.gitdir);
  const { kinds, tracked } = await scanChanges(repo);
  // Byte order, like the Rust `BTreeMap`: the cap then always keeps the same
  // changed files (all of them) plus the same unchanged ones.
  const ordered = new Map([...kinds.entries()].sort((x, y) => byteCompare(x[0], y[0])));
  const { files, truncated } = listed(ordered, tracked, MAX_FILES);
  const tree = fold(files);
  const counts = head && headRef ? await aheadBehind(repo, head, headRef) : null;
  return {
    repo: {
      name: path.basename(repo.workDir),
      branch: headRef ? shortenRef(headRef) : null,
      head: head ?? null,
      ahead: counts ? counts.ahead : null,
      behind: counts ? counts.behind : null,
    },
    tree,
    changed: tree.changed,
    truncated,
  };
}

/** `git_browser_file(path, relPath)`: the work-tree file against its base. */
async function gitBrowserFile(dir, relPath) {
  const repo = await openRepo(dir);
  return fileView(repo, relPath);
}

async function fileView(repo, relPath) {
  const rel = projectRelative(repo.workDir, relPath);
  const { kinds, sources } = await scanChanges(repo);
  const base = sources.get(rel) ?? rel;
  const cache = new Map();
  let before = ABSENT;
  const head = await headId(repo);
  if (head) {
    const commit = await readCommitObj(repo, head);
    before = await blobAt(repo, commit.tree, base, cache);
  }
  const status = kinds.get(rel) ?? null;
  const after = readWorktree(repo.workDir, rel, before.kind === 'bytes' ? before.bytes : null);
  return render(rel, status, before, after);
}

/** `git_browser_commit(path, sha)`: metadata plus the files it touched. */
async function gitBrowserCommit(dir, sha) {
  const repo = await openRepo(dir);
  return commitView(repo, sha);
}

async function commitView(repo, sha) {
  const id = parseId(sha);
  const commit = await readCommitObj(repo, id);
  const changes = await commitChanges(repo, commit);
  const touched = changes.map((change) => [change.path, change.kind]);
  const truncated = touched.length > MAX_FILES;
  const tree = fold(touched.slice(0, MAX_FILES));
  return {
    id,
    short: id.slice(0, 7),
    subject: subject(commit.message),
    body: body(commit.message),
    author: commit.author ? commit.author.name : '',
    email: commit.author ? commit.author.email : '',
    at: commit.author ? commit.author.timestamp : 0,
    parents: (commit.parent || []).slice(),
    tree,
    files: tree.changed,
    truncated,
  };
}

/** `git_browser_commit_file(path, sha, relPath)`: one file as of a commit. */
async function gitBrowserCommitFile(dir, sha, relPath) {
  const repo = await openRepo(dir);
  return commitFileView(repo, sha, relPath);
}

async function commitFileView(repo, sha, relPath) {
  const rel = validatePathText(relPath);
  const id = parseId(sha);
  const commit = await readCommitObj(repo, id);
  const changes = await commitChanges(repo, commit);
  const change = changes.find((c) => c.path === rel);
  const base = change && change.kind === StatusKind.Renamed ? change.from : rel;
  const cache = new Map();
  const parentTreeOid = commit.parent && commit.parent[0] ? await parentTree(repo, commit) : null;
  const before =
    change && change.kind === StatusKind.Added
      ? ABSENT // a copy's destination did not exist in the parent
      : await blobAt(repo, parentTreeOid, base, cache);
  const after = await blobAt(repo, commit.tree, rel, cache);
  return render(rel, change ? change.kind : null, before, after);
}

async function parentTree(repo, commit) {
  const parent = await readCommitObj(repo, commit.parent[0]);
  return parent.tree;
}

/** The commit's touched files against its first parent. */
async function commitChanges(repo, commit) {
  const parent = commit.parent && commit.parent[0] ? await parentTree(repo, commit) : null;
  const changes = await diffTrees(repo, parent, commit.tree, new Map());
  return detectRenames(changes);
}

/** Recursively diff two trees (the empty tree for `null`). */
async function diffTrees(repo, parentTreeOid, treeOid, cache) {
  const out = [];
  const rec = async (pOid, tOid, prefix) => {
    const [parents, current] = await Promise.all([
      readTreeEntries(repo, pOid, cache),
      readTreeEntries(repo, tOid, cache),
    ]);
    const parentMap = new Map(parents.map((entry) => [entry.path, entry]));
    const currentMap = new Map(current.map((entry) => [entry.path, entry]));
    const names = [...new Set([...parentMap.keys(), ...currentMap.keys()])].sort(byteCompare);
    for (const name of names) {
      const before = parentMap.get(name);
      const after = currentMap.get(name);
      const full = prefix + name;
      const beforeTree = before && before.type === TYPE_TREE;
      const afterTree = after && after.type === TYPE_TREE;
      if (beforeTree || afterTree) {
        if (afterTree && !beforeTree) {
          if (before) out.push({ path: full, kind: StatusKind.Deleted, oid: before.oid });
          await rec(null, after.oid, `${full}/`);
        } else if (beforeTree && !afterTree) {
          await rec(before.oid, null, `${full}/`);
          if (after) out.push({ path: full, kind: StatusKind.Added, oid: after.oid });
        } else {
          await rec(before.oid, after.oid, `${full}/`);
        }
        continue;
      }
      if (!before) {
        out.push({ path: full, kind: StatusKind.Added, oid: after.oid });
      } else if (!after) {
        out.push({ path: full, kind: StatusKind.Deleted, oid: before.oid });
      } else if (before.oid !== after.oid || before.mode !== after.mode) {
        out.push({ path: full, kind: StatusKind.Modified, oid: after.oid });
      }
    }
  };
  await rec(parentTreeOid, treeOid, '');
  return out;
}

module.exports = {
  // The five commands (exact JSON of their Rust counterparts).
  gitBrowserStatus,
  gitBrowserFile,
  gitBrowserLog,
  gitBrowserCommit,
  gitBrowserCommitFile,
  // Pure helpers, exported for parity tests.
  StatusKind,
  MAX_FILES,
  MAX_SIDE_BYTES,
  MAX_LINES,
  MAX_LINE_CHARS,
  MAX_COMMITS,
  MAX_LANES,
  WORKTREE_ROW,
  merge,
  listed,
  fold,
  layout,
  view,
  render,
  lineText,
  isBinary,
  projectRelative,
  validatePathText,
  validateRelativePath,
  subject,
  body,
};