'use strict';

/* Native shell surface: the OS-dialog and OS-launcher commands of the Tauri
   app, on Electron's `dialog` / `shell` / `clipboard` APIs.

   Ports these Rust items and the Tauri commands that expose them:

     external_open.rs::canonical_folder   → open_project_at, open_project
     external_open.rs::validate_reveal_path / reveal_dir
                                          → reveal_project_path
     navigation_guard.rs::open_external   → open_url_external
     picked_files.rs::read                → read_file_bytes
     picked_files.rs::copied_file_paths   → copied_file_paths
     picked_files.rs::copy_background     → pick_background_image
     (lib.rs) open_config_folder

   Every command returns what its Tauri counterpart returned: `null` for
   `Result<(), _>` and for a cancelled `Option<String>` picker, an array for
   `copied_file_paths`, `{ name, data }` for `read_file_bytes`. Errors are
   thrown as `Error` with the Rust message — `ipcMain.handle` turns a throw
   into a rejected invoke, so the renderer sees the same `Err(String)`.

   Deliberate deviations from the Rust source, all of them consequences of the
   Electron host:
     - Launching is `shell.openPath` / `shell.openExternal` (an in-process
       LaunchServices call) instead of `open::that_detached` under
       `spawn_gate`: there is no child process to gate.
     - `clipboard.read('NSFilenamesPboardType')` replaces the Win32 `CF_HDROP`
       read on macOS (Rust has no macOS clipboard path at all and returns an
       empty list there) — the port implements the plist the ticket asked for,
       and keeps `[]` on Linux/Windows.
     - `read_file_bytes` keeps Rust's reply key `data` (not `bytes`): the
       frontend decodes `r.data` in composer.jsx and use-bridge-snapshot.jsx.
     - `open_url_external` accepts `mailto:` as well as `http(s)`: that is
       `navigation_guard::classify`'s allow-list, which the command delegates
       to, and agent-rendered mail links depend on it.

   The dialog/launcher/clipboard paths are only reachable over the Electron
   APIs; called under plain `node` they throw `<command> requires the Electron
   main process`. The pure path helpers (`canonicalFolder`,
   `validateRevealPath`, the plist parser, `copyBackground`, `readFileBytes`)
   run anywhere, which is what the parity suite exercises. */

const fs = require('node:fs');
const path = require('node:path');

const stores = require('./stores');

// picked_files.rs: generous ceiling for a dropped image's raw bytes; the
// frontend's `prepareImage` downscales/re-encodes before the agent sees it.
const MAX_DROPPED_FILE_BYTES = 64 * 1024 * 1024;

// lib.rs pick_background_image's dialog filter, verbatim.
const BACKGROUND_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'gif',
  'bmp',
  'avif',
  'svg',
];

// picked_files.rs copy_background: `<config>/backgrounds/background.<ext>`.
const BACKGROUND_DIR_NAME = 'backgrounds';
const BACKGROUND_STEM = 'background.';

// ── electron access ─────────────────────────────────────────────────────────

/**
 * The Electron API object, or null outside the Electron main process.
 *
 * Outside Electron, `require('electron')` resolves to the npm package's
 * index.js, which exports the *path of the binary* (a string) — hence the
 * object check on top of `process.versions.electron`.
 */
function electronMain() {
  if (!process.versions.electron) return null;
  let mod;
  try {
    mod = require('electron');
  } catch {
    return null;
  }
  if (!mod || typeof mod !== 'object') return null;
  if (!mod.dialog || !mod.shell || !mod.clipboard) return null;
  return mod;
}

/** The Electron APIs one command needs, or the Rust-shaped "unsupported" error. */
function electronApi(command) {
  const mod = electronMain();
  if (!mod) throw new Error(`${command} requires the Electron main process`);
  return mod;
}

// ── io errors ───────────────────────────────────────────────────────────────

