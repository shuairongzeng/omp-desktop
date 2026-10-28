'use strict';

/* Profils mutations: the writing half of the per-tab omp profile registry.
 *
 * Port of `src-tauri/src/profiles.rs` (`ProfileStore::create` / `rename` /
 * `remove` / `set_startup`, `seed_bootstrap`, `clear_bootstrap`, `validate_id`,
 * `sanitize_name`, `slugify`, `unique_id`, `read_or_recover`) and of the
 * `create_profile` / `rename_profile` / `delete_profile` /
 * `set_startup_profile` / `clear_profile_bootstrap` Tauri commands in
 * `src-tauri/src/lib.rs`.
 *
 * The read side (`list_profiles`, `resolve`, `agent_dir_for`) lives in
 * `stores.js` and is reused from there; this module only adds the
 * `profiles.json` writer, the snapshot ring that guards it, and the advisory
 * lock the Rust mutation path takes. `profiles.rs` and its `json_store`
 * helpers are mirrored on disk:
 *
 *   <app config>/profiles.json            the list + startup pointer
 *   <app config>/profiles.lock            advisory lock around a mutation
 *   <app config>/profiles.snapshots/      content-addressed past versions
 *
 * Every function is synchronous, like `stores.js`.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const stores = require("./stores.js");

const DEFAULT_PROFILE_ID = stores.DEFAULT_PROFILE_ID;
/** Max length of a generated profile id (also the directory name). */
const MAX_ID_LEN = 48;
/** Max length of a display name, after trimming. */
const MAX_NAME_LEN = 48;
/** Upper bound on stored profiles. */
const MAX_PROFILES = 64;
/** Past versions of `profiles.json` kept by the snapshot ring. */
const SNAPSHOT_RETAIN = 8;
/** `json_store::STORE_LOCK_STALE_AFTER`. */
const STORE_LOCK_STALE_AFTER_MS = 5000;
/** Takeover attempts against an apparently-stale lock. */
const LOCK_TAKEOVER_ATTEMPTS = 10;
/** Delay between takeover attempts. */
const LOCK_TAKEOVER_DELAY_MS = 25;

/**
 * The bootstrap `models.yml` seeded into a freshly created profile: the
 * minimal file that lets omp's non-interactive RPC mode boot before the
 * profile has any credentials, so its first tab can reach `/login`. Verbatim
 * from `profiles::BOOTSTRAP_MODELS_YML` (including the comment prose, which
 * `clearBootstrap` deliberately ignores when it compares).
 */
const BOOTSTRAP_MODELS_YML = `# Written by OMP Desktop when this profile was created.
#
# omp's RPC mode (which the desktop uses) exits at startup unless at least
# one model resolves, and a new profile has no credentials yet — so without
# this the desktop could not even run /login for it. Marking one provider
# keyless makes its bundled models resolve so omp boots; it grants no
# access and never overrides real credentials.
#
# Removed automatically after a successful login. Safe to delete by hand.
providers:
  anthropic:
    auth: none
`;

// ── small plumbing ──────────────────────────────────────────────────────────

/** Rust's `eprintln!("[omp-desktop] …")` trace: stderr, never fatal. */
function logError(message) {
  process.stderr.write(`[omp-desktop] ${message}\n`);
}

/** Block this thread (lock retry only — `Atomics.wait` is a real sleep). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `profiles.json` and its siblings, each derived from the primary. */
function files() {
  const primary = path.join(stores.configHome(), "profiles.json");
  return {
    path: primary,
    snapshots: withExtension(primary, "snapshots"),
    lock: withExtension(primary, "lock"),
  };
}

// ── json_store::write_atomic ────────────────────────────────────────────────

/** Monotonic suffix so two writes in one millisecond land on different temps. */
let tempCounter = 0;

/** Destinations already swept for orphan temp files by this process. */
const sweptDestinations = new Set();

function sweepOrphanTempFiles(dir, baseName) {
  const prefix = `${baseName}.`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    if (path.extname(name).toLowerCase() !== '.tmp') continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Best-effort, like the Rust sweep.
    }
  }
}

