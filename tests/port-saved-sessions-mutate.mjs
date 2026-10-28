/* Port parity tests for electron/backend/saved-sessions-mutate.js.

   Mirrors the history-governance cases of
   src-tauri/src/saved_sessions/tests.rs (delete / rename halves) plus the
   `delete_saved_session` / `rename_saved_session` command wrappers. Run:

     node tests/port-saved-sessions-mutate.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mutate from '../electron/backend/saved-sessions-mutate.js';
import read from '../electron/backend/saved-sessions.js';

const { deleteSavedSession, renameSavedSession, deleteSavedSessionAt, renameSavedSessionAt } =
  mutate;
const { listSavedSessions, parseSessionFile } = read;

const scratchDirs = [];

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_mutate_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

/** A sessions tree shaped like the real one: `root/<folder>/<file>.jsonl`. */
function makeSessionFile(root, folder, file, lines) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, file);
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(''));
  return filePath;
}

/** A minimal parsable session: title event first, session event second. */
function sessionLines(title) {
  return [
    `{"type":"title","v":1,"title":"${title}","updatedAt":"2026-09-04T00:00:00.000Z"}`,
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
  ];
}

const THIRD_LINE =
  '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

// ── delete ─────────────────────────────────────────────────────────────────

test('delete_moves_file_into_trash_and_hides_it_from_scan', async () => {
  const home = makeTestDir('del_home');
  const agentDir = makeTestDir('del_agent');
  const root = path.join(agentDir, 'sessions');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('t'));

  await withEnv(
    { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    async () => {
      assert.equal((await listSavedSessions({})).length, 1, 'listed before delete');

      assert.equal(await deleteSavedSession({ path: filePath, profile: null }), null);

      assert.equal(fs.existsSync(filePath), false, 'original file must be gone');
      const trash = path.join(root, 'sess-a', '.trash', 'a.jsonl');
      assert.ok(fs.existsSync(trash), 'file must live in .trash now');
      assert.deepEqual(await listSavedSessions({}), [], 'trashed session must not be listed');
    },
  );
});

test('delete_same_name_conflict_gets_a_numeric_suffix', async () => {
  const root = makeTestDir('del_conflict');
  const first = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('t'));
  await deleteSavedSessionAt(root, first);
  const second = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('t2'));
  await deleteSavedSessionAt(root, second);

  const trash = path.join(root, 'sess-a', '.trash');
  assert.ok(fs.existsSync(path.join(trash, 'a.jsonl')), 'first trash copy kept');
  assert.ok(fs.existsSync(path.join(trash, 'a.1.jsonl')), 'second copy suffixed');

  // A third delete gets the next free suffix, not an overwrite.
  const third = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('t3'));
  await deleteSavedSessionAt(root, third);
  assert.ok(fs.existsSync(path.join(trash, 'a.2.jsonl')), 'third copy suffixed again');
  assert.ok(
    fs.readFileSync(path.join(trash, 'a.jsonl'), 'utf8').includes('"title":"t"'),
    'earlier trash copies untouched',
  );
});

test('delete_rejects_path_outside_sessions_root', async () => {
  const root = makeTestDir('del_outside_root');
  const outsideDir = makeTestDir('del_outside_file');
  const outside = path.join(outsideDir, 'secret.jsonl');
  fs.writeFileSync(outside, '');

  await assert.rejects(
    () => deleteSavedSessionAt(root, outside),
    /outside the sessions directory/,
  );
  assert.ok(fs.existsSync(outside), 'the outside file must be untouched');
});

test('delete_rejects_a_symlink_escaping_the_sessions_root', async () => {
  const root = makeTestDir('del_symlink_root');
  const outsideDir = makeTestDir('del_symlink_target');
  const outside = path.join(outsideDir, 'target.jsonl');
  fs.writeFileSync(outside, '');
  const folder = path.join(root, 'sess-a');
  fs.mkdirSync(folder, { recursive: true });
  const link = path.join(folder, 'link.jsonl');
  fs.symlinkSync(outside, link);

  await assert.rejects(
    () => deleteSavedSessionAt(root, link),
    /outside the sessions directory/,
  );
  assert.ok(fs.existsSync(outside), 'the symlink target must be untouched');
});

test('delete_rejects_flag_like_path', async () => {
  const root = makeTestDir('del_flag');
  await assert.rejects(
    () => deleteSavedSessionAt(root, '--auto-approve'),
    /invalid session path: "--auto-approve"/,
  );
});

