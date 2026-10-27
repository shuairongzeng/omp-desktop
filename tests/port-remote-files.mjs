#!/usr/bin/env node
/* Parity tests for electron/backend/remote-files.js.

   Mirrors the Rust suites one-for-one, then covers the port's own edges:

     remote_transcript.rs  newest/head/cursor pages, the serde key-order
                           scanner trap, block caps, the 300 KB wire budget,
                           default + max limit clamps, damaged rows, missing
                           files.
     remote_replay.rs      rpc_chunk removal, unparseable text kept, the
                           newest-400 cap and its `dropped` flag, head_seq
                           pass-through, empty replay, the journal-ring form.
     remote_dirs.rs        sorting, hidden filter, symlinked dirs, parent,
                           roots, 500-entry cap, error messages.
     remote/settings.rs    serde field names + pretty shape, legacy (pre-v2)
                           files, per-phone merge, phone_ms lookup, defaults
                           on a malformed file, atomic write.

   Run: node tests/port-remote-files.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const remote = require(path.join(root, 'electron/backend/remote-files.js'));
const stores = require(path.join(root, 'electron/backend/stores.js'));

const {
  transcriptWindow,
  replayProject,
  listDirs,
  remoteSettingsLoad,
  remoteSettingsSave,
  phoneMs,
  isMessageRow,
  remoteSettingsPath,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BLOCK_CHARS,
  TRUNCATION_SUFFIX,
  MAX_WINDOW_BYTES,
  MAX_PROJECTED_EVENTS,
  MAX_ENTRIES,
} = remote;

// ── harness ────────────────────────────────────────────────────────────────

const scratchDirs = [];
const originalConfigDir = process.env.OMP_PORT_CONFIG_DIR;

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_remote_files_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

let fileCounter = 0;
function uniqueFile(tag) {
  fileCounter += 1;
  return path.join(makeTestDir(tag), `fixture-${fileCounter}.jsonl`);
}

function writeJsonl(bytesOrLines, tag) {
  const file = uniqueFile(tag);
  if (Buffer.isBuffer(bytesOrLines)) {
    fs.writeFileSync(file, bytesOrLines);
  } else {
    fs.writeFileSync(file, `${bytesOrLines.join('\n')}\n`);
  }
  return file;
}

/** `message(role, text)` from the Rust tests: a row in omp's sorted key order. */
function message(role, text) {
  return JSON.stringify({
    message: { content: [{ text, type: 'text' }], role },
    type: 'message',
  });
}

/** The Rust `fixture()`: five message rows plus two noise rows. */
function fixture(tag) {
  return writeJsonl([
    '{"type":"session","version":3}',
    message('user', 'm0'),
    message('assistant', 'm1'),
    '{"type":"model_change","model":"x"}',
    message('user', 'm2'),
    message('assistant', 'm3'),
    message('user', 'm4'),
  ], tag);
}

function texts(window) {
  return window.messages.map((m) => m.content[0].text);
}

/** A fresh `remote.json` config dir; returns the directory. */
function configDir(tag) {
  const dir = makeTestDir(`cfg_${tag}`);
  process.env.OMP_PORT_CONFIG_DIR = dir;
  return dir;
}