/**
 * `json_store::write_atomic`: unique temp file in the same directory, fsync,
 * rename over the target — a crash mid-write never leaves a partial primary.
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

  const temp = path.join(dir, `${base}.${process.pid}-${tempCounter++}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
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

// ── profiles.rs: ids and names ──────────────────────────────────────────────

/** `true` when `id` denotes the built-in profile. */
function isDefault(id) {
  return id === '' || id === DEFAULT_PROFILE_ID;
}

function isLowerAlnum(byte) {
  return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39);
}

/**
 * `profiles::validate_id`: an id must start with an ASCII lowercase
 * alphanumeric (which also rules out `.`/`..` and `-flag`) and contain only
 * those plus `-`, `_`, `.`; at most 48 bytes, no trailing dot, no Windows
 * reserved device stem. Throws Rust's message otherwise.
 */
function validateId(id) {
  if (isValidId(id)) return id;
  throw new Error(`invalid profile id: ${JSON.stringify(id)}`);
}

function isValidId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const bytes = Buffer.from(id, 'utf8');
  if (bytes.length > MAX_ID_LEN) return false;
  // The device is matched on the portion *before the first dot*: Win32
  // resolves `nul.bak` to the NUL device too.
  const stem = id.split('.')[0];
  const reserved =
    stem === 'con' ||
    stem === 'prn' ||
    stem === 'aux' ||
    stem === 'nul' ||
    (stem.length === 4 && (stem.startsWith('com') || stem.startsWith('lpt')) && /^[0-9]$/.test(stem[3]));
  // Win32 strips trailing dots, so `work.` would fold onto `work`.
  if (reserved || id.endsWith('.')) return false;
  if (!isLowerAlnum(bytes[0])) return false;
  return bytes.every((byte) => isLowerAlnum(byte) || byte === 0x2d || byte === 0x5f || byte === 0x2e);
}

/**
 * `profiles::sanitize_name`: trim, then bound to 48 code points. Throws
 * Rust's messages for a blank name or one containing control characters.
 */
function sanitizeName(name) {
  if (typeof name !== 'string') {
    throw new Error('profile name must not be empty');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('profile name must not be empty');
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error('profile name must not contain control characters');
  }
  return Array.from(trimmed).slice(0, MAX_NAME_LEN).join('');
}

/**
 * `profiles::slugify`: ASCII-lowercased, every run of unsupported characters
 * collapsed to a single `-`, trimmed of leading/trailing separators, bounded
 * by 48 bytes, `"profile"` when nothing usable survives.
 */
function slugify(name) {
  let out = '';
  let pendingSep = false;
  for (const ch of name) {
    if (out.length >= MAX_ID_LEN) break;
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '.')) {
      pendingSep = true;
      continue;
    }
    if (pendingSep && out.length > 0) out += '-';
    pendingSep = false;
    out += ch.toLowerCase();
  }
  // A pushed separator can land exactly on the cap; the trim below drops it.
  out = out.slice(0, MAX_ID_LEN);
  const trimmed = out.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  return trimmed.length === 0 ? 'profile' : trimmed;
}

/**
 * `profiles::unique_id`: suffix `-2`, `-3`, … until free. `"default"` is
 * always taken so a user-created profile can never claim the built-in id.
 * Returns `null` only when every candidate is taken.
 */
function uniqueId(base, taken) {
  const isFree = (candidate) =>
    candidate !== DEFAULT_PROFILE_ID &&
    isValidId(candidate) &&
    !taken.some((profile) => profile.id === candidate);
  if (isFree(base)) return base;
  // Suffix the portion before the first dot: a base whose stem is a Windows
  // device (`nul.bak`) keeps failing `validate_id` on every `nul.bak-<n>`.
  const root = base.split('.')[0];
  for (let n = 2; n <= MAX_PROFILES + 1; n += 1) {
    const suffix = `-${n}`;
    // Keep room for the `-<n>` suffix within MAX_ID_LEN.
    const limit = MAX_ID_LEN - suffix.length;
    const stem = root.length >= limit ? root.slice(0, limit) : root;
    const candidate = `${stem}${suffix}`;
    if (isFree(candidate)) return candidate;
  }
  return null;
}

// ── profiles.rs: normalise + parse ──────────────────────────────────────────

function builtinProfile() {
  return { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_ID };
}

