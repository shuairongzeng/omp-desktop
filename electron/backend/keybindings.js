'use strict';

/* Keybindings: omp's read-only config layer plus the desktop-private overlay.
 *
 * Port of src-tauri/src/keybindings/{mod,overlay,chord,yaml}.rs and the
 * `keybindings_list` / `keybindings_set` / `keybindings_reset` Tauri commands.
 *
 * Layer precedence (identical to Rust):
 *   overlay (desktop writes) > omp config (read-only) > registry default
 *
 * The overlay is `<app config folder>/keybindings.json`, JSON of the shape
 * `{ "bindings": { action: chord | [chords] } }`. It is the only file this
 * module ever writes. Without an existing app config folder the overlay lives
 * in memory for the process (mirroring Rust's ConfigFile memory variant) and
 * `overlayPath` is null — the folder is never created just to persist it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

// ── registry ──────────────────────────────────────────────────────────────────

// Must stay in sync with `ACTION_IDS` in
// src-tauri/src/keybindings/mod.rs and `KEYMAP_ACTIONS` in src/app/keymap.js.
// `overlaySet` rejects any other id, exactly like OverlayStore::set does.
const ACTION_IDS = [
  'app.interrupt',
  'app.thinking.cycle',
  'app.model.cycleForward',
  'app.model.cycleBackward',
  'app.model.select',
  'app.plan.toggle',
  'app.message.followUp',
  'app.session.new',
  'app.session.resume',
  'desktop.commands.open',
  'desktop.history.open',
  'desktop.shortcuts.open',
  'desktop.settings.open',
  'desktop.sidebar.toggle',
  'desktop.browser.toggle',
  'desktop.tab.new',
  'desktop.tab.close',
  'desktop.tab.next',
  'desktop.tab.prev',
  'desktop.tab.moveLeft',
  'desktop.tab.moveRight',
  'desktop.tab.jump',
  'desktop.tab.reopen',
  'desktop.working.next',
  'desktop.working.prev',
  'desktop.panel.todo',
  'desktop.panel.changes',
  'desktop.panel.rules',
  'desktop.panel.stats',
  'desktop.composer.promptHistory',
  'desktop.composer.focus',
  'desktop.session.compact',
  'desktop.session.export',
  'desktop.update.check',
  'desktop.chat.collapseAll',
  'desktop.chat.expandAll',
  'desktop.terminal.toggle',
  'desktop.rail.toggle',
];

// ── chord canonicaliser (chord.rs) ───────────────────────────────────────────

const MODIFIERS = ['ctrl+', 'shift+', 'alt+', 'super+'];

/**
 * Canonicalise a chord exactly like Rust's `chord::canonical_chord` and the
 * frontend's `canonicalChord`: modifiers in any order/case become the
 * canonical `ctrl, shift, alt, super` order, the base key is lowercased,
 * `esc` → `escape`, `return` → `enter`. Returns '' when there is no base key
 * (the callers treat that as invalid).
 */
