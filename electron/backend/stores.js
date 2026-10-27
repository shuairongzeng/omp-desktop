/* electron/backend/stores.js — the side-effect-free JSON stores of the port.

   Ports four Rust modules from `src-tauri/src` one-for-one, including their
   on-disk shapes, defaults and error policy:

     open_tabs.rs        <config>/open-tabs.json       (disposable)
     recent_projects.rs  <config>/recent-projects.json (disposable)
     approval_mode.rs    <config>/approval-mode.json   (strict)
     profiles.rs         <config>/profiles.json        (strict + snapshot ring)

   Every function is **synchronous** and blocks on file I/O: the Electron main
   process is the single owner of these files, and each call touches a file of
   a few kilobytes (`open_tabs_save` runs on every tab change, so the write is
   kept as small as the Rust one). Errors are thrown as `Error` with the Rust
   command's message; `ipcMain.handle` turns a throw into a rejected invoke, so
   the renderer sees the same `Err(String)` it saw from Tauri.

   Config home — `process.env.OMP_PORT_CONFIG_DIR` when set, otherwise the
   platform default Tauri used (darwin `~/Library/Application Support/
   dev.ohMyPi.desktop`, win32 `%APPDATA%/dev.ohMyPi.desktop`, else
   `$XDG_CONFIG_HOME|~/.config/dev.ohMyPi.desktop`). Because that always
   resolves, the Rust stores' "no config folder ⇒ memory-only" branch has no
   counterpart here: every store is file-backed.

   What the port keeps from `json_store.rs`:
     - atomic writes (temp file in the destination directory, fsync, rename),
       plus the first-write orphan-temp sweep;
     - `read_strict` (missing ⇒ default, anything else ⇒ error) and
       `read_or_default` (missing or unreadable ⇒ default, logged);
     - `update_strict` (re-read under the write, refuse to replace a file that
       cannot be read, write only when something changed).
   What it drops: the advisory `<file>.lock` (`with_lock`/`with_lock_str`) and
   its stale-takeover logic. That lock exists because Tauri runs several
   webview windows' commands as independent blocking threads on one file; the
   Electron backend is one main process, so its callers are already
   serialised by the event loop, and a leftover `.lock` file would only be one
   more thing to clean up. The failure modes the lock guarded against in the
   Tauri store (`update_strict`'s read-modify-write) are handled by the
   atomic write: a reader sees the old file or the new one, never a partial.
   Snapshot-ring *reads* are kept (profiles recovers a corrupt primary from
   `<config>/profiles.snapshots`, which an earlier Tauri run may have left
   behind); ring *writes* are not, since this milestone has no profile
   mutations and therefore no snapshots to take.

   Prompt-history, keybindings and saved sessions are separate slices. */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── config home ─────────────────────────────────────────────────────────────

const APP_DIR_NAME = "dev.ohMyPi.desktop";

/** The app config folder, or the `OMP_PORT_CONFIG_DIR` override. */
function configHome() {
  const override = process.env.OMP_PORT_CONFIG_DIR;
  if (override && override.length > 0) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, APP_DIR_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(home, ".config"), APP_DIR_NAME);
}

function configPath(name) {
  return path.join(configHome(), name);
}

/** `Path::with_extension`, i.e. replace the last extension of the file name. */
function withExtension(file, ext) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  // A leading dot is not an extension (Rust's `file_stem` keeps it whole).
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(dir, `${stem}.${ext}`);
}

// ── logging ─────────────────────────────────────────────────────────────────

/** Rust's `eprintln!("[omp-desktop] …")` trace: stderr, never fatal. */
function logError(message) {
  process.stderr.write(`[omp-desktop] ${message}\n`);
}

/** Block this thread (the retry path only — `Atomics.wait` is a real sleep). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── json_store: atomic write ────────────────────────────────────────────────

/** Monotonic suffix so two writes in one millisecond land on different temps. */
let tempCounter = 0;

/** Destinations already swept for orphan temp files by this process. */
const sweptDestinations = new Set();

