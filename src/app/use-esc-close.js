/* app/use-esc-close.js — the shared Escape stack.
   Everything that closes on Escape while stacked over the app (the bottom
   overlays — kanban — the bridge-scrim panels, the command bridge) used to
   install its own window keydown listener, all in capture phase. When two
   of them are open at once (kanban under the command bridge, a panel under
   another modal), *every* listener sees the key, and the bottom one closes
   first — the opposite of what a stack should do.
   This module owns the single listener: each overlay registers {close, el?}
   on open and unregisters on close (mount order = stack order); a bare
   Escape dispatches only to the topmost registration. A registration whose
   overlay is inactive (open=false but still mounted, e.g. HistoryModal's
   persistent mount) is skipped, so "topmost" is the last *active* one.
   The listener runs on `window` in capture phase, like the listeners it
   replaced: before any bubble-phase handler (the global keymap's
   app.interrupt) and before a modal's own non-Escape key guard can stop
   propagation. It prevents the event so the keymap never aborts a turn
   underneath.
   Wrapped in an IIFE so the stack doesn't leak into document scope.
   React components use the useEscClose(onClose, active) hook instead of
   touching the registry directly. */
(function () {
  /** @type {Array<{ close: Function, el?: Element, active: boolean }>} */
  const stack = [];

  function topmost() {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].active) return stack[i];
    }
    return null;
  }

  function onKey(e) {
    // Modified variants are global shortcuts (the convention every
    // replaced listener shared); an IME's Escape belongs to the IME.
    if (e.key !== "Escape") return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.isComposing) return;
    // Someone earlier in capture already claimed it.
    if (e.defaultPrevented) return;
    const top = topmost();
    if (!top) return;
    e.preventDefault();
    e.stopPropagation();
    top.close(e);
  }

  let installed = false;
  function ensureListener() {
    if (installed) return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    window.addEventListener("keydown", onKey, true);
    installed = true;
  }

  function unregister(entry) {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  }

  /** React hook: register {close} for the component's lifetime. The
   * entry's `active` flag is read through the same ref, so toggling it
   * never re-registers — the stack order stays the component's mount
   * order, not the render order. `onClose` is likewise read through a
   * ref so an inline arrow does not re-register on every render, and the
   * entry always unregisters on unmount. Assumes a `React` global, like
   * every other hook in this codebase. */
  function useEscClose(onClose, active = true) {
    const ref = React.useRef(null);
    ref.current = { onClose, active };

    const entry = React.useMemo(() => ({
      el: null,
      close: (e) => ref.current?.onClose?.(e),
      get active() { return ref.current?.active !== false; },
    }), []);

    React.useEffect(() => {
      ensureListener();
      stack.push(entry);
      return () => unregister(entry);
    }, [entry]);

    // An always-mounted overlay (the command bridge) registers once at app
    // start, so a pure mount order would leave its entry at the bottom of
    // the stack forever — below an overlay that mounted later, even while
    // it renders above it (z-100 over z-90). Moving the entry to the top
    // whenever it (re)opens makes the stack order the *open* order: the
    // overlay that opened last closes first. A mount while already active
    // (every overlay that unmounts on close) is already at the top, so
    // this only ever reorders a re-open.
    React.useEffect(() => {
      if (!active) return undefined;
      const i = stack.indexOf(entry);
      if (i >= 0 && i !== stack.length - 1) { stack.splice(i, 1); stack.push(entry); }
      return undefined;
    }, [active, entry]);
  }

  window.useEscClose = useEscClose;
})();
