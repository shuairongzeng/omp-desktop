/* electron/backend/browser-manager.js — the port's per-tab browser owner.

   Mirrors src-tauri/src/browser/mod.rs: one Chromium per app run (launched
   lazily on the first panel open), one View per tab session, one agent-
   facing proxy on the placeholder port named in each omp overlay, and the
   screencast/annotate plumbing between them. Main forwards the manager's
   `channel` events to the webview Channel the frontend created in
   `browserOpenPanel` (see electron/port-shim.js `omp:channel`).

   Deviation from Rust, measured 2026-10-27 (Chrome 156 and CfT 150,
   --remote-debugging-pipe): the FIRST reader attached to the CDP pipe
   decides whether large replies (Page.captureScreenshot, screencast
   frames) ever arrive. With the broker first (proc.launch's handshake
   reader), every reader starves on them; with a plain reader first, all
   readers receive them. So the port spawns Chromium itself, attaches the
   PipeClient first (panel path) and the broker second (agent-facing
   proxy, small commands + events).

   The manager-level methods the Rust `View` owns but the port's View slice
   left at CDP level (navigate, history, tab new/close/activate, scroll_to,
   capture) live here, ported from src-tauri/src/browser/view/mod.rs
   including `checked_url`'s allowlist (http/https/data:/about:blank only). */

const { EventEmitter } = require("node:events");
const path = require("node:path");
const proc = require("./browser-process");
const { connect } = require("./browser-broker");
const viewMod = require("./browser-view");
const { View } = viewMod;
const annotateMod = require("./browser-annotate");
const { PipeClient } = require("./browser-pipe-client");
const { startProxy } = require("./browser-proxy");

const PROXY_PORT = 19222; // placeholder port written into every omp overlay
const MAX_URL_LEN = 4096; // Rust view::MAX_URL_LEN

