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
const { TerminalManager } = require("./backend/terminal");
const git = require("./backend/git");
const remoteFiles = require("./backend/remote-files");
const { BrowserManager } = require("./backend/browser-manager");
const { RemoteManager } = require("./backend/remote-manager");
const updater = require("./packaging/updater");

// The packaged app's version; `npx electron .` runs report the repo one.
const APP_VERSION = require("../package.json").version;

// One browser manager per app run (M3): Chromium launches lazily on the
// first panel open, exactly like the Tauri manager.
const browser = new BrowserManager();
const remote = new RemoteManager();
// One bridge and one terminal manager per app run (M3). Main subscribes
// their events and forwards them to the webview under the exact Tauri
// event names the frontend subscribes to.
const agent = new AgentBridge();
const terminal = new TerminalManager();

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
  // M5: real updater check; the frontend expects Rust's UpdateInfo
  // (camelCase {version, notes, date, canInstall, releaseUrl}) or null.
  app_update_check: async () => {
    const info = await updater.check(updater.DEFAULT_FEED, { currentVersion: APP_VERSION });
    if (!info?.available) return null;
    return {
      version: info.version,
      notes: info.notes ?? null,
      date: info.date ?? null,
      canInstall: true,
      releaseUrl: info.url,
    };
  },

  // ── M3 agent bridge (parity-tested; real-omp smoke green) ──────────────
  // The tab's shell slot is registered before omp spawns, exactly like
  // Tauri's start_session does (TerminalManager::register_tab).
  start_session: (a) => {
    const args = a?.args ?? a ?? {};
    if (args.sessionId) terminal.registerTab(args.sessionId, args.cwd ?? "");
    return agent.startSession(args);
  },
  send_command: (a) => agent.sendCommand(a?.sessionId, a?.json),
  stop_session: (a) => agent.stopSession(a?.sessionId),
  replay_events: (a) => agent.replayEvents(a?.sessionId, a?.afterSeq ?? 0),
  session_status: (a) => agent.sessionStatus(a?.sessionId),
  approval_approve_and_grant: (a) => agent.approveAndGrant(a ?? {}),
  close_tab: (a) => {
    terminal.closeTab(a?.sessionId);
    return agent.stopSession(a?.sessionId);
  },

  // ── M3 terminal manager (parity-tested, 41 checks) ─────────────────────
  terminal_open: (a) => terminal.open(a?.sessionId),
  terminal_status: (a) => terminal.status(a?.sessionId),
  terminal_write: (a) => terminal.write(a?.sessionId, a?.data ?? ""),
  terminal_resize: (a) => terminal.resize(a?.sessionId, a?.cols, a?.rows),
  terminal_ack: (a) => terminal.ack(a?.sessionId, a?.instance, a?.bytes),
  terminal_replay: (a) => terminal.replay(a?.sessionId, a?.instance, a?.afterSeq),
  terminal_settings: () => terminal.settingsPayload(),
  terminal_set_shell: (a) => terminal.setShell(a?.shell),
  terminal_pick_shell: () => null, // native dialog: M5

  // ── M3 git browser (parity-tested, 52 checks; isomorphic-git) ──────────
  git_browser_status: (a) => git.gitBrowserStatus(a?.path),
  git_browser_file: (a) => git.gitBrowserFile(a?.path, a?.relPath ?? a?.rel_path),
  git_browser_log: (a) => git.gitBrowserLog(a?.path),
  git_browser_commit: (a) => git.gitBrowserCommit(a?.path, a?.sha),
  // ── M4 phone-facing file/relay ports (parity-tested, 35 checks) ────────
  remote_transcript_window: (a) => remoteFiles.transcriptWindow(a?.sessionFile, a?.before ?? null, a?.limit),
  remote_replay_events: async (a) => remoteFiles.replayProject(
    await agent.replayEvents(a?.sessionId, a?.afterSeq ?? 0), a?.afterSeq ?? 0),
  remote_list_dirs: (a) => remoteFiles.listDirs(a?.path ?? null),
  // ── M4 remote control (crypto+files parity-tested; manager is Main's) ──
  remote_get_state: () => remote.view(),
  remote_configure: (a) => remote.configure(a ?? {}),
  remote_send: (a) => remote.send(a?.frame),
  remote_set_name: (a) => remote.setName(a?.name ?? ""),
  remote_trust_server_cert: () => remote.trustServerCert(),
  remote_regenerate_token: () => remote.regenerateToken(),
  // ── M3 browser (parity-tested slices; manager is Main's integration) ──
  browser_open_panel: (a) => browser.openPanel(a?.sessionId, {
    width: a?.width, height: a?.height, dpr: a?.dpr,
    channelId: a?.events?.__channel ?? null,
  }),
  browser_close_panel: (a) => browser.closePanel(a?.sessionId),
  browser_resize: (a) => browser.resize(a?.sessionId, a?.width, a?.height, a?.dpr),
  browser_navigate: (a) => browser.navigate(a?.sessionId, a?.url),
  browser_history: (a) => browser.history(a?.sessionId, a?.delta),
  browser_tab_new: (a) => browser.tabNew(a?.sessionId),
  browser_tab_close: (a) => browser.tabClose(a?.sessionId, a?.targetId),
  browser_tab_activate: (a) => browser.tabActivate(a?.sessionId, a?.targetId),
  browser_input: (a) => browser.input(a?.sessionId, a),
  browser_frame_ack: (a) => browser.frameAck(a?.sessionId, a?.seq),
  browser_annotate: (a) => browser.annotate(a?.sessionId, a?.on === true),
  browser_capture: (a) => browser.capture(a?.sessionId, a?.rect),
  browser_scroll_to: (a) => browser.scrollRect(a?.sessionId, a?.rect),
  browser_settings: () => browser.settings(),
  browser_set_path: (a) => browser.setPath(a?.path),
  browser_pick_path: () => null, // native dialog: M5
  // ── still stubbed (browser slices in flight) ───────────────────────────
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

module.exports = { handle, EXPLICIT, agent, terminal, browser, remote };
