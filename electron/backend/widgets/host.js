/* electron/backend/widgets/host.js — the port's WidgetHost.

   Mirrors src-tauri/src/widgets/host.rs: owns config, approvals, the
   verified-copy store, the pure scheduler and the run registry, and emits
   the four `widgets://` events the frontend subscribes to (live.js:4608
   listens to `widgets://<kind>`). Every spawn goes through the fingerprint
   gate and runs the verified copy from ScriptStore.prepare — never the
   configured script path (docs/widgets.md threat model). */

const config = require("./config");
const trust = require("./trust");
const snapshot = require("./snapshot");
const run = require("./run");
const context = require("./context");
const schedule = require("./schedule");

const TICK_MS = 250;

class WidgetHost {
  /**
   * @param options.configDir  app config folder (widgets.json, approvals)
   * @param options.storeRoot  verified-copy store root (null = default)
   * @param options.emit       (event, payload) => void (the Tauri emit seam)
   * @param options.now        injectable epoch-ms clock for tests
   */
  constructor(options = {}) {
    this.configDir = options.configDir ?? null;
    this.store = new snapshot.ScriptStore(options.storeRoot ?? snapshot.storeRoot());
    this._emit = options.emit ?? (() => {});
    this._now = options.now ?? (() => Date.now());
    this.view = { sessionId: null, railVisible: true, windowVisible: true, hidden: [] };
    this.sessions = new Map(); // sessionId -> { project }
    this.runs = new Map(); // keyId -> { handle, seq, key, pluginId }
    this.seqs = new Map(); // keyId -> next seq
    this.lastRuns = new Map(); // keyId -> RunView
    this.scheduler = schedule.createScheduler({
      now: this._now,
      startRun: (action) => this._spawn(action),
      killRun: (action) => this._kill(action.key),
      onChanged: (action) => this._publishRun(action.key),
      onRemoved: (action) => {
        this.lastRuns.delete(action.key);
        this._emit("widgets://removed", { key: action.key });
      },
    });
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref?.();
    this.reload();
  }

  /** `widgets_reload`: re-read config + approvals, re-fingerprint. */
  reload() {
    const loaded = config.loadConfig(this.configDir);
    this.config = loaded;
    const approved = new Set();
    for (const plugin of loaded.plugins ?? []) {
      if (trust.isApproved(plugin.id, trust.fingerprint(plugin), this.configDir)) {
        approved.add(plugin.id);
      }
    }
    this.scheduler.handle({ type: "config", plugins: loaded.plugins ?? [], approved }, this._now());
    // `widgets://config` carries the flattened ConfigView (host.rs:805):
    // the same PluginView[] `widgets_state` returns — the frontend's
    // applySnapshot reads payload.plugins as plugin views, not ids.
    const { active, runs, ...configView } = this.state();
    this._emit("widgets://config", configView);
    this._publishActive();
    return this.state();
  }

  /** `widgets_state`: everything the rail renders. */
  state() {
    return {
      configPath: this.config.configPath ?? null,
      fatal: this.config.fatal ?? null,
      errors: this.config.errors ?? [],
      plugins: (this.config.plugins ?? []).map((p) => {
        const fingerprint = trust.fingerprint(p);
        return {
          id: p.id,
          title: p.title ?? p.id,
          scope: p.scope ?? "tab",
          enabled: p.enabled !== false,
          approval: trust.approvalStatus(p.id, fingerprint, this.configDir),
          command: p.command ?? [],
          fingerprint,
        };
      }),
      active: {
        sessionId: this.view.sessionId ?? null,
        // The frontend's applyActive requires an ARRAY of ids (use-widgets).
        applicable: this.scheduler.activeApplicable().ids,
      },
      runs: [...this.lastRuns.values()],
    };
  }

  /** `widgets_approve`: the fingerprint gate's only opening. */
  approve(pluginId, fingerprint) {
    trust.approve(pluginId, fingerprint, { configDir: this.configDir });
    return this.reload();
  }

  /** `widgets_set_view`: rail/window visibility and hidden plugins. */
  setView(view) {
    this.view = { ...this.view, ...(view ?? {}) };
    this.scheduler.handle({
      type: "view",
      view: {
        session: this.view.sessionId ?? null,
        railVisible: this.view.railVisible !== false,
        windowVisible: this.view.windowVisible !== false,
        hidden: this.view.hidden ?? [],
      },
    }, this._now());
    this._publishActive();
    return this.state();
  }

  /** `widgets_refresh`: manual trigger for one plugin. */
  refresh(pluginId) {
    this.scheduler.handle({ type: "manual", pluginId }, this._now());
    return this.state();
  }

  sessionStarted(sessionId, project) {
    this.sessions.set(sessionId, { project: project ?? null });
    // Rust computes the git context on the scheduler thread; the port sends
    // the project now and refreshes branch/remote when they resolve.
    this.scheduler.handle({
      type: "session_opened", session: sessionId,
      ctx: { project: project ?? "", branch: "", remote: "" },
    }, this._now());
    context.gitContext(project).then((ctx) => {
      if (!this.sessions.has(sessionId)) return;
      this.sessions.set(sessionId, { project: project ?? null, ctx });
      this.scheduler.handle({ type: "session_opened", session: sessionId, ctx }, this._now());
      this._publishActive();
    });
    this._publishActive();
  }

