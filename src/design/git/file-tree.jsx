/* git/file-tree.jsx — the git browser's files pane: Rust's tree with git
   status marks, a changed-only filter and a name filter. While a commit is
   browsed the tree is the files it touched: changed-only is forced on, its
   toggle hidden and the head names the commit. Changed-only shows every
   directory open, so a directory row is inert there (the shared expansion
   set is the full tree's). Row logic is app/git-browser.js
   (OMP_GIT_BROWSER). */

const { Icon: _GT_Icon } = window;
const { flatten: _GT_flatten, filterFiles: _GT_filterFiles } = window.OMP_GIT_BROWSER;

const GIT_STATUS_META = {
  Modified:  { label: "M", color: "var(--amber)",  title: "modified" },
  Added:     { label: "A", color: "var(--accent)", title: "added" },
  Deleted:   { label: "D", color: "var(--rose)",   title: "deleted" },
  Renamed:   { label: "R", color: "var(--cyan)",   title: "renamed" },
  Untracked: { label: "U", color: "var(--fg-3)",   title: "untracked" },
};

/** Roving-tabindex key nav for the file tree (ARIA tree pattern, mirroring
 *  `_ST_radioKeyNav` in settings/controls.jsx): ↑/↓ move between rows,
 *  → expands a collapsed dir or descends, ← collapses an expanded dir or
 *  ascends to the nearest visible ancestor, Home/End jump to the ends,
 *  Enter selects a file / toggles a dir. Directory behaviour mirrors the
 *  click: a dir is inert under `changedOnly` (every dir is forced open and
 *  the expansion set belongs to the full tree). Rows carry `data-idx` into
 *  `rows`, so the DOM lookup is one query per keypress. */
