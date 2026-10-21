/* ═════════════════════════════════════════════════════════════════════
   chrome.jsx — window chrome, tabs, status bar, ambient peripherals
   - WindowChrome (traffic lights, title)
   - TabBar
   - StatusBar
   - Ambient rail: TokenGauge, ActivityRadar, subagents card, Minimap
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TokenGauge, ActivityRadar, Sparkline, TOOL_META, ProfileMenu, DEFAULT_PROFILE_ID, SubagentRailCard, TabRunDot, TabLabel, RenameField } = window;
const { sessionStrip } = window.OMP_PROJECT_NAV;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` — same
// guard and rationale as composer.jsx's copy (kept local rather than a
// third file to import from; see composer.jsx's doc comment for why the
// registry-not-loaded fallback can't move into keymap.js itself).
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

// ── Platform detection ────────────────────────────────────────────────
const IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// ── Window chrome ─────────────────────────────────────────────────────
function WindowChrome({
  project, onCmd,
  profiles, activeProfileId, startupProfileId, profilesDegraded,
  onSelectProfile, onCreateProfile, onRenameProfile, onDeleteProfile, onSetStartupProfile,
  connected = null, profileLabel,
  sessions = [], activeId = null,
}) {
  // #15: the maximize glyph must follow the window's real state, including
  // OS-level changes (double-click title bar, Win+Up, taskbar). `listen`
  // ("tauri://resize") fires on both directions; isMaximized() is polled
  // once per event, not per render.
  const [maximized, setMaximized] = React.useState(false);
  // Phone sidebar drawer (mobile.css): the class lives on <html> so CSS
  // owns the layout, this state only decides whether the scrim renders.
  const [drawer, setDrawer] = React.useState(false);
  React.useEffect(() => {
    document.documentElement.classList.toggle("mobile-sidebar-open", drawer);
    if (!drawer) return undefined;
    // Tapping a sidebar entry navigates — close the drawer with it. The
    // settings row is in on it too: the drawer (z-60) would cover the
    // settings page (z-20) it just opened. Profile rows are not: their
    // popover lives inside the drawer and switching respawns the tab
    // without moving the drawer.
    const close = (e) => { if (e.target.closest(".psb-main, .psb-hist-row, .psb-act, .psb-app-row")) setDrawer(false); };
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      document.documentElement.classList.remove("mobile-sidebar-open");
    };
  }, [drawer]);
  React.useEffect(() => {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win) return undefined;
    let alive = true;
    const sync = () => { win.isMaximized().then(m => { if (alive) setMaximized(m); }).catch(() => {}); };
    sync();
    let unlisten = null;
    win.listen?.("tauri://resize", sync).then(un => { unlisten = un; }).catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);

  // `profileLabel` defaults to the id: app-live passes the resolved name.
  const sub = [project.branch, profileLabel ?? activeProfileId]
    .filter(Boolean).join(" · ");
  // The session strip's label (OMP_PROJECT_NAV.sessionStrip): the active
  // conversation's name and how many are open.
  const strip = sessionStrip(sessions, activeId);
  return (
    <>
      {/* Phone top bar (≤760px, chrome.css): ☰ drawer · project ·
          branch · profile · connection dot. Desktop renders it
          display:none; the desktop `.chrome` block below is likewise
          hidden on phones, so the two never stack. */}
      <div className="mobile-topbar">
        <button className="mobile-topbar-menu" aria-label="projects" onClick={() => setDrawer((v) => !v)}>
          <Icon name="menu" size={16} color="var(--fg-2)" />
        </button>
        <div className="mobile-topbar-title">
          <span className="mobile-topbar-project">{project.name}</span>
          {sub && <span className="mobile-topbar-sub mono">{sub}</span>}
        </div>
        {/* Phone-remote only (design/remote-device-chip.jsx): names the
            desktop being controlled; tap opens the device hub to switch.
            Null everywhere else, so the desktop bar is untouched. */}
        {window.RemoteDeviceChip ? <window.RemoteDeviceChip /> : null}
        <span className={`dot ${connected === null ? "warn" : connected ? "live" : "error"}`}
          title={connected === null ? "connecting" : connected ? "connected" : "disconnected"} />
        {/* The desktop's Ctrl+H clock lives in the hidden tab bar; the
            phone's entry to the same full history modal (all projects,
            searchable) is here. Same `omp:mobile` dispatch the drawer's
            app menu uses, so app-live's one listener owns the mapping. */}
        <button className="mobile-topbar-menu" aria-label="conversation history"
          onClick={() => window.dispatchEvent(new CustomEvent("omp:mobile", { detail: { action: "open-history" } }))}>
          <Icon name="clock" size={16} color="var(--fg-2)" />
        </button>
      </div>
      {drawer && <div className="mobile-drawer-scrim" onClick={() => setDrawer(false)} />}

      {/* Phone session strip (≤760px, chrome.css): the one tappable row
          that replaces the horizontal tab bar. Clicking opens the drawer,
          which lists every conversation. Desktop: display:none. The label
          comes from OMP_PROJECT_NAV.sessionStrip (pure, tested). */}
      <button className="mobile-session-strip" aria-label="conversations"
        onClick={() => setDrawer(true)}>
        <span className="mobile-session-strip-title">
          {strip.title ?? "no conversation"}
        </span>
        <span className="mobile-session-strip-count mono">
          {strip.count} session{strip.count === 1 ? "" : "s"}
        </span>
        <Icon name="chev" size={9} color="var(--fg-4)" />
      </button>

      {/* Desktop title bar — hidden on phones (chrome.css), where the
          mobile topbar above replaces it. */}
      <div className="chrome" data-tauri-drag-region>

      {/* Drawer toggle for the ≤820px tablet tier (mobile.css): on real
          phones (≤760px) this whole .chrome row is hidden and the topbar's
          ☰ above owns the drawer. */}
      <button
        className="btn ghost mobile-menu-btn"
        aria-label="projects"
        onClick={() => setDrawer((v) => !v)}
      >
        <Icon name="menu" size={13} />
      </button>

      {/* macOS traffic lights — left side, hidden on Windows */}
      {!IS_WIN && (
        <div className="chrome-lights">
          <span className="light red" />
          <span className="light amber" />
          <span className="light green" />
        </div>
      )}

      <div className="chrome-title">
        <span className="mono" style={{ color: "var(--fg-3)" }}>OMP</span>
        <span className="mono" style={{ color: "var(--fg-5)" }}>·</span>
        <span className="chrome-title-project" style={{ color: "var(--fg-2)" }}>{project.name}</span>
        {project.branch && (
          <span className="chip muted" style={{ marginLeft: 6 }}>
            <Icon name="branch" size={9} color="var(--fg-3)" />
            <span className="mono" style={{ color: "var(--fg-3)" }}>{project.branch}</span>
          </span>
        )}
      </div>

      {/* Per-tab omp profile — the selector acts on the active tab only. */}
      <ProfileMenu
        profiles={profiles}
        activeId={activeProfileId}
        startupId={startupProfileId}
        degraded={profilesDegraded}
        onSelect={onSelectProfile}
        onCreate={onCreateProfile}
        onRename={onRenameProfile}
        onDelete={onDeleteProfile}
        onSetStartup={onSetStartupProfile}
      />

      <div className="chrome-right">
        <button className="btn ghost outlined" onClick={onCmd}>
          <Icon name="command" size={11} /> bridge{" "}
          <span className="kbd">{hintFor("desktop.commands.open", IS_WIN ? "^K" : "⌘K")}</span>
        </button>

        {/* Windows controls — right side, hidden on macOS/Linux */}
        {IS_WIN && (
          <div className="win-controls">
            <button className="win-ctrl win-min" title="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="win-ctrl win-max" title={maximized ? "Restore" : "Maximize"}>
              {/* #15: restore shows the classic two-overlapping-rects glyph. */}
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
              )}
            </button>
            <button className="win-ctrl win-close" title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" /></svg>
            </button>
          </div>
        )}
        </div>
      </div>
    </>
  );
}

