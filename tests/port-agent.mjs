/* Port parity tests for electron/backend/agent.js.

   Mirrors the Rust cases in src-tauri/src/agent/{mod,reader,journal,approvals}.rs
   and src-tauri/src/approval.rs, plus a fake-omp line-protocol fixture and a
   real-omp smoke (skipped when omp is not installed). Run:

     node tests/port-agent.mjs

   Every check prints `ok`/`not ok`; the final line is the check count and the
   process exits 0 only when nothing failed. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import backend from '../electron/backend/agent.js';

const {
  AgentBridge,
  ApprovalRuleBook,
  EventJournal,
  LineFramer,
  PendingApprovals,
  StderrTail,
  ALLOWED_COMMAND_TYPES,
  EVENT_JOURNAL_CAPACITY,
  EVENT_JOURNAL_MAX_BYTES,
  MAX_ID_BYTES,
  MAX_LINE_BYTES,
  MAX_PENDING,
  MIN_OMP_VERSION,
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
  STDERR_TAIL_BYTES,
  STDERR_TAIL_LINES,
  approvalDetails,
  approvalRequestId,
  approvalToolName,
  answeredId,
  childExitReason,
  childPathDirs,
  isCredentialKey,
  joinNonblank,
  locateProgram,
  ompArgs,
  overlayContent,
  parseApprovalMode,
  parseRuleScope,
  parseVersionLine,
  prefixWithin,
  profileFlag,
  projectKey,
  resolveCwd,
  sanitizeFrame,
  sanitizeLine,
  stripTrailingCRLF,
  validateCommandType,
  versionRefusal,
} = backend;

// ── harness ────────────────────────────────────────────────────────────────

let checks = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
    passed += 1;
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`not ok ${checks} - ${name}`);
    const text = String(error && error.stack ? error.stack : error);
    console.log(
      text
        .split('\n')
        .slice(0, 4)
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`skip - ${name} # ${reason}`);
}

const scratchDirs = [];
function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp_agent_${name}_`));
  scratchDirs.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn, label, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(15);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, label) {
  await waitUntil(() => !pidAlive(pid), `${label} (pid ${pid}) to die`, 5000);
}

async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

// ── fake omp ───────────────────────────────────────────────────────────────

const FAKE_OMP_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ -n "$FAKE_OMP_VERSION" ]; then printf '%s\\n' "$FAKE_OMP_VERSION"; else printf 'omp/18.12.6\\n'; fi
  exit 0
fi
# The bridge deliberately spawns with only the trusted PATH (the fake bin
# dir); the fixture needs sleep/head/tr, so it restores the system dirs.
PATH="/usr/bin:/bin:/usr/sbin:/sbin"; export PATH
if [ -n "$FAKE_OMP_ARGV_FILE" ]; then
  : > "$FAKE_OMP_ARGV_FILE"
  for arg in "$@"; do printf '%s\\n' "$arg" >> "$FAKE_OMP_ARGV_FILE"; done
fi
if [ -n "$FAKE_OMP_PID_FILE" ]; then printf '%s\\n' "$$" > "$FAKE_OMP_PID_FILE"; fi
mode="\${FAKE_OMP_MODE:-clean}"
case "$mode" in
  frames)
    printf '{"type":"ready"}\\n'
    printf '{"type":"response","id":"d1","command":"negotiate_protocol","success":true}\\n'
    ;;
  frames5)
    printf '{"type":"frame","n":1}\\n'
    printf '{"type":"frame","n":2}\\n'
    printf '{"type":"frame","n":3}\\n'
    printf '{"type":"frame","n":4}\\n'
    printf '{"type":"frame","n":5}\\n'
    sleep 30
    ;;
  blank)
    printf '\\n'
    printf '{"type":"ready"}\\n'
    printf '\\r\\n'
    printf '{"type":"agent_end"}\\r\\n'
    printf '\\n\\n'
    ;;
  startup-death)
    printf 'No models available.\\n' >&2
    printf '\\n' >&2
    printf 'Set an API key.\\n' >&2
    exit 2
    ;;
  silent-death)
    exit 2
    ;;
  mid-death)
    printf '{"type":"ready"}\\n'
    printf 'Error: boom\\n' >&2
    exit 3
    ;;
  huge)
    head -c 17000000 /dev/zero | tr '\\0' 'x'
    printf '\\n'
    printf '{"type":"ready"}\\n'
    ;;
  clean)
    exit 0
    ;;
  stdin-capture)
    while IFS= read -r line; do
      printf '%s\\n' "$line" >> "\${FAKE_OMP_STDIN_FILE:-/dev/null}"
    done
    ;;
  prompt-answer)
    printf '{"type":"extension_ui_request","id":"req-9","method":"select","title":"Allow tool: bash\\\\nCommand: ls","options":["Approve","Deny"]}\\n'
    IFS= read -r line
    printf '%s\\n' "$line" > "\${FAKE_OMP_STDIN_FILE:-/dev/null}"
    ;;
  prompt-sleep)
    printf '{"type":"extension_ui_request","id":"req-9","method":"select","title":"Allow tool: bash\\\\nCommand: ls","options":["Approve","Deny"]}\\n'
    sleep 30
    ;;
  prompt-cancel-sleep)
    printf '{"type":"extension_ui_request","id":"req-9","method":"select","title":"Allow tool: bash\\\\nCommand: ls","options":["Approve","Deny"]}\\n'
    sleep 0.5
    printf '{"type":"extension_ui_request","id":"c1","method":"cancel","targetId":"req-9"}\\n'
    sleep 30
    ;;
  sleep)
    printf '{"type":"ready"}\\n'
    sleep 30 &
    printf '%s\\n' "$!" > "\${FAKE_OMP_CHILD_PID_FILE:-/dev/null}"
    wait
    ;;
esac
`;

const fakeBins = [];
function makeFakeBin() {
  const dir = makeTempDir('bin');
  const file = path.join(dir, 'omp');
  fs.writeFileSync(file, FAKE_OMP_SCRIPT);
  fs.chmodSync(file, 0o755);
  fakeBins.push(dir);
  return dir;
}

const sharedFakeBin = makeFakeBin();

const bridges = [];
function makeBridge(opts = {}) {
  const bridge = new AgentBridge({ pathDirs: [sharedFakeBin], ...opts });
  bridges.push(bridge);
  return bridge;
}

/** Attach `line`/`exit` collectors for one session BEFORE starting it. */
function watch(bridge, sessionId) {
  const lines = [];
  let exitCount = 0;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  bridge.on('line', (sid, event) => {
    if (sid === sessionId) lines.push(event);
  });
  bridge.on('exit', (sid, reason) => {
    if (sid !== sessionId) return;
    exitCount += 1;
    resolveExit(reason);
  });
  return {
    lines,
    exited,
    get exitCount() {
      return exitCount;
    },
    texts() {
      return lines.map((line) => line.text);
    },
    parsed() {
      return lines.map((line) => JSON.parse(line.text));
    },
  };
}

// ── line framing fixture (tests/fixtures/line-framing-cases.json) ──────────

const LINE_FRAMING_CASES = [
  {
    name: 'plain_lf_line',
    raw: '{"type":"ready"}\n',
    expect_text: '{"type":"ready"}',
    expect_json: true,
  },
  { name: 'crlf_line', raw: '{"type":"ready"}\r\n', expect_text: '{"type":"ready"}', expect_json: true },
  {
    name: 'trailing_cr_only_no_lf',
    raw: '{"type":"ready"}\r',
    expect_text: '{"type":"ready"}',
    expect_json: true,
  },
  {
    name: 'multiple_trailing_newlines',
    raw: '{"type":"ready"}\n\n',
    expect_text: '{"type":"ready"}',
    expect_json: true,
  },
  { name: 'non_json_line', raw: 'not json at all\n', expect_text: 'not json at all', expect_json: false },
  { name: 'empty_object', raw: '{}\n', expect_text: '{}', expect_json: true },
  {
    name: 'nested_credential_redacted',
    raw: '{"type":"response","data":{"headers":{"Authorization":"Bearer sk-secret"}}}\n',
    expect_contains: '[REDACTED]',
    expect_not_contains: 'sk-secret',
    expect_json: true,
  },
  { name: 'truncated_json_header', raw: '{"type":"rea\n', expect_text: '{"type":"rea', expect_json: false },
  { name: 'single_lf_only', raw: '\n', expect_empty_after_strip: true },
];

