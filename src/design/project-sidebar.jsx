/* ═════════════════════════════════════════════════════════════════════
   project-sidebar.jsx — left project navigator (issue #27)

   `open`: every tab, grouped by project (folder + profile) exactly like the
   tab bar (`OMP_PROJECT_NAV.groupTabs`), multi-tab projects expandable.
   `recent`: recently opened folders of the active profile that have no
   open tab — computed by the caller (`recentRows`), since only it knows
   the active profile. Rows are containers; the click targets inside them
   are real buttons, so every action is keyboard-reachable.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, TabRunDot, TabLabel, RenameField, ProfileMenu } = window;
const { groupTabs, groupRunState, groupTarget, membersNewestFirst, basename, parentName, savedForProject } = window.OMP_PROJECT_NAV;
const { relativeTime } = window.OMP_WIDGETS;

// Saved sessions shown per expanded group; past that an "all …" row opens
// the history modal preselected on the project.
const MAX_HISTORY_ROWS = 3;

// A saved session's age label: `updated_at` (last activity) else the
// creation `timestamp`, through the widgets' epoch-ms relativeTime.
function historyAge(s) {
  const ts = Date.parse(s.updated_at || s.timestamp || "");
  return isNaN(ts) ? "" : relativeTime(ts, Date.now());
}

// Same guard as chrome.jsx's copy: the registry may not be loaded.
function sidebarHint(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

// #12: collapsed groups persist per project. A group key is already
// `profile|normPath` (project-nav.js groupKey) — pathless tabs' `tab:<id>`
// keys never survive a restart, so they fall through the JSON re-parse and
// simply start expanded, which is the old behaviour.
const COLLAPSE_KEY = "omp-desktop.sidebar.collapsed";
function _loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const map = raw ? JSON.parse(raw) : null;
    return map && typeof map === "object" ? map : {};
  } catch (_) { return {}; }
}
function _saveCollapsed(map) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map)); } catch (_) { /* quota/private mode */ }
}

// #13: platform-aware fallback for the registry-not-loaded window.
const _PSB_IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// Sidebar view tab: "open" (all tabs grouped by project) or "working"
// (non-idle tabs by attention priority). Persisted per window so a restart
// remembers the last view. The "working" tab is the #working-surface slice.
const VIEW_KEY = "omp-desktop.sidebar.view";
function _loadView() {
  try { const v = localStorage.getItem(VIEW_KEY); return v === "working" ? "working" : "open"; }
  catch (_) { return "open"; }
}
function _saveView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* quota/private mode */ }
}