// ── Project tabs ─────────────────────────────────────────────────────
// A tab's click props: select on click, close on middle-click, as in
// browsers (#24). WebKit before Safari 18.2 / WebKitGTK 2.46 has no
// `auxclick` and reports it as a `click` with button 1, hence the check in
// onClick too; newer engines never send `click` for button 1, so this
// can't double-fire. Swallowing the middle-button mousedown stops Windows
// autoscroll and Linux primary-selection paste from firing on the tab.
function tabClickProps(onSelect, onClose) {
  return {
    onClick: e => (e.button === 1 ? onClose?.() : onSelect?.()),
    onMouseDown: e => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: e => { if (e.button === 1) { e.preventDefault(); onClose?.(); } },
    // #3: the div is role="tab" + tabIndex={0}, so Enter and Space must
    // activate it like the native button it isn't. `key === " "` is Space
    // (and isSubmitEnter's IME guard lives in profile-menu's input, not here).
    // Keys typed into the inline rename field (#32) are the field's: it
    // renders inside this tab, and swallowing its Space made names
    // untypeable while Enter re-fired onSelect on top of the field's commit.
    onKeyDown: e => {
      if (e.target.closest("input, textarea")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(); }
    },
  };
}
/** Roving-tabindex arrows for the tab bar's `role=tablist` (ARIA tabs
 *  pattern with automatic activation): ←/→ move focus between the
 *  `role=tab` entries and select the one landed on; Home/End jump to the
 *  first/last. The add/history buttons and the trailing spacer are not
 *  tabs, so they are skipped — Tab (and Shift+Tab) still reaches them as
 *  its own tab stops. Keeps tabClickProps' Enter/Space activation. */