// Rust's io::Error Display: "<strerror> (os error <n>)". Node's message
// carries the syscall and path instead, so the common codes are mapped to
// the text the Rust commands put on the wire.
const OS_ERRORS = {
  EPERM: [1, 'Operation not permitted'],
  ENOENT: [2, 'No such file or directory'],
  EIO: [5, 'Input/output error'],
  EACCES: [13, 'Permission denied'],
  EBUSY: [16, 'Resource busy'],
  EEXIST: [17, 'File exists'],
  EXDEV: [18, 'Cross-device link'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EINVAL: [22, 'Invalid argument'],
  ENOSPC: [28, 'No space left on device'],
  EROFS: [30, 'Read-only file system'],
  ENAMETOOLONG: [63, 'File name too long'],
  ELOOP: [62, 'Too many levels of symbolic links'],
};

/** `io::Error`'s Display, as close as Node's errno data allows. */
function rustIoError(err) {
  const hit = err && OS_ERRORS[err.code];
  if (hit) return `${hit[1]} (os error ${hit[0]})`;
  if (err && typeof err.message === 'string' && err.message.length > 0) return err.message;
  return String(err);
}

// ── paths ───────────────────────────────────────────────────────────────────

function hasDrivePrefix(text) {
  return /^[A-Za-z]:/.test(text);
}

/**
 * Undo Windows' verbatim (`\\?\`) prefix, which `canonicalize` always adds
 * (external_open.rs::strip_verbatim). Pure string work, applied on every
 * platform: no canonical POSIX path can start with the prefix.
 */
function stripVerbatim(text) {
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice(8)}`;
  // Only a drive-letter path: `\\?\Volume{…}` GUID paths have no shorter
  // spelling, so they stay exactly as the OS gave them.
  if (text.startsWith('\\\\?\\') && hasDrivePrefix(text.slice(4))) return text.slice(4);
  return text;
}

/**
 * An existing directory as a canonical path string for the IPC boundary
 * (external_open.rs::canonical_folder). Symlinks and `..` are resolved once,
 * and anything that is not a directory is rejected rather than silently
 * spawning an agent somewhere unexpected.
 */
function canonicalFolder(target) {
  const text = typeof target === 'string' ? target : String(target);
  let canonical;
  try {
    canonical = fs.realpathSync(text);
  } catch (err) {
    throw new Error(`cannot resolve '${text}': ${rustIoError(err)}`);
  }
  let isDir = false;
  try {
    isDir = fs.statSync(canonical).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`not a directory: '${canonical}'`);
  return stripVerbatim(canonical);
}

/**
 * `Path::is_absolute`, which is not Node's `path.isAbsolute` on Windows: Rust
 * needs a prefix *and* a root (`C:\x`, `\\server\share`), so a bare `\rooted`
 * path is relative there while `path.win32.isAbsolute` calls it absolute.
 */
function isAbsolutePath(text) {
  if (process.platform !== 'win32') return text.startsWith('/');
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  return text.startsWith('\\\\');
}

/**
 * The checks reveal_dir makes before it launches anything
 * (external_open.rs::validate_reveal_path): an empty or relative string names
 * nothing to show, and a path that is not a directory (deleted, or a file)
 * would make the OS fall back to opening an arbitrary parent.
 */
function validateRevealPath(target) {
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new Error('empty path');
  }
  if (!isAbsolutePath(target)) throw new Error('not an absolute path');
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error('no such folder');
  return target;
}

// ── urls (navigation_guard.rs) ──────────────────────────────────────────────

/** `Url::parse` for the IPC boundary; the errors are the url crate's text. */
function parseExternalUrl(target) {
  const text = typeof target === 'string' ? target : String(target ?? '');
  try {
    return new URL(text);
  } catch {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
      throw new Error('relative URL without a base');
    }
    if (/^(https?):(\/*)$/i.test(text)) throw new Error('empty host');
    throw new Error('invalid URL');
  }
}

/**
 * navigation_guard.rs::classify with no dev URL: only web and mail URLs are
 * handed to the OS. Everything else — `file:`, `data:`, the app's own
 * `tauri:` origin, custom schemes — is blocked, so the command cannot launch
 * a local file or executable.
 */
function classifyExternalUrl(parsed) {
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') return 'open';
  return 'block';
}

// ── clipboard plist ─────────────────────────────────────────────────────────

const XML_NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML entity references as the plist serializer writes them. */
function unescapeXml(text) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    const named = XML_NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/**
 * Absolute paths out of an `NSFilenamesPboardType` property list.
 *
 * The payload is a tiny XML document whose every entry is a `<string>`; no
 * parser dependency is warranted for that, and a hand-rolled scan is safe
 * here because the only structure being looked for is the tag pair itself.
 * Anything that is not an absolute path (plain text on the clipboard, a
 * truncated document, a stray element) is dropped — the composer reads an
 * empty list as "not a file copy" and falls back to its image/text handling.
 */
function parseFileListPlist(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const entry = /<string>([\s\S]*?)<\/string>/g;
  let match = entry.exec(text);
  while (match !== null) {
    const value = unescapeXml(match[1]).trim();
    if (value.length > 0 && !value.includes('\0') && path.isAbsolute(value)) out.push(value);
    match = entry.exec(text);
  }
  return out;
}

// ── commands ────────────────────────────────────────────────────────────────

/**
 * `open_project`: the native folder picker, returning the chosen canonical
 * path or null when cancelled. Canonical for the same reason an OS "Open
 * with" folder is: the tab path is compared with the canonical
 * recent-projects entries, so a folder picked through a symlink must not
 * look like a different project.
 */
async function openProject() {
  const { dialog } = electronApi('open_project');
  const result = await dialog.showOpenDialog(null, {
    title: 'Open Project Folder',
    properties: ['openDirectory'],
  });
  if (!result || result.canceled) return null;
  const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
  if (typeof picked !== 'string' || picked.length === 0) return null;
  return canonicalFolder(picked);
}

/**
 * `open_project_at { path }`: the phone's folder sheet sends a typed path and
 * the desktop opens it exactly as its own picker would. Absolute-only: a
 * relative string would silently resolve against *this* process' cwd, which
 * is never the shell the user typed it in.
 */
async function openProjectAt(target) {
  if (typeof target !== 'string' || target.trim().length === 0) throw new Error('empty path');
  if (!isAbsolutePath(target)) throw new Error('not an absolute path');
  return canonicalFolder(target);
}

/**
 * `open_config_folder`: create this app's config folder if it is missing, then
 * show it in the OS file manager.
 */
async function openConfigFolder() {
  const { shell } = electronApi('open_config_folder');
  const dir = stores.configHome();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`cannot create ${dir}: ${rustIoError(err)}`);
  }
  const failure = await shell.openPath(dir);
  if (typeof failure === 'string' && failure.length > 0) throw new Error(failure);
  return null;
}

/** `reveal_project_path`: show an existing project folder in the OS file manager. */
async function revealProjectPath(target) {
  const checked = validateRevealPath(target);
  const { shell } = electronApi('reveal_project_path');
  const failure = await shell.openPath(checked);
  if (typeof failure === 'string' && failure.length > 0) throw new Error(failure);
  return null;
}

/** `open_url_external`: hand a web or mail URL to the OS default handler. */
async function openUrlExternal(target) {
  const parsed = parseExternalUrl(target);
  if (classifyExternalUrl(parsed) !== 'open') {
    throw new Error(`refusing to open ${parsed.href} externally`);
  }
  const { shell } = electronApi('open_url_external');
  await shell.openExternal(parsed.href);
  return null;
}

/**
 * `copied_file_paths`: the files/folders a file manager put on the clipboard,
 * or an empty list. Rust's contract is "a list, never an error": a clipboard
 * held by another kind of content, an unreadable clipboard or a non-macOS
 * host all mean "not a file copy" and the composer falls back to its
 * image/text handling.
 */
async function copiedFilePaths() {
  if (process.platform !== 'darwin') return [];
  const mod = electronMain();
  if (!mod) return [];
  let raw = null;
  try {
    raw = mod.clipboard.read('NSFilenamesPboardType');
  } catch {
    return [];
  }
  return parseFileListPlist(raw);
}

/**
 * `read_file_bytes`: a picked file's base name and base64 contents, for the
 * composer's image pipeline and the background-image tweak.
 */
async function readFileBytes(target) {
  if (typeof target !== 'string') throw new Error('read_file_bytes: path must be a string');
  let meta;
  try {
    meta = fs.statSync(target);
  } catch (err) {
    throw new Error(`could not read ${target}: ${rustIoError(err)}`);
  }
  if (!meta.isFile()) throw new Error(`not a file: ${target}`);
  if (meta.size > MAX_DROPPED_FILE_BYTES) throw new Error(`file too large: ${target}`);
  let bytes;
  try {
    bytes = fs.readFileSync(target);
  } catch (err) {
    throw new Error(`could not read ${target}: ${rustIoError(err)}`);
  }
  return { name: path.basename(target), data: bytes.toString('base64') };
}

/**
 * `picked_files::copy_background`: copy a picked image to
 * `<config>/backgrounds/background.<ext>` and return the copy's path. Single
 * slot — any previous `background.*` is removed first, so the folder never
 * accumulates stale picks.
 */
function copyBackground(configDir, src) {
  // `Path::extension()` has no counterpart for the trailing dot: `shot.` is
  // `Some("")` there (dest `background.`), while `shot`/`.hidden` are `None`
  // (dest `background.png`). Node's `extname` maps both to ''/'.'.
  const dotExtension = path.extname(src);
  const extension = (dotExtension === '' ? 'png' : dotExtension.slice(1)).toLowerCase();
  const dir = path.join(configDir, BACKGROUND_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`cannot create ${dir}: ${rustIoError(err)}`);
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`cannot read ${dir}: ${rustIoError(err)}`);
  }
  for (const name of entries) {
    if (!name.startsWith(BACKGROUND_STEM)) continue;
    // Rust ignores a failed removal (`let _ = fs::remove_file(..)`).
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* leave it; the copy below is what the caller needs */
    }
  }
  const dest = path.join(dir, `${BACKGROUND_STEM}${extension}`);
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    throw new Error(`cannot copy ${src}: ${rustIoError(err)}`);
  }
  return dest;
}

/**
 * `pick_background_image`: pick an image, copy it under the config folder and
 * return the copy's path; null when cancelled. The tweak only ever points at
 * our own copy, so a moved or deleted original never breaks the setting.
 */
async function pickBackgroundImage() {
  const { dialog } = electronApi('pick_background_image');
  const result = await dialog.showOpenDialog(null, {
    title: 'Choose a Background Image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: BACKGROUND_IMAGE_EXTENSIONS.slice() }],
  });
  if (!result || result.canceled) return null;
  const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
  if (typeof picked !== 'string' || picked.length === 0) return null;
  return copyBackground(stores.configHome(), picked);
}

module.exports = {
  // The IPC surface: one function per Tauri command name.
  openProject,
  openProjectAt,
  openConfigFolder,
  revealProjectPath,
  openUrlExternal,
  copiedFilePaths,
  readFileBytes,
  pickBackgroundImage,
  // Pure helpers and constants the parity suite pins (mirror the Rust items).
  canonicalFolder,
  validateRevealPath,
  isAbsolutePath,
  stripVerbatim,
  parseExternalUrl,
  classifyExternalUrl,
  parseFileListPlist,
  unescapeXml,
  copyBackground,
  rustIoError,
  MAX_DROPPED_FILE_BYTES,
  BACKGROUND_IMAGE_EXTENSIONS,
  BACKGROUND_DIR_NAME,
  BACKGROUND_STEM,
};