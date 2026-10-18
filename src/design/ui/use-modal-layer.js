// ui/use-modal-layer.js — the shared "inert the app behind" modal hook.
// A modal rendered in a portal on <body> makes #root inert while it is
// open, so Tab can't reach — and Enter can't press — what opened it, and
// focus goes back there on close (preventScroll: the opener may have
// scrolled out of view meanwhile, e.g. a streaming reply, and scrolling
// back would unpin the chat from the bottom — app/scroll-pin.js).
//
// Same behaviour as chat/image-lightbox.jsx's `useModalLayer`, extracted
// so portals outside the chat can share it, with one addition: an `open`
// dependency. The lightbox and file-preview mount only while open (the
// effect's mount IS the open), but an always-mounted overlay (the command
// bridge, which early-returns null when closed) toggles `open` on the
// same component instance — the effect has to re-run for the inert state
// to follow.
//
// Wrapped in an IIFE so `useModalLayer` doesn't leak into document scope.
(function () {
  function useModalLayer(scrimRef, open = true) {
    React.useEffect(() => {
      if (!open) return undefined;
      const prev = document.activeElement;
      const root = document.getElementById("root");
      if (root) root.inert = true;
      scrimRef.current?.focus();
      return () => {
        if (root) root.inert = false;
        // preventScroll: the opener may have scrolled out of view meanwhile
        // (a streaming reply), and scrolling back to it would unpin the chat
        // from the bottom (app/scroll-pin.js).
        if (prev?.isConnected) prev.focus({ preventScroll: true });
      };
    }, [scrimRef, open]);
  }

  window.useModalLayer = useModalLayer;
})();
