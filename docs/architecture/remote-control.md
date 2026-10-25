# Remote control (phone ↔ desktop)

Control a running omp-desktop from a phone browser. The agents, the
filesystem and every approval stay on the workstation; the phone is a
second window onto the same app (the Claude Code Remote Control model,
self-hosted).

Three components:

- **relay** (`relay/`) — a single Rust binary on the user's server: TLS
  static hosting of `src/`, WebSocket rooms, pairing, nothing else. It
  never parses a payload.
- **desktop connector** (`src-tauri/src/remote/`) — outbound WSS only,
  no inbound ports. It announces its `device_info` display identity on
  every connect (the Settings → Remote device name, hostname fallback).
  It does NOT route commands itself: a phone frame is
  `app.emit`'d into the desktop's own webview, where
  `src/app/remote-agent.js` executes it through the same `OMP_BRIDGE` /
  `__TAURI__.core.invoke` the local UI uses, and returns the result via
  a `remote_respond` command. The webview is the executor, so the phone
  sees exactly the desktop's sessions and there is no parallel command
  table to keep in sync. Events flow the same way in reverse: the shim
  sends `sub`/`unsub` frames as its `listen` registry changes, the
  remote agent refcounts Tauri listeners per event name and forwards
  matching events back (`remote_emit`). OS-only commands (native
  pickers, window chrome, updater install) answer a typed
  `unsupported on remote` error.
- **shim** (`src/app/remote-transport.js`) — when `window.__TAURI__` is
  absent (plain browser), implements `core.invoke` and `event.listen`
  over the room socket, so `live.js` and every component run unchanged.

## Rooms

One room per desktop, keyed by the desktop's persistent random
`device_id`. One desktop connection per room (a second one replaces the
first); any number of phone connections. Several desktops can share one
relay (one room each), and a phone may hold pairings for any number of
them, controlling exactly one at a time. The multi-device registry and
picker live entirely on the phone (`app/remote-devices.js`,
`app/remote-hub.js`), so the relay needs no account concept: every socket
still authenticates with one room's credentials, and each desktop still
approves its own pairings.

## Wire protocol (all JSON text frames)

Client → relay → desktop:

```json
{ "t": "cmd", "id": 42, "name": "send_command", "args": { … } }
```

Desktop → relay → phones:

```json
{ "t": "res", "id": 42, "ok": true, "value": …, "from": "<phone-conn-id>" }
{ "t": "evt", "name": "agent://line/<sid>", "payload": … }
{ "t": "hello", "v": 1, "caps": ["gz", "transcript-window", "ask-sync"] }
```

Command names and payload shapes are exactly the Tauri command surface
the webview already uses; the shim makes `invoke(name, args)` a `cmd`
frame and a `listen(name, cb)` subscription a filter on `evt` frames.
The relay validates the envelope shape (`t`, and per-type fields) and
forwards the frame verbatim.

Three refinements on top of that verbatim rule:

- **`res` unicast**: the desktop's `respond` fills the res frame's `from`
  with the triggering cmd frame's `from` (the relay stamps every phone
  frame with its connection id). The relay sends a `res` with a live
  `from` to that phone only — two phones in one room share the id space
  (each counts from 0), so a broadcast `res` would answer B with A's
  data. No `from` (a legacy desktop) or a gone phone falls back to
  broadcast. `evt` frames stay broadcast.
- **`hello` caps handshake**: the relay greets every connected client
  with its own `hello` (`caps`: `res-unicast`, `transcript-window`,
  `hello`), and the desktop broadcasts its `hello` on connect and on
  every `peer phone:true` (a joining phone). The phone shim records the
  caps (`__TAURI__.__remoteCaps`); a `{gz: …}` payload it cannot decode
  rejects the pending invoke (`unsupported frame encoding`) instead of
  resolving a garbage object. Unknown caps are ignored — that is the
  extension point.
- **Streaming coalescing**: the desktop's remote-agent holds a
  `message_update` event frame for up to 100 ms per session and forwards
  only the newest one (each carries the full accumulated text);
  `message_end` / `agent_end` / `turn_end` and any non-update frame
  flush a pending update first, then go themselves. A handset uplink
  would otherwise see 10–30 full-text frames a second, and the relay's
  256-frame outbox would kill the connection mid-turn.

Room control frames (relay ↔ one client, never forwarded):

```json
{ "t": "pair_begin" }                              // desktop → relay
{ "t": "pair_code", "code": "ABCD-1234", "url": "https://host/p#…" }
{ "t": "pair_request", "pair_id": "…", "agent": "iPhone …" }   // → desktop
{ "t": "pair_grant", "pair_id": "…" }              // desktop approves
{ "t": "paired", "device": "<id>", "token": "<phone-token>" }  // → phone
{ "t": "peer", "desktop": true }                   // room presence, → phones
{ "t": "device_info", "name": "My PC", "os": "windows" }  // desktop → relay
{ "t": "device", "name": "My PC", "os": "windows" }       // relay → phones
```

