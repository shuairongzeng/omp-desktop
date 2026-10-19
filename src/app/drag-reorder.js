// Drag-to-reorder geometry (issue #40): where a dragged tab-bar item or
// sidebar row would land. Pure; the pointer handling around it is
// `design/ui/use-drag-reorder.js`, the reorder itself `OMP_PROJECT_NAV`'s
// `moveGroup` / `moveMember`.
//
// Exposes `window.OMP_DRAG_REORDER`; wrapped as an IIFE per the project
// rule for plain <script> tags (see AGENTS.md "IIFE rule").
(function () {
  /** Pointer travel, in CSS px, before a press becomes a drag. Below it the
   *  press stays a click, so a slightly shaky click still selects. */
  const DRAG_THRESHOLD_PX = 5;
  /** Coarse pointers (touchscreens) arm at a longer travel: a finger's
   *  landing slop dwarfs a mouse's, and at 5px every scroll and long-press
   *  began a reorder (mobile walk-through). */
  const TOUCH_DRAG_THRESHOLD_PX = 16;

  /** Whether a press has become a drag. `opts.coarse` (the caller resolves
   *  `(pointer: coarse)` itself, so this stays pure and Node-testable) swaps
   *  in the touch threshold and adds a main-axis gate: with `opts.axis`, the
   *  travel accumulated from the press origin must run along the list's own
   *  axis (`|dx| > |dy|` on an "x" bar) at the moment it crosses the
   *  threshold, else the gesture is a scroll or a tap on the cross axis and
   *  never starts a drag. The fine-pointer path is byte-for-byte the old
   *  behaviour: threshold only, no gate. */
  function pastThreshold(dx, dy, { coarse = false, axis = null } = {}) {
    const t = coarse ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
    if (dx * dx + dy * dy < t * t) return false;
    if (coarse && axis) {
      const main = axis === "x" ? Math.abs(dx) : Math.abs(dy);
      const cross = axis === "x" ? Math.abs(dy) : Math.abs(dx);
      if (main <= cross) return false;
    }
    return true;
  }

  /** Drop position for item `srcId` with the pointer at `pos` on the drag
   *  axis. `items` are the list's items in display order, each with its
   *  `start`/`end` on that axis. The pointer goes before the first item whose
   *  middle it has not passed, else after the last item, so a pointer beyond
   *  either end of the list still has a slot. Returns `{ targetId, after }`,
   *  or `null` when `srcId` is not in the list or would stay where it is. */
  function dropSlot(items, srcId, pos) {
    const from = items.findIndex(it => it.id === srcId);
    if (from < 0) return null;
    let slot = items.findIndex(it => pos < (it.start + it.end) / 2);
    if (slot < 0) slot = items.length;
    if (slot === from || slot === from + 1) return null;
    return slot < items.length
      ? { targetId: items[slot].id, after: false }
      : { targetId: items[items.length - 1].id, after: true };
  }

  window.OMP_DRAG_REORDER = { DRAG_THRESHOLD_PX, TOUCH_DRAG_THRESHOLD_PX, pastThreshold, dropSlot };

})();