after(() => {
  if (originalConfigDir === undefined) delete process.env.OMP_PORT_CONFIG_DIR;
  else process.env.OMP_PORT_CONFIG_DIR = originalConfigDir;
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── remote_transcript.rs ───────────────────────────────────────────────────

test('newest_window_reports_older_rows_and_a_cursor', () => {
  const file = fixture('window');
  const window = transcriptWindow(file, null, 2);

  assert.deepEqual(texts(window), ['m3', 'm4']);
  assert.equal(window.hasOlder, true);
  assert.equal(window.nextBefore, 3);
});

test('head_window_has_no_older_rows', () => {
  const file = fixture('head');
  const first = transcriptWindow(file, 3, 3);

  assert.deepEqual(texts(first), ['m0', 'm1', 'm2']);
  assert.equal(first.hasOlder, false);
  assert.equal(first.nextBefore, 0);
});

test('cursor_pages_walk_the_file_backwards', () => {
  const file = fixture('cursor');
  const newest = transcriptWindow(file, null, 2);
  const middle = transcriptWindow(file, newest.nextBefore, 2);
  const oldest = transcriptWindow(file, middle.nextBefore, 2);

  assert.deepEqual(texts(newest), ['m3', 'm4']);
  assert.deepEqual(texts(middle), ['m1', 'm2']);
  assert.deepEqual(texts(oldest), ['m0']);
  assert.equal(middle.hasOlder, true);
  assert.equal(middle.nextBefore, 1);
  assert.equal(oldest.hasOlder, false);
  assert.equal(oldest.nextBefore, 0);
  // The cursor is absolute: appending to the file does not drift it.
  fs.appendFileSync(file, `${message('user', 'm5')}\n`);
  const again = transcriptWindow(file, newest.nextBefore, 2);
  assert.deepEqual(texts(again), ['m1', 'm2']);
});

test('before_beyond_the_row_count_clamps_to_the_newest_page', () => {
  const file = fixture('clamp');
  const window = transcriptWindow(file, 9999, 2);

  assert.deepEqual(texts(window), ['m3', 'm4']);
  assert.equal(window.hasOlder, true);
  assert.equal(window.nextBefore, 3);
});

test('long_text_block_is_capped_and_the_rest_is_verbatim', () => {
  const long = 'x'.repeat(MAX_BLOCK_CHARS + 500);
  const line = JSON.stringify({
    message: {
      content: [
        { annotations: ['keep'], text: long, type: 'text' },
        { thinking: 'short', type: 'thinking' },
        { content: 'y'.repeat(MAX_BLOCK_CHARS + 1), type: 'toolResult' },
        { annotations: ['untouched'], text: long, type: 'image' },
      ],
      role: 'assistant',
    },
    type: 'message',
  });
  const file = writeJsonl([line], 'cap');

  const window = transcriptWindow(file, null, DEFAULT_LIMIT);
  const blocks = window.messages[0].content;
  const text = blocks[0].text;
  const suffixChars = [...TRUNCATION_SUFFIX].length;

  assert.ok(text.endsWith(TRUNCATION_SUFFIX));
  assert.equal([...text].length, MAX_BLOCK_CHARS + suffixChars);
  assert.deepEqual(blocks[0].annotations, ['keep']);
  assert.equal(blocks[1].thinking, 'short');
  // toolResult caps its `content` string...
  assert.equal([...blocks[2].content].length, MAX_BLOCK_CHARS + suffixChars);
  // ...and non-text block types pass through untouched.
  assert.equal(blocks[3].text, long);
});

test('scanner_reads_omp_key_order_and_string_traps', () => {
  const scan = (line) => isMessageRow(Buffer.from(line, 'utf8'));

  // omp serializes keys alphabetically: the nested content block's `type`
  // precedes the row's own. A `"type"` inside a string value must not count.
  assert.equal(scan('{"message":{"content":[{"type":"text","text":"x"}],"role":"user"},"type":"message"}'), true);
  assert.equal(scan('{"type":"message","message":{"role":"user","content":[{"type":"text","text":"a \\"type\\": \\"toolResult\\" trap"}]}}'), true);
  assert.equal(scan('{"type":"model_change","model":"x"}'), false);
  assert.equal(scan('{"type":"session","version":3}'), false);
  assert.equal(scan('{"message":{"content":[{"type":"text"}]},"type":"toolResult"}'), false);
  assert.equal(scan('not json at all'), false);
  // A nested object's `type` is never the row's.
  assert.equal(scan('{"message":{"type":"message"}}'), false);
  // Multi-byte text (bytes, not UTF-16 units, drive the scan).
  assert.equal(scan('{"message":{"content":[{"type":"text","text":"日本語 type"}]},"type":"message"}'), true);
  // The terminator is part of the line, exactly like read_until.
  assert.equal(scan(`${message('user', 'm0')}\n`), true);
});

test('window_reads_rows_written_in_omp_key_order', () => {
  const rows = Array.from({ length: 5 }, (_, n) => JSON.stringify({
    message: { content: [{ text: `m${n}`, type: 'text' }], role: 'user' },
    type: 'message',
  }));
  const file = writeJsonl(rows, 'omp-order');

  const window = transcriptWindow(file, null, 2);

  assert.deepEqual(texts(window), ['m3', 'm4']);
  assert.equal(window.hasOlder, true);
  assert.equal(window.nextBefore, 3);
});

test('window_sheds_oldest_rows_to_fit_the_wire_budget', () => {
  // Five rows of sixteen capped blocks each (~64 KB apiece after capping):
  // the whole window is over the wire budget, so the oldest rows are shed
  // while the newest survives.
  const fat = 'y'.repeat(MAX_BLOCK_CHARS + 10);
  const blocks = Array.from({ length: 16 }, () => ({ text: fat, type: 'text' }));
  const rows = Array.from({ length: 5 }, (_, n) => JSON.stringify({
    message: { content: blocks, index: n, role: 'user' },
    type: 'message',
  }));
  const file = writeJsonl(rows, 'budget');

  const window = transcriptWindow(file, null, 5);
  const bytes = window.messages
    .reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m), 'utf8'), 0);

  assert.ok(bytes <= MAX_WINDOW_BYTES, `window over budget: ${bytes}`);
  assert.ok(window.messages.length < 5, 'nothing was shed');
  assert.equal(window.hasOlder, true);
  // The newest row always survives: shedding stops at one row.
  assert.equal(window.messages[window.messages.length - 1].index, 4);
  assert.equal(window.nextBefore, 5 - window.messages.length);
});

