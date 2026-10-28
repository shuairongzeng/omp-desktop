'use strict';

/* Per-session `.git/HEAD` watcher — port of src-tauri/src/git_watcher.rs.
 *
 * Rust keeps one `notify::RecommendedWatcher` per live session, watching the
 * *git dir* (the parent of HEAD) non-recursively and re-reading the branch
 * whenever the event names `HEAD`. This module keeps the same contract
 * without Electron:
 *
 *     const { close } = createGitWatch(projectPath, () => { … });
 *     close();   // cancels the watch, idempotent
 *
 * ## What is watched (git_watcher.rs `start`)
 *
 * The directory, not the file. git rewrites HEAD atomically
 * (`rename(.git/HEAD.lock → .git/HEAD)`), which replaces the inode; an
 * in-sandbox inotify file watch would be orphaned after the first branch
 * switch. `fs.watch(gitDir)` is the closest analogue of notify's directory
 * watch on every platform (FSEvents / inotify / ReadDirectoryChangesW).
 *
 * Nothing else is watched: the Rust watcher has no `packed-refs` or `refs/`
 * watch — a branch switch only rewrites HEAD, and a commit on the current
 * branch leaves HEAD untouched.
 *
 * ## Linked worktrees (git.rs `probe` → `repo.git_dir()`)
 *
 * gix returns the *worktree's own* git dir, so HEAD is watched at
 * `…/.git/worktrees/<name>/HEAD` for a linked worktree and at `<root>/.git/HEAD`
 * for the main one. Discovery here mirrors that: walk up from the project
 * path to the nearest `.git` entry; a `.git` directory is the git dir, a
 * `.git` *file* (`gitdir: <path>`, relative to the working-tree root) is
 * followed — that is how git marks a linked worktree or submodule.
 *
 * ## Event filtering (git_watcher.rs `is_head_change`)
 *
 * - Name: only events naming a file called exactly `HEAD`. Directory watches
 *   also report siblings (`index`, `HEAD.lock`, `COMMIT_EDITMSG`, …), which
 *   must not fire. When the platform withholds the name, the content check
 *   below still keeps unrelated writes silent.
 * - Content: the watcher keeps the last HEAD text and fires only when it
 *   actually changed. Access/open events cannot exist here (`fs.watch` does
 *   not report them); the content check is what makes a burst of OS events
 *   for one rename collapse into one call, and what keeps a rewrite of the
 *   identical value (git touches HEAD in a few no-op flows) silent.
 *
 * ## Switching vs. coalescing
 *
 * The Rust watcher has no timer: notify hands a branch switch over as one
 * `Modify(Name)` event and the callback fires immediately. `fs.watch` is
 * coarser — one atomic rename can surface as several callbacks, and macOS
 * FSEvents can deliver them before the directory entry has settled — so a
 * short settle timer (SETTLE_MS) debounces the burst and the content
 * comparison makes repeated events idempotent. The observable behaviour is
 * still "one call per HEAD change", which is what the Rust code documents.
 *
 * ## No-op cases
 *
 * Not a repository (no `.git` in any ancestor), a `.git` that cannot be read,
 * a HEAD that disappears, a watch the OS refuses (EMFILE/ENOSPC/EPERM): the
 * watcher is a silent no-op. `createGitWatch` never throws — Rust's caller
 * swallows `start` errors for the same reason (the branch chip simply does
 * not update live).
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * How long a burst of `fs.watch` callbacks is allowed to settle before HEAD
 * is re-read. Rust needs no equivalent (see the header); this is the JS-side
 * debounce.
 */
const SETTLE_MS = 50;

// ── repository discovery (git.rs `probe`) ───────────────────────────────────

/** Read a `.git` file's `gitdir: <path>` target, resolved against `baseDir`. */
function readGitDirFile(dotgitFile, baseDir) {
  let text;
  try {
    text = fs.readFileSync(dotgitFile, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:[ \t]*(.+)$/m.exec(text);
  if (!match) return null;
  return path.resolve(baseDir, match[1].trim());
}

/**
 * The git dir of the nearest repository containing `dir`, or `null`.
 *
 * `dir` may be any depth inside the working tree (Rust's `discover` also
 * accepts nested paths); a linked worktree's `.git` file points at
 * `…/.git/worktrees/<name>`, which holds that worktree's own HEAD.
 */
function resolveGitDir(dir) {
  let current = path.resolve(dir);
  for (;;) {
    const dotgit = path.join(current, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotgit);
    } catch {
      stat = null;
    }
    if (stat) {
      if (stat.isDirectory()) return dotgit;
      if (stat.isFile()) return readGitDirFile(dotgit, current);
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `{ gitDir, headPath }` for the repository containing `projectPath`, or
 * `null` when the path is not inside a repository. `headPath` is what
 * `git.rs::probe` hands the watcher: `<git dir>/HEAD`.
 */
function locateGitHead(projectPath) {
  let gitDir = null;
  try {
    gitDir = resolveGitDir(projectPath);
  } catch {
    gitDir = null;
  }
  if (gitDir === null) return null;
  return { gitDir, headPath: path.join(gitDir, 'HEAD') };
}

/** HEAD's text, trimmed, or `null` when it cannot be read. */
function readHead(headPath) {
  try {
    return fs.readFileSync(headPath, 'utf8').trim();
  } catch {
    return null;
  }
}

// ── the watcher (GitWatcherState::start / stop) ─────────────────────────────

/**
 * Watch the repository containing `projectPath` for HEAD changes.
 *
 * `onChange` is called once per actual HEAD change (branch switch, detached
 * re-attach, direct write). It is never called for sibling `.git` writes and
 * never after `close()`. A listener that throws is isolated: the watcher
 * keeps running.
 *
 * Returns `{ close() }`; `close()` is idempotent and also cancels a pending
 * debounced call. Outside a repository the returned watcher is an inert
 * no-op (`GitWatcherState::stop` is a no-op for an unregistered session).
 *
 * @param {string} projectPath
 * @param {() => void} [onChange]
 * @returns {{ close: () => void }}
 */
function createGitWatch(projectPath, onChange) {
  const notify = typeof onChange === 'function' ? onChange : null;
  const target = locateGitHead(projectPath);
  if (target === null || notify === null) return { close() {} };

  const { gitDir, headPath } = target;
  let closed = false;
  let timer = null;
  let watcher = null;
  let lastHead = readHead(headPath);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    timer = null;
    if (watcher !== null) {
      const active = watcher;
      watcher = null;
      try {
        active.close();
      } catch {
        // Already closed by the OS (the watched directory vanished).
      }
    }
  };

  const flush = () => {
    timer = null;
    if (closed) return;
    const head = readHead(headPath);
    if (head === null || head === lastHead) return;
    lastHead = head;
    try {
      notify();
    } catch {
      // A listener must not tear down the watch (Rust's callback cannot
      // throw either).
    }
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(flush, SETTLE_MS);
  };

  try {
    // Non-recursive, like `watch(git_dir, RecursiveMode::NonRecursive)`.
    watcher = fs.watch(gitDir, { persistent: true }, (_eventType, filename) => {
      // `is_head_change`: sibling names are noise; a withheld name still
      // goes through the content comparison.
      if (filename !== null && filename !== undefined && String(filename) !== 'HEAD') return;
      schedule();
    });
    watcher.on('error', close);
  } catch {
    // Not watchable (permissions, descriptor limits, dir gone): silent no-op.
    close();
  }

  return { close };
}

module.exports = {
  createGitWatch,
  locateGitHead,
  resolveGitDir,
  SETTLE_MS,
};