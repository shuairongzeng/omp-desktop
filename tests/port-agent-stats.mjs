/* Port parity tests for electron/backend/agent-stats.js.

   Mirrors the Rust modules named in each section, with fixtures built from
   the Rust `#[cfg(test)]` cases and the command contracts in lib.rs:

     model_usage.rs    — a temp `agent.db` with omp's own WAL schema
     stats.rs          — a fake `omp` on the trusted PATH printing a dashboard
     goal_config.rs    — a fake `omp` implementing `config get|set`
     prompt_history.rs — `prompt-history.json` under a temp config dir

   Run with: node tests/port-agent-stats.mjs */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const stats = require('../electron/backend/agent-stats.js');

const {
  modelUsageList,
  usageStats,
  goalContinuationGet,
  goalContinuationSet,
  promptHistoryList,
  promptHistoryRecord,
  MAX_KEYS,
  MAX_PROMPTS,
  MAX_PROMPT_BYTES,
  usageDbPath,
  exitFailureMessage,
  statsArgs,
  parseStatsJson,
  getArgs,
  setArgs,
  parseModes,
  nextModes,
  promptHistoryPath,
} = stats;

const scratchDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-port-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` with a temporary environment, restoring it afterwards. */
function withEnv(t, patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return fn();
}

/** Prepend `dir` to PATH for the duration of the test. */
function withPath(t, dir) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved ?? ''}`;
  t.after(() => {
    process.env.PATH = saved;
  });
}

// ── model_usage.rs ──────────────────────────────────────────────────────────

/** A writable connection set up the way omp's `AgentStorage` does it. */
function ompDb(file) {
  const conn = new DatabaseSync(file);
  conn.exec(
    `PRAGMA journal_mode=WAL;
     CREATE TABLE model_usage (
         model_key TEXT PRIMARY KEY,
         last_used_at INTEGER NOT NULL
     );`,
  );
  return conn;
}

function used(conn, key, at) {
  conn
    .prepare(
      `INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)
       ON CONFLICT(model_key) DO UPDATE SET last_used_at = ?`,
    )
    .run(key, at, at);
}

/** Point the built-in profile's agent dir (and so `agent.db`) at a temp dir. */
function withAgentDir(t) {
  const dir = tempDir('agentdir');
  withEnv(t, { PI_CODING_AGENT_DIR: dir, OMP_PORT_CONFIG_DIR: tempDir('config') }, () => {});
  return dir;
}

test('model_usage: newest_first_ties_by_key_and_capped', (t) => {
  const dir = withAgentDir(t);
  const db = path.join(dir, 'agent.db');
  const conn = ompDb(db);
  used(conn, 'anthropic/claude-sonnet-4-6', 100);
  used(conn, 'openai/gpt-5.2', 300);
  used(conn, 'anthropic/claude-opus-4-6', 200);
  used(conn, 'anthropic/claude-haiku-4-5', 200);
  // An upsert moves an existing key, it does not add a second row.
  used(conn, 'anthropic/claude-sonnet-4-6', 400);
  conn.close();

  assert.deepEqual(modelUsageList(null), [
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.2',
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-opus-4-6',
  ]);
});

test('model_usage: caps_at_MAX_KEYS_newest_first', (t) => {
  const dir = withAgentDir(t);
  const db = path.join(dir, 'agent.db');
  const conn = ompDb(db);
  for (let i = 0; i < 25; i += 1) used(conn, `provider/model-${String(i).padStart(2, '0')}`, i);
  conn.close();

  const keys = modelUsageList(null);
  assert.equal(keys.length, MAX_KEYS);
  assert.equal(keys[0], 'provider/model-24');
  assert.equal(keys[19], 'provider/model-05');
});

test('model_usage: missing_database_is_empty_and_not_created', (t) => {
  const dir = withAgentDir(t);
  const db = path.join(dir, 'agent.db');
  assert.equal(fs.existsSync(db), false);
  assert.deepEqual(modelUsageList(null), []);
  assert.equal(fs.existsSync(db), false, 'a fresh profile must not grow a db');
});

test('model_usage: unreadable_database_reads_as_empty', (t) => {
  const dir = withAgentDir(t);
  // A directory where the database should be is not a readable database.
  fs.mkdirSync(path.join(dir, 'agent.db'));
  assert.deepEqual(modelUsageList(null), []);
});

