/* ═════════════════════════════════════════════════════════════════════
   history-modal.jsx — Conversation history modal & session resume
   Allows browsing and restoring sessions from ~/.omp/agent/sessions/
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, useModalLayer: _HM_useModalLayer } = window;
const { sessionProjects, normPath } = window.OMP_PROJECT_NAV;

function formatRelativeTime(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  if (isNaN(date.getTime())) return ts;
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString();
}

function HistoryModal({ open, onClose, onResume, activeCwd, initialCwd }) {
  const [sessions, setSessions]       = React.useState([]);
  const [loading, setLoading]         = React.useState(false);
  // null while loading/success; the error string when the fetch failed, so
  // the failure renders its own state instead of an identical-looking
  // "no sessions" empty list (usage-stats-panel.jsx:74-93's distinction).
  const [error, setError]             = React.useState(null);
  // null = all, else a project key. `initialCwd` preselects that project's
  // chip (the modal remounts per open); a key with no chip falls back to
  // "all" via `activeProject` below.
  const [filterKey, setFilterKey]     = React.useState(() => initialCwd ? normPath(initialCwd) || null : null);
  const [query, setQuery]             = React.useState("");
  const [activeIdx, setActiveIdx]     = React.useState(0);
  // History governance: armed two-step delete (profile-menu's armed
  // pattern), the row being inline-renamed, and a delete/rename failure
  // message. All reset on every reopen.
  const [armedDelete, setArmedDelete] = React.useState(null);
  const [renaming, setRenaming]       = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const inputRef                      = React.useRef(null);
  const listRef                       = React.useRef(null);
  const panelRef                      = React.useRef(null);
  const scrimRef                      = React.useRef(null);
  // The app behind is inert while the modal is open (the shared
  // useModalLayer, ui/use-modal-layer.js): Tab can't reach the composer
  // or the status bar underneath, and focus comes back to whatever opened
  // it. The modal itself is portaled onto <body> (below), so making #root
  // inert leaves it interactive.
  _HM_useModalLayer(scrimRef);
  // The scrim is the initial focus target; the 50ms timer below moves
  // focus into the search input once the panel has mounted.

  // The profile the modal's requests must run under — `_activeProfileId`'s
  // frontend twin (live.js owns the real one; the modal invokes the
  // command directly because `OMP_BRIDGE.listSavedSessions` takes no
  // `query`): the active tab's profile, else the no-tab pick, else the
  // startup default. Read at call time, never cached, so a snapshot that
  // lands after the modal opened still resolves the same id app-live
  // would.
  const activeProfile = () => {
    const data = window.OMP_DATA;
    const tab = data?.sessions?.find(s => s.id === data?.activeSessionId);
    return tab?.profile ?? data?.noTabProfileId ?? data?.startupProfileId ?? "default";
  };

  // Fetch the session list. `searchQuery` (the search box's live text, sent
  // after the 300ms debounce) asks the backend to match message text and
  // fill `match_snippet`; empty/undefined lists everything. The plain
  // (query-less) form stays on the bridge's own method so browser-only dev
  // mode (no Tauri runtime) keeps working; the queried form needs the
  // direct invoke.
  const fetchSessions = React.useCallback(async (searchQuery) => {
    const q = (searchQuery ?? "").trim();
    setLoading(true);
    setError(null);
    try {
      let list;
      if (q && window.__TAURI__?.core) {
        // Mirrors live.js's `list_saved_sessions` call shape (cwd null for
        // the modal: it lists every project and filters by chip locally).
        list = await window.__TAURI__.core.invoke("list_saved_sessions", {
          cwd: null,
          query: q,
          profile: activeProfile(),
        });
      } else {
        if (!window.OMP_BRIDGE?.listSavedSessions) return;
        list = await window.OMP_BRIDGE.listSavedSessions();
      }
      setSessions(list || []);
    } catch (err) {
      console.error("[HistoryModal] Failed to list sessions:", err);
      setError("couldn't load saved sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when opened
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setArmedDelete(null);
      setRenaming(null);
      setActionError(null);
      fetchSessions();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, fetchSessions]);

  // Debounced backend search: 300ms after the last keystroke, the query
  // text goes to `list_saved_sessions` for full-message-text matching
  // (title/cwd matching happens locally below, immediately, so typing
  // feels instant). A stale in-flight response is dropped by the seq guard.
  const searchSeq = React.useRef(0);
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      if (seq !== searchSeq.current) return;   // superseded mid-debounce
      await fetchSessions(q);
    }, 300);
    return () => clearTimeout(t);
  }, [open, query, fetchSessions]);

  // ── history governance actions ────────────────────────────────────────
  // Both go straight to `window.__TAURI__.core.invoke` (the shared
  // contract's frontend side): the bridge methods for these don't exist,
  // and live.js is off-limits to this slice. Same `{ profile }` arg shape
  // as the search above. A round-trip that resolves after the modal closed
  // just sets state on a closed modal — harmless, and the refresh is
  // idempotent.
  const handleDelete = async session => {
    if (armedDelete !== session.path) { setArmedDelete(session.path); setActionError(null); return; }
    setArmedDelete(null);
    setActionError(null);
    try {
      await window.__TAURI__.core.invoke("delete_saved_session", {
        path: session.path,
        profile: activeProfile(),
      });
    } catch (err) {
      console.error("[HistoryModal] delete_saved_session failed:", err);
      setActionError(String(err?.message ?? err ?? "couldn't delete"));
      return;
    }
    await fetchSessions(query.trim());
  };

  const handleRename = async (session, title) => {
    setActionError(null);
    try {
      await window.__TAURI__.core.invoke("rename_saved_session", {
        path: session.path,
        title,
        profile: activeProfile(),
      });
    } catch (err) {
      console.error("[HistoryModal] rename_saved_session failed:", err);
      setActionError(String(err?.message ?? err ?? "couldn't rename"));
      // Keep the rename field open so the user can retry/adjust.
      return;
    }
    setRenaming(null);
    await fetchSessions(query.trim());
  };

  // One chip per project among the listed sessions (#35). A key that left the
  // list on a refresh falls back to "all" rather than an empty filter.
  const projects = React.useMemo(() => sessionProjects(sessions, activeCwd), [sessions, activeCwd]);
  const activeProject = projects.find(p => p.key === filterKey) || null;
  const activeKey = activeProject ? activeProject.key : null;

  // Filtered session list. The backend (via the debounced search) has
  // already dropped non-matching sessions when a query is active; this
  // local pass keeps keystrokes feeling instant before the backend reply
  // lands and covers title/project/cwd/preview/match_snippet fields.
  const filtered = React.useMemo(() => {
    const list = activeProject ? activeProject.sessions : sessions;
    if (!query.trim()) return list;
    const q = query.toLowerCase().trim();
    return list.filter(s =>
      (s.title && s.title.toLowerCase().includes(q)) ||
      (s.project_name && s.project_name.toLowerCase().includes(q)) ||
      (s.cwd && s.cwd.toLowerCase().includes(q)) ||
      (s.preview && s.preview.toLowerCase().includes(q)) ||
      (s.match_snippet && s.match_snippet.toLowerCase().includes(q))
    );
  }, [sessions, activeProject, query]);

  // Keep activeIdx in bounds
  const clampedIdx = filtered.length > 0
    ? Math.min(Math.max(0, activeIdx), filtered.length - 1)
    : 0;

  // Scroll active item into view
  React.useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[clampedIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx]);

  // Escape closes through the shared Escape stack (app/use-esc-close.js):
  // exactly one window listener dispatches a bare Escape to the topmost
  // *active* overlay, so this modal stays open while something renders
  // above it (the command bridge, an update banner) and closes only when
  // it is itself the topmost. The stack's listener also prevents the key,
  // so the global keymap's `app.interrupt` never aborts a turn underneath.
  window.useEscClose(onClose, open);

  // Keyboard navigation + the focus guard, capture phase on `window` (not
  // the panel's own onKeyDown, not bubble): the composer refocuses itself
  // when a turn ends, and focus can then sit outside the modal while it is
  // still open — a keystroke must neither type into nor Enter-send the
  // hidden composer. Same guard as prompt-history-modal.jsx and
  // update-modal.jsx: every unmodified key belongs to the modal and never
  // reaches the global keymap; a key aimed outside is cancelled and focus
  // pulled back. Ctrl/Alt/Meta chords pass through as global shortcuts.
  // Escape itself is the stack's business (above), so it is left to the
  // stack listener; Enter on a button (chips, Refresh, try-again, a row's
  // Resume) stays the button's own click — only an Enter aimed at nothing
  // in particular resumes the active row.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // The inline rename field owns its keys (its own onKeyDown commits
      // on Enter and cancels on Escape): capture-phase interception here
      // would otherwise turn that Enter into a row resume.
      if (renaming && e.target?.closest?.("input.rename-field")) return;
      e.stopPropagation();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        // A button owns its Enter (the browser fires its click): chips,
        // Refresh, try-again, per-row Resume. Not guarding this is the
        // #round-1 bug — the preventDefault below killed the button and
        // resumed `filtered[clampedIdx]` instead.
        if (e.target?.closest?.("button")) return;
        // Otherwise swallowed unconditionally (see
        // prompt-history-modal.jsx): Enter can never reach the composer's
        // send while the modal is open, whether or not there's a session
        // under the cursor.
        e.preventDefault();
        if (filtered[clampedIdx]) {
          onResume?.(filtered[clampedIdx]);
          onClose();
        }
      } else if (!panelRef.current?.contains(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, onResume, filtered, clampedIdx, renaming]);

  if (!open) return null;

  // Portaled onto <body> (file-preview.jsx / image-lightbox.jsx's pattern)
  // so the shared useModalLayer can inert #root without taking this dialog
  // with it.
  // The scrim also takes focus when nothing inside it has — useModalLayer's
  // one focus call lands here, and the 50ms timer below moves it to the
  // search input once the panel has mounted.
  return ReactDOM.createPortal(
    <div ref={scrimRef} tabIndex={-1} className="bridge-scrim" onClick={onClose} style={{ paddingTop: "8vh" }}>
      <div ref={panelRef} tabIndex={-1} className="bridge slide-in" role="dialog" aria-modal="true" aria-label="Conversation history" onClick={e => e.stopPropagation()} style={{ width: "min(740px, calc(100vw - 32px))", maxHeight: "80vh" }}>
        
        {/* Header */}
        <div className="bridge-input-row" style={{ padding: "12px 16px", gap: 10 }}>
          <Icon name="clock" size={16} color="var(--accent)" />
          <input
            ref={inputRef}
            className="bridge-input mono"
            placeholder="Search saved conversations by title, query, project…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0); setArmedDelete(null); }}
            role="combobox"
            aria-expanded={filtered.length > 0 ? "true" : "false"}
            aria-controls="hist-rows"
            aria-autocomplete="list"
            aria-activedescendant={filtered.length > 0 ? `hist-row-${clampedIdx}` : undefined}
          />
          {query && (
            <button className="btn icon ghost" title="clear search" aria-label="clear search" onClick={() => setQuery("")}>
              <Icon name="close" size={10} color="var(--fg-4)" />
            </button>
          )}
          <button className="btn icon ghost" title="refresh from disk" aria-label="refresh from disk" onClick={() => fetchSessions(query.trim())}>
            <Icon name="refresh" size={11} color={loading ? "var(--accent)" : "var(--fg-3)"} />
          </button>
          <span className="kbd">esc</span>
        </div>

        {/* Scope bar: one chip per project, scrolling past ~2 rows */}
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "6px 14px",
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-surface)",
          fontSize: "var(--d-text-xs)",
        }}>
          <span className="mono" style={{ color: "var(--fg-4)", marginRight: 4, lineHeight: "22px" }}>filter:</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, flex: 1, minWidth: 0, maxHeight: 74, overflowY: "auto" }}>
            {/* key null = "all"; "*" cannot be the normPath of a cwd */}
            {[{ key: null, path: "", name: "All Projects", parent: "", sessions }, ...projects].map(p => (
              <button
                key={p.key ?? "*"}
                className={`btn ${activeKey === p.key ? "accent outlined" : "ghost"}`}
                style={{ height: 22, padding: "0 8px", fontSize: "var(--d-text-xs)" }}
                title={p.path || undefined}
                onClick={() => { setFilterKey(p.key); setActiveIdx(0); }}>
                {p.name}{p.parent && <span style={{ color: "var(--fg-4)" }}> · {p.parent}</span>} ({p.sessions.length})
              </button>
            ))}
          </div>
          <span className="mono" style={{ color: "var(--fg-4)", lineHeight: "22px", flexShrink: 0 }}>
            {filtered.length} {filtered.length === 1 ? "session" : "sessions"}
          </span>
        </div>

        {/* List Body */}
        <div ref={listRef} className="bridge-body" id="hist-rows" role="listbox" aria-label="Saved conversations" style={{ maxHeight: "56vh", padding: "6px 8px" }}>
          {actionError && (
            <div className="mono" style={{
              padding: "6px 14px", margin: "2px 0",
              borderRadius: 8,
              color: "var(--rose)",
              background: "color-mix(in oklab, var(--rose) 10%, transparent)",
              fontSize: "var(--d-text-xs)",
            }}>
              {actionError}
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="bridge-empty">Scanning disk for saved sessions…</div>
          )}

          {!loading && error && (
            <div className="bridge-empty">
              {error}
              <div style={{ marginTop: 12 }}>
                <button className="btn ghost" onClick={() => fetchSessions(query.trim())}>
                  <Icon name="refresh" size={11} /> try again
                </button>
              </div>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="bridge-empty">
              {query
                ? `no sessions found matching "${query}"`
                : "no saved sessions found on disk"}
            </div>
          )}

          {filtered.map((s, idx) => {
            const isSelected = idx === clampedIdx;
            const timeStr = formatRelativeTime(s.updated_at || s.timestamp);
            return (
              <div
                key={s.path || s.id || idx}
                id={`hist-row-${idx}`}
                role="option"
                aria-selected={isSelected}
                className={`bridge-row ${isSelected ? "active" : ""}`}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "stretch", gap: 5,
                  padding: "10px 14px", margin: "2px 0",
                  borderRadius: 10, cursor: "pointer",
                  border: isSelected ? "1px solid color-mix(in oklab, var(--accent) 30%, var(--line))" : "1px solid transparent",
                  background: isSelected ? "var(--bg-hover)" : "transparent",
                  transition: "background 0.12s, border-color 0.12s",
                }}
                onMouseEnter={() => {
                  setActiveIdx(idx);
                  // Moving to another row disarms that row's pending delete.
                  if (armedDelete && armedDelete !== s.path) setArmedDelete(null);
                }}
                onClick={() => {
                  // An inline rename or armed delete owns this row's click;
                  // resuming underneath it would close the modal mid-edit.
                  if (renaming === s.path || armedDelete === s.path) return;
                  onResume?.(s);
                  onClose();
                }}>
                
                {/* Top line: title (click to rename inline) + delete + time.
                    The ✕ is a two-step confirm: first click arms it into
                    "delete?", second click runs it (profile-menu's armed
                    pattern); moving to another row or typing in the search
                    box disarms it. */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <Icon name="context" size={12} color={isSelected ? "var(--accent)" : "var(--fg-3)"} />
                  {renaming === s.path ? (
                    <input
                      className="rename-field"
                      defaultValue={s.title}
                      autoFocus
                      style={{ flex: 1, height: 20, fontSize: "var(--d-text-sm)" }}
                      aria-label="rename conversation"
                      maxLength={120}
                      spellCheck={false}
                      onClick={e => e.stopPropagation()}
                      onDoubleClick={e => e.stopPropagation()}
                      onAuxClick={e => e.stopPropagation()}
                      onKeyDown={e => {
                        e.stopPropagation();
                        // `isSubmitEnter`, not a raw Enter: the Enter that
                        // commits an IME candidate must not commit a
                        // half-typed name (same as rename-field.jsx).
                        if (window.isSubmitEnter?.(e)) {
                          e.preventDefault();
                          handleRename(s, e.target.value.trim());
                          return;
                        }
                        if (e.key === "Escape" && !(e.nativeEvent?.isComposing ?? e.isComposing)) {
                          e.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  ) : (
                    <span
                      title="click to rename"
                      style={{
                        fontWeight: 550,
                        color: isSelected ? "var(--accent)" : "var(--fg)",
                        fontSize: "var(--d-text-sm)",
                        flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                      onClick={e => {
                        e.stopPropagation();
                        setArmedDelete(null);
                        setRenaming(s.path);
                      }}>
                      {s.title}
                    </span>
                  )}
                  <button
                    className={`btn icon ghost hist-del ${armedDelete === s.path ? "armed" : ""}`}
                    style={{
                      height: 20, padding: "0 6px", flexShrink: 0,
                      color: armedDelete === s.path ? "var(--rose)" : "var(--fg-4)",
                      background: armedDelete === s.path
                        ? "color-mix(in oklab, var(--rose) 14%, transparent)"
                        : undefined,
                    }}
                    title={armedDelete === s.path ? "click again to move to .trash" : `delete “${s.title}”`}
                    aria-label={`delete ${s.title}`}
                    onClick={e => {
                      e.stopPropagation();
                      setRenaming(null);
                      handleDelete(s);
                    }}>
                    {armedDelete === s.path
                      ? <span className="mono" style={{ fontSize: "var(--d-text-xs)" }}>delete?</span>
                      : <Icon name="close" size={10} />}
                  </button>
                  <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)", flexShrink: 0 }}>
                    {timeStr}
                  </span>
                </div>

                {/* Second line: project chip, message count, and cwd */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                  <span className="chip" style={{
                    padding: "1px 6px",
                    background: "color-mix(in oklab, var(--cyan) 10%, transparent)",
                    borderColor: "color-mix(in oklab, var(--cyan) 25%, var(--line))",
                    color: "var(--cyan)",
                    fontSize: "var(--d-text-xs)",
                  }}>
                    <Icon name="folder" size={9} color="var(--cyan)" />
                    <span className="mono">{s.project_name}</span>
                  </span>

                  {s.message_count > 0 && (
                    <span className="chip muted mono" style={{ fontSize: "var(--d-text-xs)", padding: "1px 6px" }}>
                      {s.message_count} {s.message_count === 1 ? "turn" : "turns"}
                    </span>
                  )}

                  {s.cwd && (
                    <span className="mono" style={{
                      color: "var(--fg-4)", fontSize: "var(--d-text-xs)",
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {s.cwd}
                    </span>
                  )}

                  <button
                    className="btn ghost accent"
                    style={{ height: 20, padding: "0 8px", fontSize: "var(--d-text-xs)", marginLeft: "auto", flexShrink: 0 }}
                    aria-label={`resume ${s.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onResume?.(s);
                      onClose();
                    }}>
                    Resume ↵
                  </button>
                </div>

                {/* Third line: the search hit's snippet when a backend query
                    matched message text, else the last-message preview. */}
                {(s.match_snippet || s.preview) && (
                  <div style={{
                    color: "var(--fg-3)", fontSize: "var(--d-text-xs)",
                    lineHeight: "1.35",
                    paddingLeft: "calc(0.75rem + 8px)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {s.match_snippet || s.preview}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="bridge-foot mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> resume
          <span className="kbd">esc</span> close
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-4)" }}>~/.omp/agent/sessions</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

window.HistoryModal = HistoryModal;