test('damaged_rows_do_not_hide_the_rest_of_the_history', () => {
  const brokenUtf8 = Buffer.concat([
    Buffer.from('{"type":"message","message":{"content":[{"type":"text","text":"'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('"}]}}\n'),
  ]);
  const truncated = '{"type":"message","message":{"content":[';
  const bytes = Buffer.concat([
    Buffer.from(`${message('user', 'm0')}\n${message('assistant', 'm1')}\n`),
    brokenUtf8,
    Buffer.from(`${truncated}\n${message('user', 'm2')}\n`),
  ]);
  const file = writeJsonl(bytes, 'damaged');

  // The scan skips the non-UTF-8 line outright; the truncated line passes the
  // parse-free scanner (its `type` arrives before the damage) and is then
  // skipped by the JSON parse — the Rust behaviour, slot and all.
  const newest = transcriptWindow(file, null, 1);
  assert.deepEqual(texts(newest), ['m2']);

  // The older pages are unaffected by the damage.
  const head = transcriptWindow(file, 2, 2);
  assert.deepEqual(texts(head), ['m0', 'm1']);
  assert.equal(head.hasOlder, false);
  assert.equal(head.nextBefore, 0);
});

test('default_limit_and_max_limit_match_the_rust_clamps', () => {
  const many = Array.from({ length: 250 }, (_, n) => message('user', `m${n}`));
  const file = writeJsonl(many, 'default-limit');

  const window = transcriptWindow(file);
  assert.equal(window.messages.length, DEFAULT_LIMIT);
  assert.equal(window.hasOlder, true);
  assert.equal(window.nextBefore, 50);

  const wide = Array.from({ length: 1100 }, (_, n) => message('user', `m${n}`));
  const big = writeJsonl(wide, 'max-limit');
  const capped = transcriptWindow(big, null, 5000);
  assert.equal(capped.messages.length, MAX_LIMIT);
  assert.equal(capped.nextBefore, 100);

  // A zero/negative page is clamped up to one row, never an infinite page.
  assert.equal(transcriptWindow(file, null, 0).messages.length, 1);
  assert.equal(transcriptWindow(file, null, -5).messages.length, 1);
});

test('missing_file_errors', () => {
  const missing = path.join(makeTestDir('missing'), 'nope.jsonl');

  assert.throws(() => transcriptWindow(missing, null, 1), (err) => {
    assert.match(err.message, /^open /);
    assert.ok(err.message.includes(missing), `unexpected error: ${err.message}`);
    return true;
  });
});

// ── remote_replay.rs ───────────────────────────────────────────────────────

function event(seq, text) {
  return { seq, text };
}

test('rpc_chunk_events_are_dropped', () => {
  const hi = '{"type":"message","text":"hi"}';
  const projected = replayProject({
    events: [
      event(1, hi),
      event(2, '{"type":"rpc_chunk","id":"r1","index":0}'),
      event(3, '{"type":"stdout","line":"$ ls"}'),
    ],
    headSeq: 3,
    dropped: false,
  });

  assert.deepEqual(projected.events.map((e) => e.seq), [1, 3]);
  assert.equal(projected.events[0].text, hi);
  assert.equal(projected.dropped, false);
  assert.equal(projected.headSeq, 3);
});

test('unparseable_text_is_kept', () => {
  const raw = 'not json at all';
  const projected = replayProject({
    events: [
      event(1, raw),
      event(2, '["rpc_chunk"]'),
      event(3, '{"type":"rpc_chunk"'),
      event(4, '{"type":"rpc_chunk"}'),
    ],
    headSeq: 4,
    dropped: false,
  });

  assert.deepEqual(projected.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(projected.events[0].text, raw);
});

test('cap_keeps_newest_400_and_sets_dropped', () => {
  const events = Array.from(
    { length: MAX_PROJECTED_EVENTS + 100 },
    (_, n) => event(n + 1, JSON.stringify({ type: 'message', seq: n + 1 })),
  );
  const projected = replayProject({ events, headSeq: 500, dropped: false });

  assert.equal(projected.events.length, MAX_PROJECTED_EVENTS);
  assert.equal(projected.events[0].seq, 101);
  assert.equal(projected.events[projected.events.length - 1].seq, 500);
  assert.equal(projected.dropped, true);
});

test('exactly_400_events_do_not_set_dropped', () => {
  const events = Array.from(
    { length: MAX_PROJECTED_EVENTS },
    (_, n) => event(n + 1, JSON.stringify({ type: 'message', seq: n + 1 })),
  );
  const projected = replayProject({ events, headSeq: 400, dropped: false });

  assert.equal(projected.events.length, MAX_PROJECTED_EVENTS);
  assert.equal(projected.dropped, false);
});

test('cap_counts_only_kept_events', () => {
  // 500 chunks followed by 500 messages: the chunks must not consume any of
  // the 400 slots.
  const events = Array.from({ length: 1000 }, (_, n) => {
    const seq = n + 1;
    return seq <= 500
      ? event(seq, JSON.stringify({ type: 'rpc_chunk', index: seq }))
      : event(seq, JSON.stringify({ type: 'message', seq }));
  });
  const projected = replayProject({ events, headSeq: 1000, dropped: false });

  assert.equal(projected.events.length, MAX_PROJECTED_EVENTS);
  assert.equal(projected.events[0].seq, 601);
  assert.equal(projected.dropped, true);
});

test('dropped_passes_through', () => {
  const projected = replayProject({
    events: [
      event(1, '{"type":"stdout","line":"a"}'),
      event(2, '{"type":"stdout","line":"b"}'),
    ],
    headSeq: 2,
    dropped: true,
  });

  assert.deepEqual(projected.events.map((e) => e.seq), [1, 2]);
  assert.equal(projected.dropped, true);
});

test('head_seq_is_untouched', () => {
  const projected = replayProject({
    events: [event(7, '{"type":"rpc_chunk","id":"r"}')],
    headSeq: 9,
    dropped: false,
  });

  assert.equal(projected.headSeq, 9);
  assert.deepEqual(projected.events, []);
});

test('empty_replay_stays_empty', () => {
  const projected = replayProject({ events: [], headSeq: 0, dropped: false });

  assert.deepEqual(projected.events, []);
  assert.equal(projected.headSeq, 0);
  assert.equal(projected.dropped, false);
});

test('journal_ring_form_filters_by_after_seq_like_since', () => {
  const ring = Array.from({ length: 5 }, (_, n) => event(n + 1, JSON.stringify({
    type: n % 2 === 1 ? 'rpc_chunk' : 'message',
    seq: n + 1,
  })));

  const projected = replayProject(ring, 0);
  assert.deepEqual(projected.events.map((e) => e.seq), [1, 3, 5]);
  assert.equal(projected.headSeq, 5);
  assert.equal(projected.dropped, false);

  const tail = replayProject(ring, 2);
  assert.deepEqual(tail.events.map((e) => e.seq), [3, 5]);
  assert.equal(tail.dropped, false);

  const done = replayProject(ring, 5);
  assert.deepEqual(done.events, []);
  assert.equal(done.headSeq, 5);
  assert.equal(done.dropped, false);
});

test('journal_ring_form_reports_a_sequence_gap_as_dropped', () => {
  const ring = [5, 6, 7].map((seq) => event(seq, JSON.stringify({ type: 'message', seq })));

  const projected = replayProject(ring, 1);
  assert.equal(projected.dropped, true, 'oldest > afterSeq + 1 means eviction');
  assert.deepEqual(projected.events.map((e) => e.seq), [5, 6, 7]);

  const contiguous = replayProject(ring, 4);
  assert.equal(contiguous.dropped, false);
});

// ── remote_dirs.rs ─────────────────────────────────────────────────────────

/** Create `dirs` under a fresh root plus a stray file; returns the root. */
function dirTree(tag, dirs) {
  const rootDir = makeTestDir(tag);
  for (const dir of dirs) fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
  return rootDir;
}

test('lists_subdirectories_sorted_case_insensitively', () => {
  const rootDir = dirTree('sorted', ['Beta', 'alpha', 'Gamma', 'delta']);
  fs.writeFileSync(path.join(rootDir, 'not-a-dir.txt'), 'x');

  const listing = listDirs(rootDir);

  assert.deepEqual(listing.entries.map((e) => e.name), ['alpha', 'Beta', 'delta', 'Gamma']);
  assert.equal(listing.parent, path.dirname(rootDir));
  assert.equal(listing.entries[0].path, path.join(rootDir, 'alpha'));
});

test('skips_dot_directories', () => {
  const rootDir = dirTree('hidden', ['.git', 'src']);

  const listing = listDirs(rootDir);

  assert.deepEqual(listing.entries.map((e) => e.name), ['src']);
});

test('follows_a_symlinked_directory', () => {
  const rootDir = dirTree('symlink', ['real']);
  fs.symlinkSync(path.join(rootDir, 'real'), path.join(rootDir, 'link'), 'dir');
  fs.symlinkSync(path.join(rootDir, 'absent'), path.join(rootDir, 'dangling'), 'dir');

  const listing = listDirs(rootDir);

  // `Path::is_dir()` follows symlinks: the linked dir is browsable, the
  // dangling one is not.
  assert.deepEqual(listing.entries.map((e) => e.name), ['link', 'real']);
});

test('missing_path_is_an_error', () => {
  const target = path.join(makeTestDir('missing-dir'), 'nope');

  assert.throws(() => listDirs(target), (err) => {
    assert.ok(err.message.includes(target), `unexpected error: ${err.message}`);
    return true;
  });
});

test('file_path_is_an_error', () => {
  const rootDir = dirTree('file', []);
  const file = path.join(rootDir, 'plain.txt');
  fs.writeFileSync(file, 'x');

  assert.throws(() => listDirs(file), /not a directory/);
});

test('roots_listing_has_no_parent_and_entries_exist', () => {
  const listing = listDirs(null);

  assert.equal(listing.parent, null);
  assert.notEqual(listing.entries.length, 0);
  assert.ok(listing.entries.every((entry) => fs.statSync(entry.path).isDirectory()));
  assert.equal(listing.entries[0].path, '/');
  assert.equal(listing.entries[0].name, '/');
  assert.ok(listing.entries.some((entry) => entry.path === '/Users'));
  if (process.env.HOME) {
    assert.ok(listing.entries.some((entry) => entry.path === process.env.HOME));
  }
  const paths = listing.entries.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, 'roots are deduplicated');
});

test('caps_entries_at_500', () => {
  const rootDir = makeTestDir('cap');
  for (let i = 0; i <= MAX_ENTRIES; i += 1) {
    fs.mkdirSync(path.join(rootDir, `d${String(i).padStart(3, '0')}`));
  }

  const listing = listDirs(rootDir);

  assert.equal(listing.entries.length, MAX_ENTRIES);
  assert.equal(listing.entries[0].name, 'd000');
  assert.equal(listing.entries[MAX_ENTRIES - 1].name, 'd499');
});

// ── remote/settings.rs ─────────────────────────────────────────────────────

test('settings_roundtrip_via_json', () => {
  const dir = configDir('roundtrip');
  const saved = remoteSettingsSave({
    enabled: true,
    server: 'https://relay.example.com',
    device_id: 'aa',
    device_token: 'bb',
    pinned_cert_pem: 'PEM',
    device_name: 'My PC',
    phones: { b: { ms: 'c2VjcmV0' }, a: { ms: null } },
  });

  assert.deepEqual(saved, {
    enabled: true,
    server: 'https://relay.example.com',
    device_id: 'aa',
    device_token: 'bb',
    pinned_cert_pem: 'PEM',
    device_name: 'My PC',
    phones: { a: { ms: null }, b: { ms: 'c2VjcmV0' } },
  });
  assert.equal(remoteSettingsPath(), path.join(dir, 'remote.json'));

  // serde_json's pretty shape: struct field order, 2-space indent, no
  // trailing newline, phones sorted like the BTreeMap.
  const expected = JSON.stringify({
    enabled: true,
    server: 'https://relay.example.com',
    device_id: 'aa',
    device_token: 'bb',
    pinned_cert_pem: 'PEM',
    device_name: 'My PC',
    phones: { a: { ms: null }, b: { ms: 'c2VjcmV0' } },
  }, null, 2);
  assert.equal(fs.readFileSync(remoteSettingsPath(), 'utf8'), expected);

  assert.deepEqual(remoteSettingsLoad(), saved);
  assert.equal(phoneMs('b'), 'c2VjcmV0');
});

test('legacy_and_unknown_fields_load_with_serde_defaults', () => {
  configDir('legacy');
  // An old remote.json without `device_name` and without `phones` still
  // loads; unknown keys are dropped like serde ignores them.
  fs.writeFileSync(remoteSettingsPath(), JSON.stringify({
    enabled: true,
    server: 'https://x',
    device_id: 'aa',
    device_token: 'bb',
    pinned_cert_pem: '',
    future_field: 7,
  }));

  const settings = remoteSettingsLoad();

  assert.deepEqual(settings, {
    enabled: true,
    server: 'https://x',
    device_id: 'aa',
    device_token: 'bb',
    pinned_cert_pem: '',
    device_name: '',
    phones: {},
  });
  assert.equal('future_field' in settings, false);
});

test('save_merges_phones_and_ignores_unknown_patch_fields', () => {
  configDir('merge');
  remoteSettingsSave({ phones: { p1: { ms: 'M1' } } });
  const saved = remoteSettingsSave({ bogus: true, phones: { p2: { ms: 'M2' } } });

  assert.deepEqual(saved.phones, { p1: { ms: 'M1' }, p2: { ms: 'M2' } });
  assert.equal('bogus' in saved, false);
  assert.deepEqual(remoteSettingsLoad().phones, { p1: { ms: 'M1' }, p2: { ms: 'M2' } });
});

test('phone_ms_skips_pre_v2_entries_and_unknown_phones', () => {
  configDir('phone-ms');
  fs.writeFileSync(remoteSettingsPath(), JSON.stringify({
    enabled: true,
    server: 'https://x',
    device_id: 'aa',
    device_token: 'bb',
    phones: { aabb: { ms: 'c2VjcmV0' }, ccdd: {} },
  }));

  assert.equal(phoneMs('aabb'), 'c2VjcmV0');
  assert.equal(phoneMs('ccdd'), null); // pre-v2 entry: no ms
  assert.equal(phoneMs('nobody'), null); // unknown phone
});

test('malformed_file_reads_as_defaults_and_the_next_save_replaces_it', () => {
  configDir('malformed');
  const stderrWrite = process.stderr.write;
  let logged = '';
  process.stderr.write = (chunk) => {
    logged += String(chunk);
    return true;
  };
  try {
    fs.writeFileSync(remoteSettingsPath(), 'not json at all');
    assert.deepEqual(remoteSettingsLoad(), {
      enabled: false,
      server: '',
      device_id: '',
      device_token: '',
      pinned_cert_pem: '',
      device_name: '',
      phones: {},
    });
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.match(logged, /unreadable, reading as empty/);

  const saved = remoteSettingsSave({ server: 'https://x' });
  assert.equal(saved.server, 'https://x');
  assert.equal(JSON.parse(fs.readFileSync(remoteSettingsPath(), 'utf8')).server, 'https://x');
});

test('save_rejects_a_bad_patch', () => {
  configDir('bad-patch');

  assert.throws(() => remoteSettingsSave({ enabled: 'yes' }), TypeError);
  assert.throws(() => remoteSettingsSave({ phones: { p: 'M1' } }), TypeError);
  assert.throws(() => remoteSettingsSave({ phones: { p: { ms: 42 } } }), TypeError);
});

test('save_is_atomic_and_leaves_no_temp_file', () => {
  const dir = configDir('atomic');

  remoteSettingsSave({ server: 'https://x' });

  assert.deepEqual(fs.readdirSync(dir), ['remote.json']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(remoteSettingsPath(), 'utf8')));
  assert.equal(remoteSettingsLoad().server, 'https://x');
  // `stores` resolves the same config home the module writes into.
  assert.equal(dir, stores.configHome());
});

// ── result ────────────────────────────────────────────────────────────────

console.log('port-remote-files: 35 parity tests across 4 modules');