`device_info` is the desktop's display identity for the phone's device
picker: the connector sends it on every connect (and `remote_set_name`
pushes one live on a rename). The relay truncates both fields to 80
chars, persists them in `relay-state.json` (`DeviceState.info`),
forwards a `device` frame to the room's phones, and greets every joining
phone with the stored `device` frame plus a `peer` frame carrying the
room's *current* desktop presence — a phone that attaches between the
desktop's join and leave broadcasts would otherwise stay blind until a
command failed.

## Connecting

- Desktop: `wss://host/ws?role=desktop&device=<id>&token=<device-token>`.
  The device token is provisioned once (Settings → Remote) and stored in
  `remote.json` on the desktop and in `relay-config.json` on the server.
  Each desktop on the relay needs its own `relay-config.json` entry.
- Phone, first time: opens the pairing URL (`/p#<pair-token>`; the token
  never appears in logs or the URL line). The page connects
  `wss://host/ws?role=phone&pair=<pair-token>`; the relay asks the
  desktop, which shows an approve/deny dialog; on grant the relay
  returns a long-lived phone token and the phone reconnects with
  `wss://host/ws?role=phone&device=<id>&token=<phone-token>`. The
  credential lives in the phone's device registry (below), one entry per
  paired desktop.
- Relay state (`relay-state.json`, atomic writes): room →
  `{ device_token_hash, phones: { token_hash: { name, paired_at } },
  info: { name, os } }`.
  Pair tokens are single-use, in-memory only, 5-minute expiry.
- Revoking a phone deletes its hash; live connections are dropped.

## Multiple desktops (the phone's device picker)

One phone, many desktops on the same relay. All list logic is the pure
`app/remote-devices.js` module; `app/remote-hub.js` is the DOM/socket
glue; both load before `remote-transport.js`.

- **Registry** — localStorage `omp-remote:devices`:
  `{ devices: [{ device, token, name, os, lastUsed }], selected }`.
  The pre-multi-device single-pairing key (`omp-remote:auth`) migrates
  in place on first load (the one desktop stays selected). A `paired`
  frame appends (re-pairing a known desktop swaps its token and keeps
  name/selection); `device` frames keep `name`/`os` fresh; forgetting a
  pairing is local-only (the desktop's revoke stays the server-side
  kill).
- **Picker (hub)** — shown at boot when nothing is selected, and on
  demand from the topbar device chip or the offline overlay's
  "switch device" action. While open, it holds one *presence* WebSocket
  per listed device — the ordinary `role=phone` auth path, no new relay
  surface — and renders each room's live status from the join greet and
  subsequent `peer` frames. Sockets close with the hub; they are a
  status light, never a retry loop.
- **Choosing a device** persists `selected` + `lastUsed` and performs a
  deliberate `location.reload()`: every piece of app state (bridge,
  tabs, transcripts) belongs to the previous desktop. This is the one
  reload in the phone flow — drops still reconnect in place (below).
  Boot with a selection connects that room directly, so the common
  single-desktop (or returning) case never sees the picker.
- The control connection (`remote-transport.js`) always drives exactly
  the selected device's room; `invoke` rejects `not paired` while no
  device is selected.

## Desktop reconnect

The connector retries with capped exponential backoff (1s → 30s) and a
heartbeat ping every 25s. Phones in the room get `peer` frames on
desktop join/leave and render an offline badge; commands sent while
offline fail fast with a typed error. The phone's full-screen offline
overlay carries a "switch device" action opening the picker, so a
sleeping desktop doesn't strand the phone when another is online.

## Phone reconnect (in place, never a reload)

The phone's socket lives on the open internet (NAT idle drops, radio
handoffs, backgrounded-tab timer suspension), so drops are routine. The
shim reconnects **without reloading the page**: a non-blocking banner
announces the drop, the socket reopens with capped backoff
(1s → 15s), and on re-open the shim

1. flushes the bounded send queue (500 frames), skipping `sub` frames
   and invoke frames whose promise already timed out while queued —
   running those now would double-execute a prompt the user was told
   had failed;
2. replays one `sub` per live listener name (the relay cleared them
   with the old connection);
3. calls `OMP_BRIDGE._remoteResync()`, which re-sends `_initFetch`
   (`get_state` + `get_messages`): completed messages missed during the
   gap merge in by `ts`, streaming resumes from live events.

The mirror case: the *desktop's* app restarts while the phone's socket
never dropped. The phone's subscriptions lived in the desktop webview's
remote-agent, so they died with it. The `peer desktop:true` frame that
announces the return therefore runs the same subscription replay before
`_remoteResync()` — without it the phone looks online, answers commands,
and never streams again.

