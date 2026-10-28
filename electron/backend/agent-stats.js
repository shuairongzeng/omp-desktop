/* electron/backend/agent-stats.js — usage/model statistics, goal-mode config
   and the cross-session prompt history.

   Ports, with the same command names as Tauri:

     model_usage_list        model_usage.rs    (omp's own agent.db)
     usage_stats             stats.rs          (`omp stats --json`)
     goal_continuation_get   goal_config.rs    (`omp config get`)
     goal_continuation_set   goal_config.rs    (`omp config set`)
     prompt_history_list     prompt_history.rs (`<app config>/prompt-history.json`)
     prompt_history_record   prompt_history.rs

   `model_usage_list` reads omp's private `model_usage` table READ-ONLY
   (never `immutable`, which would skip the WAL and read stale pages) with a
   short busy timeout and one connection per query: a long-lived read
   transaction would pin the WAL and stall omp's checkpoints. Every failure —
   no database yet, schema drift, a locked or corrupt file — reads as an empty
   list, exactly like the Rust module.

   `usage_stats` and both goal commands shell out to omp through the trusted
   absolute PATH (`agent.js`'s `childPathDirs`/`locateProgram`, the port of
   `child_path`/`spawn::Omp`), because omp owns where its config lives, its
   format and its layering, and a running `omp --mode rpc-ui` tab of that
   profile picks a `config set` up live (its settings watcher). The profile
   flag precedes the subcommand — `omp stats --json --profile=<id>` is
   rejected by omp's own parser — and `OMP_PROFILE`/`PI_PROFILE` are stripped
   from the child env so an inherited alias cannot redirect the run.

   `prompt_history` follows `ConfigFile::update` (the lenient variant): an
   unreadable or malformed file reads as the default empty list and the next
   record replaces it, unlike the strict stores. Writes are atomic (temp file
   + rename).

   Deliberate deviations vs. Rust:
   - The Rust `ConfigFile::Memory` fallback (no app config folder) is not
     reproduced: `stores.configHome()` always resolves a folder and
     `writeAtomic` creates it, matching every other ported store.
   - `usage_stats`/goal commands are async (they await the child) instead of
     running on a blocking pool; callers may await the returned promise.
*/

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const stores = require('./stores');
const { childPathDirs, locateProgram, profileFlag, prefixWithin } = require('./agent');

// ── model_usage.rs ──────────────────────────────────────────────────────────

/** Keys returned per call (`MAX_KEYS`); more than the picker shows. */
const MAX_KEYS = 20;

/** How long a read waits out a write lock before giving up (`BUSY_TIMEOUT`). */
const BUSY_TIMEOUT_MS = 250;

/** `db_path`: `agent_dir_for(profile).join("agent.db")`. */
function usageDbPath(resolvedProfile) {
  return path.join(stores.agentDirFor(resolvedProfile), 'agent.db');
}

/** `Path::is_file`, false for any stat failure. */
function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * `query`: one read-only connection, a short busy timeout, one statement.
 * `NO_MUTEX` has no Node equivalent (each `DatabaseSync` is private to its
 * caller).
 */
function queryRecent(db, limit) {
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // `model_key` breaks ties: `last_used_at` has one-second resolution.
    const rows = conn
      .prepare('SELECT model_key FROM model_usage ORDER BY last_used_at DESC, model_key LIMIT ?')
      .all(limit);
    return rows.map((row) => {
      if (typeof row.model_key !== 'string') {
        // rusqlite's `row.get::<String>` would reject a non-TEXT column.
        throw new Error('model_key is not TEXT');
      }
      return row.model_key;
    });
  } finally {
    conn.close();
  }
}

/**
 * `model_usage_list` — `profile`'s most recently used model keys
 * (`provider/modelId`), newest first. A missing database is a fresh profile
 * (silently empty, and never created); any other failure is logged and reads
 * as empty too. Throws only on an unknown profile, like `resolve_owned`.
 */
