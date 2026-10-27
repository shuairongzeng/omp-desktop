/* electron/main.js — the port's shell (M0/M1).

   Loads the REAL compiled frontend (dist/, built by the same
   scripts/build-frontend.mjs as the Tauri build) and answers its IPC through
   a preload shim that mimics `window.__TAURI__`. The backend is
   `stub-backend.js` until M2 replaces it with the Node implementations.

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
  });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return win;
}

// Window controls the frameless chrome drives (live.js `_setupWindowChrome`,
// chrome.jsx's maximize poll). Electron has no startDragging equivalent —
// the titlebar's drag region is M5's CSS concern; until then it no-ops.
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
// One multiplexed channel, like the Tauri command surface: the frontend's
// shim sends (name, args); the stub (later: real backend) answers.
ipcMain.handle("omp:invoke", (_e, name, args) => stub.handle(name, args));

// Events the frontend subscribes to ride this channel back; M1's stub emits
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
