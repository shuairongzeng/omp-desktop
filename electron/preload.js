/* electron/preload.js — the `window.__TAURI__` compatibility shim.

   The frontend's whole backend surface is five call shapes (audited on
   master 2026-10-27): `core.invoke` (25 sites), `event.listen` (11),
   `core.Channel` (2, browser panel only), `window.getCurrentWindow()` (1),
   `webview.getCurrentWebview()` (1). This shim implements exactly those,
   so no frontend file changes for M1. */

const { contextBridge, ipcRenderer } = require("electron");

let nextChannelId = 1;
const channels = new Map(); // id -> { onmessage }

// Event subscription: the main process pushes { name, payload } on
// "omp:event"; listeners registered by name.
const listeners = new Map(); // name -> Set<handler>
ipcRenderer.on("omp:event", (_e, name, payload) => {
  for (const h of listeners.get(name) ?? []) h({ payload });
});

class Channel {
  constructor(onmessage) {
    this.id = nextChannelId++;
    this.onmessage = onmessage ?? null;
    channels.set(this.id, this);
  }
}

const core = {
  invoke: (name, args) => ipcRenderer.invoke("omp:invoke", name, args ?? {}),
  Channel,
};

const event = {
  listen: (name, handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return Promise.resolve(() => listeners.get(name)?.delete(handler));
  },
  emit: () => Promise.resolve(),
};

const winOp = (op) => ipcRenderer.invoke("omp:win", op);
const windowApi = {
  getCurrentWindow: () => ({
    show: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
    // chrome.jsx:62 subscribes "tauri://resize" on the window object and
    // calls .then() in a mount effect — must be a Promise of an unlisten.
    listen: () => Promise.resolve(() => {}),
    close: () => winOp("close"),
    minimize: () => winOp("minimize"),
    maximize: () => winOp("maximize"),
    unmaximize: () => winOp("unmaximize"),
    isMaximized: () => winOp("isMaximized"),
    startDragging: () => winOp("startDragging"),
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
};

const webviewApi = {
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
    setZoom: () => Promise.resolve(),
  }),
};

contextBridge.exposeInMainWorld("__TAURI__", {
  core,
  event,
  window: windowApi,
  webview: webviewApi,
  // The frontend guards on `window.__TAURI__` presence; internals is used
  // by nothing in src/ (audited) but kept as an inert object so a stray
  // deep read cannot throw.
  internals: {},
});

// Test/verification hook: lets a CDP-driven check confirm the shim is live.
contextBridge.exposeInMainWorld("__OMP_PORT_SHIM__", { version: 1 });
