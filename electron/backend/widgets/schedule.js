/* electron/backend/widgets/schedule.js — pure scheduler for rail widget plugin
   runs: decides which plugin runs when, for which tab, and what happens to its
   result. Ports src-tauri/src/widgets/schedule.rs (with the matching gates from
   config.rs). No threads, no IO, no clock: the host feeds events with the
   current epoch ms and executes the returned actions (spawn, kill, notify).

   Model: one run per (tab session or GLOBAL_KEY) × plugin with at most one
   coalesced follow-up; at most MAX_CONCURRENT_RUNS processes, the rest wait in
   FIFO order; nothing starts unless the plugin is enabled, approved, not
   hidden, the rail is visible and the plugin matches the session's project.
   Runnable sets are 64-bit masks indexed like the config's plugin list.

   Usage:

     const s = createScheduler({ now: () => Date.now(), startRun });
     const actions = s.handle({ type: 'config', plugins, approved });
     s.handle({ type: 'view', view: { session, railVisible, windowVisible, hidden } });
     ...
     const at = s.nextDeadline();          // then wake up and send { type: 'tick' }
     s.handle({ type: 'finished', key, seq, outcome });

   Deliberate deviations from Rust:
   - Runnable masks are BigInt: JS bitwise operators are 32-bit, and the Rust
     masks are u64 (`bit(63)`, `bits(1 << 63)` are pinned by its tests).
   - Plugin descriptors are normalised once, when the `config` event arrives:
     canonical fields are camelCase (`matchPath`, `matchRemote`, `intervalMs`,
     `timeoutMs`); the snake_case names of the Rust struct are accepted too.
     `intervalMs <= 0` means "no interval" (as in config.rs). Descriptors are
     copied, so later mutation of the host's objects is not observed — send a
     new `config` event instead, exactly like the Rust host.
   - Outcomes are normalised to `{ ok, value, error, durationMs }` on the way
     in. `{ result: { ok, value|error }, duration_ms }` (the Rust shape) is
     accepted as well.
   - Options may carry `startRun`/`killRun`/`onChanged`/`onRemoved` hooks; they
     run after the whole action list is computed and the state is consistent.
     The actions are always returned too.
   - Event types accept snake_case and the Rust CamelCase spelling
     (`session_opened` / `SessionOpened`).
*/

'use strict';

/** Pseudo-session that keys the one shared result of a `global` plugin. */
const GLOBAL_KEY = '__global__';
/** At most this many plugin processes run at once; the rest wait in FIFO. */
const MAX_CONCURRENT_RUNS = 4;
/** Plugins past this index are never scheduled: runnable sets are 64-bit. */
const MAX_SCHEDULED = 64;

/** Why a run was started; passed to the plugin as OMP_WIDGET_TRIGGER. */
const TRIGGER = Object.freeze({
  ACTIVATE: 'activate',
  TURN_END: 'turn_end',
  BRANCH: 'branch',
  MANUAL: 'manual',
  INTERVAL: 'interval',
});

const PHASE = Object.freeze({
  IDLE: 'idle',
  /** Queued for a concurrency slot. */
  WAITING: 'waiting',
  RUNNING: 'running',
});

const ACTION = Object.freeze({
  START: 'start',
  KILL: 'kill',
  /** The run state of `key` changed. */
  CHANGED: 'changed',
  /** The run state of `key` was dropped. */
  REMOVED: 'removed',
});

const EVENT = Object.freeze({
  CONFIG: 'config',
  VIEW: 'view',
  SESSION_OPENED: 'session_opened',
  SESSION_CLOSED: 'session_closed',
  TURN_END: 'turn_end',
  BRANCH: 'branch',
  MANUAL: 'manual',
  FINISHED: 'finished',
  TICK: 'tick',
});

/** Separator for the composite run-map key; plugin ids are `[a-z0-9-]{1,32}`. */
const KEY_SEP = '\u0000';

