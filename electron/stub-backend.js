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
  profiles_list: () => ({ profiles: [{ id: "default", name: "default", isDefault: true }] }),
  profile_current: () => "default",
  keybindings_get: () => ({ bindings: {}, paths: [] }),
  approval_mode_get: () => ({ mode: "ask", project: null }),
  session_prefs_get: () => ({}),
  recent_projects_list: () => [],
  open_tabs_list: () => [],
  list_saved_sessions: () => [],
  models_recent: () => [],
  widgets_list: () => [],
  widgets_state: () => ({ plugins: [], runs: [] }),
  extension_ui_state: () => ({ statuses: [], widgets: [] }),
  browser_state: () => ({ enabled: false, pages: [], panelOpen: false }),
  terminal_status: () => ({ tabs: [] }),
  remote_state: () => ({ status: "disabled", devices: [], pinnedCert: null }),
  updater_state: () => ({ checking: false, update: null }),
  goal_config_get: () => ({ enabled: false }),
  stats_summary: () => null,
  git_status: () => ({ branch: null, dirty: false }),
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
