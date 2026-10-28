/* electron/backend/external-open.js — the OS folder-open ingest.

   Ports src-tauri/src/external_open.rs's argv/URL half: positional
   arguments of a launch or forwarded argv, and macOS `open-file` URLs,
   resolved to canonical folders and queued for the frontend's drain
   (live.js:2144 listens to `open://project`, then pulls
   `take_pending_open_projects` until empty). A request that fails to
   resolve is logged and dropped, exactly like Rust: the OS is the caller,
   there is no UI context to report in. */

const path = require("node:path");
const nativeShell = require("./native-shell");

/** At most this many folders wait for the frontend (Rust MAX_PENDING). */
const MAX_PENDING = 32;

/** `argv[0]` is the executable and an option is never a path; macOS also
 *  passes `-psn_0_…` to bundled apps (external_open.rs:80). */
function positionalArgs(argv) {
  return (argv ?? []).slice(1).filter((a) => typeof a === "string" && a.length > 0 && !a.startsWith("-"));
}

/** A `file://` URL from the OS resolved to a canonical folder. */
function folderFromUrl(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch (error) {
    return { ok: false, error: `invalid URL '${urlText}': ${error.message}` };
  }
  if (url.protocol !== "file:") return { ok: false, error: `unsupported scheme in '${urlText}'` };
  let file;
  try {
    file = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, error: `not a local path: ${urlText}` };
  }
  return folderFromPath(file);
}

function folderFromPath(p) {
  try {
    return { ok: true, path: nativeShell.canonicalFolder(p) };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
}

/** Rust `folder_from_arg`: `file://` first, else joined onto the sender's
 *  cwd so a relative argument resolves where the user typed it. */
function folderFromArg(base, arg) {
  if (arg.startsWith("file://")) return folderFromUrl(arg);
  // Rust's Path::join REPLACES on an absolute argument; Node's path.join
  // concatenates, so resolve is the parity call (relative args still join
  // onto the sender's cwd).
  return folderFromPath(path.resolve(base ?? process.cwd(), arg));
}

/** The queue the frontend drains; one per app run. */
class OpenProjectState {
  constructor() {
    this.pending = [];
  }

  /** Queue one resolved folder; false when full or a duplicate. */
  enqueue(folder) {
    if (this.pending.length >= MAX_PENDING) return false;
    if (this.pending.includes(folder)) return false;
    this.pending.push(folder);
    return true;
  }

  /** The whole batch, emptied (live.js re-takes until empty). */
  takePending() {
    return this.pending.splice(0, this.pending.length);
  }
}

/** Resolve, queue and report every folder of one OS request. Returns the
 *  queued count so the caller announces once per non-empty batch. */
function ingest(state, outcomes, log = () => {}) {
  let queued = false;
  for (const outcome of outcomes) {
    if (outcome.ok) queued = state.enqueue(outcome.path) || queued;
    else log(`[port] ignored folder-open request: ${outcome.error}`);
  }
  return queued;
}

module.exports = {
  MAX_PENDING,
  positionalArgs,
  folderFromUrl,
  folderFromPath,
  folderFromArg,
  OpenProjectState,
  ingest,
};
