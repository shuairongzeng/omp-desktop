# Merge decision — feat/electron-port (2026-10-28, refreshed)

State of the port after the gap-closure round, and what a merge to `master`
would mean. Every row carries the command that re-verifies it.

## What works (all measured on this machine, packaged .app)

| Subsystem | Evidence | Re-verify |
|---|---|---|
| Boot | real dist/ frontend, zero error boundaries, 13 startup commands answered | `docs/port/startup-contract.md`; `node tools/deep-e2e.mjs <port>` boot row |
| Sessions | real `open-tabs.json` restore → real omp spawn → message round trip persisted to the session jsonl | deep matrix `send-roundtrip` |
| Stores / saved sessions / keybindings | 50 + 32 + 43 parity tests | `node tests/port-{stores,saved-sessions,keybindings}.mjs` |
| Terminal | 42 parity tests incl. natural-exit tree kill; packaged E2E write → first frame seq 1 | `node tests/port-terminal.mjs`; deep `terminal-write-kill` |
| Git browser | 56 parity tests (excludesFile, filemode, racy re-hash added); status byte-equal to `git status --porcelain` | `node tests/port-git.mjs`; deep `git-file-diff` |
| Agent bridge | 126 parity tests; real-omp smoke; group kill, journal, approvals, redaction | `node tests/port-agent.mjs` |
| Browser | 45 + 69 parity tests; screencast frames reach the webview as ArrayBuffers; annotate pick → marker; close→reopen | deep `browser-*` rows |
| Widgets | config/trust/snapshot/redact 75 + run/context 20 + schedule 58 tests; fingerprint gate + verified copies; rail card from real plugin stdout | deep `widgets-rail` |
| Summon hotkey + tray | 143 checks; OS-registered chord; tray "show omp" un-hides via its AX surface | deep `summon-hotkey-tray` |
| External open | launch argv + second-instance + macOS open-file → queued → drained into a tab | deep `external-open-argv` |
| Remote crypto/files/connector | 30 + 35 checks incl. phone-JS interop; live relay 129 ms | `node tests/port-remote-*.mjs` |
| Packaging | manual .app 327 MB ad-hoc signed + **dmg** (hdiutil UDZO, /Applications symlink) | `npm run port:dmg`; `node tests/port-pack-mac.mjs` |
| Updater | minisign verify byte-exact vs minisign-verify vectors; **sign half + fork feed** with generated-key identity | `node tests/port-pack-mac.mjs` |

Gate: `npm test` in the worktree = 67 frontend suites + 24 port suites,
exit 0. Deep matrix: `node tools/deep-e2e.mjs <port>` = **34/34 pass, 0
skipped, 0 failed** (the external-open row joined the 33).

## Known gaps (each a tested boundary or an external dependency)

1. **Windows browser**: `launch()` refuses win32 with a fatal, documented
   error (no OS-handle pipe hand-over, no Job Object in Node). Tested via
   platform injection: `node tests/port-browser-platform.mjs` (5 checks).
   Windows support itself is deferred to a Windows-side round (user
   decision 2026-10-28).
2. **macOS terminal tree kill**: closed by the anchor-shell sweep
   (SliceTermKill); the residual boundaries are a `setsid`-detached child
   and pid reuse, both documented in terminal.js's header and pinned by
   the 42-test suite.
3. **Git semantics**: rename similarity and commit-graph early stop remain
   unimplemented by decision; their user-visible impact is stated in
   git.js's header and pinned by tests. excludesFile/filemode/racy are now
   implemented (56 tests).
4. **Updater feed**: a packaged release build bakes the fork identity
   (`PORT_UPDATER_PUBKEY` at build time → fork feed); dev builds keep
   upstream. Publishing the feed needs a GitHub release (user deferred).
5. **No notarization**: ad-hoc signature only; another Mac's Gatekeeper
   blocks once. Needs an Apple Developer account — documented boundary,
   user decision 2026-10-28.
6. **Package formats**: macOS .app + dmg only; deb/msi deferred to their
   platforms.

## Recommendation

The port is a **macOS release candidate**: every macOS-facing feature is
implemented and operation-tested; every non-macOS gap is either a tested
refusal with a user-readable reason or an external dependency (Apple
account, GitHub release). Merge to master remains a product decision, not
a technical blocker: the port and the Tauri app would then both be live
fronts of the same frontend, and every frontend change must keep passing
both gates (`npm test` here plus the Tauri suite on master).