function tablistKeyNav(e, onSelect) {
  // An open group popover handles its own arrows (menuKeyNav) — and its
  // menuitems are not tabs, so the focus check below already skips those.
  // The defaultPrevented guard covers a popover that claimed the key first.
  if (e.defaultPrevented) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;
  // Only act when a tab itself has focus: keys from elsewhere in the bar
  // (an open popover's menuitems, the inline rename field, a tab-close
  // button) are those elements' own.
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const target = e.key === "Home" ? 0
    : e.key === "End" ? tabs.length - 1
    : (i + (e.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[target].focus();
  // Automatic activation: focus and selection move together. The tab's own
  // Enter/Space handler (tabClickProps) selects on click; arrows select
  // directly here — id is either the project id or the settings sentinel.
  onSelect(tabs[target].dataset.tabId);
}

function TabBar({
  projects, activeId, onSelect, onClose, onRename, onNew, onHistory, onReorder,
  sidebarOpen, onToggleSidebar,
  profiles = [], appVersion, updateVersion, onUpdate, onCheckUpdate,
  settings, onSelectSettings, onCloseSettings,
  terminalDirty,
  onMenu,
}) {
  // Tabs can run under different profiles, so a tab whose profile is not the
  // built-in one is labelled with it — otherwise two tabs on the same folder
  // in different profiles look identical. Falls back to the raw id until the
  // profile list has loaded.
  const profileLabel = id =>
    id === DEFAULT_PROFILE_ID ? null : (profiles.find(p => p.id === id)?.name ?? id);
  // Tab whose name is being edited inline (#32); double-click enters it.
  const [renaming, setRenaming] = React.useState(null);
  // Drag to reorder (#40): one list ("projects", keyed by tab id) along
  // the bar; the sidebar keeps its own project/member lists.
  const reorder = window.useDragReorder(onReorder);
  // Scroll the selected tab into view: picking a tab off-screen (keyboard,
  // minimap, sidebar) must not leave it hidden behind the bar's overflow.
  // Found by `[aria-selected="true"]` on the bar root, so a plain tab, a
  // group chip holding it and the Settings app tab all match — the bar
  // re-renders on every activeId change before the effect runs.
  // `block/inline: "nearest"` only ever nudges, so a tab already in view
  // (the common case) never moves.
  const barRef = React.useRef(null);
  React.useEffect(() => {
    barRef.current?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, settings?.active]);
  // The tablist's arrow nav routes its pick: a project id goes to onSelect,
  // the settings sentinel (data-tab-id="__settings__") to onSelectSettings.
  const selectById = id => {
    if (id === "__settings__") onSelectSettings?.();
    else if (id) onSelect?.(id);
  };
  // Density stages (app/tab-bar.js): how much room each tab gets decides
  // what it may show — full, compact, icon-only, then scroll with edge
  // fades. Recomputed on resize and whenever the tab count changes.
  const [stage, setStage] = React.useState(0);
  React.useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    const measure = () => setStage(window.OMP_TAB_BAR.stage(el.clientWidth, projects.length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [projects.length]);
  // A vertical wheel over the bar scrolls it sideways (trackpads already
  // send deltaX; a mouse wheel would otherwise do nothing).
  const onWheel = e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    barRef.current?.scrollBy({ left: e.deltaY });
  };
  return (
    <div className="tabs-wrap">
    <div ref={barRef} data-stage={stage} onWheel={onWheel} className="tabs" role="tablist" aria-label="projects" onPointerDown={reorder.onPointerDown}
      onKeyDown={e => tablistKeyNav(e, selectById)}>
      <button className={`tab-add ${sidebarOpen ? "on" : ""}`}
        title={`project sidebar (${hintFor("desktop.sidebar.toggle", "Ctrl+B")})`}
        aria-pressed={!!sidebarOpen}
        onClick={onToggleSidebar}>
        <Icon name="sidebar" size={11} />
      </button>
      {/* One item per conversation: the bar never folds a project's tabs
          into a chip, so every open session stays a visible, clickable,
          closeable tab of its own. Tabs of the same folder + profile sit
          where the registry (and drag reorder, #40) put them and read as
          related through `.tab-same-project` (chrome.css). */}
      {projects.map((p, i) => {
        const active = p.id === activeId;
        const profile = profileLabel(p.profile);
        const prev = projects[i - 1];
        const sameProject = !!prev && prev.path === p.path && prev.profile === p.profile && !!p.path;
        return (
          <div key={p.id}
            {...reorder.itemProps("projects", p.id, "x")}
            className={`tab ${active ? "active" : ""}${sameProject ? " tab-same-project" : ""}${reorder.dropClass("projects", p.id)}`}
            role="tab"
            tabIndex={active ? 0 : -1}
            data-tab-id={p.id}
            aria-selected={active}
            style={sameProject ? { "--tab-seam": p.color } : undefined}
            {...tabClickProps(() => onSelect(p.id), () => onClose?.(p.id))}
            // The first click of the pair already selected the tab.
            onContextMenu={e => { e.preventDefault(); onMenu?.(p.id, e.clientX, e.clientY); }}
            onDoubleClick={e => { if (onRename && !e.target.closest(".tab-close")) setRenaming(p.id); }}>
            <span className="tab-bar-mark" style={{ background: active ? p.color : "transparent" }} />
            {!sameProject && <Icon name="folder" size={11} color={active ? p.color : "var(--fg-4)"} />}
            <TabRunDot state={p.runState} />
            {terminalDirty?.[p.id] && <span className="tab-run-dot term-dirty" title="terminal has new output" />}
            {renaming === p.id ? (
              <RenameField value={p.name}
                onCommit={name => onRename(p.id, name)}
                onClose={() => setRenaming(null)} />
            ) : (
              <TabLabel tab={p} className="tab-name" title={`${p.name}\ndouble-click to rename`} />
            )}
            {profile && (
              <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
            )}
            <button className="tab-close" aria-label={`close ${p.name}`} title={`close ${p.name}`}
              onClick={e => { e.stopPropagation(); onClose?.(p.id); }}><Icon name="close" size={9} /></button>
          </div>
        );
      })}
      {/* The Settings app tab (#37): pinned after the projects, never
          dragged; `changed` counts settings off their default. */}
      {settings?.open && (
        <div className={`tab app-tab ${settings.active ? "active" : ""}`}
          role="tab" tabIndex={settings.active ? 0 : -1} data-tab-id="__settings__"
          aria-selected={!!settings.active}
          title={`settings (${hintFor("desktop.settings.open", "Ctrl+,")})`}
          {...tabClickProps(onSelectSettings, onCloseSettings)}>
          <span className="tab-bar-mark" style={{ background: settings.active ? "var(--fg-3)" : "transparent" }} />
          <Icon name="cog" size={12} />
          <span className="tab-name">Settings</span>
          {settings.changed > 0 && (
            <span className="tab-count" title={`${settings.changed} changed from default`}>{settings.changed}</span>
          )}
          <button className="tab-close" title={`close (${hintFor("desktop.tab.close", "Ctrl+W")})`}
            onClick={e => { e.stopPropagation(); onCloseSettings?.(); }}>
            <Icon name="close" size={9} />
          </button>
        </div>
      )}
      <button className="tab-add" title="open project" onClick={onNew}>
        <Icon name="plus" size={11} />
      </button>
      <button className="tab-add" title={`conversation history (${hintFor("desktop.history.open", "Ctrl+H")})`} onClick={onHistory}>
        <Icon name="clock" size={11} />
      </button>
      <div style={{ flex: 1 }} />
      <div className="tabs-right mono">
        {updateVersion && (
          <button className="btn outlined update-pill" onClick={onUpdate} title={`OMP Desktop v${updateVersion} is available`}>
            <Icon name="arrowUp" size={9} />v{updateVersion}
          </button>
        )}
        <button className="btn ghost app-version" onClick={onCheckUpdate} title="check for updates">
          {appVersion ? `v${appVersion}` : "—"}
        </button>
      </div>
    </div>
    </div>
  );
}

// ── Status bar (footer): connection, tokens, todos, panels ──────────
// The model and thinking level are not repeated here: the composer's
// pills below the prompt box show (and change) both. It spans the window
// under the workspace; the st-ctx meter, st-cost and st-tps cells (each
// with its separator) drop out when the window is narrow (layout/rail.css).
// Memoised (round 3): every streaming delta re-renders App, and the bar
// only depends on ctx/todo counts/panel flags — app-live.jsx keeps every
// prop reference-stable across those deltas (its approvalMode cell is
// useMemo'd, its handlers useCallback'd), so the bar stops diffing 12+
// buttons per frame.
const StatusBar = React.memo(function StatusBar({
  ctx, todoDone, todoTotal, onTodo, onSettings, settingsActive = false, onChanges, onRules,
  approvalMode, onStats, onTree, onTerminal, terminalOpen, onBrowser, browserOpen = false,
  busy = false, connected = true, showRailToggle = false, onToggleRail,
}) {
  // #5: currentTps is the *last* finished turn's rate — stale whenever no
  // turn is running. Muted + "last" prefix instead of reading as current.
  const tps = busy ? (
    <span className="st-tps mono" style={{ color: "var(--fg-3)" }}>{ctx.tokensPerSec} t/s</span>
  ) : (
    <span className="st-tps mono" style={{ color: "var(--fg-4)" }}>last {ctx.tokensPerSec} t/s</span>
  );
  // #22: same thresholds as TokenGauge (sparks.jsx) so the tube and the
  // rail gauge never disagree.
  const tone = ctx.pct > 80 ? "rose" : ctx.pct > 60 ? "amber" : "";
  return (
    <div className="status">
      {/* #2: honest connection state; "connecting" is the not-yet bridge
          startup, not a third colour for a healthy session. */}
      <span className="status-cell">
        <span className={`dot ${connected === null ? "warn" : connected ? "live" : "error"}`} />
        {/* .st-label: the words drop out on a phone (chrome.css), where the
            mobile topbar already names the state with the same dot. */}
        <span className="st-label">
          {connected === null ? "connecting" : connected ? "connected" : "disconnected"}
        </span>
      </span>
      <span className="status-sep">·</span>
      <span className="status-cell st-ctx mono">
        <span style={{ color: "var(--fg-3)" }}>{ctx.label}</span>
        <span className="status-bar-tube">
          <span className={`status-bar-fill${tone ? ` tone-${tone}` : ""}`} style={{ width: `${ctx.pct}%` }} />
        </span>
        <span className="st-ctx-pct" style={{ color: "var(--fg-4)" }}>{(+ctx.pct).toFixed(1)}%</span>
      </span>
      <span className="status-sep st-cost">·</span>
      <span className="status-cell st-cost mono"><span style={{ color: "var(--fg-3)" }}>cost</span> {ctx.cost}</span>
      <span className="status-sep st-tps">·</span>
      <span className="status-cell st-tps-cell">{tps}</span>
      <div className="status-gap" />
      <button className="status-cell btn ghost" onClick={onTodo}
        title={`plan kanban (${hintFor("desktop.panel.todo", "todo")})`}
        style={{ height: 20, padding: "0 6px" }}>
        <Icon name="plan" size={11} color="var(--accent)" />
        <span style={{ color: "var(--accent)" }}>todo {todoDone}/{todoTotal}</span>
      </button>
      <span className="status-sep st-panel-sep">·</span>
      <button className="status-cell btn ghost st-panel" onClick={onChanges} title="git browser" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="diff2" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep st-panel-sep">·</span>
      <button className="status-cell btn ghost st-panel" onClick={onTree} title="conversation tree (prompt-cache status)" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="branch" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep st-panel-sep">·</span>
      <button className="status-cell btn ghost st-panel" onClick={onBrowser} aria-pressed={browserOpen}
        title={`browser panel (${hintFor("desktop.browser.toggle", "Ctrl+Shift+B")})`}
        style={{ height: 20, padding: "0 6px" }}>
        <Icon name="web" size={11} color={browserOpen ? "var(--accent)" : "var(--fg-3)"} />
      </button>
      <span className="status-sep">·</span>
      <ApprovalModeCell cell={approvalMode} onClick={onRules} />
      <span className="status-sep st-panel-sep">·</span>
      <button className="status-cell btn ghost st-panel" onClick={onStats} title="usage statistics" style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cost" size={11} color="var(--fg-3)" />
      </button>
      <span className="status-sep st-panel-sep">·</span>
      <button className={`status-cell btn ghost st-panel ${terminalOpen ? "on" : ""}`} onClick={onTerminal}
        title={`terminal (${hintFor("desktop.terminal.toggle", "Ctrl+`")})`}
        aria-pressed={!!terminalOpen} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="terminal" size={11} color={terminalOpen ? "var(--accent)" : "var(--fg-3)"} />
      </button>
      <span className="status-sep st-panel-sep">·</span>
      <button className={`status-cell btn ghost st-panel ${settingsActive ? "on" : ""}`} onClick={onSettings}
        title={`settings (${hintFor("desktop.settings.open", "Ctrl+,")})`}
        aria-pressed={settingsActive} style={{ height: 20, padding: "0 6px" }}>
        <Icon name="cog" size={11} color={settingsActive ? "var(--accent)" : "var(--fg-3)"} />
      </button>
      {/* #16: the rail's ✕ leaves focus layout with no way back; this
          restores it (same place the toggle lives for the sidebar). */}
      {showRailToggle && (
        <>
          <span className="status-sep st-panel-sep">·</span>
          <button className="status-cell btn ghost st-panel" onClick={onToggleRail}
            title={`show ambient rail${hintFor("desktop.rail.toggle") ? ` (${hintFor("desktop.rail.toggle")})` : ""}`}
            style={{ height: 20, padding: "0 6px" }}>
            <Icon name="layers" size={11} color="var(--fg-3)" />
          </button>
        </>
      )}
    </div>
  );
});

// The approvals button: names the tab's running tool approval mode
// (`OMP_APPROVAL_MODE.statusCell`). Yolo as the target turns the glyph to
// `warn` and amber; a change waiting for the turn to end reads
// `running ⇢ target` muted, with the target coloured.
function ApprovalModeCell({ cell, onClick }) {
  const targetColor = cell?.warn ? "var(--amber)" : "var(--fg-3)";
  return (
    <button className="status-cell btn ghost" onClick={onClick}
      title={cell?.pending ? `approvals — switches to ${cell.target} when the agent finishes its turn` : "approvals"}
      style={{ height: 20, padding: "0 6px" }}>
      <Icon name={cell?.warn ? "warn" : "check"} size={11} color={targetColor} />
      {cell && (cell.pending
        ? <span className="mono status-mode" style={{ color: "var(--fg-4)" }}>{cell.running} ⇢ <span style={{ color: targetColor }}>{cell.target}</span></span>
        : <span className="mono status-mode" style={{ color: targetColor }}>{cell.label}</span>)}
    </button>
  );
}

// ── Minimap of the session: dense grid, one cell per message ─────────
// Hue encodes role/tool color (same palette as the chat). For assistant
// messages, opacity is log-scaled by tokens used so expensive turns pop
// against cheap ones. Click scrolls the chat to that message.
//
// Hover highlight (round 3): the `.hot` cell state lives here as component
// state, and the matching chat row gets `.mm-hot` imperatively via the
// `[data-msg-idx]` DOM handle both sides already share — no `setHovered`
// round-trip through App (a full re-render per hovered cell, on a
// mousemove-driven path). The imperative seam is the smaller one: the
// rows' `data-msg-idx` attribute already exists for the click-scroll
// (`onMinimapClick` in app-live.jsx) and the subagent jump-to-call, so no
// new prop or context has to cross the chat/minimap boundary; a React
// state round-trip would also re-render every memoised bubble that has
// `highlighted` in its props. Rows the mouse skips without lingering
// (a fast sweep) cost one no-op classList call each.
//
// Memoised on a stable signal, not the `messages` array's identity: the
// live layer rebuilds that array on every streaming delta, but the grid
// only changes when a message is added or removed. The comparator below
// keys on `messages.length` + the last message's `_id` / `streaming` /
// `tokens` — that signal skips the per-delta rebuild (a streaming bubble
// keeps its `_id` across `message_update` rewrites) while still catching
// `message_end`'s in-place tail rewrite, which would otherwise leave the
// last cell's `live` pulse running after the turn ends. Mid-array
// rewrites that move no cell (a compact row settling, a tool card
// finalizing) are skipped until the next add/remove — the grid is a
// coarse overview; the tooltips catch up on the next message.
const _mmSignals = (messages, trimmedCount) => {
  const last = messages[messages.length - 1];
  return `${messages.length}\0${last?._id ?? ""}\0${last?.streaming ? 1 : 0}\0${last?.tokens ?? 0}\0${trimmedCount}`;
};
const SessionMinimap = React.memo(function SessionMinimap({ messages, onClick, trimmedCount = 0 }) {
  // The cell the mouse is on — local, so hovering repaints only this grid.
  const [hot, setHot] = React.useState(null);
  // Mirror `hot` onto the chat row (rail.css `.row.mm-hot`): `data-msg-idx`
  // is the row handle the click-scroll and subagent jump already use, so
  // this stays a one-line query per hover — far cheaper than lifting the
  // hover into App state, which re-rendered the whole tree per cell.
  React.useEffect(() => {
    const row = hot == null ? null : document.querySelector(`[data-msg-idx="${hot}"]`);
    if (!row) return undefined;
    row.classList.add("mm-hot");
    return () => row.classList.remove("mm-hot");
  }, [hot]);
  // Log-scaled max across assistant messages so heatmap variance is
  // visible even when one compaction turn dwarfs the rest.
  const { maxTokens, shown } = React.useMemo(() => {
    let max = 0;
    let n = 0;
    for (const m of messages) {
      if (window.OMP_TURN_STATUS.isHidden(m)) continue; // the chat hides it too
      n++;
      if (m.kind === "assistant" && m.tokens && m.tokens > max) max = m.tokens;
    }
    return { maxTokens: max, shown: n };
  }, [messages]);
  const logMax = Math.log10(maxTokens + 1) || 1;

  return (
    <div className="minimap">
      <div className="minimap-head">
        <Icon name="minimap" size={11} color="var(--fg-3)" />
        <span className="mono" style={{ color: "var(--fg-3)" }}>session</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>
          {/* #19: only what is still here is counted; earlier messages were
              trimmed from the head (_trimMessages). */}
          {trimmedCount > 0 && <span title={`${trimmedCount} earlier messages trimmed from this view`} style={{ marginRight: 6, color: "var(--fg-5)" }}>−{trimmedCount}</span>}
          {shown}
        </span>
      </div>
      <div className="minimap-grid">
        {messages.map((m, i) => {
          if (window.OMP_TURN_STATUS.isHidden(m)) return null;
          let hue = "var(--fg-5)";
          if      (m.kind === "user")      hue = "var(--fg-3)";
          else if (m.kind === "assistant") hue = m.failure ? "var(--rose)" : "var(--accent)";
          else if (m.kind === "ask")       hue = "var(--amber)";
          else if (m.kind === "retry")     hue = TOOL_META.retry.color;
          else if (m.kind === "tool")      hue = TOOL_META[m.tool]?.color || "var(--fg-4)";
          else if (m.kind === "job")       hue = TOOL_META.job.color;
          else if (m.kind === "goal")      hue = TOOL_META.goal.color;
          else if (m.kind === "approval")  hue = TOOL_META.approval.color;
          // #17: a soft violet-grey distinct from every tool colour, so a
          // compaction turn reads as its own event, not a tool call.
          else if (m.kind === "compact")   hue = "color-mix(in oklab, var(--accent) 22%, var(--fg-5))";

          // Brightness: assistant cells modulate by log(tokens), others flat.
          let opacity = 0.7;
          if (m.kind === "assistant" && m.tokens && maxTokens > 0) {
            const t = Math.log10(m.tokens + 1) / logMax;
            opacity = 0.4 + 0.6 * Math.max(0, Math.min(1, t));
          }

          // Per-kind tooltip — tools don't carry their own tokens (the
          // LLM cost lives on the assistant message that invoked them),
          // so they get tool-specific info instead of a token chip.
          let title;
          if (m.kind === "assistant" && m.failure) {
            title = `request failed${m.failure.httpStatus != null ? ` · HTTP ${m.failure.httpStatus}` : ""}${m.time ? " · " + m.time : ""}`;
          } else if (m.kind === "assistant") {
            const tok  = m.tokens ? `${m.tokens.toLocaleString()} tok` : "—";
            const inOut = (m.tokensIn != null || m.tokensOut != null)
              ? ` (${(m.tokensIn ?? 0).toLocaleString()} in · ${(m.tokensOut ?? 0).toLocaleString()} out)`
              : "";
            title = `assistant · ${tok}${inOut}${m.time ? " · " + m.time : ""}`;
          } else if (m.kind === "tool") {
            const dur = m.duration ? ` · ${(m.duration / 1000).toFixed(1)}s` : "";
            const status = m.status === "running" ? " · running" : (m.status === "ok" ? "" : ` · ${m.status}`);
            title = `${m.tool ?? "tool"}${m.title ? " " + m.title : ""}${dur}${status}`;
          } else if (m.kind === "user") {
            const preview = m.text ? ` · ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}` : "";
            title = `you${preview}`;
          } else if (m.kind === "job") {
            title = `${m.jobId} finished${m.label ? " · " + m.label : ""}`;
          } else if (m.kind === "retry") {
            title = `retrying · attempt ${m.attempt}${m.maxAttempts ? " of " + m.maxAttempts : ""}`;
          } else if (m.kind === "goal") {
            title = window.OMP_GOAL.rowView(m).title;
          } else if (m.kind === "approval") {
            title = `auto-approved · ${m.tool || "tool"}`;
          } else if (m.kind === "compact") {
            // #17: status, not just the kind — a pending compact otherwise
            // reads as an unexplained grey cell.
            title = m.status === "pending" ? "compacting context…"
              : m.status === "error" ? "compaction failed"
              : `context compacted${m.tokensBefore ? ` · ${m.tokensBefore.toLocaleString()} tok before` : ""}`;
          } else {
            title = m.kind;
          }
          const cls = `minimap-cell ${m.kind} ${m.streaming ? "live" : ""} ${hot === i ? "hot" : ""}`.trim();

          return (
            <button type="button" key={m._id ?? i}
              className={cls}
              style={{ background: hue, opacity }}
              // The cell is a button (a jump target) whose tooltip doubles
              // as its accessible name; rail.css resets the native chrome
              // so the grid look stays.
              title={title}
              aria-label={title}
              onMouseEnter={() => setHot(i)}
              onMouseLeave={() => setHot(h => (h === i ? null : h))}
              onClick={() => onClick?.(i)} />
          );
        })}
      </div>
      <MinimapLegend messages={messages} />
    </div>
  );
}, (prev, next) => _mmSignals(prev.messages, prev.trimmedCount) === _mmSignals(next.messages, next.trimmedCount));

// #24: legend entries for the kinds actually present in this session, in a
// fixed order — a session with no asks shows no ask swatch.
function MinimapLegend({ messages }) {
  const present = React.useMemo(() => {
    const set = new Set();
    for (const m of messages) {
      if (window.OMP_TURN_STATUS.isHidden(m)) continue;
      if (m.kind === "compact") set.add("compact");
      else if (m.kind === "assistant") set.add(m.failure ? "failed" : "assistant");
      else if (m.kind === "tool" && TOOL_META[m.tool]?.color) set.add("tool");
      else if (m.kind === "tool") continue; // unknown tools render fg-4 too, but one generic swatch is noise
      else if (["user", "ask", "retry", "job", "goal", "approval"].includes(m.kind)) set.add(m.kind);
    }
    return set;
  }, [messages]);
  const entries = [
    ["user", "you", "var(--fg-3)"],
    ["assistant", "assistant", "var(--accent)"],
    ["failed", "failed", "var(--rose)"],
    ["ask", "ask", "var(--amber)"],
    ["tool", "tool", "var(--fg-4)"],
    ["compact", "compact", "color-mix(in oklab, var(--accent) 22%, var(--fg-5))"],
    ["retry", "retry", TOOL_META.retry.color],
    ["job", "job", TOOL_META.job.color],
    ["goal", "goal", TOOL_META.goal.color],
    ["approval", "auto-ok", TOOL_META.approval.color],
  ].filter(([id]) => present.has(id));
  if (!entries.length) return null;
  return (
    <div className="minimap-legend">
      {entries.map(([id, label, color]) => (
        <span key={id} className="minimap-legend-item"><i style={{ background: color }} />{label}</span>
      ))}
    </div>
  );
}

// ── Right rail: ambient peripherals stacked ──────────────────────────
// `show`: { context, radar, subagents, minimap } — false hides that card
// (Settings → Rail, keys showContext/showRadar/showSubagents/showMinimap);
// `children` (widget plugin cards) sit between subagents and the minimap.
// The context / radar cards below are memoised (round 3): App re-renders
// on every streaming delta, and each re-render would re-run their SVG
// point math and diff their subtrees even though ctx/activity/sparkline
// are reference-stable between updates that don't change them. Hoisting
// them as named components (rather than memoising AmbientRail itself)
// keeps the non-memoised parts — the widget/plugin `children`, whose cards
// carry per-render closures — on their own update path.

// Legend rows of the radar card: the four tool kinds the strip colours.
// Hoisted to module scope so a rail re-render doesn't rebuild the
// Object.entries list and its filter (fixed data, computed once).
const RADAR_LEGEND_KEYS = ["read", "search", "edit", "bash"];
const RADAR_LEGEND = Object.entries(TOOL_META).filter(([k]) => RADAR_LEGEND_KEYS.includes(k));

const RailContextCard = React.memo(function RailContextCard({ ctx, sparkVals }) {
  return (
    <div className="rail-card glass">
      <TokenGauge used={ctx.used} total={ctx.total} pct={ctx.pct}
        label={ctx.label} sub={`cost ${ctx.cost} · ${ctx.tokensPerSec} t/s`} />
      <div className="rail-spark">
        <Sparkline values={sparkVals} width={210} height={28} />
        <div className="rail-spark-foot mono">
          <span style={{ color: "var(--fg-4)" }}>throughput</span>
          <span style={{ color: "var(--accent)" }}>{ctx.tokensPerSec} t/s</span>
        </div>
      </div>
    </div>
  );
});

const RailRadarCard = React.memo(function RailRadarCard({ ctx, activity }) {
  return (
    <div className="rail-card glass">
      <div className="rail-card-head">
        <Icon name="radar" size={11} color="var(--accent)" />
        <span className="mono" style={{ color: "var(--fg-2)" }}>agent radar</span>
        <span className="chip muted mono" style={{ marginLeft: "auto" }}>last 60s</span>
      </div>
      <ActivityRadar activity={activity} tps={ctx.tokensPerSec} />
      <div className="legend">
        {RADAR_LEGEND.map(([k, m]) => (
          <span key={k} className="legend-item">
            <span style={{ background: m.color }} /> {m.label}
          </span>
        ))}
      </div>
    </div>
  );
});

function AmbientRail({
  ctx, activity, messages, microcopy, onClose, sparklineValues, onMinimapClick,
  subagents, subagentPaneOpen, onOpenSubagent, onToggleSubagentPane, onOpenTree,
  trimmedCount = 0, show = {}, children,
}) {
  // Use live tps samples. Before the first turn, sparklineValues is all zeros
  // which renders as a flat baseline — honest, not fake random data.
  const sparkVals = (sparklineValues && sparklineValues.length > 0)
    ? sparklineValues
    : Array(30).fill(0);
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="mono" style={{ color: "var(--fg-3)" }}>ambient</span>
        <span className="rail-head-actions">
          <button className="btn icon ghost" onClick={onOpenTree} title="conversation tree (prompt-cache status)">
            <Icon name="branch" size={10} />
          </button>
          <button className="btn icon ghost" onClick={onClose} title="hide rail">
            <Icon name="close" size={10} />
          </button>
        </span>
      </div>

      {(show.context ?? true) && <RailContextCard ctx={ctx} sparkVals={sparkVals} />}

      {(show.radar ?? true) && <RailRadarCard ctx={ctx} activity={activity} />}

      {(show.subagents ?? true) && (
        <SubagentRailCard agents={subagents} paneOpen={subagentPaneOpen}
          onOpen={onOpenSubagent} onTogglePane={onToggleSubagentPane} />
      )}

      {children}
      {(show.minimap ?? true) && (
        <div className="rail-card glass" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 120 }}>
          <div className="rail-card-head">
            <Icon name="minimap" size={11} color="var(--fg-3)" />
            <span className="mono" style={{ color: "var(--fg-2)" }}>minimap</span>
          </div>
          <SessionMinimap messages={messages} onClick={onMinimapClick} trimmedCount={trimmedCount} />
        </div>
      )}

      {/* #28: all four cards off and no widget/plugin cards — the rail is
          an empty strip otherwise, with no pointer to where the cards went.
          `children` is always an array here (Babel wraps the slot's
          expressions, falsy entries included); only a truthy child means
          a card would render. */}
      {!React.Children.toArray(children).length
        && !(show.context ?? true) && !(show.radar ?? true)
        && !(show.subagents ?? true) && !(show.minimap ?? true) && (
        <div className="rail-empty mono">all cards off — Settings → Rail</div>
      )}
    </aside>
  );
}

Object.assign(window, { WindowChrome, TabBar, StatusBar, AmbientRail, SessionMinimap });
