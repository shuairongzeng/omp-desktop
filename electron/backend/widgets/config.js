/* electron/backend/widgets/config.js — Node port of
   `src-tauri/src/widgets/config.rs`.

   `<app config>/widgets.json` is the only source of plugin commands. A
   file-level problem (unreadable, not JSON, unknown version) is fatal (the
   junction to Rust's `Err`); a bad entry is skipped and reported in
   `errors`. Unknown keys and trigger names are reported there too (typo
   detection) without invalidating the entry.

   Entry shape (the Rust `PluginEntry`, camelCased for JS callers):

     { id, title, command, matchPath, matchRemote, triggers,
       timeoutMs, intervalMs, enabled, scope }

   `triggers` holds `activate` | `turn_end` | `branch` only (`manual` is
   always allowed, `interval` follows `intervalMs`). `scope` is `tab` or
   `global`. `loadConfig` returns `{ plugins, errors, fatal, configPath }`:
   `fatal` is the file-level error string or `null`. */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const stores = require('../stores.js');

// ── constants (`config.rs`) ─────────────────────────────────────────────────

const TIMEOUT_DEFAULT_MS = 10000;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 60000;
const INTERVAL_MIN_MS = 15000;
const INTERVAL_MAX_MS = 3600000;
/** Entries past this many in `widgets.json` are not validated; one error reports them. */
const MAX_PLUGINS = 32;
const SUPPORTED_VERSION = 1;
/**
 * The triggers a config may list; also the default when `triggers` is absent.
 * `manual` is always allowed and `interval` follows `intervalMs`.
 */
const CONFIG_TRIGGERS = ['activate', 'turn_end', 'branch'];
/** Every trigger a run can carry (`Trigger::as_str`), in Rust declaration order. */
const TRIGGERS = ['activate', 'turn_end', 'branch', 'manual', 'interval'];
const FILE_NAME = 'widgets.json';
/** Known keys of one entry / of `match`, after `rename_all = "camelCase"`. */
const ENTRY_KEYS = new Set([
  'id',
  'title',
  'command',
  'match',
  'triggers',
  'timeoutMs',
  'intervalMs',
  'enabled',
  'scope',
]);
const MATCH_KEYS = new Set(['path', 'remote']);
const FILE_KEYS = new Set(['version', 'plugins']);

// ── validation helpers ──────────────────────────────────────────────────────

/** `[a-z0-9-]{1,32}`: the plugin id grammar, also checked on ids over IPC. */
function idOk(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 32 &&
    /^[a-z0-9-]+$/.test(id)
  );
}

