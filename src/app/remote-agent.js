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
 */
(function () {
  "use strict";
  // Load-time marker for diagnostics (and proof the guard below passed).
  if (!window.__TAURI__ || window.__TAURI__.__remoteShim) {
    window.__OMP_REMOTE_AGENT = { armed: false, reason: window.__TAURI__ ? "shim" : "no-tauri-yet" };
    return; // phone side: inert
  }
  window.__OMP_REMOTE_AGENT = { armed: true };

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
  ]);

  // name → { count, unlisten }; phoneId → Map(name → count)
  const active = new Map();
  const byPhone = new Map();

  function send(frame) {
    window.__OMP_REMOTE_AGENT.sent = (window.__OMP_REMOTE_AGENT.sent || 0) + 1;
    // The Rust command's parameter is `frame` — args must wrap it.
    invoke("remote_send", { frame }).catch((e) => {
      window.__OMP_REMOTE_AGENT.sendErrors = (window.__OMP_REMOTE_AGENT.sendErrors || 0) + 1;
      console.warn("[remote-agent] send:", e);
    });
  }

  function respond(id, ok, valueOrError) {
    const frame = { t: "res", id, ok };
    if (ok) frame.value = valueOrError ?? null;
    else frame.error = String(valueOrError);
    send(frame);
  }

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

  function addSub(phoneId, name) {
    if (typeof name !== "string" || name.length > 200) return;
    let perPhone = byPhone.get(phoneId);
    if (!perPhone) { perPhone = new Map(); byPhone.set(phoneId, perPhone); }
    perPhone.set(name, (perPhone.get(name) || 0) + 1);

    if (active.has(name)) { active.get(name).count++; return; }
    // Tauri's listen resolves with the unlisten fn; stash it once ready.
    const entry = { count: 1, unlisten: null };
    active.set(name, entry);
    listenTauri(name, (ev) => {
      if (name.startsWith("agent://line/") && !forwardableLine(ev.payload)) return;
      send({ t: "evt", name, payload: ev.payload ?? null });
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
      if (name === "sub") { addSub(phoneId, args && args.name); respond(id, true, null); return; }
      if (name === "unsub") { delSub(phoneId, args && args.name); respond(id, true, null); return; }
      if (UNSUPPORTED.has(name)) { respond(id, false, `${name} is unsupported on remote`); return; }

      // `js:*` — answers that live in this webview, not in Rust (the live
      // tab list above all; the phone's boot attaches to these ids).
      if (typeof name === "string" && name.startsWith("js:")) {
        const h = jsHandlers?.[name.slice(3)];
        if (!h) { respond(id, false, `unknown js handler ${name}`); return; }
        respond(id, true, (await h(args || {})) ?? null);
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
        respond(id, true, null);
        return;
      }
      if (name === "close_all_tabs" && jsHandlers) {
        await jsHandlers.closeAllTabs();
        respond(id, true, null);
        return;
      }
      // Opening a folder on the phone: the native dialog (`open_project`)
      // is UNSUPPORTED there, so the phone sends the path it picked from
      // its own sheet and the desktop opens it exactly as its own
      // "open folder…" would. The answer carries the new tab's id: the
      // phone's sheet closes on it and reports on its absence.
      if (name === "open_project_at" && jsHandlers) {
        const opened = await jsHandlers.openProjectAt(args?.path ?? args);
        respond(id, true, opened ?? null);
        return;
      }

      const value = await invoke(name, args || {});
      respond(id, true, value === undefined ? null : value);
    } catch (e) {
      respond(id, false, (e && e.message) || String(e));
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
    else if (f.t === "pair_request") {
      // The pair-approval dialog (design/remote-pair-dialog.jsx) answers.
      window.dispatchEvent(new CustomEvent("remote-pair-request", { detail: f }));
    } else {
      window.dispatchEvent(new CustomEvent("remote-control", { detail: f }));
    }
  });

  // Connector status (connecting/online/reconnecting/…) for the Settings UI.
  listenTauri("remote://status", (ev) => {
    window.dispatchEvent(new CustomEvent("remote-status", { detail: ev.payload || null }));
  });
})();