for (const testCase of LINE_FRAMING_CASES) {
  await check(`line_framing_fixture:${testCase.name}`, () => {
    const stripped = stripTrailingCRLF(Buffer.from(testCase.raw, 'utf8'));
    if (testCase.expect_empty_after_strip) {
      assert.equal(stripped.length, 0, 'expected empty after CR/LF strip');
      return;
    }
    const { text, parsed } = sanitizeLine(stripped);
    if (testCase.expect_text !== undefined) assert.equal(text, testCase.expect_text);
    if (testCase.expect_json !== undefined) assert.equal(parsed !== null, testCase.expect_json);
    if (testCase.expect_contains !== undefined) assert.ok(text.includes(testCase.expect_contains));
    if (testCase.expect_not_contains !== undefined) {
      assert.ok(!text.includes(testCase.expect_not_contains));
    }
  });
}

// ── validate_command_type (agent::mod tests) ───────────────────────────────

await check('validate_command_type_accepts_every_allowed_type', () => {
  for (const type of ALLOWED_COMMAND_TYPES) {
    assert.doesNotThrow(() => validateCommandType(JSON.stringify({ type })), `${type} should be allowed`);
  }
});

await check('validate_command_type_rejects_unknown_type', () => {
  assert.throws(
    () => validateCommandType('{"type":"switch_session","path":"/etc/passwd"}'),
    /not allowed/,
  );
});

await check('validate_command_type_rejects_malformed_json', () => {
  assert.throws(() => validateCommandType('not json'), /not valid JSON/);
});

await check('validate_command_type_rejects_missing_type_field', () => {
  assert.throws(() => validateCommandType('{"message":"hi"}'), /missing string 'type'/);
});

await check('validate_command_type_rejects_non_string_type', () => {
  assert.throws(() => validateCommandType('{"type":42}'), /missing string 'type'/);
});

// ── redaction (reader.rs tests) ────────────────────────────────────────────

await check('sanitize_redacts_nested_credential_keys', () => {
  const raw = JSON.stringify({
    type: 'response',
    data: {
      model: {
        name: 'gpt-5',
        headers: { Authorization: 'Bearer sk-secret', 'Content-Type': 'application/json' },
      },
    },
  });
  const { text, parsed } = sanitizeLine(raw);
  assert.ok(!text.includes('sk-secret'));
  assert.ok(text.includes(REDACTED_PLACEHOLDER));
  assert.notEqual(parsed, null);
  assert.equal(parsed.data.model.headers, REDACTED_PLACEHOLDER);
  assert.equal(parsed.data.model.name, 'gpt-5');
});

await check('sanitize_matches_key_regardless_of_separator_style', () => {
  for (const key of ['api_key', 'api-key', 'apiKey', 'API_KEY']) {
    const raw = JSON.stringify({ [key]: 'should-not-survive' });
    const { text } = sanitizeLine(raw);
    assert.ok(!text.includes('should-not-survive'), `key ${key} leaked a secret`);
  }
});

await check('sanitize_redacts_compound_provider_credential_key_names', () => {
  for (const key of ['x-api-key', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'client_secret']) {
    const raw = JSON.stringify({ [key]: 'should-not-survive' });
    const { text } = sanitizeLine(raw);
    assert.ok(!text.includes('should-not-survive'), `key ${key} leaked a secret`);
  }
});

await check('sanitize_frame_reports_whether_it_redacted_anything', () => {
  const clean = JSON.parse('{"type":"turn_start","usage":{"input_tokens":3}}');
  assert.equal(sanitizeFrame(clean), false);
  const nested = JSON.parse('{"a":[{"b":{"api_key":"sekrit"}}]}');
  assert.equal(sanitizeFrame(nested), true);
  assert.equal(nested.a[0].b.api_key, REDACTED_PLACEHOLDER);
});

await check('sanitize_line_preserves_untouched_frame_verbatim', () => {
  const raw = '{"z":1,  "a":  [1,2,3],"nested":{"k":"v"}}';
  const { text, parsed } = sanitizeLine(Buffer.from(raw));
  assert.equal(text, raw);
  assert.notEqual(parsed, null);
});

await check('sanitize_leaves_usage_token_counts_unredacted', () => {
  const raw = JSON.stringify({ usage: { input_tokens: 42, output_tokens: 7 } });
  const { text, parsed } = sanitizeLine(raw);
  assert.ok(!text.includes(REDACTED_PLACEHOLDER));
  assert.equal(parsed.usage.input_tokens, 42);
  assert.equal(parsed.usage.output_tokens, 7);
});

await check('sanitize_redacts_inside_arrays', () => {
  const { text } = sanitizeLine(JSON.stringify({ items: [{ password: 'hunter2' }] }));
  assert.ok(!text.includes('hunter2'));
});

await check('sanitize_falls_back_to_raw_text_on_invalid_json', () => {
  const { text, parsed } = sanitizeLine(Buffer.from('not json at all'));
  assert.equal(text, 'not json at all');
  assert.equal(parsed, null);
});

await check('credential_key_matcher_matches_reference_normalization', () => {
  // redaction.rs's reference: lowercase, drop `_`/`-`, ends-with.
  const reference = (key, suffix) =>
    key
      .split('')
      .filter((c) => c !== '_' && c !== '-')
      .join('')
      .toLowerCase()
      .endsWith(suffix);
  const keys = [
    'api_key',
    'api-key',
    'apiKey',
    'API_KEY',
    'x-api-key',
    'OPENAI_API_KEY',
    'client_secret',
    'input_tokens',
    'output_tokens',
    'monkey',
    'key',
    '',
    '_-_-',
    'aPiKeY',
    'authorization',
    'headers',
  ];
  for (const key of keys) {
    const expected = REDACTED_KEYS.some((suffix) => reference(key, suffix));
    assert.equal(isCredentialKey(key), expected, `mismatch for ${key}`);
  }
  assert.equal(isCredentialKey('clé_api_key'), true);
});

// ── LineFramer (read_until_capped) ─────────────────────────────────────────

await check('read_until_capped_frames_a_normal_line', () => {
  const framer = new LineFramer(1024);
  const frames = framer.push(Buffer.from('hello\nworld\n'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].bytes.toString(), 'hello');
  assert.equal(frames[0].truncated, false);
  assert.equal(frames[1].bytes.toString(), 'world');
});

await check('read_until_capped_reports_truncation_past_the_cap', () => {
  const framer = new LineFramer(4);
  const frames = framer.push(Buffer.from('0123456789\n'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].truncated, true);
  assert.equal(frames[0].bytes.length, 4);
  assert.equal(frames[0].bytes.toString(), '0123');
});

await check('read_until_capped_eof_returns_nothing', () => {
  const framer = new LineFramer(1024);
  assert.deepEqual(framer.push(Buffer.alloc(0)), []);
  assert.deepEqual(framer.end(), []);
});

await check('read_until_capped_flushes_a_delimiter_less_final_line', () => {
  const framer = new LineFramer(1024);
  assert.deepEqual(framer.push(Buffer.from('partial')), []);
  const flushed = framer.end();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].bytes.toString(), 'partial');
  assert.equal(flushed[0].truncated, false);
});

await check('read_until_capped_drops_an_oversized_line_spanning_chunks', () => {
  const framer = new LineFramer(20);
  assert.deepEqual(framer.push(Buffer.from('abcdefghijklmnopqrstuvwxyz')), []);
  const frames = framer.push(Buffer.from('\n{"type":"ready"}\n'));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].truncated, true);
  assert.equal(frames[1].truncated, false);
  assert.equal(frames[1].bytes.toString(), '{"type":"ready"}');
});

