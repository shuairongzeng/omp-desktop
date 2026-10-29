/* ═════════════════════════════════════════════════════════════════════
   app-live.jsx — live-wired root.

   Session model: each tab owns one omp process. OMP_BRIDGE manages
   session lifecycle; the tab list and active session come from the
   bridge (snap.sessions / snap.activeSessionId). Switching tabs calls
   bridge.activateSession() which resets ALL per-session state and
   re-fetches from omp — so the right panel (sparkline, activity radar,
   minimap, kanban, context gauge) always reflects the active session.

   Constants and the cross-cutting effects (bridge subscription, theme)
   live in app/constants.js and app/use-bridge-snapshot.jsx respectively.
   Keyboard shortcuts are resolved by app/use-keymap.jsx (useKeymap loads
   the backend payload and resolves it; useKeymapDispatch installs the
   single window keydown listener) and handled by the handler map built
   below. This file owns only the App component itself: state
   declarations, handlers, and the render tree.
   ═════════════════════════════════════════════════════════════════════ */

const {
  Icon, ChatView, Composer, CommandBridge, WindowChrome, TabBar, TabMenu, ProjectMenu, SubagentPane, ProjectSidebar, EmptyWorkspace,
  StatusBar, AmbientRail, ConversationTree, PlanKanban, HistoryModal, GitBrowser, FilePreview, ApprovalRulesPanel, UsageStatsPanel, PromptHistoryModal, UpdateModal, useTweaks, QuotePopover,
  SettingsPage, ConfirmCloseDialog, RemotePairDialog,
  useWidgets, WidgetCard, WidgetErrorCard, WidgetApprovalCard, WidgetBoundary, PanelBoundary, AppBoundary,
  TWEAK_DEFAULTS, NULL_MODEL, EMPTY_PROJECT, DEFAULT_PROFILE_ID,
  INTENT_FRAMING, APPROVAL_PROMPT,
  useBridgeSnapshot, useThemeEffect, useBackgroundImage, useSubagentManager, useUpdater, useConversationTree, useGoalMode, useTerminal, TerminalPanels, timeNow,
  useKeymap, useKeymapDispatch, useBrowser, BrowserDock, MarkdownLinkContext: _AL_MdLinkCtx,
  usePaneWidths, ResizeHandle,
} = window;
const { routeSubmit: _routeSubmit } = window.OMP_SLASH;
const { mergeIntoMessage: _mergeBrowserChips, browserCommand: _browserCommand, MIN_WIDTH: _AL_BROWSER_MIN } = window.OMP_BROWSER;
const { recentRows, groupKey, moveGroup, moveMember, moveTab, shiftGroup, closeSet, basename: _AL_basename } = window.OMP_PROJECT_NAV;
const {
  entryOf, updateEntry, pruneEntries, seedEntries,
  PLAN_IDLE, togglePlan, enterPlan, approvePlan, annotatePlan, markPlanSent,
} = window.OMP_SESSION_UI;
const { NO_OVERRIDES: NO_COLLAPSE_OVERRIDES, foldModes: _foldModes, overridesForAll: _collapseOverridesForAll } = window.OMP_COLLAPSE;
const { tweakKey: _widgetTweakKey } = window.OMP_WIDGETS;
const { EMPTY: _EXT_EMPTY, cards: _extCards, toggles: _extToggles } = window.OMP_EXT_WIDGETS;
const { entryOf: _TERM_entryOf } = window.OMP_TERMINAL;
const { absolutePath: _gitAbsolutePath, finishedEdits: _gitFinishedEdits } = window.OMP_GIT_BROWSER;
const { linkClick: _fpLinkClick } = window.OMP_FILE_PREVIEW;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const data          = window.OMP_DATA;
  const bridge        = window.OMP_BRIDGE;

  // ── UI state ──────────────────────────────────────────────────────────────
  const [bridgeOpen,  setBridgeOpen]  = React.useState(false);
  const [bridgeView,  setBridgeView]  = React.useState("commands");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // Project folder the history modal preselects: the active tab's folder
  // from the tab bar, a sidebar group's folder from its "all …" row; null
  // (no tab) shows every project.
  const [historyCwd,  setHistoryCwd]  = React.useState(null);
  // Git browser: null, or { path, project } — the file it opens on (null =
  // the first changed file) and the project that path belongs to.
  const [gitOpen,     setGitOpen]     = React.useState(null);
  // The file preview (issue #39): `{ key, target }`, `key` the tab it was
  // opened in — it shows only while that tab is active.
  const [preview,     setPreview]     = React.useState(null);
  const [rulesOpen,   setRulesOpen]   = React.useState(false);
  const [statsOpen,   setStatsOpen]   = React.useState(false);
  const [promptHistoryOpen, setPromptHistoryOpen] = React.useState(false);
  // The Settings app tab (#37; app/settings-tab.js): `{open, active,
  // section}`. Not an omp tab: the active omp tab stays `activeSessionId`
  // underneath while the page covers the stage.
  const [stab, setStab] = React.useState(window.OMP_SETTINGS_TAB.initial);
  // live.js's pending "close a working tab / quit?" question, or null.
  const [closeConfirm, setCloseConfirm] = React.useState(null);
  const [planOpen,    setPlanOpen]    = React.useState(false);
  // The column beside the chat, per tab (`side` below): the ambient rail,
  // the conversation tree (prompt-cache navigator; design/conversation-tree.jsx,
  // app/use-conversation-tree.jsx) or the browser panel — one at a time.
  const [sides, setSides] = React.useState({});
  // Plan mode is per tab (issue #28; app/session-ui.js): one entry per
  // session id, read through `plan` and written through `updatePlan` below.
  const [plans, setPlans] = React.useState({});
  // Collapsed/expanded tool cards and thinking the user toggled (#44;
  // app/chat-collapse.js): per tab, `_id → collapsed`, so a tab switch —
  // which remounts ChatView — keeps them.
  const [collapseOverrides, setCollapseOverrides] = React.useState({});

  // Cross-component highlight: hovering a minimap cell lights up the
  // matching chat bubble; clicking scrolls to it.
  const [hoveredMsgIdx, setHoveredMsgIdx] = React.useState(null);
  const handleMinimapClick = (idx) => {
    const el = document.querySelector(`[data-msg-idx="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ── Live data (all per-session — driven by OMP_BRIDGE.onUpdate) ───────────
  const [messages,      setMessages]      = React.useState([]);
  const [streaming,     setStreaming]     = React.useState(false);
  const [exitReason,    setExitReason]    = React.useState(null);
  const [model,         setModelState]    = React.useState(NULL_MODEL);
  // #19: messages trimmed from the transcript head (live.js _trimMessages),
  // surfaced by the minimap's "−N earlier" badge.
  const [trimmedCount,  setTrimmedCount]  = React.useState(0);
  const [windowed,     setWindowed]      = React.useState(false);
  const [windowCursor, setWindowCursor]  = React.useState(null);
  // A tab's right-click menu (design/tab-menu.jsx): { tabId, x, y, counts }
  // while open; the bar's onContextMenu fills it, an action drains it.
  const [tabMenu, setTabMenu] = React.useState(null);
  // A sidebar project row's right-click menu (design/project-menu.jsx):
  // { path, x, y } while open. Desktop only — the phone drawer never gets
  // the onProjectMenu prop, so a long-press there stays a text selection.
  const [projectMenu, setProjectMenu] = React.useState(null);
  const [thinkingLevel, setThinkingLevel] = React.useState(null);
  const [ctx,           setCtx]           = React.useState(data.ctx);
  const [kanban,        setKanban]        = React.useState([]);
  const [planMeta,      setPlanMeta]      = React.useState(data.planMeta);
  const [models,        setModels]        = React.useState([]);
  const [activity,      setActivity]      = React.useState([]);
  const [sparkline,     setSparkline]     = React.useState(Array(30).fill(0));
  const [loginProviders, setLoginProviders] = React.useState(null);
  // Active tab's in-memory prompt history (issue #16) — see live.js
  // promptHistories. Never persisted; re-sourced from the bridge snapshot
  // on every update, same as any other per-session field here.
  const [promptHistory, setPromptHistory] = React.useState([]);
  const [globalPromptHistory, setGlobalPromptHistory] = React.useState([]);
  // Subagent manager (src/app/subagents.js shape) + the active tab's
  // on-demand agent transcripts.
  const [subagents,           setSubagents]           = React.useState(() => window.OMP_SUBAGENTS.emptySubagents());
  const [subagentTranscripts, setSubagentTranscripts] = React.useState({});
  // omp's steer / follow-up queue + this tab's unacknowledged sends
  // (app/message-queue.js), rendered by the composer's queue strip.
  const [queue,        setQueue]        = React.useState(() => window.OMP_QUEUE.EMPTY_QUEUE);
  const [queueSending, setQueueSending] = React.useState([]);
  // omp's goal mode for this tab (app/goal.js `{known, goal}`).
  const [goal,         setGoal]         = React.useState(() => window.OMP_GOAL.UNKNOWN);
  // Status lines and text widgets the active tab's omp extensions published
  // (app/extension-widgets.js, #52), drawn as rail cards.
  const [extWidgets,   setExtWidgets]   = React.useState(_EXT_EMPTY);

  // ── Tab list — driven by bridge session registry ──────────────────────────
  // Each entry: { id, name, path, color, branch }
  const [sessions,        setSessions]        = React.useState([]);
  const [activeSessionId, setActiveSessionId] = React.useState("");

  // ── Profiles — every selectable omp profile ({id, name}) ─────────────────
  // The profile itself is per tab (see sessions[].profile); this is just the
  // catalogue the selector renders.
  const [profiles,        setProfiles]        = React.useState([]);
  const [profilesDegraded, setProfilesDegraded] = React.useState(null);
  // Which profile is ticked as the default for new tabs / the next launch.
  // App-wide and persisted, unlike a tab's own profile.
  const [startupProfileId, setStartupProfileId] = React.useState(DEFAULT_PROFILE_ID);
  // Recently opened folders of the active tab's profile (project sidebar).
  const [recentProjects, setRecentProjects] = React.useState([]);
  // Saved sessions of the active profile, for the sidebar's per-project
  // history rows; refetched by the effect below near the sidebar wiring.
  const [savedSessions, setSavedSessions] = React.useState([]);
  // A project whose sidebar group must render expanded (the phone opens a
  // folder from recents and expects its conversations listed at once);
  // cleared when the user collapses any group or opens another folder.
  const [forceExpandPath, setForceExpandPath] = React.useState(null);
  // With no tab open: the profile the next tab opens under (the menu's pick,
  // else the startup default — resolved by the bridge), and notes filed
  // while there was no transcript to hold them.
  const [noTabProfileId, setNoTabProfileId] = React.useState(DEFAULT_PROFILE_ID);
  const [workspaceNotes, setWorkspaceNotes] = React.useState([]);
  // Tool approval mode `{ default, projects }` (app/approval-mode.js), null
  // until the bridge's boot fetch lands.
  const [approvalModes, setApprovalModes] = React.useState(null);

  // ── Cross-cutting effects ─────────────────────────────────────────────────
  // The window is created `visible: false` (tauri.conf.json) and revealed
  // after the first React commit, so the scripts' load — and, in dev, the
  // in-browser Babel transpile — never paints a white frame. Demo mode (no
  // `__TAURI__`) and the phone's remote shim (`__TAURI__` carries only
  // `core`/`event`, no `.window`) no-op through the optional chain; Rust's
  // `on_page_load` handler is the fallback if React never mounts. `show`
  // is idempotent.
  React.useEffect(() => {
    window.__TAURI__?.window?.getCurrentWindow?.()?.show?.()?.catch?.(() => {});
  }, []);
  useBridgeSnapshot(bridge, {
    setMessages, setStreaming, setExitReason, setCtx, setKanban, setPlanMeta, setTrimmedCount, setWindowed, setWindowCursor,
    setModels, setActivity, setSparkline,
    setModelState, setThinkingLevel,
    setSessions, setActiveSessionId, setProfiles, setProfilesDegraded, setStartupProfileId, setRecentProjects,
    setNoTabProfileId, setWorkspaceNotes, setApprovalModes, setCloseConfirm,
    setPromptHistory, setGlobalPromptHistory, setSubagents, setSubagentTranscripts, setQueue, setQueueSending, setGoal, setExtWidgets,
  });
  useThemeEffect(t);
  useBackgroundImage(t);
  // #16: focus layout has no rail ✕ undo — the status bar button (and the
  // `desktop.rail.toggle` action) flip the layout tweak back.
  const toggleRail = React.useCallback(() => {
    setTweak("layout", t.layout === "focus" ? "rail" : "focus");
  }, [setTweak, t.layout]);
  React.useEffect(() => {
    bridge?.setPromptHistoryLimit(t.promptHistoryLimit ?? window.OMP_PROMPT_HISTORY.DEFAULT_LIMIT);
  }, [bridge, t.promptHistoryLimit]);
  // Behaviours live.js owns (app/session-prefs.js): it takes its keys from
  // the tweaks and acts only on a changed one.
  React.useEffect(() => { bridge?.setSessionPrefs(t); }, [bridge, t]);

  // Summon (R7): the global hotkey / tray "show omp" focused the window and
  // live.js relayed the app://summon event as OMP_BRIDGE.onSummon. If the
  // Settings tab is what's showing, step back to the project tab it covers
  // (the same OMP_SETTINGS_TAB.selectProject every tab pick goes through) —
  // a summoned window whose stage is a settings page would otherwise leave
  // the composer buried under it. Then focus the composer's textarea, the
  // same window event desktop.composer.focus dispatches. `setStab`'s
  // updater form reads the current state, so no ref is needed.
  React.useEffect(() => {
    if (!bridge?.onSummon) return undefined;
    const off = bridge.onSummon(() => {
      setStab(s => window.OMP_SETTINGS_TAB.selectProject(s));
      window.dispatchEvent(new CustomEvent("omp:focus-composer"));
    });
    return off;
  }, [bridge]);
  // Refuse a file or link drop no handler took (`refusesStrayDrop`), so the
  // webview never navigates to it. In the app, file drops never reach the
  // page — Tauri's native file drop claims them (composer.jsx) — so this
  // guards links here and files in demo mode, where the composer's own
  // HTML5 handlers run first and accept their drops.
  React.useEffect(() => {
    const { refusesStrayDrop } = window.OMP_IMAGES;
    const { isTypingTarget } = window.OMP_KEYMAP;
    const refuse = e => {
      if (e.defaultPrevented) return;
      const el = e.target;
      const onEditable = el instanceof Element && isTypingTarget(el);
      if (!refusesStrayDrop(e.dataTransfer, onEditable)) return;
      e.preventDefault();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);

  // Fetch OAuth providers whenever the login view opens (ensures fresh auth status)
  React.useEffect(() => {
    if (!bridgeOpen || bridgeView !== "login") return;
    setLoginProviders(null);
    bridge?.getLoginProviders()
      .then(data => setLoginProviders(data?.providers ?? []))
      .catch(() => setLoginProviders([]));
  }, [bridgeOpen, bridgeView]);

  // Stable identities (round 3): these flow into memoised children —
  // StatusBar (React.memo) and ChatView's memoised AssistantBubbles — so
  // an inline closure would defeat the memo on every App re-render, which
  // streaming deltas trigger per frame. setStab/setBridgeView/setPlanOpen
  // are setState functions (stable); the window globals are frozen.
  const openSettings = React.useCallback(
    section => setStab(s => window.OMP_SETTINGS_TAB.open(s, section)), []);
  const openBridge = React.useCallback(
    view => { setBridgeView(view); setBridgeOpen(true); }, []);
  // ChatView's onOpenKanban: every AssistantBubble is React.memo'd, and an
  // inline `() => setPlanOpen(true)` here re-rendered all of them per
  // streaming delta. StatusBar's todo button shares it.
  const handleOpenKanban = React.useCallback(() => setPlanOpen(true), []);
  const closeSettings = React.useCallback(() => setStab(window.OMP_SETTINGS_TAB.close), []);

  // ── Derived values ────────────────────────────────────────────────────────
  const activeProject = sessions.find(s => s.id === activeSessionId) ?? sessions[0] ?? EMPTY_PROJECT;
  // No tab open → `activeProject` is EMPTY_PROJECT (built-in profile), but
  // the bridge spawns the next tab into the empty workspace's pick or the
  // ticked startup profile (nothing to inherit from) — so showing the
  // built-in would tick a profile that isn't where the next tab actually
  // goes. Shared by WindowChrome's menu, the keymap, recents and the
  // usage-stats panel's header label, instead of a second copy.
  const activeProfileId    = activeProject.id ? activeProject.profile : noTabProfileId;
// #10: the window title follows the active tab, with a run marker while a
// turn is live; no tab (and unmount) restores the plain app name. The
// folder comes from the tab's path (`OMP_PROJECT_NAV.basename`, the same
// segment the tab bar shows) and only when it is not already the name — a
// fresh tab is named after its folder, and "omp-desktop · omp-desktop"
// says nothing.
React.useEffect(() => {
  const prev = document.title;
  const folder = activeProject.path ? _AL_basename(activeProject.path) : "";
  const withFolder = folder && folder !== activeProject.name ? `${activeProject.name} · ${folder}` : activeProject.name;
  // Background tabs waiting on the user stay visible in the title even when
  // the active tab is idle — the count is the whole point of the badge.
  const waiting = sessions.filter(s => s.runState === "waiting-user").length;
  const badge = waiting > 0 ? `(${waiting} 待审批) ` : "";
  document.title = activeProject.id
    ? `${badge}${streaming ? "● " : ""}${withFolder} — OMP Desktop`
    : (badge ? `${badge}OMP Desktop` : "OMP Desktop");
  return () => { document.title = prev; };
}, [activeProject.id, activeProject.name, activeProject.path, streaming, sessions]);

  // ── OS notifications (app/notify.js, tauri-plugin-notification) ─────────
  // A tab flipping busy → idle (notifyDone) or → waiting-user (notifyAsk)
  // fires a system notification — but only when nobody is looking at that
  // tab (window hidden, or the tab is in the background). `shouldNotify`
  // holds the decision matrix; tested in tests/test-notify.mjs.
  const notifyPrevRef = React.useRef(new Map()); // sessionId → runState
  React.useEffect(() => {
    const N = window.OMP_OSNOTIFY;
    if (!N) return;
    const prev = notifyPrevRef.current;
    const next = new Map();
    for (const s of sessions) {
      if (!s?.id) continue;
      next.set(s.id, s.runState);
      const before = prev.get(s.id);
      if (before === undefined || before === s.runState) continue;
      const kind = s.runState === "waiting-user" ? "ask" : "done";
      if (!N.shouldNotify({
        // shouldNotify's busy side is {busy, running}: normalise the other
        // in-flight states onto "busy" so retrying/background also notify.
        prevRun: ["running", "retrying", "background"].includes(before) ? "busy" : before,
        nextRun: s.runState,
        documentHidden: document.hidden,
        isActiveTab: s.id === activeSessionId,
        tweaks: t,
      })) continue;
      const folder = s.path ? _AL_basename(s.path) : "";
      N.fire(kind, { sessionTitle: s.title || "", projectName: folder });
    }
    notifyPrevRef.current = next;
  }, [sessions, activeSessionId, t]);
  const activeProfileLabel = profiles.find(p => p.id === activeProfileId)?.name ?? activeProfileId;
  // Status-bar approvals cell: the mode the rendered tab's omp runs, or
  // `running ⇢ target` while a change waits for its turn to end. Read
  // late-bound: app/approval-mode.js is a plain module like the others.
  // Memoised on its real inputs — the view plus the active tab's id/path/
  // running mode, everything statusCell reads — so a new object per render
  // doesn't defeat StatusBar's React.memo (round 3). `sessions` is rebuilt
  // per snapshot, so `activeProject`'s identity churns on every delta; the
  // deps below hold stable through them.
  const approvalCell = React.useMemo(
    () => window.OMP_APPROVAL_MODE.statusCell(approvalModes, activeProject.id ? activeProject : null),
    [approvalModes, activeProject.id, activeProject.path, activeProject.approvalMode]);
  // The tab being rendered owns the plan state: keyed on `activeProject.id`
  // for the same reason as `handleSelectProfile` below, and "" with no tab
  // open, which `updateEntry` ignores.
  const planKey = activeProject.id;
  const plan    = entryOf(plans, planKey, PLAN_IDLE);
  const updatePlan = React.useCallback(
    fn => setPlans(m => updateEntry(m, planKey, PLAN_IDLE, fn)), [planKey]);
  const handleAnnotate = React.useCallback(
    (idx, value) => updatePlan(p => annotatePlan(p, idx, value)), [updatePlan]);
  // "rail" (the idle entry, also with no tab open), "tree" or "browser".
  const side = entryOf(sides, planKey, "rail");
  const setSide = React.useCallback(
    next => setSides(m => updateEntry(m, planKey, "rail", () => next)), [planKey]);
  // `side` read through a ref so the two StatusBar toggles below stay
  // reference-stable (their identity feeds StatusBar's React.memo) without
  // re-creating them whenever the side column changes.
  const sideRef = React.useRef(side);
  sideRef.current = side;
  const toggleSide = React.useCallback(
    kind => setSide(sideRef.current === kind ? "rail" : kind), [setSide]);
  const handleOpenTree = React.useCallback(() => setSide("tree"), [setSide]);
  const setBrowserOpen = React.useCallback(
    on => setSides(m => updateEntry(m, planKey, "rail", s => (on ? "browser" : s === "browser" ? "rail" : s))), [planKey]);
  const tabCollapseOverrides = entryOf(collapseOverrides, planKey, NO_COLLAPSE_OVERRIDES);
  const handleToggleCollapse = React.useCallback(
    (id, collapsed) => setCollapseOverrides(m => updateEntry(m, planKey, NO_COLLAPSE_OVERRIDES, o => ({ ...o, [id]: !collapsed }))),
    [planKey]);
  const foldModes = _foldModes(t);
  // Stable per tab: ToolCard is memoised, an inline closure would re-render
  // every card. omp reports a tool path relative to the tab's folder, Rust
  // reads a relative path as repo-root-relative, so it goes over absolute.
  const gitProject = activeProject.path ?? null;
  const handleOpenFile = React.useCallback(
    path => setGitOpen({ path: _gitAbsolutePath(gitProject, path), project: gitProject }),
    [gitProject]);
  const closeGit = React.useCallback(() => setGitOpen(null), []);
  // A read card's path: the preview, bound to this tab.
  const handlePreviewFile = React.useCallback(
    target => setPreview({ key: planKey, target }), [planKey]);
  const closePreview = React.useCallback(() => setPreview(null), []);
  const previewToGit = React.useCallback(path => { setPreview(null); handleOpenFile(path); }, [handleOpenFile]);
  // The git browser refetches when this count rises; counted only while it
  // is open, and handed over as a number so streaming frames that finish no
  // edit leave the memoised browser alone.
  const gitEdits = React.useMemo(() => (gitOpen ? _gitFinishedEdits(messages) : 0), [gitOpen, messages]);
  // Collapse all / Expand all: one toggle per block in this tab, replacing
  // the tab's earlier ones; later blocks follow the modes again.
  const handleCollapseAll = (collapsed) => setCollapseOverrides(m => updateEntry(m, planKey, NO_COLLAPSE_OVERRIDES,
    () => _collapseOverridesForAll(messages, collapsed, { hidden: window.OMP_TURN_STATUS.isHidden })));
  // Another omp tab shown (opened, picked, restored) leaves the settings tab.
  React.useEffect(() => { setStab(window.OMP_SETTINGS_TAB.selectProject); }, [activeSessionId]);
  // Tab ids, for dropping the per-tab state of closed tabs (here and in
  // the composer's drafts). live.js rebuilds `sessions` on every snapshot,
  // streaming deltas included, so the list is memoised on the ids' content:
  // the prune effects run only when a tab opens or closes.
  const sessionIdsKey = sessions.map(s => s.id).join("\0");
  const sessionIds = React.useMemo(() => (sessionIdsKey ? sessionIdsKey.split("\0") : []), [sessionIdsKey]);
  // A tab seen for the first time starts with the `defaultSide` setting;
  // tabs already open keep theirs when the setting changes.
  const seenSideIds = React.useRef(new Set());
  React.useEffect(() => {
    const fresh = sessionIds.filter(id => !seenSideIds.current.has(id));
    seenSideIds.current = new Set(sessionIds);
    setPlans(m => pruneEntries(m, sessionIds));
    setCollapseOverrides(m => pruneEntries(m, sessionIds));
    setSides(m => seedEntries(pruneEntries(m, sessionIds), fresh, "rail", t.defaultSide ?? "rail"));
  }, [sessionIds]);
  // Profile chip text for a tab/project: none for the built-in profile (same
  // expression as TabBar's own copy, which labels the tab bar).
  const profileLabel = id =>
    id === DEFAULT_PROFILE_ID ? null : (profiles.find(p => p.id === id)?.name ?? id);
  const todoCounts    = kanban.reduce(
    (acc, col) => {
      acc.total += col.tasks.length;
      acc.done  += col.tasks.filter(tk => tk.status === "done").length;
      return acc;
    },
    { total: 0, done: 0 }
  );

  // ── Keymap ────────────────────────────────────────────────────────────────
  // The derived profile, not the tab's own: with no tab open it follows the
  // startup default / empty-workspace pick, which must reload the omp layer.
  const keymap = useKeymap(bridge, activeProfileId);

  // One shell per tab, in a panel above the composer (app/use-terminal.jsx).
  const terminal = useTerminal({
    bridge, activeSessionId: planKey, sessionIds, tweaks: t, setTweak,
  });

  // StatusBar's button handlers (round 3): the bar is React.memo'd, so
  // each of its eight closures must hold a stable identity across App
  // re-renders or the memo never bails out. planKey/terminal.toggle/
  // setGitOpen/setRulesOpen/setStatsOpen/toggleSide are stable; the
  // terminal one reads the tab id through a ref so a tab switch doesn't
  // leave the closure stale (it's recreated per planKey anyway, which the
  // bar already re-renders on — keying on the ref is for the tree toggle
  // sharing below).
  const planKeyRef = React.useRef(planKey);
  planKeyRef.current = planKey;
  const handleOpenChanges  = React.useCallback(() => setGitOpen({ path: null }), []);
  const handleOpenRules    = React.useCallback(() => setRulesOpen(true), []);
  const handleOpenStats    = React.useCallback(() => setStatsOpen(true), []);
  const handleToggleTree   = React.useCallback(() => toggleSide("tree"), [toggleSide]);
  const handleToggleBrowser = React.useCallback(() => toggleSide("browser"), [toggleSide]);
  const handleToggleTerminal = React.useCallback(
    () => terminal.toggle(planKeyRef.current), [terminal.toggle]);
  const openSettingsNoSection = React.useCallback(() => openSettings(), [openSettings]);

  const subagentUi = useSubagentManager({
    bridge, layout: t.layout, setTweak, activeSessionId, subagents, messages, setHoveredMsgIdx,
  });
  const subagentList = React.useMemo(() => window.OMP_SUBAGENTS.listAgents(subagents), [subagents]);

  const updater = useUpdater({ bridge, autoCheck: t.updateCheck ?? true, skipped: t.skippedUpdate, setTweak });

  // The browser panel (app/use-browser.jsx). `activeProject.id`, like the
  // widgets below, not `activeSessionId`, which keeps a closed tab's id.
  const browser = useBrowser({
    bridge, activeSessionId: activeProject.id, sessionIds, open: side === "browser", setOpen: setBrowserOpen, tweaks: t, setTweak,
  });
  // Clicks on links in the agent's markdown: a project file opens the
  // preview (Ctrl/⌘-click: the git browser); anything else goes on to the
  // browser panel's localhost handler. Without this a relative link would
  // navigate the webview, which navigation_guard.rs silently blocks.
  const browserLinkClick = browser.onChatClick;
  const handleChatLinkClick = React.useCallback(e => {
    const file = _fpLinkClick(e, gitProject);
    if (!file) { browserLinkClick?.(e); return; }
    e.preventDefault();
    if (file.git) handleOpenFile(file.target.path);
    else handlePreviewFile(file.target);
  }, [browserLinkClick, gitProject, handleOpenFile, handlePreviewFile]);
  const stageRef = React.useRef(null);
  // A chip click scrolls the panel to the annotated element — but only
  // when the panel is open and still on the page the chip was picked from
  // (`browser.state.url` is the hook's current page, `planKey` the chips'
  // own tab). A pick from another page has no rect there; a closed panel
  // has no page to scroll (the bridge call is quiet anyway).
  const handleBrowserChipClick = (chip) => {
    if (!browser.open || !chip?.pick?.docRect || chip.pick.url !== browser.state.url) return;
    bridge?.browserScrollTo(planKey, chip.pick.docRect);
  };
  // `/browser [url]`: open the panel, load a page, or answer omp's
  // `headless|visible` with a note (OMP_BROWSER.browserCommand).
  const handleBrowserCommand = (args) => {
    const r = _browserCommand(args);
    if (r.open) setBrowserOpen(true);
    else if (r.url) browser.openUrl(r.url);
    else bridge?.addAssistantMessage(r.note);
  };

  // `activeProject.id`, not `activeSessionId`: the latter keeps a closed
  // tab's id (see handleSelectProfile below). Widgets only run while the
  // rail is on screen — not in focus layout, not under the tree or browser,
  // not under the Settings tab, which covers the stage (`.st-host`).
  const widgets = useWidgets({
    bridge, activeSessionId: activeProject.id, sessionIds, railVisible: t.layout !== "focus" && side === "rail" && !stab.active, tweaks: t,
  });
  // Pushed by omp, not run by the desktop: nothing to schedule, only a
  // Settings → Rail toggle per card (`widget:ext-status`, `widget:ext:<key>`).
  const extCards = React.useMemo(() => _extCards(extWidgets), [extWidgets]);
  const extToggles = React.useMemo(() => _extToggles(extWidgets), [extWidgets]);

  // Handler map read through a ref so the dispatch effect never re-subscribes.
  const handlersRef = React.useRef({});
  useKeymapDispatch(handlersRef);

  // ── `omp:mobile` (phone redesign) ────────────────────────────────────────
  // PkgA's composer action sheet and the drawer's app menu (PkgB) dispatch
  // `omp:mobile` with `{ action }`; this is the app's single listener,
  // mapping each action onto the existing state setters — no new state.
  // Registered once on mount; the handlers read this render's setters and
  // terminal through a ref so they never go stale. open-settings first
  // drops the drawer (`mobile-sidebar-open` on <html>): the drawer (z-60)
  // would paint over the settings page (z-20) it just opened.
  const mobileHandlersRef = React.useRef(null);
  mobileHandlersRef.current = {
    "open-settings": () => openSettings(),
    "open-terminal": () => terminal.toggle(planKeyRef.current),
    "open-usage":    () => setStatsOpen(true),
    "open-git":      () => setGitOpen({ path: null }),
    "open-bridge":   () => openBridge(),
    // The phone topbar's clock (chrome.jsx): the full history modal with
    // no project filter — the desktop's Ctrl+H.
    "open-history":  () => openHistory(null),
    // Composer ＋ sheet: new conversation in the current project — the
    // desktop tab bar's always-visible ＋. (Called from the event listener,
    // long after this render completed — the closure is fresh.)
    "open-new":      () => { if (activeProject.path) handleNewInProject(activeProject.path); },
  };
  React.useEffect(() => {
    const onMobile = e => {
      const action = e?.detail?.action;
      const run = mobileHandlersRef.current?.[action];
      if (!run) return;
      document.documentElement.classList.remove("mobile-sidebar-open");
      run();
    };
    window.addEventListener("omp:mobile", onMobile);
    return () => window.removeEventListener("omp:mobile", onMobile);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  // Where a submit goes (OMP_SLASH.routeSubmit): decided on the typed draft.
  const routeOf = (msg, followUp) => _routeSubmit(data.commands, msg, {
    goalMode: goalUi.mode, followUp, streaming, connected: Boolean(bridge?.isConnected),
  });
  // The tab's browser annotations go out with a submit like the rest of the
  // draft: taken at once (chips added since stay for the next message) and
  // merged after the typed text and images (OMP_BROWSER.mergeIntoMessage:
  // image cap, page data fenced and neutralised, so the merge never turns a
  // message into a command). A command takes none: they wait for the next
  // message. Returns the merge plus the chips taken (`chips`), which a
  // failed goal start hands back with its draft.
  const takeBrowserChips = (text, images, route) => {
    const chips = route.isCmd ? [] : browser.chips;
    if (chips.length) browser.takeChips(chips.map(c => c.id));
    return { ..._mergeBrowserChips(text, images ?? [], chips), chips };
  };
  const startGoal = (msg, images, route) => {
    const out = takeBrowserChips(msg, images, route);
    goalUi.start({ text: msg, images, chips: out.chips }, out);
  };
  const handleSend = (text, images) => {
    const hasAnnotations = Object.keys(plan.annotations).length > 0;
    if (!text.trim() && !hasAnnotations && !(images && images.length > 0) && !browser.chips.length) return;
    let msg = text.trim();
    // A slash command (typed by hand, or inserted by picking a non-desktop
    // entry from the `/` popup or the ⌘K bridge) must reach omp with its
    // leading `/` at position 0, or omp's dispatcher never recognizes it as
    // a command — it just becomes ordinary prose. Checked against the real
    // command list, not just "starts with /": plan-mode prose routinely
    // starts with a path ("/etc/nginx.conf is wrong"), which both
    // plan-mode rewrites below would otherwise skip by mistake. A skill
    // invoked mid-prompt ("review this /skill:code-review", #30) counts as
    // a command too: it is sent as typed, like a leading `/skill:x`.
    // `routeOf` classifies the typed draft, before any page data merges.
    const route = routeOf(msg, false);
    // Usage stats for the composer's frequent-command pills: only a draft
    // that leads with a listed command counts (a typed path in plan prose
    // is not a command — same predicate as routeOf).
    if (route.isCmd) {
      const lead = (/^\/([^\s/]+)/.exec(msg) || [])[1];
      if (lead && data.commands.some(c => c.name === lead || (c.aliases ?? []).includes(lead))) {
        const next = window.OMP_SLASH_USAGE.record(slashUsage, lead);
        setSlashUsage(next);
        window.OMP_SLASH_USAGE.save(next);
      }
    }
    // Goal mode (app/use-goal-mode.jsx): the typed text is the goal's
    // objective. Plan mode cannot be on at the same time; a command still
    // runs as one. Browser annotations ride along in the goal's first
    // prompt (not in the stored objective); a refusal hands the typed
    // draft back, chips included.
    if (route.via === "goal") {
      startGoal(msg, images, route);
      return;
    }
    if (plan.mode && !route.isCmd) {
      if (hasAnnotations) {
        // Feedback with block comments — always takes priority over intent framing
        const lineComments = Object.entries(plan.annotations)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, { raw, comment }]) => {
            const quoted = raw.split('\n').map(l => `> ${l}`).join('\n');
            return `${quoted}\n→ ${comment.trim()}`;
          }).join('\n\n');
        const parts = ['Line comments:\n' + lineComments, text.trim()].filter(Boolean);
        msg = parts.join('\n\n');
        updatePlan(markPlanSent); // annotations imply plan is already in progress; spends them
      } else if (!plan.started) {
        // First clean send — wrap in intent framing. trimEnd() matters for an
        // image-only send (empty text): INTENT_FRAMING's template ends in a
        // literal "\n\n" that .trim() on the intent argument never touches,
        // and the server's message_start echo arrives already .trim()med
        // (live.js) — an untrimmed local echo would fail that dedup compare
        // and double-render the bubble.
        updatePlan(markPlanSent);
        msg = INTENT_FRAMING(text.trim()).trimEnd();
      }
    }
    // Browser annotations join the message last, after plan framing, so only
    // what was typed is framed.
    const out = takeBrowserChips(msg, images, route);
    if (route.via === "steer") bridge?.steer(out.text, out.images);
    else if (route.via === "prompt") bridge.send(out.text, out.images);
    else setMessages(prev => [...prev, { kind: "user", time: timeNow(), text: out.text, images: out.images }]);
  };

  const handleAbort      = () => { bridge?.abort(); setStreaming(false); };
  const handlePickModel  = m  => { setModelState(m); bridge?.setModel(m); };
  const handleAskAnswer  = React.useCallback((id, value) => { bridge?.answerAsk(id, value); }, [bridge]); // bridge = window.OMP_BRIDGE, assigned once before React renders — stable ref
  const handleAskDialogAnswer = React.useCallback((id, answers) => { bridge?.answerAskDialog(id, answers); }, [bridge]);
  const handleConfirmAsk = React.useCallback((id, confirmed) => { bridge?.answerConfirm(id, confirmed); }, [bridge]);
  const handleCancelAsk  = React.useCallback((id) => { bridge?.cancelAsk(id); }, [bridge]);
  const handleGrantApproval = React.useCallback((prompt, scope) => { bridge?.approveAndRemember(prompt, scope); }, [bridge]);
  const handleStopRetry  = React.useCallback(() => bridge?.stopRetry(), [bridge]);
  const handlePickLogin = async (provider) => {
    if (!bridge) return;
    try {
      // OMP_BRIDGE.login resolves when OAuth completes (≤300 s).
      // live.js handles extension_ui_request.open_url via open_url_external (system browser).
      // For already-authenticated providers omp refreshes the token silently (no browser).
      // Use bridge.addAssistantMessage — writes into state.messages so the message
      // survives any subsequent notify() call (e.g. model registry refresh after login).
      await bridge.login(provider.id);
      bridge.addAssistantMessage(`Logged in to **${provider.name}**.`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      bridge.addAssistantMessage(`**Login failed (${provider.name}):** ${msg}`);
    }
  };
  const cycleThinking    = () => bridge?.cycleThinking();

  // Extracted so both the global keymap handler and the composer prop share
  // the same implementation (plan §7: "extract into a togglePlanMode callback").
  // Plan mode and a goal exclude each other, as in omp: the toggle only
  // turns plan mode off while the tab has a goal (or is in goal mode).
  const togglePlanMode = () => {
    if (!plan.mode && goalUi.planBlocked) return;
    updatePlan(togglePlan);
  };

  // Composer-scoped follow-up: the composer owns the draft text. Re-trim
  // here (mirrors handleSend's `msg = text.trim()`) — expandPastes runs
  // after the composer's own trim and can reintroduce leading/trailing
  // whitespace from the raw pasted content. In goal mode the follow-up
  // chord starts the goal too, like Enter (handleSend). The tab's browser
  // annotations ride along as they do with a send.
  const handleFollowUp = (text, images) => {
    const msg = text.trim();
    const route = routeOf(msg, true);
    if (route.via === "goal") {
      startGoal(msg, images, route);
      return;
    }
    const out = takeBrowserChips(msg, images, route);
    bridge?.followUp(out.text, out.images);
  };
  // Queue strip actions: resolve `true` once omp edited its queue.
  const handleRemoveQueued  = (text, kind) => bridge?.removeQueuedMessage(text, kind);
  const handlePromoteQueued = text => bridge?.promoteQueuedMessage(text);
  const handleSendQueuedNow = (text, kind) => bridge?.sendQueuedNow(text, kind);

  // CommandBridge (⌘K) picking a non-desktop (RPC) command — no local
  // handler exists for it, unlike handleCommand's desktop entries. It has
  // no textarea of its own, so it hands the `/name ` draft up here for the
  // Composer to pick up and focus; the user fills in arguments and Enter
  // sends it as a normal prompt, which omp executes.
  const [draftInsert, setDraftInsert] = React.useState(null);
  const handleInsertDraft = (text) => setDraftInsert({ text, nonce: Date.now() });

  // Prompt-history picker (Ctrl+Up modal, issue #16) — same {text, nonce}
  // shape and rationale as draftInsert above, but *replaces* the draft (see
  // composer.jsx's promptInsert effect) rather than prepending. Rail widget
  // inserts set `append` instead: they go after the draft
  // (OMP_WIDGETS.appendToDraft), since ⌘K's draftInsert replaces a
  // `/command` draft.
  const [promptInsert, setPromptInsert] = React.useState(null);
  const handlePickHistoryPrompt = (text) => setPromptInsert({ text, nonce: Date.now() });
  const handleWidgetInsert = React.useCallback(text => setPromptInsert({ text, append: true, nonce: Date.now() }), []);
  // Your most-used slash commands (app/slash-usage.js): recorded on every
  // send whose draft leads with a command omp actually lists, so the
  // composer's foot row can offer the top three as one-click pills. The
  // list re-filters on every commands update — a command omp dropped
  // (deleted skill, renamed builtin) hides without touching the counts.
  const [slashUsage, setSlashUsage] = React.useState(() => window.OMP_SLASH_USAGE.load());
  React.useEffect(() => {
    setSlashUsage(window.OMP_SLASH_USAGE.load());
  }, [data.commands]);

  // Quote-into-composer: a finished selection inside the chat transcript
  // floats an "Add to prompt" pill at its end (rules and placement in
  // OMP_QUOTE); picking it appends the captured text to the draft.
  const [quote, setQuote] = React.useState(null); // { x, y, text } | null
  React.useEffect(() => {
    const Q = window.OMP_QUOTE;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    let selTimer = 0;
    const place = (sel) => {
      const text = Q.quotableText(sel);
      if (!text) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const { x, y } = Q.popoverPos(rect, window.innerWidth, window.innerHeight);
      setQuote({ x, y, text });
    };
    const onMouseUp = () => {
      const sel = window.getSelection();
      place(sel); // a collapsed selection is handled by selectionchange
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { clearTimeout(selTimer); setQuote(null); return; }
      // Touch long-press selections never fire mouseup — once the selection
      // has been stable for a beat, offer the pill too.
      if (!coarse) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const s2 = window.getSelection();
        if (s2 && !s2.isCollapsed) place(s2);
      }, 350);
    };
    const onMouseDown = (e) => { if (!e.target.closest?.(".quote-pop")) setQuote(null); };
    const onKey = (e) => { if (e.key === "Escape") setQuote(null); };
    // Capture phase: a scroll inside .chat-scroll doesn't bubble, but any
    // scroll moves the rect the pill was placed from — retract either way.
    const onScroll = (e) => { if (e.target?.closest?.(".chat-scroll")) setQuote(null); };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(selTimer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);
  const handleQuotePick = () => {
    setQuote(q => {
      if (q) setPromptInsert({ text: q.text, append: true, nonce: Date.now() });
      return null;
    });
    window.getSelection()?.removeAllRanges();
  };

  // Goal mode in the composer and the goal strip above it (omp's `goal`).
  const goalUi = useGoalMode({
    bridge, tabId: planKey, sessionIds, goal, planMode: plan.mode, profileId: activeProfileId,
    runState: activeProject.runState,
    // The chips go back to the tab they were taken from whatever tab is
    // shown; the text only into the composer of that tab still shown.
    onRestoreDraft: ({ text, images, chips }, { tabId, shown }) => {
      if (shown) setPromptInsert({ text, images, nonce: Date.now() });
      browser.restoreChips(chips ?? [], tabId);
    },
  });

  // Conversation tree data + actions. A successful "branch here" puts the
  // re-asked prompt into the composer through `promptInsert` (replaces the
  // draft). `sessionFile` comes with every snapshot's tab entry: it changes
  // when branch/fork/new move the process onto another file, which refetches.
  const convTree = useConversationTree({
    bridge, open: side === "tree", sessionId: activeProject.id, sessionFile: activeProject.sessionFile ?? null,
    profileId: activeProfileId, processStartedAt: activeProject.processStartedAt ?? null,
    streaming, onBranchText: text => setPromptInsert({ text, nonce: Date.now() }),
  });

  // `args`: text typed after a desktop command in the composer (composer.jsx
  // `execCmd`); empty from the ⌘K bridge.
  const handleCommand = (c, args = "") => {
    if      (c.name === "plan")      { if (!goalUi.planBlocked) updatePlan(enterPlan); }
    // `/goal <objective>`: goal mode with the objective back in the
    // composer, budget still to pick; Enter starts it. Blocked (plan mode,
    // a goal already open), the text still comes back.
    else if (c.name === "goal")      { goalUi.enter(); if (args) setPromptInsert({ text: args, nonce: Date.now() }); }
    else if (c.name === "todo")      { setPlanOpen(true); }
    else if (c.name === "browser")   { handleBrowserCommand(args); }
    else if (c.name === "compact")   { bridge?.compact(); }
    else if (c.name === "tree" || c.name === "branch") { setSide("tree"); }
    else if (c.name === "export")    { bridge?.exportHtml(); }
    else if (c.name === "thinking")  { cycleThinking(); }
    else if (c.name === "model")     { openBridge("models"); }
    else if (c.name === "login")     { openBridge("login"); }
    else if (c.name === "new")       { bridge?.newSession(); }
    else if (c.name === "history")   { openHistory(activeProject?.path); }
    else if (c.name === "shortcuts") { openSettings("shortcuts"); }
    else if (c.name === "check-updates") { updater.check(); }
    else if (c.name === "collapse-all")  { handleCollapseAll(true); }
    else if (c.name === "expand-all")    { handleCollapseAll(false); }
    else if (c.name === "settings")  { openSettings(); }
    else if (c.name === "terminal")  { terminal.toggle(planKey); }
  };

  const handleResumeSession = async (session) => {
    if (!bridge || !session) return;
    try {
      await bridge.resumeSession(session);
    } catch (err) {
      // Same dangling-profile rejection as openSession (see handleNewProject
      // below) — the bridge already rolled back its ghost tab registration.
      console.error("[app] failed to resume session:", err);
    }
  };

  const handleApprovePlan = () => {
    updatePlan(approvePlan);
    bridge?.followUp(APPROVAL_PROMPT);
    setPlanOpen(true);
  };

  // Tab select — switches the active session; bridge resets all per-session state
  // and re-fetches from the new session's omp → notify() pushes fresh data.
  const handleSelectTab = id => {
    setStab(window.OMP_SETTINGS_TAB.selectProject);
    if (id === activeSessionId) return;
    bridge?.activateSession(id);
    // setActiveSessionId is driven by snap.activeSessionId from onUpdate
  };

  // Open project → new session → new tab with its own omp process. On the
  // phone the native dialog is unreachable (the shim refuses
  // `open_project`), so the folder sheet takes its place.
  const handleNewProject = async () => {
    if (!bridge) return;
    if (window.OMP_MOBILE?.isRemote?.()) {
      setFolderError(null);
      setFolderSheet(true);
      return;
    }
    const path = await bridge.pickFolder();
    if (!path) return;
    try {
      await bridge.openSession(path);
      // Tab list and activeSessionId are updated via onUpdate from the bridge
    } catch (err) {
      // openSession rejects when the inherited/ticked profile no longer
      // exists (deleted by another window, or a hand-edited profiles.json)
      // and the backend refuses to spawn under it — the bridge already
      // rolled back the ghost tab registration, so there's nothing left to
      // undo here; just keep the rejection from going unhandled.
      console.error("[app] failed to open project:", err);
    }
  };

  // ── phone folder sheet (remote control) ────────────────────────────────
  // The sheet's rows are the desktop's own recent folders plus a typed
  // path; submitting goes through `open_project_at`, whose desktop handler
  // opens the folder exactly as the desktop's own picker would.
  const [folderSheet, setFolderSheet] = React.useState(false);
  const [folderPath, setFolderPath] = React.useState("");
  const [folderBusy, setFolderBusy] = React.useState(false);
  const [folderError, setFolderError] = React.useState(null);
  // Directory browser inside that sheet: the folder being listed (null =
  // the device's roots), its parent for the up button, and the listing.
  const [dirPath, setDirPath] = React.useState(null);
  const [dirParent, setDirParent] = React.useState(null);
  const [dirEntries, setDirEntries] = React.useState([]);
  const [dirBusy, setDirBusy] = React.useState(false);
  const [dirError, setDirError] = React.useState(null);

  const openRemoteProject = async (path) => {
    const p = (path || "").trim();
    if (!p || folderBusy) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const id = await bridge.openProjectAt(p);
      if (id) {
        // The desktop registered the tab in its own registry; pull it into
        // this client's copy and switch to it before the sheet closes, so
        // the new conversation is on screen without a manual resync.
        await bridge.syncRemoteTabs();
        await bridge.activateSession(id);
        setFolderSheet(false), setFolderPath("");
      } else setFolderError("the desktop could not open that folder");
    } catch (err) {
      setFolderError(String(err?.message ?? err));
    } finally {
      setFolderBusy(false);
    }
  };

  // Phone windowed transcript: page one older window up. live.js routes the
  // fetch to the desktop executor's slice on a handset; a desktop tab is
  // never windowed, so the chat view's row (and this) stays inert there.
  const handleLoadOlder = React.useCallback(() => { bridge?.loadOlderMessages(); }, [bridge]);

  // List one folder in the sheet's browser (null = the device's roots).
  // A failure keeps the last listing on screen and reports the message.
  const loadRemoteDirs = React.useCallback(async (path) => {
    if (!bridge) return;
    setDirBusy(true);
    setDirError(null);
    try {
      const listing = await bridge.listDirs(path ?? null);
      setDirPath(path ?? null);
      setDirParent(listing?.parent ?? null);
      setDirEntries(Array.isArray(listing?.entries) ? listing.entries : []);
    } catch (err) {
      setDirError(String(err?.message ?? err));
    } finally {
      setDirBusy(false);
    }
  }, [bridge]);

  // Opening the sheet starts at this device's roots; closing it drops the
  // listing so the next open never flashes a stale folder.
  React.useEffect(() => {
    if (!folderSheet) {
      setDirPath(null);
      setDirParent(null);
      setDirEntries([]);
      setDirError(null);
      setDirBusy(false);
      return;
    }
    loadRemoteDirs(null);
  }, [folderSheet, loadRemoteDirs]);

  // Close tab → kills that session's omp process; bridge updates tab list.
  // Guarded: with `confirmBusyClose` a working tab asks first (live.js).
  const handleCloseTab = id => { bridge?.closeSessionGuarded(id); };
  // Manual rename (#32): omp's `/rename <title>` via the bridge, which
  // activates a background tab first and keeps the transcript clean.
  const handleRenameTab = (id, title) => { bridge?.renameSession(id, title); };

  // ── Project navigation (#27) ──────────────────────────────────────────────
  const showSidebar   = t.sidebar ?? true;
  const toggleSidebar = () => setTweak("sidebar", !showSidebar);

  // The history modal opens preselected on a project's chip: the active
  // tab's folder from the tab bar /command, a group's folder from the
  // sidebar's "all …" row.
  const openHistory = path => { setHistoryCwd(path || null); setHistoryOpen(true); };

  // Saved sessions for the sidebar's per-project history rows, scanned from
  // the active profile's on-disk tree (`listSavedSessions`). Refetched when
  // the sidebar shows, the profile or tab count changes, or a turn starts
  // or ends — the .jsonl the agent just touched joins or leaves the list.
  React.useEffect(() => {
    if (!showSidebar || !bridge?.listSavedSessions) return;
    let cancelled = false;
    bridge.listSavedSessions()
      .then(list => { if (!cancelled) setSavedSessions(list || []); })
      .catch(err => console.error("[app] failed to list saved sessions:", err));
    return () => { cancelled = true; };
  }, [bridge, showSidebar, activeProfileId, streaming, sessions.length]);

  // A recent project: focus its open tab in the active profile, else spawn.
  const handleOpenRecent = async path => {
    if (!bridge) return;
    try {
      await bridge.openProject(path);
      // The new tab's group would render collapsed when the user last
      // collapsed it (or never expanded it): opening a folder from
      // recents is an explicit "show me this project" gesture, so force
      // its group open and refresh the history rows it lists.
      setForceExpandPath(path);
      bridge.listSavedSessions().then(list => setSavedSessions(list || [])).catch(() => {});
    } catch (err) {
      // Same rejection/rollback as openSession (see handleNewProject).
      console.error("[app] failed to open recent project:", err);
    }
  };

  // "New conversation" in a project: always a new tab, under the project's
  // own profile rather than the active tab's.
  const handleNewInProject = async (path, profile) => {
    if (!bridge) return;
    try {
      await bridge.openSession(path, profile);
    } catch (err) {
      console.error("[app] failed to open conversation:", err);
    }
  };

  const handleForgetRecent = path => { bridge?.forgetRecentProject(path); };

  // Drag to reorder (#40), from the tab bar or the sidebar: `onDrop` of
  // `useDragReorder`, in display order. Member lists show newest first, the
  // registry's reverse, so a drop above a row is a registry move behind it.
  const handleReorder = (list, id, targetId, after) => {
    const order = list === "projects"
      ? moveTab(sessions, id, targetId, after)
      : list === "side-projects"
        ? moveGroup(sessions, id, targetId, after)
        : moveMember(sessions, id, targetId, !after);
    if (order) bridge?.reorderTabs(order);
  };
  // A tab's right-click menu: counts come from the registry order; the
  // sets themselves are computed by closeSet at action time.
  const openTabMenu = (id, x, y) => {
    const i = sessions.findIndex(t => t.id === id);
    if (i < 0) return;
    setTabMenu({ tabId: id, x, y, counts: {
      others: sessions.length - 1, left: i, right: sessions.length - 1 - i } });
  };
  const handleTabMenuAction = (action, id) => {
    if (action === "close") { handleCloseTab(id); return; }
    const ids = closeSet(sessions, id, action);
    if (ids.length) bridge?.closeSessions(ids);
  };
  // Sidebar project row's right-click menu: reveal the folder in the OS
  // file manager (Rust `reveal_project_path`, which validates the path and
  // spawns the launcher under the gate) or copy it to the clipboard. Both
  // resolve true/false so the menu row can flash its outcome.
  const openProjectMenu = (group, x, y) => setProjectMenu({ path: group?.path || "", x, y });
  const handleProjectMenuAction = (action, path) => {
    if (action === "copy-path") return window.copyText(path);
    if (action === "reveal") {
      return window.__TAURI__?.core?.invoke("reveal_project_path", { path })
        .then(() => true, (e) => { console.warn("[project-menu] reveal failed:", e); return false; });
    }
    return Promise.resolve(false);
  };
  // Keyboard move: the active tab's project, one place along the tab bar.
  const shiftActiveProject = delta => {
    if (!activeProject.id) return;
    const order = shiftGroup(sessions, groupKey(activeProject), delta);
    if (order) bridge?.reorderTabs(order);
  };
  // Ctrl+Tab / Ctrl+Shift+Tab over the project tabs and, when open, the
  // settings tab as the last stop. Indexed on `activeProject.id`, not
  // `activeSessionId`: `activeProject` falls back to `sessions[0]` when the
  // snapshot's `activeSessionId` is stale or empty.
  const cycleTabs = dir => {
    const r = window.OMP_SETTINGS_TAB.cycle(stab, sessionIds, activeProject.id, dir);
    if (r.settingsActive) { openSettings(); return; }
    setStab(window.OMP_SETTINGS_TAB.selectProject);
    if (r.sessionId && r.sessionId !== activeProject.id) bridge?.activateSession(r.sessionId);
  };

  // Ctrl+1..9 (desktop.tab.jump): activate the Nth *project* tab, in the
  // tab bar's own order — the settings tab is not a slot, exactly as in
  // cycleTabs, so a jump's numbering never shifts when Settings opens.
  // Stepping Settings back is explicit (not left to the activation effect,
  // which never runs when the jump's target is already the active tab
  // under it): Ctrl+2 while Settings covers tab 2 must still show tab 2.
  // N past the end, or no tab at that index, is a no-op. `sessions`, the
  // list the tab bar renders — order is the whole point.
  const jumpToNthTab = n => {
    const target = sessions[n - 1];
    if (!target?.id) return;
    setStab(s => window.OMP_SETTINGS_TAB.selectProject(s));
    if (target.id === activeProject.id) return;
    bridge?.activateSession(target.id);
  };

  // Ctrl+Alt+J/K (desktop.working.next/prev): step through the sidebar's
  // "working" list — the non-idle tabs in the priority order
  // `OMP_WORKING_SURFACE.workingTabs` returns. Wraps; a list of 0/1 is a
  // no-op; lands even when the settings tab is active (selectProject first,
  // same as jumpToNthTab).
  const cycleWorking = delta => {
    const rows = window.OMP_WORKING_SURFACE?.workingTabs(sessions) ?? [];
    if (rows.length < 2 && rows.every(r => r.id === activeSessionId)) return;
    if (!rows.length) return;
    const i = rows.findIndex(r => r.id === activeSessionId);
    const target = rows[(i === -1 ? (delta > 0 ? 0 : rows.length - 1) : (i + delta + rows.length) % rows.length)];
    if (!target?.id) return;
    setStab(s => window.OMP_SETTINGS_TAB.selectProject(s));
    if (target.id !== activeSessionId) bridge?.activateSession(target.id);
  };

  // ── Global keymap handler map ─────────────────────────────────────────────
  // Written into handlersRef every render so the dispatch hook always reads
  // the latest closures without re-subscribing to the window listener.
  // Placed after handleNewProject/handleCloseTab so every entry can be a
  // direct function reference (matching cycleThinking/togglePlanMode above)
  // instead of a `() => handleNewProject()` wrapper that only exists to
  // dodge a TDZ that a closure never actually hits.
  handlersRef.current = {
    "app.interrupt":           () => {
      // Only abort when no overlay is open (overlays handle Escape themselves),
      // and never from the Settings page, which covers the chat.
      if (stab.active || bridgeOpen || historyOpen || gitOpen || rulesOpen || statsOpen || promptHistoryOpen || planOpen || updater.open) return;
      if (streaming) handleAbort();
    },
    "app.thinking.cycle":      cycleThinking,
    "app.model.cycleForward":  () => bridge?.cycleModel(),
    "app.model.cycleBackward": () => {
      if (models.length < 2) return;
      const idx = models.findIndex(m => m.id === model.id && m.provider === model.provider);
      // No-op when the current model isn't in the list (plan §7).
      if (idx < 0) return;
      handlePickModel(models[(idx - 1 + models.length) % models.length]);
    },
    "app.model.select":        () => openBridge("models"),
    "app.plan.toggle":         togglePlanMode,
    "app.session.new":         () => bridge?.newSession(),
    "app.session.resume":      () => setHistoryOpen(v => !v),
    "desktop.commands.open":   () => { setBridgeView("commands"); setBridgeOpen(v => !v); },
    "desktop.history.open":    () => setHistoryOpen(v => !v),
    "desktop.shortcuts.open":  () => openSettings("shortcuts"),
    "desktop.settings.open":   () => openSettings(),
    "desktop.sidebar.toggle":  toggleSidebar,
    "desktop.tab.new":         handleNewProject,
    // The settings tab, when it is the one shown, closes itself; it is the
    // last stop of next/prev (OMP_SETTINGS_TAB.cycle).
    "desktop.tab.close":       () => {
      if (stab.active) closeSettings();
      else if (activeProject.id) handleCloseTab(activeProject.id);
    },
    "desktop.tab.next":        () => cycleTabs(1),
    "desktop.tab.prev":        () => cycleTabs(-1),
    "desktop.tab.moveLeft":    () => shiftActiveProject(-1),
    "desktop.tab.moveRight":   () => shiftActiveProject(1),
    // The event carries the pressed chord; N is its digit (not a lookup),
    // so a rebind to another ctrl+digit still lands on the right tab.
    "desktop.tab.jump":        e => jumpToNthTab(parseInt(e?.key, 10)),
    // Ctrl+Shift+T: pop the closed-tab stack (live.js `reopenClosedTab`).
    "desktop.tab.reopen":      () => { bridge?.reopenClosedTab(); },
    "desktop.working.next":    () => cycleWorking(1),
    "desktop.working.prev":    () => cycleWorking(-1),
    "desktop.panel.todo":      () => setPlanOpen(v => !v),
    "desktop.panel.changes":   () => setGitOpen(v => (v ? null : { path: null })),
    "desktop.panel.rules":     () => setRulesOpen(v => !v),
    "desktop.panel.stats":     () => setStatsOpen(v => !v),
    "desktop.composer.promptHistory": () => setPromptHistoryOpen(v => !v),
    "desktop.composer.focus":  () => window.dispatchEvent(new CustomEvent("omp:focus-composer")),
    "desktop.session.compact": () => bridge?.compact(),
    "desktop.session.export":  () => bridge?.exportHtml(),
    "desktop.update.check":    updater.check,
    "desktop.chat.collapseAll": () => handleCollapseAll(true),
    "desktop.chat.expandAll":  () => handleCollapseAll(false),
    "desktop.terminal.toggle": () => terminal.toggle(planKey),
    "desktop.browser.toggle":  () => toggleSide("browser"),
    "desktop.rail.toggle":     toggleRail,
  };

  // Profile switch applies to the active tab only: its omp process is
  // respawned under the new profile (a live process can't be moved to a
  // different auth/session tree), so the tab comes back as a fresh session.
  //
  // Dispatched on `activeProject.id` - the tab the menu is *rendering* - not
  // on `activeSessionId`. The two diverge because `use-bridge-snapshot`
  // only assigns `activeSessionId` when the snapshot's value is truthy, so a
  // `null` from the bridge leaves the closed id in React state; and right
  // after a tab click `activeSessionId` still names the previous tab, which
  // would respawn a different tab than the one shown (and on that
  // `wasActive === false` path a failure would surface no note at all).
  const handleSelectProfile = React.useCallback(id => {
    // EMPTY_PROJECT.id is "" when no tab is open — the app starts that
    // way — so there is no process to respawn: the pick only decides which
    // profile the next tab opens under (and whose recents are listed).
    if (!activeProject.id) return bridge?.selectNoTabProfile(id);
    return bridge?.switchSessionProfile(activeProject.id, id);
  }, [bridge, activeProject.id]);
  const handleCreateProfile = React.useCallback(name => bridge?.createProfile(name), [bridge]);
  const handleRenameProfile = React.useCallback((id, name) => bridge?.renameProfile(id, name), [bridge]);
  // Returns {ok, error}: the bridge refuses to delete a profile any open tab
  // still runs under, and the menu renders that reason inline.
  const handleDeleteProfile = React.useCallback(id => bridge?.deleteProfile(id), [bridge]);

  // Returns {ok, error}; the backend re-validates the id under its lock, so
  // the menu renders a refusal inline rather than assuming success.
  const handleSetStartupProfile = React.useCallback(id => bridge?.setStartupProfile(id), [bridge]);
  // Stable: the dialog's key listener re-subscribes on a new handler.
  const handleCloseAnswer = React.useCallback(ok => bridge?.resolveCloseConfirm(ok), [bridge]);

  const showRail  = t.layout !== "focus";
  const showSplit = subagentUi.paneOpen;
  const liveCtx   = ctx ?? data.ctx;
  // No tab open (the app starts that way): the session column shows the
  // empty state instead of a transcript and a composer with nowhere to send.
  const noTab = sessions.length === 0;

  // Resizable columns beside the chat (#41): which are shown, and their
  // widths as CSS variables on `.workspace`. Browser full view hides the
  // chat and the split pane (layout/browser.css): only the sidebar is left.
  const workspaceRef = React.useRef(null);
  const browserFull = side === "browser" && browser.fullView;
  const splitShown = showSplit && !browserFull;
  const sideRail = side === "tree" ? "tree" : side !== "browser" && showRail ? "rail" : null;
  const panes = usePaneWidths({
    tweaks: t, setTweak, workspaceRef,
    open: [showSidebar && "sidebar", splitShown && "split", sideRail].filter(Boolean),
    reserve: side === "browser" && !browserFull ? _AL_BROWSER_MIN : 0,
  });

  // The widget switch keys the Settings Rail section renders: badges and
  // resets count only these (a removed plugin's stored key has no row).
  const settingsKeyOpts = React.useMemo(() => ({
    prefixKeys: [...widgets.togglePlugins.map(p => _widgetTweakKey(p.id)), ...extToggles.map(r => r.tweak)],
  }), [widgets.togglePlugins, extToggles]);

  // What the Settings page reads and writes (design/settings/). Built only
  // while the tab is shown: behind a project tab the page stays mounted
  // with the last one (`active: false`), so streaming frames re-render
  // nothing there.
  const settingsLiveCtx = stab.open && stab.active ? {
    active: true, t, setTweak, bridge, keymap,
    profiles, startupProfileId, onSetStartupProfile: handleSetStartupProfile,
    approvalModes, sessions, activeProject,
    widgets, widgetTweakKey: _widgetTweakKey, extToggles, keyOpts: settingsKeyOpts,
    panes, terminalHeight: terminal.height, updater,
    goal: { profileId: activeProfileId },
    openApprovals: () => setRulesOpen(true),
    section: stab.section,
    setSection: id => setStab(s => window.OMP_SETTINGS_TAB.setSection(s, id)),
  } : null;
  // Dropped once the tab closes: the ctx's closures hold that render's scope.
  const settingsLastCtx = React.useRef(null);
  settingsLastCtx.current = stab.open ? settingsLiveCtx ?? settingsLastCtx.current : null;
  const settingsIdleCtx = React.useMemo(
    () => (stab.open && settingsLastCtx.current ? { ...settingsLastCtx.current, active: false } : null),
    [stab.open, stab.active]);
  const settingsCtx = settingsLiveCtx ?? settingsIdleCtx;
  const settingsChanged = React.useMemo(
    () => (stab.open ? window.OMP_SETTINGS.modifiedCount("all", t, settingsKeyOpts) : 0),
    [stab.open, t, settingsKeyOpts]);

  // Chat links: project files to the preview, localhost to the browser panel.
  return (
    <_AL_MdLinkCtx.Provider value={handleChatLinkClick}>
      <div className="app-backdrop" />
      <div className="app">
        <div className={`window scanlines ${showSplit ? "is-split" : ""}`}>
          <PanelBoundary label="titlebar">
          <WindowChrome
            project={activeProject}
            onCmd={() => setBridgeOpen(true)}
            profiles={profiles}
            activeProfileId={activeProfileId}
            startupProfileId={startupProfileId}
            profilesDegraded={profilesDegraded}
            onSelectProfile={handleSelectProfile}
            onCreateProfile={handleCreateProfile}
            onRenameProfile={handleRenameProfile}
            onDeleteProfile={handleDeleteProfile}
            onSetStartupProfile={handleSetStartupProfile}
            connected={bridge?.isConnected ?? null}
            profileLabel={activeProfileLabel}
            sessions={sessions}
            activeId={stab.active ? null : activeSessionId}
          />
          </PanelBoundary>
          <PanelBoundary label="tabs">
          <TabBar
            profiles={profiles}
            projects={sessions}
            activeId={stab.active ? null : activeSessionId}
            onSelect={handleSelectTab}
            onNew={handleNewProject}
            onClose={handleCloseTab}
            onRename={handleRenameTab}
            onReorder={handleReorder}
            onMenu={openTabMenu}
            sidebarOpen={showSidebar}
            onToggleSidebar={toggleSidebar}
            onHistory={() => openHistory(activeProject?.path)}
            appVersion={updater.version}
            updateVersion={updater.pillVersion}
            onUpdate={updater.openModal}
            onCheckUpdate={updater.check}
            settings={{ open: stab.open, active: stab.active, changed: settingsChanged }}
            terminalDirty={terminal.dirtyTabs}
            onSelectSettings={() => openSettings()}
            onCloseSettings={closeSettings}
          />
          </PanelBoundary>

          <div ref={workspaceRef} className="workspace" style={panes.style}>
            {showSidebar && (
              <PanelBoundary label="sidebar">
              <ProjectSidebar
                tabs={sessions}
                activeId={stab.active ? null : activeSessionId}
                recents={recentRows(recentProjects, sessions, activeProfileId)}
                savedSessions={savedSessions}
                historyProfile={activeProfileId}
                onResumeSession={handleResumeSession}
                onShowAllHistory={openHistory}
                profileLabel={profileLabel}
                forceExpandPath={forceExpandPath}
                onForceExpandClear={() => setForceExpandPath(null)}
                onSelectTab={handleSelectTab}
                onCloseTab={handleCloseTab}
                onRenameTab={handleRenameTab}
                onNewInProject={handleNewInProject}
                onOpenRecent={handleOpenRecent}
                onForgetRecent={handleForgetRecent}
                onOpenFolder={handleNewProject}
                onHide={toggleSidebar}
                onProjectMenu={openProjectMenu}
                onReorder={handleReorder}
                profiles={profiles}
                activeProfileId={activeProfileId}
                startupProfileId={startupProfileId}
                onSelectProfile={handleSelectProfile}
                onCreateProfile={handleCreateProfile}
                onRenameProfile={handleRenameProfile}
                onDeleteProfile={handleDeleteProfile}
                onSetStartupProfile={handleSetStartupProfile}
              />
              </PanelBoundary>
            )}
            {showSidebar && <ResizeHandle className="at-sidebar" {...panes.handle("sidebar")} />}
            <div ref={stageRef} className={`stage ${side === "browser" ? `with-browser${browserFull ? " browser-full" : ""}` : sideRail ? `with-${sideRail}` : ""}`}>
              <main className="session">
                {noTab ? (
                  <PanelBoundary label="empty workspace"><EmptyWorkspace notes={workspaceNotes} /></PanelBoundary>
                ) : (<>
                  <PanelBoundary label="chat" resetKey={activeSessionId}>
                  <ChatView key={activeSessionId} messages={messages}
                    planMode={plan.mode}
                    annotations={plan.annotations}
                    onAnnotate={handleAnnotate}
                    onAskAnswer={handleAskAnswer}
                    onAskDialogAnswer={handleAskDialogAnswer}
                    onConfirmAsk={handleConfirmAsk}
                    onCancelAsk={handleCancelAsk}
                    onGrantApproval={handleGrantApproval}
                    onStopRetry={handleStopRetry}
                    hoveredMsgIdx={hoveredMsgIdx}
                    hasProjectPath={!!activeProject?.path}
                    onInspectSubagent={subagentUi.open}
                    onOpenFile={handleOpenFile}
                    onPreviewFile={handlePreviewFile}
                    projectRoot={gitProject}
                    foldModes={foldModes}
                    collapseAfter={t.collapseAfter}
                    collapseOverrides={tabCollapseOverrides}
                    onToggleCollapse={handleToggleCollapse}
                    followOutput={t.followOutput}
                    submitKey={t.submitKey}
                    onOpenKanban={handleOpenKanban}
                    onResend={text => { if (text && !streaming) handleSend(text); }}
                    windowed={windowed}
                    windowCursor={windowCursor}
                    onLoadOlder={handleLoadOlder}
                  />
                  <TerminalPanels sessions={sessions} activeId={planKey} terminal={terminal} />
                  </PanelBoundary>
                  <PanelBoundary label="composer" resetKey={activeSessionId}>
                  <Composer
                    sessionId={planKey}
                    sessionIds={sessionIds}
                    draftStoreKey={activeProject.sessionFile || activeProject.path || null}
                    onSend={handleSend}
                    planMode={plan.mode}
                    onTogglePlan={togglePlanMode}
                    planBlocked={goalUi.planBlocked}
                    goalMode={goalUi.mode}
                    goalTint={goalUi.tint}
                    onToggleGoal={goalUi.toggle}
                    goalBlocked={goalUi.goalBlocked}
                    goalStrip={goalUi.strip}
                    onOpenCmd={() => openBridge("commands")}
                    onOpenModel={() => openBridge("models")}
                    currentModel={model}
                    thinking={thinkingLevel}
                    onLoadThinkingLevels={() => bridge.thinkingLevels()}
                    onSetThinking={level => bridge.setThinkingLevel(level)}
                    isStreaming={streaming}
                    backgroundWork={activeProject.runState === "background"}
                    onAbort={handleAbort}
                    onApprove={handleApprovePlan}
                    annotationCount={Object.keys(plan.annotations).length}
                    microcopy={data.microcopy}
                    onPick={handleCommand}
                    onFollowUp={handleFollowUp}
                    draftInsert={draftInsert}
                    promptHistory={promptHistory}
                    promptInsert={promptInsert}
                    frequentCommands={window.OMP_SLASH_USAGE.topThree(slashUsage, (data.commands || []).flatMap(c => [c.name, ...(c.aliases ?? [])]))}
                    queue={queue}
                    queueSending={queueSending}
                    onRemoveQueued={handleRemoveQueued}
                    onPromoteQueued={handlePromoteQueued}
                    onSendQueuedNow={handleSendQueuedNow}
                    browserChips={browser.chips}
                    onRemoveBrowserChip={browser.removeChip}
                    onBrowserChipClick={handleBrowserChipClick}
                    submitKey={t.submitKey}
                    pasteCollapseLines={t.pasteCollapseLines}
                    approvalCell={approvalCell}
                    exitReason={exitReason}
                    onRestart={() => bridge?.restartSession?.().then(r => { if (r && r.ok === false) console.error("[app] restart failed:", r.error); })}
                  />
                  </PanelBoundary>
                </>)}
              </main>

              {splitShown && <ResizeHandle className="at-split" {...panes.handle("split")} />}
              {sideRail && <ResizeHandle key={sideRail} className="at-side" {...panes.handle(sideRail)} />}
              {showSplit && (
                <PanelBoundary label="subagents">
                <SubagentPane
                  state={subagents}
                  filter={subagentUi.filter} onFilter={subagentUi.setFilter}
                  selected={subagentUi.selected} onSelect={subagentUi.select}
                  level={subagentUi.level}
                  transcript={subagentUi.selected ? subagentTranscripts[subagentUi.selected.id] : null}
                  onLoadTranscript={id => bridge?.loadSubagentTranscript(id)}
                  onSteer={(id, text) => bridge?.steerSubagent(id, text)}
                  onStop={id => bridge?.cancelSubagent(id)}
                  onClose={subagentUi.closePane}
                  onJumpToCall={subagentUi.jumpToCall}
                  submitKey={t.submitKey}
                />
                </PanelBoundary>
              )}

              {side === "browser" ? (
                <PanelBoundary label="browser">
                <BrowserDock ui={browser} stageRef={stageRef} room={panes.browserRoom} />
                </PanelBoundary>
              ) : side === "tree" ? (
                <PanelBoundary label="tree">
                <ConversationTree
                  model={convTree.model} currentFile={convTree.currentFile} error={convTree.error}
                  loading={convTree.loading} treeKey={convTree.key} now={convTree.now} since={convTree.since}
                  streaming={streaming}
                  onRefresh={convTree.refresh} onClose={() => setSide("rail")}
                  onBranch={convTree.branch} onFork={convTree.fork} onOpenFile={convTree.openFile}
                />
                </PanelBoundary>
              ) : showRail && (
                <PanelBoundary label="rail">
                <AmbientRail
                  ctx={liveCtx}
                  activity={activity}
                  sparklineValues={sparkline}
                  subagents={subagentList}
                  subagentPaneOpen={showSplit}
                  onOpenSubagent={subagentUi.open}
                  onToggleSubagentPane={subagentUi.togglePane}
                  onOpenTree={handleOpenTree}
                  onClose={toggleRail}
                  messages={messages}
                  microcopy={data.microcopy}
                  onMinimapClick={handleMinimapClick}
                  trimmedCount={trimmedCount}
                  show={{ context: t.showContext ?? true, radar: t.showRadar ?? true, subagents: t.showSubagents ?? true, minimap: t.showMinimap ?? true }}
                >
                  {/* #21: the error cards take the widgets.json path and an
                      "open settings" passthrough; the openSettings handler
                      itself is the app's (section stays the integrator's). */}
                  {widgets.fatal && <WidgetErrorCard title="widgets.json" error={widgets.fatal}
                    configPath={widgets.configPath} onOpenSettings={() => openSettings("rail")} />}
                  {widgets.configErrors.map((e, i) => <WidgetErrorCard key={i} title="widgets.json" error={e}
                    configPath={widgets.configPath} onOpenSettings={() => openSettings("rail")} />)}
                  {widgets.approvals.map(a => (
                    <WidgetBoundary key={`approve:${a.id}`} title={a.title}>
                      {/* #20: "Not now" keeps the plugin unapproved but hides
                          its card until the window closes. */}
                      <WidgetApprovalCard title={a.title} command={a.command} changed={a.changed}
                        onApprove={() => widgets.approve(a.id)} onDismiss={() => widgets.dismissApproval(a.id)} />
                    </WidgetBoundary>
                  ))}
                  {widgets.cards.map(c => (
                    <WidgetBoundary key={c.id} title={c.title} resetKey={c.resetKey}>
                      <WidgetCard title={c.title} run={c.run}
                        onRefresh={() => widgets.refresh(c.id)} onInsert={handleWidgetInsert} />
                    </WidgetBoundary>
                  ))}
                  {extCards.filter(c => t[c.tweak] !== false).map(c => (
                    <WidgetBoundary key={c.id} title={c.title} resetKey={c.run}>
                      <WidgetCard title={c.title} run={c.run} source="extension" onInsert={handleWidgetInsert} />
                    </WidgetBoundary>
                  ))}
                </AmbientRail>
                </PanelBoundary>
              )}
              {settingsCtx && (
                <div className="st-host" hidden={!stab.active}>
                  <PanelBoundary label="settings">
                  <SettingsPage ctx={settingsCtx} onClose={closeSettings} />
                  </PanelBoundary>
                </div>
              )}
            </div>
          </div>
          {/* Full window width under the workspace: no side column (rail,
              tree, browser panel, subagent split) ever narrows it. */}
          <PanelBoundary label="status">
          <StatusBar
            ctx={liveCtx}
            todoDone={todoCounts.done}
            todoTotal={todoCounts.total}
            onTodo={handleOpenKanban}
            onChanges={handleOpenChanges}
            onRules={handleOpenRules}
            approvalMode={approvalCell}
            onStats={handleOpenStats}
            onTree={handleToggleTree}
            onTerminal={handleToggleTerminal}
            terminalOpen={_TERM_entryOf(terminal.state, planKey).open}
            onBrowser={handleToggleBrowser}
            browserOpen={side === "browser"}
            onSettings={openSettingsNoSection}
            settingsActive={stab.active}
            busy={streaming}
            connected={bridge?.isConnected ?? null}
            showRailToggle={t.layout === "focus"}
            onToggleRail={toggleRail}
          />
          </PanelBoundary>
        </div>
      </div>

      {planOpen && (
        <PanelBoundary label="plan kanban">
        <PlanKanban
          kanban={kanban}
          planMeta={planMeta}
          onClose={() => setPlanOpen(false)}
          onAbort={handleAbort}
        />
        </PanelBoundary>
      )}

      {historyOpen && (
        <PanelBoundary label="history">
        <HistoryModal
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onResume={handleResumeSession}
          activeCwd={activeProject?.path}
          initialCwd={historyCwd}
        />
        </PanelBoundary>
      )}

      {quote && (<PanelBoundary label="quote"><QuotePopover x={quote.x} y={quote.y} onPick={handleQuotePick} /></PanelBoundary>)}

      {gitOpen && (
        // Remounted per project, so no view state carries across; an
        // edit-card path preselects only in the project it came from. The
        // branch and the finished-edit count drive its refetches
        // (app/use-git-browser.jsx).
        <PanelBoundary label="git browser">
        <GitBrowser key={gitProject ?? ""} bridge={bridge}
          initialPath={gitOpen.project === gitProject ? gitOpen.path : null}
          onClose={closeGit} branch={activeProject.branch ?? null} edits={gitEdits} />
        </PanelBoundary>
      )}

      {preview && preview.key === planKey && (
        <PanelBoundary label="file preview">
        <FilePreview target={preview.target} onClose={closePreview} onOpenGit={previewToGit} />
        </PanelBoundary>
      )}

      {rulesOpen && (
        <PanelBoundary label="approval rules">
        <ApprovalRulesPanel
          onClose={() => setRulesOpen(false)}
          activeProject={activeProject.id ? activeProject : null}
          sessions={sessions}
          approvalModes={approvalModes}
        />
        </PanelBoundary>
      )}

      {statsOpen && (
        // Keyed on the profile, not just mounted once: `refresh` only runs
        // on mount/refresh-click (deps [bridge]), so without this a tab
        // switch to a different profile while the panel is open would
        // update the header's profileLabel but leave the previous
        // profile's numbers showing underneath it.
        <PanelBoundary label="usage stats">
        <UsageStatsPanel key={activeProfileId} onClose={() => setStatsOpen(false)} profileLabel={activeProfileLabel} />
        </PanelBoundary>
      )}

      {promptHistoryOpen && (
        <PanelBoundary label="prompt history">
        <PromptHistoryModal
          open={promptHistoryOpen}
          entries={promptHistory}
          globalEntries={globalPromptHistory}
          onClose={() => setPromptHistoryOpen(false)}
          onPick={handlePickHistoryPrompt}
        />
        </PanelBoundary>
      )}

      {updater.open && (
        <PanelBoundary label="update">
        <UpdateModal updater={updater} busyTabs={window.OMP_UPDATER.busyTabCount(sessions)} />
        </PanelBoundary>
      )}

      {/* The command bridge renders after the other z-100 overlays (kanban,
          history, git, approvals, stats, prompt history, update), so at equal
          z-index a later-in-DOM sibling paints over it: an overlay opened
          while the bridge is already up (e.g. Ctrl+K then Ctrl+H) covers it
          visually, not the other way around. The Escape stack agrees without
          this comment's help — the bridge registers once at app start, and
          useEscClose lifts it to the top only when it *opens*, so a modal
          opened later is the topmost and Esc closes that one first; after the
          move visuals and Esc finally say the same thing. */}
      <PanelBoundary label="command bridge">
      <CommandBridge
        open={bridgeOpen}
        initialView={bridgeView}
        onClose={() => setBridgeOpen(false)}
        onPick={handleCommand}
        onPickModel={handlePickModel}
        onPickLogin={handlePickLogin}
        onInsertDraft={handleInsertDraft}
        loginProviders={loginProviders}
        currentModelId={model.id}
        profileId={activeProfileId}
      />
      </PanelBoundary>

      {closeConfirm && (
        <PanelBoundary label="close dialog">
        <ConfirmCloseDialog confirm={closeConfirm} onAnswer={handleCloseAnswer} />
        </PanelBoundary>
      )}
      {tabMenu && (
        <PanelBoundary label="tab menu">
        <TabMenu menu={tabMenu} onAction={handleTabMenuAction} onClose={() => setTabMenu(null)} />
        </PanelBoundary>
      )}
      {projectMenu && (
        <PanelBoundary label="project menu">
        <ProjectMenu menu={projectMenu} onAction={handleProjectMenuAction} onClose={() => setProjectMenu(null)} />
        </PanelBoundary>
      )}

      <PanelBoundary label="remote pairing">
      <RemotePairDialog />
      </PanelBoundary>

      {/* Phone folder sheet (remote control): recent folders + a typed
          path, submitted as `open_project_at` — see openRemoteProject.
          Mounted on the remote shim — NOT gated on touch: the opener
          (handleNewProject) routes here whenever `isRemote()`, and a phone
          in desktop-mode UA reports a fine pointer. Gating on touch made
          the click a silent no-op there. CSS centers the sheet as a card
          under `@media (pointer: fine)`. */}
      {window.OMP_MOBILE?.isRemote?.() && folderSheet && (<PanelBoundary label="folder sheet">{(() => {
        const MobileSheet = window.MobileSheet;
        if (!MobileSheet) return null;
        const rows = recentRows(recentProjects, sessions, activeProfileId);
        return (
          <MobileSheet title="open folder" onClose={() => setFolderSheet(false)}>
            {rows.map(r => (
              <button key={r.path} className="cmp-sheet-row" disabled={folderBusy}
                onClick={() => openRemoteProject(r.path)}>
                <span className="cmp-sheet-ic"><Icon name="folder" size={14} /></span>
                <span className="cmp-sheet-tx">{_AL_basename(r.path)}<span className="s">{r.path}</span></span>
              </button>
            ))}
            <div className="cmp-sheet-sep" />
            {/* Directory browser: the desktop's folders, tap to descend,
                back to the parent. `open this folder` commits the current
                one; recents and the typed path below stay as escapes. */}
            <div className="mob-dir-head">
              <button className="btn" aria-label="up one folder"
                disabled={dirBusy || (dirParent == null && dirPath == null)}
                onClick={() => loadRemoteDirs(dirParent)}>
                <Icon name="back" size={14} />
              </button>
              <span className="mob-dir-path">{dirPath == null ? "this device" : (_AL_basename(dirPath) || dirPath)}</span>
            </div>
            <div className="mob-dir-list">
              {dirError && <div className="cmp-sheet-notice" role="alert">{dirError}</div>}
              {dirBusy
                ? <div className="cmp-sheet-row" aria-busy="true">loading…</div>
                : dirEntries.map(en => (
                  <button key={en.path} className="cmp-sheet-row"
                    onClick={() => loadRemoteDirs(en.path)}>
                    <span className="cmp-sheet-ic"><Icon name="folder" size={14} /></span>
                    <span className="cmp-sheet-tx">{en.name}</span>
                  </button>
                ))}
              {!dirBusy && !dirError && dirEntries.length === 0 && (
                <div className="cmp-sheet-row">no folders here</div>
              )}
            </div>
            <div className="mob-folder-input mob-dir-open">
              <button className="btn primary" disabled={dirBusy || !dirPath}
                onClick={() => openRemoteProject(dirPath)}>open this folder</button>
            </div>
            <div className="cmp-sheet-sep" />
            <div className="mob-folder-input">
              <input type="text" value={folderPath} spellCheck={false}
                placeholder="/absolute/path/on/the/desktop"
                onChange={e => setFolderPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") openRemoteProject(folderPath); }} />
              <button className="btn primary" disabled={folderBusy || !folderPath.trim()}
                onClick={() => openRemoteProject(folderPath)}>open</button>
            </div>
            {folderError && <div className="cmp-sheet-notice" role="alert">{folderError}</div>}
          </MobileSheet>
        );
      })()}</PanelBoundary>)}

    </_AL_MdLinkCtx.Provider>
  );
}


// The root boundary is outside App: if App itself throws (a missing
// global, a corrupt tweak), the user gets the recovery card with a reload
// button instead of an empty #root and a black window.
ReactDOM.createRoot(document.getElementById("root")).render(<AppBoundary><App /></AppBoundary>);
