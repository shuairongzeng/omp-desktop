/* ═════════════════════════════════════════════════════════════════════
   design/ui/error-boundary.jsx — fault containment for the render tree.

   Without a boundary a throw anywhere in render unmounts the whole React
   tree: #root goes empty and the window is black (the git-browser
   incident — one deleted constant took the app down). Two layers:

   - PanelBoundary: wraps an independent region (sidebar, chat stage,
     rail, a z-100 modal). One dead panel shows its crash card; the rest
     of the window keeps working.
   - AppBoundary: the single root-level fallback. Renders a full-window
     recovery card with a reload button instead of a black screen.

   Both record into window.OMP_ERRORS (app/error-watch.js) when it is
   installed, and console.error with the component stack. Same shape as
   the widgets' WidgetBoundary (widget-card.jsx): getDerivedStateFromError
   sets the error, componentDidUpdate clears it when `resetKey` changes.

   The fallback styles use hardcoded colors, not theme tokens: the last
   resort UI must stay readable even if the theme system is what threw.
   ═════════════════════════════════════════════════════════════════════ */

/** One recoverable panel. `label` names the region in the crash card
 *  ("chat", "sidebar"…). `resetKey`: a changed value clears the error and
 *  re-renders the children (e.g. the active session id), so a crash
 *  caused by one tab's data does not outlive the tab switch away. */
class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[boundary] panel "${this.props.label}" failed to render:`, error, info?.componentStack);
    try {
      window.OMP_ERRORS?.record({ kind: "render", message: `${this.props.label}: ${error?.message ?? String(error)}` });
    } catch { /* the watcher must never become the next failure */ }
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel-crash" role="alert">
        <span className="panel-crash-head">
          <_EB_Icon name="warn" size={12} />
          <span className="mono">{this.props.label} crashed</span>
        </span>
        <div className="panel-crash-msg selectable mono">{String(error?.message ?? error)}</div>
        <button className="btn ghost outlined" onClick={() => this.setState({ error: null })}>retry</button>
      </div>
    );
  }
}

/** The root fallback: one full-window recovery card instead of a black
 *  window. Reload is the only reliable recovery once the whole tree is
 *  gone; the sessions themselves live on disk and in the tab store, so a
 *  reload restores them. */
class AppBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[boundary] app failed to render:", error, info?.componentStack);
    try {
      window.OMP_ERRORS?.record({ kind: "render", message: `app: ${error?.message ?? String(error)}` });
    } catch { /* the watcher must never become the next failure */ }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash" role="alert">
        <div className="app-crash-card">
          <div className="app-crash-title">
            <_EB_Icon name="warn" size={14} />
            <span>the app hit an error</span>
          </div>
          <div className="app-crash-msg selectable mono">{String(error?.message ?? error)}</div>
          <div className="app-crash-note">your sessions are safe — reloading restores them.</div>
          <div className="app-crash-actions">
            <button className="btn primary" onClick={() => window.location.reload()}>
              <_EB_Icon name="refresh" size={11} /> reload
            </button>
            <button className="btn ghost outlined" onClick={() => this.setState({ error: null })}>try to continue</button>
          </div>
        </div>
      </div>
    );
  }
}

const _EB_Icon = window.Icon;

Object.assign(window, { PanelBoundary, AppBoundary });
