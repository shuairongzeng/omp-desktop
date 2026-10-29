/* electron/preload.js — the isolated-world bridge half of the port shim.

   The renderer-main-world half is electron/port-shim.js (injected into
   dist/index.html by scripts/port-dist.mjs). The split exists because
   Electron's contextBridge cannot marshal a Channel: a class is not
   constructible across the bridge and an `onmessage` assignment on a
   marshalled object stays renderer-local. Tauri has the same split — its
   Channel class lives in the renderer (@tauri-apps/api), crosses the wire
   as an id, and receives frames through a renderer-side listener.

   Here a Channel crosses as its id (the shim's toJSON); frame delivery
   calls back into the renderer through the function proxy the shim's
   `onmessage` setter registered via channelHandler. NOTE: a sandboxed
   preload has no Buffer, so base64 frames decode with atob. */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

let nextChannelId = 1;
const channelHandlers = new Map(); // id -> renderer handler proxy

// Channel delivery: main pushes (id, payload); payload is either a base64
// screencast frame or a plain {type, value} object.
ipcRenderer.on("omp:channel", (_e, id, payload) => {
  const fn = channelHandlers.get(id);
  if (!fn) return;
  if (payload && typeof payload.b64 === "string") {
    const bin = atob(payload.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    fn(bytes.buffer);
  } else {
    fn(payload);
  }
});

const listeners = new Map(); // name -> Set<handler>
ipcRenderer.on("omp:event", (_e, name, payload) => {
  for (const h of listeners.get(name) ?? []) h({ payload });
});

contextBridge.exposeInMainWorld("__OMP_PRIMS__", {
  invoke: (name, args) => ipcRenderer.invoke("omp:invoke", name, args ?? {}),
  winOp: (op) => ipcRenderer.invoke("omp:win", op),
  // Tauri's event.emit reaches every listener in the app; the port's only
  // consumers are this webview's own listeners and (through main's
  // rebroadcast) the remote-agent's per-phone forwarding, so emit rides
  // omp:emit to main and comes back as omp:event like every other event.
  emit: (name, payload) => ipcRenderer.send("omp:emit", name, payload ?? null),
  channelCreate: () => nextChannelId++,
  channelHandler: (id, fn) => {
    if (fn == null) channelHandlers.delete(id);
    else channelHandlers.set(id, fn);
  },
  // Tauri's native drag-drop event, reproduced from the DOM: the sandboxed
  // preload shares the page's document, and webUtils resolves a dropped
  // File to its absolute path (the renderer cannot).
  dragDrop: (handler) => {
    const dpr = () => window.devicePixelRatio || 1;
    const pathsOf = (e) => {
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return [];
      const out = [];
      for (const f of files) {
        try { out.push(webUtils.getPathForFile(f)); } catch { /* not a file */ }
      }
      return out;
    };
    const payload = (type, e) => ({
      type,
      paths: pathsOf(e),
      position: { x: Math.round(e.clientX * dpr()), y: Math.round(e.clientY * dpr()) },
    });
    // preventDefault keeps Electron from navigating the app to a dropped
    // file: like Tauri's dragDropEnabled, the app owns every drop.
    const over = (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); handler(payload("over", e)); } };
    const drop = (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); handler(payload("drop", e)); } };
    const leave = () => handler({ type: "leave", paths: [], position: { x: 0, y: 0 } });
    // Capture phase: Chromium's native drag events do not bubble to
    // window-level bubble listeners (measured: a CDP drag fired a capture
    // listener and not a bubble one), so the composer would never see a
    // real drop.
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragleave", leave, true);
    return Promise.resolve(() => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragleave", leave, true);
    });
  },
  listen: (name, handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return Promise.resolve(() => listeners.get(name)?.delete(handler));
  },
});

// Test/verification hook: lets a CDP-driven check confirm the shim is live.
contextBridge.exposeInMainWorld("__OMP_PORT_SHIM__", { version: 2 });
