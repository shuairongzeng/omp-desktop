/* Port parity tests for electron/backend/saved-sessions.js.

   Mirrors src-tauri/src/saved_sessions/tests.rs (scan/parse half) plus the
   list_saved_sessions command wrapper. Run:

     node tests/port-saved-sessions.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/saved-sessions.js';

const {
  listSavedSessions,
  scanDir,
  parseSessionFile,
  extractTextFromContent,
  matchSnippet,
  canonicalIdFromStem,
  sessionsRootFor,
} = backend;

const scratchDirs = [];

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_test_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(''));
  return filePath;
}

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sessions tree shaped like the real one: `root/<folder>/<file>.jsonl`. */
function makeSessionFile(root, folder, file, lines) {
  return writeJsonl(path.join(root, folder, file), lines);
}

// ── parse_session_file ─────────────────────────────────────────────────────

test('parses_session_file_with_fallback_title', async () => {
  const dir = makeTestDir('fallback');
  const filePath = writeJsonl(path.join(dir, 'test_session.jsonl'), [
    '{"type":"title","v":1,"title":""}',
    '{"type":"session","version":3,"id":"sess-123","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/project"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"What is quantum computing?"}]}}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Quantum computing is..."}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session, 'parsed session');
  assert.equal(session.id, 'sess-123');
  assert.equal(session.title, 'What is quantum computing?');
  assert.equal(session.cwd, '/test/project');
  assert.equal(session.projectName, 'project');
  assert.equal(session.messageCount, 2);
  assert.equal(session.preview, 'Quantum computing is...');
  assert.equal(session.updatedAt, null);
  assert.equal(session.matchSnippet, null);
  assert.equal(session.path, filePath);
});

test('parse_session_file_prefers_filename_uuid_over_stale_body_id', async () => {
  const dir = makeTestDir('filename_uuid');
  const filePath = writeJsonl(
    path.join(dir, '2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl'),
    [
      '{"type":"title","v":1,"title":""}',
      '{"type":"session","version":3,"id":"stale-body-id","timestamp":"2026-09-12T18:16:44.966Z","cwd":"/test/project"}',
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    ],
  );

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.id, '01a096d6-0aa6-75d7-804c-088913a441e6');
});

test('parses_session_file_with_explicit_title', async () => {
  const dir = makeTestDir('explicit');
  const filePath = writeJsonl(path.join(dir, 'test_explicit.jsonl'), [
    '{"type":"title","v":1,"title":"Custom Topic Title","updatedAt":"2026-09-04T01:00:00.000Z"}',
    '{"type":"session","version":3,"id":"sess-456","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/another"}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.id, 'sess-456');
  assert.equal(session.title, 'Custom Topic Title');
  assert.equal(session.updatedAt, '2026-09-04T01:00:00.000Z');
});

test('parse_session_file_last_activity_tracks_latest_message_not_creation', async () => {
  const dir = makeTestDir('last_activity_no_title');
  const filePath = writeJsonl(path.join(dir, 'test_last_activity.jsonl'), [
    '{"type":"session","version":3,"id":"sess-789","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/three"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-04T00:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-06T12:30:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still here two days later"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.timestamp, '2026-09-04T00:00:00.000Z');
  assert.equal(session.updatedAt, '2026-09-06T12:30:00.000Z');
});

test('parse_session_file_last_activity_beats_a_stale_title_rename', async () => {
  const dir = makeTestDir('last_activity_stale_title');
  const filePath = writeJsonl(path.join(dir, 'test_stale_title.jsonl'), [
    '{"type":"title","v":1,"title":"Early topic","updatedAt":"2026-09-04T00:00:10.000Z"}',
    '{"type":"session","version":3,"id":"sess-321","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/four"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-08T09:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"back after a few days"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.updatedAt, '2026-09-08T09:00:00.000Z');
});

test('parse_session_file_last_activity_later_retitle_on_first_line_wins', async () => {
  const dir = makeTestDir('last_activity_later_retitle_first_line');
  const filePath = writeJsonl(path.join(dir, 'test_retitle_first_line.jsonl'), [
    '{"type":"title","v":1,"title":"Renamed later","updatedAt":"2026-09-10T08:00:00.000Z"}',
    '{"type":"session","version":3,"id":"sess-999","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/six"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-08T09:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"earlier than the rename"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.updatedAt, '2026-09-10T08:00:00.000Z');
});

test('parse_session_file_ignores_lifecycle_events_for_last_activity', async () => {
  const dir = makeTestDir('ignores_lifecycle');
  const filePath = writeJsonl(path.join(dir, 'test_lifecycle.jsonl'), [
    '{"type":"session","version":3,"id":"sess-654","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/five"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-04T00:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"the real last message"}]}}',
    '{"type":"model_change","id":"mc1","parentId":"m1","timestamp":"2026-09-20T00:00:00.000Z","model":"foo","role":"main"}',
    '{"type":"custom","customType":"session_exit","id":"c1","parentId":"mc1","timestamp":"2026-09-20T00:00:01.000Z"}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.updatedAt, '2026-09-04T00:05:00.000Z');
});

test('parse_session_file_returns_none_without_id_or_timestamp', async () => {
  const dir = makeTestDir('no_id');
  const filePath = writeJsonl(path.join(dir, 'headerless.jsonl'), [
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.equal(session, null);

  const missing = await parseSessionFile(path.join(dir, 'does-not-exist.jsonl'));
  assert.equal(missing.session, null);
});

test('parse_session_file_tolerates_malformed_json_lines', async () => {
  const dir = makeTestDir('malformed');
  const filePath = writeJsonl(path.join(dir, 'mixed.jsonl'), [
    'not json at all {{{',
    '',
    '{"type":"session","version":3,"id":"sess-789","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/x"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"still works"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session, 'parsed despite malformed lines');
  assert.equal(session.id, 'sess-789');
  assert.equal(session.messageCount, 1);
});

test('excludes_tool_result_messages_from_count_and_preview', async () => {
  const dir = makeTestDir('toolresult');
  const filePath = writeJsonl(path.join(dir, 'with_tool.jsonl'), [
    '{"type":"session","version":3,"id":"sess-tool","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/test/tool"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"read this file"}]}}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Sure, reading now."}]}}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"raw file bytes / bash output"}]}}',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.messageCount, 2);
  assert.equal(session.preview, 'Sure, reading now.');
});

test('extract_text_from_content_handles_array_and_string_blocks', () => {
  assert.equal(extractTextFromContent([{ type: 'text', text: '  hello  ' }]), 'hello');
  assert.equal(extractTextFromContent('  plain string  '), 'plain string');
  assert.equal(extractTextFromContent([{ type: 'text', text: '   ' }]), null);
  assert.equal(extractTextFromContent([{ type: 'tool_use' }]), null);
  // A blank text block is skipped, a later non-blank one still wins.
  assert.equal(
    extractTextFromContent([{ type: 'text', text: ' ' }, { type: 'text', text: 'second' }]),
    'second',
  );
  assert.equal(extractTextFromContent(undefined), null);
});

test('preview_and_fallback_title_truncate_at_char_caps', async () => {
  const dir = makeTestDir('caps');
  const user70 = 'u'.repeat(70);
  const assistant130 = 'a'.repeat(130);
  const filePath = writeJsonl(path.join(dir, 'caps.jsonl'), [
    '{"type":"session","version":3,"id":"caps","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
    `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${user70}"}]}}`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${assistant130}"}]}}`,
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.title, `${'u'.repeat(60)}…`, 'fallback title caps at 60 chars');
  assert.equal(session.preview, `${'a'.repeat(120)}…`, 'preview caps at 120 chars');

  // Exactly-at-cap text is not ellipsised.
  const exact = writeJsonl(path.join(dir, 'exact.jsonl'), [
    '{"type":"session","version":3,"id":"exact","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
    `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${'b'.repeat(60)}"}]}}`,
  ]);
  const { session: exactSession } = await parseSessionFile(exact);
  assert.equal(exactSession.title, 'b'.repeat(60));
});

test('untitled_conversation_and_default_project_fill_empty_fields', async () => {
  const dir = makeTestDir('untitled');
  const filePath = writeJsonl(path.join(dir, 'bare.jsonl'), [
    '{"type":"session","version":3,"id":"bare","timestamp":"2026-09-04T00:00:00.000Z"}',
  ]);
  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.title, 'Untitled conversation');
  assert.equal(session.cwd, '');
  assert.equal(session.projectName, 'Default');
  assert.equal(session.messageCount, 0);
  assert.equal(session.preview, null);
});

// ── canonical ids ──────────────────────────────────────────────────────────

test('canonical_id_from_stem_extracts_uuid_from_real_shaped_filename', () => {
  assert.equal(
    canonicalIdFromStem(
      '/home/user/.omp/agent/sessions/-devel-project/2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl',
    ),
    '01a096d6-0aa6-75d7-804c-088913a441e6',
  );
});

test('canonical_id_from_stem_returns_none_without_underscore', () => {
  assert.equal(canonicalIdFromStem('sess-123.jsonl'), null);
});

test('canonical_id_from_stem_returns_none_for_invalid_uuid_characters', () => {
  assert.equal(canonicalIdFromStem('2026-09-12T18-16-44-966Z_not a valid uuid.jsonl'), null);
  assert.equal(
    canonicalIdFromStem('2026-09-12T18-16-44-966Z_01a096d6@0aa6-75d7-804c-088913a441e6.jsonl'),
    null,
  );
});

// ── sessions-root resolution ───────────────────────────────────────────────

test('pi_coding_agent_dir_applies_to_the_builtin_profile_only', () => {
  const home = '/home/u';
  const env = '/custom/agent';

  assert.equal(sessionsRootFor(home, null, env), '/custom/agent/sessions');
  assert.equal(sessionsRootFor(home, 'work', env), '/home/u/.omp/profiles/work/agent/sessions');
  assert.equal(sessionsRootFor(home, null, null), '/home/u/.omp/agent/sessions');
  assert.equal(sessionsRootFor(home, null, ''), '/home/u/.omp/agent/sessions');
});

test('an_empty_profile_id_reads_the_builtin_tree_like_omp_args_writes_it', () => {
  const home = '/home/u';
  assert.equal(sessionsRootFor(home, '', null), '/home/u/.omp/agent/sessions');
  assert.equal(sessionsRootFor(home, '', '/custom/agent'), '/custom/agent/sessions');
});

// ── scan_dir ───────────────────────────────────────────────────────────────

test('scan_dir_missing_root_returns_empty', async () => {
  const root = path.join(os.tmpdir(), 'omp_test_does_not_exist_ever_port');
  assert.deepEqual(await scanDir(root, null, null), []);
});

test('scan_dir_filters_by_cwd_and_sorts_newest_first', async () => {
  const root = makeTestDir('scan_root');

  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"a","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/one"}',
  ]);
  makeSessionFile(root, 'sess-b', 'b.jsonl', [
    '{"type":"session","version":3,"id":"b","timestamp":"2026-09-03T00:00:00.000Z","cwd":"/proj/two"}',
  ]);
  makeSessionFile(root, 'sess-c', 'c.jsonl', [
    '{"type":"session","version":3,"id":"c","timestamp":"2026-09-02T00:00:00.000Z","cwd":"/proj/one"}',
  ]);

  const all = await scanDir(root, null, null);
  assert.deepEqual(all.map((s) => s.id), ['b', 'c', 'a']);

  const filtered = await scanDir(root, '/proj/one', null);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((s) => s.cwd === '/proj/one'));

  // Filter is case- and slash-insensitive.
  const filteredWin = await scanDir(root, '\\PROJ\\ONE\\', null);
  assert.equal(filteredWin.length, 2);
});

test('scan_dir_sorts_by_last_activity_not_creation_date', async () => {
  const root = makeTestDir('scan_activity_root');

  makeSessionFile(root, 'sess-old', 'old.jsonl', [
    '{"type":"session","version":3,"id":"old","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/one"}',
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-10T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"resumed much later"}]}}',
  ]);
  makeSessionFile(root, 'sess-new', 'new.jsonl', [
    '{"type":"session","version":3,"id":"new","timestamp":"2026-09-05T00:00:00.000Z","cwd":"/proj/two"}',
  ]);

  const all = await scanDir(root, null, null);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'old');
  assert.equal(all[1].id, 'new');
});

test('scan_dir_skips_the_trash_folder_and_root_files', async () => {
  const root = makeTestDir('scan_trash');
  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"a","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/one"}',
  ]);
  makeSessionFile(root, '.trash', 'a.jsonl', [
    '{"type":"session","version":3,"id":"trashed","timestamp":"2026-09-09T00:00:00.000Z","cwd":"/proj/one"}',
  ]);
  writeJsonl(path.join(root, 'stray.jsonl'), [
    '{"type":"session","version":3,"id":"stray","timestamp":"2026-09-09T00:00:00.000Z","cwd":"/proj/one"}',
  ]);
  // Non-jsonl files are ignored.
  writeJsonl(path.join(root, 'sess-a', 'notes.txt'), ['{}']);

  const all = await scanDir(root, null, null);
  assert.deepEqual(all.map((s) => s.id), ['a']);
});

// ── query search ───────────────────────────────────────────────────────────

test('query_matches_message_text_case_insensitively_with_snippet', async () => {
  const root = makeTestDir('query_hit');
  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"title","v":1,"title":"unrelated","updatedAt":"2026-09-04T00:00:00.000Z"}',
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Please help me Fix the RaIl problem"}]}}',
  ]);

  const hit = await scanDir(root, null, 'rail problem');
  assert.equal(hit.length, 1, 'case-insensitive text match');
  assert.ok(hit[0].matchSnippet, 'snippet set');
  assert.ok(
    hit[0].matchSnippet.toLowerCase().includes('rail problem'),
    `snippet contains the hit: ${hit[0].matchSnippet}`,
  );

  assert.deepEqual(await scanDir(root, null, 'nonexistent phrase'), [], 'non-matching dropped');
});

test('query_matching_only_title_keeps_preview_without_snippet', async () => {
  const root = makeTestDir('query_title');
  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"title","v":1,"title":"Deployment notes","updatedAt":"2026-09-04T00:00:00.000Z"}',
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"nothing relevant here"}]}}',
  ]);

  const hit = await scanDir(root, null, 'deployment');
  assert.equal(hit.length, 1, 'title match keeps the session');
  assert.equal(hit[0].matchSnippet, null, 'no text hit, no snippet');
  assert.ok(hit[0].preview, 'preview stays');
});