// ── small numeric / path helpers ────────────────────────────────────────────

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** u64 saturating add, bounded to the safe-integer range anyway. */
function satAdd(a, b) {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

/** u64 saturating sub. */
function satSub(a, b) {
  return a > b ? a - b : 0;
}

function isSep(ch) {
  return ch === '/' || ch === '\\';
}

function trimSeps(s) {
  let end = s.length;
  while (end > 0 && isSep(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

/**
 * Directory-prefix match on separator boundaries: `/a/b` matches `/a/b` and
 * `/a/b/c`, never `/a/bc`; `\` and `/` are equivalent. A prefix of only
 * separators (`/`, `\`, `//`) matches every absolute path; an empty prefix
 * matches nothing here (`pluginMatches` short-circuits it to "matches all").
 */
function pathMatches(prefix, project) {
  const rawPrefix = String(prefix ?? '');
  const rawProject = String(project ?? '');
  const a = trimSeps(rawPrefix);
  const b = trimSeps(rawProject);
  if (a.length === 0) {
    // `prefix` was only separators: the root matches any absolute path.
    return rawPrefix.length > 0 && rawProject.length > 0 && isSep(rawProject[0]);
  }
  if (b.length < a.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i] && !(isSep(a[i]) && isSep(b[i]))) return false;
  }
  return b.length === a.length || isSep(b[a.length]);
}

/**
 * Whether the plugin applies to a tab with this project path and remote:
 * `matchPath` is a directory prefix (empty matches every project),
 * `matchRemote` a substring of the remote URL. Both must hold when given.
 */
function pluginMatches(plugin, project, remote) {
  const prefix = plugin.matchPath;
  if (prefix != null && prefix !== '' && !pathMatches(prefix, project)) return false;
  const needle = plugin.matchRemote;
  if (needle != null && !String(remote ?? '').includes(String(needle))) return false;
  return true;
}

/**
 * Whether `trigger` may start this plugin: `manual` always, `interval` exactly
 * when `intervalMs` is set, the rest per the plugin's `triggers` list.
 */
function pluginWants(plugin, trigger) {
  if (trigger === TRIGGER.MANUAL) return true;
  if (trigger === TRIGGER.INTERVAL) return plugin.intervalMs != null;
  return plugin.triggers.includes(trigger);
}

// ── trigger / key / descriptor normalisation ────────────────────────────────

const TRIGGER_ALIASES = new Map([
  ['activate', TRIGGER.ACTIVATE],
  ['turnend', TRIGGER.TURN_END],
  ['branch', TRIGGER.BRANCH],
  ['manual', TRIGGER.MANUAL],
  ['interval', TRIGGER.INTERVAL],
]);

/** `turn_end`, `TurnEnd`, `turn-end` all read as `turn_end`. */
function normalizeTriggerName(name) {
  if (typeof name !== 'string') return null;
  return TRIGGER_ALIASES.get(name.replace(/[_\-\s]/g, '').toLowerCase()) ?? null;
}

/** Normalises one event's `type` to a compact lower-case spelling. */
function normalizeEventType(type) {
  return typeof type === 'string' ? type.replace(/[_\-\s]/g, '').toLowerCase() : '';
}

/**
 * One plugin descriptor. Canonical (camelCase) fields; snake_case accepted.
 * `title`, `command` and `timeoutMs` are carried through for the run slice but
 * the scheduler itself never reads them.
 */
function normalizePlugin(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id ?? '');
  const triggers = [];
  const listed = Array.isArray(src.triggers) ? src.triggers : [];
  for (const name of listed) {
    const trigger = normalizeTriggerName(name);
    // `manual`/`interval` are not config triggers; pluginWants handles them.
    if (
      (trigger === TRIGGER.ACTIVATE || trigger === TRIGGER.TURN_END || trigger === TRIGGER.BRANCH) &&
      !triggers.includes(trigger)
    ) {
      triggers.push(trigger);
    }
  }
  const intervalRaw = src.intervalMs ?? src.interval_ms;
  const intervalMs =
    typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : null;
  const scope = String(src.scope ?? 'tab').toLowerCase() === 'global' ? 'global' : 'tab';
  return {
    id,
    title: String(src.title ?? id),
    command: Array.isArray(src.command) ? src.command.map(String) : [],
    matchPath: src.matchPath ?? src.match_path ?? null,
    matchRemote: src.matchRemote ?? src.match_remote ?? null,
    triggers,
    timeoutMs: numberOr(src.timeoutMs ?? src.timeout_ms, 0),
    intervalMs,
    enabled: src.enabled !== false,
    scope,
  };
}

/** `{ scopeKey, pluginId }`; snake_case accepted on inbound events. */
function normalizeKey(key) {
  if (!key || typeof key !== 'object') return null;
  const scopeKey = key.scopeKey ?? key.scope_key;
  const pluginId = key.pluginId ?? key.plugin_id;
  if (scopeKey == null || pluginId == null) return null;
  return { scopeKey: String(scopeKey), pluginId: String(pluginId) };
}

function runKey(scopeKey, pluginId) {
  return { scopeKey: String(scopeKey), pluginId: String(pluginId) };
}

function keyId(key) {
  return `${key.scopeKey}${KEY_SEP}${key.pluginId}`;
}

/** The key a run of `plugin` uses in `session` (`global` ignores the tab). */
function keyFor(plugin, session) {
  return runKey(plugin.scope === 'global' ? GLOBAL_KEY : session, plugin.id);
}

function normalizeCtx(raw) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  return {
    project: String(ctx.project ?? ''),
    branch: String(ctx.branch ?? ''),
    remote: String(ctx.remote ?? ''),
  };
}