function canonicalChord(raw) {
  let rest = String(raw).trim();
  const flags = [false, false, false, false];
  for (;;) {
    let matched = false;
    for (let i = 0; i < MODIFIERS.length; i += 1) {
      const prefix = MODIFIERS[i];
      if (rest.slice(0, prefix.length).toLowerCase() === prefix) {
        flags[i] = true;
        rest = rest.slice(prefix.length).trimStart();
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  const lower = rest.trim().toLowerCase();
  const base = lower === 'esc' ? 'escape' : lower === 'return' ? 'enter' : lower;
  if (base === '') return '';
  return MODIFIERS.filter((_, i) => flags[i]).join('') + base;
}

// ── paths ────────────────────────────────────────────────────────────────────

function homeDir() {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The per-user app config folder for this port, or null when there is none.
 *
 * Mirrors Rust `lib.rs::config_dir` in spirit: only an existing absolute
 * folder counts, so every store falls back to memory rather than writing to a
 * shared/temporary location. `OMP_PORT_CONFIG_DIR` is the test/app override.
 * An override pointing at a nonexistent folder means "no config folder", as
 * does an unset override on a platform whose default folder does not exist
 * (the folder is never created just to persist a store).
 */
function configHome() {
  const override = process.env.OMP_PORT_CONFIG_DIR;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) return null;
    return isDirectory(override) ? override : null;
  }
  let base;
  if (process.platform === 'darwin') {
    base = path.join(homeDir(), 'Library', 'Application Support');
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    base = appdata && path.isAbsolute(appdata)
      ? appdata
      : path.join(homeDir(), 'AppData', 'Roaming');
  } else {
    const xdg = process.env.XDG_CONFIG_HOME;
    base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir(), '.config');
  }
  const dir = path.join(base, 'dev.ohMyPi.desktop');
  return isDirectory(dir) ? dir : null;
}

function overlayPath() {
  const dir = configHome();
  return dir === null ? null : path.join(dir, 'keybindings.json');
}

/** omp's own agent dir for a resolved profile (None = built-in). */
function agentDir(home, profile) {
  const omp = path.join(home, '.omp');
  return profile === null || profile === undefined
    ? path.join(omp, 'agent')
    : path.join(omp, 'profiles', profile, 'agent');
}

/**
 * `PI_CODING_AGENT_DIR` is honoured for the built-in profile only, matching
 * the installed omp binary (`profiles.rs::agent_dir_for`). An empty value is
 * "unspecified", not a directory.
 */
function agentDirFor(home, profile, envDir) {
  if ((profile === null || profile === undefined) && envDir) {
    return envDir;
  }
  return agentDir(home, profile);
}

/** Probe yml → yaml → json, omp's own precedence order. */
function configPath(dir) {
  for (const name of ['keybindings.yml', 'keybindings.yaml', 'keybindings.json']) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

// ── reading omp's config ─────────────────────────────────────────────────────

// The subset of omp's pre-namespace action names that overlaps ACTION_IDS
// (`LEGACY_ACTION_NAMES` in mod.rs).
const LEGACY_ACTION_NAMES = {
  interrupt: 'app.interrupt',
  cycleThinkingLevel: 'app.thinking.cycle',
  cycleModelForward: 'app.model.cycleForward',
  cycleModelBackward: 'app.model.cycleBackward',
  selectModel: 'app.model.select',
  togglePlanMode: 'app.plan.toggle',
  followUp: 'app.message.followUp',
  newSession: 'app.session.new',
  resume: 'app.session.resume',
};

/**
 * Rewrite legacy keys to namespaced ids; a namespaced id always wins over its
 * legacy alias (the Rust reader's deterministic choice once file order is
 * lost in a sorted map).
 */
function migrateLegacyNames(raw) {
  const migrated = {};
  const pending = [];
  for (const [key, chords] of Object.entries(raw)) {
    const namespaced = LEGACY_ACTION_NAMES[key];
    if (namespaced) pending.push([namespaced, chords]);
    else migrated[key] = chords;
  }
  for (const [key, chords] of pending) {
    if (!Object.prototype.hasOwnProperty.call(migrated, key)) migrated[key] = chords;
  }
  return migrated;
}

function warn(message) {
  process.stderr.write(`[omp-desktop] keybindings: ${message}\n`);
}

/** YAML value → chord list, or null when the entry is absent/non-conforming. */
function yamlChords(value) {
  if (Array.isArray(value)) {
    const chords = [];
    for (const item of value) {
      if (item !== null && typeof item === 'object') return null;
      // The Rust flat reader yields every scalar verbatim, including the
      // literal words `null`/`true`/`1`; `String()` reproduces that.
      chords.push(item === null ? 'null' : String(item));
    }
    return chords;
  }
  if (value === null || value === undefined) return null; // YAML null = absent
  if (typeof value === 'object') return null; // nested map: unsupported
  return [String(value)];
}

/**
 * Parse omp's `keybindings.yml`/`.yaml` into `{ action: [chord] }`.
 *
 * The format is a flat map. js-yaml's `json: true` mode is used because it
 * permits duplicate keys with last-wins semantics, matching the Rust reader
 * and omp's own writer. A genuinely malformed document degrades to an empty
 * map (the Rust reader also never fails on content), keeping every other
 * store usable.
 */
function parseYamlConfig(content) {
  let doc;
  try {
    doc = yaml.load(content, { json: true });
  } catch (e) {
    warn(`ignoring malformed config: ${e.message}`);
    return {};
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    const chords = yamlChords(value);
    if (chords !== null) out[key] = chords;
  }
  return out;
}

/**
 * Parse omp's JSON keybindings file: `{ action: string | string[] }`.
 * Values that are not a string or an all-string array are skipped (matching
 * `toKeybindingsConfig`); malformed/non-object JSON degrades to empty.
 */
function parseJsonConfig(content, file) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    warn(`ignoring malformed config at ${file}`);
    return {};
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    warn(`ignoring malformed config at ${file}`);
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value === 'string') {
      out[key] = [value];
    } else if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === 'string')) continue;
      out[key] = value.slice();
    }
    // any other value type is dropped, like the Rust reader
  }
  return out;
}

