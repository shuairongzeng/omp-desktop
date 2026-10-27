/* electron/stub-backend.js — M1's answer machine.

   Every command the frontend sends gets a shape-correct empty reply so the
   real UI can boot; each call is logged to stderr so the startup contract
   (`docs/port/startup-contract.md`) can be verified against what the
   frontend ACTUALLY asks, not what we predicted. M2 replaces this file's
   bodies with real Node implementations, keeping the same dispatch shape. */

const log = (name, args, reply) =>
  process.stderr.write(`[stub] ${name} ${JSON.stringify(args ?? {})} -> ${JSON.stringify(reply)}\n`);

// Explicit shapes where an empty default would stall or mislead startup.
// Keys are the exact command names the frontend sends.
const EXPLICIT = {
  // Shapes verbatim from docs/port/startup-contract.md §1 (rows 1-13).
  approval_mode_get: () => ({ default: "write", projects: {} }),
  prompt_history_list: () => [],
  list_profiles: () => ({
    profiles: [{ id: "default", name: "default" }],
    startupId: "default",
    degraded: null,
  }),
  set_close_guard: () => null,
  recent_projects_list: () => [],
  close_all_tabs: () => null,
  // Row 7 — the riskiest stub: a non-null reply without BOTH arrays throws
  // inside _restoreOpenTabs and aborts the whole restore chain.
  open_tabs_load: () => ({ tabs: [], active: null, skipped: [] }),
  // Row 8 — must be an array or null; any other truthy value throws in a
  // detached async (unhandled rejection).
  take_pending_open_projects: () => [],
  "plugin:app|version": () => "0.11.0",
  keybindings_list: () => ({
    omp: {}, overlay: {}, overlayError: null,
    ompPath: null, inheritedPath: null, overlayPath: null,
  }),
  widgets_state: () => ({
    configPath: null, fatal: null, errors: [], plugins: [],
    active: { sessionId: null, applicable: [] }, runs: [],
  }),
  widgets_set_view: () => null,
  list_saved_sessions: () => [],
  app_update_check: () => null,
  // Restored-tab path (contract §2) — inert until M2 spawns real sessions.
  start_session: () => "write",
  start_git_watch: () => null,
  replay_events: () => ({ events: [], headSeq: 0, dropped: false }),
  session_status: () => null,
  send_command: () => null,
  extension_ui_state: () => ({ statuses: [], widgets: [], seq: 0 }),
};

// Name-shape fallbacks, in priority order.
function defaultReply(name) {
  if (/^(list_|recent_|saved_)/.test(name)) return [];
  if (/^(get_|fetch_)/.test(name)) return null;
  if (/^(set_|save_|touch_|delete_|remove_|close_|stop_|kill_|ack_)/.test(name)) return null;
  if (/^(is_|has_)/.test(name)) return false;
  return null;
}

function handle(name, args) {
  let reply;
  try {
    reply = EXPLICIT[name] ? EXPLICIT[name](args) : defaultReply(name);
  } catch (e) {
    reply = { error: String(e) };
  }
  log(name, args, reply);
  return Promise.resolve(reply);
}

module.exports = { handle, EXPLICIT };