/**
 * `profiles::normalize`: built-in first (keeping its persisted label), junk
 * dropped, duplicates dropped, capped at 64. Mirrors `stores.js`'s private
 * copy (that module exposes only the command-facing reads).
 */
function normalizeProfiles(profiles) {
  const out = [builtinProfile()];
  for (const profile of profiles) {
    if (profile.id === DEFAULT_PROFILE_ID) {
      const name = typeof profile.name === 'string' ? sanitizeNameOrNull(profile.name) : null;
      if (name !== null) out[0].name = name;
      continue;
    }
    if (!isValidId(profile.id) || out.some((entry) => entry.id === profile.id)) continue;
    const name = sanitizeNameOrNull(profile.name);
    if (name === null) continue;
    out.push({ id: profile.id, name });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

/** `sanitizeName` without the throw: `null` when the name must be dropped. */
function sanitizeNameOrNull(name) {
  try {
    return sanitizeName(name);
  } catch {
    return null;
  }
}

/** `None` means built-in, and so does a pointer that no longer resolves. */
function normalizeStartup(startup, profiles) {
  if (startup === null || startup === undefined) return null;
  if (isDefault(startup)) return null;
  return profiles.some((profile) => profile.id === startup) ? startup : null;
}

function normalizeFile(file) {
  const profiles = normalizeProfiles(file.profiles);
  return { profiles, startup: normalizeStartup(file.startup, profiles) };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The on-disk shape: `{ profiles: [{id, name}], startup?: "<id>" }`
 * (`Profile` / `ProfilesFile`). Unknown keys are ignored, `profiles` defaults
 * to absent-means-empty, `startup: null` is the absent pointer.
 */
function parseProfilesFile(bytes) {
  const raw = JSON.parse(UTF8.decode(bytes));
  if (!isPlainObject(raw)) throw new Error('profiles.json: expected a JSON object');
  const list = raw.profiles === undefined ? [] : raw.profiles;
  if (!Array.isArray(list)) throw new Error('profiles.json: profiles must be an array');
  const profiles = list.map((profile, i) => {
    if (!isPlainObject(profile)) throw new Error(`profiles[${i}]: expected an object`);
    if (typeof profile.id !== 'string') throw new Error(`profiles[${i}].id: expected a string`);
    if (typeof profile.name !== 'string') throw new Error(`profiles[${i}].name: expected a string`);
    return { id: profile.id, name: profile.name };
  });
  let startup = null;
  if (raw.startup !== undefined && raw.startup !== null) {
    if (typeof raw.startup !== 'string') throw new Error('profiles.json: startup must be a string');
    startup = raw.startup;
  }
  return { profiles, startup };
}

/** `ProfilesFile::default()`. */
function emptyProfilesFile() {
  return { profiles: [], startup: null };
}

/** Serialise exactly like serde: `startup` omitted when `None`. */
function serializeProfilesFile(file) {
  const value = { profiles: file.profiles };
  if (file.startup !== null && file.startup !== undefined) value.startup = file.startup;
  return pretty(value);
}

// ── json_store::SnapshotRing ────────────────────────────────────────────────

/** Snapshot files (`<sha256>.json`) with their mtimes, newest first. */
function listSnapshots(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    // Sidecars are `<id>.meta.json`; stripping `.json` would yield `<id>.meta`.
    const dot = id.lastIndexOf('.');
    if (dot > 0 && id.slice(dot + 1).toLowerCase() === 'meta') continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    entries.push({ id, full, modified: stat.mtimeMs });
  }
  entries.sort((a, b) => b.modified - a.modified);
  return entries;
}

/** `SnapshotRing::snapshot`: write the content-addressed copy, then prune. */
function writeSnapshot(dir, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.createHash('sha256').update(bytes).digest('hex');
  writeAtomic(path.join(dir, `${id}.json`), bytes);
  const entries = listSnapshots(dir);
  for (const stale of entries.slice(SNAPSHOT_RETAIN)) {
    try {
      fs.unlinkSync(stale.full);
    } catch {
      // Best-effort pruning.
    }
    try {
      fs.unlinkSync(path.join(dir, `${stale.id}.meta.json`));
    } catch {
      // Legacy sidecar, usually absent.
    }
  }
  return id;
}

/**
 * `SnapshotRing::restore_latest`: newest snapshot whose content still hashes
 * to its filename; a mismatching one is quarantined as `<id>.corrupt`.
 */
function restoreLatestSnapshot(dir) {
  for (const entry of listSnapshots(dir)) {
    let bytes;
    try {
      bytes = fs.readFileSync(entry.full);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') === entry.id) return bytes;
    try {
      fs.renameSync(entry.full, path.join(dir, `${entry.id}.corrupt`));
    } catch {
      // Best-effort quarantine.
    }
  }
  return null;
}

// ── json_store::with_lock_str ───────────────────────────────────────────────

/** Per-process counter so same-second acquisitions get distinct tokens. */
let lockNonce = 0;

/** `{pid}:{unix_timestamp}:{nonce}` — the nonce plays no part in staleness. */
function lockContents() {
  const createdAt = Math.max(0, Math.trunc(Date.now() / 1000));
  return `${process.pid}:${createdAt}:${lockNonce++}`;
}

/** `pid:timestamp[:nonce]`; `null` when shaped differently (treated stale). */
function parseLockContents(contents) {
  const parts = contents.trim().split(':');
  if (parts.length < 2) return null;
  if (!/^[0-9]+$/.test(parts[0]) || !/^[0-9]+$/.test(parts[1])) return null;
  return { pid: Number(parts[0]), createdAt: Number(parts[1]) };
}

/** Whether `pid` is still alive; any inconclusive outcome counts as alive. */
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function lockIsStale(contents) {
  const parsed = parseLockContents(contents);
  if (parsed === null) return true;
  if (!pidIsAlive(parsed.pid)) return true;
  const now = Math.max(0, Math.trunc(Date.now() / 1000));
  return (now - parsed.createdAt) * 1000 >= STORE_LOCK_STALE_AFTER_MS;
}

/** Remove the lock file only when it still carries this acquisition's token. */
function releaseLock(lockPath, token) {
  let contents;
  try {
    contents = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return;
  }
  if (contents.trim() !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Best-effort.
  }
}

/**
 * `json_store::with_lock_str`: best-effort cross-process advisory lock with
 * stale-owner takeover, rendered as `String` errors. A live, non-stale
 * contender gets the UI-facing sentence Rust produces.
 */
function withLock(lockPath, run) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let attempts = 0;
  let token = null;
  while (token === null) {
    const candidate = lockContents();
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let contents = '';
      try {
        contents = fs.readFileSync(lockPath, 'utf8');
      } catch {
        // Unreadable lock: treat its contents as unknown (stale).
      }
      if (attempts >= LOCK_TAKEOVER_ATTEMPTS || !lockIsStale(contents)) {
        throw new Error('another window is updating this file; try again');
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else may have removed it first.
      }
      attempts += 1;
      sleepSync(LOCK_TAKEOVER_DELAY_MS);
      continue;
    }
    try {
      fs.writeSync(fd, candidate);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    token = candidate;
  }
  try {
    return run();
  } finally {
    releaseLock(lockPath, token);
  }
}

// ── profiles.rs: read_or_recover ────────────────────────────────────────────

/**
 * Read and parse the primary, distinguishing the three Rust outcomes:
 * missing ⇒ empty; unreadable ⇒ throw; present-but-corrupt ⇒ newest valid
 * snapshot (or empty) with `corrupt: true` so the mutation can quarantine the
 * bad bytes right before it replaces them.
 */
function readOrRecover(file, snapshots) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { file: emptyProfilesFile(), corrupt: false };
    }
    throw new Error(`read profiles: ${err.message}`);
  }
  try {
    return { file: parseProfilesFile(bytes), corrupt: false };
  } catch {
    // Corrupt: consult the ring. A ring *read* failure is not "no snapshot".
  }
  let recovered;
  try {
    recovered = restoreLatestSnapshot(snapshots);
  } catch (err) {
    throw new Error(`read profile snapshots: ${err.message}`);
  }
  if (recovered === null) return { file: emptyProfilesFile(), corrupt: true };
  try {
    return { file: parseProfilesFile(recovered), corrupt: true };
  } catch {
    return { file: emptyProfilesFile(), corrupt: true };
  }
}

