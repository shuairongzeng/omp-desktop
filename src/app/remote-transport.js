/* remote-transport.js — the phone side of remote control
 * (docs/architecture/remote-control.md, R8 E2E per
 * docs/architecture/remote-e2e-contract.md). When the app is served by
 * the relay to a plain browser there is no Tauri runtime; this shim
 * provides the `window.__TAURI__` surface over the room WebSocket, so
 * live.js and every component run unchanged. Loaded before live.js;
 * under the real desktop webview it detects `__TAURI__` and does
 * nothing.
 *
 * The phone may be paired with several desktops (remote-devices.js holds
 * the list); this shim drives the ONE room of the selected device, and
 * defers "which desktop?" to the device picker (remote-hub.js).
 *
 * Boot states:
 *  - `/p#<pair-token>`: pairing landing — exchanges the one-time token
 *    for a stored phone token (the desktop shows an approve dialog),
 *    appending to the paired-device list. R8: the pairing frame carries
 *    an X25519 ephemeral; the phone derives and stores the master secret
 *    (ms) alongside the token (remote-crypto.js).
 *  - a selected device: connect its room and expose the API.
 *  - paired but none selected: the device picker (hub) takes over.
 *  - nothing paired: an overlay asks to pair; invokes reject with
 *    `not paired`. An entry without `ms` (pre-R8 pairing) likewise
 *    refuses: E2E has no plaintext fallback (re-scan the QR).
 *
 * Connection model: EVERY close retries — first-connect failures and
 * mid-session drops share the same capped exponential backoff (a phone
 * that boots before the relay answers, or with the radio still handing
 * off, must not be stranded on a dead overlay). The desktop announces
 * itself with a `hello` frame (`caps`: gz, transcript-window, ask-sync);
 * the caps land on `window.__TAURI__.__remoteCaps` for debugging. R8:
 * caps without `e2e` (an old desktop) block every invoke with the
 * upgrade notice instead of sending plaintext. Desktop restarts arrive
 * as `peer desktop:true` — the room is new, so every live event
 * subscription replays and the app resyncs the active tab.
 *
 * E2E per-connection flow (the contract is the definition):
 *  1. onopen → send `hs` {v:2, ph: sha256(token) hex, pk, mac} with a
 *     fresh ephemeral (MS from the device entry keys the MAC);
 *  2. the desktop's `hs` {pk, mac} is verified against the MS — a bad
 *     MAC shows the re-pair card and closes;
 *  3. only then does the invoke queue flush (queued frames stay queued
 *     until the handshake lands — the queue mechanism is unchanged);
 *  4. every cmd/sub/unsub rides an `enc` envelope (K_c2d), and inbound
 *     `enc` opens (K_d2c) into the plain dispatch above. seq is per
 *     direction, strictly increasing on receive.
 * Reconnects redo the handshake (fresh ephemerals, same MS).
 */