test('query_matches_project_and_cwd_fields', async () => {
  const root = makeTestDir('query_fields');
  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/work/MyProj"}',
  ]);

  const byProject = await scanDir(root, null, 'myproj');
  assert.equal(byProject.length, 1);
  assert.equal(byProject[0].matchSnippet, null);

  const byCwd = await scanDir(root, null, '/WORK/');
  assert.equal(byCwd.length, 1);
});

test('query_none_and_empty_behave_identically_and_unset_snippets', async () => {
  const root = makeTestDir('query_none');
  makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"title","v":1,"title":"t","updatedAt":"2026-09-04T00:00:00.000Z"}',
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
  ]);

  const none = await scanDir(root, null, null);
  const empty = await scanDir(root, null, '   ');
  assert.equal(none.length, 1);
  assert.equal(empty.length, 1);
  assert.equal(none[0].matchSnippet, null);
  assert.equal(empty[0].matchSnippet, null);
});

test('match_snippet_windows_around_the_hit', () => {
  const blob = 'aaa contextword bbb';
  assert.equal(matchSnippet(blob, 'contextword'), 'aaa contextword bbb');

  const long = `${'x'.repeat(300)}NEEDLE${'y'.repeat(300)}`;
  const snip = matchSnippet(long, 'NEEDLE');
  assert.ok(snip.includes('NEEDLE'));
  assert.ok(
    Array.from(snip).length < 100,
    `window is ~81 chars, got ${Array.from(snip).length}`,
  );
  assert.equal(matchSnippet(blob, 'zzz'), null);

  // Newlines inside the window collapse to spaces so the row stays one line.
  // (The blob is already lowercased by the collector; the caller lowercases
  // the needle, so the pair must match in case.)
  const multiline = 'first line\nsecond needle line\nthird';
  assert.equal(matchSnippet(multiline, 'needle'), 'first line second needle line third');
});