function normalizeView(raw) {
  const view = raw && typeof raw === 'object' ? raw : {};
  const hiddenRaw = view.hidden;
  let hidden;
  if (hiddenRaw instanceof Set) hidden = new Set(hiddenRaw);
  else if (Array.isArray(hiddenRaw)) hidden = new Set(hiddenRaw);
  else hidden = new Set();
  return {
    session: view.session == null ? null : String(view.session),
    railVisible: Boolean(view.railVisible ?? view.rail_visible ?? false),
    windowVisible: Boolean(view.windowVisible ?? view.window_visible ?? false),
    hidden,
  };
}

/**
 * `{ ok, value, error, durationMs }`. Accepts the canonical shape, the Rust
 * `{ result: { ok, value|error }, duration_ms }` shape, and a bare result
 * string.
 */
function normalizeOutcome(raw) {
  const durationMs = numberOr(raw && (raw.durationMs ?? raw.duration_ms), 0);
  if (raw && typeof raw === 'object') {
    if (typeof raw.ok === 'boolean') {
      if (raw.ok) {
        return { ok: true, value: raw.value == null ? '' : String(raw.value), error: null, durationMs };
      }
      return { ok: false, value: null, error: String(raw.error ?? ''), durationMs };
    }
    const result = raw.result;
    if (typeof result === 'string') {
      return { ok: true, value: result, error: null, durationMs };
    }
    if (result && typeof result === 'object') {
      if (result.ok === false || (result.ok === undefined && 'error' in result)) {
        return { ok: false, value: null, error: String(result.error ?? ''), durationMs };
      }
      return {
        ok: true,
        value: result.value == null ? '' : String(result.value),
        error: null,
        durationMs,
      };
    }
  }
  return { ok: false, value: null, error: 'malformed outcome', durationMs };
}

// ── mask / timer / queue math ───────────────────────────────────────────────

/** One bit of a runnable set; 0n past the schedulable range. */
function bit(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SCHEDULED) return 0n;
  return 1n << BigInt(index);
}

/** Indices of the set bits, lowest first (Rust `bits`). */
function bits(mask) {
  let rest = typeof mask === 'bigint' ? mask : BigInt(Math.trunc(mask) || 0);
  const out = [];
  while (rest > 0n) {
    const low = rest & -rest;
    out.push(low.toString(2).length - 1);
    rest &= rest - 1n;
  }
  return out;
}

/**
 * Whether an interval plugin is due: never finished (and not in flight), or
 * its last run finished at least `interval` ago. A run in flight is fresh.
 */
function dueNow(run, interval, now) {
  if (!run) return true;
  if (run.phase !== PHASE.IDLE) return false;
  if (!run.last) return true;
  return satSub(now, run.last.at) >= interval;
}

/** Re-arms plugin `index`'s interval timer one interval from `now`. */
function rearm(timers, index, plugin, now) {
  if (index < 0 || index >= timers.length || plugin.intervalMs == null) return;
  timers[index] = satAdd(now, plugin.intervalMs);
}

/** A clock that jumped back must not push a timer further away than one interval. */
function clampTimerDue(due, interval, now) {
  if (due == null || interval == null) return due;
  return Math.min(due, satAdd(now, interval));
}

/**
 * Whether a plugin gets an interval timer: tab timers only exist while a tab
 * is active; global ones always do (they re-check the active tab's match).
 */
function timerWanted(plugin, approved, hasActive) {
  return (
    plugin.intervalMs != null &&
    plugin.enabled &&
    approved &&
    (plugin.scope === 'global' || hasActive)
  );
}