function ProjectSidebar({
  tabs, activeId, recents, savedSessions = [], historyProfile, profileLabel,
  onSelectTab, onCloseTab, onRenameTab, onNewInProject, onOpenRecent, onForgetRecent, onOpenFolder, onHide, onReorder,
  onResumeSession, onShowAllHistory,
  // Drawer app menu (phone, ≤760px): the ProfileMenu props ride along so
  // the drawer's foot can host the same per-tab profile switcher the
  // desktop chrome shows. The settings row dispatches `omp:mobile
  // open-settings` (app-live.jsx owns the single listener).
  profiles = [], activeProfileId, startupProfileId,
  onSelectProfile, onCreateProfile, onRenameProfile, onDeleteProfile, onSetStartupProfile,
}) {
  // Group keys the user folded (#12): persisted as a `profile|normPath`
  // JSON map in localStorage — a restart remembers the folds. Truthy =
  // collapsed; entries for projects that no longer open simply linger
  // (bounded by distinct folders ever folded).
  const [collapsed, setCollapsed] = React.useState(_loadCollapsed);
  const toggle = key => setCollapsed(c => {
    const next = { ...c, [key]: !c[key] };
    _saveCollapsed(next);
    return next;
  });
  // Tab whose name is being edited inline (#32). Starting selects it, the
  // same as the first click of a double-click does.
  const [renaming, setRenaming] = React.useState(null);
  const startRename = id => { onSelectTab(id); setRenaming(id); };
  const renameField = t => (
    <RenameField value={t.name}
      onCommit={name => onRenameTab(t.id, name)}
      onClose={() => setRenaming(null)} />
  );
  const renameButton = t => (
    <button className="psb-act" title="rename conversation" onClick={() => startRename(t.id)}>
      <Icon name="edit" size={10} />
    </button>
  );
  const groups = groupTabs(tabs);
  // Drag to reorder (#40), the same lists as the tab bar's: projects (a
  // project's rows move as one block), and members within their project.
  const reorder = window.useDragReorder(onReorder);
  const hideHint = sidebarHint("desktop.sidebar.toggle", _PSB_IS_WIN ? "Ctrl+B" : "⌘B");

  // View tab: "open" (all tabs grouped) or "working" (non-idle by
  // priority). The working list comes from OMP_WORKING_SURFACE (already
  // loaded before this file by index.html's script order).
  const [view, setView] = React.useState(_loadView);
  const switchView = v => { setView(v); _saveView(v); };
  const workingRows = window.OMP_WORKING_SURFACE?.workingTabs(tabs) ?? [];
  const workingCount = workingRows.length;

  return (
    <aside className="project-sidebar" aria-label="projects">
      <div className="psb-head">
        <span>projects</span>
        <button className="psb-act" title={`hide sidebar (${hideHint})`} onClick={onHide}>
          <Icon name="sidebar" size={11} />
        </button>
      </div>

      <div className="psb-scroll" onPointerDown={reorder.onPointerDown}>
        {/* Segmented tab: Open (all tabs grouped) | Working (non-idle
            priority list). The working tab's badge shows the count so the
            user sees it without switching. Persisted in localStorage. */}
        <div className="psb-seg" role="tablist" aria-label="sidebar view">
          <button className={`psb-seg-tab${view === "open" ? " active" : ""}`}
            role="tab" aria-selected={view === "open"}
            onClick={() => switchView("open")}>open</button>
          <button className={`psb-seg-tab${view === "working" ? " active" : ""}`}
            role="tab" aria-selected={view === "working"}
            onClick={() => switchView("working")}>
            working
            {workingCount > 0 && <span className="psb-seg-badge">{workingCount}</span>}
          </button>
        </div>

        {view === "open" && (
          <>
            {groups.length === 0 && <div className="psb-empty">no open tabs</div>}
            {groups.map(group => {
          const multi = group.tabs.length > 1;
          // This folder's saved sessions not already open, listed only for
          // the profile the history scan ran under.
          const historyRows = savedForProject(savedSessions, tabs, group, historyProfile);
          // A single-tab project with saved sessions is expandable too:
          // its chevron reveals the history rows (a member list would just
          // duplicate the project's own row).
          const expandable = multi || historyRows.length > 0;
          const expanded = expandable && !collapsed[group.key];
          const containsActive = group.tabs.some(t => t.id === activeId);
          const profile = profileLabel(group.profile);
          const editing = !multi && renaming === group.tabs[0].id;
          const folderIcon = <Icon name="folder" size={11} color={containsActive ? "var(--accent)" : "var(--fg-4)"} />;
          // Single-tab cards show `folder · title` (#46), which ellipsizes.
          // The tooltip keeps the full title plus the folder path; multi-tab
          // project rows still tip the path (member rows tip each tab name).
          const cardTip = multi
            ? (group.path || group.name)
            : [group.tabs[0].name, group.path].filter(Boolean).join("\n");
          const members = `members:${group.key}`;
          return (
            <div key={group.key} {...reorder.itemProps("side-projects", group.key, "y")}
              className={`psb-group${reorder.dropClass("side-projects", group.key)}`}>
              {/* A multi-tab project row is only highlighted through its
                  active member row, as in the mockup; a single-tab one is
                  that tab. */}
              <div className={`psb-row psb-project ${containsActive && !expanded ? "active" : ""}`}>
                {expandable ? (
                  <button className={`psb-chev ${expanded ? "open" : ""}`}
                    title={expanded ? "collapse" : "expand"} aria-expanded={expanded}
                    onClick={e => { e.stopPropagation(); toggle(group.key); }}>
                    <Icon name="chevR" size={10} />
                  </button>
                ) : <span className="psb-chev-spacer" />}
                {editing ? (
                  <div className="psb-main psb-editing">
                    {folderIcon}
                    {renameField(group.tabs[0])}
                  </div>
                ) : (
                  <button className="psb-main" title={cardTip}
                    onClick={() => onSelectTab(groupTarget(group, activeId))}
                    onDoubleClick={() => { if (!multi) startRename(group.tabs[0].id); }}>
                    {folderIcon}
                    <span className="psb-name">{group.name}</span>
                    {profile && (
                      <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
                    )}
                    <TabRunDot state={groupRunState(group.tabs)} />
                    {multi && <span className="tab-count psb-count">{group.tabs.length}</span>}
                  </button>
                )}
                <span className="psb-actions">
                  {group.path && (
                    <button className="psb-act" title="new conversation here"
                      onClick={() => onNewInProject(group.path, group.profile)}>
                      <Icon name="plus" size={10} />
                    </button>
                  )}
                </span>
              </div>
              {expanded && membersNewestFirst(group).map(t => (
                <div key={t.id} {...reorder.itemProps(members, t.id, "y")}
                  className={`psb-row psb-tab ${t.id === activeId ? "active" : ""}${reorder.dropClass(members, t.id)}`}>
                  {renaming === t.id ? (
                    <div className="psb-main psb-editing">{renameField(t)}</div>
                  ) : (
                    <button className="psb-main" title={t.name} onClick={() => onSelectTab(t.id)}
                      onDoubleClick={() => startRename(t.id)}>
                      <span className="psb-name">{t.name}</span>
                      <TabRunDot state={t.runState} />
                    </button>
                  )}
                  <span className="psb-actions">
                    {renaming !== t.id && renameButton(t)}
                    <button className="psb-act" title="close tab" onClick={() => onCloseTab(t.id)}>
                      <Icon name="close" size={9} />
                    </button>
                  </span>
                </div>
              ))}
              {/* Saved conversations of this folder, resuming on click. */}
              {expanded && historyRows.slice(0, MAX_HISTORY_ROWS).map(s => (
                <div key={s.path || s.id} className="psb-row psb-tab psb-history">
                  <button className="psb-main" title={`${s.title}\n${s.path}`}
                    onClick={() => onResumeSession?.(s)}>
                    <Icon name="context" size={10} color="var(--fg-5)" />
                    <span className="psb-name">{s.title}</span>
                    <span className="psb-time">{historyAge(s)}</span>
                  </button>
                </div>
              ))}
              {expanded && historyRows.length > MAX_HISTORY_ROWS && (
                <div className="psb-row psb-tab psb-history">
                  <button className="psb-main psb-more"
                    title={`show all in history (${group.path})`}
                    onClick={() => onShowAllHistory?.(group.path)}>
                    <span className="psb-name">all {historyRows.length} conversations…</span>
                  </button>
                </div>
              )}
        </div>
      );
        })}
          </>
        )}

        {/* Working view: non-idle tabs sorted by attention priority
            (waiting → failed → retrying → running → background), from
            OMP_WORKING_SURFACE. Replaces the open groups list when the
            "working" tab is active. */}
        {view === "working" && (
          <>
            {workingRows.length === 0 && <div className="psb-empty">no active sessions</div>}
            {workingRows.map(t => {
              const m = (window.OMP_WORKING_SURFACE?.STATUS_META ?? {})[t.runState] ?? {};
              return (
                <div key={t.id} className={`psb-row psb-working${t.id === activeId ? " active" : ""}`}>
                  <button className="psb-main" title={`${t.name || basename(t.path)} — ${m.label || t.runState}`} onClick={() => onSelectTab(t.id)}>
                    <span className={`psb-dot psb-dot-${m.tone || "muted"}`} />
                    <span className="psb-name">{t.name || basename(t.path)}</span>
                  </button>
                  <span className={`psb-badge psb-badge-${m.tone || "muted"}`}>{m.label || t.runState}</span>
                </div>
              );
            })}
          </>
        )}

        <div className="psb-section">recent</div>
        {recents.length === 0 && <div className="psb-empty">no recent projects</div>}
        {recents.map(r => (
          <div key={r.path} className="psb-row psb-recent">
            <span className="psb-chev-spacer" />
            <button className="psb-main" title={r.path} onClick={() => onOpenRecent(r.path)}>
              <Icon name="folder" size={11} color="var(--fg-5)" />
              <span className="psb-name">
                {basename(r.path)}
                <span className="psb-parent">{parentName(r.path)}</span>
              </span>
            </button>
            <span className="psb-actions">
              <button className="psb-act" title="remove from recent" onClick={() => onForgetRecent(r.path)}>
                <Icon name="close" size={9} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <button className="psb-foot" onClick={onOpenFolder}>
        <Icon name="plus" size={11} />open folder…
      </button>

      {/* App menu pinned to the drawer's foot (phone only, sidebar.css
          ≤760px): settings + the same per-tab profile switcher the desktop
          chrome's chip hosts. Desktop renders it display:none — the
          desktop sidebar has no need for either. The settings row
          dispatches `omp:mobile open-settings`; chrome.jsx's drawer-close
          click listener (psb-app-row is in its selector) folds the drawer
          before the settings page (z-20, under the drawer's z-60) shows. */}
      <div className="psb-app">
        <button className="psb-app-row" title="settings"
          onClick={() => window.dispatchEvent(new CustomEvent("omp:mobile", { detail: { action: "open-settings" } }))}>
          <Icon name="cog" size={11} color="var(--fg-3)" />
          <span className="psb-app-name">settings</span>
        </button>
        {ProfileMenu && (
          <div className="psb-app-profile">
            <ProfileMenu
              profiles={profiles}
              activeId={activeProfileId}
              startupId={startupProfileId}
              onSelect={onSelectProfile}
              onCreate={onCreateProfile}
              onRename={onRenameProfile}
              onDelete={onDeleteProfile}
              onSetStartup={onSetStartupProfile}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

Object.assign(window, { ProjectSidebar });
