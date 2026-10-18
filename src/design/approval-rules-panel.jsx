/* ═════════════════════════════════════════════════════════════════════
   approval-rules-panel.jsx — the approvals panel (status-bar ✓, keymap
   `desktop.panel.rules`): the tool approval mode editor on top
   (approval-mode-section.jsx, #57, the same one Settings → Approvals
   shows), then the tool-approval rules granted for the active tab's
   session/project, with a revoke button per rule.
   Rules are backed by OMP_BRIDGE.listApprovalRules/revokeApprovalRule
   (src-tauri/src/approval.rs::RuleBook). Rules are granted from the ask
   bubble itself (chat/ask-bubble.jsx's "Allow for this session" /
   "Always allow in this project" buttons) — this panel is read + revoke
   only, there's no "add rule" affordance here by design: a rule should
   only ever originate from an actual prompt the human saw and approved.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _RulesIcon, ApprovalModeSection: _RulesModeSection } = window;

// Mounted only while open (app-live.jsx gates on `rulesOpen`), so there is
// no `open` prop and no early return for it: mount is open, unmount is
// closed, and the state below resets with it. `approvalModes` and `sessions` come
// from the bridge snapshot (app-live.jsx); `activeProject` is the rendered
// tab's entry, null with no tab open.
function ApprovalRulesPanel({ onClose, activeProject, sessions, approvalModes }) {
  const bridge = window.OMP_BRIDGE;
  const [rules, setRules]     = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  // Generation counter guarding `refresh` against out-of-order completions.
  const genRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!bridge) return;
    // Generation counter: a slower earlier refresh resolving after a newer
    // one must not overwrite its rules (use-keymap.jsx:62-68's pattern).
    const gen = ++genRef.current;
    setLoading(true);
    try {
      // The mode view lands in the snapshot (the `approvalModes` prop).
      // The rules list is applied only when this call is still the newest
      // one — a slower earlier refresh resolving after a newer one must
      // not overwrite its rules.
      await Promise.all([
        bridge.approvalModes(),
        bridge.listApprovalRules().then(r => {
          if (gen === genRef.current) setRules(r);
        }),
      ]);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [bridge]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const handleRevoke = async (rule) => {
    await bridge?.revokeApprovalRule(rule.tool, rule.scope);
    await refresh();
  };

  // Capture phase on `window`, not the panel's own onKeyDown: focus can sit
  // in the mode section's buttons while the panel is open, and Escape must
  // close the panel instead of reaching the global keymap's `app.interrupt`
  // (app-live.jsx's guard skips abort while this overlay is open, so the
  // key would otherwise do nothing). Same pattern as update-modal.jsx.
  // Ctrl/Alt/Meta chords pass through as global shortcuts.
  React.useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "10vh" }}>
      <div className="rules-panel" onClick={e => e.stopPropagation()}>
        <div className="rules-head">
          <_RulesIcon name="check" size={13} color="var(--accent)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>approvals</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={refresh} disabled={loading} title="refresh">
            <span className={loading ? "spin-icon" : undefined}><_RulesIcon name="refresh" size={11} /></span>
          </button>
          <button className="btn icon ghost" onClick={onClose} title="close (esc)">
            <_RulesIcon name="close" size={11} />
          </button>
        </div>
        <div className="rules-body">
          <div className="panel-sect-hd">tool approval mode</div>
          <_RulesModeSection view={approvalModes} activeProject={activeProject} sessions={sessions} />
          <div className="panel-sect-hd">standing rules</div>
          {loading && rules.length === 0 && <div className="panel-empty mono">loading…</div>}
          {!loading && rules.length === 0 && (
            <div className="panel-empty mono">
              {activeProject
                ? "no standing rules yet — grant one from an \"Allow tool\" prompt"
                : "open a tab to see its session and project rules"}
            </div>
          )}
          {rules.length > 0 && <div className="rules-list">{rules.map((rule, i) => (
            <div key={`${rule.scope}-${rule.tool}-${i}`} className="rules-row">
              <span
                className="chip"
                style={{
                  color: rule.scope === "project" ? "var(--cyan)" : "var(--fg-3)",
                  borderColor: rule.scope === "project"
                    ? "color-mix(in oklab, var(--cyan) 30%, var(--line))"
                    : "var(--line-bright)",
                }}
              >
                {rule.scope}
              </span>
              <span className="rules-tool mono">{rule.tool}</span>
              {rule.grantedAt && <span className="chip muted mono">{rule.grantedAt}</span>}
              <button
                className="btn icon ghost"
                style={{ marginLeft: "auto" }}
                title="revoke"
                onClick={() => handleRevoke(rule)}
              >
                <_RulesIcon name="trash" size={10} />
              </button>
            </div>
          ))}</div>}
        </div>
      </div>
    </div>
  );
}

window.ApprovalRulesPanel = ApprovalRulesPanel;