/** `{ index, plugin }` of `id` in the config; first entry wins on duplicates. */
function configGet(cfg, id) {
  const index = cfg.index.get(id);
  if (index === undefined) return null;
  const plugin = cfg.plugins[index];
  return plugin ? { index, plugin } : null;
}

function idleState() {
  return {
    phase: PHASE.IDLE,
    /** Identifies the current run; unique across the scheduler. */
    seq: 0,
    /** Trigger of the run in flight, or of the last finished run. */
    trigger: null,
    /** Coalesced follow-up (at most one). */
    queued: null,
    /** Last finished run; kept while a new one runs so the card can dim it. */
    last: null,
    lastOkAt: null,
  };
}

// ── scheduler ───────────────────────────────────────────────────────────────

class Scheduler {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.startRun = typeof opts.startRun === 'function' ? opts.startRun : null;
    this.killRun = typeof opts.killRun === 'function' ? opts.killRun : null;
    this.onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : null;
    this.onRemoved = typeof opts.onRemoved === 'function' ? opts.onRemoved : null;

    /** Normalised descriptors plus id → index and the approved id set. */
    this.cfg = { plugins: [], index: new Map(), approved: new Set() };
    /** As last reported; `session` may name a session not opened yet. */
    this.view = { session: null, railVisible: false, windowVisible: false, hidden: new Set() };
    /** The effective active session: `view.session` once it is known. */
    this.active = null;
    /** session id → { ctx, dirty: Map<pluginId, trigger>, lastBranch }. */
    this.sessions = new Map();
    /** keyId → { key, state }. */
    this.runs = new Map();
    /** FIFO of waiting keys; entries whose state is gone are skipped. */
    this.waiting = [];
    this.running = 0;
    this.lastSeq = 0;
    /** Next interval deadline per plugin index (aligned with cfg.plugins). */
    this.timers = [];
    /** Plugins runnable for `active` as of the last refresh. */
    this.activeMask = 0n;
    /** `windowVisible && railVisible` as of the last refresh. */
    this.live = false;
  }

  // ── public surface ───────────────────────────────────────────────────────

  /**
   * Feeds one event and returns the actions the host must execute. `nowMs`
   * defaults to the injected clock.
   */
  handle(event, nowMs) {
    const now = numberOr(nowMs, numberOr(this.clock(), 0));
    const ev = event && typeof event === 'object' ? event : {};
    const actions = [];
    this.clampTimers(now);
    switch (normalizeEventType(ev.type)) {
      case 'config':
        this.setConfig(ev.plugins ?? [], ev.approved ?? [], now, actions);
        break;
      case 'view':
        this.view = normalizeView(ev.view != null ? ev.view : ev);
        this.refresh(now, actions);
        break;
      case 'sessionopened': {
        const session = String(ev.session ?? '');
        const ctx = normalizeCtx(ev.ctx);
        const known = this.sessions.get(session);
        if (known) {
          known.ctx = ctx;
        } else {
          // The first branch seen is only recorded, never fired.
          this.sessions.set(session, {
            ctx,
            dirty: new Map(),
            lastBranch: ctx.branch === '' ? null : ctx.branch,
          });
        }
        this.refresh(now, actions);
        break;
      }
      case 'sessionclosed':
        this.close(String(ev.session ?? ''), now, actions);
        break;
      case 'turnend':
        this.fire(String(ev.session ?? ''), TRIGGER.TURN_END, actions);
        break;
      case 'branch': {
        const session = String(ev.session ?? '');
        const branch = String(ev.branch ?? '');
        const sess = this.sessions.get(session);
        if (!sess) break;
        const changed = sess.lastBranch != null && sess.lastBranch !== branch;
        sess.lastBranch = branch;
        if (changed) this.fire(session, TRIGGER.BRANCH, actions);
        break;
      }
      case 'manual':
        this.manual(String(ev.pluginId ?? ev.plugin_id ?? ''), actions);
        break;
      case 'finished': {
        const key = normalizeKey(ev.key);
        if (!key) break;
        this.finished(key, numberOr(ev.seq, -1), normalizeOutcome(ev.outcome), now, actions);
        break;
      }
      case 'tick':
        this.tick(now, actions);
        break;
      default:
        break;
    }
    this.dispatch(actions);
    return actions;
  }

  /** Earliest interval deadline; the host sends a `tick` once its clock reaches it. */
  nextDeadline() {
    let earliest = null;
    for (const due of this.timers) {
      if (due == null) continue;
      if (earliest == null || due < earliest) earliest = due;
    }
    return earliest;
  }

  /** Run state of `key`, or null when it never ran. */
  run(key) {
    const normal = normalizeKey(key);
    return normal == null ? null : this.runState(normal);
  }

  /** Context of a known session, or null. */
  sessionCtx(session) {
    const sess = this.sessions.get(String(session));
    return sess ? { ...sess.ctx } : null;
  }

  /** Descriptor of a configured plugin, or null. */
  plugin(id) {
    const found = configGet(this.cfg, String(id));
    return found ? { ...found.plugin, triggers: [...found.plugin.triggers] } : null;
  }

  /**
   * The active session and, in config order, the plugins that apply to it
   * (enabled ∧ approved ∧ match), regardless of rail/window visibility and
   * hidden cards. Empty without an active session.
   */
  activeApplicable() {
    const active = this.active;
    if (active == null) return { active: null, ids: [] };
    const sess = this.sessions.get(active);
    if (!sess) return { active, ids: [] };
    const ids = this.cfg.plugins
      .filter(
        (p) =>
          p.enabled &&
          this.cfg.approved.has(p.id) &&
          pluginMatches(p, sess.ctx.project, sess.ctx.remote),
      )
      .map((p) => p.id);
    return { active, ids };
  }

  // ── run table ────────────────────────────────────────────────────────────

  runState(key) {
    const entry = this.runs.get(keyId(key));
    return entry ? entry.state : null;
  }

  /**
   * Starts a run of `key` with `session`'s context, coalesces it into the one
   * in flight, or queues it for a slot.
   */
  start(key, trigger, session, actions) {
    const id = keyId(key);
    let entry = this.runs.get(id);
    if (!entry) {
      // First run of this key: the map needs its own copy.
      entry = { key: runKey(key.scopeKey, key.pluginId), state: idleState() };
      this.runs.set(id, entry);
    }
    const state = entry.state;
    if (state.phase !== PHASE.IDLE) {
      // An interval tick never replaces a pending turn-end/branch/manual
      // refresh; nothing the rail shows changed, so no `changed`.
      const keepQueued =
        trigger === TRIGGER.INTERVAL &&
        state.queued != null &&
        state.queued !== TRIGGER.INTERVAL;
      state.queued = keepQueued ? state.queued : trigger;
      return;
    }
    this.lastSeq += 1;
    state.seq = this.lastSeq;
    state.trigger = trigger;
    state.queued = null;
    // Two actions name the key: one copy.
    actions.push({ type: ACTION.CHANGED, key: entry.key });
    if (this.running < MAX_CONCURRENT_RUNS) {
      state.phase = PHASE.RUNNING;
      this.running += 1;
      actions.push({
        type: ACTION.START,
        key: entry.key,
        seq: this.lastSeq,
        session,
        trigger,
      });
    } else {
      state.phase = PHASE.WAITING;
      this.waiting.push(entry.key);
    }
  }

  finished(key, seq, outcome, now, actions) {
    const entry = this.runs.get(keyId(key));
    if (!entry) return;
    const state = entry.state;
    if (state.seq !== seq || state.phase !== PHASE.RUNNING) return;
    state.phase = PHASE.IDLE;
    if (outcome.ok) state.lastOkAt = now;
    state.last = { at: now, outcome };
    const queued = state.queued;
    state.queued = null;
    this.running = Math.max(0, this.running - 1);
    // The key is still needed for the follow-up.
    actions.push({ type: ACTION.CHANGED, key: entry.key });
    this.promote(actions);
    if (queued == null) return;
    // Checked again: the follow-up must still be runnable.
    const session = this.allowed(entry.key, queued, this.active);
    if (session != null) this.start(entry.key, queued, session, actions);
  }

  /**
   * Fills free slots from the waiting FIFO; a waiting run that may no longer
   * start (tab closed, hidden, unapproved, …) goes back to idle.
   */
  promote(actions) {
    while (this.running < MAX_CONCURRENT_RUNS) {
      const key = this.waiting.shift();
      if (key === undefined) break;
      const entry = this.runs.get(keyId(key));
      if (!entry) continue;
      const state = entry.state;
      if (state.phase !== PHASE.WAITING) continue;
      const trigger = state.trigger ?? TRIGGER.MANUAL;
      const session = this.allowed(entry.key, trigger, this.active);
      if (session != null) {
        state.phase = PHASE.RUNNING;
        this.running += 1;
        actions.push({ type: ACTION.CHANGED, key: entry.key });
        actions.push({
          type: ACTION.START,
          key: entry.key,
          seq: state.seq,
          session,
          trigger,
        });
      } else {
        state.phase = PHASE.IDLE;
        state.queued = null;
        actions.push({ type: ACTION.CHANGED, key: entry.key });
      }
    }
  }

  /** Drops every run state whose key matches `pred`; live/waiting runs are killed. */
  purge(pred, actions) {
    let hadWaiting = false;
    for (const [id, entry] of this.runs) {
      if (!pred(entry.key)) continue;
      const state = entry.state;
      if (state.phase === PHASE.WAITING) {
        hadWaiting = true;
        actions.push({ type: ACTION.KILL, key: entry.key });
      } else if (state.phase === PHASE.RUNNING) {
        this.running = Math.max(0, this.running - 1);
        actions.push({ type: ACTION.KILL, key: entry.key });
      }
      actions.push({ type: ACTION.REMOVED, key: entry.key });
      this.runs.delete(id);
    }
    if (hadWaiting) {
      this.waiting = this.waiting.filter((key) => this.runs.has(keyId(key)));
    }
  }

  // ── gates ────────────────────────────────────────────────────────────────

  /** enabled ∧ approved ∧ shown ∧ rail visible ∧ session known ∧ match. */
  runnable(plugin, session) {
    const sess = this.sessions.get(session);
    return (
      plugin.enabled &&
      this.view.railVisible &&
      this.cfg.approved.has(plugin.id) &&
      !this.view.hidden.has(plugin.id) &&
      sess != null &&
      pluginMatches(plugin, sess.ctx.project, sess.ctx.remote)
    );
  }

  mask(session) {
    let mask = 0n;
    const count = Math.min(this.cfg.plugins.length, MAX_SCHEDULED);
    for (let i = 0; i < count; i += 1) {
      if (this.runnable(this.cfg.plugins[i], session)) mask |= bit(i);
    }
    return mask;
  }

  /**
   * The session a run of `key` with `trigger` may start in right now, or null:
   * tab keys use their own (still open) session, global keys the active one;
   * an interval run also needs a visible window and, for a tab plugin, its tab
   * to be active.
   */
  allowed(key, trigger, active) {
    const found = configGet(this.cfg, key.pluginId);
    if (!found) return null;
    const plugin = found.plugin;
    const global = key.scopeKey === GLOBAL_KEY;
    if (global !== (plugin.scope === 'global')) return null;
    const session = global ? active : this.sessions.has(key.scopeKey) ? key.scopeKey : null;
    if (session == null) return null;
    if (!this.runnable(plugin, session)) return null;
    if (
      trigger === TRIGGER.INTERVAL &&
      !(this.view.windowVisible && (global || active === session))
    ) {
      return null;
    }
    return session;
  }

  // ── event handlers ───────────────────────────────────────────────────────

  /** Re-derives the active session and its runnable set; activates what became runnable. */
  refresh(now, actions) {
    const viewSession = this.view.session;
    const active =
      viewSession != null && this.sessions.has(viewSession) ? viewSession : null;
    const switched = active !== this.active;
    if (switched) {
      // Once per tab switch.
      this.active = active;
    }
    const mask = this.active != null ? this.mask(this.active) : 0n;
    let newly;
    if (switched) {
      const hasActive = this.active != null;
      for (let i = 0; i < this.cfg.plugins.length; i += 1) {
        const plugin = this.cfg.plugins[i];
        if (plugin.scope !== 'tab') continue;
        this.timers[i] =
          plugin.intervalMs != null &&
          timerWanted(plugin, this.cfg.approved.has(plugin.id), hasActive)
            ? satAdd(now, plugin.intervalMs)
            : null;
      }
      newly = mask;
    } else {
      newly = mask & ~this.activeMask;
    }
    this.activeMask = mask;
    this.activate(newly, now, actions);
    const live = this.view.windowVisible && this.view.railVisible;
    if (live && !this.live) {
      this.flushDirty(actions);
      this.catchUp(now, actions);
    }
    this.live = live;
  }

  /**
   * Runs the plugins in `newly` for the active session: tab plugins with
   * `activate`, or else their dirty trigger; global plugins with `activate`
   * only without a fresh result.
   */
  activate(newly, now, actions) {
    const session = this.active;
    if (session == null) return;
    const sess = this.sessions.get(session);
    for (const i of bits(newly)) {
      const plugin = this.cfg.plugins[i];
      if (!plugin) continue;
      const key = keyFor(plugin, session);
      let trigger = null;
      if (plugin.scope === 'tab') {
        let dirty = null;
        if (sess && sess.dirty.has(plugin.id)) {
          dirty = sess.dirty.get(plugin.id);
          sess.dirty.delete(plugin.id);
        }
        rearm(this.timers, i, plugin, now);
        trigger = pluginWants(plugin, TRIGGER.ACTIVATE) ? TRIGGER.ACTIVATE : dirty;
      } else {
        const due =
          plugin.intervalMs == null
            ? true
            : dueNow(this.runState(key), plugin.intervalMs, now);
        trigger = pluginWants(plugin, TRIGGER.ACTIVATE) && due ? TRIGGER.ACTIVATE : null;
      }
      if (trigger == null) continue;
      if (plugin.scope === 'global') rearm(this.timers, i, plugin, now);
      this.start(key, trigger, session, actions);
    }
  }

  /** Runs what fired while the active session was not live (one run per plugin). */
  flushDirty(actions) {
    const session = this.active;
    if (session == null) return;
    const sess = this.sessions.get(session);
    if (!sess || sess.dirty.size === 0) return;
    for (const i of bits(this.activeMask)) {
      const plugin = this.cfg.plugins[i];
      if (!plugin || plugin.scope !== 'tab') continue;
      if (!sess.dirty.has(plugin.id)) continue;
      const trigger = sess.dirty.get(plugin.id);
      sess.dirty.delete(plugin.id);
      this.start(keyFor(plugin, session), trigger, session, actions);
    }
  }

  /** Each runnable interval plugin that is due runs once and is re-armed. */
  catchUp(now, actions) {
    const session = this.active;
    if (session == null) return;
    for (const i of bits(this.activeMask)) {
      const plugin = this.cfg.plugins[i];
      if (!plugin || plugin.intervalMs == null) continue;
      const key = keyFor(plugin, session);
      if (!dueNow(this.runState(key), plugin.intervalMs, now)) continue;
      rearm(this.timers, i, plugin, now);
      this.start(key, TRIGGER.INTERVAL, session, actions);
    }
  }

  /**
   * `turn_end`/`branch` of `session`: runs now when it is the live active
   * session, otherwise remembered for its next activation.
   */
  fire(session, trigger, actions) {
    if (this.live && this.active === session) {
      for (const i of bits(this.activeMask)) {
        const plugin = this.cfg.plugins[i];
        if (!plugin || !pluginWants(plugin, trigger)) continue;
        this.start(keyFor(plugin, session), trigger, session, actions);
      }
      return;
    }
    const sess = this.sessions.get(session);
    if (!sess) return;
    for (const plugin of this.cfg.plugins) {
      if (!(plugin.enabled && plugin.scope === 'tab' && pluginWants(plugin, trigger))) continue;
      // Latest dirty trigger wins; one entry per plugin.
      sess.dirty.set(plugin.id, trigger);
    }
  }

  manual(pluginId, actions) {
    const session = this.active;
    if (session == null) return;
    const found = configGet(this.cfg, pluginId);
    if (!found) return;
    if ((this.activeMask & bit(found.index)) !== 0n) {
      this.start(keyFor(found.plugin, session), TRIGGER.MANUAL, session, actions);
    }
  }

  tick(now, actions) {
    const session = this.live ? this.active : null;
    const count = Math.min(this.timers.length, this.cfg.plugins.length);
    for (let i = 0; i < count; i += 1) {
      const due = this.timers[i];
      const plugin = this.cfg.plugins[i];
      const interval = plugin.intervalMs;
      if (due == null || interval == null) continue;
      if (due > now) continue;
      this.timers[i] = satAdd(now, interval);
      if (session != null && (this.activeMask & bit(i)) !== 0n) {
        this.start(keyFor(plugin, session), TRIGGER.INTERVAL, session, actions);
      }
    }
  }

  close(session, now, actions) {
    if (!this.sessions.delete(session)) return;
    this.purge((key) => key.scopeKey === session, actions);
    this.refresh(now, actions);
    this.promote(actions);
  }

  /** A clock that jumped back must not push a timer further away than one interval. */
  clampTimers(now) {
    const count = Math.min(this.timers.length, this.cfg.plugins.length);
    for (let i = 0; i < count; i += 1) {
      this.timers[i] = clampTimerDue(this.timers[i], this.cfg.plugins[i].intervalMs, now);
    }
  }

  setConfig(pluginsRaw, approvedRaw, now, actions) {
    const plugins = (Array.isArray(pluginsRaw) ? pluginsRaw : []).map(normalizePlugin);
    const approved = new Set(Array.from(approvedRaw ?? [], String));
    const index = new Map();
    plugins.forEach((p, i) => {
      // First entry wins on duplicate ids.
      if (!index.has(p.id)) index.set(p.id, i);
    });

    // Removed, unapproved, or scope changed: the old results are void.
    this.purge((key) => {
      const i = index.get(key.pluginId);
      if (i === undefined) return true;
      if (!approved.has(key.pluginId)) return true;
      const plugin = plugins[i];
      return (plugin.scope === 'global') !== (key.scopeKey === GLOBAL_KEY);
    }, actions);

    // Carry timers and the runnable set over by id.
    const oldCfg = this.cfg;
    const hasActive = this.active != null;
    const timers = new Array(plugins.length).fill(null);
    let mask = 0n;
    for (let i = 0; i < plugins.length; i += 1) {
      const plugin = plugins[i];
      const nowApproved = approved.has(plugin.id);
      const old = configGet(oldCfg, plugin.id);
      let keptDue = null;
      if (old) {
        const before = old.plugin;
        const same =
          before.intervalMs === plugin.intervalMs &&
          before.matchPath === plugin.matchPath &&
          before.matchRemote === plugin.matchRemote &&
          before.scope === plugin.scope &&
          before.enabled === plugin.enabled &&
          oldCfg.approved.has(plugin.id) === nowApproved;
        if (same) {
          const due = this.timers[old.index];
          keptDue = due == null ? null : due;
        }
      }
      if (plugin.intervalMs != null && timerWanted(plugin, nowApproved, hasActive)) {
        timers[i] = keptDue != null ? keptDue : satAdd(now, plugin.intervalMs);
      }
      // A scope change starts over: it lost its result above.
      if (old && old.plugin.scope === plugin.scope && (this.activeMask & bit(old.index)) !== 0n) {
        mask |= bit(i);
      }
    }
    // Dirty triggers of plugins that are gone are forgotten.
    for (const sess of this.sessions.values()) {
      for (const id of sess.dirty.keys()) {
        if (!index.has(id)) sess.dirty.delete(id);
      }
    }
    this.cfg = { plugins, index, approved };
    this.timers = timers;
    this.activeMask = mask;
    this.promote(actions);
    this.refresh(now, actions);
  }

  /** Invokes the injected hooks in action order (state is already consistent). */
  dispatch(actions) {
    for (const action of actions) {
      switch (action.type) {
        case ACTION.START:
          if (this.startRun) this.startRun(action);
          break;
        case ACTION.KILL:
          if (this.killRun) this.killRun(action);
          break;
        case ACTION.CHANGED:
          if (this.onChanged) this.onChanged(action);
          break;
        case ACTION.REMOVED:
          if (this.onRemoved) this.onRemoved(action);
          break;
        default:
          break;
      }
    }
  }
}

/** A scheduler with an injectable clock and run-starter. */
function createScheduler(options = {}) {
  return new Scheduler(options);
}

module.exports = {
  // constants
  GLOBAL_KEY,
  MAX_CONCURRENT_RUNS,
  MAX_SCHEDULED,
  TRIGGER,
  PHASE,
  ACTION,
  EVENT,
  // entry point
  createScheduler,
  // pure helpers (all pinned by the Rust test table)
  pathMatches,
  pluginMatches,
  pluginWants,
  normalizeTriggerName,
  normalizePlugin,
  normalizeKey,
  normalizeCtx,
  normalizeView,
  normalizeOutcome,
  runKey,
  keyId,
  keyFor,
  bit,
  bits,
  dueNow,
  rearm,
  clampTimerDue,
  timerWanted,
  configGet,
};