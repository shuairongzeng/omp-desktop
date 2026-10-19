/* remote-transport.js — the phone side of remote control
 * (docs/architecture/remote-control.md). When the app is served by the
 * relay to a plain browser there is no Tauri runtime; this shim provides
 * the `window.__TAURI__` surface over the room WebSocket, so live.js and
 * every component run unchanged. Loaded before live.js; under the real
 * desktop webview it detects `__TAURI__` and does nothing.
 *
 * Boot states:
 *  - `/p#<pair-token>`: pairing landing — exchanges the one-time token
 *    for a stored phone token (the desktop shows an approve dialog).
 *  - stored token: connect and expose the API.
 *  - neither: an overlay asks to pair; invokes reject with `not paired`.
 */
(function () {
  "use strict";
  if (window.__TAURI__) return; // real desktop webview

  const AUTH_KEY = "omp-remote:auth";
  const log = (...a) => console.log("[remote]", ...a);

  let ws = null;
  let wsOpen = false;
  let everConnected = false;
  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, timer }
  const listeners = new Map(); // event name → Set<cb>
  let overlay = null;

  const readAuth = () => {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; }
  };
  const writeAuth = (a) => localStorage.setItem(AUTH_KEY, JSON.stringify(a));

  const wsUrl = (query) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${query}`;

  // ── pairing landing (/p#<pair-token>) ────────────────────────────────
  function pairingPage() {
    const pairToken = location.hash.slice(1);
    showOverlay("正在与桌面端配对…", "桌面端会弹出确认对话框。");
    const sock = new WebSocket(wsUrl(`role=phone&pair=${encodeURIComponent(pairToken)}`));
    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.t === "paired") {
        writeAuth({ device: frame.device, token: frame.token });
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
  function showOverlay(title, sub, withCodeEntry) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "remote-overlay";
      overlay.innerHTML = `<div class="ro-card"><div class="ro-title"></div><div class="ro-sub"></div><div class="ro-code" style="display:none"><input class="ro-input" placeholder="ABCD-1234" maxlength="9" autocapitalize="characters" /><button class="ro-btn">配对</button></div>`;
      const style = document.createElement("style");
      style.textContent = `#remote-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0e14;color:#e6e6e6;font-family:system-ui;padding:24px;text-align:center}#remote-overlay .ro-title{font-size:18px;font-weight:600;margin-bottom:8px}#remote-overlay .ro-sub{font-size:14px;opacity:.65;line-height:1.6;margin-bottom:14px}#remote-overlay .ro-code{display:flex;gap:8px;justify-content:center}#remote-overlay .ro-input{padding:8px 12px;font-size:16px;letter-spacing:2px;text-transform:uppercase;background:#151a22;border:1px solid #2a3340;border-radius:6px;color:#e6e6e6;width:140px;text-align:center}#remote-overlay .ro-btn{padding:8px 16px;font-size:14px;background:#3b82f6;border:none;border-radius:6px;color:#fff}`;
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
  let retryMs = 1000;
  let reconnectTimer = 0;
  function connect() {
    const auth = readAuth();
    if (!auth || !auth.device || !auth.token) {
      showOverlay("未配对", "在桌面端 Settings → Remote 生成配对二维码，用手机相机扫码打开；或在此输入屏幕上显示的配对码。", true);
      return;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/open
    const sock = new WebSocket(wsUrl(`role=phone&device=${encodeURIComponent(auth.device)}&token=${encodeURIComponent(auth.token)}`));
    ws = sock;
    sock.onopen = () => {
      wsOpen = true;
      retryMs = 1000;
      hideOverlay();
      hideBanner();
      // Flush in order, skipping invoke frames whose promise already
      // timed out while queued (running them now would double-execute a
      // prompt the user was told had failed) and subs (replayed below).
      for (const frame of sendQueue) {
        if (frame.t === "cmd" && frame.name !== "sub" && frame.id && !pending.has(frame.id)) continue;
        if (frame.t === "cmd" && frame.name === "sub") continue;
        sock.send(JSON.stringify(frame));
      }
      sendQueue.length = 0;
      // Subscriptions always replay from the live registry (queued `sub`
      // frames were skipped above): covers both boot-time listeners and
      // re-subscribing after a drop.
      for (const name of listeners.keys()) {
        sock.send(JSON.stringify({ t: "cmd", id: ++seq, name: "sub", args: { name } }));
      }
      if (everConnected) {
        window.OMP_BRIDGE?._remoteResync?.();
      }
      everConnected = true;
    };
    sock.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.t === "res") {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.value);
        else p.reject(new Error(frame.error || "remote command failed"));
      } else if (frame.t === "evt") {
        const set = listeners.get(frame.name);
        if (set) for (const cb of set) cb({ event: frame.name, payload: frame.payload });
      } else if (frame.t === "peer" && frame.desktop === false) {
        showOverlay("桌面端离线", "电脑上的 OMP Desktop 不在线（睡眠或已退出）。恢复后此页会自动重连。");
      } else if (frame.t === "peer" && frame.desktop === true) {
        hideOverlay();
        // Events were missed while the desktop was gone; pull the gap.
        window.OMP_BRIDGE?._remoteResync?.();
      } else if (frame.t === "dropped") {
        console.warn("[remote] relay dropped a frame:", frame.reason);
      }
    };
    sock.onclose = () => {
      wsOpen = false;
      if (!everConnected) {
        showOverlay("连不上服务器", "检查 relay 服务与网络后刷新。若刚换过设备令牌，需要重新配对。");
        return;
      }
      showBanner("连接中断，正在重连…");
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
    "remote_configure", "remote_regenerate_token", "remote_send",
  ]);

  function invoke(name, args) {
    if (name in NOOP) return Promise.resolve(NOOP[name]());
    if (UNSUPPORTED.has(name)) return Promise.reject(new Error(`${name} is unsupported on remote`));
    // Unpaired: no frame can ever reach the desktop, so fail at once
    // instead of hanging the caller to the 30s timeout.
    if (!readAuth()) return Promise.reject(new Error("not paired"));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name}: timed out waiting for the desktop`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      sendFrame({ t: "cmd", id, name, args: args || {} });
    });
  }

  function listen(name, cb) {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
      sendFrame({ t: "cmd", id: ++seq, name: "sub", args: { name } });
    }
    set.add(cb);
    return Promise.resolve(() => {
      set.delete(cb);
      if (set.size === 0) {
        listeners.delete(name);
        sendFrame({ t: "cmd", id: ++seq, name: "unsub", args: { name } });
      }
    });
  }

  window.__TAURI__ = {
    __remoteShim: true,
    core: { invoke },
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