await check('read_until_capped_line_at_exactly_the_cap_including_newline_is_kept', () => {
  // Cap counts the delimiter, like BufRead::read_until + the take math.
  const framer = new LineFramer(5);
  const frames = framer.push(Buffer.from('abcd\n'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].truncated, false);
  assert.equal(frames[0].bytes.toString(), 'abcd');
});

await check('MAX_LINE_BYTES is 16 MiB', () => {
  assert.equal(MAX_LINE_BYTES, 16 * 1024 * 1024);
});

// ── journal.rs ─────────────────────────────────────────────────────────────

await check('journal_push_assigns_monotonic_seq_starting_at_one', () => {
  const journal = new EventJournal(4, 1 << 20);
  assert.equal(journal.push('a'), 1);
  assert.equal(journal.push('b'), 2);
  assert.equal(journal.push('c'), 3);
});

await check('journal_since_zero_on_fresh_journal_returns_empty_not_dropped', () => {
  const replay = new EventJournal(4, 1 << 20).since(0);
  assert.deepEqual(replay.events, []);
  assert.equal(replay.headSeq, 0);
  assert.equal(replay.dropped, false);
});

await check('journal_since_returns_only_events_strictly_after_cursor', () => {
  const journal = new EventJournal(4, 1 << 20);
  journal.push('a');
  journal.push('b');
  journal.push('c');
  const replay = journal.since(1);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
  assert.equal(replay.headSeq, 3);
  assert.equal(replay.dropped, false);
});

await check('journal_since_head_cursor_returns_nothing_new', () => {
  const journal = new EventJournal(4, 1 << 20);
  journal.push('a');
  journal.push('b');
  const replay = journal.since(2);
  assert.deepEqual(replay.events, []);
  assert.equal(replay.dropped, false);
});

await check('journal_eviction_beyond_capacity_drops_oldest', () => {
  const journal = new EventJournal(2, 1 << 20);
  journal.push('a');
  journal.push('b');
  journal.push('c');
  assert.deepEqual(journal.since(0).events.map((event) => event.seq), [2, 3]);
});

await check('journal_since_cursor_predating_ring_window_reports_dropped', () => {
  const journal = new EventJournal(2, 1 << 20);
  journal.push('a');
  journal.push('b');
  journal.push('c');
  const replay = journal.since(0);
  assert.equal(replay.dropped, true);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
});

await check('journal_since_cursor_exactly_at_ring_boundary_is_not_dropped', () => {
  const journal = new EventJournal(2, 1 << 20);
  journal.push('a');
  journal.push('b');
  journal.push('c');
  const replay = journal.since(1);
  assert.equal(replay.dropped, false);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
});

await check('journal_byte_budget_evicts_even_under_capacity', () => {
  const journal = new EventJournal(100, 10);
  journal.push('aaaa');
  journal.push('bbbb');
  journal.push('cccc');
  const replay = journal.since(0);
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
  assert.equal(replay.dropped, true);
});

await check('journal_oversized_single_entry_is_retained_so_its_seq_stays_replayable', () => {
  const journal = new EventJournal(100, 4);
  const seq = journal.push('this line alone blows the budget');
  const replay = journal.since(0);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].seq, seq);
});

await check('journal_byte_accounting_does_not_drift_across_many_pushes', () => {
  const journal = new EventJournal(3, 1 << 20);
  for (let i = 0; i < 50; i += 1) journal.push(`line-${i}`);
  const held = journal.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
  assert.equal(journal.bytes, held);
  assert.equal(journal.entries.length, 3);
});

await check('journal_unknown_session_head_seq_is_zero_until_first_push', () => {
  assert.equal(new EventJournal(256, 1 << 20).since(999).headSeq, 0);
});

await check('journal_defaults_match_the_rust_constants', () => {
  assert.equal(EVENT_JOURNAL_CAPACITY, 256);
  assert.equal(EVENT_JOURNAL_MAX_BYTES, 8 * 1024 * 1024);
  const journal = new EventJournal();
  assert.equal(journal.capacity, 256);
  assert.equal(journal.maxBytes, 8 * 1024 * 1024);
});

// ── StderrTail ─────────────────────────────────────────────────────────────

await check('stderr_tail_is_empty_when_the_child_said_nothing', () => {
  assert.equal(new StderrTail().toReason(), null);
});

await check('stderr_tail_collapses_blank_lines_into_one_reason', () => {
  const tail = new StderrTail();
  for (const line of ['No models available.', '', '  Set an API key: ', '']) tail.push(line);
  assert.equal(tail.toReason(), 'No models available. Set an API key:');
});

await check('stderr_tail_keeps_the_newest_lines_within_its_line_bound', () => {
  const tail = new StderrTail();
  for (let n = 0; n < STDERR_TAIL_LINES + 10; n += 1) tail.push(`line${n}`);
  const reason = tail.toReason();
  assert.ok(reason.startsWith('line10 '));
  assert.ok(reason.endsWith(`line${STDERR_TAIL_LINES + 9}`));
});

await check('stderr_tail_evicts_to_stay_within_its_byte_bound', () => {
  const tail = new StderrTail();
  tail.push('x'.repeat(STDERR_TAIL_BYTES - 1));
  tail.push('the real reason');
  assert.equal(tail.toReason(), 'the real reason');
  assert.ok(tail.bytes <= STDERR_TAIL_BYTES);
});

await check('stderr_tail_truncates_an_oversized_line_instead_of_wiping_the_tail', () => {
  const tail = new StderrTail();
  tail.push('z'.repeat(STDERR_TAIL_BYTES + 500));
  const reason = tail.toReason();
  assert.ok(reason.startsWith('zzz'));
  assert.ok(Buffer.byteLength(reason) <= STDERR_TAIL_BYTES);
  assert.ok(tail.bytes <= STDERR_TAIL_BYTES);
});

await check('stderr_tail_truncation_cuts_on_a_char_boundary', () => {
  let line = 'a'.repeat(STDERR_TAIL_BYTES - 1);
  line += '€';
  line += '-dropped-tail';
  const tail = new StderrTail();
  tail.push(line);
  assert.equal(tail.toReason(), 'a'.repeat(STDERR_TAIL_BYTES - 1));
});

await check('stderr_tail_oversized_line_evicts_older_lines_but_not_itself', () => {
  const tail = new StderrTail();
  tail.push('first, superseded by the newer report');
  tail.push('z'.repeat(STDERR_TAIL_BYTES + 10));
  const reason = tail.toReason();
  assert.ok(!reason.includes('superseded'));
  assert.ok(reason.startsWith('z'));
});

await check('prefix_within_cuts_on_char_boundaries', () => {
  assert.equal(prefixWithin('x'.repeat(5000), 2048).length, 2048);
  assert.equal(prefixWithin('abc', 2048), 'abc');
  assert.equal(prefixWithin('abc', 0), '');
  const euros = prefixWithin('€'.repeat(2048), 2048);
  assert.equal(Buffer.byteLength(euros), 2046);
  assert.ok(Array.from(euros).every((ch) => ch === '€'));
});

await check('join_nonblank_trims_and_drops_blank_lines', () => {
  assert.equal(joinNonblank([], ' '), null);
  assert.equal(joinNonblank(['', '  '], ' '), null);
  assert.equal(joinNonblank([' a ', '', 'b'], ' | '), 'a | b');
});

// ── child_exit_reason ──────────────────────────────────────────────────────

await check('nonzero_exit_mid_session_yields_a_nonempty_reason', () => {
  const reason = childExitReason({ code: 1, signal: null }, null, true);
  assert.notEqual(reason, '');
  assert.ok(reason.includes('code 1'), reason);
});

await check('clean_exit_mid_session_stays_the_empty_clean_payload', () => {
  assert.equal(childExitReason({ code: 0, signal: null }, 'benign stderr warnings', true), '');
});