function modelUsageList(profile) {
  const resolved = stores.resolveProfile(profile ?? null);
  const db = usageDbPath(resolved);
  // Checked up front only to keep a fresh profile out of the log: the
  // read-only open below never creates the file either.
  if (!isFile(db)) return [];
  try {
    return queryRecent(db, MAX_KEYS);
  } catch (err) {
    process.stderr.write(`[omp-desktop] model usage unreadable in ${db}: ${err.message}\n`);
    return [];
  }
}

// ── omp_cli.rs ──────────────────────────────────────────────────────────────

/** Port of `omp_cli::STDOUT_TAIL_MAX_BYTES`. */
const STDOUT_TAIL_MAX_BYTES = 4 * 1024;

/** `ExitStatus`'s `Display`: `exit status: N` or `signal: N (SIGKILL)`. */
function statusDisplay(code, signal) {
  if (code !== null && code !== undefined) return `exit status: ${code}`;
  const number = signal === null ? null : os.constants.signals[signal];
  if (number === undefined || number === null) return `signal: ${signal}`;
  return `signal: ${number} (${signal})`;
}

/**
 * `omp_cli::exit_failure_message`: stderr when it has anything, else the
 * stdout TAIL (most likely to hold a final error line), else the bare status.
 */
function exitFailureMessage(label, status, stderr, stdout) {
  const errText = stderr.toString('utf8').trim();
  if (errText !== '') return `${label} failed: ${errText}`;
  const tail = stdout.subarray(Math.max(0, stdout.length - STDOUT_TAIL_MAX_BYTES));
  const outText = tail.toString('utf8').trim();
  if (outText !== '') return `${label} failed (${status}): ${outText}`;
  return `${label} exited with ${status} and produced no output`;
}

/**
 * `omp_cli::run`: `omp <args>` with the trusted PATH and profile env aliases
 * stripped, resolving with stdout on exit 0 and rejecting with the Rust
 * failure message otherwise.
 */
function runOmp(args, label) {
  return new Promise((resolve, reject) => {
    let located;
    try {
      located = locateProgram(childPathDirs(), 'omp');
    } catch (err) {
      reject(err);
      return;
    }
    const env = { ...process.env, PATH: located.path };
    // `sanitize_child_env`: either alias would override the per-call profile.
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    const child = spawn(located.binary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const errOut = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => errOut.push(chunk));
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`failed to run ${located.binary}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(errOut);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(exitFailureMessage(label, statusDisplay(code, signal), stderr, stdout)));
    });
  });
}

// ── stats.rs ────────────────────────────────────────────────────────────────

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** serde's type description in an `invalid type: …` message. */
function serdeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  switch (typeof value) {
    case 'string':
      return `string ${JSON.stringify(value)}`;
    case 'boolean':
      return `boolean \`${value}\``;
    case 'number':
      return Number.isInteger(value)
        ? `integer \`${value}\``
        : `floating point \`${value}\``;
    case 'object':
      return 'map';
    default:
      return typeof value;
  }
}

function invalidType(value, expected) {
  return new Error(`invalid type: ${serdeType(value)}, expected ${expected}`);
}

/** serde's missing-field error (no `#[serde(default)]` on the field). */
function requireField(object, key) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    throw new Error(`missing field \`${key}\``);
  }
  return object[key];
}

function requireU64(object, key) {
  const value = requireField(object, key);
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 0) throw new Error(`invalid value: integer \`${value}\`, expected u64`);
    return value;
  }
  throw invalidType(value, 'u64');
}

function requireI64(object, key) {
  const value = requireField(object, key);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw invalidType(value, 'i64');
}

