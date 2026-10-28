import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Parity port of the Rust suite in
//   src-tauri/src/global_hotkey.rs (mod tests), plus the accelerator mapping
//   and the `configured_chord` fallback cases, and tray.rs's menu entries.
// Run: node tests/port-hotkey.mjs

const require = createRequire(import.meta.url);
const HK = require('../electron/backend/hotkey.js');

let checks = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  checks += 1;
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function chordOf(result) {
  return result.ok ? result.chord : undefined;
}

function acceleratorOf(result) {
  return result.ok ? result.accelerator : undefined;
}

/** Assert the reader fell back to the default, optionally with a warning. */
function expectFallback(result, file, warningPart) {
  check('fallback chord', () => assert.equal(result.chord, HK.DEFAULT_CHORD));
  check('fallback accelerator', () =>
    assert.equal(result.accelerator, 'Control+Alt+Space'));
  check('fallback source', () => assert.equal(result.source, 'default'));
  check('fallback path', () => assert.equal(result.path, file));
  if (warningPart === undefined) {
    check('no warning', () => assert.equal(result.warning, null));
  } else {
    check('warning present', () => assert.equal(typeof result.warning, 'string'));
    check(`warning mentions ${JSON.stringify(warningPart)}`, () =>
      assert.ok(result.warning.includes(warningPart), result.warning));
  }
}

// ── parseChord: Rust table, one test per Rust test ──────────────────────────

test('the_default_chord_normalizes_to_itself', () => {
  const parsed = HK.parseChord(HK.DEFAULT_CHORD);
  check('ok', () => assert.equal(parsed.ok, true));
  check('chord', () => assert.equal(chordOf(parsed), 'ctrl+alt+space'));
  check('accelerator', () =>
    assert.equal(acceleratorOf(parsed), 'Control+Alt+Space'));
  check('default constant', () => assert.equal(HK.DEFAULT_CHORD, 'ctrl+alt+space'));
  check('ctrl is the literal Control key on every platform', () =>
    assert.equal(HK.MODIFIER_ACCELERATORS.ctrl, 'Control'));
});

test('upper_case_and_stray_spaces_still_mean_the_same_chord', () => {
  const cases = [
    'CTRL+ALT+SPACE',
    'ctrl + alt + space',
    '  ctrl+alt+space  ',
  ];
  for (const raw of cases) {
    check(JSON.stringify(raw), () => {
      const parsed = HK.parseChord(raw);
      assert.equal(chordOf(parsed), 'ctrl+alt+space');
      assert.equal(acceleratorOf(parsed), 'Control+Alt+Space');
    });
  }
});

test('modifiers_are_reordered_into_the_canonical_sequence', () => {
  const cases = [
    ['alt+ctrl+space', 'ctrl+alt+space', 'Control+Alt+Space'],
    ['shift+alt+super+ctrl+a', 'ctrl+alt+shift+super+A', 'Control+Alt+Shift+Super+A'],
    ['shift+ctrl+tab', 'ctrl+shift+tab', 'Control+Shift+Tab'],
    ['super+shift+alt+ctrl+f12', 'ctrl+alt+shift+super+f12', 'Control+Alt+Shift+Super+F12'],
  ];
  for (const [raw, chord, accelerator] of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(chordOf(parsed), chord);
      assert.equal(acceleratorOf(parsed), accelerator);
    });
  }
});

test('repeated_modifiers_stay_a_single_modifier', () => {
  const cases = [
    ['ctrl+ctrl+space', 'ctrl+space', 'Control+Space'],
    ['alt+alt+ctrl+A', 'ctrl+alt+A', 'Control+Alt+A'],
    ['super+cmd+meta+win+windows+command+space', 'super+space', 'Super+Space'],
  ];
  for (const [raw, chord, accelerator] of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(chordOf(parsed), chord);
      assert.equal(acceleratorOf(parsed), accelerator);
    });
  }
});

test('modifier_aliases_mean_the_canonical_modifier', () => {
  const cases = [
    ['cmd+space', 'super+space', 'Super+Space'],
    ['command+meta+space', 'super+space', 'Super+Space'],
    ['option+ctrl+space', 'ctrl+alt+space', 'Control+Alt+Space'],
    ['control+win+space', 'ctrl+super+space', 'Control+Super+Space'],
    ['WIN+ALT+X', 'alt+super+X', 'Alt+Super+X'],
    ['Option+Control+Tab', 'ctrl+alt+tab', 'Control+Alt+Tab'],
  ];
  for (const [raw, chord, accelerator] of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(chordOf(parsed), chord);
      assert.equal(acceleratorOf(parsed), accelerator);
    });
  }
});

