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
no-op could not produce. Latest run: **39/39 pass, 0 skipped, 0 failed** — the widgets
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