// ── list_saved_sessions wrapper ────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test('list_saved_sessions_reads_the_builtin_tree', async () => {
  const home = makeTestDir('list_builtin');
  makeSessionFile(path.join(home, '.omp', 'agent', 'sessions'), 'sess-a', 'a.jsonl', [
    '{"type":"title","v":1,"title":"builtin","updatedAt":"2026-09-04T00:00:00.000Z"}',
    '{"type":"session","version":3,"id":"a","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/a"}',
  ]);

  await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: undefined }, async () => {
    const rows = await listSavedSessions({ cwd: null, query: null, profile: 'default' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'builtin');

    const other = await listSavedSessions({ profile: 'default', cwd: '/proj/other' });
    assert.deepEqual(other, []);

    const queried = await listSavedSessions({ profile: null, query: 'builtin' });
    assert.equal(queried.length, 1);
  });
});

test('list_saved_sessions_honours_pi_coding_agent_dir_for_the_builtin_profile', async () => {
  const home = makeTestDir('list_env_home');
  const custom = makeTestDir('list_env_custom');
  makeSessionFile(path.join(custom, 'sessions'), 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"a","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/a"}',
  ]);

  await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: custom }, async () => {
    const rows = await listSavedSessions({ profile: 'default' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'a');
  });
});

test('list_saved_sessions_reads_a_named_profile_tree_and_ignores_the_env_override', async () => {
  const home = makeTestDir('list_named_home');
  const custom = makeTestDir('list_named_custom');
  makeSessionFile(
    path.join(home, '.omp', 'profiles', 'work', 'agent', 'sessions'),
    'sess-w',
    'w.jsonl',
    [
      '{"type":"session","version":3,"id":"w","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/w"}',
    ],
  );
  // A decoy tree under the env override must never be read for a named profile.
  makeSessionFile(path.join(custom, 'sessions'), 'sess-decoy', 'd.jsonl', [
    '{"type":"session","version":3,"id":"decoy","timestamp":"2026-09-09T00:00:00.000Z","cwd":"/proj/d"}',
  ]);

  await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: custom }, async () => {
    const rows = await listSavedSessions({ profile: 'work' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'w');
  });
});