function _GT_treeKeyNav(e, rows, { expanded, onSelect, onToggle, changedOnly }) {
  if (e.defaultPrevented) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"];
  if (!keys.includes(e.key)) return;
  const container = e.currentTarget;
  const items = [...container.querySelectorAll("[data-idx]")];
  if (!rows.length || items.length !== rows.length) return;
  const i = items.indexOf(document.activeElement);
  if (i < 0 && e.key !== "Home" && e.key !== "End") return;
  const node = rows[i]?.node;
  const isOpen = node?.dir && (changedOnly || expanded.has(node.path));
  const move = j => {
    e.preventDefault();
    const target = items[(j + rows.length) % rows.length];
    if (target) target.focus();
  };
  switch (e.key) {
    case "ArrowUp":   return move(i - 1);
    case "ArrowDown": return move(i + 1);
    case "Home":      return move(0);
    case "End":       return move(rows.length - 1);
    case "Enter":
      e.preventDefault();
      if (!node) return;
      if (!node.dir) onSelect(node.path);
      else if (!changedOnly) onToggle(node.path);
      return;
    case "ArrowRight":
      e.preventDefault();
      // Expand a collapsed dir; descend into an expanded one; a file row
      // (a leaf) ignores the key, per the ARIA tree pattern.
      if (!node?.dir) return;
      if (!isOpen && !changedOnly) { onToggle(node.path); return; }
      return move(i + 1);
    case "ArrowLeft": {
      e.preventDefault();
      if (node?.dir && isOpen && !changedOnly) { onToggle(node.path); return; }
      // Ascend: the nearest visible ancestor above this row.
      if (!node) return;
      const prefix = `${node.path}/`;
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j].node.dir && prefix.startsWith(`${rows[j].node.path}/`)) {
          items[j]?.focus();
          return;
        }
      }
      return;
    }
  }
}
function GitFileTree({
  root, error, expanded, onToggle, selected, onSelect, changedOnly, onChangedOnly,
  filter, onFilter, changedCount, commit, truncated,
}) {
  const rows = React.useMemo(() => {
    // A name filter lists matching files flat: the tree would need every
    // ancestor expanded to show them, and the match is on the whole path.
    if (filter.trim()) return _GT_filterFiles(root, filter, changedOnly).map(node => ({ node, depth: 0, flat: true }));
    return _GT_flatten(root, expanded, changedOnly);
  }, [root, expanded, changedOnly, filter]);
  // Whether any visible file row is the selected one — picks the roving
  // tab stop (that row, else the first row) below.
  const hasActive = selected != null && rows.some(r => !r.node.dir && r.node.path === selected);


  let empty = null;
  if (error) empty = error;
  // A failed status replaces the whole browser, so no root and no error
  // means still loading.
  else if (!root) empty = "loading…";
  else if (rows.length === 0) empty = filter.trim() ? "no match" : changedOnly && !commit ? "no changes" : "no files";

  return (
    <div className="gitb-pane gitb-files">
      <div className="gitb-pane-head">
        <span className="gitb-pane-title">files</span>
        {commit && (
          <span className="gitb-pane-sub mono" title={commit.id}>{commit.short} · {commit.files} file{commit.files === 1 ? "" : "s"}</span>
        )}
        {onChangedOnly && (
          <button type="button" className={`btn ghost gitb-toggle ${changedOnly ? "on" : ""}`}
            onClick={() => onChangedOnly(!changedOnly)} title={changedOnly ? "show every file" : "show changed files only"}
            aria-pressed={changedOnly}>
            <_GT_Icon name="diff2" size={11} />
            <span>{changedCount} changed</span>
          </button>
        )}
      </div>
      <div className="gitb-filter">
        <_GT_Icon name="search" size={11} color="var(--fg-4)" />
        <input className="gitb-filter-input mono" value={filter} onChange={e => onFilter(e.target.value)}
          placeholder="filter files" spellCheck={false} />
        {filter && <button type="button" className="btn ghost icon" onClick={() => onFilter("")} aria-label="clear filter"><_GT_Icon name="close" size={10} /></button>}
      </div>
      <div className="gitb-tree" role="tree" aria-label="files"
        onKeyDown={e => _GT_treeKeyNav(e, rows, { expanded, onSelect, onToggle, changedOnly })}>
        {empty && <div className={`gitb-empty ${error ? "gitb-error" : ""}`}>{empty}</div>}
        {!error && rows.map(({ node, depth, flat }, i) => {
          const meta = node.status ? GIT_STATUS_META[node.status] : null;
          const active = !node.dir && node.path === selected;
          // Roving tabindex: the selected file row is the tab stop (or the
          // first row when none is); every other row is reached by arrow.
          const focusStop = active || (i === 0 && !hasActive);
          // A file and a dir can share a path ("x" deleted, "x/a" added").
          return (
            <div key={`${node.dir ? "d" : "f"}:${node.path}`} role="treeitem" aria-selected={active}
              aria-level={depth + 1} data-idx={i} tabIndex={focusStop ? 0 : -1}
              aria-expanded={node.dir ? changedOnly || expanded.has(node.path) : undefined}
              className={`gitb-row ${node.dir ? "dir" : "file"} ${node.dir && changedOnly ? "inert" : ""} ${active ? "active" : ""} ${node.status === "Deleted" ? "deleted" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (!node.dir) onSelect(node.path);
                else if (!changedOnly) onToggle(node.path);
              }}>
              {node.dir
                ? <_GT_Icon name={changedOnly || expanded.has(node.path) ? "chev" : "chevR"} size={11} color="var(--fg-4)" />
                : <span className="gitb-row-pad" />}
              <span className="gitb-row-name" style={meta ? { color: meta.color } : undefined}>
                {flat ? node.path : node.name}
              </span>
              {node.dir && node.changed > 0 && !changedOnly && <span className="gitb-dot" title={`${node.changed} changed`} />}
              {meta && <span className="gitb-mark mono" style={{ color: meta.color }} title={meta.title}>{meta.label}</span>}
            </div>
          );
        })}
        {!error && root && truncated && <div className="gitb-empty">list truncated — too many files to show them all</div>}
      </div>
    </div>
  );
}

window.GitFileTree = GitFileTree;
window.GIT_STATUS_META = GIT_STATUS_META;
