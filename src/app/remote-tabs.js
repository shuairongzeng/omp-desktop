/* app/remote-tabs.js — the phone's tab-table merge (docs/architecture/
   remote-control.md; pure half of the boot path in live.js).
   A remote client never replays open-tabs.json — that is the desktop's
   layout — it mirrors the desktop's live tab list from `js:list_tabs`
   into its own sessionRegistry instead. This module owns that merge so
   it is testable without a window or a Tauri bridge, exposed as
   `window.OMP_REMOTE_TABS` (the late-bound `window.X` convention):
     - mergeSnapshot(registry, tabs): for every snapshot row whose id is
       not yet in the registry, returns the entry to insert. The caller
       does the `sessionRegistry.set(id, entry)` calls; this function
       never mutates the registry or the snapshot.
   The six defaults mirror what the old `_attachRemoteTabs` inlined for
   every attached tab: no approval mode chosen yet, no session file, and
   auto-rename disarmed — the desktop owns renames of its own tabs, so
   the phone must not arm a second renamer over the same omp process.
   Snapshot fields win over the defaults (`...tab` last). */
(function () {
  "use strict";

  /** Per-tab state the phone attaches to a desktop tab, before the
   *  snapshot row is layered on. Kept as a factory: the same object must
   *  never be shared between inserted entries. */
  const attachedDefaults = () => ({
    approvalMode: null,
    sessionFile: null,
    autoRenameArmed: false,
    autoRenameInFlight: false,
    autoRenameTurns: 0,
    autoRenameLeft: 0,
  });

  /** Merge a `js:list_tabs` snapshot into the live registry's tab table.
   *  `registry` is any object with `.has(id)` (a Map in practice);
   *  `tabs` is the snapshot's rows, each `{ id, name, path, ... }`.
   *
   *  Returns `{ added, ids }` in snapshot order: `added` holds
   *  `{ id, entry }` pairs for rows the registry does not have yet, and
   *  `ids` lists those same ids (the caller's insert order and the
   *  `ask-settled` guard both read it). Rows without a non-empty string
   *  id are skipped entirely, as are rows already attached. Pure: the
   *  registry and every snapshot row are left untouched. */
  function mergeSnapshot(registry, tabs) {
    const added = [];
    const ids = [];
    if (!Array.isArray(tabs)) return { added, ids };
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== "string" || tab.id === "") continue;
      if (registry.has(tab.id)) continue;
      added.push({ id: tab.id, entry: { ...attachedDefaults(), ...tab } });
      ids.push(tab.id);
    }
    return { added, ids };
  }

  /** Does the active tab need its transcript window re-fetched?
   *  omp only reports a tab's `sessionFile` in `get_state` once the file
   *  exists, so the first window fetch can race it and come back empty.
   *  `prevFile` is the session file the phone last fetched for that tab,
   *  `nextFile` the freshly reported one. True iff `nextFile` is a usable
   *  path and it is not the one already fetched: a null/undefined/""
   *  `prevFile` with a real `nextFile` counts (first sight of the file),
   *  while an unchanged or absent `nextFile` never does. Pure. */
  function refetchWindow(prevFile, nextFile) {
    return (
      typeof nextFile === "string" &&
      nextFile.length > 0 &&
      nextFile !== prevFile
    );
  }

  window.OMP_REMOTE_TABS = Object.freeze({ mergeSnapshot, refetchWindow });
})();