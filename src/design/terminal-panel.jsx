/* ═════════════════════════════════════════════════════════════════════
   design/terminal-panel.jsx — one tab's terminal panel: a head (shell,
   folder, a starting dot, an exited-restart badge, close), the node xterm
   mounts into, and a drag / keyboard handle on the top edge (role=
   separator: arrows step 16 px, Shift 64, Home/End the bounds, double-
   click resets to 240). Hidden tabs and collapsed panels stay mounted
   (`hidden`), so the xterm keeps its output; app/use-terminal.jsx owns
   the xterm and hands over `mountRef`. A drag (left button) starts from
   the height the panel is rendered at — CSS caps it at 70 % of the
   column, which may be less than the saved tweak after the window
   shrank — and reports the final height once (`onHeight`,
   ui/use-edge-drag.js). Right-click on the body copies a selection, else
   pastes. `TerminalPanels` renders the panels of every tab for
   app-live.jsx.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _TP_Icon } = window;
const {
  clampHeight: _TP_clamp, isExited: _TP_isExited, entryOf: _TP_entryOf, shellLabel: _TP_shellLabel,
} = window.OMP_TERMINAL;

function TerminalPanel({ entry, height, hidden, onHeight, onClose, onRestart, mountRef, onContextMenu, shellLabel, cwd }) {
  const drag = window.useEdgeDrag({
    begin: (e) => {
      const column = e.currentTarget.closest(".session");
      return {
        start: Math.round(e.currentTarget.parentElement.getBoundingClientRect().height),
        startY: e.clientY,
        columnHeight: column ? column.getBoundingClientRect().height : window.innerHeight,
      };
    },
    measure: (e, d) => _TP_clamp(d.start + d.startY - e.clientY, d.columnHeight),
    commit: onHeight,
  });
  // The handle's keys (ui/resize-handle.jsx's vertical sibling): arrows
  // step 16 px, Shift 64; Home/End are the bounds, Enter-sized reset is the
  // double-click. A resize-handle.jsx with an orientation prop lives in
  // another agent's slice, so the interaction is local and matches it.
  const shown = drag.size ?? height;
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const col = e.currentTarget.closest(".session")?.getBoundingClientRect().height ?? window.innerHeight;
    const now = _TP_clamp(shown, col);
    const step = e.shiftKey ? 64 : 16;
    let to = null;
    if (e.key === "ArrowUp") to = now + step;
    else if (e.key === "ArrowDown") to = now - step;
    else if (e.key === "Home") to = _TP_clamp(0, col);
    else if (e.key === "End") to = _TP_clamp(Number.MAX_SAFE_INTEGER, col);
    if (to == null) return;
    e.preventDefault();
    onHeight(_TP_clamp(to, col));
  };
  const exited = _TP_isExited(entry);

  return (
    <section className="term-panel" hidden={hidden} style={{ height: shown }}>
      <div
        className={`term-handle${drag.size != null ? " dragging" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="resize terminal panel"
        aria-valuenow={Math.round(shown)}
        aria-valuemin={120}
        tabIndex={0}
        title="drag to resize, double-click for the default height"
        {...drag.handlers}
        onDoubleClick={() => onHeight(240)}
        onKeyDown={onKeyDown}
      >
        <span className="term-handle-tip">{Math.round(shown)} px</span>
      </div>
      <div className="term-head">
        <_TP_Icon name="terminal" size={11} color="var(--fg-3)" />
        <span className="term-head-shell">{shellLabel}</span>
        {cwd && <span className="term-head-cwd" title={cwd}>{cwd}</span>}
        {entry.status?.state === "starting" && (
          <span className="term-head-starting" title="waiting for the shell">
            <span className="term-head-dot" />starting…
          </span>
        )}
        {exited && (
          <button type="button" className="term-head-exited" onClick={onRestart}
            title={entry.error != null ? entry.error : "start a new shell"}>
            <_TP_Icon name="refresh" size={9} />
            <span className="term-head-exited-text">
              {entry.error != null
                ? `${entry.error} — restart`
                : `exited${entry.status.exitCode == null ? "" : ` (code ${entry.status.exitCode})`} — restart`}
            </span>
          </button>
        )}
        <button type="button" className="btn icon ghost term-head-close" title="hide terminal" onClick={onClose}>
          <_TP_Icon name="close" size={9} />
        </button>
      </div>
      <div className="term-body" ref={mountRef} onContextMenu={onContextMenu} />
    </section>
  );
}

/**
 * One panel per tab that has ever opened its terminal (`created`; a pending
 * or failed first spawn included). Only the active tab's open panel shows;
 * the others stay mounted but hidden, so a shell's output keeps arriving
 * off-screen and its xterm survives a hide. `terminal` is useTerminal's
 * return value, `activeId` the active tab's id.
 */
function TerminalPanels({ sessions, activeId, terminal }) {
  return (
    <>
      {sessions.map((s) => {
        const entry = _TP_entryOf(terminal.state, s.id);
        if (!entry.created) return null;
        return (
          <TerminalPanel key={s.id}
            entry={entry}
            height={terminal.height}
            hidden={s.id !== activeId || !entry.open}
            onHeight={terminal.setHeight}
            onClose={() => terminal.close(s.id)}
            onRestart={() => terminal.respawn(s.id)}
            mountRef={terminal.mountFor(s.id)}
            onContextMenu={(e) => {
              // No selection: right-click pastes (the terminal's own paste
              // path); with one it copies. Either way the page's menu stays
              // out — the body is the terminal's whole surface.
              e.preventDefault();
              if (!terminal.copySelection(s.id)) terminal.paste(s.id);
            }}
            shellLabel={_TP_shellLabel(entry.status?.shell)}
            cwd={s.path}
          />
        );
      })}
    </>
  );
}

Object.assign(window, { TerminalPanels });
