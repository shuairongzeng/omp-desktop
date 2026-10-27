/* electron/backend/agent.js — Node port of the per-session omp process bridge.

   Mirrors `src-tauri/src/agent/{mod,inner,spawn,reader,journal,approvals}.rs`
   plus the process-tree kill model of `src-tauri/src/supervisor.rs` and the
   session/approval commands of `lib.rs`:

     start_session / send_command / stop_session / replay_events /
     session_status / approval_approve_and_grant / approval_rules_*

   One omp child per tab session, spawned as `omp --mode rpc-ui …`
   (see `ompArgs`, ported verbatim from `spawn::omp_args`):

     --mode rpc-ui [--profile=<id>] [--resume=<value>] [--cwd=<abs>]
     --approval-mode=<mode> [--config=<browser overlay>]

   `--resume` and `--cwd` are single tokens so omp's own parser can never
   re-split a flag-shaped value; the browser overlay is always LAST. The
   overlay content is `overlayContent(port)` (`browser.cdpUrl` +
   `browser.relay: false`, from `browser::process::instance::overlay`);
   `startSession` accepts either an already-written `config` path (the
   browser manager's job) or a `browserPort`/`cdpUrl` to write one.

   `omp` is always resolved to an ABSOLUTE path by searching the trusted PATH
   (`childPathDirs` = inherited absolute entries + the launcher-install dirs
   from `child_path.rs`) and spawned by that path with that PATH in its env,
   never by a bare name: a tab starts in the project folder, and a bare name
   would resolve through any relative/empty PATH entry there. `OMP_PROFILE`
   and `PI_PROFILE` are stripped so they cannot override the per-tab choice,
   and the `omp --version` floor (`MIN_OMP_VERSION`) is checked once per
   binary, exactly like `spawn::check_omp_version`.

   Events (Node EventEmitter):
     bridge.on("line", (sessionId, { seq, text }) => …)   one per stdout line
     bridge.on("exit", (sessionId, reason) => …)          "" clean, else why

   `text` is the JSON line (credentials redacted, invalid UTF-8 replaced), as
   in the Tauri `agent://line/{id}` payload; `seq` is the journal ring's
   monotonic stamp, shared with `replayEvents`.

   Kill semantics: the child is spawned `detached` so it leads its own
   process group (Unix `process_group(0)`, supervisor.rs), and teardown sends
   SIGKILL to `-pid` — the whole tree, not just `omp`. `stopSession`,
   session replacement and `shutdownAll` therefore leave no orphans. A
   stopped session emits no `exit` event (its liveness flag is cleared first,
   like `BridgeInner::alive`).

   Deliberate simplifications vs. Rust, none visible to the frontend:
   - The project rule book persists to `<configRoot>/approval-rules/<key>.json`
     with the same on-disk shape, but without the snapshot ring / advisory
     lock (`json_store` is a separate port).
   - `sanitizeLine` re-serializes a redacted frame with JSON.stringify, which
     preserves key insertion order; serde_json (without preserve_order) sorts
     keys. Untouched frames are forwarded verbatim, so the hot path is
     unaffected.
   - stderr lines are decoded lossily (Rust's `lines()` stops at the first
     invalid UTF-8 line); the tail's 24-line/4096-byte bounds are identical.
*/

'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── constants (kept in sync with the Rust modules) ──────────────────────────

/** `reader::MAX_LINE_BYTES`. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** `agent::EVENT_JOURNAL_CAPACITY`. */
const EVENT_JOURNAL_CAPACITY = 256;
/** `agent::EVENT_JOURNAL_MAX_BYTES`. */
const EVENT_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** `reader::STDERR_TAIL_LINES` / `STDERR_TAIL_BYTES`. */
const STDERR_TAIL_LINES = 24;
const STDERR_TAIL_BYTES = 4096;
/** `redaction::REDACTED_PLACEHOLDER`. */
const REDACTED_PLACEHOLDER = '[REDACTED]';
/** `redaction::REDACTED_KEYS`. */
const REDACTED_KEYS = [
  'headers',
  'authorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'secret',
  'credential',
  'credentials',
  'secretkey',
  'accesskey',
  'privatekey',
  'apisecret',
];
/** `spawn::MIN_OMP_VERSION`. */
const MIN_OMP_VERSION = [18, 4, 11];
/** `approvals::MAX_PENDING` / `MAX_ID_BYTES`. */
const MAX_PENDING = 64;
const MAX_ID_BYTES = 256;
/** `approval::APPROVAL_OPTIONS` / `TITLE_PREFIX` / `RULES_FILE_VERSION`. */
const APPROVAL_OPTIONS = ['Approve', 'Deny'];
const TITLE_PREFIX = 'Allow tool: ';
const RULES_FILE_VERSION = 1;

/** `agent::ALLOWED_COMMAND_TYPES` — every command `src/live.js` sends. */
const ALLOWED_COMMAND_TYPES = [
  'extension_ui_response',
  'get_session_stats',
  'get_state',
  'get_messages',
  'get_available_models',
  'get_available_commands',
  'negotiate_protocol',
  'prompt',
  'abort',
  'abort_retry',
  'follow_up',
  'steer',
  'remove_queued_message',
  'promote_queued_message',
  'set_model',
  'cycle_model',
  'cycle_thinking_level',
  'get_available_thinking_levels',
  'set_thinking_level',
  'compact',
  'new_session',
  'export_html',
  'get_login_providers',
  'login',
  'set_ask_dialog',
  'set_subagent_subscription',
  'get_subagents',
  'get_subagent_messages',
  'steer_subagent',
  'cancel_subagent',
  'branch',
  'fork',
  'goal',
  'set_auto_compaction',
  'set_auto_retry',
];

/** `approval_mode::ApprovalMode::flag` / `as_str`. */
const APPROVAL_MODE_FLAGS = {
  'always-ask': '--approval-mode=always-ask',
  write: '--approval-mode=write',
  yolo: '--approval-mode=yolo',
};