function requireF64(object, key) {
  const value = requireField(object, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw invalidType(value, 'f64');
}

/** A serde `Option<f64>`: `null` stays `null`, a number is the value. */
function requireOptionalF64(object, key) {
  const value = requireField(object, key);
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw invalidType(value, 'f64');
}

function requireString(object, key) {
  const value = requireField(object, key);
  if (typeof value === 'string') return value;
  throw invalidType(value, 'a string');
}

/** `#[serde(default)] Vec<T>`: absent ⇒ empty; anything else a sequence. */
function optionalSequence(object, key) {
  const value = object[key];
  // `default` fills a *missing* field only: an explicit null is a type error.
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidType(value, 'a sequence');
  return value;
}

function requireObject(value, expected) {
  if (!isPlainObject(value)) throw invalidType(value, expected);
  return value;
}

/** `AggregatedStats` in its declared field order (camelCase on the wire). */
function aggregatedFrom(value) {
  const stats = requireObject(value, 'struct AggregatedStats');
  return {
    totalRequests: requireU64(stats, 'totalRequests'),
    successfulRequests: requireU64(stats, 'successfulRequests'),
    failedRequests: requireU64(stats, 'failedRequests'),
    errorRate: requireF64(stats, 'errorRate'),
    totalInputTokens: requireU64(stats, 'totalInputTokens'),
    totalOutputTokens: requireU64(stats, 'totalOutputTokens'),
    totalCacheReadTokens: requireU64(stats, 'totalCacheReadTokens'),
    totalCacheWriteTokens: requireU64(stats, 'totalCacheWriteTokens'),
    cacheRate: requireF64(stats, 'cacheRate'),
    cacheSavings: requireF64(stats, 'cacheSavings'),
    totalCost: requireF64(stats, 'totalCost'),
    unpricedRequests: requireU64(stats, 'unpricedRequests'),
    // `SUM(premium_requests)` over a REAL column: fractional by design.
    totalPremiumRequests: requireF64(stats, 'totalPremiumRequests'),
    avgDuration: requireOptionalF64(stats, 'avgDuration'),
    avgTtft: requireOptionalF64(stats, 'avgTtft'),
    avgTokensPerSecond: requireOptionalF64(stats, 'avgTokensPerSecond'),
    firstTimestamp: requireI64(stats, 'firstTimestamp'),
    lastTimestamp: requireI64(stats, 'lastTimestamp'),
  };
}

/** `ModelStats`: `{model, provider}` plus the flattened aggregate fields. */
function modelStatsFrom(value) {
  const row = requireObject(value, 'struct ModelStats');
  return {
    model: requireString(row, 'model'),
    provider: requireString(row, 'provider'),
    ...aggregatedFrom(row),
  };
}

/** `FolderStats`: `{folder}` plus the flattened aggregate fields. */
function folderStatsFrom(value) {
  const row = requireObject(value, 'struct FolderStats');
  return {
    folder: requireString(row, 'folder'),
    ...aggregatedFrom(row),
  };
}

/** `AgentTypeStats` — deliberately not an `AggregatedStats`. */
function agentTypeStatsFrom(value) {
  const row = requireObject(value, 'struct AgentTypeStats');
  return {
    agentType: requireString(row, 'agentType'),
    totalRequests: requireU64(row, 'totalRequests'),
    totalInputTokens: requireU64(row, 'totalInputTokens'),
    totalOutputTokens: requireU64(row, 'totalOutputTokens'),
    totalCacheReadTokens: requireU64(row, 'totalCacheReadTokens'),
    totalCacheWriteTokens: requireU64(row, 'totalCacheWriteTokens'),
    totalCost: requireF64(row, 'totalCost'),
  };
}

/**
 * `DashboardStats`, keeping only the breakdowns the panel renders — serde
 * drops the upstream time-series arrays, so they are ignored here too.
 */
function dashboardFrom(value) {
  const dashboard = requireObject(value, 'struct DashboardStats');
  return {
    overall: aggregatedFrom(requireField(dashboard, 'overall')),
    byModel: optionalSequence(dashboard, 'byModel').map(modelStatsFrom),
    byFolder: optionalSequence(dashboard, 'byFolder').map(folderStatsFrom),
    byAgentType: optionalSequence(dashboard, 'byAgentType').map(agentTypeStatsFrom),
  };
}

/** `stats_args`: the global profile flag BEFORE the subcommand. */
function statsArgs(profile) {
  const args = [];
  const flag = profileFlag(profile);
  if (flag !== null) args.push(flag);
  args.push('stats', '--json');
  return args;
}

/**
 * `parse_stats_json`: `omp stats` prints a `Synced N …` progress line to
 * stdout before the JSON object, so skip to the first `{`. A payload with no
 * `{` at all is malformed rather than an empty dashboard.
 */
function parseStatsJson(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const start = buffer.indexOf(0x7b);
  if (start === -1) throw new Error('omp stats output contained no JSON object');
  try {
    const text = UTF8.decode(buffer.subarray(start));
    return dashboardFrom(JSON.parse(text));
  } catch (err) {
    throw new Error(`failed to parse omp stats output: ${err.message}`);
  }
}

/**
 * `usage_stats` — rolling last-24-hours statistics for `profile` (the
 * installed CLI's `--json` path has no way to ask for more), from
 * `omp stats --json`. Rejects with the CLI's failure message.
 */
async function usageStats(profile) {
  const resolved = stores.resolveProfile(profile ?? null);
  return parseStatsJson(await runOmp(statsArgs(resolved), 'omp stats'));
}

// ── goal_config.rs ──────────────────────────────────────────────────────────

/** The omp setting this module toggles. */
const SETTING_KEY = 'goal.continuationModes';

/** The entry of `SETTING_KEY` that enables continuation over RPC. */
const RPC_MODE = 'rpc';

/** Names the subcommand in `runOmp`'s failure messages. */
const OMP_CONFIG = 'omp config';

/** How much of an unexpected `config get` output is quoted in an error. */
const OUTPUT_SNIPPET_MAX_CHARS = 120;

/**
 * Serialises every read and write of the setting (`CONFIG_LOCK`): `set`'s
 * read-modify-write, so two concurrent toggles cannot interleave and drop
 * each other's change, and `get`, so a read issued while a toggle is still
 * writing waits for it instead of returning the value it replaces.
 */
let configQueue = Promise.resolve();

function withConfigLock(fn) {
  const run = configQueue.then(fn, fn);
  // The queue itself must keep going after a failed call.
  configQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** `get_args`: `omp [--profile=<id>] config get <key> --json`. */
function getArgs(profile) {
  const args = [];
  const flag = profileFlag(profile);
  if (flag !== null) args.push(flag);
  args.push('config', 'get', SETTING_KEY, '--json');
  return args;
}

/**
 * `set_args`: the JSON array is ONE argv element, so no shell or quoting
 * layer is involved.
 */
function setArgs(profile, modes) {
  const args = [];
  const flag = profileFlag(profile);
  if (flag !== null) args.push(flag);
  args.push('config', 'set', SETTING_KEY, JSON.stringify(modes));
  return args;
}

/**
 * `parse_modes`: `{"key":…,"value":[…],"type":"array",…}` → the entries.
 * `value` must be an array of strings; anything else is an error quoting a
 * bounded prefix of what omp printed.
 */
function parseModes(stdout) {
  const text = (Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)).trim();
  const unexpected = () => {
    const chars = Array.from(text);
    const snippet = chars.slice(0, OUTPUT_SNIPPET_MAX_CHARS).join('');
    const ellipsis = snippet.length < text.length ? '…' : '';
    return new Error(`unexpected ${SETTING_KEY} from omp: ${snippet}${ellipsis}`);
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unexpected();
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.value)) throw unexpected();
  for (const item of parsed.value) {
    if (typeof item !== 'string') throw unexpected();
  }
  return parsed.value.slice();
}