(function () {
  "use strict";
  if (window.__TAURI__) return; // real desktop webview

  const log = (...a) => console.log("[remote]", ...a);

  let ws = null;
  let wsOpen = false;
  let everConnected = false;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, timer }
  let connDevice = null; // the room the live socket belongs to
  // E2E session state (one per connection; MS persists in the registry).
  // `e2eReady` gates the invoke flush: false from onopen until the
  // desktop's hs frame verifies. Keys/seq reset on every connect().
  let e2e = null; // { ms, eph, keys: {c2d,d2c}, rxSeq, ready, v2 }
  let e2eBroken = false; // a MAC failure this connection — no auto-retry
  const listeners = new Map(); // event name → Set<cb>
  // Stand-in Channels (sessionId → Channel): the desktop opens the browser
  // panel with its own Tauri Channel and re-emits every screencast frame as
  // a `browser://frame/{sid}` evt; live.js's stand-in Channel is what the
  // panel's onMessage sees. A session holds one panel at a time.
  const panelChannels = new Map();
  let overlay = null;
  let remoteCaps = null; // the desktop's hello caps, null before one arrives

  const DEVICES = () => window.OMP_REMOTE_DEVICES;
  const storeNow = () => DEVICES().load(localStorage);
  const currentEntry = () => DEVICES().selectedEntry(storeNow());

  const wsUrl = (query) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${query}`;

  /** This handset's friendly name (the desktop's phone list shows it):
   *  "<platform> · mobile/desktop" from the modern UA-Data when present,
   *  else a short UA summary. Bounded to 60 chars; the relay cleans it
   *  again anyway. */
  function phoneName() {
    const ua = navigator.userAgentData || navigator.userAgent || "";
    let name;
    if (ua && typeof ua === "object") {
      name = `${ua.platform || "unknown"} · ${ua.mobile ? "mobile" : "desktop"}`;
    } else {
      const s = String(ua);
      const m = /\(([^)]+)\)/.exec(s); // "(Windows NT 10.0; …)" style
      name = (m ? m[1] : s).split(";")[0].trim() || "unknown";
    }
    return name.slice(0, 60);
  }

  // ── pairing landing (/p#<pair-token>) ────────────────────────────────
  // E2E (contract §pairing): the phone opens the pairing socket and
  // immediately sends pair_hello {pk} with a one-off X25519 ephemeral.
  // The desktop's grant carries its own pk; the relay returns it in the
  // `paired` frame. Both sides derive the same MS = HKDF(X25519(...));
  // the phone stores it (b64) with the token — no MS, no E2E, and v2
  // has no plaintext fallback. The pk relayed back MUST match the
  // desktop's grant (pair_id is the relay's, both ends feed the salt).
  function pairingPage() {
    const pairToken = location.hash.slice(1);
    const E = window.OMP_E2E;
    const eph = E ? E.pairEph() : null;
    showOverlay("正在与桌面端配对…", "桌面端会弹出确认对话框。");
    const sock = new WebSocket(wsUrl(`role=phone&pair=${encodeURIComponent(pairToken)}`));
    sock.onopen = () => {
      if (eph) sock.send(JSON.stringify({ t: "pair_hello", pk: E.b64From(eph.pub) }));
    };
    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.t === "paired") {
        // Derive the master secret when the relay brought the desktop's
        // pairing pk back (v2 relays always do; a v1 relay pairing yields
        // no ms — the entry is flagged needs-pairing until a re-scan).
        let ms = "";
        if (eph && typeof frame.pk === "string") {
          try {
            const deskPk = E.b64Bytes(frame.pk);
            const msBytes = E.masterSecret(eph.priv, deskPk, eph.pub, deskPk);
            ms = E.b64From(msBytes);
          } catch { ms = ""; }
        }
        // Append to the paired-device list (a re-pair of a known desktop
        // swaps its token AND ms) and enter that desktop.
        let store = storeNow();
        store = DEVICES().upsert(store, frame.device, frame.token, ms);
        store = DEVICES().touch(store, frame.device, Date.now());
        DEVICES().save(localStorage, store);
        showOverlay("配对成功", "正在进入…");
        location.replace("/");
      } else if (frame.t === "pair_denied") {
        showOverlay("配对被拒绝", "桌面端拒绝了这次配对，或配对码已过期。请重新扫码。");
      }
    };
    sock.onclose = () => {
      showOverlay("配对未完成", "连接中断。请确认桌面端在线后重新扫码。");
    };
  }

  // ── overlay ─────────────────────────────────────────────────────────
  function showOverlay(title, sub, withCodeEntry, action) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "remote-overlay";
      overlay.innerHTML = `<div class="ro-card"><div class="ro-title"></div><div class="ro-sub"></div><div class="ro-code" style="display:none"><input class="ro-input" placeholder="ABCD-1234" maxlength="9" autocapitalize="characters" /><button class="ro-btn">配对</button></div><button class="ro-action" style="display:none"></button></div>`;
      const style = document.createElement("style");
      style.textContent = `#remote-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0e14;color:#e6e6e6;font-family:system-ui;padding:24px;text-align:center}#remote-overlay .ro-title{font-size:18px;font-weight:600;margin-bottom:8px}#remote-overlay .ro-sub{font-size:14px;opacity:.65;line-height:1.6;margin-bottom:14px}#remote-overlay .ro-code{display:flex;gap:8px;justify-content:center}#remote-overlay .ro-input{padding:8px 12px;font-size:16px;letter-spacing:2px;text-transform:uppercase;background:#151a22;border:1px solid #2a3340;border-radius:6px;color:#e6e6e6;width:140px;text-align:center}#remote-overlay .ro-btn{padding:8px 16px;font-size:14px;background:#3b82f6;border:none;border-radius:6px;color:#fff}#remote-overlay .ro-action{display:block;margin:14px auto 0;padding:8px 18px;font-size:14px;background:#1c2430;border:1px solid #2a3340;border-radius:6px;color:#c6cdd8}`;
      document.head.appendChild(style);
      (document.body || document.documentElement).appendChild(overlay);
      // Manual code entry: redeeming a code is opening /p#<code> (the
      // relay accepts the code as a pair-token alias).
      overlay.querySelector(".ro-btn").addEventListener("click", () => {
        const code = overlay.querySelector(".ro-input").value.trim();
        if (code) location.replace("/p#" + encodeURIComponent(code));
      });
    }
    overlay.style.display = "flex";
    overlay.querySelector(".ro-title").textContent = title;
    overlay.querySelector(".ro-sub").textContent = sub || "";
    overlay.querySelector(".ro-code").style.display = withCodeEntry ? "flex" : "none";
    // Optional one-button escape hatch (the offline overlay's "switch
    // device", the retry card's "立即重试"). Property assignment, never a
    // markup handler (CSP).
    const act = overlay.querySelector(".ro-action");
    if (action) {
      act.textContent = action.label;
      act.style.display = "block";
      act.onclick = action.onClick;
    } else {
      act.style.display = "none";
      act.onclick = null;
    }
  }
  function hideOverlay() { if (overlay) overlay.style.display = "none"; }

  // ── reconnect banner (non-blocking; the page stays alive) ─────────
  let banner = null;
  function showBanner(text) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "remote-banner";
      const style = document.createElement("style");
      style.textContent = `#remote-banner{position:fixed;top:0;left:0;right:0;z-index:99998;padding:calc(4px + env(safe-area-inset-top,0px)) 12px 4px;text-align:center;font:12px/1.6 system-ui;color:#f5c97b;background:rgba(20,24,32,.92);backdrop-filter:blur(8px);pointer-events:none}`;
      document.head.appendChild(style);
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = text;
    banner.style.display = "block";
  }
  function hideBanner() { if (banner) banner.style.display = "none"; }

  // ── connection ──────────────────────────────────────────────────────
  // Reconnect is IN PLACE, never a page reload: a reload refetches the
  // whole app and destroys the live transcript view, which over a WAN
  // (NAT idle drops, radio handoffs, screen-off timer suspension) made
  // the phone both laggy and blind to streaming replies. On re-open we
  // flush the queue, replay event subscriptions, and ask live.js to
  // resync the active tab (get_state + get_messages fill the gap).
  // First-connect failures take the SAME loop: an overlay that says
  // "refresh yourself" is a dead end on a phone whose only failure was
  // dialing too early.
  let retryMs = 1000;
  let reconnectTimer = 0;

  function connect() {
    const store = storeNow();
    if (store.devices.length === 0) {
      showOverlay("未配对", "在桌面端 Settings → Remote 生成配对二维码，用手机相机扫码打开；或在此输入屏幕上显示的配对码。", true);
      return;
    }
    const sel = DEVICES().selectedEntry(store);
    if (!sel) {
      // Paired with at least one desktop but none chosen (fresh list, or
      // the last one was forgotten): the device picker owns the screen.
      window.OMP_REMOTE_HUB?.open?.();
      return;
    }
    // R8: a pre-E2E pairing has no ms — there is no plaintext fallback,
    // so dialing is pointless. Same card the hub shows, with the
    // escape hatch into a re-scan.
    if (DEVICES().needsPairing(sel)) {
      showOverlay("需要重新配对", "此配对早于端到端加密版本。请在桌面端 Settings → Remote 重新生成配对二维码，用手机重新扫码。");
      return;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/open
    const sock = new WebSocket(wsUrl(
      `role=phone&device=${encodeURIComponent(sel.device)}&token=${encodeURIComponent(sel.token)}` +
      `&name=${encodeURIComponent(phoneName())}`));
    ws = sock;
    connDevice = sel.device;
    // Reset the E2E session: fresh ephemerals per connection (the MS
    // itself stays in the registry — it is the pairing, not the session).
    e2eBroken = false;
    e2e = null;
    const ms = window.OMP_E2E.b64Bytes(sel.ms);
    const hs = window.OMP_E2E.startHs(ms);
    const ph = window.OMP_E2E.sha256Hex(sel.token);
    sock.onopen = () => {
      wsOpen = true;
      retryMs = 1000;
      hideBanner();
      // Contract §hs: the FIRST frame on every connection is the phone's
      // handshake — ph (token hash, hex), pk (fresh eph), mac over
      // "P"||pk keyed by the MS. The desktop's reply completes the keys;
      // until then nothing business goes out (the queue keeps waiting).
      e2e = { ms, eph: hs, keys: null, txSeq: 0, rxSeq: -1, ready: false };
      sock.send(JSON.stringify({
        t: "hs", v: 2, ph,
        pk: window.OMP_E2E.b64From(hs.pk),
        mac: window.OMP_E2E.b64From(hs.mac),
      }));
    };

    /** Everything the connection does once the desktop's hs verified:
     *  the queue flush (same skip rules as before — timed-out invokes
     *  stay dead, subs replay fresh), the sub replay, and the resync
     *  on reconnect. Sealing applies now that keys exist. */
    function completeHandshake() {
      hideOverlay();
      for (const frame of sendQueue) {
        if (frame.t === "cmd" && frame.name !== "sub" && frame.id && !pending.has(frame.id)) continue;
        if (frame.t === "cmd" && frame.name === "sub") continue;
        sendE2E(frame);
      }
      sendQueue.length = 0;
      // Subscriptions always replay from the live registry (queued `sub`
      // frames were skipped above): covers both boot-time listeners and
      // re-subscribing after a drop. They ride enc like every frame now.
      replaySubsEnc();
      if (everConnected) {
        window.OMP_BRIDGE?._remoteResync?.();
      }
      everConnected = true;
    }

    /** replaySubs, but through the enc wrapper (an e2e-ready send). The
     *  desktop-restart peer frame re-uses it: a restarted desktop re-runs
     *  its half of the handshake (new room membership, fresh keys) —
     *  until its hs lands, the subs wait. */
    function replaySubsEnc() {
      if (!e2e || !e2e.ready) return;
      for (const name of listeners.keys()) {
        sendE2E({ t: "cmd", id: ++seq, name: "sub", args: { name } });
      }
    }

    /** The desktop gzips reply values over 32 KB into `{gz: base64}` to
     *  keep the handset's uplink honest; inflate them back here so callers
     *  see plain values. Anything else passes through untouched.
     *  DecompressionStream unavailable (very old browser): the pending
     *  promise rejects with a typed error instead of resolving garbage. */
    async function decodeValue(value) {
      if (!value || typeof value !== "object" || typeof value.gz !== "string") return value;
      const bytes = b64Bytes(value.gz);
      if (typeof DecompressionStream !== "function") {
        throw new Error("unsupported frame encoding");
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }

    // Decode base64 to its bytes. One allocation where the engine offers
    // it (Uint8Array.fromBase64, Chromium 140+): no intermediate binary
    // string, no per-byte copy loop. Older webviews fall back to the atob
    // path. Both throw on invalid input, which the caller reports. (The
    // same helper lives in live.js — it is IIFE-private there, and the
    // shim must never import live.js, so the equivalent is local.)
    const b64Direct = typeof Uint8Array.fromBase64 === "function";
    function b64Bytes(b64) {
      if (b64Direct) return Uint8Array.fromBase64(b64);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.t === "hs") {
        // The desktop's handshake reply (contract §hs): verify the MAC
        // over "D"||desk_pk||phone_pk keyed by the MS, then derive the
        // session keys from X25519(my_eph, desk_eph). Only then does the
        // queued business traffic flush. A bad MAC ends the connection
        // with the re-pair card — auto-retrying would loop on the same
        // mismatched secret forever.
        if (!e2e || e2e.ready) return; // stray/duplicate: ignore
        let deskPk;
        try { deskPk = window.OMP_E2E.b64Bytes(frame.pk); } catch { return failHandshake(); }
        if (deskPk.length !== 32) return failHandshake();
        if (!window.OMP_E2E.verifyDeskHs(e2e.ms, deskPk, frame.mac, e2e.eph.pk)) {
          return failHandshake();
        }
        try {
          e2e.keys = window.OMP_E2E.sessionKeys(e2e.eph.priv, deskPk, e2e.eph.pk, deskPk);
        } catch {
          return failHandshake();
        }
        e2e.ready = true;
        log("e2e handshake ok");
        completeHandshake();
        return;
      } else if (frame.t === "enc") {
        // Every business frame from the desktop arrives sealed. Open it
        // (K_d2c), enforce the strictly-increasing seq, and dispatch the
        // plaintext through the ordinary paths below by re-entering this
        // handler with the inner frame.
        if (!e2e || !e2e.ready) {
          log("enc before handshake — dropping");
          return;
        }
        let inner;
        try {
          const opened = window.OMP_E2E.open(e2e.keys.d2c, e2e.rxSeq, frame);
          e2e.rxSeq = opened.seq;
          inner = opened.frame;
        } catch (err) {
          // Tampered envelope, replay, or garbage: the connection is
          // compromised as far as we can tell — kill it without the
          // re-pair card (a transient fault must not nag; the relay
          // attacker cannot force this without breaking GCM).
          log("enc open failed:", err.message);
          try { sock.close(); } catch { /* already gone */ }
          return;
        }
        handleFrame(inner);
        return;
      }
      handleFrame(frame);
    };

    /** The plain-frame dispatch (used directly for relay-control frames
     *  and recursively for the plaintext inside an enc envelope). */
    function handleFrame(frame) {
      if (!frame || typeof frame.t !== "string") return;
      if (frame.t === "res") {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) {
          decodeValue(frame.value).then((v) => p.resolve(v), (e) => p.reject(
            e instanceof Error && e.message === "unsupported frame encoding"
              ? e
              : new Error("unsupported frame encoding")));
        } else p.reject(new Error(frame.error || "remote command failed"));
      } else if (frame.t === "evt") {
        // Screencast frames (the desktop's open-panel Channel re-emitted as
        // `browser://frame/{sid}`) belong to the stand-in Channel the panel
        // holds, not to any event listener.
        if (typeof frame.name === "string" && frame.name.startsWith("browser://frame/")) {
          // `{bin}` is a base64 screencast frame (the desktop's Channel
          // carries Raw binary, which JSON cannot): hand the screen the
          // ArrayBuffer it expects; anything else rides verbatim.
          const p = frame.payload;
          const msg = p && typeof p.bin === "string" ? binToBuffer(p.bin) : p;
          panelChannels.get(frame.name.slice("browser://frame/".length))?.onmessage?.(msg);
          return;
        }
        const set = listeners.get(frame.name);
        if (set) for (const cb of set) cb({ event: frame.name, payload: frame.payload });
      } else if (frame.t === "hello") {
        // The room desktop's caps (it sent this on its own connect, and
        // the relay repeats its own on ours). Kept on
        // window.__TAURI__.__remoteCaps. R8: caps WITHOUT `e2e` mean an
        // old desktop — the invoke wall goes up (the upgrade notice),
        // because nothing may ride plaintext.
        remoteCaps = Array.isArray(frame.caps) ? frame.caps : [];
        if (window.__TAURI__ && window.__TAURI__.__remoteShim) {
          window.__TAURI__.__remoteCaps = remoteCaps;
        }
        log("desktop caps:", remoteCaps.join(","));
      } else if (frame.t === "device") {
        // The room desktop's display identity (greet/update): keep the
        // paired list's name fresh — the hub and the topbar chip show it.
        window.OMP_REMOTE_HUB?.noteDevice?.(connDevice, frame);
      } else if (frame.t === "peer" && frame.desktop === false) {
        showOverlay("桌面端离线", "电脑上的 OMP Desktop 不在线（睡眠或已退出）。恢复后此页会自动重连。", false, {
          label: "切换设备",
          onClick: () => { hideOverlay(); window.OMP_REMOTE_HUB?.open?.(); },
        });
      } else if (frame.t === "peer" && frame.desktop === true) {
        hideOverlay();
        // Events were missed while the desktop was gone; pull the gap. A
        // desktop restart is a NEW room membership: its subscriptions
        // died with the old one, so every live listener replays (fresh
        // frames — the desktop's per-phone refcounts were rebuilt empty).
        // A restarted v2 desktop also re-runs its hs half (new eph, same
        // MS): replaySubsEnc defers to a ready session, and the desktop's
        // hs handler drives it.
        replaySubsEnc();
        window.OMP_BRIDGE?._remoteResync?.();
      } else if (frame.t === "dropped") {
        // The relay dropped an oversize frame (ours, or one addressed to
        // us): a pending invoke for that id must not hang to its 30s
        // timeout — reject it with the reason. No pending id (an evt, or
        // a reply we already resolved): just log.
        const p = frame.id != null ? pending.get(frame.id) : null;
        if (p) {
          pending.delete(frame.id);
          clearTimeout(p.timer);
          p.reject(new Error("relay dropped the reply (oversize)"));
        } else {
          console.warn("[remote] relay dropped a frame:", frame.reason);
        }
      }
    }
    /** A failed handshake MAC: the MS this phone holds does not match
     *  the desktop's (revoked+re-paired there, or corrupted storage).
     *  Retrying cannot fix a wrong key, so the connection closes AND the
     *  reconnect loop is suppressed until the user re-scans. */
    function failHandshake() {
      e2eBroken = true;
      e2e = null;
      log("e2e handshake FAILED (mac mismatch)");
      showOverlay("密钥校验失败，请重新配对", "手机与桌面端的配对密钥不一致。请在桌面端 Settings → Remote 重新生成配对二维码，用手机重新扫码。");
      try { sock.close(); } catch { /* already gone */ }
    }

    sock.onclose = () => {
      wsOpen = false;
      // A broken E2E key must not auto-retry: every attempt lands on the
      // same mismatch. The card above is the exit (re-scan or switch).
      if (e2eBroken) return;
      // First-connect failure and mid-session drop share the loop; the
      // retry card (with its button) tells a first-connect user the page
      // is not stranded, the banner tells a connected-then-dropped user
      // the page is alive.
      if (!everConnected) {
        showOverlay("连不上服务器", "正在自动重试。也可立即重试，或检查网络与 relay 服务。", false, {
          label: "立即重试",
          onClick: () => { retryMs = 0; clearTimeout(reconnectTimer); connect(); },
        });
      } else {
        showBanner("连接中断，正在重连…");
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  }

  // Wake from sleep / returning to the tab: phone browsers suspend timers
  // while backgrounded, so the relay's ping may already have killed the
  // socket. Don't wait out the backoff — reconnect immediately.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!ws || ws.readyState > 1)) {
      retryMs = 0;
      clearTimeout(reconnectTimer);
      connect();
    }
  });
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted && (!ws || ws.readyState > 1)) {
      retryMs = 0;
      clearTimeout(reconnectTimer);
      connect();
    }
  });

  // Frames sent before the socket opens (live.js boots immediately) queue
  // up and flush in order from onopen. A frame that can never be sent —
  // no pairing — is rejected by invoke() before it gets here. Bounded: a
  // long outage must not accumulate hours of stale frames.
  const sendQueue = [];
  function sendFrame(frame) {
    if (wsOpen && ws && ws.readyState === 1) {
      ws.send(JSON.stringify(frame));
    } else {
      sendQueue.push(frame);
      if (sendQueue.length > 500) sendQueue.splice(0, sendQueue.length - 500);
    }
  }

  /** E2E wrapper for every business frame (cmd/sub/unsub): seal with
   *  the live session's K_c2d. Not e2e-ready (handshake pending, or the
   *  socket down)? The frame queues PLAIN — the queue is pre-encryption
   *  by design: a reconnect mints fresh keys, and flushing would seal
   *  stale envelopes a second time. */
  function sendE2E(frame) {
    if (e2e && e2e.ready && e2e.keys && wsOpen && ws && ws.readyState === 1) {
      sendFrame(window.OMP_E2E.seal(e2e.keys.c2d, e2e.txSeq++, frame));
    } else {
      sendQueue.push(frame);
      if (sendQueue.length > 500) sendQueue.splice(0, sendQueue.length - 500);
    }
  }

  // ── the __TAURI__ surface ───────────────────────────────────────────
  // No-ops: window-close bookkeeping and the desktop's open-tab layout
  // belong to the desktop (the phone attaches to live tabs; it must never
  // persist open-tabs.json). A *deliberate* close_all_tabs passes through —
  // the boot-time one is skipped by live.js's __OMP_REMOTE__ guard.
  const NOOP = {
    set_close_guard: () => null,
    take_pending_open_projects: () => [],
    open_tabs_save: () => null,
  };
  // Desktop-only: native dialogs, the OS clipboard, the updater, window
  // chrome. An explicit error beats a dialog silently opening on the PC.
  const UNSUPPORTED = new Set([
    "open_project", "pick_background_image", "terminal_pick_shell",
    "browser_pick_path", "open_url_external", "app_update_install",
    "app_update_check", "copied_file_paths", "remote_get_state",
    "remote_configure", "remote_regenerate_token", "remote_set_name",
    "remote_send",
  ]);

  /** Stand-in for Tauri's IPC Channel: live.js builds one for the browser
   *  panel's screencast callback. The wire carries only a placeholder; the
   *  desktop's remote-agent opens the panel with its own real Channel and
   *  re-emits each frame as a `browser://frame/{sid}` evt, which the frame
   *  dispatch above feeds back into this object's onmessage. */
  function binToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  class Channel {
    constructor() { this.onmessage = null; }
  }

  function invoke(name, args) {
    if (name in NOOP) return Promise.resolve(NOOP[name]());
    if (UNSUPPORTED.has(name)) return Promise.reject(new Error(`${name} is unsupported on remote`));
    // Nothing selected (unpaired, or the picker is still up): no frame
    // can ever reach a desktop, so fail at once instead of hanging the
    // caller to the 30s timeout.
    if (!currentEntry()) return Promise.reject(new Error("not paired"));
    // R8: an old desktop (hello caps without `e2e`) must never receive
    // plaintext business frames — block every invoke with the upgrade
    // notice. remoteCaps stays null before any hello (still connecting):
    // the frame queues, and the gate re-checks once caps land.
    if (remoteCaps && !remoteCaps.includes("e2e")) {
      return Promise.reject(new Error("e2e required — upgrade the desktop app"));
    }
    // A Channel cannot cross the wire: the desktop's open-panel branch
    // builds its own and ignores the placeholder.
    let wire = args;
    if (args && typeof args === "object") {
      wire = { ...args };
      for (const [k, v] of Object.entries(wire)) {
        if (v instanceof Channel) wire[k] = { __remoteChannel: true };
      }
    }
    if (name === "browser_open_panel" && args?.events instanceof Channel) {
      panelChannels.set(args.sessionId, args.events);
      frameSub(args.sessionId);
    }
    if (name === "browser_close_panel" && typeof args?.sessionId === "string") {
      panelChannels.delete(args.sessionId);
      frameUnsub(args.sessionId);
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name}: timed out waiting for the desktop`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      sendE2E({ t: "cmd", id, name, args: wire || {} });
    });
  }

  // Frame-name sub/unsub, synchronous: the desktop's agent ignores these
  // (screencast frames ride its own Channel, re-emitted as evt frames), but
  // the wire bookkeeping mirrors every other subscription and the close
  // must land before the caller's next line observes the socket.
  function frameSub(sid) {
    const name = `browser://frame/${sid}`;
    if (listeners.has(name)) return;
    listeners.set(name, new Set()); // frames route to the Channel, never here
    sendE2E({ t: "cmd", id: ++seq, name: "sub", args: { name } });
  }
  function frameUnsub(sid) {
    const name = `browser://frame/${sid}`;
    if (!listeners.delete(name)) return;
    sendE2E({ t: "cmd", id: ++seq, name: "unsub", args: { name } });
  }

  function listen(name, cb) {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
      sendE2E({ t: "cmd", id: ++seq, name: "sub", args: { name } });
    }
    set.add(cb);
    return Promise.resolve(() => {
      set.delete(cb);
      if (set.size === 0) {
        listeners.delete(name);
        sendE2E({ t: "cmd", id: ++seq, name: "unsub", args: { name } });
      }
    });
  }

  window.__TAURI__ = {
    __remoteShim: true,
    __remoteCaps: null,
    core: { invoke, Channel },
    event: { listen },
  };
  window.__OMP_REMOTE__ = true;
  document.documentElement.classList.add("remote-shim");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  function boot() {
    if (location.pathname === "/p") pairingPage();
    else connect();
  }
})();