await check('signal_death_mid_session_names_the_signal', () => {
  const reason = childExitReason({ code: null, signal: 'SIGKILL' }, null, true);
  assert.ok(reason.includes('signal 9'), reason);
});

await check('abnormal_mid_session_exit_appends_the_stderr_tail', () => {
  const reason = childExitReason({ code: 3, signal: null }, 'Error: connect ECONNREFUSED', true);
  assert.ok(reason.includes('code 3'), reason);
  assert.ok(reason.includes('ECONNREFUSED'), reason);
});

await check('startup_death_prefers_the_stderr_banner', () => {
  assert.equal(
    childExitReason({ code: 1, signal: null }, 'No models available.', false),
    'No models available.',
  );
});

await check('silent_startup_death_falls_back_to_the_exit_code', () => {
  const reason = childExitReason({ code: 2, signal: null }, null, false);
  assert.ok(reason.includes('code 2'), reason);
});

await check('clean_startup_exit_without_stderr_stays_empty', () => {
  assert.equal(childExitReason({ code: 0, signal: null }, null, false), '');
});

await check('an_unobservable_exit_keeps_the_clean_and_banner_shapes', () => {
  assert.equal(childExitReason(null, 'banner', false), 'banner');
  assert.equal(childExitReason(null, 'noise', true), '');
});

// ── version floor + argv ───────────────────────────────────────────────────

await check('parse_version_line_reads_omp_version_shapes', () => {
  assert.deepEqual(parseVersionLine('omp/18.5.1'), [18, 5, 1]);
  assert.deepEqual(parseVersionLine('v18.5.1-dev.3'), [18, 5, 1]);
  assert.deepEqual(parseVersionLine('  18.12.6  '), [18, 12, 6]);
  assert.equal(parseVersionLine('nonsense'), null);
  assert.equal(parseVersionLine('1.2'), null);
});

await check('version_refusal_accepts_the_floor_and_rejects_older', () => {
  assert.equal(versionRefusal('omp/18.4.11'), null);
  assert.equal(versionRefusal('omp/19.0.0\n'), null);
  const older = versionRefusal('omp/18.4.10');
  assert.ok(older.includes('omp 18.4.10 is older than OMP Desktop supports (18.4.11 or newer)'), older);
  const unreadable = versionRefusal('something went wrong');
  assert.ok(unreadable.includes('could not read the omp version'), unreadable);
  assert.ok(unreadable.includes('"something went wrong"'), unreadable);
  const empty = versionRefusal('');
  assert.ok(empty.includes('could not read the omp version'), empty);
  assert.ok(empty.includes('""'), empty);
});

await check('version_refusal_uses_the_first_version_line', () => {
  assert.equal(versionRefusal('diagnostic line\nomp/18.12.6\n'), null);
});

await check('MIN_OMP_VERSION is the 18.4.11 fork floor', () => {
  assert.deepEqual(MIN_OMP_VERSION, [18, 4, 11]);
});

await check('omp_args_orders_profile_resume_cwd_mode_then_config_last', () => {
  assert.deepEqual(
    ompArgs({
      profile: 'work',
      resume: 'sess-file.jsonl',
      cwd: '/tmp/proj',
      mode: 'always-ask',
      config: '/tmp/overlay.yml',
    }),
    [
      '--mode',
      'rpc-ui',
      '--profile=work',
      '--resume=sess-file.jsonl',
      '--cwd=/tmp/proj',
      '--approval-mode=always-ask',
      '--config=/tmp/overlay.yml',
    ],
  );
});

await check('omp_args_omits_the_builtin_profile_and_blank_values', () => {
  assert.deepEqual(ompArgs({ profile: null, resume: '', cwd: null, mode: 'write', config: null }), [
    '--mode',
    'rpc-ui',
    '--approval-mode=write',
  ]);
  assert.equal(profileFlag('default'), '--profile=default');
  assert.equal(profileFlag(''), null);
});

await check('parse_approval_mode_accepts_exact_kebab_case_only', () => {
  assert.equal(parseApprovalMode(null), 'write');
  assert.equal(parseApprovalMode('yolo'), 'yolo');
  assert.throws(() => parseApprovalMode('YOLO'), /unknown approval mode/);
  assert.throws(() => parseApprovalMode('always_ask'), /unknown approval mode/);
});

await check('parse_rule_scope_matches_the_ipc_parser', () => {
  assert.equal(parseRuleScope('session'), 'session');
  assert.equal(parseRuleScope('project'), 'project');
  assert.throws(() => parseRuleScope('global'), /unknown approval rule scope 'global'/);
});

await check('overlay_content_is_the_browser_settings_overlay', () => {
  assert.equal(
    overlayContent(51234),
    'browser:\n  cdpUrl: "http://127.0.0.1:51234"\n  relay: false\n',
  );
});

await check('resolve_cwd_returns_an_absolute_path', () => {
  assert.equal(resolveCwd('/tmp/x'), '/tmp/x');
  const relative = path.join('some', 'relative', 'dir');
  assert.equal(resolveCwd(relative), path.resolve(relative));
});

// ── trusted PATH (child_path.rs) ───────────────────────────────────────────

await check('child_path_dirs_keeps_absolute_entries_and_adds_launcher_dirs', () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  process.env.PATH = ['/usr/bin', '', 'relative/bin', '.', '/bin'].join(path.delimiter);
  process.env.HOME = '/home/dev';
  try {
    const dirs = childPathDirs();
    assert.ok(dirs.includes('/usr/bin'));
    assert.ok(dirs.includes('/bin'));
    assert.ok(!dirs.includes('relative/bin'));
    assert.ok(!dirs.includes('.'));
    assert.ok(!dirs.includes(''));
    assert.ok(dirs.includes('/opt/homebrew/bin'));
    assert.ok(dirs.includes('/usr/local/bin'));
    assert.ok(dirs.includes('/home/dev/.local/bin'));
    assert.ok(dirs.includes('/home/dev/.cargo/bin'));
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
  }
});