/** Read one keybinding file; a missing file is an empty map, an IO error throws. */
function readFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw new Error(String(e && e.message ? e.message : e));
  }
  // A BOM would otherwise merge into the first key and drop that binding.
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const rawMap = path.extname(file) === '.json'
    ? parseJsonConfig(content, file)
    : parseYamlConfig(content);
  const migrated = migrateLegacyNames(rawMap);

  const out = {};
  for (const [action, chords] of Object.entries(migrated)) {
    out[action] = chords
      .map((chord) => canonicalChord(chord))
      .filter((chord) => chord !== '');
  }
  return out;
}

/** Probe `dir` and read its file in one step (configPath + readFile). */
function readLayer(dir) {
  const file = configPath(dir);
  return { path: file, bindings: file === null ? {} : readFile(file) };
}

function sortedMap(map) {
  const out = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

/**
 * Read omp's keybindings for a profile, applying omp's own merge: the
 * built-in profile's file first, then the named profile's file action by
 * action. The inherited base always lives under `~/.omp/agent`, never behind
 * `PI_CODING_AGENT_DIR` (see the Rust `read_omp` doc comment).
 */
function readOmp(profile) {
  const home = homeDir();
  const envDir = process.env.PI_CODING_AGENT_DIR || null;

  if (profile === null || profile === undefined) {
    const layer = readLayer(agentDirFor(home, null, envDir));
    return { bindings: layer.bindings, path: layer.path, inheritedPath: null };
  }

  const base = readLayer(agentDir(home, null));
  const named = readLayer(agentDirFor(home, profile, envDir));
  return {
    bindings: { ...base.bindings, ...named.bindings },
    path: named.path,
    inheritedPath: base.path,
  };
}

// ── overlay (overlay.rs) ─────────────────────────────────────────────────────

// The memory-only overlay for a process with no config folder. Rust keeps the
// bytes in a single OverlayStore created at startup; the Electron dispatcher
// keeps one module instance, so a module-level map is the equivalent.
let memoryOverlay = {};

function emptyOverlay() {
  return {};
}

/** Validate the documented `{ bindings: { … } }` on-disk shape. */
function parseOverlay(text, file) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(String(e && e.message ? e.message : e));
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`keybindings overlay at ${file} must be a JSON object`);
  }
  const raw = doc.bindings;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`keybindings overlay at ${file}: "bindings" must be an object`);
  }
  const out = {};
  for (const [action, chords] of Object.entries(raw)) {
    if (!Array.isArray(chords) || !chords.every((chord) => typeof chord === 'string')) {
      throw new Error(
        `keybindings overlay at ${file}: ${JSON.stringify(action)} must map to an array of strings`,
      );
    }
    out[action] = chords.slice();
  }
  return out;
}

/**
 * Read the overlay. Missing file/folder → empty; a malformed or unreadable
 * file throws (never silently replaced — that would discard every rebind).
 */
function readOverlay() {
  const file = overlayPath();
  if (file === null) return { bindings: { ...memoryOverlay }, path: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { bindings: emptyOverlay(), path: file };
    throw new Error(String(e && e.message ? e.message : e));
  }
  return { bindings: parseOverlay(text, file), path: file };
}

function tempPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`,
  );
}

/** temp file + rename, matching json_store::write_atomic. */
function writeAtomic(file, bytes) {
  const temp = tempPathFor(file);
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (e) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort
    }
    throw new Error(String(e && e.message ? e.message : e));
  }
}

function serialiseOverlay(bindings) {
  return JSON.stringify({ bindings: sortedMap(bindings) }, null, 2);
}

/**
 * Read-modify-write the overlay. `modify` mutates the map and returns whether
 * it changed; a no-op must not rewrite (or create) the file. A malformed
 * existing file is refused, never overwritten.
 */
function updateOverlay(modify) {
  const file = overlayPath();

  if (file === null) {
    const data = { ...memoryOverlay };
    if (modify(data)) memoryOverlay = data;
    return { bindings: data, path: null };
  }

  let data;
  try {
    data = readOverlay().bindings;
  } catch (e) {
    throw new Error(`${file} is unreadable: ${e.message}`);
  }
  if (modify(data)) writeAtomic(file, serialiseOverlay(data));
  return { bindings: data, path: file };
}

/** Canonicalise and de-duplicate (first-seen order) a set of chords. */
function canonicalKeys(keys) {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) {
    throw new Error('keys must be an array of strings');
  }
  const canonical = [];
  for (const key of keys) {
    const chord = canonicalChord(key);
    if (chord === '') throw new Error(`invalid chord: ${JSON.stringify(key)}`);
    if (!canonical.includes(chord)) canonical.push(chord);
  }
  return canonical;
}

function overlaySet(action, keys) {
  if (!ACTION_IDS.includes(action)) throw new Error('unknown action');
  // Validate before touching the file, exactly like OverlayStore::set.
  const canonical = canonicalKeys(keys);
  return updateOverlay((bindings) => {
    bindings[action] = canonical;
    return true;
  });
}

function overlayRemove(action) {
  return updateOverlay((bindings) => {
    if (!Object.prototype.hasOwnProperty.call(bindings, action)) return false;
    delete bindings[action];
    return true;
  });
}

// ── payload (mod.rs) ─────────────────────────────────────────────────────────

function assemblePayload(ompLayer, overlay, overlayError, file) {
  return {
    omp: sortedMap(ompLayer.bindings),
    overlay: sortedMap(overlay),
    overlayError,
    ompPath: ompLayer.path,
    inheritedPath: ompLayer.inheritedPath,
    overlayPath: file === null ? null : String(file),
  };
}

/** Normalise a profile id the way `ProfileStore::resolve` + `is_default` do. */
function resolveProfile(profile) {
  if (profile === null || profile === undefined) return null;
  const id = String(profile);
  return id === '' || id === 'default' ? null : id;
}

function payloadWithOverlay(profile, bindings, file) {
  return assemblePayload(readOmp(profile), bindings, null, file);
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * `keybindings_list`: the merged omp layer plus the overlay.
 *
 * A malformed/unreadable overlay does not fail the whole payload: `overlay`
 * is empty and `overlayError` carries the message, while the omp layer stays
 * usable (the frontend falls back to registry defaults).
 */
function keybindingsList(profile) {
  const resolved = resolveProfile(profile);
  const ompLayer = readOmp(resolved);
  let overlay = {};
  let overlayError = null;
  let file;
  try {
    const snapshot = readOverlay();
    overlay = snapshot.bindings;
    file = snapshot.path;
  } catch (e) {
    overlayError = e.message;
    file = overlayPath();
  }
  return assemblePayload(ompLayer, overlay, overlayError, file);
}

/**
 * `keybindings_set`: bind `action` to `keys` in the overlay and return the
 * updated payload. Throws `unknown action`, `invalid chord: …`, or a
 * `<path> is unreadable: …` error when the existing overlay is malformed.
 */
function keybindingsSet(profile, action, keys) {
  const resolved = resolveProfile(profile);
  const { bindings, path: file } = overlaySet(action, keys);
  return payloadWithOverlay(resolved, bindings, file);
}

/** `keybindings_reset`: remove `action` from the overlay (absent = no-op). */
function keybindingsReset(profile, action) {
  const resolved = resolveProfile(profile);
  const { bindings, path: file } = overlayRemove(action);
  return payloadWithOverlay(resolved, bindings, file);
}

module.exports = {
  ACTION_IDS,
  canonicalChord,
  keybindingsList,
  keybindingsSet,
  keybindingsReset,
};