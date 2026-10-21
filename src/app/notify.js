/* app/notify.js — attention system: OS notifications for a run's outcomes.
 *
 * The pure half (`shouldNotify`) decides whether a run-state transition
 * deserves a desktop notification; the effect half (`fire`) talks to the
 * Tauri notification plugin (src-tauri: tauri-plugin-notification, capability
 * `notification:default`). Exposed as `window.OMP_OSNOTIFY` per the IIFE rule
 * for plain <script> tags; the App root wires the runState listener, this
 * file never touches live.js state.
 *
 * Permission flow: `plugin:notification|is_permission_granted` (returns
 * true/false/null-prompt) then `plugin:notification|request_permission`
 * ("granted" | "denied" | "prompt" | "prompt-with-rationale"); both then
 * `plugin:notification|notify` with `{options: {title, body}}` — the exact
 * command names and payload shape of plugins-workspace v2's guest-js
 * (guest-js/index.ts invokes them verbatim; commands.rs names match).
 * Every step is guarded: a missing `__TAURI__` (tests, remote shim) or a
 * rejected permission logs a console.warn and returns — never throws into
 * the caller's render path. */
(function () {
  "use strict";

  /** Whether a run-state transition should fire a notification.
   * - busy/running → idle with tweaks.notifyDone: the reply finished.
   * - busy/running → waiting-user with tweaks.notifyAsk: an ask dialog
   *   (tool approval / question) now blocks the run.
   * - Only when the user is NOT already looking: document.hidden or the
   *   tab inactive (`isActiveTab` false). Watching the run live is its
   *   own feedback; a toast on top would be noise.
   * - Any other transition (idle → running, failed, still busy) is silent:
   *   failure already paints the tab rose, and starts need no announce.
   * Pure: no DOM, no clock, safe to unit-test (test-notify.mjs). */
  function shouldNotify({ prevRun, nextRun, documentHidden, isActiveTab, tweaks }) {
    // Missing inputs are "not watching" for the visibility gate but never
    // alone sufficient — the transition and tweak checks below still apply.
    const wasBusy = prevRun === "busy" || prevRun === "running";
    if (!wasBusy) return false;
    if (nextRun !== "idle" && nextRun !== "waiting-user") return false;
    // The tweak defaults (constants.js TWEAK_DEFAULTS) are both true; a
    // null tweaks object (settings not loaded yet) keeps that behaviour.
    const ask = nextRun === "waiting-user";
    const enabled = ask ? tweaks?.notifyAsk !== false : tweaks?.notifyDone !== false;
    if (!enabled) return false;
    const visible = documentHidden === false && isActiveTab === true;
    return !visible;
  }

  /** Titles per kind, "omp-desktop — " prefixed so the toast names the app
   * even on platforms (Windows dev) that show a PowerShell name instead. */
  const TITLES = {
    done: "omp-desktop — 回复完成",
    ask: "omp-desktop — 需要你审批",
  };

  /** The invoke seam, read once per call so tests can stub `window.__TAURI__`
   * between calls without re-importing the module. */
  function tauriInvoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke : null;
  }

  /** Ensure the OS notification permission is granted, asking once if not.
   * Returns true when sending may proceed. is_permission_granted answers
   * null for "prompt" (see commands.rs) — that is the request case. */
  async function ensurePermission(invoke) {
    let granted = null;
    try {
      granted = await invoke("plugin:notification|is_permission_granted");
    } catch (err) {
      console.warn("[notify] is_permission_granted failed:", err);
      return false;
    }
    if (granted === true) return true;
    try {
      const state = await invoke("plugin:notification|request_permission");
      // "granted" is the only go-ahead; prompt-with-rationale means still
      // undecided (the OS dialog was dismissed), denied is a hard no.
      return state === "granted";
    } catch (err) {
      console.warn("[notify] request_permission failed:", err);
      return false;
    }
  }

  /** Fire the notification for `kind` ("done" | "ask"). Best-effort: every
   * failure path warns and resolves — attention nudges must never break the
   * run-state listener that calls this. */
  async function fire(kind, { sessionTitle, projectName } = {}) {
    try {
      const invoke = tauriInvoke();
      if (!invoke) {
        console.warn("[notify] no Tauri bridge; notification skipped");
        return false;
      }
      const title = TITLES[kind] ?? "omp-desktop";
      // Body: the conversation first, the project as a quieter suffix.
      // Both optional — a bare title still names what finished.
      const parts = [];
      if (sessionTitle) parts.push(sessionTitle);
      if (projectName && projectName !== sessionTitle) parts.push(projectName);
      const body = parts.length ? parts.join(" · ") : undefined;
      if (!(await ensurePermission(invoke))) return false;
      await invoke("plugin:notification|notify", {
        // NotificationData is camelCase-renamed (models.rs) and the command
        // wraps it in an `options` arg (commands.rs: `options: NotificationData`).
        options: { title, ...(body ? { body } : {}) },
      });
      return true;
    } catch (err) {
      console.warn(`[notify] ${kind} notification failed:`, err);
      return false;
    }
  }

  Object.assign(window, { OMP_OSNOTIFY: { shouldNotify, fire } });
})();
