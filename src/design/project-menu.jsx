/* ═════════════════════════════════════════════════════════════════════
   project-menu.jsx — a sidebar project row's right-click menu: reveal
   the folder in the OS file manager (label named per platform, as VS
   Code does) or copy its absolute path. Both rows grey out for a
   pathless group.

   Props: { menu, onAction, onClose }
     menu     — { path, x, y } or null; x/y are the right-click's viewport
                coords, clamped here so the menu never opens off-screen
     onAction — (action, path) with action in "reveal" | "copy-path"
     onClose  — dismiss (outside click, Escape, Tab, after an action)

   Rendered by app-live.jsx at the app root; the menu chrome (surface,
   keyboard nav, dismissal) is the shared popover family, same as
   design/tab-menu.jsx. Row list and labels come from the pure
   app/project-menu.js (window.OMP_PROJECT_MENU).
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _PMIcon } = window;
const { revealLabel: _PM_revealLabel, rows: _PM_rows } = window.OMP_PROJECT_MENU;

const PMENU_W = 210;
const PMENU_H = 2 * 30 + 10; // two rows + padding

// The guest OS, for the reveal row's label: darwin / win32 / anything
// else reads as a generic file manager. navigator.platform is deprecated
// but still the only synchronous signal in every webview we ship.
function projectMenuPlatform() {
  const p = (typeof navigator !== "undefined" && navigator.platform) || "";
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Mac|iPhone|iPad/.test(p) || ua.includes("Mac OS X")) return "darwin";
  if (/Win/.test(p) || ua.includes("Windows")) return "win32";
  return "linux";
}

function ProjectMenu({ menu, onAction, onClose }) {
  const rootRef = React.useRef(null);
  const open = !!menu;
  // "copied" | "failed" | null: the copy row's transient outcome label.
  const [flash, setFlash] = React.useState(null);
  const flashTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(flashTimer.current), []);
  React.useEffect(() => { setFlash(null); }, [menu?.path]);
  window.usePopoverDismiss(open, rootRef, onClose);
  React.useEffect(() => {
    if (open) rootRef.current?.querySelector("button:not([disabled])")?.focus();
  }, [open, menu?.path]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - PMENU_W - 8);
  const y = Math.min(menu.y, window.innerHeight - PMENU_H - 8);
  const rows = _PM_rows({ path: menu.path }, projectMenuPlatform());
  const run = (r) => {
    // Both actions resolve true/false; a false (clipboard denied, folder
    // gone) flashes the row instead of closing silently.
    Promise.resolve(onAction(r.id, menu.path)).then(ok => {
      if (ok !== false && r.id === "reveal") { onClose(); return; }
      setFlash(ok === false ? "failed" : "copied");
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(onClose, 1200);
    });
  };
  return (
    <div ref={rootRef} className="tab-menu profile-pop" role="menu" aria-label="project folder actions"
      style={{ position: "fixed", left: x, top: y, zIndex: 60 }}
      onKeyDown={e => window.menuKeyNav(e, rootRef.current, ".tab-menu-item", onClose)}>
      {rows.map(r => (
        <button key={r.id} role="menuitem" disabled={r.disabled}
          className="tab-menu-item profile-item"
          onClick={() => run(r)}>
          <span className="tab-menu-label">
            {r.id === "copy-path" && flash === "copied" ? "Copied"
              : r.id === "copy-path" && flash === "failed" ? "Copy failed"
              : r.label}
          </span>
        </button>
      ))}
    </div>
  );
}

window.ProjectMenu = ProjectMenu;
