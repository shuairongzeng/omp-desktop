// The project sidebar's "working" section: which tabs are doing something
// that wants the user's attention, and in what order they line up.
//
// Exposes `window.OMP_WORKING_SURFACE`; wrapped as an IIFE per the project
// rule for plain <script> tags (see AGENTS.md "IIFE rule").
//
// A "row" is a snapshot `sessions` entry: `{id, name, path, runState, ...}`.
// Sorting is stable: rows of the same priority keep their registry order,
// so a tab running for a while never jumps around between snapshots.
(function () {
  /** Run states that belong in the working section — everything but `idle`. */
  const WORKING_STATES = new Set(["waiting-user", "running", "retrying", "background", "failed"]);

  /** Attention order, lower first: a tab waiting on the user outranks a
   *  failure (which the user may still want to see before a retry that is
   *  already in flight), and a quiet background job comes last. */
  const PRIORITY = { "waiting-user": 0, failed: 1, retrying: 2, running: 3, background: 4 };

  /** Badge meta per working state: `label` is the short English tag,
   *  `icon` an Icon name (src/design/ui/icons.jsx), `tone` the CSS var
   *  suffix the badge colours itself with. */
  const STATUS_META = {
    "waiting-user": { label: "waiting", icon: "check", tone: "warn" },
    failed: { label: "failed", icon: "warn", tone: "error" },
    retrying: { label: "retrying", icon: "refresh", tone: "warn" },
    running: { label: "running", icon: "play", tone: "accent" },
    background: { label: "background", icon: "clock", tone: "muted" },
  };

  const rankOf = row => {
    const p = row && PRIORITY[row.runState];
    return p === undefined ? Infinity : p;
  };

  /** The working rows of `tabs`, most attention-worthy first; a new array,
   *  the input is never reordered or mutated. */
  function workingTabs(tabs) {
    if (!Array.isArray(tabs)) return [];
    const ranked = [];
    for (let i = 0; i < tabs.length; i++) {
      const row = tabs[i];
      if (row && WORKING_STATES.has(row.runState)) ranked.push({ row, i });
    }
    ranked.sort((a, b) => rankOf(a.row) - rankOf(b.row) || a.i - b.i);
    return ranked.map(entry => entry.row);
  }

  /** Counts per working state for a header badge, in priority order; states
   *  with no row are left out entirely. */
  function countBadge(rows) {
    const counts = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const state = row && row.runState;
      if (WORKING_STATES.has(state)) counts[state] = (counts[state] || 0) + 1;
    }
    const out = {};
    for (const state of Object.keys(PRIORITY)) if (counts[state]) out[state] = counts[state];
    return out;
  }

  window.OMP_WORKING_SURFACE = {
    WORKING_STATES,
    PRIORITY,
    STATUS_META,
    workingTabs,
    countBadge,
  };
})();