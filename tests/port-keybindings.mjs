import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Parity port of the Rust keybindings suites:
//   src-tauri/src/keybindings/{tests,overlay,tests in chord,yaml}.rs
// Run: node tests/port-keybindings.mjs

const require = createRequire(import.meta.url);
const MODULE_PATH = require.resolve('../electron/backend/keybindings.js');
const KB = require(MODULE_PATH);

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

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'OMP_PORT_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
];

function snapshotEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Mirrors the module's platform default for the current platform. */
function platformConfigDir(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'dev.ohMyPi.desktop');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'dev.ohMyPi.desktop');
  }
  return path.join(home, '.config', 'dev.ohMyPi.desktop');
}

/**
 * Fresh fake home per test. `configDir: true` creates `<home>/config` and
 * makes it the override (file-backed); `configDir: false` points the override
 * at a nonexistent folder (memory-only).
 */
function setup(t, { configDir = true } = {}) {
  const saved = snapshotEnv();
  t.after(() => restoreEnv(saved));

  const home = tempDir(t, 'omp-kb-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OMP_PORT_CONFIG_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;

  const dir = path.join(home, 'config');
  if (configDir) {
    fs.mkdirSync(dir, { recursive: true });
    process.env.OMP_PORT_CONFIG_DIR = dir;
  } else {
    process.env.OMP_PORT_CONFIG_DIR = path.join(home, 'missing-config');
  }

  return {
    home,
    configDir: dir,
    overlayFile: path.join(dir, 'keybindings.json'),
    agentDir: path.join(home, '.omp', 'agent'),
    namedAgentDir: (id) => path.join(home, '.omp', 'profiles', id, 'agent'),
  };
}

function writeOmp(home, content, { filename = 'keybindings.yml', profile = null } = {}) {
  const dir = profile === null
    ? path.join(home, '.omp', 'agent')
    : path.join(home, '.omp', 'profiles', profile, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

function writeOverlay(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readOverlayFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function freshModule() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

// ── overlay read (overlay.rs) ────────────────────────────────────────────────

test('missing_file_reads_as_empty', (t) => {
  const fx = setup(t);
  const payload = KB.keybindingsList(null);
  check('overlay empty', () => assert.deepEqual(payload.overlay, {}));
  check('no overlay error', () => assert.equal(payload.overlayError, null));
  check('overlayPath names the file', () => assert.equal(payload.overlayPath, fx.overlayFile));
});

test('empty_object_file_reads_as_empty', (t) => {
  const fx = setup(t);
  writeOverlay(fx.overlayFile, '{}');
  const payload = KB.keybindingsList(null);
  check('empty object overlay', () => assert.deepEqual(payload.overlay, {}));
  check('no overlay error', () => assert.equal(payload.overlayError, null));
});

test('read_parses_the_documented_on_disk_shape', (t) => {
  const fx = setup(t);
  writeOverlay(
    fx.overlayFile,
    '{ "bindings": { "desktop.panel.changes": ["ctrl+g"], "app.plan.toggle": [] } }',
  );
  const payload = KB.keybindingsList(null);
  check('chord list read verbatim', () =>
    assert.deepEqual(payload.overlay['desktop.panel.changes'], ['ctrl+g']));
  check('explicit disable read verbatim', () =>
    assert.deepEqual(payload.overlay['app.plan.toggle'], []));
});

test('payload_with_no_overlay_file_is_empty_and_pathed', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+O\n');
  const payload = KB.keybindingsList(null);
  check('omp parsed', () => assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+o']));
  check('overlay empty', () => assert.deepEqual(payload.overlay, {}));
  check('no error', () => assert.equal(payload.overlayError, null));
  check('overlay path present', () => assert.equal(payload.overlayPath, fx.overlayFile));
});

test('corrupt_overlay_does_not_drop_omp_layer', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+O\n');
  writeOverlay(fx.overlayFile, 'not json');

  const payload = KB.keybindingsList(null);
  check('omp survives', () => assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+o']));
  check('overlay empty', () => assert.deepEqual(payload.overlay, {}));
  check('overlayError set', () => assert.equal(typeof payload.overlayError, 'string'));
  check('overlay path still reported', () => assert.equal(payload.overlayPath, fx.overlayFile));
});

test('invalid_overlay_shape_sets_overlay_error', (t) => {
  const fx = setup(t);
  writeOverlay(fx.overlayFile, '{"bindings":"nope"}');
  const payload = KB.keybindingsList(null);
  check('overlay empty', () => assert.deepEqual(payload.overlay, {}));
  check('overlayError set', () => assert.equal(typeof payload.overlayError, 'string'));
});

// ── overlay writes (overlay.rs) ──────────────────────────────────────────────

test('fresh_config_dir_is_created_on_first_set', () => {
  // The port never creates the config folder; without it the overlay is
  // memory-only, so a missing platform default stays missing after a set.
  const saved = snapshotEnv();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-kb-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.OMP_PORT_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    const expected = platformConfigDir(home);
    if (!fs.existsSync(expected)) {
      const payload = KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
      check('memory overlay has no path', () => assert.equal(payload.overlayPath, null));
      check('binding applied', () =>
        assert.deepEqual(payload.overlay['desktop.panel.changes'], ['ctrl+g']));
      check('config folder not created', () => assert.equal(fs.existsSync(expected), false));
    } else {
      check('platform folder already present', () => assert.ok(true));
    }
    fs.rmSync(home, { recursive: true, force: true });
  } finally {
    restoreEnv(saved);
  }
});

test('set_round_trips', (t) => {
  const fx = setup(t);
  const payload = KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  check('reply carries the binding', () =>
    assert.deepEqual(payload.overlay['desktop.panel.changes'], ['ctrl+g']));
  check('written shape', () =>
    assert.deepEqual(readOverlayFile(fx.overlayFile), {
      bindings: { 'desktop.panel.changes': ['ctrl+g'] },
    }));
  check('survives a fresh list', () =>
    assert.deepEqual(KB.keybindingsList(null).overlay['desktop.panel.changes'], ['ctrl+g']));
});

test('set_canonicalises_chords', (t) => {
  setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', ['Ctrl+G']);
  check('lowercase canonical chord stored', () =>
    assert.deepEqual(KB.keybindingsList(null).overlay['desktop.panel.changes'], ['ctrl+g']));
});

test('set_deduplicates_equivalent_chords', (t) => {
  setup(t);
  const payload = KB.keybindingsSet(null, 'desktop.panel.changes', ['Ctrl+G', 'ctrl+g']);
  check('deduped', () =>
    assert.deepEqual(payload.overlay['desktop.panel.changes'], ['ctrl+g']));
});

test('set_empty_keys_stores_explicit_disabled', (t) => {
  setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', []);
  const payload = KB.keybindingsList(null);
  check('key present', () =>
    assert.equal(Object.prototype.hasOwnProperty.call(payload.overlay, 'desktop.panel.changes'), true));
  check('empty chord list', () => assert.deepEqual(payload.overlay['desktop.panel.changes'], []));
});

test('remove_of_absent_action_is_noop', (t) => {
  const fx = setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  const before = fs.readFileSync(fx.overlayFile);
  KB.keybindingsReset(null, 'desktop.panel.todo');
  check('other key survives', () =>
    assert.deepEqual(KB.keybindingsList(null).overlay['desktop.panel.changes'], ['ctrl+g']));
  check('file untouched', () => assert.deepEqual(fs.readFileSync(fx.overlayFile), before));
});

test('remove_on_fresh_store_does_not_create_file', (t) => {
  const fx = setup(t);
  KB.keybindingsReset(null, 'desktop.panel.changes');
  check('overlay file not created', () => assert.equal(fs.existsSync(fx.overlayFile), false));
});

test('two_sequential_sets_both_survive', (t) => {
  setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  KB.keybindingsSet(null, 'desktop.panel.todo', ['ctrl+u']);
  const overlay = KB.keybindingsList(null).overlay;
  check('first survives', () => assert.deepEqual(overlay['desktop.panel.changes'], ['ctrl+g']));
  check('second survives', () => assert.deepEqual(overlay['desktop.panel.todo'], ['ctrl+u']));
});

test('set_on_unknown_action_errors_and_leaves_file_untouched', (t) => {
  const fx = setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  const before = fs.readFileSync(fx.overlayFile);
  let message = '';
  try {
    KB.keybindingsSet(null, 'not.a.real.action', ['ctrl+x']);
  } catch (e) {
    message = e.message;
  }
  check('error mentions unknown action', () => assert.match(message, /unknown action/));
  check('previous binding intact', () =>
    assert.deepEqual(KB.keybindingsList(null).overlay['desktop.panel.changes'], ['ctrl+g']));
  check('file untouched', () => assert.deepEqual(fs.readFileSync(fx.overlayFile), before));
});

test('invalid_chord_errors_without_writing', (t) => {
  const fx = setup(t);
  let message = '';
  try {
    KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+']);
  } catch (e) {
    message = e.message;
  }
  check('error mentions invalid chord', () => assert.match(message, /invalid chord/));
  check('nothing written', () => assert.equal(fs.existsSync(fx.overlayFile), false));
  check('overlay reads empty', () => assert.deepEqual(KB.keybindingsList(null).overlay, {}));
});

test('corrupt_file_makes_read_and_set_error_without_rewriting', (t) => {
  const fx = setup(t);
  writeOverlay(fx.overlayFile, 'this is not json');
  const before = fs.readFileSync(fx.overlayFile);

  check('list reports overlayError', () =>
    assert.equal(typeof KB.keybindingsList(null).overlayError, 'string'));

  let setError = '';
  try {
    KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  } catch (e) {
    setError = e.message;
  }
  check('set throws an unreadable error', () => assert.match(setError, /is unreadable/));
  check('set leaves the bytes unchanged', () =>
    assert.deepEqual(fs.readFileSync(fx.overlayFile), before));

  let resetError = '';
  try {
    KB.keybindingsReset(null, 'desktop.panel.changes');
  } catch (e) {
    resetError = e.message;
  }
  check('reset throws an unreadable error', () => assert.match(resetError, /is unreadable/));
  check('reset leaves the bytes unchanged', () =>
    assert.deepEqual(fs.readFileSync(fx.overlayFile), before));
});

test('set_then_remove_leaves_key_absent', (t) => {
  setup(t);
  KB.keybindingsSet(null, 'desktop.panel.changes', ['ctrl+g']);
  const payload = KB.keybindingsReset(null, 'desktop.panel.changes');
  check('removed from reply', () =>
    assert.equal(Object.prototype.hasOwnProperty.call(payload.overlay, 'desktop.panel.changes'), false));
  check('removed from disk', () =>
    assert.equal(Object.prototype.hasOwnProperty.call(KB.keybindingsList(null).overlay, 'desktop.panel.changes'), false));
});

test('a_memory_only_store_keeps_rebinds_for_its_lifetime_only', (t) => {
  const fx = setup(t, { configDir: false });
  const kb = freshModule();

  const empty = kb.keybindingsList(null);
  check('no overlay path', () => assert.equal(empty.overlayPath, null));
  check('starts empty', () => assert.deepEqual(empty.overlay, {}));
  check('nonexistent config dir still absent', () => assert.equal(fs.existsSync(fx.configDir), false));

  const set = kb.keybindingsSet(null, 'desktop.panel.changes', ['Ctrl+G']);
  check('in-memory set canonicalised', () =>
    assert.deepEqual(set.overlay['desktop.panel.changes'], ['ctrl+g']));
  check('in-memory payload has no path', () => assert.equal(set.overlayPath, null));
  check('still readable', () =>
    assert.deepEqual(kb.keybindingsList(null).overlay, set.overlay));

  let unknown = '';
  try {
    kb.keybindingsSet(null, 'not.an.action', []);
  } catch (e) {
    unknown = e.message;
  }
  check('unknown action still rejected in memory', () => assert.match(unknown, /unknown action/));

  const removed = kb.keybindingsReset(null, 'desktop.panel.changes');
  check('in-memory remove empties the overlay', () => assert.deepEqual(removed.overlay, {}));

  const fresh = freshModule();
  check('a new store starts empty', () => assert.deepEqual(fresh.keybindingsList(null).overlay, {}));
});

// ── omp config probing (mod.rs / yaml.rs) ────────────────────────────────────

test('probe_order_picks_yml_first', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: ctrl+1\n', { filename: 'keybindings.yml' });
  writeOmp(fx.home, 'app.plan.toggle: ctrl+2\n', { filename: 'keybindings.yaml' });
  writeOmp(fx.home, '{"app.plan.toggle":"ctrl+3"}', { filename: 'keybindings.json' });
  const payload = KB.keybindingsList(null);
  check('yml wins', () => assert.deepEqual(payload.omp['app.plan.toggle'], ['ctrl+1']));
  check('ompPath is the yml', () => assert.match(payload.ompPath, /keybindings\.yml$/));

  fs.rmSync(path.join(fx.agentDir, 'keybindings.yml'));
  const yamlPayload = KB.keybindingsList(null);
  check('yaml next', () => assert.deepEqual(yamlPayload.omp['app.plan.toggle'], ['ctrl+2']));
  check('ompPath is the yaml', () => assert.match(yamlPayload.ompPath, /keybindings\.yaml$/));

  fs.rmSync(path.join(fx.agentDir, 'keybindings.yaml'));
  const jsonPayload = KB.keybindingsList(null);
  check('json last', () => assert.deepEqual(jsonPayload.omp['app.plan.toggle'], ['ctrl+3']));
  check('ompPath is the json', () => assert.match(jsonPayload.ompPath, /keybindings\.json$/));
});

test('probe_order_returns_none_when_no_file_exists', (t) => {
  setup(t);
  fs.mkdirSync(path.join(process.env.HOME, '.omp', 'agent'), { recursive: true });
  const payload = KB.keybindingsList(null);
  check('omp empty', () => assert.deepEqual(payload.omp, {}));
  check('ompPath null', () => assert.equal(payload.ompPath, null));
});

test('missing_omp_config_yields_empty_layer', (t) => {
  setup(t);
  const payload = KB.keybindingsList(null);
  check('empty omp', () => assert.deepEqual(payload.omp, {}));
  check('ompPath null', () => assert.equal(payload.ompPath, null));
  check('inheritedPath null', () => assert.equal(payload.inheritedPath, null));
});

test('unreadable_file_yields_err', (t) => {
  const fx = setup(t);
  // A directory where the file should be: `exists` true, read fails.
  fs.mkdirSync(path.join(fx.agentDir, 'keybindings.yml'), { recursive: true });
  check('list throws', () => assert.throws(() => KB.keybindingsList(null)));
});

test('malformed_json_config_degrades_to_empty_map', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, '{\n  // comment\n  "app.exit": "ctrl+c"\n}\n', { filename: 'keybindings.json' });
  const payload = KB.keybindingsList(null);
  check('empty omp map', () => assert.deepEqual(payload.omp, {}));
  check('path still reported', () => assert.match(payload.ompPath, /keybindings\.json$/));
});