/** `child_path::EXTRA_PATH_DIRS` (Unix). */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

// ── redaction (redaction.rs) ────────────────────────────────────────────────

/** Whether `key`'s normalized (lowercased, `_`/`-`-free) form ends with `suffix`. */
function normalizedKeyEndsWith(key, suffix) {
  let j = key.length - 1;
  for (let i = suffix.length - 1; i >= 0; i -= 1) {
    while (j >= 0 && (key[j] === '_' || key[j] === '-')) j -= 1;
    if (j < 0) return false;
    if (key[j].toLowerCase() !== suffix[i]) return false;
    j -= 1;
  }
  return true;
}

/** `redaction::is_credential_key`. */
function isCredentialKey(key) {
  return REDACTED_KEYS.some((suffix) => normalizedKeyEndsWith(key, suffix));
}

/**
 * `reader::sanitize_frame`: recursively replace credential-keyed values.
 * Returns true when anything was redacted (so the caller can skip a
 * needless re-serialize). Redacted subtrees are not descended into.
 */
function sanitizeFrame(value) {
  let redacted = false;
  if (Array.isArray(value)) {
    for (const item of value) if (sanitizeFrame(item)) redacted = true;
    return redacted;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isCredentialKey(key)) {
        value[key] = REDACTED_PLACEHOLDER;
        redacted = true;
      } else if (sanitizeFrame(value[key])) {
        redacted = true;
      }
    }
  }
  return redacted;
}

/**
 * `reader::sanitize_line`: parse + redact one raw line. Non-JSON lines are
 * forwarded unchanged (never dropped), with `parsed: null`.
 * Returns `{ text, parsed }`.
 */
function sanitizeLine(raw) {
  const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { text: decoded, parsed: null };
  }
  const redacted = sanitizeFrame(parsed);
  return { text: redacted ? JSON.stringify(parsed) : decoded, parsed };
}

// ── small text helpers (text.rs) ────────────────────────────────────────────

/** `reader::strip_trailing_crlf` — any combination/order of trailing `\r`/`\n`. */
function stripTrailingCRLF(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  return bytes.subarray(0, end);
}

/** `text::prefix_within` — longest prefix of `text` within `maxBytes`, on a char boundary. */
function prefixWithin(text, maxBytes) {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** `text::join_nonblank` — lines trimmed, blanks dropped, joined with `sep`. */
function joinNonblank(lines, sep) {
  const kept = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (trimmed !== '') kept.push(trimmed);
  }
  return kept.length === 0 ? null : kept.join(sep);
}

// ── version floor (spawn.rs) ────────────────────────────────────────────────

/** `spawn::parse_version_line` — `[major, minor, patch]` or null. */
function parseVersionLine(line) {
  let version = String(line).trim();
  const slash = version.lastIndexOf('/');
  if (slash !== -1) version = version.slice(slash + 1);
  if (version.startsWith('v')) version = version.slice(1);
  const parts = version.split('.');
  if (parts.length < 3) return null;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const rest = parts.slice(2).join('.');
  const match = /^\d+/.exec(rest);
  if (match === null) return null;
  return [Number.parseInt(parts[0], 10), Number.parseInt(parts[1], 10), Number.parseInt(match[0], 10)];
}

