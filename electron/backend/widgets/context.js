'use strict';

/* Widget plugin context: the Node port of `src-tauri/src/widgets/context.rs`.

   A widget plugin learns exactly what `PluginContext` carries — nothing else
   is available to it (no transcript, no model):

     project   absolute path of the tab's project (never bounded)
     branch    current branch, or "" (detached HEAD, or not a repository)
     remote    fetch URL of the default remote, or ""; a password in the URL
               is removed (`https://user:pw@host/x` → `https://user@host/x`)
     session   desktop session id of the tab
     trigger   activate | turn_end | branch | manual | interval

   The per-run payload (`pluginContext`) bounds branch, remote and session to
   `CONTEXT_FIELD_MAX_BYTES` (2048 bytes, cut on a character boundary) because
   every value is also an environment variable and Linux caps one env string
   at 128 KiB. `project` is left intact: it is the plugin's working directory,
   and truncating it would run the plugin somewhere else.

   `gitContext` is the repository read behind `session_ctx`: it discovers the
   repository once (branch via HEAD, dirty count via the git browser's
   read-only status walk, remote via the repository config through
   isomorphic-git), and a path that is not a repository yields the Rust
   empty shape — never a throw. Every read is read-only and runs no external
   program: the project is untrusted, so no `git` child is started in it.

   `dirty` is an extension: the Rust `PluginContext` has no such field, but
   the rail shows the count. `pluginContext` never copies it into the payload.
*/

const fs = require('node:fs');
const path = require('node:path');
const git = require('isomorphic-git');

const { gitBrowserStatus } = require('../git');

/** `context.rs::CONTEXT_FIELD_MAX_BYTES`. */
const CONTEXT_FIELD_MAX_BYTES = 2048;

/** The five strings a plugin receives (`context.rs::PluginContext`). */
function emptyContext(project) {
  return {
    project: typeof project === 'string' ? project : '',
    branch: '',
    remote: '',
    dirty: null,
  };
}

/**
 * The repository containing `dir`: `{workDir, gitdir, commonDir, cache}`, or
 * `null` when there is none. Mirrors the discovery in `git.js::openRepo`,
 * including linked worktrees (HEAD and index in the worktree git dir, config
 * and refs in the common dir).
 */
async function discover(dir) {
  let workDir;
  try {
    workDir = await git.findRoot({ fs, filepath: path.resolve(dir) });
  } catch {
    return null;
  }
  let gitdir = path.join(workDir, '.git');
  try {
    const stat = fs.statSync(gitdir);
    if (!stat.isDirectory()) {
      if (!stat.isFile()) return null;
      const text = fs.readFileSync(gitdir, 'utf8');
      const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
      if (!match) return null;
      gitdir = path.resolve(workDir, match[1]);
    }
  } catch {
    return null;
  }
  let commonDir = gitdir;
  try {
    const text = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (text !== '') commonDir = path.resolve(gitdir, text);
  } catch {
    // Not a linked worktree: the git dir is its own common dir.
  }
  return { workDir, gitdir, commonDir, cache: {} };
}

/** The branch HEAD points at, or "" (detached HEAD, unreadable HEAD). */
function headBranch(gitdir) {
  try {
    const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    const match = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * `url` without its password. gix's `set_password(None)` writes the same URL
 * back without the `:pw` part of the userinfo; a URL without a password is
 * returned untouched (no reserialisation, no normalisation).
 */
function urlWithoutPassword(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*@)([\s\S]*)$/.exec(url);
  if (!match) return url;
  const authority = match[2].slice(0, -1); // drop the trailing '@'
  const colon = authority.indexOf(':');
  if (colon === -1) return url; // user only, or a port on a host: no password
  return `${match[1]}://${authority.slice(0, colon)}@${match[3]}`;
}

/**
 * The default remote's fetch URL (`gix::Repository::find_default_remote`):
 * the current branch's configured remote, else `origin`. A branch remote
 * configured as `.` (a local upstream) is ignored, as gix does. No remote, or
 * a remote without a URL, yields "" (never a throw).
 */
async function defaultRemoteUrl(repo, branch) {
  const config = (key) =>
    git
      .getConfig({
        fs,
        dir: repo.workDir,
        gitdir: repo.commonDir,
        path: key,
        cache: repo.cache,
      })
      .catch(() => undefined);

  let name = 'origin';
  if (branch !== '') {
    const configured = await config(`branch.${branch}.remote`);
    if (typeof configured === 'string' && configured !== '' && configured !== '.') {
      name = configured;
    }
  }
  const url = await config(`remote.${name}.url`);
  return typeof url === 'string' ? urlWithoutPassword(url) : '';
}

/**
 * Repository facts for the session the plugin runs for: branch, default
 * remote fetch URL and the changed-file count. Never throws: a missing,
 * unreadable or non-repository path yields the Rust empty shape with
 * `project` carried through.
 */
async function gitContext(projectPath) {
  const project = typeof projectPath === 'string' ? projectPath : '';
  if (project === '') return emptyContext(project);

  const repo = await discover(project);
  if (repo === null) return emptyContext(project);

  let dirty = null;
  try {
    // The git browser's read-only status walk (isomorphic-git, no child
    // process). Its `changed` count is the porcelain entry count.
    const view = await gitBrowserStatus(project);
    if (view && Number.isInteger(view.changed)) dirty = view.changed;
  } catch {
    dirty = null; // unreadable repository metadata: facts stay empty
  }

  const branch = headBranch(repo.gitdir);

  let remote = '';
  try {
    remote = await defaultRemoteUrl(repo, branch);
  } catch {
    remote = '';
  }

  return {
    project,
    branch,
    remote,
    dirty,
  };
}

/** `session_ctx` in the Rust module's own name. */
const sessionCtx = gitContext;

/**
 * `field` cut to at most `CONTEXT_FIELD_MAX_BYTES` on a UTF-8 character
 * boundary (`text::prefix_within`), copied once.
 */
function bounded(field) {
  const value = typeof field === 'string' ? field : '';
  if (Buffer.byteLength(value, 'utf8') <= CONTEXT_FIELD_MAX_BYTES) return value;
  const bytes = Buffer.from(value, 'utf8');
  let end = CONTEXT_FIELD_MAX_BYTES;
  // The first excluded byte is a continuation byte when the cut would split
  // a character; back up to that character's leading byte.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * The per-run payload (`PluginContext`): `ctx` plus the session id and
 * trigger, with every field except `project` bounded. `dirty` and any other
 * extension keys are not copied.
 */
function pluginContext(ctx, session, trigger) {
  const source = ctx || {};
  return {
    project: typeof source.project === 'string' ? source.project : '',
    branch: bounded(source.branch),
    remote: bounded(source.remote),
    session: bounded(session),
    trigger: typeof trigger === 'string' ? trigger : '',
  };
}

module.exports = {
  gitContext,
  sessionCtx,
  pluginContext,
  bounded,
  urlWithoutPassword,
  headBranch,
  CONTEXT_FIELD_MAX_BYTES,
};