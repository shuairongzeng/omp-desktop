/* ═════════════════════════════════════════════════════════════════════
   prompt-history-modal.jsx — Ctrl+Up picker over the active tab's
   in-memory prompt history (issue #16). No fetch, no persistence: the
   list is handed in as `entries` (newest first) straight from the
   bridge snapshot.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;

function PromptHistoryModal({ open, entries, onClose, onPick, globalEntries = [] }) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  // "tab" = this tab's session-only recall (Ctrl+↑ source); "all" = the
  // cross-session archive (prompt_history.rs), persisted across restarts.
  const [scope, setScope] = React.useState("tab");
  const shown = scope === "all" ? globalEntries : entries;
  const listRef = React.useRef(null);
  const containerRef = React.useRef(null);

  // Move DOM focus onto the modal itself when it opens, and back to
  // whatever had it (the composer textarea, reached via Ctrl+Up) when it
  // closes (ui/use-modal-focus.js). The focus grab alone isn't a complete
  // guard, though: the composer has its own "refocus when streaming ends"
  // effect (composer.jsx, `!isStreaming` → `ta.focus()`) that can steal
  // focus back while this is still open mid-turn — see the capture-phase
  // keydown listener below, which is the actual guard.
  window.useModalFocus(containerRef, open);

  // Reset selection to the newest entry each time the modal opens.
  React.useEffect(() => { if (open) setActiveIdx(0); }, [open]);

  const clampedIdx = shown.length > 0 ? Math.max(0, Math.min(activeIdx, shown.length - 1)) : 0;

  React.useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.children[clampedIdx]?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx, open]);

  const pick = (text) => { onPick?.(text); onClose(); };

  // Escape closes through the shared Escape stack (app/use-esc-close.js):
  // exactly one window listener dispatches a bare Escape to the topmost
  // *active* overlay, so this picker stays open while something renders
  // above it (the command bridge) and closes only when it is itself the
  // topmost — the private branch this replaces saw the key even under
  // another scrim and closed the wrong layer. The stack's listener also
  // prevents the key, so the global keymap's `app.interrupt` never aborts
  // a turn underneath.
  window.useEscClose(onClose, open);

  // Capture phase + stopPropagation, not bubble: focus alone (above)
  // isn't a reliable guard once the composer's own streaming-end
  // refocus effect can run while this is still open, so intercept
  // before the event ever reaches the composer's onKeyDown — same
  // pattern as settings/shortcuts-editor.jsx's chord recorder. Modified keys
  // are let through untouched so Ctrl+Up still reaches the keymap
  // toggle. Escape is the stack's business (above): the guard leaves it
  // alone, so something opened over this picker doesn't also close it.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Escape") return; // the shared Esc stack closes us
      if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setActiveIdx(Math.max(0, Math.min(clampedIdx + 1, shown.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setActiveIdx(Math.max(clampedIdx - 1, 0));
      } else if (e.key === "Enter") {
        // Swallowed unconditionally, even with an empty list (nothing to
        // pick): this listener exists precisely so Enter can never reach
        // the composer's send() while the picker is open, regardless of
        // whether there's an entry under the cursor.
        e.preventDefault(); e.stopPropagation();
        if (shown[clampedIdx]) pick(shown[clampedIdx]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, shown, clampedIdx]);

  if (!open) return null;

  return (
    <div className="bridge-scrim" onClick={onClose} style={{ paddingTop: "8vh" }}>
      <div ref={containerRef} tabIndex={-1} className="bridge slide-in" onClick={e => e.stopPropagation()} style={{ width: "min(640px, calc(100vw - 32px))", maxHeight: "72vh", outline: "none" }}>
        <div className="bridge-input-row" style={{ padding: "12px 16px", gap: 10 }}>
          <Icon name="clock" size={16} color="var(--accent)" />
          <span style={{ color: "var(--fg)", fontWeight: 550 }}>Prompt history</span>
          <div role="tablist" style={{ marginLeft: "auto", display: "flex", gap: 2, background: "var(--bg-hover)", borderRadius: 8, padding: 2 }}>
            {[["tab", "this tab"], ["all", "all sessions"]].map(([key, label]) => (
              <button key={key} role="tab" aria-selected={scope === key}
                onClick={() => { setScope(key); setActiveIdx(0); }}
                style={{
                  border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer",
                  fontSize: "var(--d-text-xs)",
                  background: scope === key ? "var(--bg-elevated)" : "transparent",
                  color: scope === key ? "var(--fg)" : "var(--fg-3)",
                  fontWeight: scope === key ? 600 : 400,
                }}>
                {label}
              </button>
            ))}
          </div>
          <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
            {shown.length} {shown.length === 1 ? "prompt" : "prompts"}
          </span>
          <span className="kbd">esc</span>
        </div>

        <div ref={listRef} className="bridge-body" style={{ maxHeight: "56vh", padding: "6px 8px" }}>
          {shown.length === 0 && (
            <div className="bridge-empty">{scope === "all" ? "no prompts recorded yet" : "no prompts sent in this tab yet"}</div>
          )}
          {shown.map((text, idx) => {
            const isSelected = idx === clampedIdx;
            return (
              <div
                key={idx}
                className={`bridge-row ${isSelected ? "active" : ""}`}
                style={{
                  padding: "8px 14px", margin: "2px 0",
                  borderRadius: 10, cursor: "pointer",
                  border: isSelected ? "1px solid color-mix(in oklab, var(--accent) 30%, var(--line))" : "1px solid transparent",
                  background: isSelected ? "var(--bg-hover)" : "transparent",
                  color: isSelected ? "var(--fg)" : "var(--fg-2)",
                  fontSize: "var(--d-text-sm)",
                  lineHeight: "1.35",
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  whiteSpace: "pre-wrap",
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pick(text)}>
                {text}
              </div>
            );
          })}
        </div>

        <div className="bridge-foot mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> insert into composer
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  );
}

window.PromptHistoryModal = PromptHistoryModal;