test('model_usage: schema_drift_reads_as_empty', (t) => {
  const dir = withAgentDir(t);
  const conn = new DatabaseSync(path.join(dir, 'agent.db'));
  conn.exec('CREATE TABLE something_else (a TEXT)');
  conn.close();
  assert.deepEqual(modelUsageList(null), []);
});

test('model_usage: unknown_profile_is_refused', (t) => {
  withEnv(t, { OMP_PORT_CONFIG_DIR: tempDir('config'), PI_CODING_AGENT_DIR: tempDir('agent') }, () => {
    assert.throws(() => modelUsageList('work'), /unknown profile: "work"/);
  });
});

test('model_usage: built-in profile resolves through agentDirFor', (t) => {
  const dir = tempDir('agentdir');
  withEnv(t, { PI_CODING_AGENT_DIR: dir }, () => {
    assert.equal(usageDbPath(null), path.join(dir, 'agent.db'));
  });
});

// ── stats.rs ────────────────────────────────────────────────────────────────

const AGG_OVERALL = {
  totalRequests: 10,
  successfulRequests: 9,
  failedRequests: 1,
  errorRate: 0.1,
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCacheReadTokens: 200,
  totalCacheWriteTokens: 50,
  cacheRate: 0.2,
  cacheSavings: 0.15,
  totalCost: 1.23,
  unpricedRequests: 0,
  totalPremiumRequests: 2.33,
  avgDuration: 1200.5,
  avgTtft: 300,
  avgTokensPerSecond: 42,
  firstTimestamp: 1000,
  lastTimestamp: 2000,
};

const AGG_MODEL = {
  totalRequests: 6,
  successfulRequests: 5,
  failedRequests: 1,
  errorRate: 0.166,
  totalInputTokens: 600,
  totalOutputTokens: 300,
  totalCacheReadTokens: 120,
  totalCacheWriteTokens: 30,
  cacheRate: 0.2,
  cacheSavings: 0.1,
  totalCost: 0.75,
  unpricedRequests: 1,
  totalPremiumRequests: 0.33,
  avgDuration: null,
  avgTtft: null,
  avgTokensPerSecond: null,
  firstTimestamp: 1000,
  lastTimestamp: 1800,
};

const AGG_FOLDER = {
  totalRequests: 4,
  successfulRequests: 4,
  failedRequests: 0,
  errorRate: 0,
  totalInputTokens: 400,
  totalOutputTokens: 200,
  totalCacheReadTokens: 80,
  totalCacheWriteTokens: 20,
  cacheRate: 0.2,
  cacheSavings: 0.05,
  totalCost: 0.48,
  unpricedRequests: 0,
  totalPremiumRequests: 1.75,
  avgDuration: 900,
  avgTtft: 250,
  avgTokensPerSecond: 30,
  firstTimestamp: 1500,
  lastTimestamp: 1700,
};

const AGENT_TYPE = {
  agentType: 'main',
  totalRequests: 8,
  totalInputTokens: 900,
  totalOutputTokens: 450,
  totalCacheReadTokens: 180,
  totalCacheWriteTokens: 45,
  totalCost: 1.1,
};

/**
 * `omp stats --json` shape: a `Synced …` progress line on stdout before the
 * JSON object, plus upstream time-series keys serde drops.
 */
function dashboardPayload(overall = AGG_OVERALL) {
  return {
    overall,
    byModel: [{ model: 'claude-5-sonnet', provider: 'anthropic', ...AGG_MODEL }],
    byFolder: [{ folder: '/home/user/project', ...AGG_FOLDER }],
    byAgentType: [AGENT_TYPE],
    timeSeries: [{ ignored: true }],
    modelSeries: [],
    modelPerformanceSeries: [],
    costSeries: [],
  };
}

test('stats: stats_args_put_profile_flag_before_subcommand', () => {
  assert.deepEqual(statsArgs(null), ['stats', '--json']);
  assert.deepEqual(statsArgs(''), ['stats', '--json']);
  assert.deepEqual(statsArgs('work'), ['--profile=work', 'stats', '--json']);
});