function tempPathFor(file) {
  return path.join(
    path.dirname(file),
    `${path.basename(file)}.${process.pid}-${tempCounter++}.tmp`,
  );
}

/**
 * Remove leftover `<base>.*.tmp` files in `dir` (a crashed writer's residue).
 * Best-effort: an entry that vanished or cannot be removed is skipped.
 */
function sweepOrphanTempFiles(dir, baseName) {
  const prefix = `${baseName}.`;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    if (path.extname(name).toLowerCase() !== ".tmp") continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // Best-effort, like the Rust sweep.
    }
  }
  return removed;
}

/**
 * Write `text` to `file` without ever exposing a partially-written file:
 * unique temp file in the same directory, fsync, rename over the target.
 *
 * The Rust original relies on `with_lock_str` to `create_dir_all` the parent;
 * the lock is gone here, so this does the `mkdir -p` itself. The first write
 * to a destination also sweeps that destination's orphan temp files.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!sweptDestinations.has(file)) {
    sweptDestinations.add(file);
    try {
      sweepOrphanTempFiles(dir, base);
    } catch {
      // Best-effort; the write below still has to happen.
    }
  }

  const temp = tempPathFor(file);
  let fd = null;
  try {
    fd = fs.openSync(temp, "wx");
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

/** serde_json's `to_vec_pretty`: two-space indent, no trailing newline. */
function pretty(value) {
  return JSON.stringify(value, null, 2);
}

