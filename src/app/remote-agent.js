/* remote-agent.js — the desktop webview side of remote control
 * (docs/architecture/remote-control.md). Always loaded; inert until the
 * connector (`src-tauri/src/remote/`) delivers a phone frame, which only
 * happens while the user enabled remote access.
 *
 * The webview is the executor: a phone's `cmd` runs through the very same
 * `__TAURI__.core.invoke` the local UI uses, so the phone sees exactly the
 * desktop's sessions and there is no parallel command surface. Event
 * subscriptions are refcounted per phone connection (the relay tags frames
 * with `from` and reports phone join/leave via `peer`), so a disconnecting
 * phone's listeners are torn down.
 *
 * Protocol: replies are unicast. The relay tags every phone cmd with the
 * sending connection's id (`from`); `respond` copies that id into the res
 * frame's top level, and the relay routes the reply back to that phone
 * alone (broadcast only for a legacy/absent `from`). The agent also
 * broadcasts a `hello` frame announcing its caps when it comes online and
 * whenever a new phone joins, so handsets can discover `gz` support before
 * a large reply lands.
 */
(function () {
  "use strict";
  // Load-time marker for diagnostics (and proof the guard below passed).
  if (!window.__TAURI__ || window.__TAURI__.__remoteShim) {
    window.__OMP_REMOTE_AGENT = { armed: false, reason: window.__TAURI__ ? "shim" : "no-tauri-yet" };
    return; // phone side: inert
  }
  // The desktop's advertised caps (the `hello` frame's `caps` array): `gz`
  // = replies over the size threshold ride as `{gz: base64}`; `ask-sync`
  // = a reconnecting phone can re-pull its pending asks.
  const DESKTOP_CAPS = ["gz", "transcript-window", "ask-sync"];
  window.__OMP_REMOTE_AGENT = { armed: true, HELLO_CAPS: DESKTOP_CAPS };

  // No aliasing: Tauri's event/core methods are called on their objects —
  // an unbound alias (`const f = __TAURI__.event.listen`) silently loses
  // the receiver and the listener never registers.
  const invoke = (...a) => window.__TAURI__.core.invoke(...a);
  const listenTauri = (...a) => window.__TAURI__.event.listen(...a);

  // Desktop-only commands — a phone must not pop native dialogs on the PC,
  // touch the updater, or drive the connector itself. The shim blocks these
  // too; this list is the defense in depth for a hand-rolled WS client.
  const UNSUPPORTED = new Set([
    "open_project", "pick_background_image", "terminal_pick_shell",
    "browser_pick_path", "open_url_external", "app_update_install",
    "app_update_check", "copied_file_paths", "set_close_guard",
    "take_pending_open_projects",
    "remote_get_state", "remote_configure", "remote_regenerate_token", "remote_send",
    "remote_set_name",
  ]);

  // name → { count, unlisten }; phoneId → Map(name → count)
  const active = new Map();
  const byPhone = new Map();
  // sessionId → Channel: the open browser panel's screencast channel. The
  // phone cannot receive Rust's frames itself (its shim has no Channel),
  // so this webview opens the panel with its own and re-emits the frames.
  const panelChannels = new Map();

  function send(frame) {
    window.__OMP_REMOTE_AGENT.sent = (window.__OMP_REMOTE_AGENT.sent || 0) + 1;
    // The Rust command's parameter is `frame` — args must wrap it.
    invoke("remote_send", { frame }).catch((e) => {
      window.__OMP_REMOTE_AGENT.sendErrors = (window.__OMP_REMOTE_AGENT.sendErrors || 0) + 1;
      console.warn("[remote-agent] send:", e);
    });
  }

  // Reply values above this are gzipped into `{gz: base64}` (the handset
  // inflates with DecompressionStream): a 280 KB window frame crosses a
  // 3 Mbit/s uplink as ~60 KB. Small values ride verbatim — the codec
  // would cost more than it saves.
  const GZIP_MIN_BYTES = 32 * 1024;
  async function encodeValue(value) {
    const json = JSON.stringify(value ?? null);
    if (json.length <= GZIP_MIN_BYTES) return value;
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return { gz: btoa(bin) };
    } catch (e) {
      console.warn("[remote-agent] gzip failed, sending raw:", e);
      return value;
    }
  }

  async function respond(id, ok, valueOrError, from) {
    const frame = { t: "res", id, ok };
    // Unicast: echo the triggering cmd's `from` (the phone's connection
    // id) so the relay routes this reply to that phone alone.
    if (typeof from === "string" && from) frame.from = from;
    if (ok) frame.value = await encodeValue(valueOrError);
    else frame.error = String(valueOrError);
    send(frame);
  }

  // The desktop's hello broadcast: sent when the agent detects the desktop
  // connection is live and again whenever a new phone joins the room, so
  // late-joining handsets learn the caps they were not there for.
  function broadcastHello() {
    window.__OMP_REMOTE_AGENT.hellos = (window.__OMP_REMOTE_AGENT.hellos || 0) + 1;
    send({ t: "hello", v: 1, caps: DESKTOP_CAPS });
  }
  let desktopOnline = false;

  /** Whether one stdout line is worth a phone's wire. The desktop's own
   *  large fetches ride the same `agent://line/{id}` channel the phone
   *  subscribes to: their rpc_chunk frames are tens of MB the handset
   *  neither asked for nor can afford, and the phone's own large replies
   *  travel as WS `res` frames now (`remote_transcript_window`) — so chunk
   *  frames never need the wire. Everything else (events, single-frame
   *  responses the phone correlates) passes. */
  function forwardableLine(payload) {
    const text = payload?.text;
    if (typeof text !== "string") return true;
    let obj;
    try { obj = JSON.parse(text); } catch { return true; }
    return !(obj && typeof obj === "object" && obj.type === "rpc_chunk");
  }

  // ── streaming-update coalescing (per session, 100 ms trailing edge) ──
  // A phone's WAN radio wakes once per ~100 ms; the phone-side apply is
  // idempotent full-state (the frame with the LATEST text wins), so the
  // intermediate message_update frames between two wakes are pure wire
  // cost. Each session's latest update rides a timer; any terminal frame
  // (message_end / agent_end / turn_end) or non-update line flushes the
  // pending update FIRST and then itself, preserving order and no-loss
  // for everything that is not an update.
  const COALESCE_MS = 100;
  const updateTimers = new Map(); // session id (the line channel suffix) → timer
  const updatePending = new Map(); // session id → { seq, text } — the newest envelope

  /** The session a coalesced line belongs to: the `agent://line/{id}`
   *  channel's id, or null for anything else. */
  function lineSession(name) {
    return typeof name === "string" ? /^agent:\/\/line\/(.+)$/.exec(name)?.[1] ?? null : null;
  }

  /** The parsed frame's type, or null for a non-JSON / non-object line
   *  (already filtered by forwardableLine, but a parse here is cheap and
   *  this is also the gate that never throws on odd input). */
  function lineType(payload) {
    const text = payload?.text;
    if (typeof text !== "string") return null;
    try {
      const obj = JSON.parse(text);
      return obj && typeof obj === "object" && typeof obj.type === "string" ? obj.type : null;
    } catch { return null; }
  }

  function sendLine(name, payload) {
    send({ t: "evt", name, payload: payload ?? null });
  }

  /** Drop a session's armed coalesce timer and its pending update (the
   *  listener is going away — the phone unsubscribed or dropped). */
  function clearSession(id) {
    const timer = updateTimers.get(id);
    if (timer !== undefined) { clearTimeout(timer); updateTimers.delete(id); }
    updatePending.delete(id);
  }

  /** Push one line out: an `update` type is coalesced per its session
   *  (pending flush first when a new update arms a NEW timer — the
   *  pending older frame is superseded), anything else flushes that
   *  session's pending update and rides immediately. */
  function forwardLine(name, payload) {
    const id = lineSession(name);
    if (id === null) { sendLine(name, payload); return; }
    if (lineType(payload) === "message_update") {
      // Supersede: a new update replaces the pending one in place — the
      // phone's apply is last-writer-wins, and this IS the latest frame.
      if (updatePending.has(id) && updateTimers.has(id)) {
        updatePending.set(id, payload);
        return;
      }
      updatePending.set(id, payload);
      updateTimers.set(id, setTimeout(() => {
        updateTimers.delete(id);
        const pending = updatePending.get(id);
        updatePending.delete(id);
        if (pending) sendLine(name, pending);
      }, COALESCE_MS));
      return;
    }
    // A non-update frame rides now, but never ahead of the pending
    // update of the same session: flush it first, then this frame.
    const timer = updateTimers.get(id);
    if (timer !== undefined) { clearTimeout(timer); updateTimers.delete(id); }
    const pending = updatePending.get(id);
    if (pending) {
      updatePending.delete(id);
      sendLine(name, pending);
    }
    sendLine(name, payload);
  }

  function addSub(phoneId, name) {
    if (typeof name !== "string" || name.length > 200) return;
    // Screencast frames never ride Tauri events: the desktop pushes them
    // straight from the open panel's own Channel (`browser_open_panel`
    // below), so a listener here would never fire. `delSub` is already
    // inert for a name it has not counted, so an unsub stays harmless.
    if (name.startsWith("browser://frame/")) return;
    let perPhone = byPhone.get(phoneId);
    if (!perPhone) { perPhone = new Map(); byPhone.set(phoneId, perPhone); }
    perPhone.set(name, (perPhone.get(name) || 0) + 1);

    if (active.has(name)) { active.get(name).count++; return; }
    // Tauri's listen resolves with the unlisten fn; stash it once ready.
    const entry = { count: 1, unlisten: null };
    active.set(name, entry);
    listenTauri(name, (ev) => {
      if (name.startsWith("agent://line/") && !forwardableLine(ev.payload)) return;
      forwardLine(name, ev.payload);
    }).then((un) => {
      if (active.get(name) === entry) entry.unlisten = un;
      else un(); // unsubscribed while the listener was registering
    }).catch(() => active.delete(name));
  }

  function delSub(phoneId, name) {
    // Only a phone that actually holds the name may release it — a stale
    // or ghost unsub must not count down another phone's listener.
    const perPhone = byPhone.get(phoneId);
    if (!perPhone || !perPhone.has(name)) return;
    const n = perPhone.get(name) - 1;
    if (n > 0) perPhone.set(name, n);
    else perPhone.delete(name);
    if (perPhone.size === 0) byPhone.delete(phoneId);
    const entry = active.get(name);
    if (!entry) return;
    if (--entry.count <= 0) {
      active.delete(name);
      if (entry.unlisten) entry.unlisten();
      const id = lineSession(name);
      if (id !== null) clearSession(id);
    }
  }

  function dropPhone(phoneId) {
    const perPhone = byPhone.get(phoneId);
    if (!perPhone) return;
    for (const name of [...perPhone.keys()]) {
      while (perPhone.has(name)) delSub(phoneId, name);
    }
  }

  async function handleCmd(frame) {
    const { id, name, args } = frame;
    const phoneId = typeof frame.from === "string" ? frame.from : "?";
    const jsHandlers = window.OMP_BRIDGE?._remoteHandlers;
    try {
      if (name === "sub") { addSub(phoneId, args && args.name); respond(id, true, null, frame.from); return; }
      if (name === "unsub") { delSub(phoneId, args && args.name); respond(id, true, null, frame.from); return; }
      if (UNSUPPORTED.has(name)) { respond(id, false, `${name} is unsupported on remote`, frame.from); return; }

      // `js:*` — answers that live in this webview, not in Rust (the live
      // tab list above all; the phone's boot attaches to these ids).
      if (typeof name === "string" && name.startsWith("js:")) {
        const h = jsHandlers?.[name.slice(3)];
        if (!h) { respond(id, false, `unknown js handler ${name}`, frame.from); return; }
        respond(id, true, (await h(args || {})) ?? null, frame.from);
        return;
      }

      // A phone-created tab must appear on the desktop too: mirror it into
      // the desktop registry before the Rust spawn runs. The Rust command's
      // parameter is itself named `args`, so the wire frame nests one level
      // deeper than other commands: args.args.{sessionId, cwd, …}.
      if (name === "start_session" && jsHandlers) {
        const a = args?.args ?? args;
        if (a?.sessionId) {
          jsHandlers.registerTab({
            id: a.sessionId,
            cwd: a.cwd,
            name: null,
            profile: a.profile,
            resume: a.resume,
          });
        }
      }
      // Phone-initiated closes take the desktop's own close path (omp,
      // browser, terminal, git watch all end together), not a bare
      // `close_tab` invoke.
      if (name === "close_tab" && jsHandlers) {
        await jsHandlers.closeTab(args?.sessionId ?? args?.session_id);
        respond(id, true, null, frame.from);
        return;
      }
      if (name === "close_all_tabs" && jsHandlers) {
        await jsHandlers.closeAllTabs();
        respond(id, true, null, frame.from);
        return;
      }
      // Opening a folder on the phone: the native dialog (`open_project`)
      // is UNSUPPORTED there, so the phone sends the path it picked from
      // its own sheet and the desktop opens it exactly as its own
      // "open folder…" would. The answer carries the new tab's id: the
      // phone's sheet closes on it and reports on its absence.
      if (name === "open_project_at" && jsHandlers) {
        const opened = await jsHandlers.openProjectAt(args?.path ?? args);
        respond(id, true, opened ?? null, frame.from);
        return;
      }
      // The journal replay is the phone's disconnect-gap catch-up: the raw
      // form carries every chunked stdout frame of a busy tab (hundreds of
      // KB) the handset never reassembles, so the desktop projects it
      // (`remote_replay_events`) before it touches the wire.
      if (name === "replay_events" && jsHandlers) {
        const replay = await jsHandlers.remoteReplay(args || {});
        respond(id, true, replay, frame.from);
        return;
      }

      // The phone's browser panel calls `browser_open_panel` with a Tauri
      // Channel, but nothing on the handset can receive Rust's frames: the
      // Rust side pushes them into the Channel it was handed, which lives
      // in THIS webview. So the phone sends a placeholder (`events`), we
      // open the panel with a real Channel, and re-emit every frame as a
      // room event the phone shim feeds back into its stand-in Channel.
      if (name === "browser_open_panel") {
        const sid = args?.sessionId;
        const ch = new window.__TAURI__.core.Channel();
        ch.onmessage = (msg) => {
          // Liveness guard: a closed (or replaced) panel's channel must
          // not keep pushing frames into the room.
          if (panelChannels.get(sid) !== ch) return;
          // Screencast frames ride the Channel as Raw binary (an
          // ArrayBuffer) — JSON.stringify would flatten one to {}. Base64
          // keeps the bytes intact across the room; the phone shim decodes
          // them back into an ArrayBuffer for the screen.
          let payload = msg ?? null;
          if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
            const bytes = ArrayBuffer.isView(msg) ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength) : new Uint8Array(msg);
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            payload = { bin: btoa(bin) };
          }
          send({ t: "evt", name: `browser://frame/${sid}`, payload });
        };
        panelChannels.set(sid, ch);
        try {
          const value = await invoke("browser_open_panel", { ...args, events: ch });
          respond(id, true, value === undefined ? null : value, frame.from);
        } catch (e) {
          panelChannels.delete(sid);
          respond(id, false, (e && e.message) || String(e), frame.from);
        }
        return;
      }
      // Closing drops the mapping; the channel's onmessage guard above then
      // makes any in-flight frame from the dead panel a no-op.
      if (name === "browser_close_panel") {
        panelChannels.delete(args?.sessionId);
        const value = await invoke("browser_close_panel", args || {});
        respond(id, true, value === undefined ? null : value, frame.from);
        return;
      }

      const value = await invoke(name, args || {});
      respond(id, true, value === undefined ? null : value, frame.from);
    } catch (e) {
      respond(id, false, (e && e.message) || String(e), frame.from);
    }
  }

  listenTauri("remote://phone", (ev) => {
    window.__OMP_REMOTE_AGENT.frames = (window.__OMP_REMOTE_AGENT.frames || 0) + 1;
    const f = ev.payload;
    if (f && f.t === "cmd") handleCmd(f);
  });
  listenTauri("remote://control", (ev) => {
    const f = ev.payload;
    if (!f) return;
    if (f.t === "peer" && f.phone && f.online === false) dropPhone(f.phone);
    else if (f.t === "peer" && f.phone && f.online === true) broadcastHello(); // a new handset joined the room
    else if (f.t === "pair_request") {
      // The pair-approval dialog (design/remote-pair-dialog.jsx) answers.
      window.dispatchEvent(new CustomEvent("remote-pair-request", { detail: f }));
    } else {
      window.dispatchEvent(new CustomEvent("remote-control", { detail: f }));
    }
  });

  // Connector status (connecting/online/reconnecting/…) for the Settings UI.
  listenTauri("remote://status", (ev) => {
    // Connector state (connecting/online/reconnecting/off): "online" is
    // the moment the room can hear the desktop — announce its hello then
    // (once), and remember leaving it so a reconnect re-announces.
    const f = ev.payload;
    if (f && typeof f.status === "string") {
      if (f.status === "online") {
        if (!desktopOnline) { desktopOnline = true; broadcastHello(); }
      } else {
        // Any other state (connecting/reconnecting/off) means the room
        // cannot hear the desktop right now: disarm, so the next "online"
        // re-announces (a desktop restart must reach late phones too).
        desktopOnline = false;
      }
    }
    window.dispatchEvent(new CustomEvent("remote-status", { detail: f || null }));
  });
})();
