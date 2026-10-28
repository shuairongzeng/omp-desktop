/* Port parity tests for electron/backend/conversation-tree.js.

   Mirrors src-tauri/src/conversation_tree/tests.rs (family discovery, entry
   collapsing, kept kinds, merge, labels, compaction, text, usage, validation,
   serde shape) plus the command wrapper. Run:

     node tests/port-conversation-tree.mjs */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import tree from '../electron/backend/conversation-tree.js';

const {
  conversationTree,
  buildTree,
  familyOf,
  parseFile,
  clip,
  firstText,
  MAX_FAMILY_FILES,
} = tree;

const scratchDirs = [];

function makeTestDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_tree_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A sessions root with one cwd-slug directory. */
function makeFixture(name) {
  const root = makeTestDir(name);
  const dir = path.join(root, '--work-proj--');
  fs.mkdirSync(dir, { recursive: true });
  return {
    root,
    dir,
    path: (fileName) => path.join(dir, fileName),
    put(fileName, lines) {
      return this.putRaw(fileName, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    },
    putRaw(fileName, text) {
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, text);
      return filePath;
    },
    tree(current) {
      return buildTree(this.root, current);
    },
  };
}

function header(parent = null, id = 's') {
  const session = {
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-10-04T09:00:00.000Z',
    cwd: '/work/proj',
  };
  if (parent !== null) session.parentSession = parent;
  return [
    { type: 'title', v: 1, title: '', updatedAt: '2026-10-04T09:00:00.000Z' },
    session,
  ];
}

function withHeader(parent, entries, id = 's') {
  return [...header(parent, id), ...entries];
}

function user(id, parent, text, ts) {
  return {
    type: 'message',
    id,
    parentId: parent,
    timestamp: '2026-10-04T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
  };
}

function assistant(id, parent, text, ts) {
  return {
    type: 'message',
    id,
    parentId: parent,
    timestamp: '2026-10-04T10:00:05.000Z',
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'opus',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text },
      ],
      usage: {
        input: 3,
        output: 7,
        cacheRead: 100,
        cacheWrite: 50,
        totalTokens: 160,
        cost: { cacheRead: 0.01, cacheWrite: 0.2, total: 0.5 },
        cttl: { ephemeral1h: 50 },
      },
      timestamp: ts,
    },
  };
}

function toolResult(id, parent) {
  return {
    type: 'message',
    id,
    parentId: parent,
    timestamp: '2026-10-04T10:00:06.000Z',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(5000) }], timestamp: 1 },
  };
}

function other(kind, id, parent) {
  return { type: kind, id, parentId: parent, timestamp: '2026-10-04T10:00:07.000Z' };
}

function label(id, parent, targetId, text) {
  return { type: 'label', id, parentId: parent, timestamp: 't', targetId, label: text };
}

function compaction(id, parent, firstKeptEntryId) {
  return { type: 'compaction', id, parentId: parent, timestamp: 't', firstKeptEntryId };
}

function entry(node, id) {
  const found = node.entries.find((e) => e.id === id);
  assert.ok(found, `entry ${id} missing`);
  return found;
}

function names(node) {
  return node.files.map((file) => file.path.split(/[\\/]/).pop());
}

// ── family discovery ───────────────────────────────────────────────────────

test('family is the parentSession component of one directory', async () => {
  const fx = makeFixture('family');
  const a = fx.put(
    '2026-10-04T09-00-00-000Z_a.jsonl',
    withHeader(null, [user('u1', null, 'hi', 1)]),
  );
  const b = fx.put(
    '2026-10-04T10-00-00-000Z_b.jsonl',
    withHeader(a, [user('u1', null, 'hi', 1)]),
  );
  // A fork written with a Windows-style parent path still links by name.
  const c = fx.put('2026-10-04T11-00-00-000Z_c.jsonl', [
    {
      type: 'session',
      version: 3,
      id: 'c',
      timestamp: '2026-10-04T11:00:00.000Z',
      cwd: '/work/proj',
      parentSession: `C:\\elsewhere\\${path.basename(b)}`,
    },
  ]);
  fx.put(
    '2026-10-04T12-00-00-000Z_unrelated.jsonl',
    withHeader(null, [user('z1', null, 'other', 1)]),
  );
  const sub = path.join(fx.dir, '2026-10-04T09-00-00-000Z_a');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, '0-Explore.jsonl'),
    header(a)
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  const node = await fx.tree(c);
  assert.deepEqual(names(node), [
    '2026-10-04T11-00-00-000Z_c.jsonl',
    '2026-10-04T09-00-00-000Z_a.jsonl',
    '2026-10-04T10-00-00-000Z_b.jsonl',
  ]);
  assert.deepEqual(node.files.map((file) => file.current), [true, false, false]);
  // The same family from the root file's side.
  assert.equal((await fx.tree(a)).files.length, 3);
});