test('stats: fixture payload matches hand-computed dashboard numbers', () => {
  const preamble = 'Synced 4 new entries from 2 files (12 total)\n';
  const raw = Buffer.from(`${preamble}${JSON.stringify(dashboardPayload())}\n`);
  const parsed = parseStatsJson(raw);

  assert.deepEqual(parsed, {
    overall: AGG_OVERALL,
    byModel: [{ model: 'claude-5-sonnet', provider: 'anthropic', ...AGG_MODEL }],
    byFolder: [{ folder: '/home/user/project', ...AGG_FOLDER }],
    byAgentType: [AGENT_TYPE],
  });
  // serde drops unknown fields — the serialized shape carries only the
  // struct's own keys, in declaration order.
  assert.deepEqual(Object.keys(parsed), ['overall', 'byModel', 'byFolder', 'byAgentType']);
  assert.deepEqual(Object.keys(parsed.overall), Object.keys(AGG_OVERALL));
  assert.deepEqual(Object.keys(parsed.byModel[0]), ['model', 'provider', ...Object.keys(AGG_OVERALL)]);
  assert.deepEqual(parsed.overall.avgTtft, 300, 'integer JSON is a valid f64');
  assert.equal(parsed.overall.totalPremiumRequests, 2.33, 'fractional premium requests parse');
});

test('stats: breakdowns_default_to_empty_sequences', () => {
  const raw = `{"overall":${JSON.stringify(AGG_OVERALL)}}`;
  const parsed = parseStatsJson(Buffer.from(raw));
  assert.deepEqual(parsed.byModel, []);
  assert.deepEqual(parsed.byFolder, []);
  assert.deepEqual(parsed.byAgentType, []);
});

test('stats: output_without_a_json_object_is_malformed', () => {
  assert.throws(
    () => parseStatsJson(Buffer.from('Synced 4 new entries from 2 files\n')),
    (err) => err.message === 'omp stats output contained no JSON object',
  );
});

test('stats: missing_and_mistyped_fields_match_serde_errors', () => {
  assert.throws(
    () => parseStatsJson(Buffer.from('{"byModel":[]}')),
    /^Error: failed to parse omp stats output: missing field `overall`$/,
  );
  assert.throws(
    () => parseStatsJson(Buffer.from('{"overall":{}}')),
    /failed to parse omp stats output: missing field `totalRequests`$/,
  );
  assert.throws(
    () => parseStatsJson(
      Buffer.from(`{"overall":${JSON.stringify({ ...AGG_OVERALL, totalRequests: '10' })}}`),
    ),
    /failed to parse omp stats output: invalid type: string "10", expected u64$/,
  );
  assert.throws(
    () => parseStatsJson(
      Buffer.from(`{"overall":${JSON.stringify({ ...AGG_OVERALL, totalRequests: -1 })}}`),
    ),
    /failed to parse omp stats output: invalid value: integer `-1`, expected u64$/,
  );
  assert.throws(
    () => parseStatsJson(
      Buffer.from(`{"overall":${JSON.stringify(AGG_OVERALL)},"byModel":{}}`),
    ),
    /failed to parse omp stats output: invalid type: map, expected a sequence$/,
  );
  // `#[serde(default)]` fills a missing field only; null is a type error.
  assert.throws(
    () => parseStatsJson(
      Buffer.from(`{"overall":${JSON.stringify(AGG_OVERALL)},"byModel":null}`),
    ),
    /failed to parse omp stats output: invalid type: null, expected a sequence$/,
  );
});