test('plain_keys_get_their_canonical_spelling', () => {
  const cases = [
    ['a', 'A', 'A'],
    ['ctrl+a', 'ctrl+A', 'Control+A'],
    ['ctrl+9', 'ctrl+9', 'Control+9'],
    ['ctrl+F5', 'ctrl+f5', 'Control+F5'],
    ['ctrl+Return', 'ctrl+enter', 'Control+Enter'],
    ['ctrl+SPACE', 'ctrl+space', 'Control+Space'],
    ['shift+f24', 'shift+f24', 'Shift+F24'],
    ['super+left', 'super+left', 'Super+Left'],
    ['alt+page-down', 'alt+pagedown', 'Alt+PageDown'],
    ['ctrl+del', 'ctrl+delete', 'Control+Delete'],
    ['ctrl+esc', 'ctrl+escape', 'Control+Escape'],
  ];
  for (const [raw, chord, accelerator] of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(chordOf(parsed), chord);
      assert.equal(acceleratorOf(parsed), accelerator);
    });
  }
});

test('every_named_key_has_an_electron_accelerator', () => {
  const cases = [
    ['tab', 'Tab'],
    ['enter', 'Enter'],
    ['escape', 'Escape'],
    ['backspace', 'Backspace'],
    ['delete', 'Delete'],
    ['insert', 'Insert'],
    ['home', 'Home'],
    ['end', 'End'],
    ['pageup', 'PageUp'],
    ['pagedown', 'PageDown'],
    ['up', 'Up'],
    ['down', 'Down'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['space', 'Space'],
  ];
  for (const [key, accelerator] of cases) {
    check(key, () => {
      const parsed = HK.parseChord(`ctrl+${key}`);
      assert.equal(chordOf(parsed), `ctrl+${key}`);
      assert.equal(acceleratorOf(parsed), `Control+${accelerator}`);
    });
  }
});

test('a_chord_without_a_plain_key_is_rejected', () => {
  const cases = ['ctrl+alt', '', '   ', 'ctrl+alt+shift+super', 'ctrl', 'shift'];
  for (const raw of cases) {
    check(JSON.stringify(raw), () => {
      const parsed = HK.parseChord(raw);
      assert.equal(parsed.ok, false);
      assert.equal(typeof parsed.error, 'string');
    });
  }
});

test('a_chord_with_two_plain_keys_is_rejected', () => {
  const cases = ['ctrl+a+b', 'a+b', 'ctrl+a+banana'];
  for (const raw of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /exactly one plain key/);
    });
  }
});

test('malformed_separators_are_rejected', () => {
  const cases = ['+space', 'ctrl++space', 'ctrl+space+', 'ctrl + + space', '+', 'ctrl+'];
  for (const raw of cases) {
    check(JSON.stringify(raw), () => {
      const parsed = HK.parseChord(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /empty key/);
    });
  }
});

test('unknown_keys_are_rejected', () => {
  const cases = ['ctrl+banana', 'ctrl++', 'fn+space', 'ctrl+plus', 'ctrl+ä', 'hyper+space'];
  for (const raw of cases) {
    check(raw, () => {
      const parsed = HK.parseChord(raw);
      assert.equal(parsed.ok, false);
      assert.equal(typeof parsed.error, 'string');
    });
  }

  check('unknown key names the key', () => {
    const parsed = HK.parseChord('ctrl+banana');
    assert.equal(parsed.error, 'unknown key "banana"');
  });
});

test('non_string_chords_are_rejected', () => {
  for (const raw of [undefined, null, 42, {}, ['ctrl+space']]) {
    check(String(raw), () => {
      const parsed = HK.parseChord(raw);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error, 'chord must be a string');
    });
  }
});

// ── readChord: configured_chord fallbacks ───────────────────────────────────

test('missing_file_keeps_the_default_silently', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  expectFallback(HK.readChord(dir), HK.hotkeyConfigPath(dir));
});

test('no_config_dir_keeps_the_default', () => {
  for (const dir of [null, undefined, '']) {
    const result = HK.readChord(dir);
    check(String(dir), () => {
      assert.equal(result.chord, HK.DEFAULT_CHORD);
      assert.equal(result.accelerator, 'Control+Alt+Space');
      assert.equal(result.source, 'default');
      assert.equal(result.path, null);
      assert.equal(result.warning, null);
    });
  }
});

test('a_valid_file_gives_the_normalized_chord', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, JSON.stringify({ chord: 'alt+ctrl+space' }));

  const result = HK.readChord(dir);
  check('chord', () => assert.equal(result.chord, 'ctrl+alt+space'));
  check('accelerator', () =>
    assert.equal(result.accelerator, 'Control+Alt+Space'));
  check('source', () => assert.equal(result.source, 'config'));
  check('path', () => assert.equal(result.path, file));
  check('no warning', () => assert.equal(result.warning, null));
});

