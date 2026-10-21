/* ═════════════════════════════════════════════════════════════════════
   tab-menu.jsx — a tab's right-click menu (Chrome/Firefox/VS Code naming):
   Close · Close other tabs · Close tabs to the left · Close tabs to the
   right. The left/right items grey out when the set they would close is
   empty; "Close other tabs" when the bar holds one tab.

   Props: { menu, onAction, onClose }
     menu     — { tabId, x, y, counts: { others, left, right } } or null;
                x/y are the right-click's viewport coords, clamped here so
                the menu never opens off-screen
     onAction — (action, tabId) with action in
                "close" | "others" | "left" | "right"
     onClose  — dismiss (outside click, Escape, Tab, after an action)

   Rendered by app-live.jsx at the app root; the menu chrome (surface,
   keyboard nav, dismissal) is the shared popover family.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _TMIcon } = window;

const MENU_W = 196;
const MENU_H = 4 * 30 + 10; // four rows + padding, generous

function TabMenu({ menu, onAction, onClose }) {
  const rootRef = React.useRef(null);
  const open = !!menu;
  window.usePopoverDismiss(open, rootRef, onClose);
  React.useEffect(() => {
    if (open) rootRef.current?.querySelector("button:not([disabled])")?.focus();
  }, [open, menu?.tabId]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(menu.y, window.innerHeight - MENU_H - 8);
  const rows = [
    { action: "close", label: "Close", count: 0 },
    { action: "others", label: "Close other tabs", count: menu.counts.others },
    { action: "left", label: "Close tabs to the left", count: menu.counts.left },
    { action: "right", label: "Close tabs to the right", count: menu.counts.right },
  ];
  return (
    <div ref={rootRef} className="tab-menu profile-pop" role="menu" aria-label="tab actions"
      style={{ position: "fixed", left: x, top: y, zIndex: 60 }}
      onKeyDown={e => window.menuKeyNav(e, rootRef.current, ".tab-menu-item", onClose)}>
      {rows.map(r => {
        const disabled = r.action !== "close" && r.count === 0;
        return (
          <button key={r.action} role="menuitem" disabled={disabled}
            className="tab-menu-item profile-item"
            onClick={() => { onAction(r.action, menu.tabId); onClose(); }}>
            <span className="tab-menu-label">{r.label}</span>
            {r.count > 0 && <span className="tab-menu-count mono">{r.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

window.TabMenu = TabMenu;
