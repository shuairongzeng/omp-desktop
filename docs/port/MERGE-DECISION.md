# Merge decision — feat/electron-port (2026-10-27)

State of the port after M0–M5, and what a merge to `master` would mean.

## What works (all measured on this machine, packaged .app)

| Subsystem | Evidence |
|---|---|
| Boot | real dist/ frontend, zero error boundaries, 13 startup commands answered (`docs/port/startup-contract.md`) |
| Sessions | real `open-tabs.json` restore → real omp spawn → message round trip persisted to the session jsonl (CDP-driven send, `ping from the electron port`) |
| Stores | 40 parity tests; real recents/history/approval-mode/open-tabs reads and writes |
| Saved sessions | 32 parity tests; 45 real sessions listed in the packaged app |
| Keybindings | 43 parity tests; overlay write path live |
| Terminal | 41 parity tests; packaged E2E: open → running, write → first frame seq 1 through webview events, /bin/zsh |
| Git browser | 52 parity tests; status 103 ms on the real repo, byte-equal to `git status --porcelain`; packaged E2E branch = master |
| Agent bridge | 125 parity tests; real-omp smoke 357 ms; group kill, journal, approvals, redaction |
| Browser | 45 + 69 parity tests; screencast frames reach the webview as ArrayBuffers (2099/11990/30505 B); navigate/tab/input/ack/annotate wired |
| Remote crypto | 30 checks incl. phone-JS cross-implementation interop and a live ws loopback |
| Remote files | 35 checks; 178 MB session window scan 0 diffs vs a JSON oracle |
| Remote connector | live relay: 129 ms connect over pinned-cert TLS, `hello` caps received, temp device revoked after |
| Packaging | manual .app assembly 327 MB, ad-hoc signed, launches, CDP-verifiable |
| Updater | minisign verification byte-exact vs minisign-verify's vectors; live feed check returns upstream 0.12.1 |

Gate: `npm test` in the worktree = 67 frontend suites + 11 port suites, exit 0
(79 pass-lines, 0 fail).

## Known gaps (documented in code, none blocking a macOS evaluation build)

1. **Windows browser**: `browser-process.launch` refuses win32 (no OS-handle
   pipe hand-over in Node). macOS/Linux only.
2. **macOS terminal tree-kill at natural exit**: a job that re-grouped itself
   survives the shell's natural exit (tty dropped); `closeTab`/`shutdownAll`
   still kill it. Documented in terminal.js header.
3. **Git semantics**: 10 listed deviations in git.js header (no rename
   similarity detection, no commit-graph early stop, no `core.excludesFile`,
   …). All read-only; none affects correctness of what it reports.
4. **Updater feed**: `check()`'s default feed is upstream's Tauri
   `latest.json`; an Electron release must publish its own feed or the
   packaged app offers a Tauri bundle it cannot install.
5. **No notarization**: ad-hoc signature only; another Mac's Gatekeeper
   blocks the .app until the user allows it.
6. **Not ported at all**: widgets scheduler (Rust thread model), summon
   hotkey/tray, conversation tree backend, workspace accept/reject (git
   binary), external-open argv ingest, phone UI relay static hosting
   (relay-side, unaffected).

## Recommendation

Do **not** merge to master yet. The port is a working macOS evaluation
build, not a replacement: gaps 1, 4 and 6 are user-visible on other
platforms/features. Suggested next round (in priority order): widgets +
conversation-tree ports (both are pure-ish logic with Rust tests to port),
then an Electron release feed, then Windows browser via a small native
addon or a documented refusal in the UI. Re-run this decision after those.
