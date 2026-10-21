// Tab-bar density stages: the flat bar shows one tab per conversation
// (the #40 tab bar work), so as tabs accumulate it must degrade through
// denser stages before it ever needs to scroll.
//
// Exposes `window.OMP_TAB_BAR`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
(function () {
  /** Density stage for the tab strip: how much room each of `count` tabs
   *  gets in `clientWidth` px decides what a tab may show — 0 full
   *  (folder icon + title + profile chip, >=140px each), 1 compact
   *  (title capped, no profile chip, >=96), 2 icon-only (>=48), 3 = stage 2
   *  plus horizontal scroll with edge fades. count <= 0 -> 0. */
  function stage(clientWidth, count) {
    if (!Number.isFinite(clientWidth) || clientWidth < 0 || !(count > 0)) return 0;
    const per = clientWidth / count;
    if (per >= 140) return 0;
    if (per >= 96) return 1;
    if (per >= 48) return 2;
    return 3;
  }

  window.OMP_TAB_BAR = {
    stage,
  };
})();