/** `spawn::fmt_version`. */
function fmtVersion([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function versionAtLeast(found, min) {
  for (let i = 0; i < 3; i += 1) {
    if (found[i] !== min[i]) return found[i] > min[i];
  }
  return true;
}

/**
 * `spawn::version_refusal`: the refusal message for `omp --version` output,
 * or null when it reports MIN_OMP_VERSION or newer / no version at all.
 */
function versionRefusal(output) {
  const lines = String(output)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let found = null;
  for (const line of lines) {
    found = parseVersionLine(line);
    if (found !== null) break;
  }
  if (found !== null && versionAtLeast(found, MIN_OMP_VERSION)) return null;
  if (found !== null) {
    return (
      `omp ${fmtVersion(found)} is older than OMP Desktop supports ` +
      `(${fmtVersion(MIN_OMP_VERSION)} or newer). Run \`omp update\`.`
    );
  }
  const printed = Array.from(String(output).trim()).slice(0, 200).join('');
  return (
    `could not read the omp version (\`omp --version\` printed ${JSON.stringify(printed)}). ` +
    `OMP Desktop needs omp ${fmtVersion(MIN_OMP_VERSION)} or newer.`
  );
}

// ── trusted PATH + omp resolution (child_path.rs) ───────────────────────────

/** Windows paths compare case-insensitively and separator-insensitively. */
function pathKey(dir) {
  const raw = String(dir);
  if (process.platform !== 'win32') return raw;
  return raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * `child_path::child_path_dirs`: absolute inherited PATH entries in order,
 * followed by launcher-install dirs the caller's PATH lacks. Relative and
 * empty entries are dropped — they would resolve against the project folder.
 */
function childPathDirs() {
  const inherited = process.env.PATH || '';
  // Inherited absolute entries keep their order (and any duplicates), exactly
  // like `merged_path` starting from the current PATH.
  const dirs = inherited
    .split(path.delimiter)
    .filter((entry) => entry !== '' && path.isAbsolute(entry));
  const seen = new Set(dirs.map(pathKey));
  // Windows extra dirs come from the registry in Rust; Electron inherits the
  // user PATH, so the inherited entries are already complete there.
  const extra = process.platform === 'win32' ? [] : EXTRA_PATH_DIRS.slice();
  const home = process.env.HOME;
  if (process.platform !== 'win32' && home) {
    extra.push(`${home}/.local/bin`, `${home}/.cargo/bin`);
  }
  for (const dir of extra) {
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/** `program_setting::is_executable_file`. */
function isExecutableFile(candidate) {
  if (!path.isAbsolute(candidate)) return false;
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `child_path::locate_program`: the first `dirs` entry holding an executable
 * `name`, plus the PATH those dirs join into. Windows only looks for
 * `<name>.exe`, exactly what a bare-name lookup would have resolved.
 */
function locateProgram(dirs, name) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (isExecutableFile(candidate)) {
      return { binary: candidate, path: dirs.join(path.delimiter) };
    }
  }
  throw new Error(
    `${name} was not found in any absolute PATH folder (relative entries are ignored). ` +
      `Make sure ${name} is installed and on PATH.`,
  );
}

// ── argv (spawn.rs) ─────────────────────────────────────────────────────────

/** `spawn::profile_flag` — blank and null both mean the built-in profile. */
function profileFlag(profile) {
  if (profile == null || profile === '') return null;
  return `--profile=${profile}`;
}

function isDefaultProfile(profile) {
  return profile == null || profile === '' || profile === 'default';
}

/** `spawn::resolve_cwd` — one absolute path for both `cwd` and `--cwd=`. */
function resolveCwd(dir) {
  try {
    return path.resolve(dir);
  } catch {
    return dir;
  }
}

/** `lib.rs::parse_rule_scope`. */
function parseRuleScope(scope) {
  if (scope === 'session' || scope === 'project') return scope;
  throw new Error(`unknown approval rule scope '${scope}'`);
}

/** `ApprovalMode::from_str` — exact kebab-case spellings only. */
function parseApprovalMode(mode) {
  if (mode == null) return 'write';
  if (Object.prototype.hasOwnProperty.call(APPROVAL_MODE_FLAGS, mode)) return mode;
  throw new Error(`unknown approval mode ${JSON.stringify(mode)} (expected always-ask, write or yolo)`);
}

/**
 * `spawn::omp_args` — the argv suffix after the binary name. Order is part of
 * the contract: `--mode rpc-ui` first, `--config` last.
 */
function ompArgs({ profile, resume, cwd, mode, config }) {
  const args = ['--mode', 'rpc-ui'];
  const flag = profileFlag(profile);
  if (flag !== null) args.push(flag);
  if (resume != null && resume !== '') args.push(`--resume=${resume}`);
  if (cwd != null && cwd !== '') args.push(`--cwd=${cwd}`);
  args.push(APPROVAL_MODE_FLAGS[parseApprovalMode(mode)]);
  if (config != null) args.push(`--config=${config}`);
  return args;
}

/** `browser::process::instance::overlay`. */
function overlayContent(port) {
  return `browser:\n  cdpUrl: "http://127.0.0.1:${port}"\n  relay: false\n`;
}

/**
 * Create/verify a private directory (mode 0700). A pre-existing symlink or
 * non-directory is refused rather than followed — the overlay is
 * standing configuration omp will read.
 */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`not a private directory: ${dir}`);
  }
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

/**
 * Write `contents` to `file` as a private file (0600), never through an
 * existing symlink: a stale entry from an earlier run is unlinked first and
 * the new file created exclusively (`O_EXCL`), mirroring
 * `browser::process::instance::create_private_file`.
 */
function writePrivateFile(file, contents) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) throw new Error(`not a file: ${file}`);
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
}

function cdpPort(cdpUrl) {
  const port = new URL(cdpUrl).port;
  if (!port) throw new Error(`browser cdpUrl has no port: ${cdpUrl}`);
  return port;
}

// ── line framing (reader::read_until_capped + strip_trailing_crlf) ──────────

/**
 * Incremental `read_until_capped` with `\n` as the delimiter.
 *
 * `push(chunk)` returns `[{ bytes, truncated }]`: one entry per completed
 * line, `bytes` without the delimiter. A line that would exceed `maxBytes`
 * (delimiter included, like the Rust cap) is consumed through its newline
 * and reported `truncated: true` with a prefix — callers must drop it, never
 * forward it. `end()` flushes a final delimiter-less line, or the truncated
 * marker for a line that overflowed before EOF.
 */
class LineFramer {
  constructor(maxBytes = MAX_LINE_BYTES) {
    this.maxBytes = Math.max(1, Number(maxBytes));
    this.buffer = Buffer.alloc(0);
    this.truncating = false;
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const out = [];
    let start = 0;
    if (this.truncating) {
      const nl = bytes.indexOf(0x0a);
      if (nl === -1) return out;
      out.push({ bytes: Buffer.alloc(0), truncated: true });
      this.truncating = false;
      this.buffer = Buffer.alloc(0);
      start = nl + 1;
    }
    while (start < bytes.length) {
      const nl = bytes.indexOf(0x0a, start);
      if (nl === -1) {
        this.append(bytes.subarray(start));
        break;
      }
      const piece = bytes.subarray(start, nl);
      const room = this.maxBytes - this.buffer.length;
      if (nl - start + 1 > room) {
        const keep = Math.max(0, room);
        out.push({
          bytes: Buffer.concat([this.buffer, piece.subarray(0, keep)]),
          truncated: true,
        });
      } else {
        out.push({
          bytes: Buffer.concat([this.buffer, piece]),
          truncated: false,
        });
      }
      this.buffer = Buffer.alloc(0);
      start = nl + 1;
    }
    return out;
  }

  append(piece) {
    const room = this.maxBytes - this.buffer.length;
    if (piece.length > room) {
      if (room > 0) this.buffer = Buffer.concat([this.buffer, piece.subarray(0, room)]);
      this.truncating = true;
      return;
    }
    this.buffer = Buffer.concat([this.buffer, piece]);
  }

  end() {
    const out = [];
    if (this.truncating) {
      out.push({ bytes: Buffer.alloc(0), truncated: true });
      this.truncating = false;
      this.buffer = Buffer.alloc(0);
      return out;
    }
    if (this.buffer.length > 0) {
      out.push({ bytes: this.buffer, truncated: false });
      this.buffer = Buffer.alloc(0);
    }
    return out;
  }
}

// ── event journal (journal.rs) ──────────────────────────────────────────────

/**
 * `EventJournal`: bounded per-session ring, by entry count and total bytes.
 * `since(afterSeq)` is the `replay_events` wire shape (`headSeq`, `dropped`).
 */
