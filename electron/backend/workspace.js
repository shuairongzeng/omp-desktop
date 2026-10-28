'use strict';

/* workspace.js — git working-tree mutation for the git browser of the port.

   One-for-one ports of the single-file stage/discard commands:

     src-tauri/src/workspace.rs   accept() / reject()
       → workspaceAccept(path, relPath)   (lib.rs workspace_accept)
       → workspaceReject(path, relPath)   (lib.rs workspace_reject)

   plus the watcher teardown that has no port-side counterpart:

     lib.rs stop_git_watch(session_id) → stopGitWatch()

   Parity notes (each mirrors the Rust line it replaces):

   - Repository discovery happens before any git process runs, exactly like
     `workspace::discover` (gix `discover`): the nearest ancestor holding a
     `.git` entry is the working-tree root, a bare repository is
     `repository has no working tree`, and an unrelated folder is
     `not a git repository: Did not find a git repository in '<path>' or in
     any of its parents`. Doing it in-process keeps the error ordering right:
     a non-repo reports the repository error even when no `git` binary exists.
   - Path validation is `workspace::validate_path_text` +
     `validate_relative_path`: no absolute/UNC/drive-letter paths, no `..` or
     empty components, no `.git` component (case-insensitive), and every
     *parent* component is canonicalized so a symlinked directory cannot
     escape the work tree. The final component is deliberately never resolved,
     so a tracked symlink is mutated as the link itself (what `git status`
     reports). The normalized path that git receives is derived from the
     resolved absolute path, so git sees the path it actually tracks.
   - Mutations shell out to the `git` binary with a fully static argv, never a
     shell string: `--literal-pathspecs` (a frontend path is data, never a
     pathspec expression) and `--no-optional-locks` are applied to every
     invocation, and the binary is located by absolute path in the trusted
     PATH folders — never a bare `git`, which a project could shadow.
   - accept: `git add -- <rel>`.
   - reject: a path present in `HEAD` is restored with
     `git checkout HEAD -- <rel>`. A rename/copy destination has no blob at
     that path but its content lives at the rename source, so it is unstaged
     and the source is restored, then the moved file is removed. Everything
     else (untracked, or staged but never committed) is unstaged and deleted
     from the working tree — destructive by design, matching Rust.
   - Errors keep Rust's wording byte for byte: `git <label> failed: <stderr>`,
     `failed to run git <label>: <reason>`, `<rel> is a directory, not a file`,
     `path must not ...`, `path escapes repository root`.
   - accept/reject run asynchronously. Rust moves them off the IPC thread
     (`spawn_blocking`) because a large repository can take seconds; a
     synchronous spawn here would freeze the Electron main process just the
     same, so the git child is awaited instead.

   `stopGitWatch` is an explicit no-op: the port has no HEAD watcher (its
   `start_git_watch` is likewise a null stub), and the frontend calls the
   teardown unconditionally on session close. It resolves to `null`, the
   value the Rust command's `()` serializes to. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { childPathDirs, locateProgram } = require('./agent');

/** Folders probed for `git` ahead of the inherited PATH, in order. */
const GIT_HEAD_DIRS = ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'];

/** `workspace::git_in` — applied to every invocation, no call site can skip. */
const GIT_GLOBAL_ARGS = ['--literal-pathspecs', '--no-optional-locks'];

// ── git resolution ──────────────────────────────────────────────────────────