test('a parentSession written as a bare id links the family', async () => {
  const fx = makeFixture('idform');
  const rootId = '01a10000-0000-7000-8000-000000000001';
  const forkId = '01a10000-0000-7000-8000-000000000002';
  const root = fx.put(
    `2026-10-04T09-00-00-000Z_${rootId}.jsonl`,
    [header(null, rootId)[1], user('u1', null, 'q', 1)],
  );
  const fork = fx.put(
    `2026-10-04T10-00-00-000Z_${forkId}.jsonl`,
    [header(rootId, forkId)[1], user('u1', null, 'q', 1)],
  );
  // A parent found through its header id, not its file name.
  fx.put('odd-name.jsonl', [header(null, 'hdr-id')[1], user('z1', null, 'z', 1)]);
  const byHeader = fx.put('child.jsonl', [header('hdr-id', 'child-id')[1], user('z1', null, 'z', 1)]);
  // An id no listed file has links nothing.
  const dangling = fx.put('lost.jsonl', [header('no-such-id', 'lost-id')[1], user('l1', null, 'l', 1)]);

  assert.deepEqual(names(await fx.tree(fork)), [
    `2026-10-04T10-00-00-000Z_${forkId}.jsonl`,
    `2026-10-04T09-00-00-000Z_${rootId}.jsonl`,
  ]);
  assert.equal((await fx.tree(root)).files.length, 2);
  assert.deepEqual(names(await fx.tree(byHeader)), ['child.jsonl', 'odd-name.jsonl']);
  assert.deepEqual(names(await fx.tree(dangling)), ['lost.jsonl']);
});

test('family is capped nearest files first', async () => {
  const fx = makeFixture('cap');
  let prev = null;
  for (let i = 0; i < 40; i += 1) {
    const name = `f${String(i).padStart(2, '0')}.jsonl`;
    fx.put(name, withHeader(prev, [user(`u${String(i).padStart(2, '0')}`, null, 'x', 1)]));
    prev = fx.path(name);
  }
  const node = await fx.tree(fx.path('f00.jsonl'));
  assert.equal(node.files.length, MAX_FAMILY_FILES);
  assert.equal(names(node)[0], 'f00.jsonl');
  assert.equal(names(node)[MAX_FAMILY_FILES - 1], 'f31.jsonl');
});

test('symlinks and non-jsonl neighbours never join the family', async () => {
  const fx = makeFixture('links');
  const real = fx.put('real.jsonl', withHeader(null, [user('u1', null, 'q', 1)]));
  fx.putRaw('notes.txt', '{}\n');
  fs.symlinkSync(real, fx.path('link.jsonl'));
  assert.deepEqual(await familyOf(fx.dir, 'real.jsonl'), ['real.jsonl']);
});

// ── entries ────────────────────────────────────────────────────────────────

test('kept facts: kind, timestamps, usage, label, compaction at once', async () => {
  const fx = makeFixture('facts');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'hi', 1),
      assistant('a1', 'u1', 'yo', 2),
      toolResult('t1', 'a1'),
      label('l1', 't1', 'u1', 'draft'),
      compaction('k1', 't1', 'u1'),
    ]),
  );
  const node = await fx.tree(file);

  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'a1', 'k1']);
  const u1 = entry(node, 'u1');
  assert.deepEqual(
    [u1.kind, u1.parentId, u1.ts, u1.at, u1.text, u1.agent, u1.label, u1.inCurrent],
    ['user', null, 1, '2026-10-04T10:00:00.000Z', 'hi', false, 'draft', true],
  );
  const a1 = entry(node, 'a1');
  assert.equal(a1.kind, 'assistant');
  assert.equal(a1.parentId, 'u1');
  assert.equal(a1.ts, 2);
  assert.deepEqual(a1.usage, {
    input: 3,
    output: 7,
    cacheRead: 100,
    cacheWrite: 50,
    ttl: 3600,
    costRead: 0.01,
    costWrite: 0.2,
  });
  const k1 = entry(node, 'k1');
  assert.deepEqual(
    [k1.kind, k1.parentId, k1.firstKeptId, k1.firstKeptExact, k1.text, k1.ts, k1.usage],
    ['compaction', 'a1', 'u1', true, null, null, null],
  );
  assert.deepEqual(node.files[0], {
    path: file,
    cwd: '/work/proj',
    title: null,
    leafId: 'k1',
    current: true,
  });
});