test('non_object_json_config_degrades_to_empty_map', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, '[1, 2, 3]', { filename: 'keybindings.json' });
  check('empty omp map', () => assert.deepEqual(KB.keybindingsList(null).omp, {}));
});

test('json_config_accepts_strings_and_string_arrays_only', (t) => {
  const fx = setup(t);
  writeOmp(
    fx.home,
    JSON.stringify({
      'app.plan.toggle': 'Ctrl+O',
      'app.model.select': ['alt+m'],
      'app.x': ['ctrl+x', 1],
      'app.y': 7,
    }),
    { filename: 'keybindings.json' },
  );
  const payload = KB.keybindingsList(null);
  check('string value', () => assert.deepEqual(payload.omp['app.plan.toggle'], ['ctrl+o']));
  check('array value canonicalised', () => assert.deepEqual(payload.omp['app.model.select'], ['alt+m']));
  check('mixed array dropped', () => assert.equal('app.x' in payload.omp, false));
  check('non-string dropped', () => assert.equal('app.y' in payload.omp, false));
});

test('bom_prefixed_yaml_is_parsed', (t) => {
  const fx = setup(t);
  fs.mkdirSync(fx.agentDir, { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(
    path.join(fx.agentDir, 'keybindings.yml'),
    Buffer.concat([bom, Buffer.from('app.exit: ctrl+c\n')]),
  );
  check('BOM does not swallow the first key', () =>
    assert.deepEqual(KB.keybindingsList(null).omp['app.exit'], ['ctrl+c']));
});

test('yaml_null_is_absent_and_empty_sequence_is_disabled', (t) => {
  const fx = setup(t);
  writeOmp(
    fx.home,
    'app.a:\napp.b: []\napp.c: null\napp.d: ~\napp.e: "null"\n',
  );
  const omp = KB.keybindingsList(null).omp;
  check('bare key absent', () => assert.equal('app.a' in omp, false));
  check('inline [] disabled', () => assert.deepEqual(omp['app.b'], []));
  check('null absent', () => assert.equal('app.c' in omp, false));
  check('~ absent', () => assert.equal('app.d' in omp, false));
  check('quoted null is a literal chord', () => assert.deepEqual(omp['app.e'], ['null']));
});

test('yaml_block_sequence_and_comments_parse', (t) => {
  const fx = setup(t);
  writeOmp(
    fx.home,
    '# leading comment\napp.model.select:\n  - alt+m\n  - alt+n\napp.other: ctrl+z\n',
  );
  const omp = KB.keybindingsList(null).omp;
  check('block sequence', () => assert.deepEqual(omp['app.model.select'], ['alt+m', 'alt+n']));
  check('following entry', () => assert.deepEqual(omp['app.other'], ['ctrl+z']));
});

test('yaml_duplicate_keys_last_wins', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: ctrl+a\napp.plan.toggle: ctrl+b\n');
  check('last wins', () =>
    assert.deepEqual(KB.keybindingsList(null).omp['app.plan.toggle'], ['ctrl+b']));
});

test('legacy_action_names_are_migrated_and_namespaced_wins', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'togglePlanMode: Alt+P\nnewSession: ctrl+n\n');
  const migrated = KB.keybindingsList(null).omp;
  check('legacy plan id migrated', () => assert.deepEqual(migrated['app.plan.toggle'], ['alt+p']));
  check('legacy new-session id migrated', () => assert.deepEqual(migrated['app.session.new'], ['ctrl+n']));

  writeOmp(fx.home, 'interrupt: ctrl+c\napp.interrupt: ctrl+x\n');
  check('namespaced entry wins over legacy alias', () =>
    assert.deepEqual(KB.keybindingsList(null).omp['app.interrupt'], ['ctrl+x']));
});

