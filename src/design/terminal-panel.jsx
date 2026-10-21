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
   pastes; Shift+Right-click passes through to the WebView's own menu.

   Phone tier (touch only, terminal.css's ≤760px layer sizes the parts):
   a key row under the head — Esc / sticky Ctrl / ↑ / ↓ / Tab / 粘贴 —
   whose caps write the exact bytes through useTerminal's `sendKey` (the
   same bridge.terminalWrite channel xterm's own keys take), and a
   double-tap on the handle that flips between the 240 px tweak and half
   the column. `TerminalPanels` renders the panels of every tab for
   app-live.jsx.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _TP_Icon } = window;
const {
  clampHeight: _TP_clamp, isExited: _TP_isExited, entryOf: _TP_entryOf, shellLabel: _TP_shellLabel,
} = window.OMP_TERMINAL;

// Read once at module level, the composer's `touch` convention: a coarse
// pointer drives this UI (app/mobile.js isTouch). Not a per-render check —
// the pointer kind does not change under a mounted page.
const _TP_touch = Boolean(window.OMP_MOBILE?.isTouch?.());

function TerminalPanel({
  entry, height, hidden, onHeight, onClose, onRestart, mountRef, onContextMenu, shellLabel, cwd,
  // Phone tier (touch only): the touch key row under the head and the
  // handle's two-level double-tap. `touch` gates the row's render,
  // `onKey` writes a cap's sequence, `onPaste` the clipboard, `ctrlOn`
  // lights the Ctrl cap and `onToggleCtrl` arms/disarms it (all three
  // come from useTerminal's return; optional so the panel still renders
  // when a caller passes none).
  touch, onKey, onPaste, ctrlOn, onToggleCtrl,
}) {
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

  // Phone: a drag already resizes at pointer granularity, and the drag
  // gesture needs the handle anyway — the double-tap flips between two
  // levels instead: the tweak's 240 px compact and half the session
  // column (the 820px layer caps the panel at 60% and floors it at
  // 30vh; clampHeight keeps both inside). Desktop keeps the single
  // reset level.
  // (A double-click reaches this handler after useEdgeDrag's own tap
  // cycle: a pointerdown/up pair with no move; `drag.size` is null by
  // then, so `shown` reads the committed height.)
  const toggleLevel = (e) => {
    if (!touch) return onHeight(240);
    // The handle sits inside the panel, inside the session column; the
    // event's own node is the reliable way to it (mountRef is a callback
    // ref, not a node).
    const column = e?.currentTarget?.closest?.(".session")?.getBoundingClientRect().height
      ?? window.innerHeight;
    const half = column / 2;
    onHeight(_TP_clamp(shown >= half ? 240 : half, column));
  };

  // A cap press: `seq` is the exact bytes the row writes (useTerminal's
  // `onKey`, the channel xterm's own keys take). Buttons blur on tap, so
  // the terminal's textarea keeps the focus — the soft keyboard stays
  // down and the sequence (not a keystroke) goes to the shell.
  const cap = (seq, label, extra = {}) => (
    <button type="button" className="term-key" onClick={() => onKey?.(seq)} {...extra}>
      {label}
    </button>
  );

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
        onDoubleClick={toggleLevel}
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
        <button type="button" className="btn icon ghost term-head-close" title="hide terminal" aria-label="hide terminal" onClick={onClose}>
          <_TP_Icon name="close" size={9} />
        </button>
      </div>
      {touch && (
        <div className="term-keyrow" role="toolbar" aria-label="terminal keys">
          <button
            type="button"
            className={`term-key term-key-ctrl${ctrlOn ? " on" : ""}`}
            aria-pressed={Boolean(ctrlOn)}
            title="粘滞 Ctrl：下一次按键带上 Ctrl"
            onClick={() => onToggleCtrl?.()}
          >
            Ctrl
          </button>
          {cap("\x1b", "Esc", { "aria-label": "发送 Esc" })}
          {cap("\x1b[A", "↑", { "aria-label": "上一条命令（上箭头）" })}
          {cap("\x1b[B", "↓", { "aria-label": "下一条命令（下箭头）" })}
          {cap("\t", "Tab", { "aria-label": "发送 Tab" })}
          <button
            type="button"
            className="term-key"
            title="粘贴剪贴板内容"
            aria-label="粘贴剪贴板内容"
            onClick={() => onPaste?.()}
          >
            粘贴
          </button>
        </div>
      )}
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
              // out — the body is the terminal's whole surface. Shift held:
              // the WebView's own menu is wanted after all, so the event
              // passes through untouched.
              if (e.shiftKey) return;
              e.preventDefault();
              if (!terminal.copySelection(s.id)) terminal.paste(s.id);
            }}
            shellLabel={_TP_shellLabel(entry.status?.shell)}
            cwd={s.path}
            // Phone tier: the row renders only for a coarse pointer, and
            // each cap goes through the useTerminal members above. The
            // optional chains inside the panel keep an older caller
            // (none today) rendering.
            touch={_TP_touch}
            onKey={(seq) => terminal.sendKey?.(s.id, seq)}
            onPaste={() => terminal.paste(s.id)}
            ctrlOn={Boolean(terminal.ctrlTabs?.[s.id])}
            onToggleCtrl={() => terminal.toggleCtrl?.(s.id)}
          />
        );
      })}
    </>
  );
}

Object.assign(window, { TerminalPanels });
