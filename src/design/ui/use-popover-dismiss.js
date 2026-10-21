/* ui/use-popover-dismiss.js — outside-click / Escape dismissal shared by the
   dropdown menus (profile-menu.jsx, thinking-menu.jsx, path-setting.jsx).

   usePopoverDismiss(open, rootRef, onOutside, onEscape = onOutside): while
   `open`, a mousedown outside `rootRef` calls `onOutside`, and Escape calls
   `onEscape`. Escape is prevented, so the window keymap (use-keymap.jsx
   skips defaultPrevented events) does not also abort the running turn. The
   listeners are attached only while open, and the callbacks are read
   through a ref, so an inline arrow does not re-attach them every render.

   menuKeyNav(e, menu, selector, close): a menu's onKeyDown. Arrows, Home
   and End move focus between the `selector` items in `menu`; Tab closes the
   menu, prevented so Shift+Tab does nothing else. A single-character key
   types ahead: the first item whose text starts with the typed letter
   (cycling past the focused one on a repeat of the same letter). Keys
   from an inline text field inside the menu (an item being renamed) stay
   the field's. Ctrl/Alt/Meta chords are left to the window keymap
   (Ctrl+Tab, …). */

(function () {
  function usePopoverDismiss(open, rootRef, onOutside, onEscape = onOutside) {
    const handlers = React.useRef(null);
    handlers.current = { onOutside, onEscape };

    React.useEffect(() => {
      if (!open) return undefined;
      const onDown = e => { if (!rootRef.current?.contains(e.target)) handlers.current.onOutside(); };
      const onKey  = e => { if (e.key === "Escape") { e.preventDefault(); handlers.current.onEscape(); } };
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [open, rootRef]);
  }

  function menuKeyNav(e, menu, selector, close) {
    // Keys typed into an inline text field (a group row being renamed)
    // are the field's, never menu navigation.
    if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Tab") { e.preventDefault(); close(); return; }
    const all = [...menu.querySelectorAll(selector)];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? all[(i + 1) % all.length]
      : e.key === "ArrowUp" ? all[i <= 0 ? all.length - 1 : i - 1]
      : e.key === "Home" ? all[0]
      : e.key === "End" ? all[all.length - 1]
      : null;
    if (next) {
      e.preventDefault();
      next.focus();
      return;
    }
    // Character typeahead: one printable key jumps to the first item whose
    // text starts with it; repeating the same letter cycles to the next
    // item with that letter, wrapping, as browser menus do. Space is
    // skipped (a scroll key, and a "select" key on menus elsewhere), and
    // so is Shift (the browser's caret shortcuts, not menu letters).
    if (e.key.length === 1 && e.key !== " " && !e.shiftKey) {
      const prefix = e.key.toLowerCase();
      const texts = all.map(el => (el.textContent || "").trim().toLowerCase());
      let hit = texts.findIndex((text, j) => text.startsWith(prefix) && j > i);
      if (hit < 0) hit = texts.findIndex(text => text.startsWith(prefix));
      if (hit >= 0 && hit !== i) {
        e.preventDefault();
        all[hit].focus();
      }
    }
  }

  window.usePopoverDismiss = usePopoverDismiss;
  window.menuKeyNav = menuKeyNav;
})();
