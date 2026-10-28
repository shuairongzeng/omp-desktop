/* Port parity tests for electron/backend/git.js.

   Mirrors src-tauri/src/git_browser/{status,file,log,graph,commit,mod}.rs and
   their #[cfg(test)] cases, with fixture repositories built by the real `git`
   binary in temp dirs (setup only — the code under test never runs it).

     node tests/port-git.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/git.js';

const {
  gitBrowserStatus,
  gitBrowserFile,
  gitBrowserLog,
  gitBrowserCommit,
  gitBrowserCommitFile,
  StatusKind,
  MAX_FILES,
  MAX_SIDE_BYTES,
  MAX_LINES,
  MAX_LINE_CHARS,
  MAX_COMMITS,
  MAX_LANES,
  WORKTREE_ROW,
  merge,
  listed,
  fold,
  layout,
  view,
  render,
  lineText,
  isBinary,
  projectRelative,
  subject,
  body,
} = backend;

const scratch = [];
let counter = 0;

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures (git_browser::fixture) ─────────────────────────────────────────

function runGit(cwd, args, env) {
  const out = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(
    out.status,
    0,
    `git ${args.join(' ')} failed in ${cwd}: ${out.stderr}`,
  );
  return out.stdout;
}

function initRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-git-browser-test-${tag}-`));
  scratch.push(dir);
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['config', 'core.autocrlf', 'false']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/** Commit everything staged with author/committer date `epoch`. */
function commit(repo, message, epoch) {
  const date = `@${epoch} +0000`;
  runGit(repo, ['commit', '-q', '--allow-empty', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return runGit(repo, ['rev-parse', 'HEAD']).trim();
}

function write(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Move a file's mtime two seconds on, so a same-size edit is stat-visible. */
function later(abs) {
  const when = new Date(Date.now() + 2000);
  fs.utimesSync(abs, when, when);
}

/** Arm a repository-config clean filter that leaves a marker when it runs. */
function armCleanFilter(repo, gitDirRel) {
  const gitDir = path.join(repo, gitDirRel);
  const marker = path.join(gitDir, 'filter-ran');
  const config = path.join(gitDir, 'config');
  const set = (key, value) => runGit(repo, ['config', '--file', config, key, value]);
  set('filter.probe.clean', `echo ran >> '${marker.replaceAll('\\', '/')}'; cat`);
  set('filter.probe.required', 'true');
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=probe\n');
  return marker;
}

function find(node, relPath) {
  if (node.path === relPath) return node;
  for (const child of node.children) {
    const hit = find(child, relPath);
    if (hit) return hit;
  }
  return null;
}

function statusOf(tree, relPath) {
  const node = find(tree, relPath);
  return node ? node.status : undefined;
}

function touchedFiles(node, out = []) {
  for (const child of node.children) {
    if (child.dir) touchedFiles(child, out);
    else out.push([child.path, child.status]);
  }
  return out;
}

// ── mod.rs: subject / body ──────────────────────────────────────────────────

test('subject_and_body_split_at_the_first_line', () => {
  const msg = 'fix: the thing\n\nWhy it broke.\n\nMore.\n';
  assert.equal(subject(msg), 'fix: the thing');
  assert.equal(body(msg), 'Why it broke.\n\nMore.');
  assert.equal(subject('one line'), 'one line');
  assert.equal(body('one line'), '');
  assert.equal(body('crlf\r\n\r\nbody\r\n'), 'body');
});

test('project_relative_passes_relative_paths_through_validation', () => {
  const repo = initRepo('rel-relative');
  write(repo, 'src/a.txt', 'a\n');
  assert.equal(projectRelative(repo, 'src/a.txt'), 'src/a.txt');
  assert.throws(() => projectRelative(repo, '../x'));
  assert.throws(() => projectRelative(repo, '.git/config'));
});

test('project_relative_relativises_absolute_paths_inside_the_work_dir', () => {
  const repo = initRepo('rel-absolute');
  write(repo, 'src/a.txt', 'a\n');
  assert.equal(projectRelative(repo, path.join(repo, 'src', 'a.txt')), 'src/a.txt');
  // A deleted file (missing parent dir too) still relativises.
  assert.equal(projectRelative(repo, path.join(repo, 'gone', 'b.txt')), 'gone/b.txt');
});

test('project_relative_rejects_absolute_paths_outside_the_work_dir', () => {
  const repo = initRepo('rel-outside');
  const outside = path.join(os.tmpdir(), 'omp-git-browser-elsewhere.txt');
  assert.throws(() => projectRelative(repo, outside), /outside the repository/);
  assert.throws(() => projectRelative(repo, path.join(repo, '.git', 'config')));
});

// ── status.rs: pure helpers ────────────────────────────────────────────────

test('merge_applies_the_precedence_per_path', () => {
  const ev = (p, kind, from = null) => ({ path: p, kind, from });
  const { kinds } = merge([
    ev('a', StatusKind.Added),
    ev('a', StatusKind.Modified),
    ev('d', StatusKind.Modified),
    ev('d', StatusKind.Deleted),
    ev('r', StatusKind.Modified),
    ev('r', StatusKind.Renamed, 'old'),
    ev('u', StatusKind.Deleted),
    ev('u', StatusKind.Untracked),
    ev('m', StatusKind.Modified),
  ]);
  assert.deepEqual(
    [...kinds.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    [
      ['a', StatusKind.Added],
      ['d', StatusKind.Deleted],
      ['m', StatusKind.Modified],
      ['r', StatusKind.Renamed],
      ['u', StatusKind.Untracked],
    ],
  );
});

test('merge_records_rename_sources_by_destination', () => {
  const { kinds, sources } = merge([
    { path: 'new.txt', kind: StatusKind.Renamed, from: 'old.txt' },
  ]);
  assert.equal(sources.get('new.txt'), 'old.txt');
  assert.equal(kinds.has('old.txt'), false);
});

test('listed_keeps_changed_files_and_drops_unchanged_ones_past_the_cap', () => {
  const changed = new Map([
    ['y.txt', StatusKind.Added],
    ['z.txt', StatusKind.Modified],
  ]);
  const tracked = ['a.txt', 'b.txt', 'b.txt', 'z.txt'];
  const capped = listed(changed, tracked, 3);
  assert.equal(capped.truncated, true);
  assert.equal(capped.files.size, 3);
  assert.equal(capped.files.get('z.txt'), StatusKind.Modified);
  assert.equal(capped.files.get('y.txt'), StatusKind.Added);
  assert.equal(capped.files.get('a.txt'), null);

  const roomy = listed(changed, tracked, 4);
  assert.equal(roomy.truncated, false);
  assert.deepEqual([...roomy.files.keys()].sort(), ['a.txt', 'b.txt', 'y.txt', 'z.txt']);
});

test('fold_puts_dirs_first_then_files_and_counts_changes', () => {
  const tree = fold([
    ['z.txt', null],
    ['src/b.rs', StatusKind.Modified],
    ['src/a/x.rs', StatusKind.Added],
    ['src/a/y.rs', null],
    ['a.txt', StatusKind.Untracked],
    ['docs/readme.md', null],
  ]);
  assert.equal(tree.path, '');
  assert.equal(tree.dir, true);
  assert.deepEqual(tree.children.map((c) => c.name), ['docs', 'src', 'a.txt', 'z.txt']);
  assert.equal(tree.changed, 3);

  const docs = tree.children[0];
  assert.equal(docs.path, 'docs');
  assert.equal(docs.changed, 0);
  const src = tree.children[1];
  assert.deepEqual(src.children.map((c) => c.name), ['a', 'b.rs']);
  assert.equal(src.changed, 2);
  const a = src.children[0];
  assert.equal(a.path, 'src/a');
  assert.equal(a.dir, true);
  assert.equal(a.changed, 1);
  const x = a.children[0];
  assert.equal(x.path, 'src/a/x.rs');
  assert.deepEqual([x.dir, x.status, x.changed], [false, StatusKind.Added, 0]);
  assert.equal(x.children.length, 0);
  assert.equal(tree.children[2].path, 'a.txt');
});

// ── status.rs: repositories ─────────────────────────────────────────────────

test('status_lists_every_file_with_its_merged_kind', async () => {
  const repo = initRepo('status-kinds');
  write(repo, 'keep.txt', 'keep\n');
  write(repo, 'edit.txt', 'edit\n');
  write(repo, 'gone.txt', 'gone\n');
  write(repo, 'move.txt', 'move me\nsecond line\nthird line\n');
  write(repo, 'dir/nested.txt', 'nested\n');
  write(repo, '.gitignore', 'ignored.log\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);

  write(repo, 'edit.txt', 'edited\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  runGit(repo, ['mv', 'move.txt', 'moved.txt']);
  write(repo, 'new.txt', 'staged\n');
  runGit(repo, ['add', 'new.txt']);
  write(repo, 'new.txt', 'staged then edited\n');
  write(repo, 'fresh/untracked.txt', 'u\n');
  write(repo, 'ignored.log', 'noise\n');

  const result = await gitBrowserStatus(repo);
  const tree = result.tree;
  assert.equal(statusOf(tree, 'keep.txt'), null);
  assert.ok(find(tree, 'keep.txt'), 'unchanged files are listed');
  assert.equal(statusOf(tree, 'edit.txt'), StatusKind.Modified);
  assert.equal(statusOf(tree, 'gone.txt'), StatusKind.Deleted);
  assert.equal(statusOf(tree, 'moved.txt'), StatusKind.Renamed);
  assert.equal(find(tree, 'move.txt'), null, 'rename source is gone');
  assert.equal(statusOf(tree, 'new.txt'), StatusKind.Added);
  assert.equal(statusOf(tree, 'fresh/untracked.txt'), StatusKind.Untracked);
  assert.equal(find(tree, 'ignored.log'), null, 'ignored files never appear');
  assert.equal(find(tree, 'dir/nested.txt').status, null);
  assert.equal(result.changed, 5);
  assert.equal(tree.changed, 5);
  assert.equal(result.truncated, false);

  assert.equal(result.repo.branch, 'main');
  assert.equal(result.repo.head, runGit(repo, ['rev-parse', 'HEAD']).trim());
  assert.deepEqual([result.repo.ahead, result.repo.behind], [null, null]);
  assert.ok(result.repo.name.startsWith('omp-git-browser-test-status-kinds'));
});

test('status_works_on_an_unborn_head_and_from_a_subdirectory', async () => {
  const repo = initRepo('status-unborn');
  write(repo, 'sub/a.txt', 'a\n');
  runGit(repo, ['add', '.']);
  write(repo, 'sub/b.txt', 'b\n');

  const result = await gitBrowserStatus(path.join(repo, 'sub'));
  assert.equal(result.repo.head, null);
  assert.equal(result.repo.branch, 'main');
  assert.equal(statusOf(result.tree, 'sub/a.txt'), StatusKind.Added);
  assert.equal(statusOf(result.tree, 'sub/b.txt'), StatusKind.Untracked);
});

test('status_reports_a_detached_head_without_a_branch', async () => {
  const repo = initRepo('status-detached');
  const first = commit(repo, 'one', 1_700_000_000);
  commit(repo, 'two', 1_700_000_100);
  runGit(repo, ['checkout', '-q', '--detach', first]);
  const result = await gitBrowserStatus(repo);
  assert.equal(result.repo.branch, null);
  assert.equal(result.repo.head, first);
});

test('status_never_reads_a_submodule_work_tree_and_sees_its_commit_move', async () => {
  const outer = initRepo('status-sub-filter');
  const inner = initRepo('status-sub-filter-inner');
  write(inner, 'a.txt', 'one\n');
  runGit(inner, ['add', '.']);
  commit(inner, 'inner', 1_700_000_000);
  runGit(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub']);
  commit(outer, 'add sub', 1_700_000_100);
  const marker = armCleanFilter(outer, '.git/modules/sub');
  const checkout = path.join(outer, 'sub', 'a.txt');
  write(outer, 'sub/a.txt', fs.readFileSync(checkout, 'utf8').replace('one', 'uno'));

  let result = await gitBrowserStatus(outer);
  assert.equal(fs.existsSync(marker), false, "the submodule's clean filter ran");
  assert.equal(statusOf(result.tree, 'sub'), null, 'dirty content is ignored');

  runGit(outer, ['-C', 'sub', 'commit', '-q', '--allow-empty', '-m', 'moved'], {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  result = await gitBrowserStatus(outer);
  assert.equal(statusOf(result.tree, 'sub'), StatusKind.Modified);
});

test('status_outside_a_repository_is_an_error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-git-browser-not-a-repo-'));
  scratch.push(dir);
  await assert.rejects(() => gitBrowserStatus(dir), /not a git repository/);
});

// ── file.rs: pure rendering ────────────────────────────────────────────────

const line = (kind, old, newNum, text) => ({ kind, old, new: newNum, text });

test('unchanged_file_is_all_context_with_both_numbers', () => {
  const out = view('f.txt', null, Buffer.from('a\nb\n'), Buffer.from('a\nb\n'));
  assert.equal(out.kind, 'Text');
  assert.deepEqual([out.adds, out.rems, out.truncated], [0, 0, false]);
  assert.deepEqual(out.lines, [
    line('ctx', 1, 1, 'a'),
    line('ctx', 2, 2, 'b'),
  ]);
});

test('a_hunk_shows_removed_lines_before_added_ones_with_shifted_numbers', () => {
  const out = view(
    'f.txt',
    null,
    Buffer.from('a\nb\nc\nd\n'),
    Buffer.from('a\nB1\nB2\nB3\nB4\nc\nd\n'),
  );
  assert.deepEqual([out.adds, out.rems], [4, 1]);
  assert.deepEqual(out.lines, [
    line('ctx', 1, 1, 'a'),
    line('rem', 2, null, 'b'),
    line('add', null, 2, 'B1'),
    line('add', null, 3, 'B2'),
    line('add', null, 4, 'B3'),
    line('add', null, 5, 'B4'),
    line('ctx', 3, 6, 'c'),
    line('ctx', 4, 7, 'd'),
  ]);
});

test('separate_hunks_keep_context_between_them', () => {
  const out = view(
    'f.txt',
    null,
    Buffer.from('x\n1\n2\n3\ny\n'),
    Buffer.from('1\n2\n3\nz\n'),
  );
  assert.deepEqual(out.lines, [
    line('rem', 1, null, 'x'),
    line('ctx', 2, 1, '1'),
    line('ctx', 3, 2, '2'),
    line('ctx', 4, 3, '3'),
    line('rem', 5, null, 'y'),
    line('add', null, 4, 'z'),
  ]);
});

test('an_anchored_hunk_keeps_the_common_suffix_as_context', () => {
  const out = view(
    'f.txt',
    null,
    Buffer.from('p\nq\nr\ns\nt\nu\nv\n'),
    Buffer.from('q\nr\ns\nt\nv\n'),
  );
  assert.deepEqual([out.adds, out.rems], [0, 2]);
  assert.deepEqual(
    out.lines.map((l) => [l.kind, l.text]),
    [
      ['rem', 'p'],
      ['ctx', 'q'],
      ['ctx', 'r'],
      ['ctx', 's'],
      ['ctx', 't'],
      ['rem', 'u'],
      ['ctx', 'v'],
    ],
  );
});

test('a_new_file_is_all_added_and_a_deleted_one_all_removed', () => {
  const added = view('f.txt', null, null, Buffer.from('one\ntwo'));
  assert.deepEqual([added.adds, added.rems], [2, 0]);
  assert.deepEqual(added.lines, [
    line('add', null, 1, 'one'),
    line('add', null, 2, 'two'),
  ]);
  const deleted = view('f.txt', null, Buffer.from('one\r\ntwo\r\n'), null);
  assert.deepEqual([deleted.adds, deleted.rems], [0, 2]);
  assert.deepEqual(deleted.lines, [
    line('rem', 1, null, 'one'),
    line('rem', 2, null, 'two'),
  ]);
});

test('neither_side_is_missing_and_a_nul_byte_is_binary', () => {
  assert.equal(view('f.txt', null, null, null).kind, 'Missing');
  const binary = view('b.bin', StatusKind.Modified, Buffer.from('text\n'), Buffer.from('PNG\0\x01\x02'));
  assert.equal(binary.kind, 'Binary');
  assert.equal(binary.lines.length, 0);
  assert.equal(binary.status, StatusKind.Modified);
  // A NUL past the sniff window does not count.
  const late = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])]);
  assert.equal(view('', null, null, late).kind, 'Text');
  assert.equal(isBinary(late), false);
});

test('long_lines_are_cut_at_the_char_cap', () => {
  const long = 'é'.repeat(MAX_LINE_CHARS + 10);
  const out = view('f.txt', null, null, Buffer.from(`${long}\nshort\n`));
  assert.equal(out.truncated, true);
  assert.equal([...out.lines[0].text].length, MAX_LINE_CHARS);
  assert.ok([...out.lines[0].text].every((ch) => ch === 'é'));
  assert.equal(out.lines[1].text, 'short');

  const exact = 'x'.repeat(MAX_LINE_CHARS);
  const exactView = view('f.txt', null, null, Buffer.from(exact));
  assert.equal(exactView.truncated, false);
  assert.equal(exactView.lines[0].text, exact);

  // The helper itself: a 4-byte astral character counts as one char.
  const [text, cut] = lineText(Buffer.from('\u{1F600}'.repeat(MAX_LINE_CHARS + 1) + '\n'));
  assert.equal(cut, true);
  assert.equal([...text].length, MAX_LINE_CHARS);
});

test('output_stops_at_the_line_cap', () => {
  const text = `${Array.from({ length: MAX_LINES + 1 }, (_, i) => i).join('\n')}\n`;
  const out = view('f.txt', null, null, Buffer.from(text));
  assert.equal(out.truncated, true);
  assert.equal(out.lines.length, MAX_LINES);
  assert.equal(out.adds, MAX_LINES + 1, 'counts cover the whole diff');
  assert.equal(out.lines[MAX_LINES - 1].new, MAX_LINES);
});

test('a_side_past_the_byte_cap_is_too_large_with_no_lines', () => {
  const big = `${'y'.repeat(399)}\n`.repeat(Math.floor(MAX_SIDE_BYTES / 400) + 5);
  for (const [before, after] of [
    [Buffer.from('y\n'), Buffer.from(big)],
    [Buffer.from(big), null],
  ]) {
    const out = view('f.txt', null, before, after);
    assert.equal(out.kind, 'TooLarge');
    assert.deepEqual([out.adds, out.rems, out.truncated], [0, 0, false]);
    assert.equal(out.lines.length, 0);
  }
  const exact = 'y'.repeat(MAX_SIDE_BYTES);
  assert.equal(view('f.txt', null, null, Buffer.from(exact)).kind, 'Text');
});

test('render_treats_a_too_large_side_as_too_large', () => {
  const out = render('f.txt', StatusKind.Modified, { kind: 'tooLarge' }, { kind: 'bytes', bytes: Buffer.from('y\n') });
  assert.equal(out.kind, 'TooLarge');
  assert.equal(out.status, StatusKind.Modified);
  assert.equal(render('f.txt', null, { kind: 'absent' }, { kind: 'absent' }).kind, 'Missing');
});

// ── file.rs: repositories ──────────────────────────────────────────────────

test('a_worktree_file_past_the_byte_cap_is_too_large', async () => {
  const repo = initRepo('file-too-large');
  write(repo, 'a.txt', 'a\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  write(repo, 'a.txt', 'y\n'.repeat(Math.floor(MAX_SIDE_BYTES / 2) + 1));
  const out = await gitBrowserFile(repo, 'a.txt');
  assert.equal(out.kind, 'TooLarge');
  assert.equal(out.status, StatusKind.Modified);
  assert.deepEqual([out.adds, out.rems, out.truncated], [0, 0, false]);
  assert.equal(out.lines.length, 0);
});

test('a_head_blob_past_the_byte_cap_is_too_large', async () => {
  const repo = initRepo('file-blob-too-large');
  write(repo, 'a.txt', 'y\n'.repeat(Math.floor(MAX_SIDE_BYTES / 2) + 1));
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  write(repo, 'a.txt', 'a\n');
  const out = await gitBrowserFile(repo, 'a.txt');
  assert.equal(out.kind, 'TooLarge');
  assert.equal(out.status, StatusKind.Modified);
  assert.equal(out.lines.length, 0);
});

test('a_crlf_checkout_of_an_lf_blob_is_unchanged', async () => {
  const repo = initRepo('file-crlf');
  write(repo, '.gitattributes', '*.txt text eol=crlf\n');
  write(repo, 'a.txt', 'one\ntwo\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  fs.rmSync(path.join(repo, 'a.txt'));
  runGit(repo, ['checkout', '--', 'a.txt']);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'a.txt')), Buffer.from('one\r\ntwo\r\n'));

  const out = await gitBrowserFile(repo, 'a.txt');
  assert.equal(out.status, null);
  assert.deepEqual([out.adds, out.rems], [0, 0]);
  assert.deepEqual(out.lines, [
    line('ctx', 1, 1, 'one'),
    line('ctx', 2, 2, 'two'),
  ]);
});

test('safecrlf_does_not_refuse_a_file_whose_endings_would_not_round_trip', async () => {
  const repo = initRepo('file-safecrlf');
  write(repo, 'a.txt', 'one\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  runGit(repo, ['config', 'core.autocrlf', 'input']);
  runGit(repo, ['config', 'core.safecrlf', 'true']);
  write(repo, 'b.txt', 'mixed\r\nendings\r\n');

  const out = await gitBrowserFile(repo, 'b.txt');
  assert.equal(out.kind, 'Text');
  assert.equal(out.status, StatusKind.Untracked);
  assert.deepEqual(out.lines, [
    line('add', null, 1, 'mixed'),
    line('add', null, 2, 'endings'),
  ]);
});

test('worktree_file_diffs_against_head', async () => {
  const repo = initRepo('file-worktree');
  write(repo, 'a.txt', 'one\ntwo\nthree\n');
  write(repo, 'b.txt', 'same\n');
  write(repo, 'gone.txt', 'bye\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  write(repo, 'a.txt', 'one\n2\nthree\n');
  write(repo, 'new.txt', 'hello\n');
  fs.rmSync(path.join(repo, 'gone.txt'));

  const a = await gitBrowserFile(repo, 'a.txt');
  assert.equal(a.path, 'a.txt');
  assert.equal(a.status, StatusKind.Modified);
  assert.deepEqual(a.lines, [
    line('ctx', 1, 1, 'one'),
    line('rem', 2, null, 'two'),
    line('add', null, 2, '2'),
    line('ctx', 3, 3, 'three'),
  ]);
  const b = await gitBrowserFile(repo, 'b.txt');
  assert.equal(b.status, null);
  assert.deepEqual(b.lines, [line('ctx', 1, 1, 'same')]);
  const fresh = await gitBrowserFile(repo, 'new.txt');
  assert.equal(fresh.status, StatusKind.Untracked);
  assert.deepEqual(fresh.lines, [line('add', null, 1, 'hello')]);
  const gone = await gitBrowserFile(repo, 'gone.txt');
  assert.equal(gone.status, StatusKind.Deleted);
  assert.deepEqual(gone.lines, [line('rem', 1, null, 'bye')]);
  assert.equal((await gitBrowserFile(repo, 'nowhere.txt')).kind, 'Missing');

  // An absolute path inside the work dir resolves to the same file.
  const byAbs = await gitBrowserFile(repo, path.join(repo, 'a.txt'));
  assert.equal(byAbs.path, 'a.txt');
  assert.deepEqual(byAbs.lines, a.lines);
  await assert.rejects(() => gitBrowserFile(repo, '../a.txt'));
});

test('a_staged_rename_diffs_against_its_source', async () => {
  const repo = initRepo('file-rename');
  write(repo, 'old.txt', 'l1\nl2\nl3\nl4\nl5\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  runGit(repo, ['mv', 'old.txt', 'new.txt']);
  write(repo, 'new.txt', 'l1\nl2\nl3\nl4\nl5\nl6\n');

  const out = await gitBrowserFile(repo, 'new.txt');
  assert.equal(out.status, StatusKind.Renamed);
  assert.deepEqual([out.adds, out.rems], [1, 0]);
  assert.deepEqual(out.lines.at(-1), line('add', null, 6, 'l6'));
});

test('an_unborn_head_shows_staged_files_as_added_lines', async () => {
  const repo = initRepo('file-unborn');
  write(repo, 'a.txt', 'x\n');
  runGit(repo, ['add', '.']);
  const out = await gitBrowserFile(repo, 'a.txt');
  assert.equal(out.status, StatusKind.Added);
  assert.deepEqual(out.lines, [line('add', null, 1, 'x')]);
});

test('a_clean_filter_from_the_repository_config_never_runs', async () => {
  const repo = initRepo('file-repo-filter');
  write(repo, 'a.txt', 'one\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  const marker = armCleanFilter(repo, '.git');
  write(repo, 'a.txt', 'uno\n');
  // Same size as the index entry: only the timestamp tells git to re-hash, so
  // make sure it differs (writing twice within one second can leave it equal).
  later(path.join(repo, 'a.txt'));

  const status = await gitBrowserStatus(repo);
  assert.equal(fs.existsSync(marker), false, "status ran the repository's clean filter");
  assert.equal(statusOf(status.tree, 'a.txt'), StatusKind.Modified);
  const out = await gitBrowserFile(repo, 'a.txt');
  assert.equal(fs.existsSync(marker), false, "the repository's clean filter ran");
  assert.equal(out.status, StatusKind.Modified);
  assert.deepEqual(out.lines, [
    line('rem', 1, null, 'one'),
    line('add', null, 1, 'uno'),
  ]);
});

// ── graph.rs ───────────────────────────────────────────────────────────────

const MOCK = [
  ['a1f9c2e', ['b72e01d']],
  ['b72e01d', ['c3d4a55']],
  ['c3d4a55', ['d91be70']],
  ['d91be70', ['e7a2c11', 'f0c3b8d']],
  ['f0c3b8d', ['e7a2c11']],
  ['e7a2c11', ['0a1b2c3']],
  ['9f8e7d6', ['8e7d6c5']],
  ['8e7d6c5', ['0a1b2c3']],
  ['0a1b2c3', ['1b2c3d4']],
  ['1b2c3d4', ['2c3d4e5', '3d4e5f6']],
  ['3d4e5f6', ['4e5f6a7']],
  ['2c3d4e5', ['5f6a7b8']],
  ['4e5f6a7', ['5f6a7b8']],
  ['5f6a7b8', ['6a7b8c9']],
  ['6a7b8c9', ['7b8c9d0']],
  ['7b8c9d0', ['8c9d0e1']],
  ['8c9d0e1', ['9d0e1f2']],
  ['9d0e1f2', ['0e1f2a3']],
  ['0e1f2a3', []],
];

const edges = (pairs) => pairs.map(([from, to]) => ({ from, to }));

test('mock_history_fits_two_lanes', () => {
  const out = layout(MOCK);
  assert.equal(out.width, 2);
  assert.equal(out.rows.length, MOCK.length);
  assert.deepEqual(
    out.rows.map((row) => row.lane),
    [0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0],
  );
});

test('merges_branch_out_to_the_next_free_lane', () => {
  const out = layout(MOCK);
  assert.deepEqual(out.rows[3].edges, edges([[0, 0], [0, 1]]));
  assert.deepEqual(out.rows[9].edges, edges([[0, 0], [0, 1]]));
});

test('side_branches_bend_back_into_their_first_parents_lane', () => {
  const out = layout(MOCK);
  assert.deepEqual(out.rows[4].edges, edges([[1, 0], [0, 0]]));
  assert.deepEqual(out.rows[6].edges, edges([[1, 1], [0, 0]]));
  assert.deepEqual(out.rows[7].edges, edges([[1, 0], [0, 0]]));
  assert.deepEqual(out.rows[10].edges, edges([[1, 1], [0, 0]]));
  assert.deepEqual(out.rows[11].edges, edges([[0, 0], [1, 1]]));
  assert.deepEqual(out.rows[12].edges, edges([[1, 0], [0, 0]]));
  assert.deepEqual(out.rows[18].edges, edges([]));
});

test('a_second_parent_already_waiting_gets_an_edge_into_its_lane', () => {
  const out = layout([
    ['x', ['c', 'y']],
    ['y', ['d', 'c']],
    ['d', ['c']],
    ['c', []],
  ]);
  assert.deepEqual(out.rows[0].edges, edges([[0, 0], [0, 1]]));
  assert.equal(out.rows[1].lane, 1);
  assert.deepEqual(out.rows[1].edges, edges([[1, 1], [1, 0], [0, 0]]));
  assert.deepEqual(out.rows[2].edges, edges([[1, 0], [0, 0]]));
  assert.equal(out.rows[3].lane, 0);
  assert.equal(out.width, 2);
});

test('unrelated_tips_take_new_lanes_and_bend_into_their_shared_base', () => {
  const out = layout([
    ['b', ['m']],
    ['c', ['m']],
    ['m', []],
  ]);
  assert.equal(out.rows[0].lane, 0);
  assert.equal(out.rows[1].lane, 1);
  assert.deepEqual(out.rows[1].edges, edges([[1, 0], [0, 0]]));
  assert.equal(out.rows[2].lane, 0);
  assert.equal(out.width, 2);
});

test('a_lane_claimed_by_a_second_parent_does_not_pass_through_its_first_row', () => {
  const out = layout([
    ['a', ['p', 'q']],
    ['q', ['p']],
    ['p', []],
  ]);
  assert.deepEqual(out.rows[0].edges, edges([[0, 0], [0, 1]]));
  assert.deepEqual(out.rows[1].edges, edges([[1, 0], [0, 0]]));
});

test('lanes_past_the_cap_squash_onto_the_last_one', () => {
  const commits = Array.from({ length: MAX_LANES + 3 }, (_, i) => [`tip${i}`, [`base${i}`]]);
  const out = layout(commits);
  assert.equal(out.width, MAX_LANES);
  const lanes = out.rows.map((row) => row.lane);
  assert.deepEqual(lanes.slice(0, MAX_LANES), Array.from({ length: MAX_LANES }, (_, i) => i));
  assert.ok(lanes.slice(MAX_LANES).every((lane) => lane === MAX_LANES - 1));
});

test('lanes_past_the_cap_keep_every_parent_edge', () => {
  const n = MAX_LANES + 1;
  const tips = Array.from({ length: n }, (_, i) => [`tip${i}`, `base${i}`]);
  const commits = tips.map(([tip, base]) => [tip, [base]]);
  commits.push([tips[n - 1][1], ['x', 'y']]);
  for (const [, base] of tips.slice(0, n - 1)) commits.push([base, []]);
  commits.push(['x', []]);
  commits.push(['y', []]);

  const out = layout(commits);
  assert.equal(out.width, MAX_LANES);
  const laneOf = (id) => {
    const index = commits.findIndex(([commitId]) => commitId === id);
    return out.rows[index].lane;
  };
  for (let i = 0; i < commits.length; i++) {
    const [id, parents] = commits[i];
    const row = out.rows[i];
    for (const parent of parents) {
      const edge = { from: row.lane, to: laneOf(parent) };
      assert.ok(
        row.edges.some((e) => e.from === edge.from && e.to === edge.to),
        `${id} → ${parent}: ${JSON.stringify(row)}`,
      );
    }
    const seen = new Set();
    for (const edge of row.edges) {
      assert.equal(seen.has(`${edge.from}:${edge.to}`), false, `${id}: duplicate edge`);
      seen.add(`${edge.from}:${edge.to}`);
    }
  }
});

test('empty_history_has_no_lanes', () => {
  const out = layout([]);
  assert.deepEqual(out.rows, []);
  assert.equal(out.width, 0);
});

// ── log.rs ─────────────────────────────────────────────────────────────────

/** main: c1 ← c2 (HEAD); side: c1 ← s1, also `origin/main`; tag v1 on c1. */
function diverged(tag) {
  const repo = initRepo(tag);
  const c1 = commit(repo, 'first\n\nbody', 1_700_000_000);
  const c2 = commit(repo, 'second', 1_700_000_100);
  runGit(repo, ['tag', '-a', 'v1', '-m', 'release', c1]);
  runGit(repo, ['checkout', '-q', '-b', 'side', c1]);
  const s1 = commit(repo, 'side work', 1_700_000_200);
  runGit(repo, ['update-ref', 'refs/remotes/origin/main', s1]);
  runGit(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  runGit(repo, ['checkout', '-q', 'main']);
  return { repo, c1, c2, s1 };
}

test('log_lists_all_refs_newest_first_with_decorations', async () => {
  const { repo, c1, c2, s1 } = diverged('log-refs');
  const out = await gitBrowserLog(repo);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.rows.map((row) => row.id), [WORKTREE_ROW, s1, c2, c1]);

  const wt = out.rows[0];
  assert.deepEqual(wt.parents, [c2]);
  assert.deepEqual([wt.short, wt.subject, wt.at], ['', '', 0]);

  assert.deepEqual(out.rows[1].refs, [
    { name: 'side', kind: 'branch' },
    { name: 'origin/main', kind: 'remote' },
  ]);
  assert.deepEqual(out.rows[2].refs, [{ name: 'main', kind: 'head' }]);
  assert.deepEqual(out.rows[3].refs, [{ name: 'v1', kind: 'tag' }]);

  const first = out.rows[3];
  assert.equal(first.subject, 'first');
  assert.equal(first.short, c1.slice(0, 7));
  assert.equal(first.author, 'Test');
  assert.equal(first.at, 1_700_000_000);
  assert.equal(first.parents.length, 0);
  assert.deepEqual(out.rows[1].parents, [c1]);

  assert.deepEqual(out.rows.map((row) => row.lane), [0, 1, 0, 1]);
  assert.deepEqual(out.rows[2].edges, edges([[0, 1], [1, 1]]));
  assert.equal(out.width, 2);
});

test('a_detached_head_is_decorated_as_head', async () => {
  const { repo, c1 } = diverged('log-detached');
  runGit(repo, ['checkout', '-q', '--detach', c1]);
  const out = await gitBrowserLog(repo);
  const row = out.rows.find((r) => r.id === c1);
  assert.deepEqual(row.refs, [
    { name: 'HEAD', kind: 'head' },
    { name: 'v1', kind: 'tag' },
  ]);
  assert.deepEqual(out.rows[0].parents, [c1]);
  assert.ok(
    out.rows.some((r) => r.refs.some((ref) => ref.name === 'main' && ref.kind === 'branch')),
  );
});

test('an_unborn_head_has_no_rows', async () => {
  const repo = initRepo('log-unborn');
  const out = await gitBrowserLog(repo);
  assert.equal(out.rows.length, 0);
  assert.equal(out.width, 0);
});

test('history_is_cut_at_the_commit_cap', async () => {
  const repo = initRepo('log-cap');
  let stream = '';
  for (let i = 0; i <= MAX_COMMITS; i++) {
    stream += `commit refs/heads/main\ncommitter T <t@e> ${1_700_000_000 + i} +0000\ndata 2\nc\n`;
  }
  const child = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: repo,
    input: stream,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);

  const out = await gitBrowserLog(repo);
  assert.equal(out.truncated, true);
  assert.equal(out.rows.length, MAX_COMMITS + 1, 'commits plus the @ row');
});

test('ahead_behind_counts_against_the_upstream', async () => {
  const { repo } = diverged('log-upstream');
  assert.equal((await gitBrowserStatus(repo)).repo.ahead, null);

  runGit(repo, ['remote', 'add', 'origin', '../nowhere']);
  runGit(repo, ['config', 'branch.main.remote', 'origin']);
  runGit(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
  let status = await gitBrowserStatus(repo);
  assert.deepEqual([status.repo.ahead, status.repo.behind], [1, 1]);

  // Configured but never fetched: no upstream ref.
  runGit(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  status = await gitBrowserStatus(repo);
  assert.deepEqual([status.repo.ahead, status.repo.behind], [null, null]);
});

test('ahead_behind_counts_a_criss_cross_history_without_a_merge_base', async () => {
  const repo = initRepo('log-criss-cross');
  const base = commit(repo, 'base', 1_700_000_000);
  const left = commit(repo, 'left', 1_700_000_100);
  runGit(repo, ['checkout', '-q', '-b', 'other', base]);
  const right = commit(repo, 'right', 1_700_000_200);
  runGit(repo, ['checkout', '-q', 'main']);
  runGit(repo, ['merge', '-q', '--no-ff', '--no-edit', right]);
  runGit(repo, ['checkout', '-q', 'other']);
  runGit(repo, ['merge', '-q', '--no-ff', '--no-edit', left]);
  const theirs = runGit(repo, ['rev-parse', 'HEAD']).trim();
  runGit(repo, ['checkout', '-q', 'main']);
  runGit(repo, ['update-ref', 'refs/remotes/origin/main', theirs]);
  runGit(repo, ['remote', 'add', 'origin', '../nowhere']);
  runGit(repo, ['config', 'branch.main.remote', 'origin']);
  runGit(repo, ['config', 'branch.main.merge', 'refs/heads/main']);

  const status = await gitBrowserStatus(repo);
  assert.deepEqual([status.repo.ahead, status.repo.behind], [1, 1]);
});

// ── commit.rs ──────────────────────────────────────────────────────────────

/**
 * Root: a.txt, src/keep.rs, src/move.rs, gone.txt. Second commit: a.txt
 * edited, gone.txt deleted, src/move.rs → lib/moved.rs, new.txt.
 */
function history(tag) {
  const repo = initRepo(tag);
  write(repo, 'a.txt', 'one\ntwo\n');
  write(repo, 'src/keep.rs', 'fn keep() {}\n');
  write(repo, 'src/move.rs', 'fn a() {}\nfn b() {}\nfn c() {}\n');
  write(repo, 'gone.txt', 'bye\n');
  runGit(repo, ['add', '.']);
  const root = commit(repo, 'root', 1_700_000_000);
  write(repo, 'a.txt', 'one\n2\n');
  write(repo, 'new.txt', 'hi\n');
  runGit(repo, ['rm', '-q', 'gone.txt']);
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  runGit(repo, ['mv', 'src/move.rs', 'lib/moved.rs']);
  runGit(repo, ['add', '.']);
  const second = commit(repo, 'second\n\nthe body\nline two\n', 1_700_000_100);
  return { repo, root, second };
}

test('commit_lists_files_touched_against_the_first_parent', async () => {
  const { repo, root, second } = history('commit-files');
  const out = await gitBrowserCommit(repo, second);
  assert.equal(out.id, second);
  assert.equal(out.short, second.slice(0, 7));
  assert.equal(out.subject, 'second');
  assert.equal(out.body, 'the body\nline two');
  assert.deepEqual([out.author, out.email], ['Test', 'test@example.com']);
  assert.equal(out.at, 1_700_000_100);
  assert.deepEqual(out.parents, [root]);
  assert.deepEqual(touchedFiles(out.tree), [
    ['lib/moved.rs', StatusKind.Renamed],
    ['a.txt', StatusKind.Modified],
    ['gone.txt', StatusKind.Deleted],
    ['new.txt', StatusKind.Added],
  ]);
  assert.equal(out.files, 4);
  assert.equal(out.truncated, false);
});

test('a_root_commit_lists_every_file_as_added', async () => {
  const { repo, root } = history('commit-root');
  const out = await gitBrowserCommit(repo, root);
  assert.equal(out.parents.length, 0);
  assert.equal(out.body, '');
  assert.deepEqual(touchedFiles(out.tree), [
    ['src/keep.rs', StatusKind.Added],
    ['src/move.rs', StatusKind.Added],
    ['a.txt', StatusKind.Added],
    ['gone.txt', StatusKind.Added],
  ]);
  assert.equal(out.tree.changed, 4);
});

test('commit_file_shows_the_commits_change_or_plain_context', async () => {
  const { repo, root, second } = history('commit-file');
  const a = await gitBrowserCommitFile(repo, second, 'a.txt');
  assert.equal(a.status, StatusKind.Modified);
  assert.deepEqual(
    a.lines.map((l) => [l.kind, l.old, l.new]),
    [
      ['ctx', 1, 1],
      ['rem', 2, null],
      ['add', null, 2],
    ],
  );

  const keep = await gitBrowserCommitFile(repo, second, 'src/keep.rs');
  assert.equal(keep.status, null);
  assert.equal(keep.lines.length, 1);
  assert.equal(keep.lines[0].kind, 'ctx');

  const moved = await gitBrowserCommitFile(repo, second, 'lib/moved.rs');
  assert.equal(moved.status, StatusKind.Renamed);
  assert.deepEqual([moved.adds, moved.rems], [0, 0]);
  assert.equal(moved.lines.length, 3);

  const gone = await gitBrowserCommitFile(repo, second, 'gone.txt');
  assert.equal(gone.status, StatusKind.Deleted);
  assert.equal(gone.lines[0].kind, 'rem');

  const rootA = await gitBrowserCommitFile(repo, root, 'a.txt');
  assert.equal(rootA.status, StatusKind.Added);
  assert.ok(rootA.lines.every((l) => l.kind === 'add'));

  const none = await gitBrowserCommitFile(repo, root, 'nowhere.txt');
  assert.equal(none.kind, 'Missing');
});

test('bad_ids_and_paths_are_errors', async () => {
  const { repo, root } = history('commit-errors');
  await assert.rejects(() => gitBrowserCommit(repo, 'not-hex'), /invalid commit id/);
  await assert.rejects(() => gitBrowserCommit(repo, '0'.repeat(40)), /failed to read commit/);
  await assert.rejects(() => gitBrowserCommitFile(repo, root, '../a.txt'));
  await assert.rejects(() => gitBrowserCommitFile(repo, root, ''));
  await assert.rejects(() => gitBrowserCommitFile(repo, root, '.git/config'));
  await assert.rejects(() => gitBrowserCommitFile(repo, root, '/etc/passwd'));
});

test('commit_file_ignores_what_the_path_is_on_disk_today', { skip: process.platform === 'win32' }, async () => {
  const repo = initRepo('commit-symlinked-dir');
  write(repo, 'include/a.h', 'int a;\n');
  write(repo, 'elsewhere/a.h', 'int other;\n');
  runGit(repo, ['add', '.']);
  const first = commit(repo, 'first', 1_700_000_000);
  fs.rmSync(path.join(repo, 'include'), { recursive: true });
  fs.symlinkSync('elsewhere', path.join(repo, 'include'));

  const out = await gitBrowserCommitFile(repo, first, 'include/a.h');
  assert.equal(out.path, 'include/a.h');
  assert.equal(out.status, StatusKind.Added);
  assert.deepEqual(out.lines.map((l) => l.text), ['int a;']);
});

// One trailing sanity check that the limits match the Rust constants.
test('limits_match_the_rust_constants', () => {
  assert.equal(MAX_FILES, 20_000);
  assert.equal(MAX_SIDE_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_LINES, 20_000);
  assert.equal(MAX_LINE_CHARS, 500);
  assert.equal(MAX_COMMITS, 500);
  assert.equal(MAX_LANES, 12);
});

// ── status.rs: global excludes, core.filemode, racy entries ─────────────────

test('status_applies_the_configured_global_excludes_file', async () => {
  const repo = initRepo('status-excludes-file');
  write(repo, 'keep.txt', 'keep\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-git-excludes-'));
  scratch.push(configDir);
  const excludes = path.join(configDir, 'ignore');
  fs.writeFileSync(excludes, '*.log\n!keep.log\nbuild/\n');
  runGit(repo, ['config', 'core.excludesFile', excludes]);

  write(repo, 'noise.log', 'noise\n');
  write(repo, 'keep.log', 'kept\n');
  write(repo, 'build/out.o', 'object\n');
  write(repo, 'src/app.txt', 'app\n');

  const result = await gitBrowserStatus(repo);
  assert.equal(find(result.tree, 'noise.log'), null, 'wildcard pattern ignores the file');
  assert.equal(find(result.tree, 'build'), null, 'directory-only pattern prunes the dir');
  assert.equal(statusOf(result.tree, 'keep.log'), StatusKind.Untracked, '! re-includes');
  assert.equal(statusOf(result.tree, 'src/app.txt'), StatusKind.Untracked);
  assert.equal(result.changed, 2);
});

test('core_filemode_false_ignores_a_chmod_only_change', { skip: process.platform === 'win32' }, async () => {
  const repo = initRepo('status-filemode');
  write(repo, 'run.sh', '#!/bin/sh\necho hi\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  fs.chmodSync(path.join(repo, 'run.sh'), 0o755);

  const strict = await gitBrowserStatus(repo);
  assert.equal(statusOf(strict.tree, 'run.sh'), StatusKind.Modified);

  runGit(repo, ['config', 'core.filemode', 'false']);
  const loose = await gitBrowserStatus(repo);
  assert.equal(statusOf(loose.tree, 'run.sh'), null);
  assert.equal(loose.changed, 0);
});

test('a_racy_same_size_same_mtime_edit_is_re_hashed', async () => {
  const repo = initRepo('status-racy');
  // Start just after a wall-clock second boundary so the commit's index entry
  // and the edit share a whole second: size, mtime and ctime all compare equal
  // and the stat cache alone cannot see the edit. The walk must re-hash.
  const now = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000 - (now % 1000) + 10));

  write(repo, 'f.txt', 'AAAA\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);

  const abs = path.join(repo, 'f.txt');
  const before = fs.statSync(abs);
  write(repo, 'f.txt', 'BBBB\n');
  fs.utimesSync(abs, before.atime, before.mtime);
  const after = fs.statSync(abs);
  assert.equal(after.size, before.size, 'same byte count');
  assert.equal(
    Math.floor(after.mtimeMs / 1000),
    Math.floor(before.mtimeMs / 1000),
    'same mtime second, so the stat cache says clean',
  );

  const result = await gitBrowserStatus(repo);
  assert.equal(statusOf(result.tree, 'f.txt'), StatusKind.Modified);
});

test('an_edited_rename_is_not_paired_by_exact_content', async () => {
  const repo = initRepo('status-rename-edit');
  write(repo, 'old.txt', 'one\ntwo\n');
  runGit(repo, ['add', '.']);
  commit(repo, 'init', 1_700_000_000);
  runGit(repo, ['mv', 'old.txt', 'new.txt']);
  write(repo, 'new.txt', 'one\ntwo!\n');
  runGit(repo, ['add', 'new.txt']);

  // The documented boundary: a rename whose blob also changed is Add+Delete.
  const result = await gitBrowserStatus(repo);
  assert.equal(statusOf(result.tree, 'old.txt'), StatusKind.Deleted);
  assert.equal(statusOf(result.tree, 'new.txt'), StatusKind.Added);
  assert.equal(find(result.tree, 'new.txt').path, 'new.txt');
});