/** Write a fake `omp` executable into a temp dir and return that dir. */
function fakeOmp(t) {
  const dir = tempDir('bin');
  const file = path.join(dir, 'omp');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_OMP_LOG) {
  fs.appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify(args) + '\\n');
}
const sub = args.find((a) => a === 'stats' || a === 'config');
if (sub === 'stats') {
  if (process.env.FAKE_OMP_STDERR) process.stderr.write(process.env.FAKE_OMP_STDERR);
  if (process.env.FAKE_OMP_STDOUT_FILE) {
    process.stdout.write(fs.readFileSync(process.env.FAKE_OMP_STDOUT_FILE));
  } else if (process.env.FAKE_OMP_STDOUT) {
    process.stdout.write(process.env.FAKE_OMP_STDOUT);
  }
  process.exit(Number(process.env.FAKE_OMP_EXIT || '0'));
}
const state = process.env.FAKE_OMP_STATE;
const key = 'goal.continuationModes';
const read = () => {
  try { return JSON.parse(fs.readFileSync(state, 'utf8')); }
  catch { return ['interactive']; }
};
const verb = args[args.indexOf('config') + 1];
if (verb === 'get') {
  process.stdout.write(JSON.stringify({
    key, value: read(), type: 'array', description: 'd',
  }) + '\\n');
  process.exit(0);
}
if (verb === 'set') {
  const value = JSON.parse(args[args.indexOf(key) + 1]);
  fs.writeFileSync(state, JSON.stringify(value));
  process.exit(0);
}
process.stderr.write('unexpected args ' + JSON.stringify(args) + '\\n');
process.exit(2);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
  withPath(t, dir);
  return dir;
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** A config dir holding a `work` profile, plus the fake omp env. */
function goalScratch(t) {
  const dir = tempDir('goal');
  fs.writeFileSync(
    path.join(dir, 'profiles.json'),
    JSON.stringify({ profiles: [{ id: 'work', name: 'Work' }] }),
  );
  const stateFile = path.join(dir, 'goal-config.json');
  const logFile = path.join(dir, 'omp-args.log');
  withEnv(
    t,
    { OMP_PORT_CONFIG_DIR: dir, FAKE_OMP_STATE: stateFile, FAKE_OMP_LOG: logFile },
    () => {},
  );
  fakeOmp(t);
  return { dir, stateFile, logFile };
}

test('stats: usage_stats_spawns_omp_and_passes_the_profile_flag', async (t) => {
  const { logFile } = goalScratch(t);
  const payload = path.join(tempDir('payload'), 'stats.txt');
  fs.writeFileSync(payload, `Synced 1 entry\n${JSON.stringify(dashboardPayload())}\n`);
  withEnv(t, { FAKE_OMP_STDOUT_FILE: payload }, () => {});

  const parsed = await usageStats('work');
  assert.equal(parsed.overall.totalRequests, 10);
  assert.deepEqual(parsed.byAgentType, [AGENT_TYPE]);
  assert.deepEqual(readLog(logFile), [['--profile=work', 'stats', '--json']]);
});

test('stats: non_zero_exit_reports_stderr_then_stdout_tail_then_status', async (t) => {
  const { logFile } = goalScratch(t);
  assert.ok(logFile);

  withEnv(t, { FAKE_OMP_EXIT: '1', FAKE_OMP_STDERR: '  boom  \n' }, () => {});
  await assert.rejects(usageStats(null), (err) => err.message === 'omp stats failed: boom');

  withEnv(t, { FAKE_OMP_EXIT: '2', FAKE_OMP_STDERR: undefined, FAKE_OMP_STDOUT: ' usage: omp \n' }, () => {});
  await assert.rejects(
    usageStats(null),
    (err) => err.message === 'omp stats failed (exit status: 2): usage: omp',
  );

  withEnv(t, { FAKE_OMP_EXIT: '129', FAKE_OMP_STDERR: undefined, FAKE_OMP_STDOUT: undefined }, () => {});
  await assert.rejects(
    usageStats(null),
    (err) => err.message === 'omp stats exited with exit status: 129 and produced no output',
  );
});

test('stats: stdout_fallback_keeps_the_tail_not_the_head', () => {
  const filler = 'x'.repeat(8192);
  const stdout = Buffer.from(`HEAD_MARKER${filler}TRAILING_MARKER`);
  const message = exitFailureMessage('omp stats', 'exit status: 2', Buffer.alloc(0), stdout);
  assert.ok(message.includes('TRAILING_MARKER'), message);
  assert.ok(!message.includes('HEAD_MARKER'), message);
  assert.equal(message.length, 'omp stats failed (exit status: 2): '.length + 4096);
});

// ── goal_config.rs ──────────────────────────────────────────────────────────

test('goal: get_args_put_profile_flag_before_subcommand', () => {
  assert.deepEqual(getArgs(null), ['config', 'get', 'goal.continuationModes', '--json']);
  assert.deepEqual(getArgs(''), ['config', 'get', 'goal.continuationModes', '--json']);
  assert.deepEqual(getArgs('work'), [
    '--profile=work',
    'config',
    'get',
    'goal.continuationModes',
    '--json',
  ]);
});

test('goal: set_args_pass_json_array_as_one_element', () => {
  assert.deepEqual(setArgs(null, ['interactive', 'rpc']), [
    'config',
    'set',
    'goal.continuationModes',
    '["interactive","rpc"]',
  ]);
  assert.deepEqual(setArgs('work', []), [
    '--profile=work',
    'config',
    'set',
    'goal.continuationModes',
    '[]',
  ]);
  const escaped = setArgs(null, ['a "b"']);
  assert.equal(escaped.length, 4);
  assert.equal(escaped[3], '["a \\"b\\""]');
});