class EventJournal {
  constructor(capacity = EVENT_JOURNAL_CAPACITY, maxBytes = EVENT_JOURNAL_MAX_BYTES) {
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.maxBytes = Math.max(1, Math.trunc(maxBytes));
    this.bytes = 0;
    this.nextSeq = 1;
    this.entries = [];
  }

  /** Append `text`, evicting oldest-first; returns the assigned seq. */
  push(text) {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.entries.push({ seq, text });
    while (
      this.entries.length > this.capacity ||
      (this.bytes > this.maxBytes && this.entries.length > 1)
    ) {
      const evicted = this.entries.shift();
      this.bytes -= Buffer.byteLength(evicted.text, 'utf8');
    }
    return seq;
  }

  since(afterSeq) {
    const cursor = Number.isFinite(Number(afterSeq)) ? Math.max(0, Math.trunc(Number(afterSeq))) : 0;
    const headSeq = this.nextSeq - 1;
    const oldest = this.entries.length > 0 ? this.entries[0].seq : null;
    const dropped = oldest === null ? cursor < headSeq : oldest > cursor + 1;
    const events = this.entries
      .filter((entry) => entry.seq > cursor)
      .map((entry) => ({ seq: entry.seq, text: entry.text }));
    return { events, headSeq, dropped };
  }
}

// ── stderr tail (reader.rs) ─────────────────────────────────────────────────

/**
 * `StderrTail`: newest stderr lines within 24 lines / 4096 bytes. An
 * oversized line is truncated on a char boundary rather than evicting
 * itself, so a refusal banner always has something to say.
 */
class StderrTail {
  constructor() {
    this.lines = [];
    this.bytes = 0;
  }

  push(line) {
    let kept = String(line);
    if (Buffer.byteLength(kept, 'utf8') > STDERR_TAIL_BYTES) {
      kept = prefixWithin(kept, STDERR_TAIL_BYTES);
    }
    this.bytes += Buffer.byteLength(kept, 'utf8');
    this.lines.push(kept);
    while (this.lines.length > STDERR_TAIL_LINES || this.bytes > STDERR_TAIL_BYTES) {
      if (this.lines.length === 0) break;
      const dropped = this.lines.shift();
      this.bytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  /** Blank-line-collapsed one-line reason, or null when nothing was said. */
  toReason() {
    return joinNonblank(this.lines, ' ');
  }
}

// ── exit-reason synthesis (reader::child_exit_reason) ───────────────────────

/** Unix signal names to the numbers omp's reason text uses. */
function signalNumber(signal) {
  if (typeof signal === 'number') return signal;
  const signals = os.constants.signals || {};
  return signals[signal] != null ? signals[signal] : signal;
}

function formatExitCode(code) {
  return `process exited with code ${code}`;
}

function withStderrTail(cause, stderr) {
  return stderr ? `${cause} (${stderr})` : cause;
}

/**
 * `reader::child_exit_reason`. `status` is `{ code, signal }` (Node's `close`
 * arguments) or null when unobservable. Empty string = clean exit; the
 * empty/non-empty split is the event contract.
 */
function childExitReason(status, stderr, sawFrame) {
  const cleaned = stderr == null ? null : String(stderr);
  const cleanOrUnseen = () => (sawFrame ? '' : cleaned || '');
  if (status == null) return cleanOrUnseen();
  const failed = status.signal != null || (status.code != null && status.code !== 0);
  if (!failed) return cleanOrUnseen();
  if (sawFrame) {
    if (status.signal != null) {
      return withStderrTail(`process killed by signal ${signalNumber(status.signal)}`, cleaned);
    }
    const cause = status.code == null ? 'process exited abnormally' : formatExitCode(status.code);
    return withStderrTail(cause, cleaned);
  }
  // Startup death: the banner is the whole reason.
  if (cleaned) return cleaned;
  return status.code == null ? 'process exited abnormally' : formatExitCode(status.code);
}

// ── approval prompt shape (approval.rs) ────────────────────────────────────

/** Mirrors omp's own tool-name grammar. */
function isValidToolName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (!/^[A-Za-z0-9]/.test(name)) return false;
  if (Buffer.byteLength(name, 'utf8') > 64) return false;
  return /^[A-Za-z0-9_.:-]+$/.test(name);
}

/** The first title line, with a CRLF terminator's `\r` dropped (not a lone `\r`). */
function firstTitleLine(title) {
  const nl = title.indexOf('\n');
  if (nl === -1) return title;
  const line = title.slice(0, nl);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** `approval::approval_tool_name`: the tool iff this is omp's exact prompt shape. */
function approvalToolName(frame) {
  if (frame === null || typeof frame !== 'object') return null;
  if (frame.type !== 'extension_ui_request') return null;
  if (frame.method !== 'select') return null;
  if (!Array.isArray(frame.options) || frame.options.length !== APPROVAL_OPTIONS.length) return null;
  for (let i = 0; i < APPROVAL_OPTIONS.length; i += 1) {
    if (frame.options[i] !== APPROVAL_OPTIONS[i]) return null;
  }
  if (typeof frame.title !== 'string') return null;
  const line = firstTitleLine(frame.title);
  if (!line.startsWith(TITLE_PREFIX)) return null;
  const name = line.slice(TITLE_PREFIX.length);
  return isValidToolName(name) ? name : null;
}

/** `approval::approval_request_id`. */
function approvalRequestId(frame) {
  if (frame === null || typeof frame !== 'object') return null;
  return typeof frame.id === 'string' ? frame.id : null;
}

/** `approval::approval_details`: the title after its first line, or null. */
function approvalDetails(frame) {
  if (frame === null || typeof frame !== 'object' || typeof frame.title !== 'string') return null;
  const nl = frame.title.indexOf('\n');
  if (nl === -1) return null;
  const details = frame.title.slice(nl + 1);
  return details.trim() === '' ? null : details;
}

// ── open approval prompts (agent/approvals.rs) ─────────────────────────────

/** `PendingApprovals`: `(request id, tool)` for prompts the human can still answer. */
class PendingApprovals {
  constructor(projectRoot = null) {
    this.projectRoot = projectRoot == null ? null : String(projectRoot);
    this.prompts = [];
  }

  /** Track a forwarded prompt, or forget one omp cancelled (`method: cancel`). */
  observe(frame) {
    const tool = approvalToolName(frame);
    if (tool !== null) {
      const id = approvalRequestId(frame);
      if (id === null) return;
      if (Buffer.byteLength(id, 'utf8') > MAX_ID_BYTES) return;
      this.track(id, tool);
      return;
    }
    if (frame !== null && typeof frame === 'object' && frame.method === 'cancel') {
      if (typeof frame.targetId === 'string') this.remove(frame.targetId);
    }
  }

  tool(id) {
    const found = this.prompts.find((prompt) => prompt.id === id);
    return found === undefined ? undefined : found.tool;
  }

  track(id, tool) {
    this.remove(id);
    if (this.prompts.length === MAX_PENDING) this.prompts.shift();
    this.prompts.push({ id, tool });
  }

  remove(id) {
    const at = this.prompts.findIndex((prompt) => prompt.id === id);
    if (at !== -1) this.prompts.splice(at, 1);
  }

  list() {
    return this.prompts.map((prompt) => ({ id: prompt.id, tool: prompt.tool }));
  }
}

/** `agent::approvals::observe` — only `extension_ui_request` frames are recorded. */
function observeApproval(pending, frameType, frame) {
  if (frameType !== 'extension_ui_request') return;
  pending.observe(frame);
}

/** `agent::approvals::answered_id`. */
function answeredId(command) {
  if (command === null || typeof command !== 'object') return null;
  if (command.type !== 'extension_ui_response') return null;
  return typeof command.id === 'string' ? command.id : null;
}

/** `agent::approvals::settle`. */
function settleApproval(pending, id) {
  pending.remove(id);
}

/** The answer that approves omp's prompt `requestId`. */
function approveAnswer(requestId) {
  return JSON.stringify({ type: 'extension_ui_response', id: requestId, value: 'Approve' });
}

// ── command validation (agent::validate_command_type) ──────────────────────

/**
 * Parse `trimmed` as JSON, require a string `type`, and check it against the
 * allowlist. Returns the parsed command or throws the Rust error text.
 */
function validateCommandType(trimmed) {
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('command is not valid JSON');
  }
  const type = parsed !== null && typeof parsed === 'object' ? parsed.type : undefined;
  if (typeof type !== 'string') throw new Error("command missing string 'type' field");
  if (!ALLOWED_COMMAND_TYPES.includes(type)) {
    throw new Error(`command type '${type}' is not allowed`);
  }
  return parsed;
}

// ── project rule book (approval.rs) ─────────────────────────────────────────

function canonicalProjectRoot(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return String(root);
  }
}