/** `has_rpc`. */
function hasRpc(modes) {
  return modes.includes(RPC_MODE);
}

/**
 * `next_modes`: the list to write so `"rpc"` is present (`enabled`) or absent
 * (`!enabled`), or `null` when `current` already satisfies that. Removal
 * drops every `"rpc"`; addition appends one; other entries keep their order.
 */
function nextModes(current, enabled) {
  if (hasRpc(current) === enabled) return null;
  const next = current.filter((mode) => mode !== RPC_MODE);
  if (enabled) next.push(RPC_MODE);
  return next;
}

async function readModes(profile) {
  return parseModes(await runOmp(getArgs(profile), OMP_CONFIG));
}

/**
 * `goal_continuation_get` — whether the effective `goal.continuationModes` of
 * `profile` contains `"rpc"`. Spawns omp; the caller may await it.
 */
async function goalContinuationGet(profile) {
  const resolved = stores.resolveProfile(profile ?? null);
  return withConfigLock(async () => hasRpc(await readModes(resolved)));
}

/**
 * `goal_continuation_set` — add (`enabled`) or remove `"rpc"` in the
 * profile's `goal.continuationModes`, keeping every other entry and its
 * order, and return the effective value re-read after the write. Nothing is
 * written when the list would not change.
 */
async function goalContinuationSet(profile, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error(`invalid type: ${serdeType(enabled)}, expected a boolean`);
  }
  const resolved = stores.resolveProfile(profile ?? null);
  return withConfigLock(async () => {
    const current = await readModes(resolved);
    const next = nextModes(current, enabled);
    // `next_modes` returns null only when the list already says `enabled`.
    if (next === null) return enabled;
    await runOmp(setArgs(resolved, next), OMP_CONFIG);
    // Not `goalContinuationGet`: the lock is held and is not reentrant.
    return hasRpc(await readModes(resolved));
  });
}

