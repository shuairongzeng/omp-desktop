/* app/mobile-viewport.js — the phone's true viewport height.
   iOS Safari (and every mobile browser worth the name) shrinks
   *visualViewport* when the software keyboard opens, but 100vh/100%
   keep measuring the layout viewport — so the composer stays glued to
   the *screen* bottom, under the keyboard, where no thumb can reach it.
   This publishes the live value as the `--vvh` custom property on
   <html>; the mobile CSS blocks (composer.css's phone tier) use
   `height: var(--vvh, 100%)` for .window/.app, which snaps the whole
   app to the *visible* height, keyboard included.
   Desktop never runs anything here past the feature test: visualViewport
   is desktop browsers' API too, but their resize events only fire on
   window resizes, the property is read (harmlessly) by nobody — every
   consumer lives inside `@media (max-width: 760px)`. */
(function () {
  "use strict";

  function install() {
    const vv = window.visualViewport;
    if (!vv) return;
    const write = () => {
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    };
    // Both: keyboard open fires resize, page scroll (toolbar collapse)
    // fires scroll; either can change the usable height.
    vv.addEventListener("resize", write);
    vv.addEventListener("scroll", write);
    write();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