// ── json_store: reads ───────────────────────────────────────────────────────

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Raw bytes of `file`, or `null` when it does not exist. Throws otherwise. */
function readRaw(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** `JSON.parse` over bytes; invalid UTF-8 is an error like serde's. */
function jsonParse(bytes) {
  return JSON.parse(UTF8.decode(bytes));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(bytes, what) {
  const value = jsonParse(bytes);
  if (!isPlainObject(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

function requireString(value, what) {
  if (typeof value !== "string") throw new Error(`${what} must be a string`);
  return value;
}

/** A serde `Option<String>` field: absent/null ⇒ `null`. */
function optionalString(value, what) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${what} must be a string or null`);
  return value;
}

/** A serde `u64`/`usize` field. */
function requireUnsigned(value, what) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer`);
  }
  return value;
}

function requireArray(value, what) {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  return value;
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function isDirectory(target) {
  const stat = statOrNull(target);
  return stat !== null && stat.isDirectory();
}

function isFile(target) {
  const stat = statOrNull(target);
  return stat !== null && stat.isFile();
}

/** Unix epoch milliseconds, `0` for a clock before 1970. */
function nowMs() {
  return Math.max(0, Math.trunc(Date.now()));
}

// ── open_tabs.rs ────────────────────────────────────────────────────────────

/** Tabs kept per layout; a restore drops any beyond this. */
const MAX_TABS = 64;

/** `open-tabs.json`'s field order, exactly as the Rust structs declare it. */
function emptyLayout() {
  return { tabs: [], active: null };
}

function parseLayout(bytes) {
  const raw = parseObject(bytes, "open-tabs.json");
  const tabs = raw.tabs === undefined ? [] : requireArray(raw.tabs, "tabs");
  const parsed = tabs.map((tab, i) => {
    if (!isPlainObject(tab)) throw new Error(`tabs[${i}] must be an object`);
    const where = `tabs[${i}]`;
    return {
      path: tab.path === undefined ? "" : requireString(tab.path, `${where}.path`),
      profile: optionalString(tab.profile, `${where}.profile`),
      sessionFile: optionalString(tab.sessionFile, `${where}.sessionFile`),
      name: optionalString(tab.name, `${where}.name`),
    };
  });
  let active = raw.active;
  if (active === undefined || active === null) active = null;
  else active = requireUnsigned(active, "active");
  return { tabs: parsed, active };
}

function readLayoutOrEmpty() {
  const file = configPath("open-tabs.json");
  try {
    const bytes = readRaw(file);
    return bytes === null ? emptyLayout() : parseLayout(bytes);
  } catch (err) {
    logError(`${file} unreadable, reading as empty: ${err.message}`);
    return emptyLayout();
  }
}

/** Empty optionals read back as absent. */
function nonEmpty(value) {
  return value === "" ? null : value;
}

/** Cap the tab count, drop an out-of-range `active`, normalise `""` ⇒ null. */
function sanitizeLayout(layout) {
  const tabs = layout.tabs.slice(0, MAX_TABS).map((tab) => ({
    path: tab.path,
    profile: nonEmpty(tab.profile),
    sessionFile: nonEmpty(tab.sessionFile),
    name: nonEmpty(tab.name),
  }));
  const active =
    layout.active !== null && layout.active !== undefined && layout.active < tabs.length
      ? layout.active
      : null;
  return { tabs, active };
}

/**
 * The tabs a launch can reopen, with `active` remapped:
 * - a conversation file gone from disk reopens as a fresh conversation in the
 *   same folder (the folder is what the user had open);
 * - a folder gone from disk drops the tab and reports it in `skipped`;
 * - a pathless tab without a conversation has nothing to reopen and is
 *   dropped silently.
 */
function restorable(layout) {
  const { tabs, active } = sanitizeLayout(layout);
  const kept = [];
  const skipped = [];
  let newActive = null;
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    if (tab.sessionFile !== null && !isFile(tab.sessionFile)) tab.sessionFile = null;
    if (tab.path !== "" && !isDirectory(tab.path)) {
      skipped.push(tab.path);
      continue;
    }
    if (tab.path === "" && tab.sessionFile === null) continue;
    if (active === i) newActive = kept.length;
    kept.push(tab);
  }
  return { tabs: kept, active: newActive, skipped };
}

/**
 * `open_tabs_load` — the saved layout, minus unrestorable tabs
 * (`{ tabs, active, skipped }`).
 */
function openTabsLoad() {
  return restorable(readLayoutOrEmpty());
}

/**
 * `open_tabs_save` — replace the saved layout with `layout`.
 *
 * Written as is (the load path sanitises it on the way back), with every
 * field the Rust struct serialises, in the same order.
 */
function openTabsSave(layout) {
  if (!isPlainObject(layout)) throw new Error("layout must be an object");
  const raw = layout;
  const tabs = raw.tabs === undefined ? [] : requireArray(raw.tabs, "layout.tabs");
  const serialized = tabs.map((tab, i) => {
    if (!isPlainObject(tab)) throw new Error(`layout.tabs[${i}] must be an object`);
    const where = `layout.tabs[${i}]`;
    return {
      path: tab.path === undefined ? "" : requireString(tab.path, `${where}.path`),
      profile: optionalString(tab.profile, `${where}.profile`),
      sessionFile: optionalString(tab.sessionFile, `${where}.sessionFile`),
      name: optionalString(tab.name, `${where}.name`),
    };
  });
  const active =
    raw.active === undefined || raw.active === null ? null : requireUnsigned(raw.active, "layout.active");
  writeAtomic(configPath("open-tabs.json"), pretty({ tabs: serialized, active }));
  return null;
}

// ── recent_projects.rs ──────────────────────────────────────────────────────

/** Entries kept per profile; older ones are dropped on the next touch. */
const MAX_PER_PROFILE = 20;

function parseRecentFile(bytes) {
  const raw = parseObject(bytes, "recent-projects.json");
  const entries = raw.entries === undefined ? [] : requireArray(raw.entries, "entries");
  const parsed = entries.map((entry, i) => {
    if (!isPlainObject(entry)) throw new Error(`entries[${i}] must be an object`);
    const where = `entries[${i}]`;
    return {
      path: requireString(entry.path, `${where}.path`),
      profile: requireString(entry.profile, `${where}.profile`),
      openedAt: requireUnsigned(entry.openedAt, `${where}.openedAt`),
    };
  });
  return { entries: parsed };
}

/** Missing or unreadable ⇒ empty; the next write replaces the bad file. */
function readRecentFile() {
  const file = configPath("recent-projects.json");
  try {
    const bytes = readRaw(file);
    return bytes === null ? { entries: [] } : parseRecentFile(bytes);
  } catch (err) {
    logError(`${file} unreadable, reading as empty: ${err.message}`);
    return { entries: [] };
  }
}

/** `profile`'s entries in file order, skipping folders that no longer exist. */
function entriesFor(file, profile) {
  return file.entries
    .filter((entry) => entry.profile === profile && isDirectory(entry.path))
    .map((entry) => ({ path: entry.path, openedAt: entry.openedAt }));
}

/** Move `(profile, path)` to the front, then trim `profile` to the cap. */
function upsertRecent(file, profile, projectPath, openedAt) {
  file.entries = file.entries.filter(
    (entry) => !(entry.profile === profile && entry.path === projectPath),
  );
  file.entries.unshift({ path: projectPath, profile, openedAt });
  let kept = 0;
  file.entries = file.entries.filter((entry) => {
    if (entry.profile !== profile) return true;
    kept += 1;
    return kept <= MAX_PER_PROFILE;
  });
}

/**
 * Canonical absolute folder, like `external_open::canonical_folder`: a missing
 * path or a file is refused rather than recorded.
 */
function canonicalFolder(input) {
  const given = typeof input === "string" ? input : String(input);
  let canonical;
  try {
    canonical = fs.realpathSync(given);
  } catch (err) {
    throw new Error(`cannot resolve '${given}': ${err.message}`);
  }
  if (!isDirectory(canonical)) throw new Error(`not a directory: '${canonical}'`);
  return stripVerbatim(canonical);
}

/** Undo Windows' `\\?\` prefix, as the Rust port does unconditionally. */
function stripVerbatim(target) {
  if (target.startsWith("\\\\?\\UNC\\")) return `\\\\${target.slice(8)}`;
  if (target.startsWith("\\\\?\\") && /^[A-Za-z]:/.test(target.slice(4))) return target.slice(4);
  return target;
}

/** `recent_projects_list` — `profile`'s recent folders, newest first. */
function recentsList(profile) {
  return entriesFor(readRecentFile(), recentsKey(profile));
}

/**
 * `recent_projects_touch` — canonicalise `projectPath`, record it as opened
 * now under `profile`, and return that profile's updated list.
 */
function recentsTouch(profile, projectPath) {
  const key = recentsKey(profile);
  const canonical = canonicalFolder(projectPath);
  const file = readRecentFile();
  upsertRecent(file, key, canonical, nowMs());
  writeAtomic(configPath("recent-projects.json"), pretty({ entries: file.entries }));
  return entriesFor(file, key);
}

/**
 * The key recents are stored under: the built-in profile (`null`, `""`,
 * `"default"`) is `"default"`; an unlisted id is an error.
 */
function recentsKey(profile) {
  return resolveProfile(profile) ?? DEFAULT_PROFILE_ID;
}

// ── approval_mode.rs ────────────────────────────────────────────────────────

/** omp's `--approval-mode` values (kebab-case on the wire and on disk). */
const APPROVAL_MODES = new Set(["always-ask", "write", "yolo"]);

/** One loaded `approval-mode.json`, keyed by its absolute path. */
const approvalCaches = new Map();

/** `ProfileStore`-style load-once cache; `set*` replaces the entry. */
function defaultApprovalFile() {
  return { version: 1, default: "write", projects: {} };
}

function approvalFilePath() {
  return configPath("approval-mode.json");
}

function parseApprovalMode(value) {
  if (typeof value !== "string" || !APPROVAL_MODES.has(value)) {
    throw new Error(
      `unknown approval mode ${JSON.stringify(value)} (expected always-ask, write or yolo)`,
    );
  }
  return value;
}

/**
 * `ApprovalModeFile`, including its container-level `#[serde(default)]`: a
 * missing field takes the value from the struct's `Default` (so `version` is
 * 1, not `u32`'s 0). Unknown keys are dropped on the next write.
 */
function parseApprovalFile(bytes) {
  const raw = parseObject(bytes, "approval-mode.json");
  const version =
    raw.version === undefined ? 1 : requireUnsigned(raw.version, "version");
  if (version > 0xffffffff) throw new Error("version must fit in a u32");
  const mode = raw.default === undefined ? "write" : parseApprovalMode(raw.default);
  const projects = {};
  if (raw.projects !== undefined) {
    if (!isPlainObject(raw.projects)) throw new Error("projects must be an object");
    for (const [key, value] of Object.entries(raw.projects)) {
      projects[key] = parseApprovalMode(value);
    }
  }
  return { version, default: mode, projects };
}

/** `read_strict`: missing ⇒ defaults; unreadable or malformed ⇒ throw. */
function readApprovalFile(file) {
  const bytes = readRaw(file);
  return bytes === null ? defaultApprovalFile() : parseApprovalFile(bytes);
}

/** Load once, like `ApprovalModeStore::load`; a bad file reads as defaults. */
function approvalEntry(file) {
  const cached = approvalCaches.get(file);
  if (cached !== undefined) return cached;
  const entry = { file: defaultApprovalFile() };
  approvalCaches.set(file, entry);
  try {
    entry.file = readApprovalFile(file);
  } catch (err) {
    logError(`${file} unreadable, using the default approval mode: ${err.message}`);
  }
  return entry;
}

/** `BTreeMap` order: UTF-8 byte order, not JS's UTF-16 code-unit order. */
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedProjects(projects) {
  const out = {};
  for (const key of Object.keys(projects).sort(byteCompare)) out[key] = projects[key];
  return out;
}

/** `ApprovalModeView`: `{ default, projects }`, camelCase-free and sorted. */
function approvalView(file) {
  return { default: file.default, projects: sortedProjects(file.projects) };
}

/**
 * `json_store::update_strict`: re-read the file, let `modify` edit it, write
 * atomically only when `modify` reports a change, and never replace a file
 * that cannot be read.
 */
function updateApproval(file, modify) {
  let data;
  try {
    data = readApprovalFile(file);
  } catch (err) {
    throw new Error(`${file} is unreadable: ${err.message}`);
  }
  if (modify(data)) {
    const serialized = {
      version: data.version,
      default: data.default,
      projects: sortedProjects(data.projects),
    };
    writeAtomic(file, pretty(serialized));
  }
  approvalCaches.set(file, { file: data });
  return approvalView(data);
}

/** `approval_mode_get` — the stored default and per-project overrides. */
function approvalModeGet() {
  return approvalView(approvalEntry(approvalFilePath()).file);
}

/** `approval_mode_set_default` — the mode every override-less project uses. */
function approvalModeSetDefault(mode) {
  const parsed = parseApprovalMode(mode);
  return updateApproval(approvalFilePath(), (data) => {
    const changed = data.default !== parsed;
    data.default = parsed;
    return changed;
  });
}

/**
 * `approval_mode_set_project` — store `projectRoot`'s override, or remove it
 * (`null`: the project follows the default). `projectRoot` must be absolute.
 */
function approvalModeSetProject(projectRoot, mode) {
  // The Rust command parses the mode before the store checks the path.
  const parsed = mode === null || mode === undefined ? null : parseApprovalMode(mode);
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error(
      `project folder must be an absolute path: ${JSON.stringify(String(projectRoot ?? ""))}`,
    );
  }
  const key = projectKey(projectRoot);
  return updateApproval(approvalFilePath(), (data) => {
    if (parsed === null) {
      if (!Object.prototype.hasOwnProperty.call(data.projects, key)) return false;
      delete data.projects[key];
      return true;
    }
    const changed = data.projects[key] !== parsed;
    data.projects[key] = parsed;
    return changed;
  });
}

/** Canonical folder when it resolves, the raw path otherwise (gone folder). */
function projectKey(projectRoot) {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
}

/** Drop every in-memory store cache (tests, and a config-dir switch). */
function resetCaches() {
  approvalCaches.clear();
}

// ── profiles.rs ─────────────────────────────────────────────────────────────

/** Reserved id of the built-in profile: omp's own `~/.omp/agent` tree. */
const DEFAULT_PROFILE_ID = "default";
const MAX_PROFILES = 64;
const MAX_ID_LEN = 48;
const MAX_NAME_LEN = 48;
/** Pause before the one retry of an unreadable `profiles.json`. */
const RETRY_DELAY_MS = 100;

/** Empty is "unspecified", which means the built-in profile. */
function isDefaultProfile(id) {
  return id === "" || id === DEFAULT_PROFILE_ID;
}

/**
 * Reject ids that could escape the profile directory or be re-tokenised as an
 * omp flag: leading ASCII lowercase alphanumeric, then `[a-z0-9._-]`, at most
 * 48 bytes, no trailing dot, no Windows reserved device stem.
 */
function validateId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) return false;
  const stem = id.split(".")[0];
  const reserved =
    stem === "con" ||
    stem === "prn" ||
    stem === "aux" ||
    stem === "nul" ||
    /^(com|lpt)[0-9]$/.test(stem);
  if (reserved || id.endsWith(".")) return false;
  if (!/[a-z0-9]/.test(id[0])) return false;
  return /^[a-z0-9._-]+$/.test(id);
}

