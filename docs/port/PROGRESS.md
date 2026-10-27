# Electron port — progress tracker

Branch `feat/electron-port`, worktree `/Users/jackey/GitHub/omp-desktop-electron`.
Main (`master`) must never receive port commits. Full-port route per
`docs/architecture/electron-migration-assessment.md` (spike evidence in
`docs/port/spikes/`).

## Milestones and kill criteria

| ID | Scope | Kill criterion | Status |
|---|---|---|---|
| M0 | Scaffold + gates: Electron 45 main/preload, `npm test` chain runs the 67 pure JS suites unchanged | scaffold cannot boot | **done**: boot log shows 13 startup calls answered, `npm test` exit 0 in the worktree |
| M1 | `window.__TAURI__` shim + real `dist/` frontend boots against stub backend; every startup command stubbed per `docs/port/startup-contract.md` | stub shapes stall startup | **boot-proven** (2026-10-27): titlebar crash (`isMaximized`) fixed via `omp:win` channel; zero error boundaries on boot |
| M2 | Side-effect-free backend in Node: json stores, profiles, recents, saved sessions, keybindings — parity tests ported from the Rust suites | parity coverage < Rust test count for these modules | **done** (2026-10-27): stores 40 + saved-sessions 32 + keybindings 43 parity tests green; wired into the dispatcher; measured: boot reads the real `open-tabs.json`, real recents/history/keybindings answers in the stub log |
| M3 | Hard core: node-pty terminal, CDP broker over Chromium's pipe, git reads via **isomorphic-git** (decided 2026-10-27, bench on the real 17 MB repo: status 47 ms, log(100) 25 ms, readCommit 1 ms, listFiles 1 ms — pure JS also never runs git's filter drivers, strictly safer than gix's discovery path) | 2× estimate or semantic gaps untestable | **mostly done** (2026-10-27): agent 125 checks (real-omp smoke 357 ms), terminal 41, git 52 (status 103 ms on the real repo, byte-equal to `git status --porcelain`), browser-core 45 (NUL-framed CDP broker, no debugging port); measured through the real webview: tab restore → omp spawn → message round trip on disk, terminal open/write/first-frame seq 1 via webview events, git_browser_status on the real repo. Browser view/proxy/annotate slice in flight |
| M4 | E2E crypto (node:crypto, same wire as the phone's noble bundle) + relay wire compatibility | relay rejects enc frames | **done** (2026-10-27): 30 crypto checks incl. phone-JS cross-implementation interop + live ws loopback; remote-files 35 checks (178 MB session scan 0 diffs vs JSON oracle, 124 ms); **live-relay measured**: a temp device id registered on 39.105.79.222, port `RemoteConnector` connected in 129 ms over pinned-cert TLS, status online, relay `hello` (caps res-unicast/transcript-window/hello) received; temp id revoked, relay back to its 2 real devices |
| M5 | updater, packaging, signing, full E2E, merge decision | — | not started |

Per-milestone discipline: rebase onto master before starting; kill the line
and write a post-mortem here if a milestone exceeds 2× its estimate or
master drift stops rebasing cleanly.

## Task board

### Done
- M0 scaffold: `electron/main.js`, `electron/preload.js`, `electron/stub-backend.js`,
  `package.json` (electron + node-pty + ws + @noble deps declared), gates wired.
- Spike evidence committed (`docs/port/spikes/`).
- Assessment doc carried from master (it landed there first).

### In progress
- M1: startup contract forensics (`docs/port/startup-contract.md`, scout),
  then stub backend + real-dist boot + CDP screenshot.

### Remaining (ordered)
- M1 stub backend per contract; boot proof; screenshot.
- M2 stores/profiles/recents/saved-sessions/keybindings + parity tests.
- M3 git-backend decision (isomorphic-git perf on the 43 MB session repo vs
  micro-sidecar), terminal, CDP broker.
- M4 crypto + relay.
- M5 packaging/updater/E2E/merge.

## Notes for the next session
- Frontend shim surface is 5 call shapes only (invoke 25, listen 11,
  Channel 2, window 1, webview 1) — the shim stays small by construction.
- The 67 JS regression suites are framework-agnostic; they run in M0 gates.
- Rust parity source of truth: `src-tauri/src/**/tests` (1,050 tests on
  master at port start).
