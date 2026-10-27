/* electron/main.js — the port's shell (M0+).

   Loads the REAL compiled frontend (dist/, built by the same
   scripts/build-frontend.mjs as the Tauri build) and answers its IPC through
   a preload shim that mimics `window.__TAURI__`. Backend bodies come from
   electron/stub-backend.js, which routes to electron/backend/* as the
   milestones land.

   Boot with a CDP port for verification screenshots:
     npx electron . --remote-debugging-port=9333 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const stub = require("./stub-backend");

const T0 = Date.now();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    // Tauri runs decorations:false on every platform and the frontend draws
    // its own traffic lights / win controls (live.js branches on platform).
    // A framed or hidden-titlebar Electron window stacks native lights on
    // top of the drawn ones (measured: two titlebars in the M2 boot shot).
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      // The frontend is ours (same origin trust as the Tauri build); the
      // release CSP story is M5's problem, not M0's.
      nodeIntegration: false,
    },
  });
  win.webContents.once("did-finish-load", () => {
    console.log(`[port] first load at +${Date.now() - T0}ms`);
    // Tauri's startDragging() has no Electron equivalent; the idiomatic
    // replacement is a CSS drag region on the drawn titlebar. Injected after
    // load so dist/ stays untouched (the frontend's mousedown→startDragging
    // path no-ops through omp:win).
    win.webContents.insertCSS(`
      .chrome { -webkit-app-region: drag; }
      .chrome button, .chrome input, .chrome select, .chrome a,
      .chrome [role="button"], .chrome .profile-pop { -webkit-app-region: no-drag; }
    `).catch(() => {});
  });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return win;
}

// Window controls the frameless chrome drives (live.js `_setupWindowChrome`,
// chrome.jsx's maximize poll). startDragging is served by the CSS drag
// region above; the IPC stays a no-op so the frontend's call path is honest.
ipcMain.handle("omp:win", (e, op) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return Promise.resolve(null);
  switch (op) {
    case "minimize": win.minimize(); return Promise.resolve(null);
    case "maximize": win.maximize(); return Promise.resolve(null);
    case "unmaximize": win.unmaximize(); return Promise.resolve(null);
    case "isMaximized": return Promise.resolve(win.isMaximized());
    case "close": win.close(); return Promise.resolve(null);
    case "startDragging": return Promise.resolve(null);
    default: return Promise.resolve(null);
  }
});
// M3: the agent bridge's per-session stdout/exit frames ride the same
// `omp:event` channel the shim's event.listen consumes, named exactly like
// the Tauri events the frontend subscribes to (contract §3).
stub.agent.on("line", (sessionId, frame) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:event", `agent://line/${sessionId}`, frame);
  }
});
stub.agent.on("exit", (sessionId, reason) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:event", `agent://exit/${sessionId}`, reason);
  }
});
// M3: terminal output/exit frames. The manager's generic `data`/`exit`
// events carry {tabId, channel, ...payload}; the payload is exactly what
// the frontend's _listen expects ({instance, seq, b64} / {instance, code}),
// so strip the routing keys and pass it through on the same omp:event
// channel under the Tauri event name.
for (const kind of ["data", "exit"]) {
  stub.terminal.on(kind, (ev) => {
    const { tabId, channel, ...payload } = ev;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("omp:event", channel, payload);
    }
  });
}

app.on("before-quit", () => {
  stub.agent.shutdownAll();
  stub.terminal.shutdownAll().catch(() => {});
});

// One multiplexed channel, like the Tauri command surface: the frontend's
// shim sends (name, args); the stub (later: real backend) answers.
ipcMain.handle("omp:invoke", (_e, name, args) => stub.handle(name, args));

// Events the frontend subscribes to ride this channel back; the stub emits
// nothing, matching a quiet desktop.
ipcMain.handle("omp:subscribe", (_e, _name) => 0);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
