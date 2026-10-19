/* app/mobile.js — the phone's behaviour branches (docs/architecture/
   remote-control.md, docs/design/mobile-draft.html v1).
   Pure predicates over the environment, exposed as `window.OMP_MOBILE`
   so JSX files can read them at render time without top-level
   destructuring (the late-bound `window.X` convention):
     - isTouch():        a coarse pointer (a finger) drives this UI
     - submitOnEnter():  whether the *Enter* key should send; on a
                         touchscreen it never does — Enter is just the
                         keyboard's newline key there, and an accidental
                         mid-draft Enter firing a half-typed message is
                         the #1 reported mobile papercut. The dedicated
                         send button is the only sender.
     - placeholder(kind): the textarea's hint text, phone flavour —
                         short, lowercase, no chord glyphs (a phone has
                         no ⌘/⎋ to advertise). Desktop keeps the
                         keymap-aware fillHints() logic in composer.jsx
                         untouched; this only decides the touch branch.
   All three read `matchMedia('(pointer: coarse)')` through a tiny
   accessor so tests can stub the media query per case. */
(function () {
  "use strict";

  /** The media-query source. Overridable by tests (window-stub harness);
   *  never reads anything else, so the module stays a pure function of
   *  the environment. */
  const media = (query) => (typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : null);

  /** A coarse pointer (finger) drives the UI. Wide-enough desktops never
   *  report coarse; a touch laptop with a mouse attached reports fine,
   *  so hybrid devices take the desktop branch — the keyboard is right
   *  there and Enter-sends is the faster path. */
  function isTouch() {
    return Boolean(media("(pointer: coarse)")?.matches);
  }

  /** Whether the plain Enter key submits the draft. False on touch (the
   *  send button is the only sender; IME composition guards in
   *  constants.js stay active regardless). On desktop the decision
   *  belongs to the `submitKey` tweak + isSubmitKey, so this returns
   *  true and the composer's chord logic decides — the caller treats a
   *  `false` here as "Enter is newline, nothing else". */
  function submitOnEnter() {
    return !isTouch();
  }

  /** The textarea placeholder for `kind` ("idle" | "streaming"), touch
   *  flavour. Returns null when the environment is not touch — the
   *  caller then falls back to the desktop fillHints() string, which is
   *  the invariant this module exists to keep: one function decides
   *  which flavour shows, never two. */
  function placeholder(kind) {
    if (!isTouch()) return null;
    return kind === "streaming" ? "working… tap ⏹ to stop" : "message…";
  }

  window.OMP_MOBILE = Object.freeze({ isTouch, submitOnEnter, placeholder });
})();
