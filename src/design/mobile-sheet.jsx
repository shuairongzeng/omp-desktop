/* design/mobile-sheet.jsx — the phone's bottom sheet primitive
   (docs/design/mobile-draft.html, frame 3).
   One component, three gestures, no portal:
     - scrim tap closes (unless dismissOnScrim=false — the parent owns
       dismissal then, e.g. a sheet whose rows commit state per-tap)
     - drag the grab handle (or any header-adjacent drag origin): the
       sheet tracks the finger 1:1 (translateY, clamp ≥0), and on
       release closes past 120px or a flick faster than 0.5px/ms,
       otherwise springs back
     - Escape closes, through the shared useEscClose stack
       (app/use-esc-close.js) — the same registry every other overlay
       uses, so a sheet never swallows the Escape a modal underneath
       expects, and vice versa. The hook is exactly for overlays, so it
       is called unconditionally at mount; the `active` flag follows
       the sheet's own open state, which is the hook's own contract.
   Rendering: fixed to the viewport bottom, 18px top corners, 38×4.5
   grab handle, slide-up entry animation, slide-down exit. All styling
   lives in composer.css's phone tier (`@media (max-width: 760px)`);
   a MobileSheet is only ever mounted from touch branches, so desktop
   never sees one.
   Consumers take `window.MobileSheet` inside their render function
   (late-bound, per the cross-package contract), never top-level. */

const { useEscClose: _MS_useEscClose } = window;

// Close thresholds: distance in px, velocity in px/ms.
const _MS_CLOSE_PX = 120;
const _MS_FLICK_V = 0.5;

function MobileSheet({ title, onClose, dismissOnScrim = true, children }) {
  // The drag offset (px, ≥0 once dragging). Null when not dragging, so
  // the transform only ever renders a real gesture or the idle 0.
  const [dy, setDy] = React.useState(null);
  const dragRef = React.useRef(null); // { y0, t0, lastY, lastT, moved }
  const sheetRef = React.useRef(null);
  // Drag-to-dismiss is a touch gesture; on a fine pointer (a phone in
  // desktop-mode UA, a hybrid with a mouse) the sheet is a centered card
  // and an inline translateY would fight the CSS centering transform.
  const coarse = window.OMP_MOBILE?.isTouch?.() ?? true;

  // Escape: the shared stack owns the listener; `active` is this sheet's
  // open state (always true while mounted — sheets unmount on close).
  _MS_useEscClose?.(onClose, true);

  const beginDrag = (e) => {
    const t = e.touches?.[0];
    if (!t) return;
    dragRef.current = { y0: t.clientY, t0: performance.now(), lastY: t.clientY, lastT: performance.now(), moved: false };
    setDy(0);
  };

  const moveDrag = (e) => {
    const d = dragRef.current;
    const t = e.touches?.[0];
    if (!d || !t) return;
    if (!d.moved && Math.abs(t.clientY - d.y0) > 3) d.moved = true;
    d.lastY = t.clientY;
    d.lastT = performance.now();
    // Downward only: a sheet cannot be dragged further up than closed-0.
    setDy(Math.max(0, t.clientY - d.y0));
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const dist = d.lastY - d.y0;
    const dt = Math.max(1, d.lastT - d.t0);
    const v = dist / dt;
    if ((d.moved && dist > _MS_CLOSE_PX) || v > _MS_FLICK_V) {
      // The exit animation owns the visual from here; onClose unmounts.
      setDy(null);
      onClose?.();
      return;
    }
    // Spring back: dy → 0 with the CSS transition; clear the drag state
    // after the settle so the transform class returns to the entry one.
    setDy(0);
  };

  const style = dy === null ? undefined : { transform: `translateY(${dy}px)`, transition: "none" };

  return (
    <div className="ms-root">
      <div className="ms-scrim" onClick={dismissOnScrim ? onClose : undefined} />
      <div className="ms-sheet" ref={sheetRef} style={style}
        role="dialog" aria-modal="true" aria-label={title || "sheet"}
        onTouchStart={coarse ? beginDrag : undefined} onTouchMove={coarse ? moveDrag : undefined}
        onTouchEnd={coarse ? endDrag : undefined} onTouchCancel={coarse ? endDrag : undefined}>
        <div className="ms-grab" />
        {title && <div className="ms-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

Object.assign(window, { MobileSheet });