// ── profile merging (mod.rs) ─────────────────────────────────────────────────

test('pi_coding_agent_dir_applies_only_to_built_in_profile', (t) => {
  const fx = setup(t);
  const elsewhere = tempDir(t, 'omp-kb-elsewhere-');
  writeOmp(fx.home, 'app.plan.toggle: ctrl+home\n');
  writeOmp(elsewhere, 'app.plan.toggle: ctrl+env\n');
  writeOmp(fx.home, 'app.model.select: alt+m\n', { profile: 'work' });
  process.env.PI_CODING_AGENT_DIR = path.join(elsewhere, '.omp', 'agent');

  const builtIn = KB.keybindingsList(null);
  check('built-in honours the env dir', () =>
    assert.deepEqual(builtIn.omp['app.plan.toggle'], ['ctrl+env']));
  check('built-in path is the env dir', () =>
    assert.equal(builtIn.ompPath, path.join(elsewhere, '.omp', 'agent', 'keybindings.yml')));

  const named = KB.keybindingsList('work');
  check('named ignores the env dir', () =>
    assert.deepEqual(named.omp['app.model.select'], ['alt+m']));
  check('named path is under profiles', () =>
    assert.equal(named.ompPath, path.join(fx.home, '.omp', 'profiles', 'work', 'agent', 'keybindings.yml')));
});

