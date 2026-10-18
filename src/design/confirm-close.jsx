/* ═════════════════════════════════════════════════════════════════════
   confirm-close.jsx — "Ask before closing a busy tab" (#37, Settings →
   Session): the confirmation shown before closing a tab whose agent is
   still at work, or quitting with such tabs.

   Props: { confirm, onAnswer }
     confirm  — the snapshot's `closeConfirm` (live.js; shape from
                app/session-prefs.js `tabCloseConfirm` / `quitConfirm`:
                { kind, title, body, tabs: [{id, name, state}], confirmLabel })
     onAnswer — called with true (close / quit) or false (keep); app-live.jsx
                passes `OMP_BRIDGE.resolveCloseConfirm`.

   Mounted only while `confirm` is set. Focus starts on "keep": Enter must
   not stop a working agent by accident.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _CCIcon } = window;

function ConfirmCloseDialog({ confirm, onAnswer }) {
  const panelRef = React.useRef(null);
  const keepRef = React.useRef(null);

  // "keep" takes focus; it goes back where it was on close.
  window.useModalFocus(keepRef);

  // Escape keeps everything (the same answer as the scrim click) through
  // the shared Escape stack (app/use-esc-close.js): exactly one window
  // listener dispatches a bare Escape to the topmost *active* overlay —
  // the private branch this replaces saw the key even under another
  // scrim and answered a dialog buried below it. The stack's listener
  // also prevents the key, so the global keymap's `app.interrupt` never
  // aborts a turn underneath.
  window.useEscClose(() => onAnswer(false));

  // Capture-phase guard: while the dialog is open no key reaches the
  // composer or the window keymap (Ctrl+W behind it would close a tab).
  // Tab cycles the dialog's buttons, Enter/Space press the focused one;
  // every other key does nothing, and a key aimed outside pulls focus
  // back in. Escape is the stack's business (above): the guard only
  // contains it, so something opened over this dialog doesn't also
  // answer it.
  React.useEffect(() => {
    const onKey = e => {
      e.stopPropagation();
      const panel = panelRef.current;
      const inside = !!panel?.contains(e.target);
      if (e.key === "Escape") return; // the shared Esc stack closes us
      if (e.key === "Tab") {
        e.preventDefault();
        const buttons = [...(panel?.querySelectorAll("button") ?? [])];
        if (!buttons.length) return;
        const i = buttons.indexOf(document.activeElement);
        const n = buttons.length;
        buttons[i < 0 ? 0 : (i + (e.shiftKey ? n - 1 : 1)) % n].focus();
        return;
      }
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      if (inside && plain && (e.key === "Enter" || e.key === " ")) return;
      e.preventDefault();
      if (!inside) keepRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onAnswer]);

  return (
    <div className="bridge-scrim" onClick={() => onAnswer(false)} style={{ paddingTop: "18vh" }}>
      <div className="close-confirm-panel" ref={panelRef} tabIndex={-1} role="alertdialog" aria-modal="true"
        aria-label={confirm.title} onClick={e => e.stopPropagation()}>
        <div className="close-confirm-head">
          <_CCIcon name="warn" size={13} color="var(--amber)" />
          <span className="mono" style={{ color: "var(--fg-2)" }}>{confirm.title}</span>
        </div>
        <div className="close-confirm-body">
          <div>{confirm.body}</div>
          <ul className="close-confirm-tabs">
            {confirm.tabs.map(tab => (
              <li key={tab.id} className="close-confirm-tab mono">
                <span className="close-confirm-tab-name">{tab.name}</span>
                <span className="close-confirm-tab-state">{tab.state}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="close-confirm-foot">
          <button className="btn ghost" ref={keepRef} onClick={() => onAnswer(false)}>
            {confirm.kind === "quit" ? "keep running" : "keep tab"}
          </button>
          <button className="btn outlined danger" onClick={() => onAnswer(true)}>{confirm.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

window.ConfirmCloseDialog = ConfirmCloseDialog;
