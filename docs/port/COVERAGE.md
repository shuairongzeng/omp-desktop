# IPC coverage audit (2026-10-27)

Why this exists: the port's dispatcher had a `defaultReply` name-shape
fallback that answered every unimplemented frontend command with a
plausible-looking value — the silent-no-op class ("click open folder,
nothing happens"). This round eliminated it.

## Method (re-runnable)

```
grep -rhoE '(invoke|_invokeSafe|_invokeResult)\(\s*"[a-z_0-9]+"' src \
  --include='*.js' --include='*.jsx' | … | sort -u   # reference repo src/
node -e "Object.keys(require('./electron/stub-backend.js').EXPLICIT)"  # port
comm -23 frontend implemented                                        # the gap
```

Frontend call surface: 90 distinct names (3 grep artifacts from
`src/babel.min.js` excluded). Gap at round start: 28.

## Where each gap went

| Command(s) | Now |
|---|---|
| open_project, open_project_at, open_config_folder, reveal_project_path, open_url_external, copied_file_paths, read_file_bytes, pick_background_image | `backend/native-shell.js` (Electron dialog/shell/clipboard; plist parse for macOS file clipboard; 20 parity tests) |
| create_profile, rename_profile, delete_profile, set_startup_profile, clear_profile_bootstrap | `backend/profiles-mutate.js` (json_store lock + snapshot ring ported; 32 tests) |
| delete_saved_session, rename_saved_session | `backend/saved-sessions-mutate.js` (.trash move, byte-pinned title line; 21 tests) |
| model_usage_list, usage_stats, goal_continuation_get/set, prompt_history_record/list | `backend/agent-stats.js` (node:sqlite read-only per query; omp stats subprocess; 30 tests) |
| list_project_files, project_file_read | `backend/project-files.js` (fuzzy search, symlink-escape refusal, caps; 26 tests) |
| conversation_tree | `backend/conversation-tree.js` (family walk + parse; 25 tests; fork is an omp RPC verb, already allowed) |
| workspace_accept, workspace_reject, stop_git_watch | `backend/workspace.js` (git binary by absolute path, exact argv/errors; 22 tests) |
| approval_rules_list, approval_rules_revoke | agent.js `listRules`/`revokeRule` wired |
| app_update_install | packaging/updater.js `install` on the last `app_update_check` result |
| widgets_approve/refresh/set_view/state | explicit empty-but-valid state + in-memory approvals (scheduler not ported, MERGE-DECISION gap 6) |

## Silent-no-op elimination

- `defaultReply` now **throws** `port: command not implemented: <name>`.
- The shim turns the dispatcher's `{error}` envelope into a rejection, so
  `_invokeSafe` falls back and `_invokeResult` surfaces the message — same
  observable behaviour as a Rust `Err`.
- Residual gap after wiring: **0** (audit re-run above).

## Surface sweep

`tools/sweep.mjs <cdp-port> <out-dir>` walks 12 surfaces on a running
instance (boot, tab restore, recents, open_project_at, history modal,
composer round trip with the marker proven on the session jsonl, native
open-folder dialog, terminal, git browser, browser panel canvas pixels,
settings sections, tab menu) with DOM assertions + a screenshot each.
Latest run: **12/12 pass**; baseline screenshots + sweep.json in
`docs/port/sweep/`.

Known sweep limits: `Page.captureScreenshot` cannot see OS-level dialogs
(the open-folder check proves the dialog by screenshot taken with
`screencapture`, and the check runs last because a modal dialog blocks
later DOM checks); conditional UI (git/browser buttons render only for
a git-repo project) means the fixture tab must be a repo.

## Operation-level matrix (2026-10-27, supersedes the render-level sweep)

`tools/deep-e2e.mjs <cdp-port> [shot-dir]` runs four group modules
(`tools/deep/{tabs-sidebar,composer,panels,browser-settings-keys}.mjs`,
shared harness `tools/deep/ctx.mjs`) SEQUENTIALLY against one instance.
Every check proves its feature by an external consequence — open-tabs.json
/ recent-projects.json / session jsonl on disk, scoped `pgrep` of omp and
pty children, `pbpaste`, Finder's front-window target — or a DOM change a
no-op could not produce. Latest run: **43/43 pass, 0 skipped, 0 failed** — the widgets
rail and the summon hotkey/tray were ported in full (bb735d3);
results + screenshots in `docs/port/sweep/deep-e2e.json` and
`/tmp/deep-shots-final2/`.

The matrix is the port's release gate: it found six real backend bugs the
render-level sweep could not see — `recent_projects_remove` missing (dead
sidebar click), the frontend InputEvent→CDP mapping unported (no click or
key ever reached the page), annotate picks never forwarded to the panel,
`View.close()` closing the manager's shared CDP pipe (reopen dead for the
run), headless screencast metadata alternating device/window px (clicks
mapped outside the page), and `Page.enable` missing on shown pages (strip
showed URLs, never titles).

## Shell comfort (2026-10-28, measured)

- `clipboard-chords`: the application menu's Edit role carries Cmd+C/V/X/A
  (macOS accelerators live in the menu; without one every chord is dead).
  Evidence: pbcopy seed + a real Cmd+V keystroke lands in the composer.
- `navigation-guard`: `will-navigate` refuses every non-app URL and hands it
  to `shell.openExternal` (Tauri's navigation_guard.rs parity);
  `setWindowOpenHandler` denies new windows the same way.
- `drop-pipeline`: the preload's capture-phase DOM listeners reproduce
  Tauri's `onDragDropEvent` payload (`{type, paths, position}` in physical
  pixels, paths via `webUtils.getPathForFile`) and preventDefault keeps a
  drop from navigating the app. MANUAL ROW: an OS file drop (webUtils
  resolving a real File) is not synthesizable — Chromium's CDP drags carry
  no Files type and an empty FileList; drag an image into the composer by
  hand to verify the attach chip.
- `window-bounds`: `window-bounds.json` in the config dir persists
  geometry + maximized across launches (cross-display validated on read).

## Remote (2026-10-28, measured against the production relay)

`remote_get_state` returns Rust's RemoteStateView field for field
(`enabled, server, device_id, status, pinned_cert, device_name`); the
Settings row's `device_id.slice(0, 12)` crashed on the old renamed shape.
The relay's cert is a self-signed LEAF (Basic Constraints CA:FALSE): rustls
accepts it as its own anchor, OpenSSL rejects it as `ca`
(UNABLE_TO_VERIFY_LEAF_SIGNATURE), so tlsOptions pins such a leaf by DER
equality in checkServerIdentity (regression test with a real openssl
CA:FALSE leaf). `tools/deep/remote-relay.mjs` walks enable → device-id row
→ TOFU trust prompt → trust → online → disable against the live relay with
a temporary registered device (revoked afterwards).

## Phone chain against the port desktop (2026-10-28)

`tools/deep/phone-port-e2e.mjs` walks the whole handset path against the
production relay: Settings → Remote pair code → phone overlay submits it →
the port desktop's pair_request dialog approves → the phone enters the port
desktop's session view → a marker message round-trips through the port's
omp (session jsonl on disk) and the reply streams back. 5/5 measured.
Two parity gaps this round closed: the connector's boot-time start (Rust
starts at setup) and the v2 pairing state machine (pair_request pk →
grant pk → pair_done MS persistence; plus the ms-refresh + pending-hs
retry for a hs that beats pair_done).
