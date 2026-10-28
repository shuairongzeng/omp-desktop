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
    this._lastShown = new Map(); // sessionId -> targetId the user last saw
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
    return spawn;
  }

  /** The placeholder port omp's overlay points at. Binding port 0 lets two
   *  instances coexist (a hardcoded port made the second die EADDRINUSE);
   *  the broker is deferred, so this may run before Chromium exists. */
  async ensureProxy() {
    if (!this.proxy) {
      this.proxy = await startProxy({ broker: () => this._ensureBrokerForProxy(), port: 0 });
    }
    return this.proxy.port;
  }

  async _ensureBrokerForProxy() {
    if (!this.broker) await this._ensureBrowser();
    return this.broker;
  }

  get proxyPort() {
    return this.proxy?.port ?? null;
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
      // The shown page died under us (middle click, tab_close): hand over
      // to the survivor like Rust's on_target_destroyed does.
      view.on("lost-active", async (targetId) => {
        try {
          if (targetId == null) {
            const created = await this.pipe.send("Target.createTarget", { url: "about:blank" });
            targetId = created?.targetId;
            await view.discover();
          }
          await this.tabActivate(sessionId, targetId);
        } catch { /* the tab is closing anyway */ }
      });
      view.on("show", async (targetId) => {
        try {
          const session = await this.pipe.sessionFor(targetId);
          view.setActive(targetId, session);
          this._lastShown.set(sessionId, targetId);
          await this.pipe.send("Page.enable", {}, { sessionId: session }).catch(() => {});
          await view.syncAfterAttach();
        } catch { /* page gone between event and attach */ }
      });
      this.views.set(sessionId, view);
    }
    // Rust's open_panel guarantees at least one page before the screencast
    // starts (a fresh Chromium has none); without it the panel reports
    // "no page open" forever.
    if (channelId != null) this.channels.set(sessionId, channelId);
    if (view.pages().length === 0 || !view.active) {
      // A fresh view has not looked at Chromium yet: discover BEFORE
      // deciding what to show, or a reopen would create a new about:blank
      // instead of returning to the pages that are still open.
      await view.discover();
      // A reopened panel returns to the page the user was looking at when
      // it closed, not to whichever target discover() listed first.
      const remembered = this._lastShown.get(sessionId);
      const known = remembered && view.page(remembered) ? remembered : null;
      const target = known
        ? { targetId: known }
        : view.pages().length
          ? { targetId: view.pages()[0].targetId }
          : await this.pipe.send("Target.createTarget", { url: "about:blank" });
      if (!known && !view.page(target?.targetId)) await view.discover();
      // Rust's switch_to attaches the flattened CDP session and marks the
      // page active; the View throws "no page open" until setActive runs.
      let cdpSession = await this.pipe.sessionFor(target?.targetId);
      // A cached session can still be dead (Chromium detached it between
      // the event and this attach): re-attach once on the stale-id error.
      try {
        await this.pipe.send("Target.getTargetInfo", { targetId: target?.targetId }, { sessionId: cdpSession });
      } catch (error) {
        if (!/Session with given id not found/.test(String(error.message))) throw error;
        cdpSession = await this.pipe.reattach(target?.targetId);
      }
      view.setActive(target?.targetId, cdpSession);
      this._lastShown.set(sessionId, target?.targetId);
      await this.pipe.send("Page.enable", {}, { sessionId: cdpSession }).catch(() => {});
      await view.syncAfterAttach();
    }
    view.setSize(width, height, dpr ?? 1);
    const onFrame = (frame) => {
      this.emit("channel", sessionId, { b64: frame.wire().toString("base64") });
    };
    // The silent-screencast watchdog lives in View.startScreencast now, so
    // every start (open, reopen, page switch) is covered, not just opens.
    await view.startScreencast(this.pipe, onFrame, { width, height, dpr: dpr ?? 1 });
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
    // Page.getNavigationHistory is a PAGE-domain command: it must ride the
    // active page's flattened session (Rust's call_active), not the
    // browser-level one, where Chromium answers "wasn't found".
    const { sessionId: pageSession } = v.activation();
    const h = await v.call("Page.getNavigationHistory", {}, { sessionId: pageSession });
    const current = Number(h?.currentIndex ?? 0);
    const entries = Array.isArray(h?.entries) ? h.entries : [];
    const entry = entries[current + Number(delta ?? 0)];
    if (!entry) return null;
    await v.call("Page.navigateToHistoryEntry", { entryId: entry.id }, { sessionId: pageSession });
    return null;
  }

  async tabNew(sessionId) {
    const v = this.view(sessionId);
    const target = await v.call("Target.createTarget", { url: "about:blank" });
    // Rust's tab_new = create_page + switch_to: the new page must actually
    // be shown (screencast follows), or the strip marks it active while the
    // canvas keeps the old page and the next navigate hits the wrong one.
    await this.tabActivate(sessionId, target?.targetId);
    return target?.targetId ?? null;
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
    // Rust's switch_locked: the OLD page's screencast stops and its session
    // detaches before the new one takes over, else frames keep arriving
    // from the old generation and the canvas never follows the click.
    const old = v.active && v.active.targetId !== targetId ? v.active.sessionId : null;
    if (old) {
      v.releaseOverlay?.(old);
      this._notify(old, "Page.stopScreencast", {});
      this._notify(null, "Target.detachFromTarget", { sessionId: old });
    }
    const session = await this.pipe.sessionFor(targetId);
    v.setActive(targetId, session);
    this._lastShown.set(sessionId, targetId);
    this._notify(null, "Target.activateTarget", { targetId });
    await this.pipe.send("Page.enable", {}, { sessionId: session }).catch(() => {});
    await this._retargetAnnotate(sessionId, targetId);
    // apply_viewport parity: the new page gets the panel's size and a fresh
    // screencast; without it the canvas keeps the old page's frames.
    await v.startScreencast(
      this.pipe,
      (frame) => this.emit("channel", sessionId, { b64: frame.wire().toString("base64") }),
      { width: v.size.w, height: v.size.h, dpr: v.size.dpr },
    );
    await v.syncAfterAttach();
    return null;
  }

  _notify(sessionId, method, params) {
    this.pipe.send(method, params ?? {}, sessionId ? { sessionId } : undefined).catch(() => {});
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
    // Rust's resize_shown_page: the page's viewport follows the panel, or
    // the old-size JPEG stretches across the new canvas (full view).
    if (v.active) {
      v.applyViewport().catch(() => {});
    }
    return null;
  }

  /** The tab's Annotate, installing on first use; its picks ride the
   *  panel channel exactly like the Rust emit (use-browser.jsx consumes
   *  `{type:"pick", value}`), and the view state carries `annotate` so the
   *  next state message does not self-cancel the mode. */
  /** A switch moves the overlay to the new page (Rust releases the old
   *  page's overlay on switch); only while annotate mode is on. */
  async _retargetAnnotate(sessionId, targetId) {
    const ann = this.annotates.get(sessionId);
    if (!ann || !ann.enabled) return;
    ann.close();
    this.annotates.delete(sessionId);
    const fresh = await this._ensureAnnotate(sessionId, targetId);
    await fresh.setOn(true);
  }

  async _ensureAnnotate(sessionId, targetId = this.view(sessionId).active?.targetId) {
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

module.exports = { BrowserManager, checkedUrl };