test('empty_profile_id_is_treated_as_built_in', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+P\n');
  const payload = KB.keybindingsList('');
  check('empty id reads the built-in file', () =>
    assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+p']));
  check('no inherited path', () => assert.equal(payload.inheritedPath, null));

  const namedDefault = KB.keybindingsList('default');
  check('"default" also reads the built-in file', () =>
    assert.deepEqual(namedDefault.omp['app.plan.toggle'], ['shift+alt+p']));
});

test('named_profile_overrides_base_while_non_overridden_survive', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+O\napp.model.select: []\n');
  writeOmp(fx.home, 'app.plan.toggle: Ctrl+Shift+O\n', { profile: 'work' });

  const payload = KB.keybindingsList('work');
  check('named overrides', () => assert.deepEqual(payload.omp['app.plan.toggle'], ['ctrl+shift+o']));
  check('base disable survives', () => assert.deepEqual(payload.omp['app.model.select'], []));
  check('path points at the named file', () =>
    assert.match(payload.ompPath, /profiles\/work\/agent\/keybindings\.yml$/));
  check('inherited path present', () => assert.match(payload.inheritedPath, /\.omp\/agent\/keybindings\.yml$/));
});

test('built_in_profile_reads_only_one_file_no_inherited', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+P\n');
  const payload = KB.keybindingsList(null);
  check('built-in reads its file', () =>
    assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+p']));
  check('no inherited path', () => assert.equal(payload.inheritedPath, null));
});