// ── prompt_history.rs ───────────────────────────────────────────────────────

/** Longest kept list (`MAX_PROMPTS`). */
const MAX_PROMPTS = 200;

/** A single stored prompt is capped (`MAX_PROMPT_BYTES`). */
const MAX_PROMPT_BYTES = 8 * 1024;

const PROMPT_HISTORY_FILE = 'prompt-history.json';

/** Monotonic suffix so two writes in one millisecond land on different temps. */
let tempCounter = 0;

/**
 * `json_store::write_atomic`: unique temp file in the same directory, fsync,
 * rename over the target. Creates the parent (the Rust lock used to).
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `${path.basename(file)}.${process.pid}-${tempCounter++}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // ignore: the original error is what the caller needs
    }
    throw err;
  }
}

function promptHistoryPath() {
  return path.join(stores.configHome(), PROMPT_HISTORY_FILE);
}

/**
 * `read_or_default::<PromptHistoryFile>`: missing, unreadable or malformed
 * (including a non-string entry) ⇒ empty. The next record replaces it.
 */
function readPrompts() {
  let bytes;
  try {
    bytes = fs.readFileSync(promptHistoryPath());
  } catch {
    return [];
  }
  try {
    const value = JSON.parse(UTF8.decode(bytes));
    if (!isPlainObject(value) || !Array.isArray(value.prompts)) return [];
    if (!value.prompts.every((prompt) => typeof prompt === 'string')) return [];
    return value.prompts;
  } catch {
    return [];
  }
}

/** `prompt_history_list` — the cross-session prompt history, newest first. */
function promptHistoryList() {
  return readPrompts();
}

/**
 * `prompt_history_record` — record `text` (trimmed, byte-capped) as the most
 * recent prompt and return the updated list. Empty prompts are a no-op.
 */
function promptHistoryRecord(text) {
  if (typeof text !== 'string') {
    throw new Error(`invalid type: ${serdeType(text)}, expected a string`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return readPrompts();
  const capped = prefixWithin(trimmed, MAX_PROMPT_BYTES);
  const prompts = readPrompts().filter((prompt) => prompt !== capped);
  prompts.unshift(capped);
  if (prompts.length > MAX_PROMPTS) prompts.length = MAX_PROMPTS;
  // serde_json's `to_vec_pretty`: two-space indent, no trailing newline.
  writeAtomic(promptHistoryPath(), JSON.stringify({ prompts }, null, 2));
  // The Rust command projects a fresh read after the write.
  return readPrompts();
}

module.exports = {
  // The IPC surface, one function per Rust command.
  modelUsageList,
  usageStats,
  goalContinuationGet,
  goalContinuationSet,
  promptHistoryList,
  promptHistoryRecord,
  // Shared plumbing and pure helpers.
  MAX_KEYS,
  BUSY_TIMEOUT_MS,
  MAX_PROMPTS,
  MAX_PROMPT_BYTES,
  SETTING_KEY,
  RPC_MODE,
  usageDbPath,
  queryRecent,
  runOmp,
  exitFailureMessage,
  statsArgs,
  parseStatsJson,
  dashboardFrom,
  getArgs,
  setArgs,
  parseModes,
  nextModes,
  hasRpc,
  promptHistoryPath,
  readPrompts,
};