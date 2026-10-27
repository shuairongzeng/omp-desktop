# Startup IPC contract — OMP Desktop frontend (Electron M1 stub target)

Extracted read-only from `/Users/jackey/GitHub/omp-desktop` (branch `feat/electron-port`, source of the dist the Electron shell loads). Everything below is what the *real* frontend needs from the backend between `live.js` evaluation and the first painted frame, plus the restored-tab path that only runs when `open-tabs.json` contains tabs.

Two facts decide the contract:

1. `live.js` only talks IPC when `window.__TAURI__` exists (`src/live.js:5464`). Without it the app runs in demo mode and issues **no** IPC — so the Electron stub must define `window.__TAURI__` before `index.html` loads `live.js` (script order: `src/index.html:587`).
2. With an **empty** open-tabs layout nothing per-session happens: no `start_session`, no `agent://line/{id}` listener, no `replay_events`, no `session_status`, no `send_command`, no `get_state` / `get_messages`. The UI renders the empty workspace and the boot ends after the rows in §1. (Tabs are spawned only from `open_tabs_load`'s reply, `_restoreOpenTabs` at `src/live.js:2267`.)

All command names below are the exact strings passed to `core.invoke(name, args)`. `_invokeSafe` returns its `fallback` on a thrown invoke, `_invokeResult` turns a throw into `{ok:false,error}` (`src/live.js:494`, `src/live.js:507`).

---

## 1. Startup IPC calls — desktop boot, empty layout

Order is **invoke issue order**. Rows 5–8 are issued only after `list_profiles` resolves; the synchronous startup block (`src/live.js:5464-5515`) issues row 4 while 3 is still in flight.

| # | command | args | stub reply | consumer fallback if absent | source line ref |
|---|---|---|---|---|---|
| 1 | `approval_mode_get` | `{}` | `{"default":"write","projects":{}}` | `null` → `approvalModes` stays null; `AMODE.effectiveFor` falls back to `"write"` and `restartPlan` no-ops, so the status-bar cell and restarts still work | `src/live.js:1879`, fired at `src/live.js:5481` |
| 2 | `prompt_history_list` | `{}` | `[]` | non-array → ignored (`Array.isArray` gate); the history modal's "all sessions" section just stays empty | `src/live.js:5484-5485` |
| 3 | `list_profiles` | `{}` | `{"profiles":[{"id":"default","name":"default"}],"startupId":"default","degraded":null}` | `null` / missing `profiles` → keeps the in-code `[{id:"default",name:"default"}]`, no `notify()`; the restore chain still continues (the promise resolved) | `src/live.js:3640`, fired at `src/live.js:5486` |
| 4 | `set_close_guard` | `{"armed":false}` | `null` | throw swallowed (`_invokeSafe`), value unused | `src/live.js:3770`, fired at `src/live.js:5502` (and from every `notify()` at `src/live.js:874`) |
| 5 | `recent_projects_list` | `{"profile":"default"}` | `[]` | fallback `null`; `_applyRecents` ignores anything that is not an array | `src/live.js:3688`, fired from `_syncRecentsProfile` at `src/live.js:3694` |
| 6 | `close_all_tabs` | `{}` | `null` | throw swallowed; return value unused | `src/live.js:5492` |
| 7 | `open_tabs_load` | `undefined` (no args object) | `{"tabs":[],"active":null,"skipped":[]}` | `null` → `_restoreOpenTabs` returns early (legal, nothing to restore); a non-null reply **without** `tabs`/`skipped` throws `TypeError`, aborting the restore into the chain's `.catch` | `src/live.js:2278-2281` |
| 8 | `take_pending_open_projects` | `undefined` (no args object) | `[]` | `null`/`undefined` → drain returns; any other non-array truthy (e.g. `{}`) throws in `for (const path of paths)` inside a detached async (`void _drainExternalOpens()`), i.e. an unhandled rejection | `src/live.js:2124`, fired at `src/live.js:2156` via `_setupExternalOpens` (`src/live.js:2148-2157`) |
| 9 | `plugin:app|version` | `undefined` | `"0.11.0"` (any string) | `null` → `version` stays null; the tab bar simply omits the version label | `src/live.js:5392`; mount effect `src/app/use-updater.jsx:26-27` |
| 10 | `keybindings_list` | `{"profile":"default"}` | `{"omp":{},"overlay":{},"overlayError":null,"ompPath":null,"inheritedPath":null,"overlayPath":null}` | `null` → `applyPayload(null)` seeds registry defaults and sets the "configuration could not be loaded" banner; render continues | `src/live.js:5048`; mount effect `src/app/use-keymap.jsx:70-72` |
| 11 | `widgets_state` | `{}` | `{"configPath":null,"fatal":null,"errors":[],"plugins":[],"active":{"sessionId":null,"applicable":[]},"runs":[]}` | throw → `{fatal}` snapshot; `null` → `applySnapshot` returns immediately; rail renders empty | `src/live.js:4579` (`_widgetsSnapshot`, `src/live.js:527`); mount effect `src/app/use-widgets.jsx:80` |
| 12 | `widgets_set_view` | `{"view":{"sessionId":null,"railVisible":true,"windowVisible":true,"hidden":[]}}` | `null` | throw swallowed; reply unused (fire-and-forget) | `src/live.js:4594`; mount effect `src/app/use-widgets.jsx:136-139` |
| 13 | `list_saved_sessions` | `{"cwd":null,"profile":"default"}` | `[]` | fallback `[]` (third arg of `_invokeSafe`); sidebar history rows stay empty | `src/live.js:4891`; mount effect `src/app-live.jsx:938-945` |
| 14 | `app_update_check` | `undefined` | `null` (up to date) | `_invokeResult` → `{ok:false,error}`; only a console warning from the background check | `src/live.js:5398`; timer `src/app/use-updater.jsx:48-53`, delay `STARTUP_DELAY_MS = 15_000` (`src/app/updater.js:24`) |

Notes:

- Row 14 fires 15 s after mount, i.e. after the first render. It is listed because it is the first post-boot command and a stub that rejects it is harmless but noisy.
- `open_tabs_save` is **not** called at boot: `_restoreOpenTabs` adopts the current layout as already written (`_layoutKey = untouched ? JSON.stringify(_layoutNow()) : null`, `src/live.js:2342`), and `_persistLayout` skips an unchanged key (`src/live.js:964-971`). It starts firing on the first real tab change (`src/live.js:984`, args `{"layout":{"tabs":[…],"active":<index|null>}}`).
- `read_file_bytes` (`{"path":<bgImage>}` → `{"data":"<base64>","name":…,"mime":…}`) is issued at mount only when the `bgImage` tweak is non-null; the default is `null` (`src/app/constants.js:52`), so it is **not** on the empty-startup path. Source: `src/app/use-bridge-snapshot.jsx:156`.
- Teardown commands (`close_tab` `src/live.js:1580`, `stop_session`/`stop_git_watch` `src/live.js:1567-1568`) are never issued during startup.

---

## 2. Restored-tab path — only when `open_tabs_load` returns a non-empty `tabs`

With `{"tabs":[]}` none of this runs. With tabs, per saved tab (`_restoreOpenTabs` → `_startProjectSession` → `_spawnSession` → `activateSession` → `_switchToSession`):

| # | command | args | stub reply | consumer fallback if absent | source line ref |
|---|---|---|---|---|---|
| R1 | `start_session` | `{"args":{"sessionId":"session-<ms>","cwd":"/abs/path","resume":null,"profile":"default"}}` (note the double nesting: the Rust command takes one `args` struct) | `"write"` (the resolved approval mode; `"always-ask"`/`"write"`/`"yolo"`) | rejection → that tab is reported failed and skipped, the other tabs still restore (`src/live.js:2293-2299`); `undefined` mode → `approvalMode: null` | `src/live.js:1500-1502` |
| R2 | `start_git_watch` | `{"sessionId":"…","path":"/abs/path"}` | `null` (or a branch name string) | `.catch(() => null)` → branch chip empty | `src/live.js:1526` |
| R3 | `replay_events` | `{"sessionId":"…","afterSeq":0}` | `{"events":[],"headSeq":0,"dropped":false}` | rejection → warn and continue (only `/not found/` marks the process dead); a reply missing `events` throws inside the `try`, also just warns | `src/live.js:1323`, `src/live.js:1325-1350` |
| R4 | `session_status` | `{"sessionId":"…"}` | `null` (no cached startup error) | rejection → warn only; a non-null value is rendered as a "process died" note | `src/live.js:1378-1399` |
| R5 | `send_command` — `negotiate_protocol` | `{"sessionId":"…","json":"{\"type\":\"negotiate_protocol\",\"protocolVersion\":2,\"id\":\"d1\"}"}` | invoke reply `null`; the *RPC* answer must arrive as an `agent://line/{id}` event (see wire contract below) | no response → the 2000 ms race in `_initFetch` fires and the batch continues | `src/live.js:3501`, wrapper `src/live.js:291-330` |
| R6 | `send_command` — `set_ask_dialog` | `json` with `{"type":"set_ask_dialog","enabled":true,"id":"d2"}` | invoke reply `null` + RPC response event | rejection → `console.warn`, no block | `src/live.js:3507-3508` |
| R7 | `send_command` — `get_state` | `json` `{"type":"get_state"}` (no id) | invoke reply `null`; RPC answer `data: {}` | `data:null` is tolerated (`_applyRpcState` starts with `if (!rpcState) return`, `src/live.js:3347`); the sender ignores the RPC reply | `src/live.js:3516`; consumer `src/live.js:2487-2488` |
| R8 | `send_command` — `get_messages` | `json` `{"type":"get_messages"}` | invoke reply `null`; RPC answer `data: {"messages":[]}` | **`data:null` throws** (`data.nextBefore`); the merge expects an object every time | `src/live.js:3517`; consumer `src/live.js:2497-2590` |
| R9 | `send_command` — `get_available_commands` | `json` `{"type":"get_available_commands"}` | invoke reply `null`; RPC answer `data: {"commands":[]}` | **`data:null` throws** (`data.commands`); `commands:undefined` is tolerated | `src/live.js:3518`; consumer `src/live.js:2587` |
| R10 | `send_command` — `set_subagent_subscription` | `json` `{"type":"set_subagent_subscription","level":"off"}` | invoke reply `null` | fire-and-forget | `src/live.js:3521` |
| R11 | `send_command` — `get_subagents` | `json` `{"type":"get_subagents"}` | invoke reply `null`; RPC answer with an empty agent list, or none | fire-and-forget; rail shows no subagents | `src/live.js:3522` |
| R12 | `extension_ui_state` | `{"sessionId":"…"}` | `{"statuses":[],"widgets":[],"seq":0}` | only called when `replay.dropped === true`; `null` → keeps local ext state | `src/live.js:1336` |

All `send_command` payloads go through `_invokeSend` (`src/live.js:3566-3568`): `invoke("send_command", { sessionId, json: JSON.stringify(cmd) })`. The inner `type` is validated by `ALLOWED_COMMAND_TYPES` before it reaches omp (`src-tauri/src/agent/mod.rs:61-119`) — every type used above is on that list.

RPC wire contract for the stub: emit `agent://line/{sessionId}` with payload `{seq:<number>, text:"<json>"}`; `text` is either an omp event (`{"type":"ready"}` triggers `_initFetch`, `src/live.js:2401-2404`) or a response `{"type":"response","id":<echoed id|null>,"command":"negotiate_protocol","success":true,"data":{…}}`. `_handleResponse` resolves the pending `_sendWithResponse` by `id` (`src/live.js:2425-2434`) and dispatches id-less responses by `command` (`src/live.js:2487`+).

---

## 3. Event subscriptions at init

`window.__TAURI__.event.listen(name, handler)` must return a **Promise of an unlisten function** — the startup block calls `.catch()` on the result directly (`src/live.js:5500`, `src/live.js:5511`), so a non-Promise return throws out of the boot IIFE and skips window-chrome setup.

| event | registered at | when |
|---|---|---|
| `window://close-requested` | `src/live.js:5500` | always, synchronously at boot |
| `app://summon` | `src/live.js:5511` | always, synchronously at boot |
| `open://project` | `src/live.js:2150` | in `_setupExternalOpens`, after the profile→restore chain settles |
| `widgets://config`, `widgets://run`, `widgets://removed`, `widgets://active` | `src/live.js:4607-4608` | always at mount (`use-widgets.jsx:77`) |
| `tauri://resize` via `getCurrentWindow().listen` | `src/design/chrome.jsx:62` | always at mount (WindowChrome renders even with no tabs) |
| `agent://line/{sessionId}` | `src/live.js:1259` | per restored/activated tab only |
| `agent://exit/{sessionId}` | `src/live.js:1269` | per restored/activated tab only |
| `git://branch/{sessionId}` | `src/live.js:1532` | per spawned tab with a non-empty `cwd` only |
| `browser://agent-use` | `src/app/use-browser.jsx:203` | only while the browser panel has a session |
| `update://progress` | `src/live.js:5409` | only during an update install |
| `ask-settled`, `omp://tabs-changed` | `src/live.js:2218`, `src/live.js:2226` | phone client only (`__OMP_REMOTE__`) |

The four widget listens must not reject: `onWidgetsEvent` uses `Promise.all` over `.catch(err => null)` per listener (`src/live.js:4607-4609`), so failures degrade quietly.

---

## 4. Window / webview API touched at init

The window object returned by `getCurrentWindow()` **must** provide these methods, and the ones marked Promise must return Promises — `chrome.jsx` calls `.then()` on them inside a mount effect with only a null-window guard, so a missing/mis-typed method throws into React and trips the app error boundary instead of rendering.

| API | call site | when | required return |
|---|---|---|---|
| `window.__TAURI__.window.getCurrentWindow()` | `src/live.js:3722`, `src/app-live.jsx:174`, `src/design/chrome.jsx:56`, `src/live.js:3801` | boot (chrome setup + mount effect) | window object (non-null) |
| `.show()` | `src/app-live.jsx:174` (optional-chained) | mount | Promise (window is created hidden in Tauri) |
| `.isMaximized()` | `src/design/chrome.jsx:59` | mount, and after every `tauri://resize` | `Promise<boolean>` |
| `.listen("tauri://resize", cb)` | `src/design/chrome.jsx:62` | mount | `Promise<unlisten>` |
| `.startDragging()` | `src/live.js:3736` | first mousedown on `.chrome` | Promise (only after interaction) |
| `.minimize()`, `.maximize()`, `.unmaximize()` | `src/live.js:3741-3742`, `src/live.js:3750-3751` | traffic-light / win-control click | Promise |
| `.close()` | `src/live.js:3801` | quit | Promise |
| `window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(cb)` | `src/design/composer.jsx:832` | **only when the Composer mounts** (a tab is restored); payload `{type:"enter"\|"over"\|"drop"\|"leave", paths, position:{x,y}}` in physical px | `Promise<unlisten>` |

Not used anywhere: `setTheme`, `onDragDropEvent` on the window object, `getCurrentWebview()` at boot. `navigator.userAgent`/`platform` decide the traffic-light vs win-control branch (`src/live.js:3724`).

---

## 5. `core.Channel` construction sites

| site | startup? |
|---|---|
| `src/live.js:4737` — `browserOpenPanel` builds `new window.__TAURI__.core.Channel()` for screencast frames | **No.** Runs only when the browser panel opens (`use-browser.jsx:163`), which is user/agent triggered. |
| `src/app/remote-agent.js:328` — desktop-side re-emit channel for a phone-opened panel | No (phone RPC only). |
| `src/app/remote-transport.js:569` — phone stand-in class | No (phone shim). |

So M1 needs no working `Channel` implementation to boot; it must exist as a constructor only if the browser panel is exercised.

---

## 6. Cross-check against the Rust command surface

Checked against `ALLOWED_COMMAND_TYPES` (`src-tauri/src/agent/mod.rs:61-119`) and the `generate_handler!` list (`src-tauri/src/lib.rs:1701-1800`).

- Every command in §1 and §2 is in `generate_handler!` **except `plugin:app|version`**. `plugin:app|version` is Tauri's built-in app plugin command (same as `window.__TAURI__.app.getVersion()`, per `src/live.js:5389-5392`); it is not a custom command, so it never appears in `generate_handler!`. The Electron stub must answer it anyway (row 9).
- `event.listen` / `WebviewWindow.listen` are not commands in the handler list either: they are the Tauri JS event plugin's own IPC (`plugin:event|listen` / `plugin:event|unlisten`, with `{event, target, handler}`). The stub should implement the public JS API directly rather than routing through a command-name table. [INFERENCE from the Tauri 2 API surface; the `@tauri-apps/api` sources are not vendored in this repo — the app only ever calls the public `event.listen`/`window.listen` methods.]
- `send_command`-carried types used at startup — `negotiate_protocol`, `set_ask_dialog`, `get_state`, `get_messages`, `get_available_commands`, `set_subagent_subscription`, `get_subagents` (plus `set_auto_compaction` / `set_auto_retry` only when the user turned those prefs off) — are all in `ALLOWED_COMMAND_TYPES`.
- Names the frontend sends that are **not** Rust commands and must never be expected in `generate_handler!` (all `js:`-prefixed, executed by the desktop webview's `remote-agent.js` for a paired phone, guarded by `window.__OMP_REMOTE__`):
  - `js:list_tabs` (`src/live.js:2183`, `src/live.js:2227`)
  - `js:get_messages_window` (`src/live.js:3542`)
  - `js:get_pending_asks` (`src/live.js:2167`)
  - `js:settle_ask` (`src/live.js:682`)

  None of them is issued during a desktop boot; they are listed so a stub-side "unknown command" log isn't mistaken for a missing handler.
- Phone-only Rust commands also reachable from the same code but not at desktop boot: `remote_replay_events` (`src/live.js:1322`, in the handler list), `open_project` (phone path), `remote_list_dirs` (`src/live.js:5372`).

---

## 7. Minimal stub checklist (what "boots clean" means)

1. `window.__TAURI__` with `core.invoke(name, args)`, `core.Channel` (constructor), `event.listen(name, cb) → Promise<unlisten>`, `window.getCurrentWindow()`, `webview.getCurrentWebview()` — defined before `live.js` runs.
2. Answer rows 1–13 with the shapes above; row 14 after 15 s or not at all.
3. Return an empty `tabs` array from `open_tabs_load` (row 7) — that is the whole "empty layout" contract.
4. Emit no `agent://*` events; nothing is listening with no tabs.
5. Never reject `event.listen`; always return a Promise (even a resolved no-op unlisten).

### Three riskiest stubs (wrong shape breaks boot, not just a feature)

1. **`open_tabs_load`** — a non-null reply must contain both `tabs` (array) and `skipped` (array). `saved.skipped.length` runs before anything else (`src/live.js:2280`), so a reply like `{"tabs":[]}` throws and aborts the whole restore (and, on a populated layout, every tab).
2. **`take_pending_open_projects`** — must be an array (or `null`). Any other truthy value throws in the `for…of` inside `void _drainExternalOpens()` (`src/live.js:2124-2126`), which surfaces as an unhandled rejection and kills OS folder-open handling.
3. **`send_command` + the RPC response line** — the invoke itself may return `null`, but `negotiate_protocol` and `set_ask_dialog` are awaited via `_sendWithResponse`; without a `{"type":"response","id":…}` line on `agent://line/{id}`, every tab activation eats the full 2 s negotiate cap before `get_state`/`get_messages`/`get_available_commands` go out (`src/live.js:3500-3523`), and `set_ask_dialog`'s pending entry lingers for its 120 s timeout.

Runner-up, outside the command table: the window object's `isMaximized()` and `listen()` must return Promises — `src/design/chrome.jsx:59-62` calls `.then()` on them in a mount effect.