test('file_chord_is_normalized_not_echoed', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  fs.writeFileSync(HK.hotkeyConfigPath(dir), '{ "chord": "  SHIFT + Option + F5  " }');

  const result = HK.readChord(dir);
  check('chord', () => assert.equal(result.chord, 'alt+shift+f5'));
  check('accelerator', () =>
    assert.equal(result.accelerator, 'Alt+Shift+F5'));
  check('source', () => assert.equal(result.source, 'config'));
});

test('corrupt_json_falls_back_with_a_warning_naming_the_file', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, '{ not json');
  expectFallback(HK.readChord(dir), file, `hotkey config ${file} invalid (`);
});

test('an_empty_file_falls_back_with_a_warning', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, '');
  expectFallback(HK.readChord(dir), file, 'invalid');
});

test('a_renamed_key_is_a_config_error_not_a_silent_default', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);

  for (const body of [{ hotkey: 'ctrl+space' }, { shortcut: 'ctrl+space' },
    { chord: 'ctrl+space', hotkey: 'ctrl+a' }]) {
    fs.writeFileSync(file, JSON.stringify(body));
    const result = HK.readChord(dir);
    check(JSON.stringify(body), () => {
      assert.equal(result.chord, HK.DEFAULT_CHORD);
      assert.equal(result.source, 'default');
      assert.match(result.warning, /invalid/);
      assert.match(result.warning, /unknown field/);
    });
  }
});

test('a_missing_chord_field_falls_back_with_a_warning', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, '{}');
  expectFallback(HK.readChord(dir), file, 'missing field');
});

test('a_non_string_chord_falls_back_with_a_warning', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, JSON.stringify({ chord: 5 }));
  expectFallback(HK.readChord(dir), file, 'invalid type for `chord`');
});

test('a_non_object_config_falls_back_with_a_warning', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);

  for (const body of ['null', '[]', '"ctrl+space"', '42']) {
    fs.writeFileSync(file, body);
    const result = HK.readChord(dir);
    check(body, () => {
      assert.equal(result.chord, HK.DEFAULT_CHORD);
      assert.match(result.warning, /invalid/);
    });
  }
});

test('an_unparsable_chord_falls_back_with_the_rust_wording', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, JSON.stringify({ chord: 'ctrl+banana' }));

  const result = HK.readChord(dir);
  expectFallback(
    result,
    file,
    `hotkey config ${file} has an unparsable chord "ctrl+banana"; using ctrl+alt+space`,
  );
});

test('an_unreadable_config_path_falls_back_with_a_warning', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.mkdirSync(file); // a directory where the file belongs → EISDIR
  expectFallback(HK.readChord(dir), file, `hotkey config ${file} unreadable (`);
});

test('the_warning_text_keeps_the_rust_prefix', (t) => {
  const dir = tempDir(t, 'omp-hotkey-');
  const file = HK.hotkeyConfigPath(dir);
  fs.writeFileSync(file, '{');
  const result = HK.readChord(dir);
  check('prefix', () => assert.ok(result.warning.startsWith('[omp-desktop] hotkey config ')));
});

// ── tray.rs menu data ───────────────────────────────────────────────────────

test('tray_menu_mirrors_tray_rs', () => {
  const model = HK.trayMenuModel();
  check('tray id', () => assert.equal(model.trayId, 'omp-tray'));
  check('tooltip', () => assert.equal(model.tooltip, 'omp'));
  check('left click', () => assert.equal(model.leftClick, 'toggle-window'));
  check('menu not on left click', () => assert.equal(model.showMenuOnLeftClick, false));
  check('two entries', () => assert.equal(model.items.length, 2));
  check('show entry', () =>
    assert.deepEqual(model.items[0], {
      id: 'show',
      label: 'show omp',
      enabled: true,
      action: 'summon',
    }));
  check('quit entry', () =>
    assert.deepEqual(model.items[1], {
      id: 'quit',
      label: 'quit',
      enabled: true,
      action: 'quit',
    }));
});

test('tray_menu_is_data_without_electron', () => {
  const model = HK.trayMenuModel();
  model.items[0].label = 'mutated';
  check('fresh copy', () => assert.equal(HK.trayMenuModel().items[0].label, 'show omp'));
  check('summon event is the rust constant', () =>
    assert.equal(HK.SUMMON_EVENT, 'app://summon'));
});

test('summary', () => {
  console.log(`hotkey: ${checks} checks passed`);
});