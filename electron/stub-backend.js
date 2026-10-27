/* electron/stub-backend.js — the IPC dispatcher.

   Every command the frontend sends lands here; each call is logged to
   stderr so the startup contract (`docs/port/startup-contract.md`) can be
   verified against what the frontend ACTUALLY asks, not what we predicted.
   Bodies route to electron/backend/* as milestones land; anything not yet
   ported falls through to a shape-correct empty reply (the M1 stub table),
   which is why this file is still named "stub". */

const savedSessions = require("./backend/saved-sessions");
const keybindings = require("./backend/keybindings");
const stores = require("./backend/stores");
const { AgentBridge } = require("./backend/agent");

// One bridge per app run (M3). Main subscribes its line/exit events and
// forwards them to the webview as `agent://line/{id}` / `agent://exit/{id}`.
const agent = new AgentBridge();

const log = (name, args, reply) =>
  process.stderr.write(`[stub] ${name} ${JSON.stringify(args ?? {})} -> ${JSON.stringify(reply)}\n`);

// Keys are the exact command names the frontend sends. One entry per name —
// a duplicate silently shadows the earlier one (object-literal last-key-wins).
const EXPLICIT = {
  // ── startup contract §1 ────────────────────────────────────────────────
  approval_mode_get: () => stores.approvalModeGet(),
  approval_mode_set_default: (a) => stores.approvalModeSetDefault(a?.mode),
  approval_mode_set_project: (a) => stores.approvalModeSetProject(a?.projectRoot, a?.mode),
  prompt_history_list: () => [],
  list_profiles: () => stores.profilesList(),
  set_close_guard: () => null,
  recent_projects_list: (a) => stores.recentsList(a?.profile ?? ""),
  recent_projects_touch: (a) => stores.recentsTouch(a?.profile ?? "", a?.path),
  close_all_tabs: () => null,
  // The riskiest startup shape: a non-null reply without BOTH arrays throws
  // inside _restoreOpenTabs and aborts the whole restore chain.
  open_tabs_load: () => stores.openTabsLoad(),
  open_tabs_save: (a) => stores.openTabsSave(a?.layout),
  // Must be an array or null; any other truthy value throws in a detached
  // async (unhandled rejection).
  take_pending_open_projects: () => [],
  "plugin:app|version": () => "0.11.0",
  keybindings_list: (a) => keybindings.keybindingsList(a?.profile ?? ""),
  keybindings_set: (a) => keybindings.keybindingsSet(a?.profile ?? "", a?.action, a?.keys),
  keybindings_reset: (a) => keybindings.keybindingsReset(a?.profile ?? "", a?.action),
  widgets_state: () => ({
    configPath: null, fatal: null, errors: [], plugins: [],
    active: { sessionId: null, applicable: [] }, runs: [],
  }),
  widgets_set_view: () => null,
  list_saved_sessions: (a) => savedSessions.listSavedSessions(a ?? {}),
  app_update_check: () => null,

  // ── M3 agent bridge (parity-tested; real-omp smoke green) ──────────────
  start_session: (a) => agent.startSession(a?.args ?? a ?? {}),
  send_command: (a) => agent.sendCommand(a?.sessionId, a?.json),
  stop_session: (a) => agent.stopSession(a?.sessionId),
  replay_events: (a) => agent.replayEvents(a?.sessionId, a?.afterSeq ?? 0),
  session_status: (a) => agent.sessionStatus(a?.sessionId),
  approval_approve_and_grant: (a) => agent.approveAndGrant(a ?? {}),

  // ── still stubbed (M3 slices in flight) ────────────────────────────────
  start_git_watch: () => null,
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

async function handle(name, args) {
  let reply;
  try {
    reply = EXPLICIT[name] ? await EXPLICIT[name](args) : defaultReply(name);
  } catch (e) {
    reply = { error: String(e) };
  }
  log(name, args, reply);
  return reply;
}

module.exports = { handle, EXPLICIT, agent };