test('delete_rejects_non_jsonl_file_under_root', async () => {
  const root = makeTestDir('del_nonjsonl');
  const notJsonl = makeSessionFile(root, 'sess-a', 'a.txt', []);
  await assert.rejects(
    () => deleteSavedSessionAt(root, notJsonl),
    /not a \.jsonl session file/,
  );
  assert.ok(fs.existsSync(notJsonl), 'rejected file stays put');
});

test('delete_missing_file_reports_the_rust_error_string', async () => {
  const root = makeTestDir('del_missing');
  const missing = path.join(root, 'sess-a', 'gone.jsonl');
  await assert.rejects(
    () => deleteSavedSessionAt(root, missing),
    (err) => {
      assert.equal(
        err.message,
        `session path does not exist: "${missing}" (No such file or directory (os error 2))`,
      );
      return true;
    },
  );
});

test('delete_reports_an_unavailable_sessions_directory_like_rust', async () => {
  const missingRoot = path.join(makeTestDir('del_missing_root'), 'nope');
  const existing = path.join(makeTestDir('del_missing_root_file'), 'a.jsonl');
  fs.writeFileSync(existing, '');
  await assert.rejects(
    () => deleteSavedSessionAt(missingRoot, existing),
    (err) => {
      assert.equal(
        err.message,
        'sessions directory unavailable: No such file or directory (os error 2)',
      );
      return true;
    },
  );
});

// ── rename ─────────────────────────────────────────────────────────────────

test('rename_replaces_only_the_first_line_title', async () => {
  const root = makeTestDir('rename_ok');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', [...sessionLines('old title'), THIRD_LINE]);

  await renameSavedSessionAt(root, filePath, 'new title');

  const content = fs.readFileSync(filePath, 'utf8');
  const [firstLine, ...rest] = content.split('\n');
  // serde_json without `preserve_order` re-serializes with byte-sorted keys,
  // compact and with no trailing spaces.
  assert.equal(
    firstLine,
    '{"title":"new title","type":"title","updatedAt":"2026-09-04T00:00:00.000Z","v":1}',
  );
  const parsed = JSON.parse(firstLine);
  assert.equal(parsed.type, 'title');
  assert.equal(parsed.title, 'new title');
  assert.equal(parsed.updatedAt, '2026-09-04T00:00:00.000Z');
  assert.equal(parsed.v, 1);
  assert.deepEqual(rest, [
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-04T00:00:00.000Z","cwd":"/proj/x"}',
    THIRD_LINE,
    '',
  ]);

  const { session } = await parseSessionFile(filePath);
  assert.ok(session);
  assert.equal(session.title, 'new title');
});

test('rename_through_the_command_wrapper_updates_the_listed_row', async () => {
  const home = makeTestDir('rename_home');
  const agentDir = makeTestDir('rename_agent');
  const root = path.join(agentDir, 'sessions');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('old'));

  await withEnv(
    { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    async () => {
      assert.equal(
        await renameSavedSession({ path: filePath, title: 'renamed', profile: undefined }),
        null,
      );
      const rows = await listSavedSessions({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, 'renamed');
    },
  );
});

test('rename_cleans_the_title_before_writing', async () => {
  const root = makeTestDir('rename_clean');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('old'));
  const long = 'x'.repeat(200);

  await renameSavedSessionAt(root, filePath, `  a\nb\t ${long} `);

  const written = JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0]).title;
  assert.equal(Array.from(written).length, 120);
  assert.ok(!written.includes('\n') && !written.includes('\t'));
  assert.ok(written.startsWith('ab'));
  assert.equal(written.trim(), written);
});

test('rename_trims_rust_whitespace_but_not_a_byte_order_mark', async () => {
  const root = makeTestDir('rename_trim');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('old'));

  // Rust's White_Space (str::trim) excludes U+FEFF; JS trim would drop it.
  await renameSavedSessionAt(root, filePath, ' \uFEFF padded \u00a0');
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0]).title;
  assert.equal(written, '\uFEFF padded');
});

test('rename_rejects_empty_and_outside_paths', async () => {
  const root = makeTestDir('rename_bad');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('old'));

  await assert.rejects(() => renameSavedSessionAt(root, filePath, '   '), /title must not be empty/);

  const outsideDir = makeTestDir('rename_outside');
  const outside = path.join(outsideDir, 'other.jsonl');
  fs.writeFileSync(outside, '');
  await assert.rejects(
    () => renameSavedSessionAt(root, outside, 'x'),
    /outside the sessions directory/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), '', 'the outside file must be untouched');
});