function checkedUrl(url) {
  const u = String(url ?? "").trim();
  if (!u || u.length > MAX_URL_LEN || /[\x00-\x1f\x7f]/.test(u)) {
    throw new Error("invalid url");
  }
  const head = u.toLowerCase();
  if (head.startsWith("http://") || head.startsWith("https://") || head.startsWith("data:") || head === "about:blank") {
    return u;
  }
  throw new Error("unsupported url scheme");
}

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.spawn = null; // spawnChromium handle
    this.broker = null; // serves the agent-facing proxy
    this.pipe = null; // serves the panel (large replies)
    this.proxy = null;
    this.views = new Map(); // sessionId -> View
    this.annotates = new Map(); // sessionId -> Annotate
    this.channels = new Map(); // sessionId -> channel id (webview Channel)
  }

  alive() {
    return this.spawn != null && this.spawn.child.exitCode === null && this.spawn.child.signalCode === null;
  }

  async _ensureBrowser() {
    if (this.alive()) return this.spawn;
    const setting = proc.settingsGet();
    const found = proc.discover();
    const binary = setting?.path || found?.binaries?.[0] || null;
    if (!binary) throw new Error("no Chromium found (Settings → Browser)");
    const instanceDir = await proc.prepareInstanceDir(proc.browserRoot());
    const profiles = path.join(instanceDir, "profiles");
    require("node:fs").mkdirSync(profiles, { recursive: true, mode: 0o700 });
    const profile = path.join(profiles, `panel-${Date.now()}`);
    const spawn = proc.spawnChromium(binary, profile);
    proc.createPrivateFile(`${profile}.pid`, `${spawn.child.pid}\n`);
    // Reader order is the contract: PipeClient first, broker second.
    this.pipe = new PipeClient({ fromChromium: spawn.from, toChromium: spawn.to });
    await this.pipe.send("Browser.getVersion", {}); // handshake, like waitForBrowser
    this.broker = await connect({ from: spawn.from, to: spawn.to });
    this.spawn = spawn;
    if (!this.proxy) {
      this.proxy = await startProxy({ broker: this.broker, port: PROXY_PORT });
    }
    return spawn;
  }

  /** `browser_open_panel`: allocate the tab's view, start the screencast. */
  async openPanel(sessionId, { width, height, dpr, channelId }) {
    await this._ensureBrowser();
    let view = this.views.get(sessionId);
    if (!view) {
      view = new View({ client: this.pipe, sessionId });
      view.startFollowing();
      view.on("message", (m) => this.emit("channel", sessionId, m));
      // Agent-follow: a page the agent opened becomes the shown page; the
      // view only decides WHICH target, attaching its session is here.
      view.on("show", async (targetId) => {
        try {
          const session = await this.pipe.sessionFor(targetId);
          view.setActive(targetId, session);
          await this.pipe.send("Page.enable", {}, { sessionId: session }).catch(() => {});
        } catch { /* page gone between event and attach */ }
      });
      this.views.set(sessionId, view);
    }
    // Rust's open_panel guarantees at least one page before the screencast
    // starts (a fresh Chromium has none); without it the panel reports
    // "no page open" forever.
    if (channelId != null) this.channels.set(sessionId, channelId);
    if (view.pages().length === 0 || !view.active) {
      const target = await this.pipe.send("Target.createTarget", { url: "about:blank" });
      await view.discover();
      // Rust's switch_to attaches the flattened CDP session and marks the
      // page active; the View throws "no page open" until setActive runs.
      const cdpSession = await this.pipe.sessionFor(target?.targetId);
      view.setActive(target?.targetId, cdpSession);
      await this.pipe.send("Page.enable", {}, { sessionId: cdpSession }).catch(() => {});
    }
    view.setSize(width, height, dpr ?? 1);
    await view.startScreencast(
      this.pipe,
      (frame) => this.emit("channel", sessionId, { b64: frame.wire().toString("base64") }),
      { width, height, dpr: dpr ?? 1 },
    );
    return null;
  }

  view(sessionId) {
    const v = this.views.get(sessionId);
    if (!v) throw new Error("panel not open");
    return v;
  }

  navigate(sessionId, url) {
    const v = this.view(sessionId);
    const target = checkedUrl(url);
    const session = v.activeSession();
    if (!session) throw new Error("no page shown");
    return v.call("Page.navigate", { url: target }, { sessionId: session });
  }

  async history(sessionId, delta) {
    const v = this.view(sessionId);
    const h = await v.call("Page.getNavigationHistory", {});
    const current = Number(h?.currentIndex ?? 0);
    const entries = Array.isArray(h?.entries) ? h.entries : [];
    const entry = entries[current + Number(delta ?? 0)];
    if (!entry) return null;
    await v.call("Page.navigateToHistoryEntry", { entryId: entry.id });
    return null;
  }

  async tabNew(sessionId) {
    const v = this.view(sessionId);
    const target = await v.call("Target.createTarget", { url: "about:blank" });
    await v.call("Target.activateTarget", { targetId: target?.targetId });
    return null;
  }

  async tabClose(sessionId, targetId) {
    const v = this.view(sessionId);
    if (!v.pages().some(p => p.targetId === targetId)) throw new Error("unknown tab");
    if (v.pages().length <= 1) {
      await v.call("Target.createTarget", { url: "about:blank" });
    }
    await v.call("Target.closeTarget", { targetId });
    return null;
  }

  async tabActivate(sessionId, targetId) {
    const v = this.view(sessionId);
    if (!v.pages().some(p => p.targetId === targetId)) throw new Error("unknown tab");
    await v.call("Target.activateTarget", { targetId });
    const session = await this.pipe.sessionFor(targetId);
    v.setActive(targetId, session);
    await this.pipe.send("Page.enable", {}, { sessionId: session }).catch(() => {});
    return null;
  }

  input(sessionId, event) {
    const v = this.view(sessionId);
    if (event && typeof event.kind === 'string') {
      const [method, params] = viewMod.inputEventToCommand(event);
      return v.input(method, params);
    }
    return v.input(event?.method, event?.params ?? {});
  }

  frameAck(sessionId, seq) {
    this.views.get(sessionId)?.frameAck(seq);
    return null;
  }

  resize(sessionId, width, height, dpr) {
    const v = this.view(sessionId);
    v.setSize(width, height, dpr ?? 1);
    return null;
  }

  /** The tab's Annotate, installing on first use; its picks ride the
   *  panel channel exactly like the Rust emit (use-browser.jsx consumes
   *  `{type:"pick", value}`), and the view state carries `annotate` so the
   *  next state message does not self-cancel the mode. */
  async _ensureAnnotate(sessionId) {
    let ann = this.annotates.get(sessionId);
    if (!ann) {
      const v = this.view(sessionId);
      ann = await annotateMod.install(this.pipe, v.active?.targetId, { view: v });
      ann.on("pick", (value) => this.emit("channel", sessionId, { type: "pick", value }));
      this.annotates.set(sessionId, ann);
    }
    return ann;
  }

  async annotate(sessionId, on) {
    const v = this.view(sessionId);
    const ann = on ? await this._ensureAnnotate(sessionId) : this.annotates.get(sessionId);
    if (ann) await ann.setOn(on === true);
    v.updateState((state) => { state.annotate = on === true; });
    if (!on && ann) {
      this.annotates.delete(sessionId);
    }
    return null;
  }

  async capture(sessionId, rect) {
    const ann = await this._ensureAnnotate(sessionId);
    return ann.capture(rect);
  }

  scrollRect(sessionId, rect) {
    const v = this.view(sessionId);
    const session = v.activeSession();
    if (!session) throw new Error("no page shown");
    // Rust scrolls via the overlay binding; the port drives it through
    // Runtime.evaluate on the page session (same effect, no overlay dep).
    const x = Math.max(0, Number(rect?.x ?? 0));
    const y = Math.max(0, Number(rect?.y ?? 0));
    return v.call("Runtime.evaluate", {
      expression: `window.scrollTo({left:${x},top:${y},behavior:"smooth"})`,
    }, { sessionId: session });
  }

  settings() {
    return proc.settingsGet();
  }

  setPath(p) {
    return proc.settingsSetPath(p);
  }

  async closePanel(sessionId) {
    const view = this.views.get(sessionId);
    if (view) view.close();
    this.views.delete(sessionId);
    this.channels.delete(sessionId);
    const ann = this.annotates.get(sessionId);
    if (ann) {
      try { ann.close(); } catch { /* overlay already gone */ }
    }
    this.annotates.delete(sessionId);
    return null;
  }

  async shutdownAll() {
    for (const ann of this.annotates.values()) await ann.close().catch(() => {});
    this.annotates.clear();
    for (const view of this.views.values()) view.close();
    this.views.clear();
    this.channels.clear();
    if (this.proxy) await this.proxy.close().catch(() => {});
    this.proxy = null;
    if (this.pipe) this.pipe.close();
    this.pipe = null;
    if (this.broker) this.broker.close();
    this.broker = null;
    if (this.spawn) await this.spawn.stop().catch(() => {});
    this.spawn = null;
  }
}

module.exports = { BrowserManager, PROXY_PORT, checkedUrl };