test('non-kept entries collapse into their nearest kept ancestor', async () => {
  const fx = makeFixture('collapse');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      other('model_change', 'm0', null),
      user('u1', 'm0', 'first', 10),
      assistant('a1', 'u1', 'calling', 20),
      toolResult('t1', 'a1'),
      other('custom', 'c1', 't1'),
      other('custom_message', 'c2', 'c1'),
      other('model_change', 'm1', 'c2'),
      user('u2', 'm1', 'second', 30),
    ]),
  );
  const node = await fx.tree(file);
  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'a1', 'u2']);
  assert.equal(entry(node, 'u1').parentId, null);
  assert.equal(entry(node, 'a1').parentId, 'u1');
  assert.equal(entry(node, 'u2').parentId, 'a1');
  assert.equal(node.files[0].leafId, 'u2');
});

test('warm records and compactions are kept, other model usage is not', async () => {
  const fx = makeFixture('warm');
  const warm = {
    type: 'model_usage',
    id: 'w1',
    parentId: 'a1',
    timestamp: '2026-10-04T10:05:00.000Z',
    purpose: 'cache-warm',
  };
  const memory = {
    type: 'model_usage',
    id: 'w2',
    parentId: 'w1',
    timestamp: '2026-10-04T10:06:00.000Z',
    purpose: 'memory',
  };
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('a1', 'u1', 'r', 2),
      warm,
      memory,
      other('compaction', 'k1', 'w2'),
    ]),
  );
  const node = await fx.tree(file);
  assert.deepEqual(
    node.entries.map((e) => [e.id, e.kind]),
    [
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['w1', 'warm'],
      ['k1', 'compaction'],
    ],
  );
  assert.equal(entry(node, 'k1').parentId, 'w1');
  assert.equal(entry(node, 'w1').at, '2026-10-04T10:05:00.000Z');
});

test('shared prefix merges by id and inCurrent follows the current file', async () => {
  const fx = makeFixture('merge');
  const a = fx.put(
    'a.jsonl',
    withHeader(null, [
      user('u1', null, 'one', 1),
      assistant('a1', 'u1', 'r1', 2),
      user('u2', 'a1', 'two', 3),
      assistant('a2', 'u2', 'r2', 4),
    ]),
  );
  const b = fx.put(
    'b.jsonl',
    withHeader(a, [user('u1', null, 'one', 1), assistant('a1', 'u1', 'r1', 2), user('u3', 'a1', 'three', 5)]),
  );
  const node = await fx.tree(b);
  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'a1', 'u3', 'u2', 'a2']);
  assert.deepEqual(
    node.entries.map((e) => e.inCurrent),
    [true, true, true, false, false],
  );
  assert.equal(entry(node, 'u3').parentId, 'a1');
  assert.equal(entry(node, 'u2').parentId, 'a1');
  // Every parent precedes its children.
  node.entries.forEach((e, i) => {
    if (e.parentId === null) return;
    assert.ok(
      node.entries.slice(0, i).some((x) => x.id === e.parentId),
      `${e.parentId} after ${e.id}`,
    );
  });
  assert.deepEqual(
    node.files.map((file) => [path.basename(file.path), file.current, file.leafId]),
    [
      ['b.jsonl', true, 'u3'],
      ['a.jsonl', false, 'a2'],
    ],
  );
});

