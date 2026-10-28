'use strict';

/* Summon hotkey + tray menu data.
 *
 * Port of src-tauri/src/global_hotkey.rs (chord grammar, config file, default
 * and every refusal path) and src-tauri/src/tray.rs (the two menu entries).
 *
 * The chord grammar is Rust's `normalize_chord`/`normalize_key`, unchanged:
 *   - modifiers are order-insensitive and collapse to the canonical order
 *     ctrl, alt, shift, super; a repeated modifier stays one;
 *   - aliases: control→ctrl, option→alt, cmd/command/meta/win/windows→super,
 *     return→enter, esc→escape, del→delete, page-down→pagedown;
 *   - exactly one plain key: one ASCII letter (uppercased), one digit,
 *     `f`+digits (lowercase), `space`, or one of tab, enter, escape,
 *     backspace, delete, insert, home, end, pageup, pagedown, up, down,
 *     left, right;
 *   - anything else — empty parts, zero or several plain keys, unknown keys —
 *     is refused, and `readChord` falls back to the default.
 *
 * Accelerator spelling is Electron's, not the plugin's, but the physical key
 * is Rust's: ctrl becomes `Control` (the literal Control key on every OS,
 * including macOS — not `CommandOrControl`, which would rebind the default
 * `ctrl+alt+space` to Cmd+Option+Space on the Mac), super becomes `Super`.
 * Named keys keep their Electron casing (`Space`, `PageUp`, `F5`).
 *
 * No Electron require here: `trayMenuModel()` is inert data so the main
 * process can build the Tray, and the parser/reader run under plain node.
 *
 * Config: `<configDir>/global-hotkey.json`, shape `{ "chord": "<chord>" }`
 * with unknown fields refused (`deny_unknown_fields`). A missing file, a
 * missing config dir, unreadable/invalid JSON, a renamed key (`hotkey`,
 * `shortcut`) or an unparsable chord all yield the default chord exactly like
 * the Rust `configured_chord`: the app must always start. Failures other than
 * a missing file carry the same `[omp-desktop] hotkey config …` warning text,
 * so `readChord` returns it instead of printing it — the caller logs it.
 *
 * One JSON.parse consequence differs from serde: a duplicate `"chord"` key
 * takes the last value instead of raising `duplicate field`. The file is
 * user-owned config, not the approval store, so this is not a trust boundary.
 */

const fs = require('node:fs');
const path = require('node:path');

// ── constants ────────────────────────────────────────────────────────────────

/** The webview event a summon delivers. Empty payload, as in Rust. */
const SUMMON_EVENT = 'app://summon';

/** `ctrl+alt+space` — no known OS collision, one left hand. */
const DEFAULT_CHORD = 'ctrl+alt+space';

/** The file name under the app config dir. */
const CONFIG_FILE_NAME = 'global-hotkey.json';

const LOG_PREFIX = '[omp-desktop] ';

// Tray contract from tray.rs.
const TRAY_ID = 'omp-tray';
const TRAY_TOOLTIP = 'omp';
const SHOW_ITEM_ID = 'show';
const QUIT_ITEM_ID = 'quit';

// ── accelerator tables ───────────────────────────────────────────────────────

/** Canonical modifier → Electron accelerator modifier. */
const MODIFIER_ACCELERATORS = Object.freeze({
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
});

/**
 * Normalized named key → Electron accelerator key. Letters, digits and
 * F-keys are absent on purpose: their spelling is mechanical (`A`, `9`,
 * `f5` → `F5`), so `acceleratorKey` derives it.
 */
const KEY_ACCELERATORS = Object.freeze({
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
});

/** Aliases the parser's key table accepts, mapped onto its spelling. */
const NAMED_KEYS = Object.freeze({
  tab: 'tab',
  enter: 'enter',
  return: 'enter',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  'page-down': 'pagedown',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
});

// ── chord parser ─────────────────────────────────────────────────────────────

/** Rust's `to_ascii_lowercase`: never touches non-ASCII code points. */
function asciiLower(value) {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * One plain key in the canonical spelling the Rust parser accepts, or null
 * for a key it does not know.
 */
function normalizeKey(key) {
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toUpperCase();
  if (key.length === 1 && /[0-9]/.test(key)) return key;

  const lowered = asciiLower(key);
  if (lowered === 'space') return 'space';
  if (/^f[0-9]+$/.test(lowered)) return lowered;
  // Own-property check: `toString` and friends must not parse as named keys.
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, lowered)) return NAMED_KEYS[lowered];
  return null;
}

/** Electron accelerator spelling of a normalized plain key. */
function acceleratorKey(key) {
  if (Object.prototype.hasOwnProperty.call(KEY_ACCELERATORS, key)) {
    return KEY_ACCELERATORS[key];
  }
  // Single letters are already uppercase; digits are unchanged; f5 → F5.
  return key.toUpperCase();
}

/**
 * Parse a user chord into the canonical chord and its Electron accelerator.
 *
 * @param {string} raw
 * @returns {{ok: true, chord: string, accelerator: string}
 *          | {ok: false, error: string}}
 */