/**
 * `ProfileStore::mutate`: re-read the file under the advisory lock (so two
 * app instances stay additive instead of last-writer-wins), let `edit` work
 * on the normalised value, re-validate the startup pointer, snapshot the new
 * bytes, quarantine a corrupt primary, and atomically replace the file.
 */
function mutate(edit) {
  const { path: file, snapshots, lock } = files();
  return withLock(lock, () => {
    const { file: loaded, corrupt } = readOrRecover(file, snapshots);
    const current = normalizeFile(loaded);
    const value = edit(current);
    // `edit` may have removed the profile the pointer named: a dangling
    // pointer must never reach disk.
    current.startup = normalizeStartup(current.startup, current.profiles);
    const text = serializeProfilesFile(current);
    // Snapshot the *incoming* bytes, like `SnapshotRing::snapshot`; the ring
    // is a recovery aid, so a failure here never fails the mutation.
    try {
      writeSnapshot(snapshots, Buffer.from(text, 'utf8'));
    } catch {
      // Best-effort.
    }
    if (corrupt) {
      // The ring snapshot above already holds a good copy; this is the last
      // moment the original corrupt bytes are recoverable for hand repair.
      try {
        fs.renameSync(file, withExtension(file, 'json.corrupt'));
      } catch {
        // A failed quarantine must not fail the mutation.
      }
    }
    try {
      writeAtomic(file, text);
    } catch (err) {
      throw new Error(`write profiles: ${err.message}`);
    }
    return value;
  });
}