/** `approval::project_key` — first 32 hex chars of sha256(canonical root). */
function projectKey(root) {
  const canon = canonicalProjectRoot(root);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex').slice(0, 32);
}

/** `approval::now_iso8601` — UTC, second precision. */
function nowIso8601() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `approval::RuleBook`: session grants in memory, project grants persisted
 * under `<configRoot>/approval-rules/<key>.json` (same file shape:
 * `{ version, rules: [{ tool, granted_at }] }`). Without a `configRoot` the
 * project rules live for the process only, like `RuleBook::in_memory`.
 */
class ApprovalRuleBook {
  constructor(configRoot = null) {
    this.configRoot = configRoot == null ? null : String(configRoot);
    this.projectRules = new Map();
    this.sessionRules = new Map();
  }

  rulesPath(root) {
    const key = projectKey(root);
    return {
      key,
      file: this.configRoot === null ? null : path.join(this.configRoot, `${key}.json`),
    };
  }

  loadProjectRules(root) {
    const { key, file } = this.rulesPath(root);
    if (this.projectRules.has(key)) return this.projectRules.get(key);
    let rules = [];
    if (file !== null) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
          rules = parsed.rules
            .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.tool === 'string')
            .map((rule) => ({
              tool: rule.tool,
              scope: 'project',
              grantedAt: typeof rule.granted_at === 'string' ? rule.granted_at : '',
            }));
        }
      } catch {
        // Missing or corrupt: no rules. (Rust consults its snapshot ring for
        // the corrupt case; that store is a separate port.)
        rules = [];
      }
    }
    this.projectRules.set(key, rules);
    return rules;
  }

  persistProjectRules(root, rules) {
    const { key, file } = this.rulesPath(root);
    if (file === null) {
      this.projectRules.set(key, rules);
      return;
    }
    const body = {
      version: RULES_FILE_VERSION,
      rules: rules.map((rule) => ({ tool: rule.tool, granted_at: rule.grantedAt })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // json_store::write_atomic: write a sibling temp file, then rename.
    const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temp, JSON.stringify(body, null, 2), { mode: 0o600 });
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Already gone.
      }
      throw error;
    }
    // Only after the write succeeded, like `mutate_project_rules`.
    this.projectRules.set(key, rules);
  }

  mutateProjectRules(root, mutate) {
    const rules = this.loadProjectRules(root).map((rule) => ({ ...rule }));
    mutate(rules);
    this.persistProjectRules(root, rules);
  }

  /** `RuleBook::grant` — `scope` is `"session"` or `"project"`. */
  grant(sessionId, projectRoot, tool, scope) {
    if (!isValidToolName(tool)) throw new Error(`'${tool}' is not a valid tool name`);
    if (scope === 'session') {
      if (!this.sessionRules.has(sessionId)) this.sessionRules.set(sessionId, new Set());
      this.sessionRules.get(sessionId).add(tool);
      return;
    }
    if (projectRoot == null) throw new Error('project-scoped grant requires a project root');
    this.mutateProjectRules(projectRoot, (rules) => {
      if (!rules.some((rule) => rule.tool === tool)) {
        rules.push({ tool, scope: 'project', grantedAt: nowIso8601() });
      }
    });
  }

  /** `RuleBook::revoke` — no-op (not an error) when nothing was granted. */
  revoke(sessionId, projectRoot, tool, scope) {
    if (scope === 'session') {
      const set = this.sessionRules.get(sessionId);
      if (set) set.delete(tool);
      return;
    }
    if (projectRoot == null) throw new Error('project-scoped revoke requires a project root');
    this.mutateProjectRules(projectRoot, (rules) => {
      for (let i = rules.length - 1; i >= 0; i -= 1) {
        if (rules[i].tool === tool) rules.splice(i, 1);
      }
    });
  }

  /** `RuleBook::list` — session-scoped first (tool-sorted), then project. */
  list(sessionId, projectRoot) {
    const out = [];
    const set = this.sessionRules.get(sessionId);
    if (set) {
      for (const tool of Array.from(set).sort()) {
        out.push({ tool, scope: 'session', grantedAt: '' });
      }
    }
    if (projectRoot != null) {
      out.push(...this.loadProjectRules(projectRoot).map((rule) => ({ ...rule })));
    }
    return out;
  }

  /** `RuleBook::is_granted`. */
  isGranted(sessionId, projectRoot, tool) {
    const set = this.sessionRules.get(sessionId);
    if (set && set.has(tool)) return true;
    if (projectRoot != null) {
      return this.loadProjectRules(projectRoot).some((rule) => rule.tool === tool);
    }
    return false;
  }

  /** `RuleBook::clear_session`. */
  clearSession(sessionId) {
    this.sessionRules.delete(sessionId);
  }
}