test('list_saved_sessions_rejects_a_traversal_or_unknown_shaped_profile_id', async () => {
  await assert.rejects(
    () => listSavedSessions({ profile: '../../etc' }),
    /invalid profile id/,
  );
  await assert.rejects(
    () => listSavedSessions({ profile: 'Work' }),
    /invalid profile id/,
  );
});

test('list_saved_sessions_returns_every_project_when_cwd_is_null', async () => {
  const home = makeTestDir('list_all_projects');
  const sessions = path.join(home, '.omp', 'agent', 'sessions');
  makeSessionFile(sessions, 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"a","timestamp":"2026-09-01T00:00:00.000Z","cwd":"/proj/a"}',
  ]);
  makeSessionFile(sessions, 'sess-b', 'b.jsonl', [
    '{"type":"session","version":3,"id":"b","timestamp":"2026-09-02T00:00:00.000Z","cwd":"/proj/b"}',
  ]);

  await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: undefined }, async () => {
    const rows = await listSavedSessions({});
    assert.deepEqual(rows.map((row) => row.id), ['b', 'a']);
    assert.ok(rows.every((row) => row.matchSnippet === null));
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      [
        'cwd',
        'id',
        'matchSnippet',
        'messageCount',
        'path',
        'preview',
        'projectName',
        'timestamp',
        'title',
        'updatedAt',
      ].sort(),
      'camelCase shape the Rust command serializes',
    );
  });
});