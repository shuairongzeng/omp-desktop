/* widgets/widget-card.jsx — rail cards for widget plugins (user guide:
   docs/widgets.md). The card model is neutral — a title plus a `run`
   `{ state: "idle"|"running"|"ok"|"error", widget, error, durationMs, at,
   lastOkAt }` built by app/use-widgets.jsx — so other widget sources (#52)
   can reuse WidgetCard. Also the approval card a plugin shows until its
   exact command is approved, the card for a config-level error, and the
   per-card error boundary. Blocks come from widgets/widget-blocks.jsx. */

const { Icon: _WC_Icon, WidgetBlocks: _WC_Blocks, OMP_WIDGETS: { argvDisplay: _WC_argvDisplay, relativeTime: _WC_relativeTime } } = window;

// #25: relative labels for the card's timestamps — minute-granular, and
// "2m" beats "14:32" for glance reading. Uses OMP_WIDGETS.relativeTime,
// the same helper the project sidebar's history rows use.
function _wcWhen(ms) {
  if (!ms) return "";
  return _WC_relativeTime(ms, Date.now());
}

/** #21: config-level errors (widgets.json). `configPath` and the settings
 *  button come through props from the caller (app-live); the prop is a
 *  transparent passthrough — openSettings wiring lives there. */
function WidgetErrorCard({ title, error, configPath, onOpenSettings }) {
  return (
    <div className="rail-card glass wdg-card tone-error">
      <div className="rail-card-head">
        <span className="wdg-dot" />
        <span className="mono wdg-title">{title}</span>
      </div>
      <div className="wdg-error selectable">{error}</div>
      {configPath && (
        <>
          <div className="wdg-note mono selectable" title={configPath}>{configPath}</div>
          {onOpenSettings && (
            <button className="btn ghost outlined" onClick={onOpenSettings}>
              <_WC_Icon name="cog" size={10} /> open settings
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** `source`: set for content another program pushes (omp extensions, #52)
 *  rather than a plugin run — shown as the card's chip in place of the run
 *  timing, with the accent border. */
function WidgetCard({ title, run, onRefresh, onInsert, source }) {
  const state = run?.state ?? "idle";
  const widget = run?.widget ?? null;
  const toneClass = state === "error" ? "tone-error" : state === "ok" && widget ? `tone-${widget.status}` : "tone-neutral";
  const stale = state === "running" && widget != null;
  const meta = source ?? (state === "running" ? "running…" : run?.durationMs != null ? `${run.durationMs} ms · ${_wcWhen(run.at)}` : "");
  return (
    <div className={`rail-card glass wdg-card ${toneClass}${stale ? " wdg-stale" : ""}${source ? " wdg-pushed" : ""}`}>
      <div className="rail-card-head">
        <span className={`wdg-dot${state === "running" ? " pulse-dot" : ""}`} />
        <span className="mono wdg-title">{title}</span>
        {meta ? <span className="chip muted mono wdg-meta">{meta}</span> : <span className="wdg-meta" />}
        {onRefresh && (
          <button className="btn icon ghost" title="refresh" aria-label={`refresh ${title}`} disabled={state === "running"} onClick={onRefresh}>
            <_WC_Icon name="refresh" size={10} />
          </button>
        )}
      </div>
      {state === "error" && (
        <>
          <div className="wdg-error selectable">{run.error}</div>
          {run.lastOkAt != null && <div className="wdg-note mono">last ok {_wcWhen(run.lastOkAt)}</div>}
        </>
      )}
      {(state === "ok" || stale) && widget && (
        <>
          <_WC_Blocks blocks={widget.blocks} onInsert={onInsert} />
          {widget.skipped > 0 && <div className="wdg-note mono">{widget.skipped} unsupported block{widget.skipped > 1 ? "s" : ""}</div>}
        </>
      )}
      {state === "idle" && <div className="wdg-note mono">not run yet</div>}
    </div>
  );
}

/** A plugin that has never been approved, or whose command or script
 *  changed since (`changed`), runs nothing until the user approves its exact
 *  argv here. The argv is shown one element per line, quoted and escaped
 *  (OMP_WIDGETS.argvDisplay): this card is the only gate, so a newline, an
 *  empty argument or a bidi override must not change what the user reads. */
function WidgetApprovalCard({ title, command, changed, onApprove, onDismiss }) {
  const [busy, setBusy] = React.useState(false);
  const approve = () => {
    if (busy || !onApprove) return;
    setBusy(true);
    // The card unmounts once the approval lands; on a stale fingerprint it
    // stays and the button must work again.
    Promise.resolve()
      .then(onApprove)
      .catch((err) => console.error("[widgets] approve failed:", err))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`rail-card glass wdg-card wdg-approval${changed ? " wdg-approval-changed" : ""}`}>
      <div className="rail-card-head">
        <span className="wdg-dot" />
        <span className="mono wdg-title">{title}</span>
        <span className="chip muted mono wdg-meta">{changed ? "changed" : "needs approval"}</span>
      </div>
      <div className="wdg-note">
        {changed
          ? "This plugin's command or script changed since you approved it. It will not run until you approve it again."
          : "This plugin runs the command below automatically once approved."}
      </div>
      <div className="wdg-argv mono selectable">
        {(command ?? []).map((arg, i) => <div key={i} className="wdg-argv-line">{_WC_argvDisplay(arg)}</div>)}
      </div>
      <div className="wdg-approval-actions">
        {/* #20: "not now" hides the card for this session only (the
            approval itself is untouched); `onDismiss` is a no-op prop
            without the caller's session state. */}
        {onDismiss && (
          <button className="btn ghost" onClick={onDismiss} title="hide this card for the rest of the session">
            not now
          </button>
        )}
        <button className="btn primary" disabled={busy || !onApprove} onClick={approve}>
          {changed ? "approve again" : "approve"}
        </button>
      </div>
    </div>
  );
}

/** Per-card error boundary: a render error in one card shows that card's
 *  error card instead of unmounting the app. A changed `resetKey` (e.g. a new
 *  run) clears the error and renders the children again. */
class WidgetBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[widgets] card "${this.props.title}" failed to render:`, error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <WidgetErrorCard title={this.props.title} error={`render failed: ${error?.message ?? String(error)}`} />;
  }
}

Object.assign(window, { WidgetCard, WidgetErrorCard, WidgetApprovalCard, WidgetBoundary });