test('leaf is the last entry mapped to its kept ancestor', async () => {
  const fx = makeFixture('leaf');
  const a = fx.put(
    'a.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('a1', 'u1', 'r', 2),
      toolResult('t1', 'a1'),
      other('custom', 'c1', 't1'),
    ]),
  );
  fx.put('b.jsonl', withHeader(a, [user('u1', null, 'q', 1), user('u9', 'u1', 'w', 3)]));
  const node = await fx.tree(a);
  const leaf = (name) => node.files.find((file) => file.path.endsWith(name)).leafId;
  assert.equal(leaf('a.jsonl'), 'a1');
  assert.equal(leaf('b.jsonl'), 'u9');
});

test('ttl and costs come from cttl and cost', async () => {
  const fx = makeFixture('ttl');
  const plain = (id, parent, usage) => ({
    type: 'message',
    id,
    parentId: parent,
    timestamp: 't',
    message: { role: 'assistant', content: [], usage, timestamp: 9 },
  });
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('one', 'u1', 'h', 2),
      plain('five', 'one', {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { cacheRead: 0.5, cacheWrite: 0.25 },
        cttl: { ephemeral5m: 9, ephemeral1h: 0 },
      }),
      plain('none', 'five', { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    ]),
  );
  const node = await fx.tree(file);
  const one = entry(node, 'one').usage;
  assert.deepEqual([one.ttl, one.costRead, one.costWrite], [3600, 0.01, 0.2]);
  assert.deepEqual([one.input, one.output, one.cacheRead, one.cacheWrite], [3, 7, 100, 50]);
  const minutes = entry(node, 'five').usage;
  assert.deepEqual([minutes.ttl, minutes.costRead, minutes.costWrite], [300, 0.5, 0.25]);
  const none = entry(node, 'none').usage;
  assert.deepEqual([none.ttl, none.costRead, none.costWrite], [null, null, null]);
  assert.equal(entry(node, 'u1').usage, null);
});

test('text is trimmed, first non-empty, and cut on a code-point boundary', async () => {
  const fx = makeFixture('text');
  const long = `a${'é'.repeat(400)}`;
  const blocks = {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '  \n ' },
        { type: 'toolCall', name: 'x', arguments: { text: 'nope' } },
        { type: 'text', text: '\n  the answer  ' },
      ],
      timestamp: 2,
    },
  };
  const stringContent = {
    type: 'message',
    id: 'u2',
    parentId: 'a1',
    timestamp: 't',
    message: { role: 'user', content: '  plain string  ', timestamp: 3 },
  };
  const agent = {
    type: 'message',
    id: 'u3',
    parentId: 'u2',
    timestamp: 't',
    message: { role: 'user', attribution: 'agent', content: [{ type: 'text', text: 'nudge' }], timestamp: 4 },
  };
  const synthetic = {
    type: 'message',
    id: 'u4',
    parentId: 'u3',
    timestamp: 't',
    message: { role: 'user', synthetic: true, content: [{ type: 'text', text: 'gen' }], timestamp: 5 },
  };
  const imageOnly = {
    type: 'message',
    id: 'u5',
    parentId: 'u4',
    timestamp: 't',
    message: { role: 'user', content: [{ type: 'image', data: 'AAAA' }], timestamp: 6 },
  };
  const file = fx.put(
    's.jsonl',
    withHeader(null, [user('u1', null, long, 1), blocks, stringContent, agent, synthetic, imageOnly]),
  );
  const node = await fx.tree(file);
  const u1 = entry(node, 'u1').text;
  assert.equal(Array.from(u1).length, 300);
  assert.ok(u1.startsWith('aéé'));
  assert.equal(entry(node, 'a1').text, 'the answer');
  assert.equal(entry(node, 'u2').text, 'plain string');
  assert.equal(entry(node, 'u2').agent, false);
  assert.equal(entry(node, 'u3').agent, true);
  assert.equal(entry(node, 'u4').agent, true);
  assert.equal(entry(node, 'u5').text, null);
  // The same clip rule, unit-tested.
  assert.equal(clip('   '), null);
  assert.equal(clip(` ${'x'.repeat(299)} `), 'x'.repeat(299));
  assert.equal(Array.from(clip(`${'x'.repeat(300)}${'y'.repeat(5)}`)).length, 300);
});

