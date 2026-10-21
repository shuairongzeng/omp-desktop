/* ═════════════════════════════════════════════════════════════════════
   ui/tab-bits.jsx — the two render-only pieces a conversation's name and
   run state need, shared by every surface that lists tabs: the tab bar
   (chrome.jsx), the project sidebar (project-sidebar.jsx) and the
   composer's background-job row (composer.jsx).

   They lived in tab-group-chip.jsx while the bar folded a project's tabs
   into one chip (#27); the bar is flat now (one item per conversation),
   the chip is gone, and these two outlived it — hence their own file.
   Load before chrome.jsx and project-sidebar.jsx, which destructure them
   at top level; composer.jsx reads TabRunDot at render time only.
   ═════════════════════════════════════════════════════════════════════ */

const { tabLabel: _TB_tabLabel } = window.OMP_PROJECT_NAV;

/** A tab's (or group's) run-state dot; nothing while idle. */
function TabRunDot({ state }) {
  if (!state || state === "idle") return null;
  const title = state === "waiting-user" ? "waiting for you"
    : state === "failed" ? "agent process exited"
    : state === "background" ? "background job running · the agent resumes when it finishes"
    : state === "retrying" ? "retrying a failed request"
    : "running";
  return <span className={`tab-run-dot ${state}`} title={title} />;
}

/** Name of a tab shown on its own (#46): `folder · title` once the title
 *  is no longer the folder name, the folder truncating first. `className`
 *  is the caller's name class (.tab-name in the bar, .psb-name sidebar). */
function TabLabel({ tab, className, title }) {
  const { prefix, title: name } = _TB_tabLabel(tab);
  if (!prefix) return <span className={className} title={title}>{name}</span>;
  return (
    <span className={`${className} tab-label`} title={title}>
      {/* A few letters of the folder stay visible however long the title;
          a shorter folder keeps its own width, not a padded 4ch box. */}
      <span className="tab-prefix" style={{ minWidth: `${Math.min(4, prefix.length)}ch` }}>{prefix}</span>
      <span className="tab-sep">·</span>
      <span className="tab-title">{name}</span>
    </span>
  );
}

Object.assign(window, { TabRunDot, TabLabel });
