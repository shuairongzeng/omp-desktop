# Optimization log

The running ledger of performance/UX optimization rounds on this repo. Every
round appends one section: what changed, the measured before/after, and — as
important — the approaches that were tried and **rejected**, with the reason,
so a later round never re-walks a dead end. New rounds read this file first.

Format per round: date · scope · measured result · status · dead ends.

---

## R1 — Frontend bundling + minification (2026-10-26)

- **Scope**: `scripts/build-frontend.mjs` merges the 66 plain `app/*.js` +
  `live.js` + `adapter.js` files into one minified `app-bundle.js` and the 87
  compiled JSX files into one minified `design-bundle.js` (esbuild
  `transformSync`, `target: es2022`). Vendor files (react, react-dom, marked,
  highlight) stay separate — already minified, cached independently. xterm and
  qrcode remain lazy-loaded on first terminal/QR use.
- **Measured**: script tags 159 → 6 (−96%); first-paint JS 850 KB → 363 KB
  gzipped (−57%); verified live over HTTPS on the relay (per-file
  `curl -H "Accept-Encoding: gzip"` sizes).
- **Status**: shipped (`133e472`). Desktop release bundle and phone page both
  E2E-verified rendering.
- **Dead ends**:
  - *core/lazy code splitting* (settings/history/git/terminal/remote modules
    out of the first paint, ~294 KB target): **rejected** — `app-live.jsx` and
    `live.js` destructure `window.OMP_*` globals at top level, so a module
    must exist before they run; true lazy loading needs an ESM/dynamic-import
    migration of the IIFE architecture. Two black-screen/`l.THEMES` incidents
    proved it during the attempt.
  - *esbuild CSS minification*: **rejected** — esbuild's CSS minifier
    re-serialises `@import` rules and broke the `?v=` stamping chain; a 32 KB
    saving is not worth a broken cascade. Revisit with a CSS-native minifier.

## R2 — Cache-busting version stamp (2026-10-26)

- **Scope**: `build-frontend.mjs` version stamp = `tauri.conf.json` version +
  first 8 hex of SHA-256 over the two bundle files (`0.11.0-048e8123`).
- **Why**: a same-version redeploy changed bundle content but not `?v=`, so a
  phone's cached `index.html` kept serving the old bundle (the "black screen"
  report after R1's relay deploy).
- **Status**: shipped (`25d77e6`); relay etag + new stamp verified over HTTPS.
- **Dead ends**: none — the earlier manual `<!-- bundle v2 -->` etag bump on
  the server was a stopgap, removed by this deploy.

## R3 — Sidebar project-row context menu (2026-10-27)

- **Scope**: right-click a sidebar project row → "Reveal in Finder" /
  "Reveal in File Explorer" / "Open in File Manager" (platform-named) +
  "Copy project path". Rust `reveal_project_path` validates (absolute,
  existing dir) then `open::that_detached` under `spawn_gate::shared()`;
  copy goes through the webview clipboard with a "Copied"/"Copy failed" flash.
  Pure rows/labels in `app/project-menu.js`; phone drawer unaffected.
- **Status**: shipped (`500edc8`). E2E: menu rendered, `pbpaste` matched the
  project path exactly, Finder became frontmost on reveal.
- **Dead ends**: none.

## R4 — Reopen closed tab, Ctrl+Shift+T (2026-10-27)

- **Scope**: closed-tab stack (`app/closed-tabs.js`, LIFO cap 20); `live.js`
  pushes `{sessionFile, profile, path}` on every `closeSession` (only tabs
  with a `.jsonl` on disk can return); keymap action `desktop.tab.reopen`
  (Ctrl+Shift+T / Shift+Super+T, Chrome-Firefox-VS Code vocabulary) pops and
  resumes via `resumeSession(session, profile)` — which gained an optional
  profile override so a tab reopens under its own profile, not the active
  one. `resumeSession`'s focus-existing lookup makes a stale stack entry
  harmless (focuses instead of double-spawning).
- **Status**: shipped. Verified by `tests/test-closed-tabs.mjs` (21 checks),
  the keymap↔Rust `ACTION_IDS` sync test, and a real-machine E2E: closed the
  active exodus-py tab with Ctrl+W (tab left the bar, moved to sidebar
  recents), pressed Ctrl+Shift+T — the tab returned active with its full
  transcript restored.
- **Dead ends**: none yet.

---

## Open backlog (candidates for future rounds, unstarted)

- Service Worker static cache for the phone page (second visit < 500 ms).
- True lazy loading of panel modules (needs the ESM migration R1 rejected).
- WS-layer compression (permessage-deflate) — rejected in the phone-lag round:
  axum/tokio-tungstenite need both ends to negotiate; app-layer gzip on
  projected payloads already covers the win.
- P2P/WebRTC phone↔desktop — rejected: TURN *is* the relay, so the relay stays
  and two transports get maintained; projection+gzip beats P2P on a 3 Mbps
  uplink by ~10×.