test('labels follow the latest entry and an empty label deletes', async () => {
  const fx = makeFixture('labels');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('a1', 'u1', 'r', 2),
      user('u2', 'a1', 'q2', 3),
      toolResult('t1', 'u2'),
      label('l1', 't1', 'u1', 'draft'),
      label('l2', 'l1', 'u1', 'final'),
      label('l3', 'l2', 'u2', 'gone'),
      label('l4', 'l3', 'u2', ''),
      // Aimed at a collapsed entry: shown on its kept ancestor.
      label('l5', 'l4', 't1', 'on the tool'),
    ]),
  );
  const node = await fx.tree(file);
  assert.equal(entry(node, 'u1').label, 'final');
  assert.equal(entry(node, 'a1').label, null);
  assert.equal(entry(node, 'u2').label, 'on the tool');
});

test('clearing the label of a collapsed entry keeps its ancestor own label', async () => {
  const fx = makeFixture('labels_collapsed');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('a1', 'u1', 'r', 2),
      toolResult('t1', 'a1'),
      label('l1', 't1', 'a1', 'important'),
      label('l2', 'l1', 't1', 'check'),
      label('l3', 'l2', 't1', ''),
    ]),
  );
  const node = await fx.tree(file);
  assert.equal(entry(node, 'a1').label, 'important');
});

test('compaction maps its first kept entry to a kept ancestor', async () => {
  const fx = makeFixture('compaction');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      assistant('a1', 'u1', 'r', 2),
      toolResult('t1', 'a1'),
      user('u2', 't1', 'q2', 3),
      compaction('k1', 'u2', 'u2'),
      compaction('k2', 'k1', 't1'),
      compaction('k3', 'k2', 'gone'),
    ]),
  );
  const node = await fx.tree(file);
  const k1 = entry(node, 'k1');
  assert.deepEqual([k1.firstKeptId, k1.firstKeptExact], ['u2', true]);
  const k2 = entry(node, 'k2');
  assert.deepEqual([k2.firstKeptId, k2.firstKeptExact], ['a1', false]);
  const k3 = entry(node, 'k3');
  assert.deepEqual([k3.firstKeptId, k3.firstKeptExact], [null, false]);
});

test('file facts: title, cwd and malformed lines', async () => {
  const fx = makeFixture('facts2');
  const a = fx.put('a.jsonl', withHeader(null, [user('u1', null, 'q', 1)]));
  const renamed = {
    type: 'title_change',
    id: 'tc',
    parentId: 'u1',
    timestamp: '2026-10-04T09:30:00.000Z',
    title: 'Early name',
  };
  const file = fx.putRaw(
    'b.jsonl',
    [
      JSON.stringify({ type: 'title', v: 1, title: 'Newest name', updatedAt: '2026-10-04T11:00:00.000Z' }),
      JSON.stringify(header(a)[1]),
      'not json',
      '',
      '{"type":"message"',
      JSON.stringify(user('u1', null, 'q', 1)),
      JSON.stringify(renamed),
      JSON.stringify(user('u2', 'tc', 'after junk', 2)),
    ].join('\n') + '\n',
  );
  const node = await fx.tree(file);
  const thisFile = node.files[0];
  assert.equal(thisFile.title, 'Newest name');
  assert.equal(thisFile.cwd, '/work/proj');
  assert.equal(thisFile.path, file);
  assert.equal(entry(node, 'u2').parentId, 'u1');

  // With an empty title line the latest title_change wins.
  const renamedWith = (id, title, at) => ({
    type: 'title_change',
    id,
    parentId: 'u1',
    timestamp: at,
    title,
  });
  const c = fx.put(
    'c.jsonl',
    withHeader(null, [
      user('u1', null, 'q', 1),
      renamedWith('tc1', 'First', '2026-10-04T09:30:00.000Z'),
      renamedWith('tc2', 'Second', '2026-10-04T09:45:00.000Z'),
    ]),
  );
  assert.equal((await fx.tree(c)).files[0].title, 'Second');
  const fromA = await fx.tree(a);
  assert.equal(fromA.files.find((f) => f.path.endsWith('a.jsonl')).title, null);
});