A first connect that fails (relay down, no network) enters the same
capped backoff with an "auto-retrying" overlay and a retry-now button —
it used to be a dead end that only a page reload escaped.

## Windowed transcripts and projected replays

A handset's uplink is the relay's narrowest pipe, so nothing large rides
it raw. `get_messages` on a phone never reaches omp: the desktop reads
ONE window straight from the tab's session file
(`remote_transcript_window`, `src-tauri/src/remote_transcript.rs` —
byte-offset scan, tail seek, 4000-char block caps, 300 KB wire budget)
and the chat view's "load older messages…" row pages up by cursor
(`state.windowed` / `state.windowCursor`, `transcript-window.js` holds
the cursor math). The journal replay follows the same rule: the phone's
`replay_events` goes to `remote_replay_events`, which projects the ring
(drops `rpc_chunk` envelopes, caps at the newest 400, marks `dropped`
when the cap cut — the windowed `get_messages` below recovers whatever
the projection shed). Reply values over 32 KB ride gzipped
(`{gz: base64}`, inflated by the shim's `decodeValue`); the relay stays
an opaque forwarder throughout.

## Pending approvals survive a phone attach

A tool approval / ask dialog exists only as a one-shot event — omp's
`get_state` has no pending-request field — so a phone that attaches (or
reloads) after one fired would never see it: the desktop stays blocked,
the phone looks idle. The desktop answers `js:get_pending_asks` with the
tab's unanswered ask bubbles (live state for the active tab, the tab
snapshot otherwise, plus the not-yet-flushed buffer); the phone merges
the ones it missed after every `activateSession` and `_remoteResync`
(`_mergeRemotePendingAsks`, dedupe by request id — ask bubbles carry no
`ts`, so the get_messages merge keeps them). Answering on the phone is
the normal RPC path; answering on the desktop reaches the phone as the
usual resolve event.

### Settle echo (both directions)

omp broadcasts no request-resolved event, so an ask bubble settles only
on the client that answered it. To keep the peer's copy from hanging
"unanswered", `_resolveAsk` echoes every settle: a phone calls
`js:settle_ask` (the desktop patches its live messages or the tab
snapshot, whitelisted keys `answered/answer/answers/cancelled`, and
never re-sends to omp — the phone already did), and the desktop
broadcasts an `ask-settled` evt frame the phones' `_attachRemoteTabs`
listener applies the same way. Crossed answers are no-ops via the
re-answer guard on both sides.

`visibilitychange` (visible) and `pageshow` (persisted) trigger an
immediate reconnect attempt instead of waiting out the backoff — phone
browsers suspend timers while backgrounded, so the socket is usually
already dead on wake. A `peer desktop:true` frame after a desktop
outage also triggers `_remoteResync()`.

## Security

- TLS everywhere (relay does rustls itself or sits behind Caddy/nginx).
- The relay authenticates both roles at the WS handshake and only ever
  joins clients that present credentials for the same room.
- Tokens are 256-bit random, stored hashed (SHA-256) on both sides;
  the pairing code is the only secret that ever travels in a URL, and it
  is single-use with a short TTL.
- **E2E encryption** (protocol v2, `docs/architecture/remote-e2e-contract.md`
  is the normative contract): pairing exchanges ephemeral X25519 keys
  through the relay (`pair_hello`/`pair_grant` pk fields) and both sides
  derive a master secret the relay never sees. Every connection then runs
  an `hs` handshake (fresh ephemeral X25519 + HMAC under the MS) for
  forward secrecy, and all business frames (`cmd`/`res`/`evt`) ride as
  `enc` envelopes — AES-256-GCM, per-direction keys, seq-counter nonces,
  strictly increasing seq (replay refusal). The relay routes envelopes
  (`to`/`from`, room) but content is opaque to it. v2 is a hard cutover:
  a plaintext `cmd` is rejected with a typed error, and a pairing without
  key material is asked to re-pair — no plaintext fallback.
- Residual, documented: the pairing moment still trusts the relay (it
  mints the pair token), so an *actively* malicious relay could MITM the
  pairing key exchange inside the 5-minute pairing window. After pairing,
  passive inspection and later compromise of the relay expose only
  envelope metadata (type, seq, timing, size).

## What the phone UI is

The same `src/` the webview loads, plus the shim, plus
`src/design/layout/mobile.css` (below 768px: rail/sidebar collapse into
a drawer, git browser and terminal stay available but full-screen,
composer touch targets grow). `index.html` loads the shim before
`live.js`; under Tauri it detects `window.__TAURI__` and does nothing.
Window chrome, the updater and OS-only commands (folder pickers) answer
a typed `unsupported on remote` error the UI hides behind the
`remote-shim` root class. The mobile topbar's device chip
(`design/remote-device-chip.jsx`) names the controlled desktop and opens
the picker; it renders only when the hub module is live (phone).