function dirKey(dir) {
  const raw = String(dir);
  if (process.platform !== 'win32') return raw;
  return raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The search folders for `git`: the well-known absolute install dirs first,
 * then the absolute inherited PATH entries (`child_path::child_path_dirs`,
 * which drops relative and empty entries — those would resolve against the
 * project folder).
 */
function gitSearchDirs() {
  const dirs = [];
  const seen = new Set();
  for (const dir of GIT_HEAD_DIRS.concat(childPathDirs())) {
    const key = dirKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * `child_path::locate_program` for `git`: `{ binary, path }` where `path` is
 * the joined search dirs (the child's PATH, for the helpers git itself
 * starts). Throws the Rust resolution error when nothing matches.
 */
function resolveGit(dirs = gitSearchDirs()) {
  return locateProgram(dirs, 'git');
}

// ── git invocation ──────────────────────────────────────────────────────────

/**
 * Run one git subcommand rooted at `workDir` with the global hardening flags
 * and the trusted PATH. Resolves to `{ ok, stdout, stderr }`; rejects with
 * `failed to run git <label>: <reason>` when the process cannot be started.
 */
async function spawnGit(dirs, workDir, args, label, stdio) {
  const program = locateProgram(dirs, 'git');
  return new Promise((resolve, reject) => {
    const child = spawn(program.binary, GIT_GLOBAL_ARGS.concat(args), {
      cwd: workDir,
      env: Object.assign({}, process.env, { PATH: program.path }),
      stdio,
    });
    const stdout = [];
    const stderr = [];
    if (child.stdout) child.stdout.on('data', (chunk) => stdout.push(chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      reject(new Error(`failed to run git ${label}: ${error.message}`));
    });
    child.once('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

/** `workspace::git_output`: stdout, or `git <label> failed: <stderr>`. */
async function gitOutput(dirs, workDir, args, label) {
  const result = await spawnGit(dirs, workDir, args, label, ['ignore', 'pipe', 'pipe']);
  if (!result.ok) {
    throw new Error(`git ${label} failed: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

/**
 * `workspace::git_succeeds`: exit status only, both streams discarded. For
 * probes where a non-zero exit is an expected answer (an unborn `HEAD`, a
 * path absent from `HEAD`) rather than a failure.
 */
async function gitSucceeds(dirs, workDir, args, label) {
  const result = await spawnGit(dirs, workDir, args, label, 'ignore');
  return result.ok;
}

// ── repository discovery (workspace::discover) ──────────────────────────────

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** A bare repository: `HEAD` plus `objects/` and `refs/`, with no `.git`. */
function looksBare(dir) {
  const head = lstatOrNull(path.join(dir, 'HEAD'));
  if (head === null || !head.isFile()) return false;
  const objects = lstatOrNull(path.join(dir, 'objects'));
  if (objects === null || !objects.isDirectory()) return false;
  const refs = lstatOrNull(path.join(dir, 'refs'));
  return refs !== null && refs.isDirectory();
}

/**
 * The working-tree root of the nearest repository containing `dir` — the
 * root every project-relative path resolves against. Fails like
 * `workspace::discover`: `not a git repository: …` outside a repository,
 * `repository has no working tree` for a bare one.
 */
function discover(dir) {
  const requested = path.resolve(String(dir));
  let current;
  try {
    const stat = fs.statSync(requested);
    const resolved = fs.realpathSync(requested);
    current = stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch (error) {
    throw new Error(`not a git repository: ${error.message}`);
  }
  for (;;) {
    const dotgit = lstatOrNull(path.join(current, '.git'));
    if (dotgit !== null) return current;
    if (looksBare(current)) throw new Error('repository has no working tree');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `not a git repository: Did not find a git repository in '${current}' or in any of its parents`,
  );
}

// ── path validation (workspace.rs) ──────────────────────────────────────────

/**
 * `workspace::validate_path_text`: reject an empty, absolute, UNC,
 * drive-letter, traversal, empty-component or `.git` path, touching no disk.
 * Returns the `/`-separated form.
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
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error("path must not contain '..' or empty components");
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error('path must not reference the .git directory');
  }
  return normalized;
}

/**
 * `workspace::weakly_canonicalize`: canonicalize the longest existing
 * ancestor, then re-append the part that does not exist yet (a missing
 * segment cannot be a symlink, so the escape guarantee still holds).
 */
function weaklyCanonicalize(abs) {
  let existing = abs;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.push(path.basename(existing));
    existing = parent;
  }
  let resolved = fs.realpathSync(existing);
  for (let i = missing.length - 1; i >= 0; i -= 1) resolved = path.join(resolved, missing[i]);
  return resolved;
}

/**
 * `workspace::validate_relative_path`: the textual checks, then the symlink
 * escape guard on the resolved parent (never on the final component).
 * Returns `{ abs, rel }` where `rel` is the git pathspec of the *tracked*
 * path, derived from the resolved absolute one.
 */
function validateRelativePath(workDir, rel) {
  const normalized = validatePathText(rel);
  let root;
  try {
    root = fs.realpathSync(workDir);
  } catch (error) {
    throw new Error(`failed to canonicalize repository root: ${error.message}`);
  }
  const candidate = path.join(root, ...normalized.split('/'));
  const file = path.basename(candidate);
  if (file === '' || file === '.' || file === '..') throw new Error('path must not be empty');
  let parentResolved;
  try {
    parentResolved = weaklyCanonicalize(path.dirname(candidate));
  } catch (error) {
    throw new Error(`failed to resolve path: ${error.message}`);
  }
  if (parentResolved !== root && !parentResolved.startsWith(root + path.sep)) {
    throw new Error('path escapes repository root');
  }
  const abs = path.join(parentResolved, file);
  const relNorm = path.relative(root, abs).split(path.sep).join('/');
  if (relNorm === '' || relNorm === '..' || relNorm.startsWith(`..${path.sep}`)) {
    throw new Error('path escapes repository root');
  }
  return { abs, rel: relNorm };
}

/**
 * `workspace::resolve_file_target`: discover the work tree, validate the
 * path, refuse a directory. Returns `{ workDir, abs, rel }`.
 */
function resolveFileTarget(repoRoot, relPath, dirs) {
  const workDir = discover(repoRoot);
  const target = validateRelativePath(workDir, relPath);
  const stat = lstatOrNull(target.abs);
  if (stat !== null && stat.isDirectory()) {
    throw new Error(`${target.rel} is a directory, not a file`);
  }
  return { workDir, abs: target.abs, rel: target.rel };
}

// ── accept / reject ─────────────────────────────────────────────────────────

/**
 * `workspace_accept(path, relPath)` — stage one file's working-tree changes
 * (`git add -- <rel>`). Resolves to `null`.
 */
async function accept(repoRoot, relPath, options = {}) {
  const dirs = options.searchDirs || gitSearchDirs();
  const { workDir, rel } = resolveFileTarget(repoRoot, relPath, dirs);
  await gitOutput(dirs, workDir, ['add', '--', rel], 'add');
  return null;
}

/** The worktree file's removal half of reject: a missing file is fine. */
function removeWorktreeFile(abs, rel) {
  try {
    fs.unlinkSync(abs);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw new Error(`failed to remove ${rel}: ${error.message}`);
  }
}

/**
 * `workspace::find_rename_source`: whether `rel` is the destination of a
 * rename/copy in `git diff --name-status -M -z` (staged when `staged`), and
 * if so the source path. The diff is deliberately unfiltered: a pathspec
 * would hide the rename's source and defeat git's rename detection.
 */
async function findRenameSource(dirs, workDir, rel, staged) {
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--name-status', '-M', '-z');
  const stdout = await gitOutput(dirs, workDir, args, 'diff --name-status');
  const fields = stdout.toString('utf8').split('\0').filter((field) => field !== '');
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i + 1];
      const destination = fields[i + 2];
      if (destination === rel) return source === undefined ? null : source;
      i += 2;
    } else {
      i += 1; // single-path record: consume the path and skip
    }
  }
  return null;
}

/**
 * `workspace_reject(path, relPath)` — discard one file's working-tree changes.
 *
 * A file present in `HEAD` reverts to its `HEAD` content. A rename/copy
 * destination is unstaged and its source restored, then the moved file is
 * removed. Anything else has no `HEAD` version and is unstaged and *deleted*
 * from the working tree (destructive; the UI owns the warning). Resolves to
 * `null`.
 */
async function reject(repoRoot, relPath, options = {}) {
  const dirs = options.searchDirs || gitSearchDirs();
  const { workDir, abs, rel } = resolveFileTarget(repoRoot, relPath, dirs);

  const headHasFile = await gitSucceeds(
    dirs,
    workDir,
    ['cat-file', '-e', `HEAD:${rel}`],
    'cat-file',
  );
  if (headHasFile) {
    await gitOutput(dirs, workDir, ['checkout', 'HEAD', '--', rel], 'checkout');
    return null;
  }

  const renameSource =
    (await findRenameSource(dirs, workDir, rel, true)) ||
    (await findRenameSource(dirs, workDir, rel, false));
  if (renameSource !== null) {
    await gitOutput(dirs, workDir, ['reset', '--', rel], 'reset');
    await gitOutput(dirs, workDir, ['checkout', 'HEAD', '--', renameSource], 'checkout');
    // The physical file was moved to the new name; now that the original has
    // been restored at its own path, remove it there.
    removeWorktreeFile(abs, rel);
    return null;
  }

  await gitOutput(dirs, workDir, ['reset', '--', rel], 'reset');
  removeWorktreeFile(abs, rel);
  return null;
}

// ── watcher teardown ────────────────────────────────────────────────────────

/**
 * `stop_git_watch(session_id)` — explicit no-op in the port.
 *
 * The Rust app keeps a notify-based HEAD watcher per session whose only
 * effect is keeping the git browser's branch chip fresh. The port has no
 * watcher (`start_git_watch` is a null stub), so there is nothing to stop —
 * but the frontend calls this unconditionally when a session closes, so it
 * must be an explicit handler rather than the dispatcher's silent default.
 * Returns `null`, the serialization of the Rust command's `()`.
 */
function stopGitWatch() {
  return null;
}

module.exports = {
  // The two commands, dispatcher-shaped (lib.rs workspace_accept/_reject).
  workspaceAccept: accept,
  workspaceReject: reject,
  stopGitWatch,
  // Direct ports, exported for parity tests.
  accept,
  reject,
  discover,
  validatePathText,
  validateRelativePath,
  weaklyCanonicalize,
  resolveFileTarget,
  gitSearchDirs,
  resolveGit,
};