test('strict line typing drops a line with one wrong-typed field', async () => {
  const fx = makeFixture('strict');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [
      // `id` must be a string: the whole line is dropped.
      { type: 'message', id: 5, parentId: null, message: { role: 'user', content: 'x' } },
      // `usage.input` must be u64: the whole assistant line is dropped.
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'r' }], usage: { input: '3' } },
      },
      // Present-but-null `cost` is a struct type error, unlike an absent one.
      {
        type: 'message',
        id: 'a2',
        parentId: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'r' }],
          usage: { input: 1, output: 2, cost: null },
        },
      },
      // An unknown field never costs the line.
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'kept', usage: { input: 1, output: 2 } },
        extra: { anything: true },
      },
      // A block array whose element is not an object loses the text only.
      {
        type: 'message',
        id: 'u2',
        parentId: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'nope' }, 7] },
      },
    ]),
  );
  const node = await fx.tree(file);
  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'u2']);
  assert.equal(entry(node, 'u1').text, 'kept');
  assert.equal(entry(node, 'u2').text, null);
  // A non-text first block does not stop the search for text.
  assert.equal(firstText([{ type: 'text', text: '   ' }, { type: 'text', text: ' real ' }]), 'real');
  assert.equal(firstText({ type: 'text', text: 'x' }), null);
});

// ── validation ─────────────────────────────────────────────────────────────

test('only existing .jsonl files under the root are accepted', async () => {
  const fx = makeFixture('validate');
  const good = fx.put('s.jsonl', withHeader(null, [user('u1', null, 'q', 1)]));
  assert.ok((await buildTree(fx.root, good)).files.length === 1);

  // omp writes the file lazily, so the path of a fresh tab is not there yet:
  // an empty tree while the directory is confined, an error otherwise.
  const unwritten = await buildTree(fx.root, fx.path('nope.jsonl'));
  assert.deepEqual(unwritten, { files: [], entries: [] });
  await assert.rejects(
    buildTree(fx.root, path.join(fx.root, '--gone--', 'nope.jsonl')),
    /does not exist: .*nope\.jsonl/,
  );
  await assert.rejects(buildTree(fx.root, fx.path('nope.txt')), /\.jsonl session file/);

  const text = fx.putRaw('notes.txt', '{}\n');
  await assert.rejects(buildTree(fx.root, text), /\.jsonl session file/);

  const elsewhere = makeFixture('validate_other');
  const outside = elsewhere.put('o.jsonl', withHeader(null, []));
  await assert.rejects(buildTree(fx.root, outside), /outside the sessions directory/);

  // A `..` hop that leaves the root is judged by where it lands.
  const sneaky = path.join(
    fx.dir,
    '..',
    '..',
    path.basename(elsewhere.root),
    '--work-proj--',
    'o.jsonl',
  );
  await assert.rejects(buildTree(fx.root, sneaky), /outside the sessions directory/);
  // An unwritten file is confined the same way, `..` hop or not.
  await assert.rejects(
    buildTree(fx.root, elsewhere.path('fresh.jsonl')),
    /outside the sessions directory/,
  );
  await assert.rejects(
    buildTree(fx.root, path.join(fx.dir, '..', '..', path.basename(elsewhere.root), '--work-proj--', 'fresh.jsonl')),
    /outside the sessions directory/,
  );
  // A directory is not a session file.
  await assert.rejects(buildTree(fx.root, fx.dir), /has no usable file name|\.jsonl/);
  // A dangling link is not an unwritten file.
  const dangling = fx.path('dangle.jsonl');
  fs.symlinkSync(fx.path('nowhere.jsonl'), dangling);
  await assert.rejects(buildTree(fx.root, dangling), /dangling link/);
  // A missing sessions root surfaces the root error.
  await assert.rejects(buildTree(path.join(fx.root, 'no-root'), good), /sessions directory unavailable/);
});

test('an unreadable current file errors, an unreadable relative is left out', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores file modes');
    return;
  }
  const fx = makeFixture('unreadable');
  const a = fx.put('a.jsonl', withHeader(null, [user('u1', null, 'q', 1)]));
  const b = fx.put('b.jsonl', withHeader(a, [user('u1', null, 'q', 1)]));

  // The current file is what the command was asked for: its failure surfaces.
  fs.chmodSync(b, 0o000);
  await assert.rejects(
    fx.tree(b),
    /cannot read .*b\.jsonl: Permission denied \(os error 13\)/,
  );
  fs.chmodSync(b, 0o644);

  // A relative whose header still links it but whose body cannot be opened is
  // skipped: the listing must not fail, and the file drops out of the family.
  fs.chmodSync(a, 0o000);
  try {
    const node = await fx.tree(b);
    assert.deepEqual(names(node), ['b.jsonl']);
    assert.equal(node.files[0].current, true);
  } finally {
    fs.chmodSync(a, 0o644);
  }
  assert.equal((await fx.tree(b)).files.length, 2);
});