// ── profiles.rs: bootstrap seed ─────────────────────────────────────────────

/** `bootstrap_path`: the named profile's `models.yml`. */
function bootstrapPath(id) {
  return path.join(stores.agentDirFor(id), 'models.yml');
}

/**
 * `profiles::seed_bootstrap`: create the agent directory and write the
 * placeholder `models.yml`, never clobbering an existing one (`wx` is the
 * atomic "create new" the Rust code uses).
 *
 * `id` must already be validated/resolved — this joins it into a path that is
 * written to.
 */
function seedBootstrap(id) {
  const file = bootstrapPath(id);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`create ${dir}: ${err.message}`);
  }
  let fd = null;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw new Error(`write ${file}: ${err.message}`);
  }
  try {
    fs.writeFileSync(fd, BOOTSTRAP_MODELS_YML);
  } catch (err) {
    throw new Error(`write ${file}: ${err.message}`);
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/**
 * `semantic_lines`: lines with pure-comment/blank lines dropped and trailing
 * whitespace trimmed, so the seed's comment prose may change across builds
 * without making an already-written seed unrecognisable.
 */
function semanticLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.trimStart().startsWith('#'));
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}

/**
 * `profiles::clear_bootstrap`: drop the seed once the profile has real
 * credentials. Silent no-op when the file is absent, unreadable,
 * semantically modified, or not UTF-8 — leaving a stale placeholder behind is
 * strictly better than deleting someone's model config.
 *
 * `id` must already be resolved (never the built-in profile).
 */
function clearBootstrap(id) {
  const file = bootstrapPath(id);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  let contents;
  try {
    contents = UTF8.decode(bytes);
  } catch {
    return null;
  }
  if (sameLines(semanticLines(contents), semanticLines(BOOTSTRAP_MODELS_YML))) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best-effort cleanup path.
    }
  }
  return null;
}

// ── lib.rs commands ─────────────────────────────────────────────────────────

/**
 * `create_profile`: create a profile labelled `name`, deriving its id with
 * `slugify` + `unique_id` (so a duplicate name becomes `-2`, exactly like
 * Rust), then seed its bootstrap `models.yml`.
 *
 * `explicitId` is a port extension for callers that already know the id (the
 * shipped frontend sends only `{ name }`): when given it is validated and an
 * already-listed id is refused instead of being uniquified. Passing the Tauri
 * args object itself (`createProfile({ id?, name })`) works too.
 */