test('goal: parse_modes_reads_value_array', () => {
  const out = Buffer.from(
    '{"key":"goal.continuationModes","value":["interactive","rpc"],"type":"array","description":"d"}',
  );
  assert.deepEqual(parseModes(out), ['interactive', 'rpc']);
  assert.deepEqual(parseModes(Buffer.from('  {"value":[]}\r\n')), []);
});

test('goal: parse_modes_rejects_unexpected_outputs', () => {
  for (const text of ['{"value":"rpc"}', '{"value":null}', '{"value":{"rpc":true}}', '{"key":"goal.continuationModes"}']) {
    assert.throws(() => parseModes(Buffer.from(text)), (err) => {
      assert.ok(err.message.startsWith('unexpected goal.continuationModes from omp: '), err.message);
      assert.ok(err.message.includes(text), err.message);
      return true;
    });
  }
  assert.throws(() => parseModes(Buffer.from('{"value":["interactive",3]}')), /^Error: unexpected goal\.continuationModes from omp: /);
  assert.throws(() => parseModes(Buffer.from('not json')), /unexpected goal\.continuationModes from omp: not json$/);
  // The snippet is bounded, and the ellipsis marks the cut.
  const long = `{"value":${'x'.repeat(500)}}`;
  assert.throws(() => parseModes(Buffer.from(long)), (err) => {
    const snippet = err.message.slice('unexpected goal.continuationModes from omp: '.length);
    assert.equal(Array.from(snippet).length, 121); // 120 chars + "…"
    assert.ok(snippet.endsWith('…'));
    return true;
  });
});

test('goal: next_modes_keeps_other_entries_and_their_order', () => {
  assert.equal(nextModes(['interactive', 'rpc'], true), null, 'already enabled');
  assert.equal(nextModes(['interactive'], false), null, 'already disabled');
  assert.deepEqual(nextModes(['rpc'], false), []);
  assert.deepEqual(nextModes(['interactive'], true), ['interactive', 'rpc']);
  assert.deepEqual(nextModes(['interactive', 'custom'], true), ['interactive', 'custom', 'rpc']);
  assert.deepEqual(nextModes(['rpc', 'interactive', 'rpc'], false), ['interactive']);
  assert.equal(nextModes(['rpc', 'interactive'], true), null, 'has "rpc" already');
});

test('goal: round_trip_through_fake_omp_under_a_temp_config_dir', async (t) => {
  const { stateFile, logFile } = goalScratch(t);

  assert.equal(await goalContinuationGet(null), false, 'default is ["interactive"]');
  assert.deepEqual(readLog(logFile), [
    ['config', 'get', 'goal.continuationModes', '--json'],
  ]);

  assert.equal(await goalContinuationGet('work'), false);
  assert.deepEqual(readLog(logFile)[1], [
    '--profile=work',
    'config',
    'get',
    'goal.continuationModes',
    '--json',
  ]);

  assert.equal(await goalContinuationSet(null, true), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), ['interactive', 'rpc']);

  // Already enabled: nothing is written.
  const writesBefore = readLog(logFile).filter((args) => args.includes('set')).length;
  assert.equal(await goalContinuationSet(null, true), true);
  const writesAfter = readLog(logFile).filter((args) => args.includes('set')).length;
  assert.equal(writesAfter, writesBefore, 'a no-op must not spawn `config set`');

  assert.equal(await goalContinuationSet(null, false), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), ['interactive']);

  // Removal drops every "rpc"; addition appends one.
  fs.writeFileSync(stateFile, JSON.stringify(['rpc', 'interactive', 'rpc', 'custom']));
  assert.equal(await goalContinuationSet('work', false), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), ['interactive', 'custom']);
  assert.equal(await goalContinuationSet('work', true), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    ['interactive', 'custom', 'rpc'],
  );

  const setCall = readLog(logFile).find((args) => args.includes('set') && args[0] === '--profile=work');
  assert.deepEqual(setCall, [
    '--profile=work',
    'config',
    'set',
    'goal.continuationModes',
    '["interactive","custom"]',
  ]);
});