await check('locate_program_takes_the_first_absolute_folder_holding_it', () => {
  const root = makeTempDir('locate');
  const none = path.join(root, 'a');
  const first = path.join(root, 'b');
  const second = path.join(root, 'c');
  fs.mkdirSync(none);
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const exe = path.join(first, 'omp-test');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(exe, 0o755);
  const later = path.join(second, 'omp-test');
  fs.writeFileSync(later, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(later, 0o755);
  const found = locateProgram([none, first, second], 'omp-test');
  assert.equal(found.binary, exe);
  assert.equal(found.path, [none, first, second].join(path.delimiter));
  assert.throws(() => locateProgram([none], 'omp-test'), /was not found in any absolute PATH folder/);
});

await check('locate_program_skips_a_non_executable_file_and_a_directory', () => {
  const root = makeTempDir('locate-nonexec');
  const plain = path.join(root, 'plain');
  fs.writeFileSync(path.join(root, 'omp-test'), 'not executable');
  fs.mkdirSync(plain);
  assert.throws(() => locateProgram([plain, root], 'omp-test'), /was not found/);
});

// ── approval prompt shape (approval.rs tests) ──────────────────────────────

const prompt = (id, tool) => ({
  type: 'extension_ui_request',
  id,
  method: 'select',
  title: `Allow tool: ${tool}`,
  options: ['Approve', 'Deny'],
});

await check('approval_tool_name_matches_exact_prompt_shape', () => {
  assert.equal(approvalToolName(prompt('r1', 'bash')), 'bash');
  assert.equal(approvalRequestId(prompt('r1', 'bash')), 'r1');
});

await check('approval_tool_name_rejects_wrong_method', () => {
  assert.equal(approvalToolName({ ...prompt('r1', 'bash'), method: 'ask' }), null);
});

await check('approval_tool_name_rejects_wrong_options', () => {
  assert.equal(approvalToolName({ ...prompt('r1', 'bash'), options: ['Approve'] }), null);
  assert.equal(approvalToolName({ ...prompt('r1', 'bash'), options: ['Yes', 'No'] }), null);
  assert.equal(approvalToolName({ ...prompt('r1', 'bash'), options: ['Approve', 'Deny', 'Always'] }), null);
});

await check('approval_tool_name_rejects_unrelated_select_prompt', () => {
  assert.equal(
    approvalToolName({
      type: 'extension_ui_request',
      id: 'r1',
      method: 'select',
      title: 'Pick one',
      options: ['a', 'b'],
    }),
    null,
  );
});

await check('approval_tool_name_rejects_invalid_tool_name_in_title', () => {
  assert.equal(approvalToolName(prompt('r1', 'ba sh')), null);
  assert.equal(approvalToolName(prompt('r1', '9bad!')), null);
});

await check('approval_tool_name_reads_first_line_of_multiline_title', () => {
  const frame = {
    ...prompt('r1', 'bash'),
    title: 'Allow tool: bash\nCommand: ls -la\nCwd: /tmp',
  };
  assert.equal(approvalToolName(frame), 'bash');
});

await check('approval_tool_name_tolerates_crlf_in_multiline_title', () => {
  const frame = { ...prompt('r1', 'bash'), title: 'Allow tool: bash\r\nCommand: ls\r\n' };
  assert.equal(approvalToolName(frame), 'bash');
});

await check('approval_tool_name_ignores_prompt_header_in_detail_lines', () => {
  const frame = { ...prompt('r1', 'bash'), title: 'Allow tool: bash\nAllow tool: edit' };
  assert.equal(approvalToolName(frame), 'bash');
});

await check('approval_details_is_the_title_after_its_first_line', () => {
  const frame = {
    ...prompt('r1', 'bash'),
    title: 'Allow tool: bash\nCommand: ls -la\nCwd: /tmp',
  };
  assert.equal(approvalDetails(frame), 'Command: ls -la\nCwd: /tmp');
});

await check('approval_details_is_none_without_detail_lines', () => {
  assert.equal(approvalDetails(prompt('r1', 'bash')), null);
  assert.equal(approvalDetails({ ...prompt('r1', 'bash'), title: 'Allow tool: bash\n  \n' }), null);
});

await check('only_an_extension_ui_response_answers_a_prompt', () => {
  assert.equal(answeredId({ type: 'extension_ui_response', id: 'r1', value: 'Deny' }), 'r1');
  assert.equal(answeredId({ type: 'prompt', id: 'r1' }), null);
  assert.equal(answeredId({ type: 'extension_ui_response' }), null);
});

// ── PendingApprovals ───────────────────────────────────────────────────────

await check('a_forwarded_approval_prompt_is_kept_with_its_tool', () => {
  const pending = new PendingApprovals('/proj');
  pending.observe({
    type: 'extension_ui_request',
    id: 'r2',
    method: 'select',
    title: 'Pick one',
    options: ['a', 'b'],
  });
  pending.observe(prompt('r1', 'bash'));
  assert.equal(pending.tool('r1'), 'bash');
  assert.equal(pending.tool('r2'), undefined);
  assert.equal(pending.tool('other'), undefined);
});

await check('omp_cancel_forgets_the_prompt', () => {
  const pending = new PendingApprovals();
  pending.observe(prompt('r1', 'bash'));
  pending.observe(prompt('r2', 'edit'));
  pending.observe({ type: 'extension_ui_request', id: 'c', method: 'cancel', targetId: 'r1' });
  assert.equal(pending.tool('r1'), undefined);
  assert.equal(pending.tool('r2'), 'edit');
});

await check('a_reused_id_keeps_only_the_latest_prompts_tool', () => {
  const pending = new PendingApprovals();
  pending.observe(prompt('r1', 'bash'));
  pending.observe(prompt('r1', 'edit'));
  assert.equal(pending.tool('r1'), 'edit');
  pending.remove('r1');
  assert.equal(pending.tool('r1'), undefined);
});

await check('the_oldest_prompt_goes_once_the_cap_is_reached', () => {
  const pending = new PendingApprovals();
  for (let i = 0; i <= MAX_PENDING; i += 1) pending.observe(prompt(`r${i}`, 'bash'));
  assert.equal(pending.tool('r0'), undefined);
  assert.equal(pending.tool('r1'), 'bash');
  assert.equal(pending.tool(`r${MAX_PENDING}`), 'bash');
  assert.equal(pending.list().length, MAX_PENDING);
});

await check('an_oversized_id_is_not_recorded', () => {
  const pending = new PendingApprovals();
  const id = 'x'.repeat(MAX_ID_BYTES + 1);
  pending.observe(prompt(id, 'bash'));
  assert.equal(pending.tool(id), undefined);
});

// ── ApprovalRuleBook ───────────────────────────────────────────────────────

await check('session_grant_is_visible_only_to_that_session', () => {
  const book = new ApprovalRuleBook();
  book.grant('sess-a', null, 'bash', 'session');
  assert.equal(book.isGranted('sess-a', null, 'bash'), true);
  assert.equal(book.isGranted('sess-b', null, 'bash'), false);
});

await check('clear_session_drops_only_that_sessions_grants', () => {
  const book = new ApprovalRuleBook();
  book.grant('sess-a', null, 'bash', 'session');
  book.grant('sess-b', null, 'edit', 'session');
  book.clearSession('sess-a');
  assert.equal(book.isGranted('sess-a', null, 'bash'), false);
  assert.equal(book.isGranted('sess-b', null, 'edit'), true);
});

await check('project_grant_persists_across_a_new_rulebook_instance', () => {
  const configRoot = makeTempDir('rules');
  const project = makeTempDir('proj');
  const book = new ApprovalRuleBook(configRoot);
  book.grant('sess-a', project, 'bash', 'project');
  assert.equal(book.isGranted('sess-a', project, 'bash'), true);
  const reopened = new ApprovalRuleBook(configRoot);
  assert.equal(reopened.isGranted('other-session', project, 'bash'), true);
  const file = path.join(configRoot, `${projectKey(project)}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.rules.map((rule) => rule.tool), ['bash']);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(onDisk.rules[0].granted_at));
});

await check('project_revoke_removes_a_persisted_grant', () => {
  const configRoot = makeTempDir('rules-revoke');
  const project = makeTempDir('proj-revoke');
  const book = new ApprovalRuleBook(configRoot);
  book.grant('sess-a', project, 'bash', 'project');
  book.revoke('sess-a', project, 'bash', 'project');
  assert.equal(new ApprovalRuleBook(configRoot).isGranted('sess-a', project, 'bash'), false);
  book.revoke('sess-a', project, 'bash', 'project'); // no-op, not an error
});

await check('project_grant_without_root_errors', () => {
  const book = new ApprovalRuleBook();
  assert.throws(() => book.grant('sess-a', null, 'bash', 'project'), /requires a project root/);
  assert.throws(() => book.revoke('sess-a', null, 'bash', 'project'), /requires a project root/);
});

await check('grant_rejects_invalid_tool_name', () => {
  const book = new ApprovalRuleBook();
  assert.throws(() => book.grant('sess-a', null, 'ba sh', 'session'), /is not a valid tool name/);
});

await check('regrant_is_idempotent_not_duplicated', () => {
  const configRoot = makeTempDir('rules-regrant');
  const project = makeTempDir('proj-regrant');
  const book = new ApprovalRuleBook(configRoot);
  book.grant('sess-a', project, 'bash', 'project');
  book.grant('sess-a', project, 'bash', 'project');
  assert.equal(book.list('sess-a', project).length, 1);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(configRoot, `${projectKey(project)}.json`), 'utf8'),
  );
  assert.equal(onDisk.rules.length, 1);
});

await check('corrupt_project_rules_file_treated_as_empty_not_fatal', () => {
  const configRoot = makeTempDir('rules-corrupt');
  const project = makeTempDir('proj-corrupt');
  fs.writeFileSync(path.join(configRoot, `${projectKey(project)}.json`), '{ not json');
  const book = new ApprovalRuleBook(configRoot);
  assert.equal(book.isGranted('sess-a', project, 'bash'), false);
  assert.deepEqual(book.list('sess-a', project), []);
});

await check('different_projects_get_independent_rule_files', () => {
  const configRoot = makeTempDir('rules-two');
  const a = makeTempDir('proj-a');
  const b = makeTempDir('proj-b');
  const book = new ApprovalRuleBook(configRoot);
  book.grant('sess-a', a, 'bash', 'project');
  book.grant('sess-b', b, 'edit', 'project');
  assert.notEqual(projectKey(a), projectKey(b));
  assert.equal(book.isGranted('sess-a', a, 'edit'), false);
  assert.equal(book.isGranted('sess-b', b, 'bash'), false);
});

await check('in_memory_project_grant_dies_with_the_book', () => {
  const project = makeTempDir('proj-mem');
  const book = new ApprovalRuleBook();
  book.grant('sess-a', project, 'bash', 'project');
  assert.equal(book.isGranted('sess-a', project, 'bash'), true);
  assert.equal(new ApprovalRuleBook().isGranted('sess-a', project, 'bash'), false);
});

await check('list_returns_session_rules_first_then_project_rules', () => {
  const configRoot = makeTempDir('rules-list');
  const project = makeTempDir('proj-list');
  const book = new ApprovalRuleBook(configRoot);
  book.grant('sess-a', null, 'edit', 'session');
  book.grant('sess-a', null, 'bash', 'session');
  book.grant('sess-a', project, 'webfetch', 'project');
  assert.deepEqual(book.list('sess-a', project), [
    { tool: 'bash', scope: 'session', grantedAt: '' },
    { tool: 'edit', scope: 'session', grantedAt: '' },
    { tool: 'webfetch', scope: 'project', grantedAt: book.list('sess-a', project)[2].grantedAt },
  ]);
});

// ── AgentBridge with the fake omp ─────────────────────────────────────────

await check('start_session_reports_arguments_and_writes_the_browser_overlay', async () => {
  const bin = makeFakeBin();
  const project = makeTempDir('argv-proj');
  const overlayDir = makeTempDir('argv-overlay');
  const argvFile = path.join(makeTempDir('argv-file'), 'argv');
  const bridge = new AgentBridge({ pathDirs: [bin], overlayDir });
  bridges.push(bridge);
  const events = watch(bridge, 'sess-argv');
  const relative = path.relative(process.cwd(), project);

  await withEnv({ FAKE_OMP_MODE: 'frames', FAKE_OMP_ARGV_FILE: argvFile }, async () => {
    const mode = await bridge.startSession({
      sessionId: 'sess-argv',
      cwd: relative,
      resume: 'sess-file.jsonl',
      profile: 'work',
      approvalMode: 'yolo',
      browserPort: 43210,
    });
    assert.equal(mode, 'yolo');
    await events.exited;
  });

  const overlayPath = path.join(overlayDir, 'sess-argv.yml');
  assert.deepEqual(readLines(argvFile), [
    '--mode',
    'rpc-ui',
    '--profile=work',
    '--resume=sess-file.jsonl',
    `--cwd=${path.resolve(project)}`,
    '--approval-mode=yolo',
    `--config=${overlayPath}`,
  ]);
  assert.equal(fs.readFileSync(overlayPath, 'utf8'), overlayContent(43210));
});

await check('start_session_omits_profile_and_cwd_for_the_builtin_profile', async () => {
  const bin = makeFakeBin();
  const argvFile = path.join(makeTempDir('argv-default'), 'argv');
  const bridge = new AgentBridge({ pathDirs: [bin] });
  bridges.push(bridge);
  const events = watch(bridge, 'sess-default');

  await withEnv({ FAKE_OMP_MODE: 'frames', FAKE_OMP_ARGV_FILE: argvFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-default', cwd: '', resume: null, profile: 'default' });
    await events.exited;
  });

  assert.deepEqual(readLines(argvFile), ['--mode', 'rpc-ui', '--approval-mode=write']);
});

await check('start_session_is_idempotent_on_a_live_session', async () => {
  const pidFile = path.join(makeTempDir('idem'), 'pid');
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-idem');
  await withEnv({ FAKE_OMP_MODE: 'sleep', FAKE_OMP_PID_FILE: pidFile }, async () => {
    assert.equal(await bridge.startSession({ sessionId: 'sess-idem', cwd: '', approvalMode: 'write' }), 'write');
    await waitUntil(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '',
      'the fake omp pid file',
    );
    const first = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.equal(await bridge.startSession({ sessionId: 'sess-idem', cwd: '', approvalMode: 'yolo' }), 'write');
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), first);
    assert.equal(pidAlive(first), true);
    await bridge.stopSession('sess-idem');
    assert.equal(events.exitCount, 0, 'a stopped session emits no exit event');
  });
});

await check('line_events_carry_seq_and_exact_text', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-lines');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'frames' }, async () => {
    await bridge.startSession({ sessionId: 'sess-lines', cwd: '' });
    reason = await events.exited;
  });
  assert.deepEqual(events.texts(), [
    '{"type":"ready"}',
    '{"type":"response","id":"d1","command":"negotiate_protocol","success":true}',
  ]);
  assert.deepEqual(events.lines.map((line) => line.seq), [1, 2]);
  assert.equal(reason, '');
  assert.equal(bridge.sessionStatus('sess-lines'), null);
  assert.throws(() => bridge.replayEvents('sess-lines', 0), /not found/);
  assert.equal(bridge.isAlive('sess-lines'), false);
});

await check('blank_stdout_lines_do_not_kill_the_reader', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-blank');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'blank' }, async () => {
    await bridge.startSession({ sessionId: 'sess-blank', cwd: '' });
    reason = await events.exited;
  });
  assert.deepEqual(events.texts(), ['{"type":"ready"}', '{"type":"agent_end"}']);
  assert.deepEqual(events.lines.map((line) => line.seq), [1, 2]);
  assert.equal(reason, '');
});

await check('startup_death_payload_is_the_bounded_stderr_tail', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-startup-death');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'startup-death' }, async () => {
    await bridge.startSession({ sessionId: 'sess-startup-death', cwd: '' });
    reason = await events.exited;
  });
  assert.equal(reason, 'No models available. Set an API key.');
  assert.equal(bridge.sessionStatus('sess-startup-death'), reason);
  assert.deepEqual(events.lines, []);
});

await check('silent_startup_death_names_the_exit_code', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-silent');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'silent-death' }, async () => {
    await bridge.startSession({ sessionId: 'sess-silent', cwd: '' });
    reason = await events.exited;
  });
  assert.equal(reason, 'process exited with code 2');
  assert.equal(bridge.sessionStatus('sess-silent'), reason);
});

await check('mid_session_death_appends_the_stderr_tail', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-mid-death');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'mid-death' }, async () => {
    await bridge.startSession({ sessionId: 'sess-mid-death', cwd: '' });
    reason = await events.exited;
  });
  assert.deepEqual(events.texts(), ['{"type":"ready"}']);
  assert.equal(reason, 'process exited with code 3 (Error: boom)');
  assert.equal(bridge.sessionStatus('sess-mid-death'), reason);
});

await check('clean_exit_without_frames_is_the_empty_payload', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-clean');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'clean' }, async () => {
    await bridge.startSession({ sessionId: 'sess-clean', cwd: '' });
    reason = await events.exited;
  });
  assert.equal(reason, '');
  assert.equal(bridge.sessionStatus('sess-clean'), null);
});

await check('an_oversized_stdout_line_is_dropped_and_reading_continues', async () => {
  const bridge = makeBridge();
  const events = watch(bridge, 'sess-huge');
  let reason;
  await withEnv({ FAKE_OMP_MODE: 'huge' }, async () => {
    await bridge.startSession({ sessionId: 'sess-huge', cwd: '' });
    reason = await events.exited;
  });
  assert.deepEqual(events.texts(), ['{"type":"ready"}']);
  assert.equal(events.lines[0].seq, 1, 'the dropped line never consumed a seq');
  assert.equal(reason, '');
});

await check('send_command_writes_one_trailing_newline_terminated_line', async () => {
  const stdinFile = path.join(makeTempDir('stdin'), 'lines');
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'stdin-capture', FAKE_OMP_STDIN_FILE: stdinFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-send', cwd: '' });
    await bridge.sendCommand('sess-send', '{"type":"get_state","id":"d1"}\r\n');
    await waitUntil(() => (readLines(stdinFile) || []).length > 0, 'the captured stdin line');
    assert.deepEqual(readLines(stdinFile), ['{"type":"get_state","id":"d1"}']);
    await bridge.stopSession('sess-send');
  });
});

await check('send_command_rejects_types_outside_the_allowlist', async () => {
  const stdinFile = path.join(makeTempDir('stdin-reject'), 'lines');
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'stdin-capture', FAKE_OMP_STDIN_FILE: stdinFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-reject', cwd: '' });
    await assert.rejects(
      () => bridge.sendCommand('sess-reject', '{"type":"switch_session","path":"/etc/passwd"}'),
      /not allowed/,
    );
    await assert.rejects(() => bridge.sendCommand('sess-reject', 'not json'), /not valid JSON/);
    await assert.rejects(() => bridge.sendCommand('sess-reject', '{"message":"hi"}'), /missing string 'type'/);
    await bridge.stopSession('sess-reject');
  });
  assert.equal(readLines(stdinFile), null, 'nothing reached the child');
});

await check('send_command_for_an_unknown_session_uses_the_cached_error', async () => {
  const empty = makeTempDir('empty-path');
  const bridge = new AgentBridge({ pathDirs: [empty] });
  bridges.push(bridge);
  await assert.rejects(
    () => bridge.startSession({ sessionId: 'sess-missing', cwd: '' }),
    /omp was not found in any absolute PATH folder/,
  );
  assert.match(bridge.sessionStatus('sess-missing'), /omp was not found/);
  await assert.rejects(
    () => bridge.sendCommand('sess-missing', '{"type":"get_state"}'),
    /omp was not found/,
  );
  await assert.rejects(
    () => bridge.sendCommand('sess-never', '{"type":"get_state"}'),
    /session 'sess-never' not found/,
  );
  assert.equal(bridge.isAlive('sess-missing'), false);
});

await check('starting_an_omp_older_than_the_floor_is_refused_and_cached', async () => {
  const bin = makeFakeBin();
  const bridge = new AgentBridge({ pathDirs: [bin] });
  bridges.push(bridge);
  await withEnv({ FAKE_OMP_VERSION: 'omp/18.4.10' }, async () => {
    await assert.rejects(
      () => bridge.startSession({ sessionId: 'sess-old', cwd: '' }),
      /is older than OMP Desktop supports \(18\.4\.11 or newer\)/,
    );
  });
  assert.match(bridge.sessionStatus('sess-old'), /is older than OMP Desktop supports/);
});

await check('an_unreadable_omp_version_is_refused', async () => {
  const bin = makeFakeBin();
  const bridge = new AgentBridge({ pathDirs: [bin] });
  bridges.push(bridge);
  await withEnv({ FAKE_OMP_VERSION: 'could not start' }, async () => {
    await assert.rejects(
      () => bridge.startSession({ sessionId: 'sess-unknown-version', cwd: '' }),
      /could not read the omp version/,
    );
  });
});

await check('stop_session_kills_the_whole_process_group', async () => {
  const dir = makeTempDir('kill');
  const pidFile = path.join(dir, 'pid');
  const childPidFile = path.join(dir, 'child-pid');
  const bridge = makeBridge();
  await withEnv(
    {
      FAKE_OMP_MODE: 'sleep',
      FAKE_OMP_PID_FILE: pidFile,
      FAKE_OMP_CHILD_PID_FILE: childPidFile,
    },
    async () => {
      await bridge.startSession({ sessionId: 'sess-kill', cwd: '' });
      await waitUntil(
        () =>
          fs.existsSync(pidFile) &&
          fs.readFileSync(pidFile, 'utf8').trim() !== '' &&
          fs.existsSync(childPidFile) &&
          fs.readFileSync(childPidFile, 'utf8').trim() !== '',
        'pid files',
      );
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      const childPid = Number(fs.readFileSync(childPidFile, 'utf8').trim());
      assert.equal(pidAlive(pid), true);
      assert.equal(pidAlive(childPid), true);
      await bridge.stopSession('sess-kill');
      await waitDead(pid, 'omp');
      await waitDead(childPid, 'background child');
    },
  );
  assert.equal(bridge.isAlive('sess-kill'), false);
  assert.throws(() => bridge.replayEvents('sess-kill', 0), /not found/);
});

await check('journal_replay_covers_events_the_listener_missed', async () => {
  const bridge = makeBridge({ journalCapacity: 2 });
  const events = watch(bridge, 'sess-replay');
  await withEnv({ FAKE_OMP_MODE: 'frames5' }, async () => {
    await bridge.startSession({ sessionId: 'sess-replay', cwd: '' });
    await waitUntil(() => events.lines.length === 5, 'five frames');
    const all = bridge.replayEvents('sess-replay', 0);
    assert.equal(all.headSeq, 5);
    assert.equal(all.dropped, true);
    assert.deepEqual(all.events.map((event) => event.seq), [4, 5]);
    const fromThree = bridge.replayEvents('sess-replay', 3);
    assert.equal(fromThree.dropped, false);
    assert.deepEqual(fromThree.events.map((event) => event.seq), [4, 5]);
    const head = bridge.replayEvents('sess-replay', 5);
    assert.deepEqual(head.events, []);
    assert.equal(head.dropped, false);
    await bridge.stopSession('sess-replay');
  });
});

// ── approvals through the bridge (agent/approvals.rs tests) ───────────────

await check('approving_answers_the_asking_process_then_grants_its_scope', async () => {
  const dir = makeTempDir('approve');
  const stdinFile = path.join(dir, 'lines');
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'prompt-answer', FAKE_OMP_STDIN_FILE: stdinFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-approve', cwd: '', approvalMode: 'always-ask' });
    await waitUntil(() => bridge.pendingApprovals('sess-approve').length === 1, 'the open prompt');
    assert.deepEqual(bridge.pendingApprovals('sess-approve'), [{ id: 'req-9', tool: 'bash' }]);
    const result = await bridge.approveAndGrant('sess-approve', 'req-9', 'session');
    assert.equal(result, null);
    await waitUntil(() => (readLines(stdinFile) || []).length > 0, 'the written answer');
    assert.deepEqual(readLines(stdinFile), [
      '{"type":"extension_ui_response","id":"req-9","value":"Approve"}',
    ]);
  });
  assert.deepEqual(bridge.listRules('sess-approve', null), [
    { tool: 'bash', scope: 'session', grantedAt: '' },
  ]);
});

await check('a_settled_or_unknown_prompt_is_neither_answered_nor_granted', async () => {
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'prompt-sleep' }, async () => {
    await bridge.startSession({ sessionId: 'sess-noprompt', cwd: '' });
    await waitUntil(() => bridge.pendingApprovals('sess-noprompt').length === 1, 'the open prompt');
    await assert.rejects(
      () => bridge.approveAndGrant('sess-noprompt', 'nope', 'session'),
      /has no open approval prompt 'nope'/,
    );
    await assert.rejects(
      () => bridge.approveAndGrant('sess-noprompt', 'req-9', 'global'),
      /unknown approval rule scope 'global'/,
    );
    assert.deepEqual(bridge.pendingApprovals('sess-noprompt'), [{ id: 'req-9', tool: 'bash' }]);
    await bridge.stopSession('sess-noprompt');
  });
});

await check('a_project_grant_without_a_folder_is_refused_and_keeps_the_prompt', async () => {
  const dir = makeTempDir('approve-project');
  const stdinFile = path.join(dir, 'lines');
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'prompt-sleep', FAKE_OMP_STDIN_FILE: stdinFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-project', cwd: '' });
    await waitUntil(() => bridge.pendingApprovals('sess-project').length === 1, 'the open prompt');
    await assert.rejects(
      () => bridge.approveAndGrant('sess-project', 'req-9', 'project'),
      /project-scoped grant requires a project root/,
    );
    assert.equal(readLines(stdinFile), null);
    assert.deepEqual(bridge.pendingApprovals('sess-project'), [{ id: 'req-9', tool: 'bash' }]);
    await bridge.stopSession('sess-project');
  });
});

await check('an_answer_omp_never_received_keeps_the_prompt', async () => {
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'prompt-sleep' }, async () => {
    await bridge.startSession({ sessionId: 'sess-broken', cwd: '' });
    await waitUntil(() => bridge.pendingApprovals('sess-broken').length === 1, 'the open prompt');
    const entry = bridge.sessions.get('sess-broken');
    entry.stdin.destroy();
    await assert.rejects(() => bridge.approveAndGrant('sess-broken', 'req-9', 'session'));
    assert.deepEqual(bridge.pendingApprovals('sess-broken'), [{ id: 'req-9', tool: 'bash' }]);
    await bridge.stopSession('sess-broken');
  });
});

await check('omp_cancel_via_the_reader_settles_the_prompt', async () => {
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'prompt-cancel-sleep' }, async () => {
    await bridge.startSession({ sessionId: 'sess-cancel', cwd: '' });
    // The cancel frame arrives right after the prompt: first the prompt is
    // recorded, then omp's cancel forgets it. Poll until the prompt was seen,
    // then until it is gone — a 0-length check alone would pass vacuously.
    let sawPrompt = false;
    await waitUntil(() => {
      const pending = bridge.pendingApprovals('sess-cancel');
      if (pending.length === 1) sawPrompt = true;
      return sawPrompt && pending.length === 0;
    }, 'prompt recorded then cancelled');
    await bridge.stopSession('sess-cancel');
  });
});

await check('a_granted_rule_auto_answers_and_emits_the_notice', async () => {
  const dir = makeTempDir('auto-approve');
  const stdinFile = path.join(dir, 'lines');
  const bridge = makeBridge();
  bridge.grantRule({ sessionId: 'sess-auto', tool: 'bash', scope: 'session' });
  const events = watch(bridge, 'sess-auto');
  await withEnv({ FAKE_OMP_MODE: 'prompt-answer', FAKE_OMP_STDIN_FILE: stdinFile }, async () => {
    await bridge.startSession({ sessionId: 'sess-auto', cwd: '' });
    await waitUntil(() => (readLines(stdinFile) || []).length > 0, 'the auto answer');
    assert.deepEqual(readLines(stdinFile), [
      '{"type":"extension_ui_response","id":"req-9","value":"Approve"}',
    ]);
    assert.equal(bridge.pendingApprovals('sess-auto').length, 0, 'never offered to the human');
    await events.exited;
  });
  assert.equal(events.lines.length, 1);
  const notice = JSON.parse(events.lines[0].text);
  assert.deepEqual(notice, {
    type: 'desktop_auto_approval',
    tool: 'bash',
    details: 'Command: ls',
  });
});

await check('a_rule_that_does_not_match_forwards_the_prompt_untouched', async () => {
  const bridge = makeBridge();
  bridge.grantRule({ sessionId: 'sess-nomatch', tool: 'edit', scope: 'session' });
  await withEnv({ FAKE_OMP_MODE: 'prompt-sleep' }, async () => {
    await bridge.startSession({ sessionId: 'sess-nomatch', cwd: '' });
    await waitUntil(() => bridge.pendingApprovals('sess-nomatch').length === 1, 'the open prompt');
    assert.deepEqual(bridge.pendingApprovals('sess-nomatch'), [{ id: 'req-9', tool: 'bash' }]);
    await bridge.stopSession('sess-nomatch');
  });
});

await check('shutdown_all_leaves_no_orphaned_processes', async () => {
  const dir = makeTempDir('shutdown');
  const one = path.join(dir, 'one.pid');
  const two = path.join(dir, 'two.pid');
  const childOne = path.join(dir, 'one.child.pid');
  const childTwo = path.join(dir, 'two.child.pid');
  const bridge = makeBridge();
  await withEnv({ FAKE_OMP_MODE: 'sleep', FAKE_OMP_CHILD_PID_FILE: path.join(dir, 'unused') }, async () => {
    await withEnv({ FAKE_OMP_PID_FILE: one, FAKE_OMP_CHILD_PID_FILE: childOne }, async () => {
      await bridge.startSession({ sessionId: 'sess-one', cwd: '' });
    });
    await withEnv({ FAKE_OMP_PID_FILE: two, FAKE_OMP_CHILD_PID_FILE: childTwo }, async () => {
      await bridge.startSession({ sessionId: 'sess-two', cwd: '' });
    });
    await waitUntil(
      () =>
        [one, two, childOne, childTwo].every(
          (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '',
        ),
      'both pid files',
    );
    const pids = [one, two, childOne, childTwo].map((file) =>
      Number(fs.readFileSync(file, 'utf8').trim()),
    );
    for (const pid of pids) assert.equal(pidAlive(pid), true, `pid ${pid} should be running`);
    await bridge.shutdownAll();
    assert.equal(bridge.sessions.size, 0);
    for (const pid of pids) await waitDead(pid, `pid ${pid}`);
  });
});

// ── real-omp smoke ─────────────────────────────────────────────────────────

{
  let ompFound = false;
  try {
    locateProgram(childPathDirs(), 'omp');
    ompFound = true;
  } catch {
    ompFound = false;
  }
  if (!ompFound) {
    skip('real_omp_smoke', 'omp is not on PATH');
  } else {
    await check('real_omp_smoke_emits_a_first_frame_and_answers_negotiate', async () => {
      const bridge = new AgentBridge(); // real PATH, real omp
      bridges.push(bridge);
      const project = makeTempDir('smoke-cwd');
      const sessionId = `smoke-${Date.now()}`;
      const events = watch(bridge, sessionId);
      await withEnv({ FAKE_OMP_MODE: undefined }, async () => {
        await bridge.startSession({ sessionId, cwd: project, approvalMode: 'always-ask' });
        const first = await Promise.race([
          waitUntil(() => events.lines.length > 0, 'the first omp frame', 15000),
          events.exited.then((reason) => {
            throw new Error(`omp exited before its first frame: ${reason || '(clean)'}`);
          }),
        ]);
        assert.equal(first, true);
        const frame = JSON.parse(events.lines[0].text);
        assert.equal(typeof frame, 'object');
        assert.equal(events.lines[0].seq, 1);
        // The other half of the stdio contract: a command written to omp's
        // stdin produces its RPC response on stdout (live.js's
        // `_sendWithResponse` gate).
        await bridge.sendCommand(
          sessionId,
          JSON.stringify({ type: 'negotiate_protocol', protocolVersion: 2, id: 'smoke-1' }),
        );
        await waitUntil(
          () => events.lines.some((line) => line.text.includes('"id":"smoke-1"')),
          'the negotiate_protocol response',
          15000,
        );
        const response = JSON.parse(
          events.lines.find((line) => line.text.includes('"id":"smoke-1"')).text,
        );
        assert.equal(response.type, 'response');
        assert.equal(response.command, 'negotiate_protocol');
        assert.equal(response.success, true);
      });
      await bridge.stopSession(sessionId);
    });
  }
}

// ── cleanup + summary ──────────────────────────────────────────────────────

for (const bridge of bridges) {
  try {
    await bridge.shutdownAll();
  } catch {
    // Best effort: a failed teardown is already reported by its own check.
  }
}
for (const dir of scratchDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Scratch only.
  }
}

console.log(
  `\nchecks: ${checks} (${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''})`,
);
if (failed > 0) {
  console.log('\nfailures:');
  for (const { name, error } of failures) console.log(`  - ${name}: ${error && error.message ? error.message : error}`);
}
process.exit(failed === 0 ? 0 : 1);