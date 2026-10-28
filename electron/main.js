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
const { globalShortcut, Tray, Menu, nativeImage } = require("electron");
const fs = require("node:fs");
const hotkey = require("./backend/hotkey");

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
  stub.remote.shutdown().catch(() => {});
  stub.agent.shutdownAll();
  stub.terminal.shutdownAll().catch(() => {});
  stub.browser.shutdownAll().catch(() => {});
  stub.widgetsHost.killAll();
  globalShortcut.unregisterAll();
});

// ── widgets: events to the webview + host lifecycle hooks ─────────────────
stub.setWidgetEmit((event, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:event", event, payload);
  }
});
// Rust: start_session registers the session with the host (lib.rs:183),
// close/stop unregister it, agent_end notifies turn end. The port has no
// .git/HEAD watcher, so the branch trigger is inert (documented gap).
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.removeHandler("omp:invoke");
ipcMain.handle("omp:invoke", (e, name, args) => {
  const result = stub.handle(name, args);
  if (name === "start_session") {
    const a = args?.args ?? args ?? {};
    Promise.resolve(result).then(() => {
      stub.widgetsHost.sessionStarted(a.sessionId, a.cwd ?? null);
    });
  }
  if (name === "close_tab" || name === "stop_session") {
    const sid = args?.sessionId;
    if (sid) Promise.resolve(result).then(() => stub.widgetsHost.sessionClosed(sid));
  }
  return result;
});
// agent_end frames ride the agent line channel: notify turn end.
stub.agent.on("line", (sessionId, frame) => {
  if (typeof frame?.text === "string" && frame.text.includes('"type":"agent_end"')) {
    stub.widgetsHost.turnEnded(sessionId);
  }
});

// ── summon hotkey + tray (global_hotkey.rs / tray.rs) ─────────────────────
const summon = () => {
  console.log("[port] summon fired");
  app.focus({ steal: true });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("omp:event", hotkey.SUMMON_EVENT, null);
  }
};
function setupHotkeyTray() {
const chord = hotkey.readChord(stub.widgetsHost.configDir ?? require("./backend/stores").configHome());
  if (chord.warning) console.error(chord.warning);
  try {
    const registered = globalShortcut.register(chord.accelerator, summon);
    console.log(`[port] summon hotkey ${chord.chord} -> ${chord.accelerator} registered=${registered} isRegistered=${globalShortcut.isRegistered(chord.accelerator)}`);
  } catch (e) {
    console.error(`[port] summon hotkey registration failed: ${e.message}`);
  }
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "16x16.png"));
  let tray = null;
  if (!trayIcon.isEmpty()) {
    tray = new Tray(trayIcon);
    tray.setToolTip(hotkey.TRAY_TOOLTIP);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "show omp", click: summon },
      { label: "quit", click: () => { app.quit(); } },
    ]));
    // Rust: left click toggles the window (tray.rs), menu stays for right.
    tray.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return summon();
      if (win.isVisible() && win.isFocused()) win.hide();
      else summon();
    });
  }
}

// M3: browser screencast frames and view messages ride the webview Channel
// the frontend created in browserOpenPanel (preload serializes it to its
// id; the dispatcher hands that id to the manager).
stub.browser.on("channel", (sessionId, payload) => {
  const channelId = stub.browser.channels.get(sessionId);
  if (channelId == null) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:channel", channelId, payload);
  }
});

// M4: remote-control frames fan out as the three Tauri events
// remote-agent.js subscribes to (remote://phone / control / status).
stub.remote.on("event", (name, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:event", name, payload);
  }
});


// Events the frontend subscribes to ride this channel back; the stub emits
// nothing, matching a quiet desktop.
ipcMain.handle("omp:subscribe", (_e, _name) => 0);

// ── external open: launch argv, second instance, macOS open-file ──────────
// Mirrors external_open.rs: positional args (and macOS `open-file` URLs)
// resolve to canonical folders, queue, and one `open://project` event wakes
// the frontend's drain (live.js:2144 → take_pending_open_projects).
const announceOpenProjects = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("omp:event", "open://project", null);
  }
};
const ingestArgv = (argv, cwd) => {
  const base = cwd ?? process.cwd();
  const outcomes = stub.externalOpen.positionalArgs(argv).map((arg) =>
    stub.externalOpen.folderFromArg(base, arg));
  if (stub.externalOpen.ingest(stub.openProjects, outcomes, (m) => console.error(m))) {
    announceOpenProjects();
  }
};
// Tauri's single-instance plugin forwards a second launch's argv; Electron
// needs the lock explicitly (external_open.rs's forwarded-argv path).
if (!app.requestSingleInstanceLock()) {
  app.quit(); // an instance already owns this config dir
}
app.on("second-instance", (_e, argv, cwd) => ingestArgv(argv, cwd));
app.on("open-file", (_e, file) => {
  if (stub.externalOpen.ingest(stub.openProjects, [stub.externalOpen.folderFromPath(file)],
    (m) => console.error(m))) announceOpenProjects();
});

app.whenReady().then(() => {
  setupHotkeyTray();
  ingestArgv(process.argv, process.cwd());
  createWindow();
  // No boot announce needed: live.js's _setupExternalOpens drains the
  // queue once at setup, which covers a launch-argv batch queued before
  // any window existed (its announce would have had no listener).
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