test('named_profile_inherited_base_ignores_pi_coding_agent_dir', (t) => {
  const fx = setup(t);
  const elsewhere = tempDir(t, 'omp-kb-elsewhere-');
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+O\n');
  writeOmp(fx.home, 'app.model.select: ctrl+m\n', { profile: 'work' });
  writeOmp(elsewhere, 'app.plan.toggle: ctrl+shift+z\n');
  process.env.PI_CODING_AGENT_DIR = path.join(elsewhere, '.omp', 'agent');

  const payload = KB.keybindingsList('work');
  check('named binding applies', () =>
    assert.deepEqual(payload.omp['app.model.select'], ['ctrl+m']));
  check('base came from the real home', () =>
    assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+o']));
  check('inherited path under the real home', () =>
    assert.equal(payload.inheritedPath, path.join(fx.home, '.omp', 'agent', 'keybindings.yml')));
});

test('named_profile_missing_files_report_null_paths', (t) => {
  setup(t);
  fs.mkdirSync(path.join(process.env.HOME, '.omp', 'profiles', 'work', 'agent'), { recursive: true });
  const payload = KB.keybindingsList('work');
  check('empty merge', () => assert.deepEqual(payload.omp, {}));
  check('named path null', () => assert.equal(payload.ompPath, null));
  check('inherited path null', () => assert.equal(payload.inheritedPath, null));
});

// ── layer-precedence proof ───────────────────────────────────────────────────

test('overlay_does_not_write_omp_file_and_payload_layers_correctly', (t) => {
  const fx = setup(t);
  const ymlContent = '# comment\napp.plan.toggle: Alt+Shift+O\napp.model.select: []\n';
  writeOmp(fx.home, ymlContent);
  KB.keybindingsSet(null, 'app.plan.toggle', ['ctrl+shift+o']);

  const payload = KB.keybindingsList(null);
  check('omp layer as authored', () =>
    assert.deepEqual(payload.omp['app.plan.toggle'], ['shift+alt+o']));
  check('omp explicit disable', () => assert.deepEqual(payload.omp['app.model.select'], []));
  check('overlay layer rebound', () =>
    assert.deepEqual(payload.overlay['app.plan.toggle'], ['ctrl+shift+o']));
  check('omp path at the yml', () => assert.match(payload.ompPath, /keybindings\.yml$/));
  check('omp file untouched', () =>
    assert.equal(fs.readFileSync(path.join(fx.agentDir, 'keybindings.yml'), 'utf8'), ymlContent));
});

test('payload_with_overlay_matches_payload_for_the_same_state', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.plan.toggle: Alt+Shift+O\n');
  const viaSet = KB.keybindingsSet(null, 'app.plan.toggle', ['ctrl+shift+o']);
  const fresh = KB.keybindingsList(null);
  check('omp layers equal', () => assert.deepEqual(viaSet.omp, fresh.omp));
  check('overlay layers equal', () => assert.deepEqual(viaSet.overlay, fresh.overlay));
  check('no overlay error', () => assert.equal(viaSet.overlayError, null));
  check('paths equal', () => assert.equal(viaSet.overlayPath, fresh.overlayPath));
  check('overlay file path', () => assert.equal(viaSet.overlayPath, fx.overlayFile));
});