test('invalid UTF-8 lines are consumed and skipped', async () => {
  const fx = makeFixture('utf8');
  const valid = (line) => Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
  const file = fx.path('s.jsonl');
  fs.writeFileSync(
    file,
    Buffer.concat([
      ...header(null).map(valid),
      valid(user('u1', null, 'q', 1)),
      Buffer.from([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0xff, 0xfe, 0x7d, 0x0a]),
      valid(user('u2', 'u1', 'after', 2)),
    ]),
  );
  const node = await fx.tree(file);
  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'u2']);
  assert.equal(entry(node, 'u2').parentId, 'u1');
});

test('lines longer than the read chunk still parse', async () => {
  const fx = makeFixture('longline');
  const huge = 'z'.repeat(200 * 1024);
  const file = fx.put(
    's.jsonl',
    withHeader(null, [user('u1', null, huge, 1), user('u2', 'u1', 'after', 2)]),
  );
  const node = await fx.tree(file);
  assert.deepEqual(node.entries.map((e) => e.id), ['u1', 'u2']);
  assert.equal(Array.from(entry(node, 'u1').text).length, 300);
});

test('the session header is only read from the first four lines', async () => {
  const fx = makeFixture('headerwindow');
  const parent = fx.put('parent.jsonl', withHeader(null, [user('u1', null, 'q', 1)]));
  const late = [
    { type: 'title', v: 1, title: '', updatedAt: '1' },
    { type: 'title', v: 1, title: '', updatedAt: '2' },
    { type: 'title', v: 1, title: '', updatedAt: '3' },
    { type: 'title', v: 1, title: '', updatedAt: '4' },
    { type: 'session', version: 3, id: 'late', cwd: '/work/proj', parentSession: parent },
    user('u9', null, 'q', 9),
  ];
  const file = fx.put('late.jsonl', late);
  assert.deepEqual(await familyOf(fx.dir, 'late.jsonl'), ['late.jsonl']);
  // The entries still parse; only the link was invisible.
  assert.deepEqual((await parseFile(file)).entries.map((e) => e.id), ['u9']);
});

// ── serde shape ────────────────────────────────────────────────────────────

test('serialises the contract field names', async () => {
  const fx = makeFixture('json');
  const file = fx.put(
    's.jsonl',
    withHeader(null, [user('u1', null, 'q', 1), assistant('a1', 'u1', 'r', 2)]),
  );
  const value = JSON.parse(JSON.stringify(await fx.tree(file)));
  assert.deepEqual(Object.keys(value).sort(), ['entries', 'files']);
  assert.deepEqual(Object.keys(value.files[0]).sort(), ['current', 'cwd', 'leafId', 'path', 'title']);
  assert.deepEqual(Object.keys(value.entries[1]).sort(), [
    'agent',
    'at',
    'firstKeptExact',
    'firstKeptId',
    'id',
    'inCurrent',
    'kind',
    'label',
    'parentId',
    'text',
    'ts',
    'usage',
  ]);
  assert.deepEqual(Object.keys(value.entries[1].usage).sort(), [
    'cacheRead',
    'cacheWrite',
    'costRead',
    'costWrite',
    'input',
    'output',
    'ttl',
  ]);
  assert.equal(value.entries[0].kind, 'user');
  assert.equal(value.entries[0].ts, 1);
  assert.equal(value.entries[1].parentId, 'u1');
  // Absent optionals serialise as null, never as missing keys.
  assert.equal(value.entries[0].parentId, null);
  assert.equal(value.files[0].title, null);
});

// ── frontend consumer ──────────────────────────────────────────────────────