/** The user's home directory from `HOME` (`USERPROFILE` on Windows); null when unset or empty. */
function homeDir() {
  const name = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Replaces a leading `~/` in every argv element with `home` (Rust
 * `expand_home`). Only the exact `~/` prefix counts: `~user` and a bare `~`
 * stay untouched. Returns false when an element needs expanding but there is
 * no home directory.
 */
function expandHome(command, home) {
  for (let i = 0; i < command.length; i += 1) {
    const arg = command[i];
    if (arg.startsWith('~/')) {
      if (home === null || home === undefined) return false;
      command[i] = path.join(home, arg.slice(2));
    }
  }
  return true;
}

/**
 * Parses `triggers`; unknown names and `interval` become `warnings`, the
 * entry stays valid with the rest (Rust `parse_triggers`).
 */
function parseTriggers(list, id, warnings) {
  if (list === undefined || list === null) return CONFIG_TRIGGERS.slice();
  const out = [];
  for (const name of list) {
    if (!CONFIG_TRIGGERS.includes(name)) {
      if (name === 'manual') continue; // always allowed; listing it is harmless
      if (name === 'interval') {
        warnings.push(
          `plugin "${id}": "interval" is not a valid trigger; set "intervalMs" instead`,
        );
      } else {
        warnings.push(
          `plugin "${id}": unknown trigger "${name}" (expected activate, turn_end, branch or manual)`,
        );
      }
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const isSep = (code) => code === 0x2f || code === 0x5c; // `/` or `\`

/** Directory-prefix match on separator boundaries (Rust `path_matches`). */
function pathMatches(prefix, project) {
  const trimEnd = (s) => s.replace(/[/\\]+$/, '');
  const a = Buffer.from(trimEnd(prefix), 'utf8');
  const b = Buffer.from(trimEnd(project), 'utf8');
  if (a.length === 0) {
    // `prefix` was only separators: the root matches any absolute path.
    return prefix.length > 0 && project.length > 0 && isSep(Buffer.from(project, 'utf8')[0]);
  }
  if (b.length < a.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i] && !(isSep(a[i]) && isSep(b[i]))) return false;
  }
  return b.length === a.length || isSep(b[a.length]);
}

/**
 * Whether the plugin applies to a tab with this project path and remote
 * (`PluginEntry::matches`): `matchPath` is a directory prefix, `matchRemote`
 * a substring of the remote URL. Both must hold when given.
 */
function pluginMatches(entry, project, remote) {
  const pathOk =
    entry.matchPath === null ||
    entry.matchPath === undefined ||
    entry.matchPath === '' ||
    pathMatches(entry.matchPath, project);
  const remoteOk =
    entry.matchRemote === null ||
    entry.matchRemote === undefined ||
    remote.includes(entry.matchRemote);
  return pathOk && remoteOk;
}

/**
 * Whether `trigger` may start this plugin (`PluginEntry::wants`): `manual`
 * always, `interval` exactly when `intervalMs` is set, the rest per `triggers`.
 */
function pluginWants(entry, trigger) {
  if (trigger === 'manual') return true;
  if (trigger === 'interval') return entry.intervalMs !== null && entry.intervalMs !== undefined;
  return entry.triggers.includes(trigger);
}

// ── raw JSON → typed raw (serde's job in Rust) ──────────────────────────────

/** serde's `invalid type: …, expected …` wording for one value. */
function invalidType(value, expected) {
  if (value === null) return `invalid type: null, expected ${expected}`;
  if (Array.isArray(value)) return `invalid type: sequence, expected ${expected}`;
  switch (typeof value) {
    case 'string':
      return `invalid type: string ${JSON.stringify(value)}, expected ${expected}`;
    case 'boolean':
      return `invalid type: boolean \`${value}\`, expected ${expected}`;
    case 'number':
      return Number.isInteger(value) && !Object.is(value, -0)
        ? `invalid type: integer \`${value}\`, expected ${expected}`
        : `invalid type: floating point \`${value}\`, expected ${expected}`;
    default:
      return `invalid type: map, expected ${expected}`;
  }
}

/** A `Option<u64>` field: undefined when absent, else the unsigned integer. */
function u64Field(raw, key) {
  const value = raw[key];
  // serde's `Option<T>`: an explicit `null` is `None`, exactly like absent.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid type at \`${key}\`: ${invalidType(value, 'u64')}`);
  }
  return value;
}

/** A `Option<bool>` field. */
function boolField(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`invalid type at \`${key}\`: ${invalidType(value, 'a boolean')}`);
  }
  return value;
}

/** A `Option<String>` field. */
function stringField(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`invalid type at \`${key}\`: ${invalidType(value, 'a string')}`);
  }
  return value;
}

/** A `Option<Vec<String>>` field. */
function stringListField(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`invalid type at \`${key}\`: ${invalidType(value, 'a sequence')}`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`invalid type at \`${key}\`: ${invalidType(item, 'a string')}`);
    }
  }
  return value.slice();
}

/** The keys of `value` outside `known`, sorted like serde's `BTreeMap`. */
function extraKeys(value, known) {
  return Object.keys(value)
    .filter((key) => !known.has(key))
    .sort();
}

/**
 * The typed raw entry (`RawEntry`): field types are checked here, unknown
 * keys are collected (`extras`, `matchExtras`). Throws the serde-shaped
 * message the Rust deserializer would have produced.
 */
function rawEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(invalidType(value, 'struct RawEntry'));
  }
  const entry = {
    id: stringField(value, 'id'),
    title: stringField(value, 'title'),
    command: stringListField(value, 'command'),
    triggers: stringListField(value, 'triggers'),
    timeoutMs: u64Field(value, 'timeoutMs'),
    intervalMs: u64Field(value, 'intervalMs'),
    enabled: boolField(value, 'enabled'),
    scope: stringField(value, 'scope'),
    match: undefined,
    extras: extraKeys(value, ENTRY_KEYS),
    matchExtras: [],
  };
  if (value.match !== undefined && value.match !== null) {
    const matcher = value.match;
    if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) {
      throw new Error(`invalid type at \`match\`: ${invalidType(matcher, 'struct RawMatch')}`);
    }
    entry.match = {
      path: stringField(matcher, 'path'),
      remote: stringField(matcher, 'remote'),
    };
    entry.matchExtras = extraKeys(matcher, MATCH_KEYS);
  }
  return entry;
}

/**
 * Validates one typed entry (`config.rs::validate`). Problems that keep the
 * entry usable (unknown keys, unknown triggers) go to `warnings`; the rest
 * throw and reject the entry.
 *
 * `options`: `{ index, seen, warnings, home }` — `seen` is the entries
 * accepted so far (duplicate detection), `home` the expansion source.
 */