  sessionClosed(sessionId) {
    this.sessions.delete(sessionId);
    this.scheduler.handle({ type: "session_closed", session: sessionId }, this._now());
    this._publishActive();
  }

  turnEnded(sessionId) {
    this.scheduler.handle({ type: "turn_end", session: sessionId }, this._now());
  }

  branchChanged(sessionId) {
    this.scheduler.handle({ type: "branch", session: sessionId }, this._now());
  }

  /** Updater relaunch / app exit: every plugin process tree dies. */
  killAll() {
    clearInterval(this._timer);
    for (const entry of this.runs.values()) entry.handle?.cancel?.();
    this.runs.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────
  _tick() {
    const now = this._now();
    if (this.scheduler.nextDeadline() <= now) {
      this.scheduler.handle({ type: "tick" }, now);
    }
  }

  /** The fingerprint gate, then the verified copy, then the process. */
  _spawn(action) {
    const key = action.key;
    const keyId = schedule.keyId(key);
    const entry =
      this.scheduler.plugin(key.pluginId) ??
      (this.config.plugins ?? []).find((p) => p.id === key.pluginId);
    if (!entry) return;
    const fingerprint = trust.fingerprint(entry);
    const seq = (this.seqs.get(keyId) ?? 0) + 1;
    this.seqs.set(schedule.keyId(key), seq);
    const base = { key: key.scopeKey ?? key, pluginId: key.pluginId ?? entry.id, seq };
    if (!trust.isApproved(entry.id, fingerprint, this.configDir)) {
      this.lastRuns.set(schedule.keyId(key), {
        ...base, phase: "idle", last: null, lastOkAt: null,
        error: `not approved (fingerprint ${fingerprint.slice(0, 12)}…)`,
      });
      this._publishRun(key);
      return;
    }
    let prepared;
    try {
      prepared = this.store.prepare(entry, fingerprint);
    } catch (error) {
      this.lastRuns.set(schedule.keyId(key), {
        ...base, phase: "idle", last: null, lastOkAt: null, error: String(error.message),
      });
      this._publishRun(key);
      return;
    }
    if (prepared.kind === "changed") {
      // The approved script changed on disk: the new fingerprint is not
      // approved, so nothing runs until the user approves it again.
      this.lastRuns.set(schedule.keyId(key), {
        ...base, phase: "idle", last: null, lastOkAt: null,
        error: `script changed (new fingerprint ${prepared.fingerprint.slice(0, 12)}… needs approval)`,
      });
      this._publishRun(key);
      return;
    }
    this.lastRuns.set(schedule.keyId(key), { ...base, phase: "running", last: this.lastRuns.get(schedule.keyId(key))?.last ?? null, lastOkAt: this.lastRuns.get(schedule.keyId(key))?.lastOkAt ?? null });
    this._publishRun(key);
    const session = key.scopeKey === schedule.GLOBAL_KEY ? null : key.scopeKey;
    const project = session ? this.sessions.get(session)?.project ?? null : null;
    const controller = new AbortController();
    context.gitContext(project).then((ctx) => {
      const argv = prepared.run.argv;
      const promise = run.runWidget({
        scriptPath: argv[0],
        args: argv.slice(1),
        env: { OMP_WIDGET_TRIGGER: action.trigger ?? "manual" },
        context: context.pluginContext(ctx, session, action.trigger ?? "manual"),
        cwd: project ?? undefined,
        timeoutMs: entry.timeoutMs ?? undefined,
        signal: controller.signal,
      });
      this.runs.set(keyId, {
        handle: { cancel: () => controller.abort(), then: promise.then.bind(promise) },
        seq, key, pluginId: entry.id,
      });
      promise.then((result) => {
        prepared.run.dispose?.();
        this.runs.delete(schedule.keyId(key));
        const outcome = {
          ok: result.exitCode === 0 && !result.timedOut && !result.error,
          value: result.stdout,
          error: result.error ?? (result.timedOut ? "timed out" : result.exitCode === 0 ? null : `exit ${result.exitCode}`),
          durationMs: result.durationMs,
        };
        this.scheduler.handle({ type: "finished", key, seq, outcome }, this._now());
        if (outcome.ok) {
          const view = this.lastRuns.get(schedule.keyId(key)) ?? { ...base };
          this.lastRuns.set(schedule.keyId(key), {
            ...view, phase: "idle",
            last: { stdout: result.stdout, at: this._now() },
            lastOkAt: this._now(),
          });
          this._publishRun(key);
        }
      });
    });
  }

  _kill(key) {
    const entry = this.runs.get(schedule.keyId(key));
    entry?.handle?.cancel?.();
    this.runs.delete(schedule.keyId(key));
  }

  /** `widgets://run` carries the RunView the frontend merges by seq. */
  _publishRun(key) {
    const state = this.scheduler.runState(key);
    const stored = this.lastRuns.get(schedule.keyId(key));
    if (!stored) return;
    const phase = state?.phase ?? stored.phase ?? "idle";
    this.lastRuns.set(schedule.keyId(key), { ...stored, phase });
    this._emit("widgets://run", this.lastRuns.get(schedule.keyId(key)));
  }

  _publishActive() {
    this._emit("widgets://active", {
      sessionId: this.view.sessionId ?? null,
      applicable: this.scheduler.activeApplicable().ids,
    });
  }
}

module.exports = { WidgetHost };