test('the real navigator model consumes this module output', async (t) => {
  const dist = new URL('../dist/app/', import.meta.url);
  const graph = new URL('conversation-tree-graph.js', dist);
  const model = new URL('conversation-tree.js', dist);
  if (!fs.existsSync(graph) || !fs.existsSync(model)) {
    t.skip('built frontend not present');
    return;
  }
  const fx = makeFixture('consumer');
  const a = fx.put(
    'a.jsonl',
    withHeader(null, [
      user('u1', null, 'one', 1),
      assistant('a1', 'u1', 'r1', 2),
      user('u2', 'a1', 'two', 3),
      assistant('a2', 'u2', 'r2', 4),
    ]),
  );
  const b = fx.put(
    'b.jsonl',
    withHeader(a, [user('u1', null, 'one', 1), assistant('a1', 'u1', 'r1', 2), user('u3', 'a1', 'three', 5)]),
  );
  const node = JSON.parse(JSON.stringify(await fx.tree(b)));

  const ctx = vm.createContext({ window: {} });
  for (const file of [graph, model]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file.pathname) });
  }
  const tree = ctx.window.OMP_CONV_TREE.buildModel(node, { now: Date.now(), since: null });
  // The merged family's prompts, in path order, including the branch's own.
  assert.deepEqual(tree.rows.map((row) => row.id), ['u1', 'u2', 'u3']);
  assert.deepEqual(tree.rows.map((row) => row.kind), ['prompt', 'prompt', 'prompt']);
  assert.equal(tree.tips.length, 2, 'one tip per family file');
  assert.equal(tree.counts.total, 3);
});

// ── command wrapper ────────────────────────────────────────────────────────

test('conversationTree resolves the profile agent dir and rejects the unknown', async () => {
  const home = makeTestDir('home');
  const sessions = path.join(home, '.omp', 'agent', 'sessions', '--proj--');
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'a.jsonl');
  fs.writeFileSync(file, withHeader(null, [user('u1', null, 'q', 1)]).map((l) => `${JSON.stringify(l)}\n`).join(''));

  const configDir = makeTestDir('config');
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OMP_PORT_CONFIG_DIR: process.env.OMP_PORT_CONFIG_DIR,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.OMP_PORT_CONFIG_DIR = configDir;
  try {
    const node = await conversationTree({ sessionFile: file, profile: null });
    assert.equal(node.files[0].current, true);
    assert.equal(node.files[0].path, file);
    assert.deepEqual(node.entries.map((e) => e.id), ['u1']);

    // "" and "default" both name the built-in profile.
    assert.equal((await conversationTree({ sessionFile: file, profile: '' })).entries.length, 1);
    assert.equal((await conversationTree({ sessionFile: file, profile: 'default' })).entries.length, 1);

    await assert.rejects(
      conversationTree({ sessionFile: file, profile: 'ghost' }),
      /unknown profile: "ghost"/,
    );
    await assert.rejects(conversationTree({}), /missing sessionFile/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ── a real session file (read-only) ────────────────────────────────────────

test('a real session file parses read-only and yields nodes', async () => {
  const env = process.env.PI_CODING_AGENT_DIR;
  const root = env ? path.join(env, 'sessions') : path.join(os.homedir(), '.omp', 'agent', 'sessions');
  let newest = null;
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of dirs) {
    const full = path.join(root, dir.name);
    for (const item of fs.readdirSync(full, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const file = path.join(full, item.name);
      const { mtimeMs } = fs.statSync(file);
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  }
  assert.ok(newest, `no session .jsonl under ${root}`);

  const node = await buildTree(root, newest.file);
  assert.ok(node.files.length >= 1, 'family has the current file');
  assert.equal(node.files[0].current, true);
  assert.equal(node.files[0].path, newest.file);
  assert.ok(node.entries.length >= 1, `expected kept entries, got ${node.entries.length}`);
  const kinds = new Set(['user', 'assistant', 'compaction', 'warm']);
  for (const e of node.entries) {
    assert.ok(kinds.has(e.kind), `unexpected kind ${e.kind}`);
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.inCurrent, 'boolean');
  }
  // Parents still precede children after the merge.
  const seen = new Set();
  for (const e of node.entries) {
    if (e.parentId !== null) assert.ok(seen.has(e.parentId), `${e.parentId} after ${e.id}`);
    seen.add(e.id);
  }
  process.stderr.write(
    `[conversation-tree] real ${path.basename(newest.file)}: ${node.files.length} files, ${node.entries.length} entries\n`,
  );
});