/* git/git-browser.jsx — the git browser: a full-window view of the active
   tab's project. Files pane (git/file-tree.jsx), the selected file with its
   change inline (git/file-view.jsx), commit graph with refs
   (git/history.jsx). Opened from the status bar's git button, the
   `desktop.panel.changes` chord, or a path in an edit card (initialPath).
   Every datum comes from app/use-git-browser.jsx (useGitBrowser); a history
   click browses that commit read-only, the working-tree row returns.
   At git.css's phone tier (≤760px) the three panes collapse into one
   tabbed pane: the 220px + 280px column minimums sum past a 390px
   viewport and squeeze the diff column to 0px, so below the breakpoint
   only the active pane renders, behind a .gitb-tabs segment control. */

const { Icon: _GB_Icon, GitFileTree: _GB_Tree, GitFileView: _GB_View, GitHistory: _GB_History } = window;

/** The window is inside git.css's phone tier (≤760px), the tier whose
 *  three-column grid no longer fits. Read once at mount and again on
 *  every breakpoint crossing; pre-matchMedia engines see false, which is
 *  the desktop layout — the safe default. */
function _GB_isPhoneLayout() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)").matches
    : false;
}
// Memoised: App re-renders on every streamed frame, and none of them touch
// these props (`edits` is a count, not the transcript).
const GitBrowser = React.memo(function GitBrowser({ bridge, onClose, initialPath, branch, edits }) {
  const g = window.useGitBrowser({ bridge, initialPath, branch, edits });
  const rootRef = React.useRef(null);

  // The dialog takes focus, so keystrokes never reach the hidden composer;
  // on close the focus goes back where it was (the composer, usually).
  React.useEffect(() => {
    const restore = document.activeElement;
    rootRef.current?.focus();
    return () => { restore?.focus?.(); };
  }, []);

  // Escape closes through the shared Escape stack (app/use-esc-close.js):
  // exactly one window listener dispatches a bare Escape to the topmost
  // *active* overlay, so this browser (z-90) stays open while something
  // renders above it (the command bridge, a bridge-scrim panel, z-100) and
  // closes only when it is itself the topmost — the private listener this
  // replaces approximated that with a focus-in-a-bridge-scrim probe, which
  // mis-guessed whenever focus sat elsewhere (the composer refocuses its
  // textarea when a turn ends). The stack's listener also prevents the key,
  // so the global keymap's `app.interrupt` (use-keymap.jsx) never aborts a
  // turn underneath.
  window.useEscClose(onClose);

  // The phone tier's active pane ("files" | "diff" | "history"). The CSS
  // breakpoint alone owns what *renders wide*; this state only decides
  // which single pane the phone tier shows. `isPhone` follows the media
  // query so a desktop window dragged across the boundary re-renders both
  // ways with no leftover state (the chosen pane is harmless at desktop
  // width: the tab strip is display:none and all three panes render).
  const [isPhone, setIsPhone] = React.useState(() => _GB_isPhoneLayout());
  React.useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 760px)");
    if (!mq?.addEventListener) return undefined;
    const onChange = () => setIsPhone(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [pane, setPane] = React.useState(null);
  // Once the first status arrives the default pane lands: the diff of the
  // file the browser opened on (initialPath or the first changed file —
  // use-git-browser picks it), else the files list. A null pane before
  // that shows Files, which needs no data.
  const paneSet = pane !== null;
  React.useEffect(() => {
    if (!paneSet && g.tree) setPane(g.selected ? "diff" : "files");
  }, [paneSet, g.tree, g.selected]);
  // `pane` survives a breakpoint crossing on purpose: a user who chose
  // History stays on History after a resize round-trip.
  const active = pane ?? "files";
  const mobile = isPhone && active; // "" only if matchMedia is missing

  // The scrim closes on a click that both starts and ends on it, never on a
  // drag-select that merely ends there.
  const downOnScrim = React.useRef(false);

  const repo = g.status?.repo ?? null;
  const changed = g.status?.changed ?? 0;
  const inCommit = Boolean(g.commitSha);

  // The branch chip (or the short sha of a detached HEAD); an unborn branch
  // has a name but no commit yet, so it gets both chips.
  let headChip = null;
  if (repo?.branch) headChip = <span className="gitb-ref head"><_GB_Icon name="branch" size={9} />{repo.branch}</span>;
  else if (repo?.head) headChip = <span className="gitb-ref remote" title="detached HEAD">{repo.head.slice(0, 7)}</span>;
  const unbornChip = repo && !repo.head ? <span className="gitb-ref none" title="unborn branch">no commits</span> : null;

  return (
    <div className="gitb-scrim"
      onMouseDown={e => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnScrim.current && e.target === e.currentTarget) onClose(); downOnScrim.current = false; }}>
      <div className="gitb" ref={rootRef} role="dialog" aria-modal="true" aria-label="git browser" tabIndex={-1}>
        <div className="gitb-head">
          <_GB_Icon name="branch" size={13} color="var(--accent)" />
          <span className="gitb-title">git</span>
          {repo && <span className="gitb-project">{repo.name}</span>}
          {headChip}{unbornChip}
          {repo && (repo.ahead || repo.behind) ? (
            <span className="gitb-chip mono" title="ahead / behind upstream">↑{repo.ahead ?? 0} ↓{repo.behind ?? 0}</span>
          ) : null}
          <span className="gitb-head-stats mono">
            {g.status && <span>{changed} changed</span>}
          </span>
          <button type="button" className="btn ghost" onClick={g.refresh} title="refresh" aria-label="refresh"><_GB_Icon name="refresh" size={12} /></button>
          <button type="button" className="btn ghost" onClick={onClose} title="close (Esc)" aria-label="close"><_GB_Icon name="close" size={12} /></button>
        </div>
        {g.error ? (
          <div className="gitb-empty tall gitb-error">{g.error}</div>
        ) : (
          <>
            {mobile && (
              <div className="gitb-tabs" role="tablist" aria-label="git browser panes">
                <button type="button" role="tab" className={`gitb-tab ${active === "files" ? "on" : ""}`}
                  aria-selected={active === "files"} onClick={() => setPane("files")}>Files</button>
                <button type="button" role="tab" className={`gitb-tab ${active === "diff" ? "on" : ""}`}
                  aria-selected={active === "diff"} onClick={() => setPane("diff")}>Diff</button>
                <button type="button" role="tab" className={`gitb-tab ${active === "history" ? "on" : ""}`}
                  aria-selected={active === "history"} onClick={() => setPane("history")}>History</button>
              </div>
            )}
            <div className="gitb-body">
              {(!mobile || active === "files") && (
                <_GB_Tree root={g.tree} error={g.commitError}
                  expanded={g.expanded} onToggle={g.toggleDir} selected={g.selected} onSelect={g.select}
                  changedOnly={inCommit || g.changedOnly} onChangedOnly={inCommit ? null : g.setChangedOnly}
                  filter={g.filter} onFilter={g.setFilter} changedCount={changed}
                  commit={g.commit} truncated={g.truncated} />
              )}
              {(!mobile || active === "diff") && (
                <_GB_View path={g.selected} file={g.file} error={g.fileError} commit={g.commit}
                  onStage={inCommit ? null : () => g.stage(g.selected)}
                  onDiscard={inCommit ? null : () => g.discard(g.selected, g.file?.status ?? null)} />
              )}
              {(!mobile || active === "history") && (
                <_GB_History log={g.log} changedCount={changed}
                  selected={g.commitSha ?? "@"} onSelect={g.browse} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

window.GitBrowser = GitBrowser;
