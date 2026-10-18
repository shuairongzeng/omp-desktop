/* app/quote-selection.js — "quote into the composer" rules behind the
   floating button that appears when a chat selection ends (IIFE →
   window.OMP_QUOTE; pure). app-live.jsx listens for mouseup, asks
   `quotableText` whether the selection earns the button, places it with
   `popoverPos`, and on a pick hands the text to the composer through
   `promptInsert`. */
(function () {
  /* A selection earns the button only when it is a real range of text
     inside the chat transcript — both ends in `.chat-scroll`, and neither
     end inside a typing surface (the composer, an ask's answer box, an
     inline rename) where selection is editing, not quoting. */
  function quotableText(sel) {
    if (!sel || sel.isCollapsed) return null;
    const text = String(sel.toString()).replace(/\s+$/, "");
    if (!text.trim()) return null;
    for (const node of [sel.anchorNode, sel.focusNode]) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el || typeof el.closest !== "function") return null;
      if (!el.closest(".chat-scroll")) return null;
      if (el.closest("input, textarea, [contenteditable]")) return null;
    }
    return text;
  }

  /* Fixed-position pill above the selection's end, flipped below when
     there is no headroom, clamped to the viewport's 8px margin. Returns
     CSS left/top for a popover of the given (measured or estimated)
     size. */
  function popoverPos(rect, vw, vh, popW = 132, popH = 30) {
    const gap = 8;
    let x = rect.right - popW / 2;
    x = Math.max(gap, Math.min(x, vw - popW - gap));
    let y = rect.top - popH - gap;
    if (y < gap) y = rect.bottom + gap;
    // The flip can land off-screen too (a selection scrolled wholly above
    // the viewport): clamp unconditionally.
    y = Math.max(gap, Math.min(y, vh - popH - gap));
    return { x, y };
  }

  window.OMP_QUOTE = { quotableText, popoverPos };
})();