function createProfile(name, explicitId = null) {
  if (isPlainObject(name)) {
    explicitId = name.id === undefined ? null : name.id;
    name = name.name;
  }
  const clean = sanitizeName(name);
  if (explicitId !== null && explicitId !== undefined) validateId(explicitId);
  const created = mutate((file) => {
    if (file.profiles.length >= MAX_PROFILES) {
      throw new Error(`profile limit reached (${MAX_PROFILES})`);
    }
    let id;
    if (explicitId !== null && explicitId !== undefined) {
      id = explicitId;
      if (file.profiles.some((profile) => profile.id === id)) {
        // Port-only guard: Rust never receives an explicit id and therefore
        // uniquifies instead of refusing. The quoted id matches the shape of
        // the module's other id errors (`invalid profile id: "…"`).
        throw new Error(`profile already exists: ${JSON.stringify(id)}`);
      }
    } else {
      id = uniqueId(slugify(clean), file.profiles);
      if (id === null) throw new Error('no free profile id');
    }
    const entry = { id, name: clean };
    file.profiles.push(entry);
    return entry;
  });
  // Best-effort, like lib.rs: the list entry is already committed, so a seed
  // failure only costs the in-app login path.
  try {
    seedBootstrap(created.id);
  } catch (err) {
    logError(`could not seed models.yml for '${created.id}': ${err.message}`);
  }
  return created;
}

/**
 * `rename_profile`: change only the display label; the id (and therefore
 * omp's data directory) is immutable. Passing blank/`"default"` renames the
 * built-in profile's label.
 */
function renameProfile(id, name) {
  const clean = sanitizeName(name);
  if (typeof id !== 'string') throw new Error(`unknown profile: ${JSON.stringify(id)}`);
  const wanted = isDefault(id) ? DEFAULT_PROFILE_ID : id;
  return mutate((file) => {
    const entry = file.profiles.find((profile) => profile.id === wanted);
    if (entry === undefined) throw new Error(`unknown profile: ${JSON.stringify(wanted)}`);
    entry.name = clean;
    return { id: entry.id, name: entry.name };
  });
}

/**
 * `delete_profile`: unlist the profile. Deliberately never touches
 * `~/.omp/profiles/<id>/` — that tree holds real credentials and session
 * history, so recreating the id re-adopts it. The built-in profile cannot be
 * removed.
 */
function deleteProfile(id) {
  if (typeof id !== 'string') throw new Error(`unknown profile: ${JSON.stringify(id)}`);
  if (isDefault(id)) throw new Error('the default profile cannot be deleted');
  mutate((file) => {
    const before = file.profiles.length;
    file.profiles = file.profiles.filter((profile) => profile.id !== id);
    if (file.profiles.length === before) throw new Error(`unknown profile: ${JSON.stringify(id)}`);
    return null;
  });
  return null;
}

/**
 * `set_startup_profile`: choose the profile new processes start in. Blank or
 * `"default"` selects the built-in one, stored as an absent pointer. The id
 * is re-checked against the freshly read list under the lock, so a profile
 * deleted by another instance can't leave a dangling pointer on disk.
 */
function setStartupProfile(id) {
  if (typeof id !== 'string') throw new Error(`unknown profile: ${JSON.stringify(id)}`);
  const next = isDefault(id) ? null : id;
  mutate((file) => {
    if (next !== null && !file.profiles.some((profile) => profile.id === next)) {
      throw new Error(`unknown profile: ${JSON.stringify(next)}`);
    }
    file.startup = next;
    return null;
  });
  return null;
}

/**
 * `clear_profile_bootstrap`: called after a successful login, drops the
 * placeholder seed if it is still ours. Resolved first, so a blank/default id
 * can't aim this at the built-in tree (which has no seed) and an unlisted id
 * can't reach the disk at all.
 */
function clearProfileBootstrap(id) {
  const resolved = stores.resolveProfile(id);
  if (resolved === null) return null;
  return clearBootstrap(resolved);
}

module.exports = {
  // The IPC surface, one function per Rust command.
  createProfile,
  renameProfile,
  deleteProfile,
  setStartupProfile,
  clearProfileBootstrap,
  // Shared pieces the dispatcher and later slices may need.
  seedBootstrap,
  clearBootstrap,
  validateId,
  sanitizeName,
  slugify,
  uniqueId,
  BOOTSTRAP_MODELS_YML,
  DEFAULT_PROFILE_ID,
  MAX_ID_LEN,
  MAX_NAME_LEN,
  MAX_PROFILES,
};