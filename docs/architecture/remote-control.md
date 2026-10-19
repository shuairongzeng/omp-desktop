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
  no inbound ports. It does NOT route commands itself: a phone frame is
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
first); any number of phone connections.

## Wire protocol (all JSON text frames)

Client → relay → desktop:

```json
{ "t": "cmd", "id": 42, "name": "send_command", "args": { … } }
```

Desktop → relay → all phones:

```json
{ "t": "res", "id": 42, "ok": true, "value": … }        // ok:false → "error": "…"
{ "t": "evt", "name": "agent://line/<sid>", "payload": … }
```

Command names and payload shapes are exactly the Tauri command surface
the webview already uses; the shim makes `invoke(name, args)` a `cmd`
frame and a `listen(name, cb)` subscription a filter on `evt` frames.
The relay validates the envelope shape (`t`, and per-type fields) and
forwards the frame verbatim.

Room control frames (relay ↔ one client, never forwarded):

```json
{ "t": "pair_begin" }                              // desktop → relay
{ "t": "pair_code", "code": "ABCD-1234", "url": "https://host/p#…" }
{ "t": "pair_request", "pair_id": "…", "agent": "iPhone …" }   // → desktop
{ "t": "pair_grant", "pair_id": "…" }              // desktop approves
{ "t": "paired", "device": "<id>", "token": "<phone-token>" }  // → phone
{ "t": "peer", "desktop": true }                   // room presence, → phones
```

## Connecting

- Desktop: `wss://host/ws?role=desktop&device=<id>&token=<device-token>`.
  The device token is provisioned once (Settings → Remote) and stored in
  `remote.json` on the desktop and in `relay-config.json` on the server.
- Phone, first time: opens the pairing URL (`/p#<pair-token>`; the token
  never appears in logs or the URL line). The page connects
  `wss://host/ws?role=phone&pair=<pair-token>`; the relay asks the
  desktop, which shows an approve/deny dialog; on grant the relay
  returns a long-lived phone token and the phone reconnects with
  `wss://host/ws?role=phone&device=<id>&token=<phone-token>` stored in
  localStorage.
- Relay state (`relay-state.json`, atomic writes): room →
  `{ device_token_hash, phones: { token_hash: { name, paired_at } } }`.
  Pair tokens are single-use, in-memory only, 5-minute expiry.
- Revoking a phone deletes its hash; live connections are dropped.

## Desktop reconnect

The connector retries with capped exponential backoff (1s → 30s) and a
heartbeat ping every 25s. Phones in the room get `peer` frames on
desktop join/leave and render an offline badge; commands sent while
offline fail fast with a typed error.

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
- Content is visible to the relay (it is the user's own server); E2E
  encryption is a documented future step, not v1.

## What the phone UI is

The same `src/` the webview loads, plus the shim, plus
`src/design/layout/mobile.css` (below 768px: rail/sidebar collapse into
a drawer, git browser and terminal stay available but full-screen,
composer touch targets grow). `index.html` loads the shim before
`live.js`; under Tauri it detects `window.__TAURI__` and does nothing.
Window chrome, the updater and OS-only commands (folder pickers) answer
a typed `unsupported on remote` error the UI hides behind the
`remote-shim` root class.
