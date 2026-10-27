// The sidebar project group's context menu: which rows it offers, in what
// order, and when they are unavailable.
//
// Exposes `window.OMP_PROJECT_MENU`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
//
// `group` is a sidebar project group object — `{id, name, path, ...}` — whose
// `path` may be "" or undefined for a group that has no single directory.
// Both rows act on that path, so both are disabled without one.
(function () {
  /** Platform-native wording for "show this folder in the OS file browser". */
  function revealLabel(platform) {
    if (platform === "darwin") return "Reveal in Finder";
    if (platform === "win32") return "Reveal in File Explorer";
    return "Open in File Manager";
  }

  /** The menu rows for `group`, in display order. A fresh array every call,
   *  and `group` is only read. */
  function rows(group, platform) {
    const path = group && group.path;
    const disabled = !path;
    return [
      { id: "reveal", label: revealLabel(platform), disabled },
      { id: "copy-path", label: "Copy project path", disabled },
    ];
  }

  window.OMP_PROJECT_MENU = { revealLabel, rows };
})();