function parseChord(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'chord must be a string' };
  }

  let ctrl = false;
  let alt = false;
  let shift = false;
  let superKey = false;
  const keys = [];

  for (const part of raw.split('+')) {
    const token = part.trim();
    if (token.length === 0) {
      // "+x", "ctrl++x", "x+", "ctrl + + space"
      return { ok: false, error: 'empty key between + separators' };
    }
    switch (asciiLower(token)) {
      case 'ctrl':
      case 'control':
        ctrl = true;
        break;
      case 'alt':
      case 'option':
        alt = true;
        break;
      case 'shift':
        shift = true;
        break;
      case 'super':
      case 'cmd':
      case 'command':
      case 'meta':
      case 'win':
      case 'windows':
        superKey = true;
        break;
      default:
        keys.push(token);
    }
  }

  if (keys.length === 0) {
    return { ok: false, error: 'chord needs exactly one plain key, found none' };
  }
  if (keys.length > 1) {
    return {
      ok: false,
      error: `chord needs exactly one plain key, found ${keys.length}: ${keys.join(', ')}`,
    };
  }

  const key = normalizeKey(keys[0]);
  if (key === null) {
    return { ok: false, error: `unknown key ${JSON.stringify(keys[0])}` };
  }

  const modifiers = [];
  const accelerator = [];
  if (ctrl) {
    modifiers.push('ctrl');
    accelerator.push(MODIFIER_ACCELERATORS.ctrl);
  }
  if (alt) {
    modifiers.push('alt');
    accelerator.push(MODIFIER_ACCELERATORS.alt);
  }
  if (shift) {
    modifiers.push('shift');
    accelerator.push(MODIFIER_ACCELERATORS.shift);
  }
  if (superKey) {
    modifiers.push('super');
    accelerator.push(MODIFIER_ACCELERATORS.super);
  }
  modifiers.push(key);
  accelerator.push(acceleratorKey(key));

  return { ok: true, chord: modifiers.join('+'), accelerator: accelerator.join('+') };
}

// ── config reader ────────────────────────────────────────────────────────────

/** `<configDir>/global-hotkey.json`. */
function hotkeyConfigPath(configDir) {
  return path.join(configDir, CONFIG_FILE_NAME);
}

/** The default result; `file` is the probed path or null when there was none. */
function defaultResult(file, warning) {
  const parsed = parseChord(DEFAULT_CHORD);
  return {
    chord: parsed.chord,
    accelerator: parsed.accelerator,
    source: 'default',
    path: file,
    warning: warning === undefined ? null : warning,
  };
}

function invalidConfigReason(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const found = value === null ? 'null' : Array.isArray(value) ? 'sequence' : typeof value;
    return `invalid type: ${found}, expected an object with a "chord" field`;
  }
  for (const field of Object.keys(value)) {
    if (field !== 'chord') return `unknown field \`${field}\`, expected \`chord\``;
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'chord')) return 'missing field `chord`';
  if (typeof value.chord !== 'string') return 'invalid type for `chord`: expected a string';
  return null;
}

/**
 * Read the summon chord from `<configDir>/global-hotkey.json`.
 *
 * `configDir` null/undefined/empty mirrors Rust's `None`: the default chord,
 * `path: null`, no warning. A missing file is also silent. Every other
 * failure returns the default plus the Rust warning, which the caller logs —
 * a broken hotkey must never stop the app from starting.
 *
 * @param {string|null|undefined} configDir
 * @returns {{chord: string, accelerator: string,
 *            source: 'config'|'default', path: string|null,
 *            warning: string|null}}
 */
function readChord(configDir) {
  if (typeof configDir !== 'string' || configDir.length === 0) {
    return defaultResult(null);
  }

  const file = hotkeyConfigPath(configDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultResult(file);
    return defaultResult(
      file,
      `${LOG_PREFIX}hotkey config ${file} unreadable (${err && err.message}); using ${DEFAULT_CHORD}`,
    );
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return defaultResult(
      file,
      `${LOG_PREFIX}hotkey config ${file} invalid (${err.message}); using ${DEFAULT_CHORD}`,
    );
  }

  const invalid = invalidConfigReason(value);
  if (invalid !== null) {
    return defaultResult(
      file,
      `${LOG_PREFIX}hotkey config ${file} invalid (${invalid}); using ${DEFAULT_CHORD}`,
    );
  }

  const parsed = parseChord(value.chord);
  if (!parsed.ok) {
    return defaultResult(
      file,
      `${LOG_PREFIX}hotkey config ${file} has an unparsable chord ${JSON.stringify(value.chord)}; using ${DEFAULT_CHORD}`,
    );
  }

  return {
    chord: parsed.chord,
    accelerator: parsed.accelerator,
    source: 'config',
    path: file,
    warning: null,
  };
}

// ── tray menu data ───────────────────────────────────────────────────────────

/**
 * The tray's menu entries, as data for the Electron main process.
 *
 * `action: "summon"` means show + unminimize + focus the main window, then
 * emit `SUMMON_EVENT`; `action: "quit"` means close the main window so the
 * normal close path (busy-tab confirmation, child-process cleanup) runs, with
 * `app.exit(0)` only when there is no window — never `app.exit(0)` while one
 * exists, which would skip that path. `leftClick: "toggle-window"` hides a
 * visible, un-minimized window and shows a hidden or minimized one.
 *
 * @returns {{trayId: string, tooltip: string, showMenuOnLeftClick: boolean,
 *            leftClick: string,
 *            items: Array<{id: string, label: string, enabled: boolean,
 *                           action: 'summon'|'quit'}>}}
 */
function trayMenuModel() {
  return {
    trayId: TRAY_ID,
    tooltip: TRAY_TOOLTIP,
    showMenuOnLeftClick: false,
    leftClick: 'toggle-window',
    items: [
      { id: SHOW_ITEM_ID, label: 'show omp', enabled: true, action: 'summon' },
      { id: QUIT_ITEM_ID, label: 'quit', enabled: true, action: 'quit' },
    ],
  };
}

module.exports = {
  SUMMON_EVENT,
  DEFAULT_CHORD,
  CONFIG_FILE_NAME,
  TRAY_ID,
  TRAY_TOOLTIP,
  SHOW_ITEM_ID,
  QUIT_ITEM_ID,
  MODIFIER_ACCELERATORS,
  KEY_ACCELERATORS,
  parseChord,
  readChord,
  hotkeyConfigPath,
  trayMenuModel,
};