// ── spawn waiting ──────────────────────────────────────────────────────────

/** Resolve once the child is spawned, reject on the pre-spawn error event. */
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** Write `line + "\n"` to `stdin`, rejecting if the pipe is gone. */
function writeLine(stdin, line) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(error && error.message ? error.message : String(error)));
    };
    stdin.once('error', onError);
    try {
      stdin.write(`${line}\n`, (error) => {
        if (settled) return;
        settled = true;
        stdin.removeListener('error', onError);
        if (error) reject(new Error(error.message));
        else resolve();
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        stdin.removeListener('error', onError);
        reject(new Error(error && error.message ? error.message : String(error)));
      }
    }
  });
}

// ── the bridge ─────────────────────────────────────────────────────────────

/** Version checks that already passed, keyed by absolute binary path. */
const versionOk = new Set();

/**
 * One omp process per tab session, with a bounded replay journal, open
 * approval prompts and model-rule grants.
 *
 * `new AgentBridge(opts)`:
 *  - `pathDirs`       — override the trusted PATH search (tests).
 *  - `ruleBook`       — an ApprovalRuleBook-compatible object to share.
 *  - `configRoot`     — where a default rule book persists project grants.
 *  - `overlayDir`     — where a `browserPort` overlay file is written.
 *  - `journalCapacity` / `journalMaxBytes` — ring bounds (tests).
 *  - `versionCheck`   — set false to skip `omp --version` (default: check).
 *  - `debug`          — log stderr passthrough like the Rust reader.
 */
class AgentBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessions = new Map();
    this.lastErrors = new Map();
    this.nextGen = 1;
    this.pathDirs = Array.isArray(opts.pathDirs) ? opts.pathDirs.slice() : null;
    this.ruleBook = opts.ruleBook || new ApprovalRuleBook(opts.configRoot ?? null);
    this.overlayDir =
      opts.overlayDir || path.join(os.tmpdir(), `omp-desktop-electron-${process.pid}`);
    this.journalCapacity = opts.journalCapacity ?? EVENT_JOURNAL_CAPACITY;
    this.journalMaxBytes = opts.journalMaxBytes ?? EVENT_JOURNAL_MAX_BYTES;
    this.versionCheck = opts.versionCheck !== false;
    this.debug = opts.debug === true;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * `start_session`. `args` is the frontend's StartSessionArgs
   * (`{sessionId, cwd, resume, profile}`), optionally wrapped as
   * `{args: {…}}`; also accepts `approvalMode`/`mode`, `config`, or
   * `browserPort`/`cdpUrl`. Returns the resolved approval mode (the Rust
   * command's `"write"` reply). Idempotent on a live session.
   */
  async startSession(input) {
    const args = input && typeof input === 'object' && input.args !== undefined ? input.args : input;
    if (args === null || typeof args !== 'object' || typeof args.sessionId !== 'string') {
      throw new Error('start_session requires sessionId');
    }
    const sessionId = args.sessionId;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing.mode;

    const mode = parseApprovalMode(args.approvalMode ?? args.mode ?? 'write');
    const profile = isDefaultProfile(args.profile) ? null : String(args.profile);
    const resume = args.resume == null || args.resume === '' ? null : String(args.resume);
    const cwd =
      typeof args.cwd === 'string' && args.cwd !== '' ? resolveCwd(args.cwd) : null;
    let config = null;
    try {
      config = this.overlayFor(sessionId, args);
    } catch (error) {
      this.cacheError(sessionId, `browser overlay: ${error.message}`);
      throw new Error(`browser overlay: ${error.message}`);
    }

    let omp;
    try {
      omp = this.locateOmp();
      if (this.versionCheck) this.checkOmpVersion(omp);
    } catch (error) {
      this.cacheError(sessionId, error.message);
      throw error;
    }

    const argv = ompArgs({ profile, resume, cwd, mode, config });
    const env = { ...process.env, PATH: omp.path };
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;

    let child;
    try {
      child = spawn(omp.binary, argv, {
        cwd: cwd === null ? undefined : cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group (supervisor::prepare → process_group(0)).
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      await waitForSpawn(child);
    } catch (error) {
      const message = `failed to spawn ${omp.binary}: ${error.message}`;
      this.cacheError(sessionId, message);
      throw new Error(message);
    }
    // A pipe error must never take the process down; writeLine observes the
    // specific failure it cares about.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const entry = {
      gen: this.nextGen,
      mode,
      stdin: child.stdin,
      child,
      journal: new EventJournal(this.journalCapacity, this.journalMaxBytes),
      approvals: new PendingApprovals(cwd),
      projectRoot: cwd,
      alive: { value: true },
      stderrTail: new StderrTail(),
      closed: new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
      stderrDone: null,
    };
    this.nextGen += 1;

    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, entry);
    if (prev !== undefined) {
      // Clear liveness before releasing the map, exactly like the Rust
      // critical section: a straggler frame must go mute immediately.
      prev.alive.value = false;
      // A session id being replaced drops its previous occupant's grants:
      // they were consent for a process that is gone.
      this.ruleBook.clearSession(sessionId);
      void this.reap(prev);
    }
    this.lastErrors.delete(sessionId);

    entry.stderrDone = this.runStderrReader(entry, sessionId);
    entry.readerDone = this.runStdoutReader(entry, sessionId);
    return mode;
  }

  /** `send_command` — one JSON line on omp's stdin, allowlisted by `type`. */
  async sendCommand(sessionId, json) {
    const line = String(json).replace(/[\r\n]+$/, '');
    const command = validateCommandType(line);
    const answered = answeredId(command);
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error(this.lastErrors.get(sessionId) || `session '${sessionId}' not found`);
    }
    if (!entry.stdin) throw new Error('agent not running');
    await writeLine(entry.stdin, line);
    if (answered !== null) settleApproval(entry.approvals, answered);
  }

  /** `stop_session` — kill the process tree, drop session grants and errors. */
  stopSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry !== undefined) {
      this.sessions.delete(sessionId);
      entry.alive.value = false;
    }
    this.ruleBook.clearSession(sessionId);
    this.lastErrors.delete(sessionId);
    return entry === undefined ? Promise.resolve() : this.reap(entry);
  }

  /** `replay_events` — `{events, headSeq, dropped}` for events after `afterSeq`. */
  replayEvents(sessionId, afterSeq = 0) {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) throw new Error(`session '${sessionId}' not found`);
    return entry.journal.since(afterSeq);
  }

  /** `session_status` — the cached spawn/startup error, or null. */
  sessionStatus(sessionId) {
    return this.lastErrors.get(sessionId) ?? null;
  }

  /** Whether a live session exists under this id (Rust `is_alive`). */
  isAlive(sessionId) {
    return this.sessions.has(sessionId);
  }

  /** Open approval prompts of a session, oldest first. */
  pendingApprovals(sessionId) {
    const entry = this.sessions.get(sessionId);
    return entry === undefined ? [] : entry.approvals.list();
  }

  /**
   * `approval_approve_and_grant`: answer the open prompt `requestId` with
   * "Approve" and grant standing approval for its tool. Returns null when
   * answered and granted, a reason string when answered but not saved, and
   * throws (nothing written, prompt kept) for an unknown/ended prompt.
   */
  async approveAndGrant(sessionId, requestId, scope) {
    const ruleScope = parseRuleScope(scope);
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) throw new Error(`session '${sessionId}' not found`);
    if (!entry.stdin) throw new Error('agent not running');
    const open = entry.approvals;
    const tool = open.tool(requestId);
    if (tool === undefined) {
      throw new Error(`session '${sessionId}' has no open approval prompt '${requestId}'`);
    }
    let root = null;
    if (ruleScope === 'project') {
      if (entry.projectRoot == null) {
        throw new Error('project-scoped grant requires a project root');
      }
      root = entry.projectRoot;
    }
    open.remove(requestId);
    try {
      await writeLine(entry.stdin, approveAnswer(requestId));
    } catch (error) {
      open.track(requestId, tool);
      throw error;
    }
    const ended = () => new Error(`session '${sessionId}' ended before the grant was saved`);
    if (ruleScope === 'session') {
      const current = this.sessions.get(sessionId);
      if (current === undefined || current.approvals !== open) throw ended();
      this.ruleBook.grant(sessionId, null, tool, 'session');
      return null;
    }
    try {
      this.ruleBook.grant(sessionId, root, tool, 'project');
      return null;
    } catch (error) {
      return error.message;
    }
  }

  /** `approval_rules_list`. */
  listRules(sessionId, projectRoot = null) {
    return this.ruleBook.list(sessionId, projectRoot);
  }

  /** Grant a rule directly (the UI only grants through `approveAndGrant`). */
  grantRule({ sessionId, projectRoot = null, tool, scope }) {
    this.ruleBook.grant(sessionId, projectRoot, tool, parseRuleScope(scope));
  }

  /** `approval_rules_revoke`. */
  revokeRule({ sessionId, projectRoot = null, tool, scope }) {
    this.ruleBook.revoke(sessionId, projectRoot, tool, parseRuleScope(scope));
  }

  /** Kill and reap every session (app exit / relaunch). Idempotent. */
  async shutdownAll() {
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const entry of entries) entry.alive.value = false;
    await Promise.all(entries.map((entry) => this.reap(entry)));
  }

  /** Alias for {@link shutdownAll}. */
  dispose() {
    return this.shutdownAll();
  }

  // ── internals ────────────────────────────────────────────────────────────

  cacheError(sessionId, message) {
    this.lastErrors.set(sessionId, message);
  }

  locateOmp() {
    return locateProgram(this.pathDirs === null ? childPathDirs() : this.pathDirs, 'omp');
  }

  /** `spawn::check_omp_version` — refusals cached only for the failing path. */
  checkOmpVersion(omp) {
    if (versionOk.has(omp.binary)) return;
    const env = { ...process.env, PATH: omp.path };
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    const result = spawnSync(omp.binary, ['--version'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) {
      // Can't run it at all: stand aside, the real spawn reports why.
      if (this.debug) {
        process.stderr.write(`[omp-desktop] version check skipped: ${result.error.message}\n`);
      }
      return;
    }
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const refusal = versionRefusal(output);
    if (refusal !== null) throw new Error(refusal);
    versionOk.add(omp.binary);
  }

  /** The `--config=<path>` overlay (browser.rs), or null when unavailable. */
  overlayFor(sessionId, args) {
    if (args.config != null) return String(args.config);
    let port = null;
    if (args.browserPort != null) port = args.browserPort;
    else if (args.cdpUrl != null) port = cdpPort(args.cdpUrl);
    if (port == null) return null;
    ensurePrivateDir(this.overlayDir);
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'session';
    const file = path.join(this.overlayDir, `${safe}.yml`);
    writePrivateFile(file, overlayContent(port));
    return file;
  }

  /** SIGKILL the whole process group, then reap the direct child. */
  reap(entry) {
    const { child } = entry;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // ESRCH (already gone) or a process not (yet) a group leader.
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }
    return entry.closed.catch(() => {});
  }

  /** `reader::spawn_stderr_reader`: keep the newest lines in the bounded tail. */
  async runStderrReader(entry, sessionId) {
    const framer = new LineFramer(Number.MAX_SAFE_INTEGER);
    const push = (bytes) => {
      const line = stripTrailingCRLF(bytes).toString('utf8');
      if (this.debug) process.stderr.write(`[omp/${sessionId}] ${line}\n`);
      entry.stderrTail.push(line);
    };
    try {
      for await (const chunk of entry.child.stderr) {
        for (const line of framer.push(chunk)) push(line.bytes);
      }
      for (const line of framer.end()) push(line.bytes);
    } catch {
      // A stderr read error leaves the tail as far as it got.
    }
  }

  /**
   * `reader::spawn_stdout_reader`: frame stdout, redact, journal, auto-answer
   * granted prompts, emit, then settle the exit reason and announce.
   */
  async runStdoutReader(entry, sessionId) {
    const framer = new LineFramer(MAX_LINE_BYTES);
    let sawFrame = false;
    let exitReason = '';

    const processFrames = (frames) => {
      for (const frame of frames) {
        if (frame.truncated) {
          process.stderr.write(
            `[omp/${sessionId}] dropped a stdout line that exceeded ${MAX_LINE_BYTES} bytes; ` +
              'frontend will not see this RPC message\n',
          );
          continue;
        }
        const stripped = stripTrailingCRLF(frame.bytes);
        if (stripped.length === 0) continue;
        const { text, parsed } = sanitizeLine(stripped);
        if (parsed !== null) sawFrame = true;
        const frameType =
          parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string'
            ? parsed.type
            : undefined;
        let shared = text;
        if (parsed !== null) {
          const notice = this.autoApproveOrTrack(entry, sessionId, parsed, frameType);
          if (notice !== null) shared = notice;
        }
        const seq = entry.journal.push(shared);
        if (entry.alive.value) this.emit('line', sessionId, { seq, text: shared });
      }
    };

    try {
      for await (const chunk of entry.child.stdout) processFrames(framer.push(chunk));
      processFrames(framer.end());
    } catch (error) {
      exitReason = `stdout read error: ${error.message}`;
    }

    if (exitReason === '') {
      const status = await entry.closed;
      await entry.stderrDone;
      exitReason = childExitReason(status, entry.stderrTail.toReason(), sawFrame);
    }
    this.retireAndAnnounce(entry, sessionId, exitReason);
  }

  /**
   * `reader::auto_approve_or_track`: a rule-covered prompt is answered on
   * stdin and replaced by a `desktop_auto_approval` notice; everything else
   * is shown to `approvals` and forwarded as is.
   */
  autoApproveOrTrack(entry, sessionId, frame, frameType) {
    const tool = approvalToolName(frame);
    if (tool !== null && this.ruleBook.isGranted(sessionId, entry.projectRoot, tool)) {
      const id = approvalRequestId(frame);
      if (id !== null && entry.stdin) {
        try {
          entry.stdin.write(`${JSON.stringify({
            type: 'extension_ui_response',
            id,
            value: 'Approve',
          })}\n`);
        } catch {
          // A dead pipe leaves the prompt unanswered; omp ends the turn.
        }
      }
      return JSON.stringify({
        type: 'desktop_auto_approval',
        tool,
        details: approvalDetails(frame),
      });
    }
    observeApproval(entry.approvals, frameType, frame);
    return null;
  }

  /**
   * `reader::retire_and_announce`: give up this incarnation's entry in the
   * same critical section that decides whether to announce (JS is
   * single-threaded, so this is atomic), record a non-empty reason, emit.
   */
  retireAndAnnounce(entry, sessionId, exitReason) {
    let announce = false;
    const current = this.sessions.get(sessionId);
    if (current === undefined) {
      announce = entry.alive.value;
    } else if (current.gen === entry.gen) {
      this.sessions.delete(sessionId);
      entry.alive.value = false;
      announce = true;
    }
    if (!announce) return;
    if (exitReason !== '') this.lastErrors.set(sessionId, exitReason);
    this.emit('exit', sessionId, exitReason);
  }
}

module.exports = {
  AgentBridge,
  ApprovalRuleBook,
  EventJournal,
  LineFramer,
  PendingApprovals,
  StderrTail,
  ALLOWED_COMMAND_TYPES,
  APPROVAL_MODE_FLAGS,
  EVENT_JOURNAL_CAPACITY,
  EVENT_JOURNAL_MAX_BYTES,
  MAX_LINE_BYTES,
  MAX_PENDING,
  MAX_ID_BYTES,
  MIN_OMP_VERSION,
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
  STDERR_TAIL_BYTES,
  STDERR_TAIL_LINES,
  approvalDetails,
  approvalRequestId,
  approvalToolName,
  approveAnswer,
  answeredId,
  childExitReason,
  childPathDirs,
  isCredentialKey,
  joinNonblank,
  locateProgram,
  nowIso8601,
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
};