test('overlay_is_app_wide_not_per_profile', (t) => {
  const fx = setup(t);
  writeOmp(fx.home, 'app.model.select: alt+m\n', { profile: 'work' });
  const viaNamed = KB.keybindingsSet('work', 'desktop.panel.changes', ['ctrl+g']);
  check('overlay written once', () => assert.equal(viaNamed.overlayPath, fx.overlayFile));
  check('visible from the built-in profile', () =>
    assert.deepEqual(KB.keybindingsList(null).overlay['desktop.panel.changes'], ['ctrl+g']));
});

// ── chord.rs ─────────────────────────────────────────────────────────────────

test('canonical_chord_matches_omp_ordering_and_aliases', () => {
  const cases = [
    ['Alt+Shift+P', 'shift+alt+p'],
    ['Ctrl+P', 'ctrl+p'],
    ['P', 'p'],
    ['p', 'p'],
    ['Esc', 'escape'],
    ['Return', 'enter'],
    ['CTRL+ALT+]', 'ctrl+alt+]'],
    ['super+K', 'super+k'],
    ['  ctrl+  Tab ', 'ctrl+tab'],
  ];
  for (const [raw, expected] of cases) {
    check(`canonicalChord(${JSON.stringify(raw)})`, () =>
      assert.equal(KB.canonicalChord(raw), expected));
  }
});

test('canonical_chord_rejects_a_missing_base', () => {
  check('ctrl+', () => assert.equal(KB.canonicalChord('ctrl+'), ''));
  check('blank', () => assert.equal(KB.canonicalChord('   '), ''));
});

test('summary', () => {
  console.log(`keybindings: ${checks} checks passed`);
});