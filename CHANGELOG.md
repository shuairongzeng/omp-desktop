# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Frequent slash commands as one-click pills in the composer's foot row** — the three commands you send most (count + recency, persisted in localStorage across restarts) sit beside the goal pill; a click prepends `/name ` to your draft (a draft already leading with a command is replaced, never double-prefixed) and focuses the input. A command omp no longer lists (deleted skill, renamed builtin) hides at once — its counts stay, so it returns when the command does

### Fixed

- **Phone drawer clicks that looked like no-ops now always end in rendered content** — resuming a saved conversation from a project's history rows opened the tab but left the phone on an empty chat (the transcript window raced omp's session file appearing, and nothing re-fetched once the file existed), and the drawer stayed open over it; opening a folder from recents left its group collapsed with no conversations listed. The desktop now announces the tab table when a session file lands (the phone re-pulls and refetches its window once), a resumed session closes the drawer, and a recent-folder click force-expands that project's group with its on-disk conversations listed (the drawer stays open for recents — the list is the point of the click)

- **A single-conversation project no longer renders two identical rows in the sidebar, and collapsing a project can no longer hide a live session** — the open panel showed the folder row plus a session row with the same text (an untitled conversation takes the folder's name), and the chevron collapse hid the session row while its tab kept running. Now the folder row shows the folder name only, the conversation gets its own row below it only when its title adds information (never the same text twice), and that row stays visible regardless of the chevron, which opens only the saved-history rows
- **The remote folder sheet rendered as an unreadable chip cloud on tablets and desktop browsers** — every content-row style (`cmp-sheet-*`, `mob-dir-*`, the typed-path row) was locked inside the ≤760px media tier. The base layout now lives under `.ms-root` (sheets mount only on touch devices and remote clients, so the desktop app is untouched), with compact density + hover/focus states for wide remote clients
- **"open folder…" and the tab-bar "+" did nothing on a phone in desktop-mode UA** (or any remote client reporting a fine pointer) — the folder sheet's opener routed by `isRemote()` but its render gate required `isTouch()`, and the sheet CSS was display:none above 760px. The gate now follows the opener, and on wide/fine-pointer remote clients the sheet presents as a centered card
- **Phones could stay on a stale page for a day after a same-version redeploy** — the relay served JS with `max-age=86400` and the `?v=` stamp only changes with the app version, so a fixed phone page never reached a cached handset (this is why a re-pair seemed to "do nothing" after the E2E upgrade). All static responses now revalidate (`no-cache`) with an etag → 304 when nothing changed

### Changed

- **New app icon: the pulse line** — a bold white throughput pulse (the live sparkline of an agent at work) running across the deep blue-black squircle and ending in the orange cursor dot, replacing the generic `>` chevron mark. Picked from a seven-direction exploration board (monospace π, block cursor, swarm cluster, `omp` lettermark, neon π, pixel π, pulse) on small-size legibility and silhouette; all shipped assets regenerated (`icon.ico` with real 16–256px frames, `icon.icns`, the PNG ladder, Windows Store tiles, Android/iOS icons), and the NSIS installer itself now carries the app icon instead of the toolkit default

### Added

- **Six alternate app-icon direction sets (`src-tauri/icons/alt/`)** — one full Tauri icon ladder per direction (PNG sizes, `icon.ico`/`icon.icns`, Windows Store tiles, Android/iOS mipmaps), each generated from a hand-authored 1024-grid `icon-source.svg` kept beside it: telemetry (avionics gauge), phosphor (CRT `❯ ▉` prompt), sigil (gold π seal — the exploration's pick), bauhaus (primary-colour π), biolume (bioluminescent colony), kamon (igeta crest). All six passed the 16 px pixel-grid, light-background and collision gates; see `src-tauri/icons/alt/README.md` for how to promote one to the live icon
- **Ctrl+Shift+T reopens the last closed tab** (Chrome/Firefox/VS Code's chord) — every close pushes the conversation onto a 20-deep stack, and the shortcut resumes it under its own profile; a stale entry whose conversation is open again focuses that tab instead of spawning a duplicate. Optimization rounds are now logged in `docs/optimization-log.md`
- **Right-click a sidebar project row for OS-level folder actions** — "Reveal in Finder" / "Reveal in File Explorer" / "Open in File Manager" (named per platform) opens the folder in the OS file manager, and "Copy project path" puts the absolute path on the clipboard with a "Copied" flash on the row. Both rows grey out for a project with no folder on disk; a denied clipboard or a vanished folder flashes "Copy failed" instead of closing silently
- **Working view in the project sidebar** — the "open" section is now a segmented tab (open | working). The working view lists every non-idle tab sorted by attention priority (waiting → failed → retrying → running → background), each row with a status dot + badge, clicking it activates the tab. The tab shows a count badge; the view choice persists across restarts. `Ctrl+Alt+J` / `Ctrl+Alt+K` cycle the working list globally
- **End-to-end encryption for phone remote control** (protocol v2) — pairing now exchanges ephemeral X25519 keys through the relay and every connection re-handshakes (fresh ephemeral keys, HMAC-authenticated under the pairing master secret, so sessions have forward secrecy). All business frames ride as AES-256-GCM `enc` envelopes with seq-counter nonces and replay refusal; the relay routes envelopes only and can no longer read message content. Documented residual: the pairing moment itself still trusts the relay (it mints the pair token). **Hard cutover, no plaintext fallback**: after upgrading, open the phone page once and re-pair each desktop when it shows "需重新配对" — old pairings carry no key material. Phone-side crypto is the vendored pure-JS `@noble` bundle (works under the self-signed cert where `crypto.subtle` is unavailable)
- **relay is now covered by CI** — the shared test workflow runs the relay crate's test suite on every PR and master push

- **Summon the app from anywhere** — a global hotkey (Ctrl+Alt+Space by default; override in `<app config>/global-hotkey.json`, e.g. `{ "chord": "ctrl+shift+o" }`) shows and focuses the window and drops the cursor into the composer, switching back from the Settings tab if it was covering your project. A new system tray icon toggles the window with a left click, and its menu can show or quit the app (quit goes through the full child-process cleanup)

- **Ctrl+1…9 jumps straight to a tab** (project tabs only; rebindable in Settings → Shortcuts), and **composer drafts now survive a restart** — unsent text is kept per conversation (`omp-desktop:drafts`, 50-entry cap) and restored into the right box when you reopen the tab; sending clears it

- **Reading comfort settings** (Settings → Appearance → Text): UI font family (five stacks, all with CJK fallbacks), UI font size (12–18, proportionally scaled), and density (comfortable/compact). The defaults are pixel-identical to the old look, and terminals, code blocks and diffs keep their monospace stacks

- **Startup timing is now a tested budget** — the smoke suite measures spawn → root rendered / composer ready / bridge connected on the real release build and fails if composer-ready regresses past 8 s (measured baseline ≈ 1.6–1.8 s warm); see `tests/smoke/SMOKE.md`

- **A render crash no longer blacks out the window** — every panel (chat, composer, sidebar, rail, settings, status bar, each modal) is wrapped in an error boundary: a throw in one shows that panel's crash card with a retry button while the rest of the app keeps working, and a top-level failure shows a full-window recovery card (reload restores the tabs from the tab store) instead of an empty black window. All crashes are recorded in a bounded in-memory ring (`app/error-watch.js`, also capturing window errors and unhandled rejections) so the next smoke run or devtools session can see what broke

- **`npm run smoke` — an automated CDP smoke test against the real release build** (`tests/smoke/`): launches the packaged app with WebView2 remote debugging, asserts zero console errors, walks the main surfaces (settings, command bridge, git browser), fault-injects both boundary layers and proves the window survives, and measures a heap delta across modal churn; see `tests/smoke/SMOKE.md`

- **The browser panel opens by itself when the tab's agent starts browsing** — Rust emits one `browser://agent-use` event per episode (a report after ≥30 s of silence, and only while the panel is closed), the desktop switches the active tab's side column to the panel and a paired phone opens its panel on the same report over the room, so the agent's browsing is visible wherever you are; Settings → Browser → "Show the panel when the agent browses" turns it off

- **Notifications when a tab needs you** (Settings → Session): a turn finishing or a tool approval arriving fires an OS notification while the window is hidden or the tab is in the background (tauri-plugin-notification, `app/notify.js` — `notifyDone`/`notifyAsk` toggles, both on by default), and the window title now carries a "(N 待审批)" count across all tabs, not just the active one

- **Cross-session prompt history**: prompts are now archived to `prompt-history.json` (newest first, deduplicated, 200 cap) — the prompt history modal (Ctrl+↑) gains a "this tab / all sessions" toggle, so a prompt polished in one project is recallable in any other, across restarts

- **History modal: delete, rename, and search the content** — saved conversations can be deleted (moved to a `.trash` folder next to the session file, recoverable), renamed inline (click the title), and the search box now matches the conversation *text*, not just the title, with the matching snippet shown

- **Failed turns can be resent**: a failed reply card has a "resend" button that replays that turn's prompt

- **Terminal touch keypad** (phone): Esc / sticky-Ctrl (so Ctrl+C works — interrupt a runaway command) / arrows / Tab / paste, plus the panel no longer auto-focuses on touch (the keyboard covered the output you opened it for), touch-sized drag handle and close button, and a double-tap toggles half-screen height

- **Image lightbox pinch zoom** on touchscreens, with double-tap toggling fit ↔ 2.5×

- **Ctrl+L focuses the composer** from anywhere (the main interaction had no keyboard path back)

- **Settings search actually finds things**: section titles, group names, `src` file names, option labels and theme names are indexed (searching "midnight", "ctrl+enter", "terminal.json" works now), twelve high-frequency Chinese keywords are mapped (字体/通知/终端/手机/快捷键/审批/历史…), and the Shortcuts row no longer false-matches generic words like "port"

- **Settings → footer: "open settings folder"** opens the app's config directory (where terminal.json, approval-mode.json etc. live)

- **qrcode.js loads lazily** — 57 KB off every startup; it is injected the first time the pairing QR opens

- **Pair by link, not just by scan** — the pairing modal's QR code, the
  pairing URL line under it and the pairing code are all click-to-copy:
  send the link (`https://<relay>/p#<token>`) to the phone, it pairs on
  open, no camera or code typing. Copied feedback in the modal title,
  plus a note that WeChat's in-app browser should hand the link to a real
  browser.

- **Remote control from your phone** (Settings → Remote, `docs/remote.md`): the app connects outbound-only to a small self-hosted relay (`relay/`, a single Rust binary that also serves the phone UI); pair by scanning a QR code and approving on the desktop. The phone runs the same UI — tabs, streaming chat, tool approvals, terminal, git browser — through a WebSocket shim that stands in for `__TAURI__`, with the desktop's own webview as the executor (`docs/architecture/remote-control.md`). `start_session` is now idempotent on a live session so a remote client attaching to the desktop's tabs can never restart its agents; narrow screens get an overlay-drawer sidebar and full-width panels (`mobile.css`). Self-signed relay certs are supported by TOFU pinning (Settings → Remote → 信任证书, with the SHA-256 fingerprint shown); the connector surfaces the real disconnect reason in its status instead of hanging silently, and pins the `ring` rustls provider explicitly (the process also compiles aws-lc-rs via reqwest, and rustls refuses to choose between two providers)

- **Chat width setting** (Settings → Appearance → Text): `standard` keeps the 80ch reading column, `wide` (new default) raises it to 120ch and lets user bubbles grow to 1200px, `full` removes the caps so messages follow a stretched window (verified live at 1440px: 539px → 809px → 1185px)

- **Phone-first message flow (mobile v1)**: on a touchscreen the pending tool-approval prompt renders as a bottom sheet (`window.MobileSheet`, `dismissOnScrim=false`, title "approval required") with vertical 48px buttons — solid-accent Approve, rose-outline Deny, remember-rules as text links; copy buttons are always visible with 40px hit areas (the hover reveal is now `(hover: hover)`-scoped so iOS never sticky-hovers them); card bodies lose their nested scroll caps (the collapse system's 3-line preview owns density, the chat scroll is the only scroller); bash output wraps anywhere, code blocks read at 12px with a right-edge scroll mask; diffs shrink the line-number gutter to 36px and drop the mouse-only scrub rail; a pending ask turns the "Jump to latest" button into a solid-amber "⚠ approval needed" alert. Desktop sees only the amber-tinted jump-button state; every other rule is `@media (max-width: 760px)`/`(hover: …)`-gated (regression: `tests/test-mobile-chat.mjs`)

- **Phone: full conversation history and folder opening** (Settings → Remote handsets): the phone top bar gains the desktop's Ctrl+H clock — the searchable, all-projects history modal (92vh, 44px rows at phone width) — and "open folder…" opens a bottom sheet of the desktop's recent folders plus a typed path instead of dead-ending on the native dialog the handset cannot show; the pick travels as `open_project_at` and the desktop opens it exactly as its own picker would

- **Phone: the folder sheet browses the desktop's disk** (Settings → Remote handsets): "open folder…" now opens with a directory browser — the device's roots (drives on Windows), tap a folder to descend, back to the parent, and "open this folder" commits; the listing is one bounded read per step from the new read-only `remote_list_dirs` command (subdirectories only, hidden entries filtered, 500-row cap, cross-platform via pure std). The recent-folders rows and the typed path stay as escapes

- **Phone: the tab list follows the desktop live** (Settings → Remote handsets): a folder opened from the phone now appears and becomes the active conversation at once — the sheet syncs the desktop's tab table and activates the returned tab id before it closes — and every later desktop-side open or close reaches the phone through a new `omp://tabs-changed` announcement (the phone's registry was a one-shot attach snapshot before, so a new project stayed invisible until a manual refresh). The merge is the new pure `OMP_REMOTE_TABS.mergeSnapshot` (`tests/test-remote-tabs.mjs`)

- **Windowed transcripts over narrow pipes** (phone remote control + desktop): a transcript fetch used to push the whole session file — hundreds of MB for long conversations — through omp and over the wire, stalling every operation behind it (the phone's symptom: seconds of dead air per tab switch over a 3 Mbit/s uplink). `get_messages` now reads ONE window straight from the tab's session file in Rust (`remote_transcript_window`: byte-offset scan with a parse-free row scanner, tail seek for the newest page, 4000-char block caps, 300 KB wire budget) and the chat view grows a "load older messages…" row that pages up with the reading position anchored; streaming output is untouched. The relay's nginx now gzips the phone UI's static assets (3.5 MB → ~700 KB). `tests/test-transcript-window.mjs` (cursor math), 7 Rust unit tests, one `test-remote-agent.mjs` routing check

- **Phone: projected replays and gzipped reply values** (Settings → Remote handsets): the journal replay of a busy tab (hundreds of KB of chunked stdout envelopes the handset never reassembles) and every large reply value now stay off the raw wire — `remote_replay_events` projects the ring (drops `rpc_chunk`, caps at the newest 400, marks `dropped` for the windowed refetch to recover) and reply values over 32 KB ride gzipped (`{gz}`, inflated in the phone shim). The window fetch also resolves the session file desktop-side (`js:get_messages_window`), so a handset whose registry copy lags its own attach still gets content, with one idempotent refetch as the attach's backstop. Wire per 178 MB-session switch: ~178 MB → ~0.3 MB; measured on a paired handset: attach ~1 s, tab switch 0.4 s

- **Phone: control several desktops from one handset** (Settings → Remote): the phone can pair with every desktop behind the same relay and a device picker lists them with live online status — each pairing is one entry in the new `omp-remote:devices` registry (the old single-pairing storage migrates in place), presence rides ordinary per-room phone auth through one socket per listed device while the picker is open (no new relay surface, no account concept; every desktop still approves its own pairings), and choosing a device performs a deliberate one-time reload because the whole app state belongs to the previous desktop. Switch from the topbar device chip or the offline overlay's new "切换设备" action. Desktops now announce a readable identity (`device_info` on connect and rename — Settings → Remote gains a device-name field, hostname fallback — persisted by the relay and forwarded as `device` frames), and the relay greets a joining phone with its room's current desktop presence, which also fixes a phone attached to an already-online desktop seeing no `peer` frame until something changed

- A trash button floats at the prompt box's top right while the draft has text, clearing it in one click (attachments are untouched — they keep their own per-chip remove).

- Selecting text in the chat floats an "Add to prompt" pill beside the selection; clicking it appends the quoted text to the draft, sparing the copy-move-paste round trip. Selections in typing surfaces (the composer, an ask's answer box, an inline rename) never raise it, and it retracts on scroll, Escape, a collapsed selection or a click elsewhere.

- Four new themes — nordic, solarized, sakura (light) and midnight (OLED black) — join aurora, phosphor and daylight, each coming in with its own default accent. Settings → Appearance also gains a text-brightness slider (nudges the foreground ladder toward or away from the contrast pole), a background image picker (the chosen image is copied into the app's config folder, so moving the original never breaks the setting, with dim and blur sliders to keep text readable), and a frosted-glass switch with opacity and blur sliders for the floating surfaces — the project sidebar, bridge-style dialogs and the Settings page itself. Frosted glass stays off under the phosphor theme, where scanlines over blur would be visual mud. The picker and the drop handler both accept `jfif` and `svg` alongside the usual formats.

- Chat messages now carry a role glyph. The agent's replies keep their left rail, with the generic sparkle replaced by a purpose-drawn speech-bubble-and-spark mark (accent-coloured, rose when the request failed); your messages get a bust mark in a new right rail, drawn in the neutral text colour. Both are new `assistant`/`user` icons in the OMP Icon Pack, following the pack's single accent-dot convention.

- Files and folders can be dropped onto the prompt box, and files copied in the file manager paste into it with Ctrl+V: their paths are inserted as text, and the agent reads them with its own tools. Dropped images are still attached as images; pasting an image *file* inserts its path, while pasting a screenshot (no file behind it) still attaches the image.

- The project sidebar lists a project's saved conversations: expand a project (a single-conversation project with saved history has a chevron now too) to see up to three, newest first with each conversation's age. Clicking one resumes it in place, and an "all N conversations…" row opens the history panel already filtered to that project. Conversations already open in a tab are not listed again. The history panel itself now opens filtered to the active tab's project; the "All Projects" chip still shows everything.

### Fixed

- **The phone's browser panel now opens and navigates**: `browser_open_panel` carries a Tauri Channel for screencast frames that the phone's WebSocket shim could neither build nor receive — the open threw before a frame reached the wire, and every address submit answered "panel not open" behind an unchanged bar. The desktop's remote-agent now opens the panel with its own Channel and re-emits each frame as a `browser://frame/{session}` room event; the phone shim hands a stand-in Channel to the panel and feeds those events back into it, so the canvas paints and the address bar loads pages


- **Sending a message no longer blacks out the whole window**: the new OS-notification module exported itself as `window.OMP_NOTIFY`, a name `live.js` had owned since the notify-coalescing change — live.js's later assignment overwrote the notification pair at load, so the first run-state flip (a send) threw `shouldNotify is not a function` and, with no error boundary, unmounted the entire React tree. The notification module now exports `window.OMP_OSNOTIFY`, and a new `test-global-names.mjs` scans every script the document loads and fails the suite if any `window.*` global is assigned by two files, so this class of accident dies in CI instead of on a user's Enter key

- **Settings no longer blacks out the whole window when leaving the Remote section**: the pairing component's unmount cleanup referenced two state variables (`copied`, `copyTimer`) whose declarations were lost in a parallel-edit accident — leaving Remote threw a `ReferenceError`, and with no error boundary React unmounted the entire tree. Both declarations are restored; every section tab now switches cleanly (verified on desktop and phone by clicking through all 12 sections)

- **Two phones in one room no longer receive each other's command replies**: the relay stamped every phone frame with its connection id but broadcast every response, so colliding per-phone request ids resolved against the wrong phone's pending call — responses now carry the origin id and are unicast to it (broadcast only as the legacy fallback)

- **A desktop app restart no longer silently freezes a phone's stream**: the phone's event subscriptions lived in the desktop's webview and died with it; the phone reconnects its subscriptions on the desktop's return before re-syncing

- **Two desktops sharing one device id no longer fight over the room forever**: the replaced connector now stops with "another desktop is online with this device id" instead of reconnecting into an endless replace loop

- **The phone can steer a running agent again**: streaming hid the send path entirely (the stop button replaced it), so a mid-turn correction had to wait for the turn to end — the send button now stays (it routes to steer), with stop beside it

- **The git browser's phone layout no longer collapses the diff pane to zero width**: the three desktop columns (min 220/280px) left 0px for the diff on a 390px screen — the panes are now a tabbed single view with 40px touch targets and a two-tap confirm on discard

- **A prompt sent on a dead tab is no longer silently swallowed** (the bubble looked sent, the process was gone): the refusal becomes a visible note with the text and a copy button, the composer explains the agent exited, and a "restart agent" strip respawns the tab with --resume

- **Huge code blocks no longer freeze the UI**: syntax highlighting now caps at 64 KB / 2000 lines (32 KB for auto-detect) — a 50 KB unlabeled fence blocked the main thread for ~12 s at the moment the answer landed

- **Phone: a failed first connect retries** (capped backoff + a retry-now button) instead of parking on a dead "check the relay" overlay that only a page reload escaped

- **Phone streaming over narrow uplinks is coalesced**: message_update frames carry the full accumulated text, so the desktop now sends only the newest one per 100 ms per session — 10–30× less uplink traffic mid-turn, and the relay's bounded outbox no longer overflows and kills the connection

- **Inline plan cards survive tab switches and replace their stale selves**: the get_messages merge dropped the injected plan block, and a second todo_write left an outdated plan beside the new one

- **The remote protocol now has a version handshake**: relay and desktop exchange `hello` frames with capability lists, and a gzipped reply the phone cannot decode rejects loudly instead of rendering a blank transcript

- **bash tool cards keep the whole output** (they held only the last 20 lines — a test suite's first failure was unreachable); collapsed shows the tail with a "last 20 of N" note, expanded shows everything

- **Profile list degradation is visible**: when profiles.json is unreadable at startup, the profile menu says so (and that the file is still on disk) instead of showing a mysteriously empty list

- **Updater failures speak plainly** ("Couldn't reach the update server — check your network") with the raw error on hover, and a notify-only build's "open release page" failure surfaces in the modal instead of vanishing into the console

- **Markdown checklists render as checklists** (no more bullet + raw disabled checkbox), wide tables get the same right-edge scroll hint as code blocks, your own messages have a copy button, and a relay-dropped oversized reply rejects the call immediately instead of hanging it for 30 s

- Settings → Remote now names an untrusted relay certificate instead of looping silently: the connector classifies the rustls handshake failure (`certificate not trusted (self-signed?)` in the status line) and the trust prompt triggers off that reason — with wording that distinguishes a first trust from a re-trust after the server's cert changed. A self-signed relay with no pin stored used to sit in `reconnecting (error: …)` with no way in

- The startup tab restore filed one "Could not reopen undefined: undefined" note per restored tab: the outcome report iterated the array of spawn *Promises* instead of `Promise.all`'s resolved values, so every success read as a failure with no label, and the restored-id list stayed empty (which also defeated the #34 layout adoption on a clean restore). The report now walks the resolved results through `OMP_PROJECT_NAV.restoreReport`

- **Git browser no longer blacks out the whole window**: the accessibility pass dropped the `_GH_WORKTREE` constant in `git/history.jsx`, so `GitHistory` threw a `ReferenceError` on first render and — with no error boundary — React unmounted the entire tree (verified live: modal opens, history graph and inline diff render)

- **Streaming replies no longer flicker**: the streaming bubble's React key (`_id`) was re-stamped on every delta once `notify()` became rAF-coalesced — the stamp was deferred past the first `message_update`, whose spread-replacement dropped the unstamped id, so the row remounted every frame and its `fade-up` entrance animation never finished (the ghosted, flashing text). The bubble is now stamped at creation, and both replacement sites carry the replaced entry's id as a backstop (verified live: 0 remounts, single stable id, opacity trace flat at 1)

- The image lightbox's private `useModalLayer` copy clobbered the shared module and left the whole app inert from startup; the lightbox now uses the shared one (verified: root is interactive at boot, bridge open/close toggles inert correctly)

- Custom accent colors now derive a readable `--accent-fg` (near-black/near-white by luminance), so the primary button and HEAD chip stay legible with any swatch in any theme; midnight's primary button idle/hover pairing fixed

- `test-a11y` and `test-dead-process` are now actually in the `npm test` chain

- Phone remote control: a network blip no longer reloads the phone's whole page (the cause of the phone feeling laggy and never showing streaming replies) — the shim reconnects in place with capped backoff, replays event subscriptions, and resyncs the transcript via `get_messages`; waking the phone reconnects immediately instead of waiting out the backoff

- Phone remote control: a tool approval / ask dialog raised before the phone attached (or while it was disconnected) now shows up on the phone — the desktop serves its unanswered asks (`js:get_pending_asks`) and the phone merges them on attach and resync, so a blocked session is always unblockable from the phone

- Phone layout v1 (the `docs/design/mobile-draft.html` plan): two-row composer (full-width input, round send key, a ＋ bottom sheet for image/commands/thinking/plan/goal/terminal/usage/git), bare Enter inserts a newline on touchscreens instead of sending, no keyboard-popping autofocus after send, a 44px top bar and a session strip replace the desktop chrome and the horizontal tab bar, the status bar drops to connection/todo/approval-mode, the drawer gets 48px rows and a settings/profile foot, copy buttons are always visible on touch, approvals stack 48px buttons (and pending tool approvals pop as a bottom sheet), card inner scroll regions flatten so page momentum is never eaten, the jump-to-latest pill turns amber while an approval waits unseen, drag-reorder no longer fights touch scrolling, and the thinking menu no longer opens off-screen

- Settings on a phone: a back button now closes the page (there was no way out without a keyboard — the footer's "Ctrl+W close tab" was a hint, not a button), the section strip scrolls with every section's full label instead of overlapping them, wide-control rows (segmented groups, sliders, selects, accent swatches) stack label-over-control so text renders full-width instead of wrapping every other word, the theme grid drops to two columns (the third card was clipped at 390px), the search field hides its Ctrl+F chip and types at 16px (no iOS focus zoom), and the footer's keyboard-hint chips are gone

- The frosted-glass tweak no longer styles the whole window root as a glass card (`.glass` class collision — the root was also becoming the containing block for every fixed overlay); rail cards blur only while the tweak is on

- Diff cards no longer flash the full diff then replay it line-by-line (chunked reveal, no playback beyond 60 lines, composited cursor)

- Terminal refit/repaint no longer fires on unrelated tabs' state changes; drag-reorder no longer layout-thrashes per pointermove; the lightbox wheel handler is non-passive (no console interventions)

- bash output tails no longer re-split the whole accumulated output per update (O(L²) → tail window)

- Deep-interaction pass: a prompt refused by a busy omp now becomes a visible note instead of a ghost bubble (and busy sends route through the queue); a dead omp process settles the tab's run state, streaming bubble and tool cards instead of claiming "running" forever; a mid-session death now reports its real exit reason instead of a "clean exit"

- Focus traps closed: the terminal and composer no longer grab focus while the Settings page, plan kanban or git browser covers them (typed text could invisibly run/send); IME composition (CJK input) is respected by the composer's popup keys, rename fields and Settings search

- The plan kanban and prompt-history/confirm-close/git-browser overlays joined the shared Escape stack, and the command bridge renders above same-z overlays

- The widget rail sleeps while Settings covers it, the browser panel stops decoding screencast frames it can't show, Esc in the browser panel no longer aborts the running turn, and the goal auto-continue switch stays in sync between the strip and Settings

- The chat collapse horizon no longer folds the text you're reading when its message is removed, and the unread count survives a removed horizon

- Round-2 regression pass: the rail's ✕/sparkline/minimap-highlight props are wired again, the browser panel keeps its flex width, tab rename accepts spaces, widget dismissal re-arms on fingerprint change, and the activity radar's time axis matches its labels

- Escape now closes the topmost overlay (shared stack), the history modal's Enter no longer swallows its buttons, and hidden Settings stops acting on keys — a turn end can no longer send an invisible composer draft

- Paste/drop path insertion no longer clobbers keystrokes typed mid-IPC or leaks into another tab; eval cards auto-scroll the growing cell and reset on settle; search result rows lose their UA button chrome

- `start_session` no longer freezes the window (moved off the IPC thread), a widget finishing at its deadline is no longer misreported as timed out, a malformed `widget-approvals.json` surfaces as a rail error card, and an unreadable `profiles.json` retries once before degrading

- A UI-review pass over the whole app landed 91 fixes. Dead controls removed: the inline plan's "open kanban" button works, the placeholder dictate button is disabled until it exists, and the command bridge's footer hints (↑↓/↵) now drive real keyboard navigation. Data-loss traps closed: Escape with the slash menu open dismisses the menu instead of clearing the draft, and the browser annotation popover keeps its text across re-picks (and gained Save/Cancel). Honesty: the status bar's connection dot reflects the real bridge state, t/s dims to "last …" while idle, the history panel distinguishes "couldn't load" from "no sessions", and Settings search no longer claims a hidden conditional row doesn't exist (and is tokenised AND now). Visibility: buttons show a real disabled state, the dark themes' `--fg-4` meets a 3:1 floor on elevated surfaces, failed tool cards render rose, waiting-for-you tabs pulse, wide markdown tables scroll, and a running bash/eval card follows its own output. Reachability: the tab bar scrolls horizontally when it overflows, tabs are keyboard-focusable, a hidden rail can be brought back from the status bar, the approvals/usage/plan panels close with Escape, and the terminal's height handle is a real separator with keys, a pixel readout and a double-click reset. Plus the long tail: minimap compact cells wired and its legend generated from the kinds actually present, rail cards gain dismiss/relative-time/show-less, the window title follows the active tab, compact rows are keyboard-expandable, tool durations read like "1.2s" instead of raw milliseconds, timestamps drop seconds, and "Jump to latest" counts what's new.

### Changed

- **The tab bar degrades before it scrolls** — four density stages (app/tab-bar.js): full tabs while each gets ≥140px, then compact (capped title, no profile chip), then icon-only with the name in the tooltip, and only past that horizontal scroll, now with edge fades and a vertical mouse wheel mapped to sideways scroll; a ResizeObserver on the bar picks the stage
- **Tabs have a right-click menu** in Chrome/Firefox/VS Code's vocabulary: Close · Close other tabs · Close tabs to the left · Close tabs to the right (left/right grey out when the set is empty); a bulk close that includes a busy tab asks once through the existing busy-close confirmation ("close N tabs"), never once per tab
- - **The tab bar is flat: one tab per conversation** — a project's sessions no longer fold into a single chip with a dropdown; every open conversation is its own visible, clickable, closeable tab (consecutive tabs of one project read as related through a 2px project-colour seam and no repeated folder icon). Resuming a second conversation of an open project from the history panel or the sidebar therefore shows up as a second tab instead of looking like it replaced the first. Drag reorder moves single tabs anywhere along the bar (`OMP_PROJECT_NAV.moveTab`); the sidebar keeps its project-level drag. The tab's hover × now sits flush against the tab's right padding and lost its green brand dot, which had read as an off-centre speck

- Copy unification: buttons, tooltips, empty states and inline errors are lowercase without trailing periods, matching the app's majority convention

- Dead weight removed: the unused per-theme `--syntax-*` ladder (42 definitions), sakura's unused `--magenta-fg`/`--lilac-fg`, phosphor's `.glow-text`, and the never-wired `.ass-text` rules

- Accessibility pass: Shift+Tab is backward focus traversal again (the thinking-level cycle now only fires with the composer focused), the git browser's file tree/history and the conversation tree are fully keyboard-operable, the chat transcript is a `role=log` live region that announces settled replies/failures, the history modal and command bridge are proper modal dialogs (combobox/listbox semantics, inert background), tab lists got arrow-key navigation, minimap cells are real buttons, and tab-close buttons have accessible names

- Contrast: fg-4 lifted to ≈4.6:1 in all 7 themes (placeholders pass with it), solarized's inverted fg ramp straightened, status-hue text on light themes uses new darkened `--*-fg` variants, and the primary button no longer becomes unreadable on hover

- Performance pass: streaming no longer re-parses/re-highlights the whole bubble per token (highlight once on settle), `notify()` coalesces to one snapshot per animation frame, memoized chat bubbles/rail cards/StatusBar stay memoized (stable callbacks and props), xterm.js (478 KB) loads on first terminal open instead of at startup, and the reader thread scans with memchr + a 64 KiB buffer with a zero-copy fast path

- Startup pass: the window is created hidden and revealed on the first painted UI frame (Rust's `on_page_load` is the fallback if the frontend never mounts, and a forwarded "Open with" during startup shows it too), so the script load no longer paints a white flash; previously open tabs restore with parallel spawns instead of one at a time (the saved active tab is the single activation, falling back to the first tab that spawned); the ~2 MiB `get_available_models` reply is fetched lazily on the model picker's first open instead of at every startup and tab switch (the picker's refresh button still forces a refetch, and the commands view shows the `get_state` model name until the list lands); dev builds no longer auto-open devtools at startup (F12 / Ctrl+Shift+I opens them manually)

## [0.11.0] - 2026-10-17

### Added

- Resizable columns (#41): drag the line between the chat and the project sidebar, the subagent pane, the ambient rail or the conversation tree to change that column's width. The widths are saved and come back on the next launch. Double-click a line (or focus it and press Enter) for the default width; with a line focused, the arrow keys move it 16 px (64 px with Shift) and Home/End jump to the narrowest and widest. A column grows only into room the chat can spare, so the chat keeps at least 420 px; in a smaller window the columns narrow first, down to their minimum widths. Settings → Layout → Column widths shows each width, and "Reset all widths" puts every column back, the browser panel included. The browser panel's edge takes the same keys.
- File preview (#39): click the path on a read card, or a link to a project file in the agent's reply, to see the file in a preview window. Code is syntax-highlighted, and the lines the agent read are tinted and scrolled into view (a link's `#L12` or `:12-20` works the same way). Images show whole. "Open in git browser" switches to the git browser, and so does Ctrl/⌘-click. Only files inside the tab's project open; a symlink pointing out of the project is refused. Text files over 1 MiB and images over 8 MiB show as too large; a longer text file shows its first 20,000 lines, each cut at 500 characters. A link written as a Windows path (`C:/proj/a.rs`) or a bare `main.rs:12` opens the preview too. Images the agent read appear as thumbnails on the read card and open in the image viewer. A write card now names its file and its size, and its path opens the git browser like an edit card's.
- A Settings page (#37) that opens as a tab after your project tabs: the cog in the status bar, `Ctrl+,` (`⌘,` on macOS) or `/settings`. Every setting is in one place, grouped into Appearance, Layout, Chat, Composer, Rail, Terminal, Browser, Agent, Session, Approvals and Shortcuts, with a search over all of them (`Ctrl+F`). A dot marks a setting you changed; reset it, or a whole section, with one click. Changes apply at once. The tab shows how many settings differ from the defaults, `Ctrl+W` closes it, `Ctrl+Tab` reaches it after your project tabs, and Esc there never stops the agent. Picking a project tab leaves Settings open where you were.
- The shortcut editor now lives in Settings → Shortcuts; `Ctrl+/` and `/shortcuts` open it there. A binding that comes from omp's own `keybindings.yml` can be changed too; the change is saved as a desktop override.
- New settings: **Reopen tabs on launch** (on by default; off starts with no tabs and leaves the saved list alone until you open or close a tab), **Ask before closing a working tab** (off by default; asks before closing a tab whose agent is working, retrying, waiting for your answer or running background jobs, and before quitting with such tabs, also from the window's close button, Alt+F4 or the OS), **Name tabs automatically** (on by default; off sends no automatic `/rename`), **Send with** `Enter` or `Ctrl+Enter` (for the prompt box, an ask's answer box and a subagent's steer box; the other chord adds a new line), **Collapse pastes longer than** 2–50 lines (default 5), **Follow new output** (on by default; off keeps the transcript where you scrolled while the agent works), terminal **Scrollback** (1,000 to 50,000 lines, default 5,000; applies to open terminals too), **New tabs show** the rail, the conversation tree or the browser beside the chat, **Auto-compact context** and **Retry failed requests** (both on by default; off turns omp's automatic compaction or retries off in every tab).
- Settings → Approvals sets the tool approval mode and the per-project overrides, the same controls as the approvals panel, and shows how many always-allow rules apply, with a link to the panel.
- Settings → Agent sets the startup profile and whether omp keeps working on a goal on its own between turns.
- Settings → Session shows the installed version, the last update check and a version you skipped, which "Clear skipped" offers again.

### Changed

- The floating Tweaks panel is gone; everything it held is in Settings. `/tweaks` is now `/settings`. The status bar's autosave switch and the scanlines setting are removed.
- A picked accent colour now also sets the matching soft, glow and dark shades (focus rings, glows, the terminal's selection), instead of leaving the theme's own shades next to it.

### Fixed

- Typography on Windows: interface text now uses Segoe UI Variable (Segoe UI on Windows 10) and code uses Cascadia Mono, Cascadia Code or Consolas, instead of falling through the macOS-only fonts to Arial and Consolas. Chinese and Japanese characters still take Windows' fallback font for the display language.
- Windows title-bar buttons (minimize, maximize, close) were coloured red, yellow and green by leftover prototype rules. They now use the theme's text colour, draw as line icons instead of text glyphs, and sit flush with no gaps or rounded corners.
- When the app's settings folder can't be found, "always allow in this project" approvals are now kept only until the app closes, instead of being read from and saved to the shared temporary folder, where another user on the same machine could have placed approvals of their own.
- When the app's settings folder can't be found, the profile list, open tabs, recent projects and shortcut changes are now kept only until the app closes, instead of being read from and saved to the shared temporary folder. Another user on the same machine could have placed files there that chose the folder and profile the app's agent starts in at launch. Settings → Shortcuts then shows no settings file path.
- Opening the git browser, or a file in it, no longer runs commands that the repository's own config attaches to files as clean or process filters (`filter.<name>.clean` / `process` in `.git/config`). A downloaded or extracted repository could use them to run a program just because it was previewed. Filters from your own git config, such as Git LFS installed with `git lfs install`, still apply, and so do line-ending conversions. A submodule now shows as changed only when it has a different commit checked out, not for edits inside it.
- A project folder can no longer start its own `omp` in place of yours (security). With an empty or relative entry in `PATH` (`.`, `bin`, or a stray `::`), a tab opened on a project that shipped an executable `omp` could run it with your permissions. omp is now looked up only in absolute `PATH` folders, its version is checked on that exact file, and the session runs that same file. omp, and so every command the agent runs, also gets `PATH` without those entries, so a project can't supply the interpreter an npm-installed omp starts with either: a project-local tool reached only through a relative entry such as `./node_modules/.bin` now needs its path spelled out. An `omp` on `PATH` that you aren't allowed to run is passed over for the next one, as a shell does.
- The example git widget (`examples/widgets/git.sh`) no longer runs programs named by the project's own git configuration. A repository could make it run a command of its choice: a clean or process filter when the widget checked for changed files, or a signature checker (`gpg.program`) when it listed commits. The widget now turns off every filter the project's configuration defines or overrides (filters from your own git configuration, such as git-lfs, keep working), never shows commit signatures, never fetches missing objects of a partial clone, and no longer counts a submodule as changed for edits inside it, only for a different checked-out commit. It now needs git 2.26 or later. Copy the script to `~/.omp-desktop/widgets/` again to get the fix.
- "Allow for this session" / "Always allow in this project" on a tool-approval prompt now always applies to the tab and project whose agent asked. A prompt that reached another tab during a fast tab switch could create the standing rule for the tab you had just switched to. A tab now ignores events from a session it has already switched away from, and the app grants a rule only for an approval prompt that tab's agent is still waiting on, with the tool and project that agent asked about.
- Stage and discard in the git browser can no longer run a `git` that the project itself ships (security). With an empty or relative entry in `PATH` (`.`, `bin`, or a stray `::`), an executable `git` in the project could run with your permissions. `git` is now looked up only in absolute `PATH` folders and run by that exact path, with `PATH` minus those entries for the helpers it starts (credential helpers, ssh, an editor). A `git` reachable only through a relative entry is no longer found: stage and discard then report that git was not found.
- Rail widgets: a plugin's script could be swapped between the approval check and the start of the run, and the swapped-in code then ran under the old approval. Runs now execute verified copies of the plugin's scripts, kept in the app's cache directory under the approved fingerprint, made from exactly the bytes that were checked and compared with the originals again before every run. Anything named by absolute path that loads files next to itself (a widget's `$(dirname "$0")/…` or relative `import`, a launcher like `npx.cmd`) no longer finds them; keep a widget in one file and start launchers by name. A native program named first in `command` (on Windows: a path ending in `.exe`), files over 8 MiB and folders still run from their own path (`docs/widgets.md`).
- The browser panel's Chromium could be controlled by other user accounts on the same computer: its debugging port and the agent's connection point accepted anyone on the machine. Chromium now opens no debugging port at all and talks to the app over a private pipe, and the app answers the agent's browser connections only from programs running as your own user.
- "Allow for this session" / "Always allow in this project" on a tool-approval prompt now approves the prompt and saves the rule in one step. Before, a failure in between, or the tab's agent restarting at that moment, could leave a saved rule for a prompt that was never approved, or send the approval to the restarted agent. The rule is now saved only after the approval reached the agent that asked; if it could not be delivered, nothing is saved.
- Windows and macOS: a program the app started at the same moment as the browser panel's Chromium (an agent, a widget, the terminal's shell, git) could inherit Chromium's private pipe and with it control the browser behind the app's back. The pipe is now open to Chromium alone: the app starts no other program while Chromium is being started.

## [0.10.1] - 2026-10-16

### Fixed

- macOS no longer says OMP Desktop "is damaged and can't be opened" when the app was downloaded with a browser (#60). The app is now signed ad hoc, so on first launch macOS asks you to allow it in System Settings → Privacy & Security → Open Anyway instead. It is still not notarised by Apple.

## [0.10.0] - 2026-10-15

### Added

- A browser panel next to the chat (#58): see and use the same browser the tab's agent works in. Open it with the globe button in the status bar, `Ctrl+Shift+B` (`Shift+⌘B` on macOS; rebindable in the shortcuts screen) or `/browser [url]`. The panel follows the page the agent is on and has page tabs, back/forward/reload and an address field; drag its left edge to resize it or switch to full view. Mouse, scroll, keyboard, paste and input methods reach the page, while the app's own panel and tab shortcuts keep working. **Annotate** lets you click an element or drag over an area and add a comment; it goes out with your next message (or the goal you start) as text plus a screenshot of the area. What comes from the page is marked as page content, so a page can't give the agent commands. Localhost links in chat open in the panel (`⌘`/`Ctrl`+click opens your normal browser; switch it off under Tweaks → Browser). The panel uses Google Chrome, Chromium, Edge, Brave or the Chrome for Testing omp downloads; the app finds one itself, and the `chromium` menu under Tweaks → Browser lets you choose another. Each tab gets its own browser with a fresh profile and no extensions, started only when needed and closed with the tab. The agent works in the page you are looking at, so its navigation replaces yours.

### Changed

- The conversation tree is now open or closed per tab, like the browser panel: switching tabs shows each tab's own side column (the rail, the tree or the browser).
- The status bar now runs along the whole bottom of the window, under the side panels too, and stays on one line: when space is short it drops the tokens/s, cost and context meter cells, in that order, instead of wrapping or cutting off its buttons.

### Fixed

- Icons now grow and shrink with the font size set in Tweaks, like the text next to them. Until now they stayed the same size, so at a larger font size the icons in the git browser, the session history, the Tweaks panel, the tabs, the sidebar and the chat looked too small and were hard to read. Icon-only buttons and the Tweaks panel grow with them. A crowded status bar no longer squeezes its icons either.
- The model pill below the prompt box no longer sits lower than the thinking, plan mode and goal pills next to it.
- A terminal shell path in `terminal.json` wrapped in quotes, as Windows' "Copy as path" gives it, now works.

## [0.9.0] - 2026-10-15

### Added

- Choose omp's tool approval mode in the app (#57). The approvals panel, opened from the ✓ button in the status bar, sets how often the agent asks before it acts: `always ask` (it asks before every file change and every command; only reads run on their own), `write` (the default: it edits files on its own and asks before shell commands and anything else that runs code) or `yolo` (every tool runs without asking, shell commands included, and omp's own stop for dangerous commands such as `rm -rf /` is skipped too; shown in amber). The mode is a default for all projects, and each project can have its own. A change restarts the agent in the tabs it affects, and the conversation picks up where it was; a tab that is busy switches when its turn ends, and until then the status bar shows both modes (`write ⇢ yolo`). Your saved approval rules are kept.
- A git browser for the tab's project. The git button in the status bar, `Ctrl+Shift+G` (`Shift+⌘G` on macOS; rebindable in the shortcuts screen) or a click on the file path in an edit card opens it over the whole window, in three panes. **Files**: the project tree with each changed file marked (modified, added, deleted, renamed, untracked), a "changed" switch that shows only those, and a filter by name; ignored files are left out. **File**: the whole file with its change against the last commit inline — staged and unstaged together, removed lines in place, added lines highlighted, old and new line numbers — opened on its first change, with buttons to jump between changes, stage, discard, and copy the diff. **History**: the commits of every branch, remote branch and tag as a graph, with the branch you are on, how far it is ahead of or behind its upstream, and your uncommitted work as the top row. Click a commit to browse it: the files pane then lists the files it changed and the file pane shows a file as of that commit with that commit's change inline; click the top row to get back. It refreshes by itself when the branch changes, when the agent edits a file and after a stage or discard. Very large repositories, files and histories are shown up to a limit (20,000 files, 20,000 lines per file, 2 MiB per file, 500 commits), and a capped view says so.

### Changed

- The status bar no longer shows the model and thinking level: the pills below the prompt box already show both, so the status bar has more room for the rest.
- The status bar's git button opens the git browser instead of the Changes panel, which is gone; its stage and discard buttons are in the browser's file pane.
- Reading the repository (status, file contents, history) no longer runs the `git` program; the app reads the repository itself. Stage and discard still run `git`.

### Fixed

- Arrow Up no longer replaces a prompt you are typing with your last sent one (#55). Up and Down now move the caret in a typed draft, wherever it is. Up brings back earlier prompts only from an empty prompt box, as in omp's own editor. While you step through them, Up on the first line and Down on the last line move between prompts, and Down past the newest one empties the box again. `Ctrl+↑` still opens the searchable picker at any time.

## [0.8.0] - 2026-10-13

### Added

- A shell in every tab (#56). The terminal button in the status bar, `` Ctrl+` `` / `` ⌘` `` (rebindable in the shortcuts screen) or `/terminal` opens a real shell in a panel below the chat, in the tab's project folder (your home folder when the tab has none) and with your normal shell profile. Hiding the panel keeps the shell running, so output produced meanwhile is there when you come back; closing the tab ends the shell and everything it started, and switching the tab's profile keeps it. After `exit`, press Enter in the panel to start a new one. A program that prints faster than the panel can draw is slowed down instead of making the app sluggish. Drag the panel's top edge to resize it (the height is kept). Under Tweaks → Terminal you pick the shell new terminals start from a menu: `default` and the shells installed on this computer — on Windows `cmd`, `powershell`, `pwsh`, Git Bash (`bash`) and `nu`; on Linux and macOS `sh`, `bash`, `zsh`, `fish`, `dash`, `ksh` and `nu` — or any other program through "other…"; there you can also open the panel with every new tab. `Ctrl+C`, `Esc` and other `Ctrl`/`Alt` keys in the terminal go to the shell, not to the agent; the toggle-terminal and next/previous-tab shortcuts, `⌘` shortcuts and (outside macOS) `Ctrl+Shift` shortcuts still reach the app. Copy and paste with `Ctrl+Shift+C` / `Ctrl+Shift+V` (`⌘C` / `⌘V` on macOS).

### Fixed

- Tweaks: a long path no longer runs off the panel. The `plugins` row under Rail shows the full path to `widgets.json` on its own line, wrapped.

## [0.7.0] - 2026-10-13

### Added

- Send a waiting message right away (#47). While the agent works, each steer and follow-up listed above the prompt box has a ⚡ button: it stops the agent's current step, as Esc does, and the agent continues at once with the message (and any other steers waiting). Before, a steer waited for the agent's next step and a follow-up until the agent was done.
- Drop images onto the prompt box (#50). Drag image files from the file manager onto the prompt box to attach them, as with the attach button or a paste: they show as thumbnails you can remove, keep the text you already typed, and go out with the next message, text or not. Other files are ignored. A file dropped anywhere else in the window is refused, and so is a link dropped outside a text field (it would have opened in your browser).
- Collapse all / Expand all (#43): `/collapse-all` and `/expand-all` in the command bridge and the prompt box's `/` menu fold or unfold every tool card and thinking block in the current tab at once; blocks that arrive later follow your settings again. Both can be given a key in the shortcuts screen.
- `/tweaks` opens the Tweaks panel from the command bridge or the prompt box, like the cog in the status bar.
- Tweaks → Rail: show or hide the context gauge, agent radar, subagents card and minimap individually; the choice is kept across restarts (#51).
- Rail widgets (#49): your own cards in the ambient rail, between the subagents card and the minimap. List a program in `<app config>/widgets.json`; it prints JSON to stdout (status, numbers, progress, key/value rows, text, lists, links) and the desktop draws it as a card. Nothing runs until you approve the plugin's exact command and script in the rail; if either changes later, it stops and asks again. Approved plugins refresh by themselves when you switch to a tab, when a turn ends, when the branch changes, on their refresh button or every `intervalMs`; a turn that ends in a background tab refreshes its cards when you switch to it. At most four run at once, a hidden card or rail runs nothing, and closing a tab or quitting stops its plugins. List items can add text to your prompt or open a link. Each plugin card has its own toggle under Tweaks → Rail. Examples in `examples/widgets/`, setup and trust model in `docs/widgets.md`.
- omp extension widgets in the rail (#52). What an omp extension shows with `ctx.ui.setStatus` and `ctx.ui.setWidget` used to be dropped; it now appears in the rail after the plugin cards: one `status` card with a row per status line (omp's own `/review` and `/annotate` report their progress there), and one card per widget with its lines in monospace, both marked `extension`. Each tab shows its own, including what a background tab published meanwhile; they stay through `/new`, branch and fork, as in omp's terminal UI, and go when the tab's omp process ends. Each card can be hidden under Tweaks → Rail. Example extension in `docs/widgets.md`.

### Changed

- Thinking and tool output fold separately (#43). Under Tweaks → Chat, *thinking* and *tool output* each choose auto (fold a long block once enough newer ones follow it, as before), open (never fold on their own) or folded (start folded). Folded tool output still shows a running command, an edit's diff and a call that failed. They replace the auto-collapse switch; if you had turned it off, both start as open.
- The collapse button on tool cards and thinking now shows what a click does: a down chevron on a collapsed block expands it, and an up chevron on an open block collapses it. Before, a collapsed block showed a right chevron and an open one a down chevron, which read as "expand". The button is also larger and grows with the font size set under Tweaks → Look, like the text beside it.

## [0.6.1] - 2026-10-12

### Added

- Reorder tabs and projects by dragging (#40). Drag a project along the tab bar or the project sidebar, or a conversation within its project in the tab-bar dropdown or the sidebar; a line shows where it will land, and Esc cancels. `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` move the current tab's project one place left or right (rebindable in the shortcuts screen). The order is kept when the app restarts.
- Tool cards and thinking can be collapsed (#44). Everything starts expanded; once enough newer tool calls and thinking blocks have followed a long one, it folds down to its first few lines (a shell command to its last few). Short ones never fold on their own. Each has a chevron button to collapse or expand it by hand, which always wins and is kept when you switch tabs. Nothing folds while you are scrolled up reading. Set how many newer blocks to wait for, or turn auto-collapse off, under Tweaks → Chat.

### Changed

- A tab for a project with one conversation now shows the project's folder before the conversation's title (`omp-desktop · fix tab close`), in the tab bar and the project sidebar (#46). The folder is shortened first when space runs out, and left out while the conversation is still named after its folder.
- A project's conversations are listed newest-opened first, in the tab-bar dropdown and the project sidebar (#38), until you drag them into another order.
- A tool call one of your approval rules let through now shows what was approved, not just the tool: a compact "auto-approved" row under the tool's card names the tool and what the call does — the command, the file, the action — and a click unfolds everything the approval prompt would have shown (#42). Before, the conversation only said "Auto-approved bash via your approval rule" in a full reply bubble.

### Fixed

- A project with several conversations now has a close button (×) on its tab-bar chip, like a single tab (#45). It closes one conversation — the one you are in, or the newest when you are in another project — never the whole project; its tooltip names the conversation.

## [0.6.0] - 2026-10-04

### Added

- Messages waiting for the agent are listed above the prompt box: steers (Enter while the agent works) and follow-ups (Ctrl+Q), in the order the agent will get them. Each row can be removed (✕), taken back into the prompt box to edit (✎, text only), or — for a follow-up — sent as a steer right away (↑), which also starts the agent again after you stopped it. A message the agent already took cannot be pulled back; the row then says "already delivered". The list is omp's own queue, so it stays correct across tab switches. A steer or follow-up omp refuses leaves a note with its text.
- Talk to a running subagent, or stop it, from the subagent manager. Open an agent while it works: a message box under its details sends it a message as if you were its user (Enter sends, Shift+Enter starts a new line). The agent reads it at its next step; while the agent is open in the manager, the message then shows up as a `you ›` line in its Output tab. A message the agent refuses stays in the box with a note saying why; so does text you were still typing when the agent finished. The stop button asks once more before it ends the agent; the agent that started it gets an aborted result and carries on.
- Pick the thinking level from a menu (#10): click the thinking pill under the prompt box. It lists the levels the current model supports, each with what it means, and ticks the one in use. Shift+Tab still cycles through the levels.
- When the agent asks you questions, they now arrive together in one card: every question of the ask at once, with each option's description, the recommended option marked, previews where the agent gave them, and a box to type your own answer to each. Questions that take several answers have checkboxes. Nothing is sent until you press Submit, which waits until every pick-one question has an answer; a lone pick-one question still answers on click. Cancel stops the turn, as Esc does. Once sent, the card shrinks to the answers you gave. Before, the questions came one at a time, and every click on a multi-answer question added another prompt to the chat.
- A tab whose agent has finished its reply but still has a background job running (a backgrounded shell command, task or eval) now shows it: a hollow ring in the tab bar and the project sidebar, and a note under the prompt box, until omp reports the work done. The agent picks the job's result up by itself; a row naming the finished job (its command and run time) then appears above the reply it triggered. The update dialog counts such a tab as busy, since restarting would kill the job.
- A conversation tree with the prompt-cache status of every prompt. Open it from the branch button in the right rail or the status bar, or type `/tree` (or `/branch`): it replaces the right rail and lists the conversation as a git-style graph, one row per prompt, oldest at the top, with branches in separate lanes and a divider at each context compaction. Each row says whether asking that prompt again would reuse the provider's prompt cache — cached, expiring in under 10 minutes, partly cached (the part up to an earlier cache anchor, which omp re-marks every 15th prompt, is still cached), or cold — and what asking it again would cost now and after the cache expires; when the provider reports no cache lifetime, the rows show no cache colours or prices. Select a row to **Branch here** (a new conversation without that prompt and everything after it; the prompt goes back into the prompt box), **Fork after the reply** (a new conversation that keeps the prompt and its reply), or, for a prompt that only exists in another conversation of the same family, **Open in new tab**. Branch and fork are disabled while the tab's agent works. A new omp process (a tab opened from the tree, or a tab reopened after a relaunch) writes the conversation to the cache again, because its system prompt differs (with a memory backend, the recalled memories): the tree prices **Open in new tab** that way and shows points cached by an earlier process as cold, tagged "earlier process".
- When a request fails and omp retries it by itself (an overloaded or unreachable provider, say), the conversation now says so: a row with the attempt (such as 3 of 10), the provider's error, a countdown to the next try or how long the current try has been waiting, and a Stop button — between tries it stops retrying and shows the failure, during a try it stops that try as Esc does. Meanwhile the tab bar and the project sidebar show a spinning amber dot, and the update dialog counts the tab as busy. Failed tries no longer leave empty replies behind: the reply says after how many failed attempts it came, or how many there were before omp gave up or you stopped it.
- Goal mode: give the agent a goal it keeps working toward until it calls it done. Click the new **goal** pill under the prompt box (or type `/goal`, optionally followed by the goal), optionally pick a token budget (presets or your own, such as `300k`), and what you send becomes the goal. A strip above the prompt box then shows the goal, its status, the tokens used against the budget and the time spent, with pause, resume and drop (drop asks first); once the agent completes the goal, the strip keeps the final usage until you dismiss it. The conversation marks each change: goal set, paused, resumed, budget reached, complete, dropped, and every turn omp started by itself to continue the goal. Esc pauses a running goal, as in omp; resume picks it up again. A goal that was running when OMP Desktop closed comes back paused. The **auto-continue** switch in the strip is omp's own setting (`goal.continuationModes`) for the tab's profile: with it on, omp keeps working on the goal between turns by itself; with it off (omp's default when an app such as OMP Desktop drives it), each turn needs a message from you, and the strip says so while it waits. Plan mode and goal mode exclude each other, as in omp. Until omp fixes it, the agent's own goal calls ask "Allow tool: goal"; allowing it for the session or project stops the prompts.

### Changed

- OMP Desktop now requires omp 18.4.11 or newer. A tab started against an older omp does not start; its note names the installed and the required version, and an `omp update` takes effect for the next tab without restarting the app. The list of waiting messages, subagent steering, the question card, the conversation tree's fork and goal mode (see Added) rely on RPC commands that older omp versions lack.
- A steer or follow-up now appears in the conversation when the agent actually reads it, not when you send it, and no longer pulls the view down if you are reading further up. Until then it is in the list above the prompt box.
- Pick-from-a-list prompts from extensions, such as `/review`'s pickers, no longer have a box for typed text: they only accept one of their own options.

### Fixed

- The chat stays on its latest line when the area below it grows — the list of waiting messages, attached images, or a long draft — instead of hiding the end of the conversation behind it until the next update.
- A tab that fails to start — omp too old or not on `PATH`, or its profile deleted meanwhile — now says why, in the current tab or on the empty workspace, when it was opened with `+`, from a recent project or from the history panel. Before, nothing happened.
- After picking a model whose highest thinking level is lower than the current one, the thinking pill shows the lowered level right away instead of at the next prompt.
- A model without thinking showed `thinking · auto`; it now shows `off`, as omp does. The status bar showed `xhigh` as `max`, and omp's own `max` level as `—`.
- An answer you typed to the agent's question reached the agent as if you had picked an option of that name; it now arrives as your own answer.
- A request the provider rejected — after omp's own retries — left an empty reply, which vanished entirely after a tab switch. The reply now shows the failure: the HTTP status, provider and model, the provider's own message, and its full response behind "provider response". "temporary" marks a failure omp considers transient, such as an overloaded provider, where sending again later may work. A failed request that produced no output is not kept across a restart: omp leaves it out of the conversation it resumes.
- After switching tabs and back, the conversation keeps its order: a reply that followed a tool call could jump above it, and every later entry shifted along with it, the last one sometimes vanishing. Notes the app adds itself (an automatic tool approval, a login result) and messages omp dropped from its own context (an attempt it retried) no longer disappear on a tab switch either.

## [0.5.0] - 2026-10-03

### Added

- Rename a conversation from the tab bar or the project sidebar (#32): double-click a tab or a sidebar row, or use the pencil on a sidebar row or in a grouped tab's dropdown, then type the name and press Enter (Escape cancels). The name is saved with the conversation, so it survives a restart or resume, and from then on the automatic title never overwrites it. It works while the agent is running too, and leaves nothing in the chat. Typing `/rename <title>` still works the same way.
- Copy buttons on agent output (#33). Hover an assistant message, a code block, a bash output, an eval cell's code or output, or an edit's diff, and click the copy icon to put its raw text on the clipboard: a message copies as the markdown the agent wrote, a code block as the exact fence content, and a bash output in full — including lines scrolled out of the card, without omp's wall-time and exit-code notes. The button briefly shows "copied".
- Skills can be picked in the middle of a message (#30), the way omp's own editor does it: typing `/` after other text (`review this change /`) opens a list of skills only, which narrows as you type a name or any part of a hyphenated name (`/rev` finds `skill:code-review`). Picking one inserts `/skill:<name>` at that spot and keeps the rest of your text, which omp passes to the skill as its instructions. Escape closes the list without touching the message. A message that invokes a skill this way also reaches omp as a skill while the agent is still working, and plan mode sends it as typed, like a `/skill:<name>` at the start.
- The model picker lists your recently used models first (#11): up to five, newest first, in a "recently used" group above the full list, which stays unchanged below. The order is omp's own — the same one its terminal model selector uses — so a model you switched to in the terminal, in another tab, or by `/model` counts too. It is kept per profile, includes only models you can pick right now, and follows the filter as you type.
- The app reopens the tabs that were open when it last closed (#17) — after quitting, a restart, or an in-app update. Each tab comes back in its place with its project, profile and conversation, and the tab you were on is active again. A tab that had no conversation yet reopens empty on its folder. A tab whose folder no longer exists, or that fails to start, is not reopened; a note in the chat says which. Folders opened with "Open with OMP Desktop" at launch open after the restored tabs and become the active tab.

### Fixed

- Pasted text stays readable (#31). A sent message keeps its line breaks instead of running them together into one line. A long paste (more than 5 lines or 500 characters) still goes into the prompt box as a `[paste #N +K lines]` placeholder, but a chip above the box now shows it: click the chip to read the pasted text, or "expand" to turn it back into editable text in the prompt. Once a draft is taller than the prompt box, it scrolls instead of hiding the rest.
- After an in-app update on Windows, the relaunched app connects to omp again instead of every tab staying silent until a manual restart (#34). The MSI installer starts the new version with only the machine-wide PATH, so an omp installed for the current user (`%LOCALAPPDATA%\omp`, on the user PATH) was not found. omp is now spawned with the machine and user PATH from the registry appended to whatever PATH the app was started with. The same goes for `git`, so the Changes panel also keeps working with a per-user Git install (winget `--scope user`, scoop).
- The history panel's filter row offers one chip per project that has saved conversations, each with its count, instead of only "All Projects" and the current project (#35). The current project's chip comes first, and stays there with a count of 0 when it has none; the rest follow their most recent conversation. Two folders with the same name show their parent folder (hover a chip for its full path), and a long list of projects scrolls inside the filter row.

## [0.4.2] - 2026-10-02

### Fixed

- The prompt box and plan mode belong to each tab instead of being shared by all of them (#28). Switching projects no longer carries over a half-typed message (which Enter would then send to the other project), its attached images or collapsed pastes, plan mode, or plan comments. Each tab keeps its own until you come back; an image still being prepared when you switch lands in the tab it was pasted into.

## [0.4.1] - 2026-09-30

### Added

- A new conversation's tab is named after its folder at first, then renames itself to the conversation's generated title once the first exchange finishes (omp's RPC mode never auto-titles, so the app asks for one with `/rename` after the first turn); the title is then refreshed after 5 and 10 further turns to keep up with the work, then left alone, and a `/rename` you type yourself (`/rename Title` or `/rename:Title`) always wins. The project sidebar's single-tab card shows that name too. Resumed conversations keep their saved name. `/new` in the same tab drops the old title and earns a rename of its own (#13).

### Fixed

- Release builds stamp every script and stylesheet URL with the app version (`?v=X.Y.Z`), so a webview that cached a previous version's files after an in-app update can no longer serve them: the WebView2 data folder survives the updater, and embedded assets carry no cache validators, which could leave an updated app running a mix of old and new frontend modules until the cache happened to evict.
- The Linux `.AppImage` starts when another user mounts it — `firejail --appimage`, the AppImage catalog's test, root-extracted copies — instead of failing with `AppRun.wrapped: Permission denied`. Tauri CLI before 2.12 shipped that launcher as owner/group-only (`0770`); builds now use Tauri 2.12, and a release fails if any file in the AppImage is limited to its owner.

## [0.4.0] - 2026-09-30

### Added

- Project sidebar (toggle with `Ctrl+B` / `⌘B`, the tab-bar button, or the *project sidebar* tweak): open tabs grouped by project — hover a project to start a new conversation there — plus the recently opened folders of the active tab's profile; click one to open it, hover to drop it from the list (#27).
- Tabs on the same folder and profile collapse into one tab-bar chip with a count; its dropdown switches between them or starts a new conversation in that project — a second tab on the same folder and profile, i.e. a duplicate of that project card (#27, #12).

### Changed

- Opening a recent project, or resuming a conversation from history, focuses its tab when it is already open instead of starting a second copy (#27). `+` / `Ctrl+T` still always opens a new tab.
- A folder picked with `+` / `Ctrl+T` is opened at its real (symlink-resolved) path, the same form "Open with OMP Desktop" and the recent-projects list use, so an open project is always recognised (#27).
- The app no longer opens an empty "OMP Desktop" tab at launch — an agent running in whatever directory the app happened to start in, with no project behind it. With no tab open (at launch, or after closing the last one) the main area shows an animated "digital rain" welcome screen with an OMP-DESKTOP logo (static when the system asks for reduced motion); projects open from the sidebar or the tab bar, and no agent process runs until one does.

## [0.3.3] - 2026-09-25

### Added

- Middle-clicking a project tab closes it, like in a browser (#24).
- Clicking an image attached to a message pops it out into an enlarged viewer; with several images, switch between them with the arrow buttons or ←/→ keys, close with Esc or a click (#25).

### Fixed

- Conversation history is now ordered by when a session was last active (its most recent message), not by when it was created — a session you continue days after starting now correctly sorts to the top (#23).
- Raw HTML in agent replies and plans is shown as text instead of being rendered, so markup like `<img onerror=…>` can no longer run scripts in the app.

### Changed

- Release builds no longer allow inline scripts or inline event handlers (Content Security Policy), as a second line of defence against injected markup.

## [0.3.2] - 2026-09-24

### Fixed

- Markdown links whose scheme is hidden behind HTML character references (e.g. `&#106;avascript:`) now render as plain text instead of clickable links.
- A code block's language tag can no longer inject HTML attributes into the rendered page.

### Changed

- Faster startup in release builds: the interface ships precompiled and uses React's production build, so the first screen appears in about 0.1 s instead of 1.7 s, and the bundled frontend files shrink from 5.4 MB to 1.3 MB. `npm run dev` is unchanged.
- Stricter Content Security Policy: `eval` is no longer allowed (nothing in the app needed it).
- All dependencies updated: React 19.3 (was 18.3), marked 18 (was 12), highlight.js 11.12, Babel 7.29.9, Tauri 2.11.6 and its plugins, `gix` 0.87, `notify` 8, `sha2` 0.11, `windows-sys` 0.61, Tauri CLI 2.11.5. This also clears two `quick-xml` security advisories.

## [0.3.1] - 2026-09-24

### Added

- In-app updates (#19) — the tab bar now shows the running version (it used to show a hardcoded placeholder) and, once a newer release is published, an update pill. The pill, the version label, `/check-updates` and a rebindable **Check for updates** shortcut open a panel with the release notes and **install & restart**, which downloads the signed update, verifies it, closes every tab's omp process and relaunches. It warns first if any tab is mid-turn. Windows, macOS and the Linux AppImage update themselves; `.deb`/`.rpm` and source builds only get the notice and a link to the release page. The app checks 15 s after launch and then every 6 h; background checks never open anything, and **skip this version** hides the notice until a newer version appears. Automatic checks can be turned off in Tweaks → Session. Installs from before this release have to be updated by hand once.

### Changed

- Release builds are now signed for the updater. The release workflow needs the `TAURI_SIGNING_PRIVATE_KEY` secret (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one) and fails early without the key. Once every platform has built, it publishes `latest.json`, using this changelog's section for the version as release notes. It won't publish a feed that is missing a platform, or one whose tag disagrees with the app version. A manual run of the workflow now names its release after the `tag` input; it used to name it after the branch. Releases only build after the full test suite passes (Rust tests on Windows/Linux/macOS plus the JS regression scripts), and CI now runs that same suite; it previously ran only `cargo check`.

## [0.3.0] - 2026-09-24

### Added

- Usage statistics panel (#22) — a status-bar button surfaces cost/token telemetry for the active tab's profile, sourced from `omp stats --json` (requests, error rate, cost, cache rate, tokens in/out, avg throughput/TTFT), broken down by model, by project folder, and by agent type (main/subagent/advisor). Covers a rolling last-24-hours window and the active tab's own profile only — omp's `--json` output has no flag for a wider time range, and resolves against one profile per invocation the same as every other per-tab omp spawn — so switching tabs to a different profile and reopening the panel shows that profile's own last-24h usage, not a merge across profiles.
- Prompt history in the composer (#16) — Arrow Up/Down recall the tab's previously sent prompts (bash/readline-style: only when the caret sits on the first/last line, so multi-line edits still use the arrows normally), and Ctrl+Up/Cmd+Up opens a scrollable picker over the last 100 (configurable in Tweaks → Session) prompts, click or Enter to load one into the composer without sending. History is per-tab and in-memory only — never written to disk — gathered as you send, and backfilled from the transcript whenever a tab is (re)activated or a saved session is resumed, so switching back to an older tab or resuming from history repopulates it instead of starting empty.
- Minimap legend (#21) — the session minimap grid colored each cell by role/tool with no key explaining what the colors meant. A small legend row now sits under the grid, mapping color to meaning: you, assistant, ask, tool.
- Subagent manager — live introspection of the agents a `task` call spawns. A **subagents** card in the right rail shows how many are running, their combined tokens/cost/tool calls, and what each is doing right now (current tool + intent, elapsed time). Opening the manager (the card's button, the Tweaks **split** layout, or the new inspect icon on any agent row of a task card) adds a column with totals, a swimlane timeline of recent activity (the last few tool calls of up to 8 agents active in the past ~2 minutes), live/done/failed filters, and agents grouped by the task call that spawned them — nested agents indented under their parent, and each group can jump the chat to its task card. Clicking an agent opens an inspector: its task and assignment, the tool it is running now, tokens/cost/wall time/requests/model/context, recent tools, recent output plus a live event stream, and its full transcript. Finished agents stay listed for the rest of the session (omp itself forgets them), and a background tab re-syncs on return, marking agents that finished meanwhile as ended. The live event stream is only requested while an agent is being inspected.

### Changed

- Removed the "peer session" rail card, split pane and `split` tab chip — prototype leftovers that never had live data behind them. The Tweaks `split` layout now opens the subagent manager instead.

### Fixed

- The `/` palette and ⌘K bridge never received omp's slash-command list on connect: the backend's command allowlist was missing `get_available_commands`, so the request introduced for #8 was rejected before reaching omp and the list only filled in if omp happened to push an `available_commands_update`. It is now allowlisted, and a Rust test checks every `_send`/`_sendWithResponse` call site in `live.js` against the allowlist (failing on any call site whose command type it cannot read).

## [0.2.2] - 2026-09-23

### Fixed

- Image attachment in the composer — the attach-image icon had no click handler and clipboard paste only ever read plain text, so both silently did nothing (#7). The icon now opens a native file picker; pasting an image (screenshot, copied file, or a bitmap alongside real text from a spreadsheet/rich-text app) now attaches it as a thumbnail and sends it to the agent as an image content block, with the accompanying text preserved. On Linux (WebKitGTK), the synchronous paste event never carried image data at all even after that fix — only `text/*` — so clipboard image paste still silently did nothing there; pasting now falls back to the async Clipboard API when the synchronous path finds no image, which WebKitGTK does populate correctly.
- Clicking a link in agent output (e.g. a GitHub URL) navigated the app's own window in place, with no back control — the only recovery was quitting and losing every tab's session state (#14). The webview now stays on the app for every internal navigation; `http(s)`/`mailto` links are handed to the system's default browser/mail client instead. Everything else is refused: a same-origin file-path link no longer reboots the app in place, and a `javascript:`/`data:` link (which a webview would otherwise execute before any navigation even starts) is rendered as plain text instead of a clickable link.
- Chat force-scrolled to the bottom on every streamed update while the agent worked, with no way to read earlier content mid-run (#20). The transcript now auto-scrolls only while already pinned to the bottom; scrolling up unpins it (per tab) and shows a "Jump to latest" button. A new streamed message no longer forces the view back on its own — scrolling back down to the bottom, sending, steering, queueing a follow-up (which now shows in the transcript immediately rather than once the agent gets to it), clicking the button, or the transcript being reset (`/new`, a profile switch) all re-pin.
- A tab opened from history with a long (often auto-generated) session title could span nearly half the window width and squeeze out every other tab (#15). Tab labels now truncate with an ellipsis at 200px and show the full title on hover.
- The `/` composer palette and ⌘K command bridge only ever listed a static 12-entry desktop command list — omp's real slash commands (`/security`, `/fast`, `/mcp`, …) and every discovered skill (`/skill:<name>`) were invisible, with no way to run them except typing the full name from memory (#8). Both now merge that static list with omp's live `get_available_commands` (fetched on connect, refreshed on `available_commands_update`, scoped per tab/profile). A desktop entry (`/plan`, `/history`, …) still runs its own handler; picking an omp-native entry inserts `/name ` into the composer so you can add arguments and send it as a normal prompt, which omp executes.

## [0.2.1] - 2026-09-19

### Added

- "Open with OMP Desktop" on a folder — Finder, Explorer (right-click a folder or a folder's background) and Linux file managers can hand a directory to the app, which opens it as a project tab. Opening a folder while the app is running adds a tab to the existing window and brings it to the front; opening one while it is closed starts it with that folder's tab instead of the empty launch tab. Opening a folder from the command line (`omp-desktop /path/to/project`) does the same.
- Keyboard shortcuts — every desktop action (tabs, panels, model cycling, session history, plan mode) is now a bindable, rebindable chord; the main ones ship with a default binding out of the box. The Shortcuts screen (`Ctrl+/` or `/shortcuts`) lists all actions with their effective chords, their source layer (omp config / desktop overlay / registry default), and lets you rebind, add a second chord, clear, or reset. Rebinds are stored in `<app config>/keybindings.json`; omp's own `~/.omp/agent/keybindings.yml` is read-only and respected as the base layer. Dispatch honours the focused element: typing characters in the composer is never intercepted, but `Ctrl+`/`Alt+`/`Super+` combos and `Escape`/`Shift+Tab`/Fn keys work from anywhere. The command bridge's own Escape handling (back out of the model/login view, then close) now runs standalone instead of behind a global override, so `Escape` from a drilled-in view returns to the command list before it closes the bridge.

## [0.2.0] - 2026-09-17

### Added

- Per-tab omp profiles — each tab runs its own `omp --profile <id>` (separate auth, sessions, settings, caches); create, rename and delete them from the title-bar selector, and tick one as the default that new tabs and the next launch start in. The built-in `default` profile keeps using `~/.omp/agent`; switching a tab's profile restarts that tab's agent only.
- Approval rules — "Allow for this session" / "Always allow in this project" on approval prompts, plus a panel to review and revoke them. Sessions now start with `--approval-mode write`, so exec-tier tools ask instead of auto-approving.
- Changes panel — `git status`/`git diff` for the active tab's project with per-file accept/reject, bounded so large changesets stay responsive.
- `@`-mention autocomplete for project file paths in the composer.
- Conversation history and resume are scoped to the tab's own profile.
- `confirm` and `editor` prompts render as chat cards (previously auto-cancelled and invisible); `input` no longer uses a blocking browser dialog.
- Per-tab run state in the tab bar: running / waiting-on-you / idle / failed.
- Switching back to a background tab recovers the tool cards, prompts and streaming state that arrived while it was away.
- Credentials (tokens, API keys, auth headers) are redacted from agent output and logs.
- Hardening: only known RPC command types reach the agent, and saved-session identity comes from the session filename.
- `test-rpc.mjs --evidence` writes a redacted golden snapshot of the RPC surface to `docs/agents/evidence/`.

### Fixed

- Closing a tab or quitting now kills the agent's whole process tree — no orphaned subagents or tool-call children.
- Enter that commits an IME candidate no longer sends a half-typed message.
- Bridge button in the title bar sat ~7px above the window controls.
- Ask prompts could be answered twice, or answered after the agent had already cancelled them.
- "Agent process exited" / "Agent failed to start" notices rendered as blank bubbles, hiding why a session died.
- A tab whose agent dies during startup now explains itself instead of going blank. Any death before the agent's first output — a rejected flag, an exec failure, or no model resolving — previously read as a clean, silent exit; the tab now shows omp's own stderr reason, including the exact command to run when it's a missing-credentials profile. Background tabs report it too, when next selected.
- A freshly created profile's tab died silently at startup (no credentials, so omp had nothing to boot) and `/login` plus the provider list had nothing to talk to. `create_profile` now seeds a minimal `models.yml` so the tab boots far enough to run `/login`; the seed is removed once login succeeds.
- Several prompts raised in one turn overwrote each other, wedging the tab with tool cards stuck at "running".
- Approval rules could be silently lost when two windows saved at once: a stale-lock takeover let the previous holder delete the new owner's lock file, admitting a third writer mid-write.
- Lock contention on the rules and profile files surfaced as `File exists (os error 17)` instead of a readable "another window is updating this file; try again".
- A failed session spawn (omp missing from PATH, an exec error) left a dead tab in the tab bar with no agent behind it, and a failure partway through startup could leave a running omp process that nothing could reach or shut down.

### Changed

- Large diffs and long tool-output streams are now bounded in memory (journal capped at 8 MiB per session; `git diff` read through an early-stopping pipe).

## [0.1.3] - 2026-09-13

### Added

- Conversation history panel (`Ctrl+H`/`⌘H`, `/history` command, or the clock icon in the tab bar) — browse, search, and resume past omp sessions persisted under `~/.omp/agent/sessions`. Backend adds `list_saved_sessions` (async, off the Tauri main thread) and a validated `resume` path on `start_session`; `resume` values are checked against the sessions directory before being forwarded to omp's argv, rejecting flag-shaped or out-of-tree paths.

### Fixed

- Tab switch drops all tool cards from chat — `get_messages` returns only text entries; tool/ask/compact cards live exclusively in live event state. Fixed by merging `get_messages` ground-truth text into the existing snapshot (preserving tool cards in-place) instead of replacing `state.messages` wholesale. `activeToolCards` indices are rebuilt after merge so in-flight `tool_execution_update` events continue landing correctly.
- Minimap cell stuck pulsating after tab switch — `streamingBubble` restored from snapshot was never cleared when `get_state` reported `isStreaming: false` (turn completed while away); `_applyRpcState` now retires the bubble and strips `streaming: true` entries from `state.messages` immediately, before `get_messages` arrives.
- Model picker empty / no models listed — `get_available_models` returns ~2 MiB (837 models), overflowing the RPC v1 1 MiB physical-frame cap and failing with `RPC response exceeded the transport limit`, leaving `state.models` empty. The bridge now negotiates protocol v2 (`negotiate_protocol`) in `_initFetch` before the large fetches and reassembles the resulting `rpc_chunk` sequence (base64 byte-segments → strict UTF-8 → JSON) in `handleLine`. Reassembly validates chunkId/index/count/byteLength, rejects interleaved or duplicate frames, and enforces the 64 MiB ceiling.
- Built `.app`/`.dmg` shows an empty model picker (and no working session) when launched from Finder/Dock/DMG, while `tauri dev` works — macOS hands a GUI-launched bundle a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew, so `Command::new("omp")` in `agent/spawn.rs` failed to resolve `/opt/homebrew/bin/omp`; the default session never spawned and `get_available_models` never ran. `spawn_omp` and the `rpc-ui` probe now override the child `PATH`, appending common install dirs (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`, `~/.local/bin`, `~/.cargo/bin`) after the inherited entries (de-duplicated, inherited PATH still wins).

## [0.1.2] - 2026-05-11

### Fixed

- macOS freeze (spinning beach ball + high CPU) when opening a project folder via the + button — `blocking_pick_folder` was called from a command-handler thread, deadlocking against the main RunLoop; switched to callback-based `pick_folder` with an async command and `spawn_blocking` channel bridge

## [0.1.1] - 2026-05-10

### Added

- `/login` command with OAuth provider picker (fetches providers via `get_login_providers` RPC)
- Ask tool rendered as inline chat bubble with `rpc-ui` mode support _(requires [can1357/oh-my-pi#994](https://github.com/can1357/oh-my-pi/pull/994) to be merged)_

### Performance

- Fixed 13×13 minimap grid (169 cells); oldest row of 13 messages evicted at turn boundary once the grid is full, keeping memory and render cost bounded in long sessions
- `React.memo` on all bubble components (UserBubble, AssistantBubble, ToolCard, AskBubble, CompactRow); only the live streaming tail re-renders per token — stable history bails out
- Stable `_id` stamped on every message object in `live.js`; bubbles keyed by `_id` instead of array index, eliminating remount/fade-in blink when the oldest row is evicted
- `useCallback` on `handleAnnotate` and `handleAskAnswer` in App to stabilize function-prop refs and preserve memo bailouts for AssistantBubble and AskBubble

## [0.1.0] - 2026-05-10

### Added

- Initial Tauri 2 shell: spawns `omp --mode rpc` per tab, no bundler, JSX transpiled in-browser via `@babel/standalone`
- GitHub Actions CI (cargo check + cargo test on win/linux/mac) and release pipeline
- Per-tab omp process isolation — one process per tab, preserved across switches via session snapshots
- Model picker as a separate bridge view with on-load fetch and refresh button
- Markdown rendering with syntax highlighting (marked v12 + highlight.js) in chat
- Plan mode: full intent → drafting → review → running → done lifecycle with inline block annotations
- Slash command palette with arrow-key navigation, fuzzy filter, and Enter execution
- `/new` command to start a fresh omp session in the current tab
- Steer: send a message to the agent mid-turn without waiting for completion
- Compact tool cards: full expand/collapse card showing live progress and final result
- Task/quick_task tool cards: collapsible subagent panel with live-stream view on row click
- Eval cell tool cards: stream code and output live; syntax highlight on completion
- Auto-scroll chat to bottom as the agent streams output
- Minimap: dense grid heatmap with chat-bubble cross-highlight and per-kind tooltips
- Long paste collapse into `[paste #N +K lines]` inline tokens in the composer
- macOS-style traffic light window controls on Windows (DWM frameless)
- Autosave toggle button in the status bar
- Font size slider in the tweaks panel (75–150%, step 5)
- Git branch chip in the title bar via `gix` + `notify`
- OMP icon pack v1 as app icons across all platforms
- MIT license

### Fixed

- Black screen on startup — disable Tauri CSP hash injection, remove Google Fonts CDN link
- Git HEAD watcher — watch `.git/` directory instead of `HEAD` file to survive atomic rename on Linux/macOS
- Window drag — replaced custom handler with `data-tauri-drag-region`
- Diff block overflow — contained within chat column width
- Composer textarea: single-line default via `field-sizing: content`; focus restored after send; textarea stays enabled during streaming for steer input
- Phantom textarea scrollbar hidden at min-height
- Window control symbols: always colored red/yellow/green, no hover background bleed
- Tweaks panel: persist settings to `localStorage`; retheme to use app CSS variables
- Token and context gauge percentages truncated to one decimal place
- Stream line accumulation — handle in-place growing lines without duplication
- ToolCard: remove duplicate `return` statement; expand individual subagent rows, not the card header
- Plan annotations always reaching the prompt; `sendFeedback` working with annotations and no body text
- Plan running→done state transition
- Message history preserved across tab switches
- Tab name retained from folder path when `omp sessionName` is absent
- `_handleResponse` in `live.js` — missing closing brace caused silent IIFE syntax error
- Thinking level values aligned to valid RPC set (`off | minimal | low | medium | high | xhigh`)
- Rust agent: race-safe sessions, lock-free per-session stdin writes, no orphan child processes on hot-reload

### Changed

- Project renamed from `omp-desktop` to `Oh My Pi Desktop`
- Split large files into focused modules: `agent.rs` → `agent/`, `app.jsx` → `app-live.jsx` + `src/app/`, monolithic CSS and chat/UI/tweaks components into dedicated directories
- Plan mode moved from a dedicated side panel into the chat timeline
