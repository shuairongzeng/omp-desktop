/* remote-hub.js — the phone's device picker (multi-desktop remote
 * control, docs/architecture/remote-control.md).
 *
 * A full-screen list of every paired desktop with live presence, shown
 * at boot when no device is selected, and any time the user asks to
 * switch (the topbar chip, the offline overlay's action). Presence is
 * one WebSocket per listed device, opened only while the hub is visible
 * — the exact auth path the control connection uses
 * (role=phone&device&token), so the relay needs no new surface: it
 * greets every phone join with the room's stored `device` info and
 * current desktop `peer` presence, and keeps both fresh.
 *
 * Choosing a device persists the selection and RELOADS the page: the
 * whole app state (bridge, tabs, transcripts) belongs to the previous
 * desktop — a switch is a deliberate one-time user action, unlike a
 * drop, which reconnects in place and must never reload.
 *
 * Inert under a real Tauri webview (same guard as remote-transport.js,
 * which loads AFTER this file and only then defines the shim __TAURI__).
 * All list logic lives in remote-devices.js (pure, regression-tested);
 * this file is the DOM/socket glue around it.
 */
(function () {
  "use strict";
  if (window.__TAURI__) return; // real desktop webview

  const D = () => window.OMP_REMOTE_DEVICES;

  const STYLE = `#remote-hub{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#0a0e14;color:#e6e6e6;font-family:system-ui;padding:20px;text-align:left}
#remote-hub .rh-card{width:100%;max-width:420px;max-height:85vh;max-height:85dvh;overflow-y:auto;background:#10151d;border:1px solid #1f2733;border-radius:14px;padding:20px}
#remote-hub .rh-title{font-size:17px;font-weight:600;margin-bottom:4px}
#remote-hub .rh-sub{font-size:13px;opacity:.6;line-height:1.6;margin:6px 0}
#remote-hub .rh-list{display:flex;flex-direction:column;gap:8px;margin:12px 0}
#remote-hub .rh-row{display:flex;align-items:center;gap:10px;padding:12px;background:#151b25;border:1px solid #232c3a;border-radius:10px;cursor:pointer}
#remote-hub .rh-row.online{border-color:#2c4a33}
#remote-hub .rh-row-main{flex:1;min-width:0}
#remote-hub .rh-row-name{font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#remote-hub .rh-row-meta{font-size:12px;opacity:.55;margin-top:2px}
#remote-hub .rh-dot{width:9px;height:9px;border-radius:50%;flex:none;background:#5a6675}
#remote-hub .rh-dot.online{background:#3ecf6e}
#remote-hub .rh-dot.offline{background:#5a6675}
#remote-hub .rh-dot.connecting{background:#d9a441}
#remote-hub .rh-row-tag{font-size:11px;opacity:.7;border:1px solid #2a3340;border-radius:99px;padding:1px 8px;flex:none}
#remote-hub .rh-forget{background:none;border:none;color:#8b95a3;font-size:12px;padding:6px;flex:none}
#remote-hub .rh-pair-line{display:flex;gap:8px;margin-top:8px}
#remote-hub .rh-input{flex:1;padding:9px 12px;font-size:15px;letter-spacing:2px;text-transform:uppercase;background:#151a22;border:1px solid #2a3340;border-radius:8px;color:#e6e6e6;text-align:center}
#remote-hub .rh-btn{padding:9px 16px;font-size:14px;background:#3b82f6;border:none;border-radius:8px;color:#fff}
#remote-hub .rh-btn.ghost{background:#1c2430;color:#c6cdd8;border:1px solid #2a3340}
#remote-hub .rh-actions{display:flex;gap:8px;justify-content:space-between;margin-top:6px}`;

  let overlay = null;
  let listBox = null;
  let pairPane = null;
  let closeBtn = null;
  let isOpen_ = false;
  const presence = new Map(); // device id → { ws, status }

  const wsUrl = (query) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${query}`;

  const storeNow = () => D().load(localStorage);
  const persist = (store) => D().save(localStorage, store);

  /** The entry this phone controls (the chip shows its name). */
  function current() {
    return D().selectedEntry(storeNow());
  }

  /** A relay `device` frame from any of our sockets: fold the display
   * info into the entry and tell the app (the topbar chip listens). */
  function applyDeviceInfo(device, frame) {
    if (!device || !frame) return;
    persist(D().setInfo(storeNow(), device, { name: frame.name, os: frame.os }));
    window.dispatchEvent(new CustomEvent("omp:remote-device", {
      detail: { device, name: frame.name || "", os: frame.os || "" },
    }));
  }

  /** Called by remote-transport.js when the CONTROL socket receives a
   * `device` frame (the room it is connected to = the selected desktop). */
  function noteDevice(device, frame) {
    applyDeviceInfo(device, frame);
    render();
  }

  // ── presence sockets (alive only while the hub is open) ──────────────
  function syncPresence() {
    const devices = storeNow().devices;
    for (const [id, rec] of [...presence]) {
      if (!devices.some((d) => d.device === id)) dropPresence(id, rec);
    }
    for (const d of devices) {
      if (presence.has(d.device)) continue;
      const ws = new WebSocket(wsUrl(
        `role=phone&device=${encodeURIComponent(d.device)}&token=${encodeURIComponent(d.token)}`));
      const rec = { ws, status: "connecting" };
      presence.set(d.device, rec);
      ws.onmessage = (ev) => {
        let f;
        try { f = JSON.parse(ev.data); } catch { return; }
        if (f.t === "peer" && typeof f.desktop === "boolean") {
          rec.status = f.desktop ? "online" : "offline";
          render();
        } else if (f.t === "device") {
          applyDeviceInfo(d.device, f);
          render();
        }
      };
      // Any drop (relay restart, revoked token) reads as offline here;
      // reopening the hub retries. The control connection has its own
      // reconnect loop — this one is a status light, nothing more.
      ws.onclose = () => {
        if (presence.get(d.device) === rec) { rec.status = "offline"; render(); }
      };
    }
  }

  function dropPresence(id, rec) {
    presence.delete(id);
    try { rec.ws.onclose = null; rec.ws.close(); } catch { /* already gone */ }
  }

  function closePresence() {
    for (const [id, rec] of [...presence]) dropPresence(id, rec);
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const STATUS_TEXT = { connecting: "连接中…", online: "在线", offline: "离线" };

  function build() {
    if (overlay) return;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    overlay = el("div");
    overlay.id = "remote-hub";
    const card = el("div", "rh-card");
    card.appendChild(el("div", "rh-title", "选择要控制的桌面"));
    card.appendChild(el("div", "rh-sub", "同一 relay 上已配对的电脑，圆点是实时在线状态。"));
    listBox = el("div", "rh-list");
    card.appendChild(listBox);

    pairPane = el("div", "rh-pair");
    pairPane.style.display = "none";
    pairPane.appendChild(el("div", "rh-sub",
      "在新桌面端 Settings → Remote 点「配对新手机」，用手机相机扫描二维码；或输入那台电脑屏幕上显示的配对码。"));
    const line = el("div", "rh-pair-line");
    const input = el("input", "rh-input");
    input.placeholder = "ABCD-1234";
    input.maxLength = 9;
    const go = el("button", "rh-btn", "配对");
    go.addEventListener("click", () => {
      const code = (input.value || "").trim();
      if (code) location.replace("/p#" + encodeURIComponent(code));
    });
    line.appendChild(input);
    line.appendChild(go);
    pairPane.appendChild(line);
    card.appendChild(pairPane);

    const actions = el("div", "rh-actions");
    const pairBtn = el("button", "rh-btn ghost", "配对新桌面");
    pairBtn.addEventListener("click", () => {
      pairPane.style.display = pairPane.style.display === "none" ? "block" : "none";
    });
    closeBtn = el("button", "rh-btn ghost", "取消");
    closeBtn.addEventListener("click", close);
    actions.appendChild(pairBtn);
    actions.appendChild(closeBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function render() {
    if (!overlay || !isOpen_) return;
    const store = storeNow();
    const rows = [];
    for (const d of store.devices) {
      const rec = presence.get(d.device);
      const status = rec ? rec.status : "connecting";
      const row = el("div", `rh-row ${status}`);
      row.addEventListener("click", () => { if (status === "online") choose(d.device); });
      row.appendChild(el("span", `rh-dot ${status}`));
      const main = el("div", "rh-row-main");
      main.appendChild(el("div", "rh-row-name", D().displayName(d)));
      const meta = [D().osLabel(d.os), STATUS_TEXT[status]].filter(Boolean).join(" · ");
      main.appendChild(el("div", "rh-row-meta", meta));
      row.appendChild(main);
      if (d.device === store.selected) row.appendChild(el("span", "rh-row-tag", "当前"));
      const forget = el("button", "rh-forget", "遗忘");
      forget.addEventListener("click", (ev) => { ev.stopPropagation(); forgetDevice(d.device); });
      row.appendChild(forget);
      rows.push(row);
    }
    if (rows.length === 0) {
      rows.push(el("div", "rh-sub", "还没有配对的桌面。点下方「配对新桌面」扫码添加。"));
    }
    listBox.replaceChildren(...rows);
    // At boot with nothing selected there is no app behind the hub yet —
    // "取消" only makes sense when switching away from a live session.
    closeBtn.style.display = store.selected ? "" : "none";
  }

  function choose(device) {
    let store = D().select(storeNow(), device);
    store = D().touch(store, device, Date.now());
    persist(store);
    close();
    // Deliberate reload: everything on screen belongs to the previous
    // desktop; the fresh document attaches to the new one.
    location.reload();
  }

  function forgetDevice(device) {
    const entry = storeNow().devices.find((d) => d.device === device) || null;
    const msg = `遗忘「${D().displayName(entry)}」的配对？之后需要在那台电脑上重新扫码。`;
    if (window.confirm && !window.confirm(msg)) return;
    persist(D().forget(storeNow(), device));
    syncPresence();
    render();
  }

  function open() {
    build();
    isOpen_ = true;
    overlay.style.display = "flex";
    syncPresence();
    render();
  }

  function close() {
    isOpen_ = false;
    closePresence();
    if (overlay) overlay.style.display = "none";
  }

  window.OMP_REMOTE_HUB = {
    open,
    close,
    isOpen: () => isOpen_,
    current,
    noteDevice,
  };
})();