/** Trim and bound a display name; `null` when it must be dropped. */
function sanitizeName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return null;
  return Array.from(trimmed).slice(0, MAX_NAME_LEN).join("");
}

function builtinProfile() {
  return { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_ID };
}

/** Built-in first (keeping its persisted name), junk dropped, capped. */
function normalizeProfiles(profiles) {
  const out = [builtinProfile()];
  for (const profile of profiles) {
    if (profile.id === DEFAULT_PROFILE_ID) {
      const name = sanitizeName(profile.name);
      if (name !== null) out[0].name = name;
      continue;
    }
    if (!validateId(profile.id) || out.some((entry) => entry.id === profile.id)) continue;
    const name = sanitizeName(profile.name);
    if (name === null) continue;
    out.push({ id: profile.id, name });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

/** `None` means built-in, and so does a pointer that no longer resolves. */
function normalizeStartup(startup, profiles) {
  if (startup === null || startup === undefined) return null;
  if (isDefaultProfile(startup)) return null;
  return profiles.some((profile) => profile.id === startup) ? startup : null;
}

function parseProfilesFile(bytes) {
  const raw = parseObject(bytes, "profiles.json");
  const profiles = raw.profiles === undefined ? [] : requireArray(raw.profiles, "profiles");
  const parsed = profiles.map((profile, i) => {
    if (!isPlainObject(profile)) throw new Error(`profiles[${i}] must be an object`);
    return {
      id: requireString(profile.id, `profiles[${i}].id`),
      name: requireString(profile.name, `profiles[${i}].name`),
    };
  });
  const startup = raw.startup === undefined || raw.startup === null
    ? null
    : requireString(raw.startup, "startup");
  return { profiles: parsed, startup };
}

/** Snapshot files whose content still hashes to their name, newest first. */
function restoreLatestSnapshot(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const dot = id.lastIndexOf(".");
    if (dot > 0 && id.slice(dot + 1).toLowerCase() === "meta") continue;
    const full = path.join(dir, name);
    const stat = statOrNull(full);
    if (stat === null || !stat.isFile()) continue;
    entries.push({ id, full, modified: stat.mtimeMs });
  }
  entries.sort((a, b) => b.modified - a.modified);
  for (const entry of entries) {
    let bytes;
    try {
      bytes = fs.readFileSync(entry.full);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest === entry.id) return bytes;
    // Quarantine rather than delete, like `SnapshotRing::restore_latest`.
    try {
      fs.renameSync(entry.full, path.join(dir, `${entry.id}.corrupt`));
    } catch {
      // Best-effort.
    }
  }
  return null;
}

/**
 * `read_or_recover`: missing ⇒ empty; unreadable ⇒ throw; corrupt ⇒ the
 * newest valid snapshot, else empty (and the corrupt primary is left in place
 * — this milestone never writes a replacement over it).
 */
function readProfilesAt(file, snapshots) {
  let bytes;
  try {
    bytes = readRaw(file);
  } catch (err) {
    throw new Error(`read profiles: ${err.message}`);
  }
  if (bytes === null) return { profiles: [], startup: null };
  try {
    return parseProfilesFile(bytes);
  } catch {
    // Corrupt: consult the ring.
  }
  let recovered;
  try {
    recovered = restoreLatestSnapshot(snapshots);
  } catch (err) {
    throw new Error(`read profile snapshots: ${err.message}`);
  }
  if (recovered === null) return { profiles: [], startup: null };
  try {
    return parseProfilesFile(recovered);
  } catch {
    return { profiles: [], startup: null };
  }
}

/** One delayed retry for an *unreadable* primary (corruption is immediate). */
function loadProfilesFile() {
  const file = configPath("profiles.json");
  const snapshots = withExtension(file, "snapshots");
  try {
    return readProfilesAt(file, snapshots);
  } catch (first) {
    logError(`${first.message}, retrying`);
    sleepSync(RETRY_DELAY_MS);
    try {
      return readProfilesAt(file, snapshots);
    } catch (retry) {
      logError(`${retry.message}, starting with the built-in profile only`);
      throw retry;
    }
  }
}

/**
 * `list_profiles` — `{ profiles, startupId, degraded }`, built-in first.
 *
 * `degraded` carries the load error when this run could only offer the
 * built-in profile because `profiles.json` was unreadable twice.
 */
function profilesList() {
  let file = { profiles: [], startup: null };
  let degraded = null;
  try {
    file = loadProfilesFile();
  } catch (err) {
    degraded = err.message;
  }
  const profiles = normalizeProfiles(file.profiles);
  const startupId = normalizeStartup(file.startup, profiles) ?? DEFAULT_PROFILE_ID;
  return { profiles, startupId, degraded };
}

/**
 * `ProfileStore::resolve`: `null`/`""`/`"default"` ⇒ `null` (the built-in
 * profile, spawned without `--profile`); anything else must be a persisted
 * profile, so a tab can neither invent a directory nor smuggle a flag into
 * omp's argv. Throws otherwise.
 */
function resolveProfile(profile) {
  if (profile === null || profile === undefined) return null;
  if (typeof profile !== "string") {
    throw new Error(`unknown profile: ${JSON.stringify(profile)}`);
  }
  if (isDefaultProfile(profile)) return null;
  const { profiles } = profilesList();
  if (profiles.some((entry) => entry.id === profile)) return profile;
  throw new Error(`unknown profile: ${JSON.stringify(profile)}`);
}

/**
 * `profiles::agent_dir_for`: the built-in profile is `~/.omp/agent` (honouring
 * `PI_CODING_AGENT_DIR`), a named profile `~/.omp/profiles/<id>/agent`.
 * Callers resolve the id first.
 */
function agentDirFor(profile) {
  const id = typeof profile === "string" && profile !== "" ? profile : null;
  if (id === null) {
    const env = process.env.PI_CODING_AGENT_DIR;
    if (env) return env;
  }
  const omp = path.join(os.homedir(), ".omp");
  return id === null ? path.join(omp, "agent") : path.join(omp, "profiles", id, "agent");
}

module.exports = {
  // The IPC surface, one function per Rust command.
  openTabsLoad,
  openTabsSave,
  recentsList,
  recentsTouch,
  approvalModeGet,
  approvalModeSetDefault,
  approvalModeSetProject,
  profilesList,
  // Shared plumbing the dispatch layer and later slices need.
  configHome,
  resetCaches,
  resolveProfile,
  agentDirFor,
  DEFAULT_PROFILE_ID,
  APPROVAL_MODES,
  MAX_TABS,
  MAX_PER_PROFILE,
};