function validateEntry(raw, options = {}) {
  const index = options.index ?? 0;
  const seen = options.seen ?? [];
  const warnings = options.warnings ?? [];
  const home = options.home === undefined ? homeDir() : options.home;

  const id = raw.id ?? '';
  const validId = idOk(id);
  const label = validId ? `plugin "${id}"` : `plugin #${index}`;
  for (const key of raw.extras ?? []) warnings.push(`${label}: unknown key "${key}"`);
  for (const key of raw.matchExtras ?? []) warnings.push(`${label}: unknown key "match.${key}"`);
  if (!validId) {
    throw new Error(`plugin #${index}: id "${id}" must match [a-z0-9-]{1,32}`);
  }
  if (seen.some((p) => p.id === id)) throw new Error(`${label}: duplicate id`);
  const command = (raw.command ?? []).slice();
  if (command.length === 0 || command[0] === '') {
    throw new Error(`${label}: command must be a non-empty argv array`);
  }
  if (!expandHome(command, home)) {
    throw new Error(`${label}: cannot expand ~: no home directory`);
  }
  // The working directory is the untrusted project: a relative program path
  // (`./x`, `bin/x`) would resolve inside it.
  const argv0 = command[0];
  if ((argv0.includes('/') || argv0.includes('\\')) && !path.isAbsolute(argv0)) {
    throw new Error(`${label}: command path must be absolute or a bare program name`);
  }
  let scope;
  if (raw.scope === undefined || raw.scope === null || raw.scope === 'tab') {
    scope = 'tab';
  } else if (raw.scope === 'global') {
    scope = 'global';
  } else {
    throw new Error(`${label}: scope must be "tab" or "global"`);
  }
  const timeoutMs = clamp(raw.timeoutMs ?? TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
  const rawInterval = raw.intervalMs;
  const intervalMs =
    rawInterval !== undefined && rawInterval !== null && rawInterval > 0
      ? clamp(rawInterval, INTERVAL_MIN_MS, INTERVAL_MAX_MS)
      : null;
  // An empty matcher matches everything, exactly like an absent one.
  let matchPath = raw.match?.path;
  let matchRemote = raw.match?.remote;
  if (matchPath === '' || matchPath === undefined || matchPath === null) matchPath = null;
  if (matchRemote === '' || matchRemote === undefined || matchRemote === null) matchRemote = null;
  if (matchPath !== null) {
    const expanded = [matchPath];
    if (!expandHome(expanded, home)) {
      throw new Error(`${label}: cannot expand ~ in match.path: no home directory`);
    }
    [matchPath] = expanded;
  }
  const triggers = parseTriggers(raw.triggers, id, warnings);
  const title = typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : id;
  return {
    id,
    title,
    command,
    matchPath,
    matchRemote,
    triggers,
    timeoutMs,
    intervalMs,
    enabled: raw.enabled ?? true,
    scope,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ── load (`config.rs::load`) ────────────────────────────────────────────────

/** `<config dir>/widgets.json`. */
function configPath(configDir) {
  return path.join(configDir, FILE_NAME);
}

/**
 * Reads and validates `widgets.json`.
 *
 * A missing file is an empty config with no error; an unreadable file, a
 * file that is not a UTF-8 JSON object, a missing/unsupported `version` or a
 * non-array `plugins` is `fatal`. Everything else lands in `errors`, one
 * string per problem, and the affected entry is skipped.
 *
 * @param {string} [configDir] defaults to `stores.configHome()`
 * @returns {{plugins: object[], errors: string[], fatal: string|null, configPath: string|null}}
 */
function loadConfig(configDir) {
  const dir = configDir === undefined || configDir === null ? stores.configHome() : configDir;
  const file = dir ? configPath(dir) : null;
  const out = { plugins: [], errors: [], fatal: null, configPath: file };
  if (!file) {
    out.fatal = `${FILE_NAME}: no app config directory`;
    return out;
  }
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return out;
    out.fatal = `${FILE_NAME}: ${error.message}`;
    return out;
  }
  let text;
  try {
    // `ignoreBOM: true` keeps a leading byte-order mark in the text, so
    // JSON.parse rejects it — serde_json does too.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    out.fatal = `${FILE_NAME}: stream did not contain valid UTF-8`;
    return out;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    out.fatal = `${FILE_NAME}: ${error.message}`;
    return out;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    out.fatal = `${FILE_NAME}: ${invalidType(document, 'struct RawFile')}`;
    return out;
  }
  if (document.version === undefined || document.version === null) {
    out.fatal = `${FILE_NAME}: missing "version"`;
    return out;
  }
  if (typeof document.version !== 'number' || !Number.isInteger(document.version) || document.version < 0) {
    out.fatal = `${FILE_NAME}: invalid type at \`version\`: ${invalidType(document.version, 'u64')}`;
    return out;
  }
  const version = document.version;
  if (document.plugins !== undefined && document.plugins !== null && !Array.isArray(document.plugins)) {
    out.fatal = `${FILE_NAME}: invalid type at \`plugins\`: ${invalidType(document.plugins, 'a sequence')}`;
    return out;
  }
  if (version !== SUPPORTED_VERSION) {
    out.fatal = `${FILE_NAME}: version ${version} is not supported (this desktop supports ${SUPPORTED_VERSION})`;
    return out;
  }
  for (const key of extraKeys(document, FILE_KEYS)) {
    out.errors.push(`${FILE_NAME}: unknown key "${key}"`);
  }
  const entries = document.plugins ?? [];
  if (entries.length > MAX_PLUGINS) {
    out.errors.push(
      `${FILE_NAME}: ${entries.length - MAX_PLUGINS} plugin entries ignored (at most ${MAX_PLUGINS} are read)`,
    );
  }
  const limited = entries.slice(0, MAX_PLUGINS);
  for (let index = 0; index < limited.length; index += 1) {
    let raw;
    try {
      raw = rawEntry(limited[index]);
    } catch (error) {
      // A type error is serde's, and names the entry by index only.
      out.errors.push(`plugin #${index}: ${error.message}`);
      continue;
    }
    try {
      out.plugins.push(
        validateEntry(raw, { index, seen: out.plugins, warnings: out.errors, home: homeDir() }),
      );
    } catch (error) {
      // `validate` messages already name the entry (`plugin "id"`/`plugin #i`).
      out.errors.push(error.message);
    }
  }
  return out;
}

module.exports = {
  // constants
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  INTERVAL_MIN_MS,
  INTERVAL_MAX_MS,
  MAX_PLUGINS,
  SUPPORTED_VERSION,
  CONFIG_TRIGGERS,
  TRIGGERS,
  // loading
  loadConfig,
  configPath,
  // pure validators
  idOk,
  homeDir,
  expandHome,
  parseTriggers,
  pathMatches,
  pluginMatches,
  pluginWants,
  rawEntry,
  validateEntry,
  invalidType,
};