test('rename_rejects_a_file_whose_first_line_is_not_a_title_event', async () => {
  const root = makeTestDir('rename_notitle');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', [
    '{"type":"session","version":3,"id":"s1"}',
  ]);
  await assert.rejects(
    () => renameSavedSessionAt(root, filePath, 'x'),
    /not a title event/,
  );
  assert.equal(
    fs.readFileSync(filePath, 'utf8'),
    '{"type":"session","version":3,"id":"s1"}\n',
    'rejected file stays byte-identical',
  );
});

test('rename_rejects_a_title_event_without_a_string_title', async () => {
  const root = makeTestDir('rename_notitle_field');
  const missing = makeSessionFile(root, 'sess-a', 'a.jsonl', ['{"type":"title","v":1}']);
  await assert.rejects(
    () => renameSavedSessionAt(root, missing, 'x'),
    /has no title field/,
  );

  const nullTitle = makeSessionFile(root, 'sess-b', 'b.jsonl', [
    '{"type":"title","v":1,"title":null}',
  ]);
  await assert.rejects(
    () => renameSavedSessionAt(root, nullTitle, 'x'),
    /has no title field/,
  );
});

test('rename_rejects_a_first_line_that_is_not_json', async () => {
  const root = makeTestDir('rename_badjson');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', ['{"type":"title",']);
  await assert.rejects(
    () => renameSavedSessionAt(root, filePath, 'x'),
    /session first line is not valid JSON: /,
  );
});

test('rename_preserves_a_single_line_file_and_terminates_it', async () => {
  const root = makeTestDir('rename_no_newline');
  const dir = path.join(root, 'sess-a');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'a.jsonl');
  fs.writeFileSync(filePath, '{"type":"title","v":1,"title":"old"}');

  await renameSavedSessionAt(root, filePath, 'new');

  assert.equal(fs.readFileSync(filePath, 'utf8'), '{"title":"new","type":"title","v":1}\n');
  const { session } = await parseSessionFile(filePath);
  assert.equal(session, null, 'no session event — still not a row');
});

test('rename_never_leaves_a_temp_file_behind', async () => {
  const root = makeTestDir('rename_atomic');
  const filePath = makeSessionFile(root, 'sess-a', 'a.jsonl', sessionLines('old'));
  await renameSavedSessionAt(root, filePath, 'new');
  const leftovers = fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(fs.statSync(filePath).isFile(), true);
});

// ── profile resolution (command wrappers) ──────────────────────────────────

test('wrappers_read_a_named_profile_tree_and_ignore_the_env_override', async () => {
  const home = makeTestDir('named_home');
  const custom = makeTestDir('named_custom');
  const namedRoot = path.join(home, '.omp', 'profiles', 'work', 'agent', 'sessions');
  const filePath = makeSessionFile(namedRoot, 'sess-w', 'w.jsonl', sessionLines('old'));
  // A decoy under the env override must not be touched for a named profile.
  makeSessionFile(path.join(custom, 'sessions'), 'sess-decoy', 'd.jsonl', sessionLines('decoy'));

  await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: custom }, async () => {
    await renameSavedSession({ path: filePath, title: 'named title', profile: 'work' });
    const { session } = await parseSessionFile(filePath);
    assert.equal(session.title, 'named title');

    await deleteSavedSession({ path: filePath, profile: 'work' });
    assert.equal(fs.existsSync(filePath), false);
    assert.ok(
      fs.existsSync(path.join(namedRoot, 'sess-w', '.trash', 'w.jsonl')),
      'moved inside the named profile tree',
    );
    assert.equal(
      (await listSavedSessions({ profile: 'work' })).length,
      0,
      'deleted row gone from the named tree',
    );
  });
});

test('wrappers_reject_a_traversal_or_unknown_shaped_profile_id', async () => {
  await assert.rejects(
    () => renameSavedSession({ path: '/tmp/x.jsonl', title: 'x', profile: '../../etc' }),
    /invalid profile id/,
  );
  await assert.rejects(
    () => deleteSavedSession({ path: '/tmp/x.jsonl', profile: 'Work' }),
    /invalid profile id/,
  );
});

test('wrappers_reject_a_non_string_path_like_the_rust_deserializer', async () => {
  await assert.rejects(
    () => deleteSavedSession({ path: null, profile: null }),
    /invalid session path: null/,
  );
});