test('goal: non_boolean_enabled_is_refused', async (t) => {
  goalScratch(t);
  await assert.rejects(
    goalContinuationSet(null, 'yes'),
    /invalid type: string "yes", expected a boolean/,
  );
});

test('goal: unreadable_omp_response_surfaces_the_unexpected_error', async (t) => {
  goalScratch(t);
  const bin = tempDir('bin-bad');
  const file = path.join(bin, 'omp');
  fs.writeFileSync(file, '#!/bin/sh\necho not-a-config-payload\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  // Prepend AFTER goalScratch's fake, so this one wins the lookup.
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => {
    process.env.PATH = saved;
  });
  await assert.rejects(
    goalContinuationGet(null),
    /^Error: unexpected goal\.continuationModes from omp: not-a-config-payload$/,
  );
});

// ── prompt_history.rs ───────────────────────────────────────────────────────

function promptScratch(t) {
  const dir = tempDir('prompts');
  withEnv(t, { OMP_PORT_CONFIG_DIR: dir }, () => {});
  return { dir, file: path.join(dir, 'prompt-history.json') };
}

test('prompt_history: record_dedupes_and_orders_newest_first', (t) => {
  const { file } = promptScratch(t);
  assert.deepEqual(promptHistoryRecord('first'), ['first']);
  assert.deepEqual(promptHistoryRecord('second'), ['second', 'first']);
  assert.deepEqual(promptHistoryRecord('first'), ['first', 'second']);
  assert.deepEqual(promptHistoryList(), ['first', 'second']);
  assert.equal(promptHistoryPath(), file);
});

test('prompt_history: record_ignores_blank_and_caps_the_list', (t) => {
  const { file } = promptScratch(t);
  assert.deepEqual(promptHistoryRecord('   '), []);
  assert.equal(fs.existsSync(file), false, 'a blank prompt writes nothing');
  for (let i = 0; i < MAX_PROMPTS + 20; i += 1) promptHistoryRecord(`prompt ${i}`);
  const list = promptHistoryList();
  assert.equal(list.length, MAX_PROMPTS);
  assert.equal(list[0], `prompt ${MAX_PROMPTS + 19}`);
  assert.equal(list[MAX_PROMPTS - 1], 'prompt 20');
});

test('prompt_history: record_caps_a_huge_prompt_on_a_char_boundary', (t) => {
  promptScratch(t);
  const huge = '€'.repeat(3000); // 9000 bytes, 3 per char
  const [stored] = promptHistoryRecord(huge);
  assert.ok(Buffer.byteLength(stored, 'utf8') <= MAX_PROMPT_BYTES);
  assert.equal(Buffer.byteLength(stored, 'utf8'), MAX_PROMPT_BYTES - 2);
  assert.ok(Array.from(stored).every((ch) => ch === '€'));
  assert.ok(!stored.includes('\uFFFD'));
});

test('prompt_history: file_shape_is_pretty_prompts_object', (t) => {
  const { file } = promptScratch(t);
  promptHistoryRecord('first');
  promptHistoryRecord('second');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw, JSON.stringify({ prompts: ['second', 'first'] }, null, 2));
  assert.ok(!raw.endsWith('\n'), 'serde-only files carry no trailing newline');
  assert.deepEqual(JSON.parse(raw), { prompts: ['second', 'first'] });
});

test('prompt_history: malformed_files_read_empty_and_are_replaced', (t) => {
  const { file } = promptScratch(t);
  for (const bad of ['not json', '[]', '{}', '{"prompts":["ok",1]}']) {
    fs.writeFileSync(file, bad);
    assert.deepEqual(promptHistoryList(), [], bad);
  }
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(promptHistoryRecord('recovered'), ['recovered']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { prompts: ['recovered'] });
});

test('prompt_history: a_file_backed_store_survives_a_reopen', (t) => {
  const { file } = promptScratch(t);
  promptHistoryRecord('persisted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { prompts: ['persisted'] });
  // No process cache: every call re-reads the file.
  assert.deepEqual(promptHistoryList(), ['persisted']);
  fs.writeFileSync(file, JSON.stringify({ prompts: ['external'] }));
  assert.deepEqual(promptHistoryList(), ['external']);
});

test('prompt_history: non_string_text_is_refused', (t) => {
  promptScratch(t);
  assert.throws(() => promptHistoryRecord(undefined), /invalid type: undefined, expected a string/);
});

