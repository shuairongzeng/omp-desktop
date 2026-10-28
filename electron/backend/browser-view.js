/* electron/backend/browser-view.js — Node port of the panel's half of the
   browser: `src-tauri/src/browser/view/` (model, frames, events, cdp.rs,
   wire.rs).

   One View per browser tab session. It owns:
   - the page list (`Target.setDiscoverTargets` / target events) and the
     `{ type: "tabs", value }` message the Rust panel channel carried;
   - follow and hold: the agent's page is followed at once, unless the user
     acted in the last `followHoldMs`, and a page the view does not list yet
     is followed when it appears (newest report wins);
   - the screencast: `Emulation.setDeviceMetricsOverride` + `Page.
     startScreencast`, with the same ack gating as `view/frames.rs` — at most
     one frame is in flight to the panel, Chromium is acked only when the
     panel acked that frame (`frameAck`) or `ackTimeoutMs` passed, and the
     newest waiting frame replaces an older one (whose Chromium ack is owed
     and sent with the next release);
   - `input(method, params)`: gestures queued in order for the page session
     shown when they were made, dropped (not redirected) if another page is
     shown by the time they are sent; `browser is busy` past 512 queued.

   Payload parity, Rust → here:
   - `tabs`     { targetId, title, url, active } (camelCase, same fields)
   - `state`    { status, error, url, loading, canBack, canForward, annotate }
   - `pick`     lives in browser-annotate.js.
   - frames     Rust sent raw bytes: u64 seq (LE), u32 css_w (LE), u32 css_h
                (LE), then the JPEG. Electron IPC is JSON, so a frame reaches
                `onFrame` as a `Frame` whose `toJSON()` is
                { seq, b64, w, h, cssW, cssH }; `frame.wire()` reproduces the
                Rust byte layout exactly for a binary channel.

   Framing note: the CDP pipe behind the Broker is NOT newline-delimited
   JSON. Rust's `broker/mod.rs` `read_loop` uses `BufRead::read_until(0)`,
   i.e. each JSON message is NUL-terminated (0x00) on the wire. This module
   never touches that pipe — it speaks only the Broker/BrokerClient contract
   — but the framing is stated here because the batch context had it wrong.

   Deliberate deviations:
   - The Rust event handler/worker/emitter/input threads collapse into Node
     async loops: `FrameFlow.next()` is a promise, input is a promise queue,
     and the ordering guarantees (causal commands, ack before next frame) are
     unchanged.
   - Rust's worker reacts to page events with CDP calls; the same calls are
     made here, from the same events: `Page.frameNavigated`,
     `Page.frameStoppedLoading` and `Page.navigatedWithinDocument` refresh
     `Page.getNavigationHistory`, `Page.loadEventFired` refreshes
     `Target.getTargetInfo` (the title), and a failed main-frame load sets
     `error` from `unreachableUrl`. Only events of the shown page's session
     count (the Rust worker's `is_active_session`).
   - Rust's `InputEvent::to_command` mapping (frontend payload → CDP method,
     with its mouse-type/button/key-type validation) is not in this slice:
     `input(method, params)` takes the CDP command that mapping produced.
   - Rust's async `CdpClient` post (`notify`) is `send(...).catch()` here:
     the same fire-and-forget ordering, no waiting for the reply. */

'use strict';

const { EventEmitter } = require('node:events');

/** How long a frame in flight waits for the panel's ack (`ACK_TIMEOUT`). */
const ACK_TIMEOUT_MS = 1000;
/** After the user picked a tab, following waits this long (`FOLLOW_HOLD`). */
const FOLLOW_HOLD_MS = 5000;
const MAX_EDGE = 8192;
const MAX_DEVICE_EDGE = 8192;
const MAX_HEALS = 5;
const HEAL_GAP_MS = 300;
const HEAL_REFILL_MS = 5000;
/** Input events not yet sent to Chromium; past this input is refused. */
const INPUT_QUEUE = 512;
const NOT_ATTACHED_TRIES = 6;
const NOT_ATTACHED_PAUSE_MS = 50;
/** What Chromium answers a page command while it commits a navigation. */
const NOT_ATTACHED = 'Not attached to an active page';
/** Bytes before the JPEG in `Frame#wire()`. */
const FRAME_HEADER = 16;
/** Base64 characters decoded for `jpegSize` (a multiple of 4). */
const PREFIX = 4096;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const sleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

function messageOf(error) {
  if (error == null) return 'unknown error';
  return typeof error === 'string' ? error : String(error.message ?? error);
}

/** The bytes of the first `PREFIX` base64 characters, cut to whole groups. */
function decodePrefix(b64) {
  if (typeof b64 !== 'string') return null;
  const text = b64.slice(0, Math.min(b64.length, PREFIX) & ~3);
  if (!BASE64.test(text)) return null;
  try {
    return Buffer.from(text, 'base64');
  } catch {
    return null;
  }
}

function be16(bytes, at) {
  if (at + 1 >= bytes.length) return null;
  return (bytes[at] << 8) | bytes[at + 1];
}

/** `(width, height)` in pixels of the JPEG `b64` encodes, like `jpeg_size`. */
function jpegSize(b64) {
  const bytes = decodePrefix(b64);
  if (!bytes || bytes.length < 2) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  for (;;) {
    if (at + 1 >= bytes.length || bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = be16(bytes, at + 5);
      const width = be16(bytes, at + 7);
      return height == null || width == null ? null : [width, height];
    }
    const length = be16(bytes, at + 2);
    if (length == null) return null;
    at += 2 + length;
  }
}

/** One screencast frame. `b64` is Chromium's JPEG, untouched. */
class Frame {
  constructor({ b64, w, h, cssW, cssH, seq = 0 }) {
    this.b64 = b64;
    this.w = w;
    this.h = h;
    this.cssW = cssW;
    this.cssH = cssH;
    this.seq = seq;
  }

  /** `Frame::new`: image size from the JPEG header, CSS size as fallback. */
  static create(b64, cssW, cssH) {
    const size = jpegSize(b64);
    const [w, h] = size ?? [cssW, cssH];
    return new Frame({ b64, w, h, cssW, cssH });
  }

  /** The panel channel's bytes: seq u64, cssW u32, cssH u32 (LE), JPEG. */
  wire() {
    if (typeof this.b64 !== 'string' || !BASE64.test(this.b64)) return null;
    const jpeg = Buffer.from(this.b64, 'base64');
    const bytes = Buffer.alloc(FRAME_HEADER + jpeg.length);
    bytes.writeBigUInt64LE(BigInt(this.seq), 0);
    bytes.writeUInt32LE(this.cssW >>> 0, 8);
    bytes.writeUInt32LE(this.cssH >>> 0, 12);
    jpeg.copy(bytes, FRAME_HEADER);
    return bytes;
  }

  /** Whether the image has the proportions its CSS size claims. */
  hasCssProportions() {
    const across = this.w * this.cssH;
    const down = this.h * this.cssW;
    return Math.abs(across - down) <= Math.max(this.cssW, this.cssH);
  }

  toJSON() {
    return { seq: this.seq, b64: this.b64, w: this.w, h: this.h, cssW: this.cssW, cssH: this.cssH };
  }
}

/** `chromium_ack`: the `Page.screencastFrameAck` a frame of `session` owes. */
function chromiumAck(session, params) {
  const id = params && params.sessionId;
  if (!Number.isInteger(id)) return null;
  return { session, id };
}

/**
 * The frame waiting for the emitter and the one in flight to the panel —
 * `view/frames.rs` `FrameFlow` with the same transitions.
 */
class FrameFlow {
  constructor({ ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
    this.ackTimeoutMs = ackTimeoutMs;
    this.waiting = null;
    this.inFlight = null;
    /** Acks of frames skipped or released, not sent yet. */
    this.owed = [];
    this.seq = 0;
    this.closed = false;
    this.waiters = [];
    this.timer = null;
  }

  /** The newest frame of activation `generation`; one waiting is skipped. */
  put(generation, frame, ack = null) {
    if (this.waiting && this.waiting.ack) this.owed.push(this.waiting.ack);
    this.waiting = { generation, frame, ack };
    this._wake();
  }

  /** Skip the waiting frame (the screencast restarts). */
  clear() {
    if (this.waiting && this.waiting.ack) this.owed.push(this.waiting.ack);
    this.waiting = null;
    this._wake();
  }

  /** The panel is done with frame `seq`; other seqs are ignored. */
  ack(seq) {
    if (this.inFlight && this.inFlight.seq === seq) {
      this.inFlight.acked = true;
      this._wake();
    }
  }

  close() {
    this.closed = true;
    this._wake();
  }

  /**
   * The next step: `{ acks, frame: [generation, frame] | null }`, or null once
   * closed. A frame is handed out only when none is in flight.
   */
  async next() {
    for (;;) {
      if (this.closed) return null;
      const inFlight = this.inFlight;
      if (inFlight && !inFlight.acked) {
        const left = this.ackTimeoutMs - (Date.now() - inFlight.sent);
        if (left > 0) {
          await this._wait(left);
          continue;
        }
      }
      if (this.inFlight) {
        if (this.inFlight.ack) this.owed.push(this.inFlight.ack);
        this.inFlight = null;
      }
      if (this.waiting) {
        const { generation, frame, ack } = this.waiting;
        this.waiting = null;
        this.seq += 1;
        frame.seq = this.seq;
        this.inFlight = { seq: this.seq, sent: Date.now(), ack, acked: false };
        return { acks: this.owed.splice(0), frame: [generation, frame] };
      }
      if (this.owed.length) return { acks: this.owed.splice(0), frame: null };
      await this._wait(null);
    }
  }

  _wait(millis) {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const inFlight = this.inFlight;
      let delay = 0;
      if (millis != null) delay = millis;
      else if (inFlight && !inFlight.acked) {
        delay = Math.max(0, this.ackTimeoutMs - (Date.now() - inFlight.sent));
      }
      if (inFlight && !inFlight.acked) {
        this.timer = setTimeout(() => this._wake(), delay);
        this.timer.unref?.();
      }
    });
  }

  _wake() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** A panel size within bounds, CSS and device pixels both (`model::Size`). */
function makeSize(w, h, dpr) {
  const sides = Number.isInteger(w) && Number.isInteger(h) && w >= 1 && w <= MAX_EDGE && h >= 1 && h <= MAX_EDGE;
  const ratio = typeof dpr === 'number' && dpr >= 0.25 && dpr <= 8;
  const device = ratio && Math.max(w, h) * dpr <= MAX_DEVICE_EDGE;
  if (!sides || !device) throw new Error(`invalid panel size ${w}x${h} at ${dpr}x`);
  return { w, h, dpr, px: (css) => Math.round(css * dpr) };
}

/** The panel's `state` payload (`ViewState`). */
function newState(status) {
  return {
    status,
    error: null,
    url: '',
    loading: false,
    canBack: false,
    canForward: false,
    annotate: false,
  };
}

const TARGET_EVENTS = new Set([
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.targetDestroyed',
]);

const PAGE_EVENTS = new Set([
  'Page.frameNavigated',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.loadEventFired',
  'Page.navigatedWithinDocument',
]);

/** The panel's view of one tab's Chromium. */
class View extends EventEmitter {
  /**
   * `broker.client()` is the browser-level connection this View reads
   * through; pass `client` instead to adopt one. Events are delivered as
   * `{ type, value }` messages on `"message"` (`tabs`, `state`), plus
   * `"panelRelease"` (panel mouse release timestamp) and `"show"` (the page
   * a follow asks for).
   */
  constructor({ broker = null, client = null, sessionId = null, followHoldMs = FOLLOW_HOLD_MS, ackTimeoutMs = ACK_TIMEOUT_MS, now = Date.now } = {}) {
    super();
    this.client = client ?? (broker ? broker.client() : null);
    this.sid = sessionId;
    this.now = now;
    this.followHoldMs = followHoldMs;
    this.holdMs = followHoldMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this._listened = new WeakSet();

    this.pageList = [];
    this.active = null;
    this.activations = 0;
    this.following = false;
    this.pendingFollow = null;
    this.heldFollow = null;
    this.userActivated = null;
    this.publishedTabs = [];
    this.state = newState('starting');
    this.size = { w: 1, h: 1, dpr: 1 };
    this.heals = 0;
    this.restartPending = false;
    this.lastRestart = null;

    this.closed = false;
    this.panelReleaseAt = null;
    this.inputs = [];
    this._inputDraining = false;

    this.frames = null;
    this.screencast = null;
    this._holdTimer = null;
    this._restartTimer = null;

    if (this.client) this._listen(this.client);
  }

  // ── connection ───────────────────────────────────────────────────────────

  _listen(client) {
    if (!client || typeof client.on !== 'function' || this._listened.has(client)) return;
    this._listened.add(client);
    client.on('event', (event) => this._handleEvent(event ?? {}));
    client.on('close', () => this._lostConnection());
  }

  _lostConnection() {
    if (this.closed) return;
    this.updateState((state) => {
      state.status = 'stopped';
      state.error = 'browser connection lost';
    });
    this.emit('close');
  }

  /** Send a command whose reply nobody reads (Rust's `notify`). */
  _notify(method, params = {}, { sessionId } = {}) {
    if (!this.client) return;
    this.client.send(method, params, sessionId ? { sessionId } : undefined).catch(() => {});
  }

  /**
   * A CDP command; a page command refused while its page commits a
   * navigation (`NOT_ATTACHED`) is sent again, so a click on back or a resize
   * right after a navigation still lands.
   */
  async call(method, params = {}, { sessionId } = {}) {
    if (!this.client) throw new Error('cdp not connected');
    let tries = 1;
    for (;;) {
      try {
        return await this.client.send(method, params, sessionId ? { sessionId } : undefined);
      } catch (error) {
        if (sessionId && tries < NOT_ATTACHED_TRIES && messageOf(error) === NOT_ATTACHED) {
          tries += 1;
          await sleep(NOT_ATTACHED_PAUSE_MS);
          continue;
        }
        throw error;
      }
    }
  }

  // ── pages and tabs ───────────────────────────────────────────────────────

  /** Discover the pages already there (Rust `open`'s first half). */
  async discover() {
    await this.call('Target.setDiscoverTargets', { discover: true });
    const targets = await this.call('Target.getTargets', {});
    for (const info of targets?.targetInfos ?? []) {
      if (info?.type === 'page') this._upsertPage(info);
    }
    this._publishTabs();
    return this.pages();
  }

  /** Start following the agent (Rust's `open` sets this after its switch). */
  startFollowing() {
    this.following = true;
    return this;
  }

  /** Insert or update a page from a `targetInfo`; true when it is new. */
  _upsertPage(info = {}) {
    const targetId = info.targetId;
    if (typeof targetId !== 'string') return false;
    const title = typeof info.title === 'string' ? info.title : '';
    const url = typeof info.url === 'string' ? info.url : '';
    const page = this.pageList.find((p) => p.targetId === targetId);
    if (page) {
      page.title = title;
      page.url = url;
      return false;
    }
    this.pageList.push({ targetId, title, url });
    return true;
  }

  _isListed(targetId) {
    return this.pageList.some((p) => p.targetId === targetId);
  }

  page(targetId) {
    return this.pageList.find((p) => p.targetId === targetId) ?? null;
  }

  /** The page list the panel renders (`TabInfo[]`). */
  pages() {
    const active = this.active?.targetId ?? null;
    return this.pageList.map((p) => ({
      targetId: p.targetId,
      title: p.title,
      url: p.url,
      active: p.targetId === active,
    }));
  }

  /** Drop page `targetId`; a follow waiting for it is dropped too. */
  removePage(targetId) {
    const before = this.pageList.length;
    this.pageList = this.pageList.filter((p) => p.targetId !== targetId);
    for (const key of ['pendingFollow', 'heldFollow']) {
      if (this[key] === targetId) this[key] = null;
    }
    return before !== this.pageList.length;
  }

  _publishTabs() {
    const tabs = this.pages();
    const unchanged =
      tabs.length === this.publishedTabs.length &&
      tabs.every((tab, i) => {
        const old = this.publishedTabs[i];
        return tab.targetId === old.targetId && tab.title === old.title && tab.url === old.url && tab.active === old.active;
      });
    if (unchanged) return null;
    this.publishedTabs = tabs;
    this.emitMessage('tabs', tabs);
    return tabs;
  }

  // ── active page ──────────────────────────────────────────────────────────

  /** Show `targetId` through `sessionId`; returns the new generation. */
  setActive(targetId, sessionId) {
    this.activations += 1;
    this.active = { targetId, sessionId, generation: this.activations, shown: false };
    this._publishTabs();
    return this.activations;
  }

  markShown(generation) {
    if (this.active && this.active.generation === generation) this.active.shown = true;
  }

  /** `(sessionId, generation)` of the page shown now; throws when none. */
  activation() {
    if (!this.active) throw new Error('no page open');
    return { sessionId: this.active.sessionId, generation: this.active.generation };
  }

  activeSession() {
    return this.activation().sessionId;
  }

  // ── follow and hold ──────────────────────────────────────────────────────

  /** The user acted (picked a tab, typed, clicked): hold the view. */
  hold(millis) {
    this.userActivated = this.now();
    if (millis != null) this.holdMs = millis;
    this._armHold();
    return this;
  }

  _held() {
    return this.userActivated != null && this.now() - this.userActivated < this.holdMs;
  }

  /**
   * The agent worked in `targetId`: true when the view should show it now,
   * false when it is held by the user's recent choice (then kept as the page
   * to show when the hold ends) or not listed yet (then kept until it
   * appears). The newest report replaces an older one.
   */
  follow(targetId) {
    if (!this.following) return false;
    this.pendingFollow = null;
    this.heldFollow = null;
    if (!this._isListed(targetId)) {
      this.pendingFollow = targetId;
      return false;
    }
    if (this._held()) {
      this.heldFollow = targetId;
      this._armHold();
      return false;
    }
    return true;
  }

  /** When the hold keeping a follow back ends, if one is kept. */
  followDeadline() {
    if (this.heldFollow == null) return null;
    if (this.userActivated == null) return null;
    return this.userActivated + this.holdMs;
  }

  /** The follow the hold kept back, once the hold has ended. */
  takeHeldFollow() {
    if (this._held()) return null;
    const target = this.heldFollow;
    this.heldFollow = null;
    return target;
  }

  _armHold() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    const deadline = this.followDeadline();
    if (deadline == null || this.closed) return;
    const delay = Math.max(0, deadline - this.now());
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null;
      const target = this.takeHeldFollow();
      if (target != null && !this.closed) this.emit('show', target);
    }, delay);
    this._holdTimer.unref?.();
  }

  /**
   * Handle a target event: keep the pages current and give back the page to
   * show, if it is the one a follow was waiting for and the user's choice
   * does not hold the view back.
   */
  applyTargetEvent(method, params = {}) {
    if (method === 'Target.targetDestroyed') {
      const targetId = params.targetId;
      if (typeof targetId !== 'string') return null;
      this.removePage(targetId);
      // A closed page that was shown leaves the view with no page.
      if (this.active && this.active.targetId === targetId) this.active = null;
      this._publishTabs();
      return null;
    }
    const info = params.targetInfo ?? {};
    if (info.type !== 'page') return null;
    const isNew = this._upsertPage(info);
    const targetId = info.targetId;
    if (typeof targetId !== 'string') return null;
    this._publishTabs();
    const awaited = method === 'Target.targetCreated' && isNew && this.pendingFollow === targetId;
    if (!awaited) return null;
    return this.follow(targetId) ? targetId : null;
  }

  // ── state ────────────────────────────────────────────────────────────────

  /** Change the panel state; a changed state is emitted once. */
  updateState(change) {
    const next = { ...this.state };
    change(next);
    const keys = Object.keys(next);
    const changed = keys.length !== Object.keys(this.state).length || keys.some((key) => next[key] !== this.state[key]);
    if (!changed) return this.state;
    this.state = next;
    this.emitMessage('state', next);
    return next;
  }

  emitMessage(type, value) {
    this.emit('message', { type, value });
  }

  setSize(w, h, dpr) {
    this.size = makeSize(w, h, dpr);
    return this.size;
  }

  // ── screencast ───────────────────────────────────────────────────────────

  /**
   * Size the shown page's viewport and start its screencast. Frames reach
   * `onFrame` one at a time, each acked by `frameAck(frame.seq)`.
   */
  async startScreencast(client = this.client, onFrame = () => {}, options = {}) {
    if (!client) throw new Error('cdp not connected');
    if (options.width != null) this.setSize(options.width, options.height, options.dpr);
    // A View built without a broker adopts the client it is driven with.
    if (this.client == null) this.client = client;
    const sessionId = this.activeSession();
    this._listen(client);
    this.frames?.close();
    this.frames = new FrameFlow({ ackTimeoutMs: options.ackTimeoutMs ?? this.ackTimeoutMs });
    this.screencast = { client, onFrame };
    // Headless Chromium occasionally accepts Page.startScreencast and then
    // sends nothing (measured: first open after a long idle, an open onto
    // an already-screencasting view). One watchdog restart per start turns
    // that silent dead panel into frames; a painting panel needs none.
    this._frameSeen = false;
    // The token keeps a later start's watchdog from restarting twice.
    const token = (this._screencastToken += 1);
    // Headless Chromium occasionally accepts Page.startScreencast and then
    // sends nothing (measured on Chrome-for-Testing 150 and, rarely, system
    // Chrome; a stop+start always healed it). Retry the start until a frame
    // arrives, at most SCREENCAST_HEALS times.
    const probe = (tries) => {
      setTimeout(() => {
        if (this._screencastToken !== token || this._frameSeen || this.closed) return;
        if (tries <= 0) return;
        this.restartScreencast().catch(() => {});
        probe(tries - 1);
      }, 2500).unref?.();
    };
    probe(3);
    await this.call(
      'Emulation.setDeviceMetricsOverride',
      { width: this.size.w, height: this.size.h, deviceScaleFactor: this.size.dpr, mobile: false },
      { sessionId },
    );
    this._notify('Emulation.setFocusEmulationEnabled', { enabled: true }, { sessionId });
    await this.restartScreencast(sessionId);
    this.updateState((state) => {
      state.status = 'running';
    });
    this._drainFrames();
    return this;
  }

  /** Restart `sessionId`'s screencast without touching its viewport. */
  async restartScreencast(sessionId = this.activeSession()) {
    this._notify('Page.stopScreencast', {}, { sessionId });
    this.frames?.clear();
    return this.call(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: 70,
        maxWidth: Math.round(this.size.w * this.size.dpr),
        maxHeight: Math.round(this.size.h * this.size.dpr),
        everyNthFrame: 1,
      },
      { sessionId },
    );
  }

  /** The panel painted or dropped frame `seq`: the next one may follow. */
  frameAck(seq) {
    this.frames?.ack(seq);
  }

  _handleEvent({ method, params, sessionId }) {
    if (typeof method !== 'string') return;
    if (method === 'Page.screencastFrame') {
      this._onFrame(sessionId, params ?? {});
      return;
    }
    if (TARGET_EVENTS.has(method)) {
      const target = this.applyTargetEvent(method, params ?? {});
      if (target != null) this.emit('show', target);
      return;
    }
    // Only the shown page's session speaks for the panel's state.
    if (PAGE_EVENTS.has(method)) {
      if (this.active == null || sessionId !== this.active.sessionId) return;
      this._onPageEvent(method, params ?? {});
    }
  }

  _onPageEvent(method, params) {
    const active = this.active;
    const mainFrame = active && (params.frame?.id === active.targetId || params.frameId === active.targetId);
    if (method === 'Page.frameNavigated' && params.frame?.parentId == null) {
      // A failed load commits an error page that names the URL.
      const failed = typeof params.frame?.unreachableUrl === 'string' ? params.frame.unreachableUrl : null;
      const url = failed ?? (typeof params.frame?.url === 'string' ? params.frame.url : null);
      this.updateState((state) => {
        if (url != null) state.url = url;
        state.error = failed == null ? null : `could not load ${failed}`;
      });
      const page = active && this.page(active.targetId);
      if (page && url != null && page.url !== url) {
        page.url = url;
        this._publishTabs();
      }
      this.refreshHistory().catch(() => {});
    } else if (method === 'Page.frameStartedLoading' && mainFrame) {
      this.updateState((state) => {
        state.loading = true;
      });
    } else if (method === 'Page.frameStoppedLoading' && mainFrame) {
      this.updateState((state) => {
        state.loading = false;
      });
      // Once the page stopped loading the history is settled.
      this.refreshHistory().catch(() => {});
    } else if (method === 'Page.loadEventFired') {
      this.updateState((state) => {
        state.loading = false;
      });
      this.refreshTitle().catch(() => {});
    } else if (method === 'Page.navigatedWithinDocument') {
      this.refreshHistory().catch(() => {});
      this.refreshTitle().catch(() => {});
    }
  }

  /** A page that finished loading before this session's `Page.enable`
   *  never emits `loadEventFired`/`frameStoppedLoading` to it, so its title
   *  and history would stay at discovery values forever (measured: a
   *  data: page's strip showed the raw URI, a reloaded page kept a stale
   *  title). Pull both once right after the attach. */
  async syncAfterAttach() {
    await Promise.allSettled([this.refreshHistory(), this.refreshTitle()]);
    return this.state;
  }

  /** `canBack`/`canForward` and the URL, from the navigation history. */
  async refreshHistory() {
    if (this.active == null) return this.state;
    const history = await this.call('Page.getNavigationHistory', {}, { sessionId: this.active.sessionId });
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const index = Number.isInteger(history?.currentIndex) && history.currentIndex >= 0 ? history.currentIndex : 0;
    const url = entries[index]?.url;
    return this.updateState((state) => {
      state.canBack = index > 0;
      state.canForward = index + 1 < entries.length;
      if (typeof url === 'string') state.url = url;
    });
  }

  /** The shown page's title as Chromium has it now. */
  async refreshTitle() {
    const targetId = this.active?.targetId;
    if (targetId == null) return this.state;
    const info = await this.call('Target.getTargetInfo', { targetId });
    const page = this.page(targetId);
    if (page && info?.targetInfo) {
      this._upsertPage(info.targetInfo);
      this._publishTabs();
    }
    return this.state;
  }

  _screencastToken = 0;

  _onFrame(session, params) {
    const frames = this.frames;
    if (!frames || !this.screencast) return;
    this._frameSeen = true;
    const ack = chromiumAck(session, params);
    const data = params.data;
    if (typeof data !== 'string') {
      if (ack) this._ackChromium([ack]); // not queued: ack or Chromium stops sending
      return;
    }
    const active = this.active;
    if (!active || active.sessionId !== session) {
      if (ack) this._ackChromium([ack]);
      return; // a page we no longer show
    }
    const metadata = params.metadata ?? {};
    const cssNumber = (key, fallback) => {
      const value = Number(metadata[key]);
      return Number.isFinite(value) ? Math.round(value) : fallback;
    };
    // The emulation pins the page viewport to exactly this.size, so the
    // metadata can never legitimately exceed it — yet headless Chromium
    // alternates device px (css*dpr) and window px here (measured
    // 1058x1284 / 1280x657 for a 529x642 viewport), which would map panel
    // clicks outside the page. Clamp to the requested emulation; the JPEG
    // aspect still matches (device px is an exact multiple).
    const cssW = Math.min(cssNumber('deviceWidth', this.size.w), this.size.w);
    const cssH = Math.min(cssNumber('deviceHeight', this.size.h), this.size.h);
    const frame = Frame.create(data, cssW, cssH);
    const proportioned = frame.hasCssProportions();
    const restart = this._frameNeedsRestart(cssW, cssH, proportioned);
    if (proportioned) frames.put(active.generation, frame, ack);
    else if (ack) this._ackChromium([ack]);
    if (restart) this._restartSoon();
  }

  _ackChromium(acks) {
    const client = this.screencast?.client ?? this.client;
    if (!client) return;
    for (const ack of acks) {
      client.send('Page.screencastFrameAck', { sessionId: ack.id }, { sessionId: ack.session }).catch(() => {});
    }
  }

  async _drainFrames() {
    const frames = this.frames;
    while (frames) {
      const step = await frames.next();
      if (!step) return;
      this._ackChromium(step.acks);
      if (!step.frame) continue;
      const [generation, frame] = step.frame;
      const current = !this.closed && this.active && this.active.generation === generation;
      let delivered = false;
      if (current) {
        try {
          this.screencast.onFrame(frame);
          delivered = true;
        } catch {
          delivered = false;
        }
      }
      if (!delivered) frames.ack(frame.seq);
    }
  }

  /** Whether a frame calls for a screencast restart, at most MAX_HEALS. */
  _frameNeedsRestart(cssW, cssH, proportioned) {
    if (proportioned && cssW === this.size.w && cssH === this.size.h) {
      this.heals = 0;
      return false;
    }
    if (this.lastRestart != null && this.now() - this.lastRestart >= HEAL_REFILL_MS) this.heals = 0;
    if (this.restartPending || this.heals >= MAX_HEALS) return false;
    this.heals += 1;
    this.restartPending = true;
    return true;
  }

  _restartWait() {
    if (this.lastRestart == null) return 0;
    return Math.max(0, HEAL_GAP_MS - (this.now() - this.lastRestart));
  }

  restartStarted() {
    this.restartPending = false;
    this.lastRestart = this.now();
  }

  _restartSoon() {
    if (this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.closed || !this.active) return;
      this.restartStarted();
      this.restartScreencast(this.active.sessionId).catch(() => {});
    }, this._restartWait());
    this._restartTimer.unref?.();
  }

  // ── input ────────────────────────────────────────────────────────────────

  /** The panel released a mouse button on the page. */
  notePanelRelease(at = this.now()) {
    this.panelReleaseAt = at;
    this.emit('panelRelease', at);
  }

  /** Whether the panel released a mouse button in the last `within` ms. */
  panelReleasedWithin(within, at = this.now()) {
    return this.panelReleaseAt != null && at - this.panelReleaseAt <= within;
  }

  /**
   * Queue a gesture for the page shown now; sent in order, dropped (not
   * redirected) if another page is shown by the time it is sent. Acting on
   * the page (anything but moving the pointer) holds the view there.
   */
  async input(method, params = {}) {
    if (this.closed) throw new Error('browser view closed');
    const { sessionId, generation } = this.activation();
    const moving = method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved';
    if (!moving) this.hold();
    if (this.inputs.length >= INPUT_QUEUE) throw new Error('browser is busy');
    const release = method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased';
    return new Promise((resolve, reject) => {
      this.inputs.push({ session: sessionId, generation, method, params, release, resolve, reject });
      this._drainInput();
    });
  }

  async _drainInput() {
    if (this._inputDraining) return;
    this._inputDraining = true;
    try {
      while (this.inputs.length) {
        const item = this.inputs.shift();
        if (this.closed) {
          item.reject(new Error('browser view closed'));
          continue;
        }
        const current = this.active && this.active.generation === item.generation && this.active.sessionId === item.session;
        if (!current) {
          item.resolve(); // an earlier activation's gesture: dropped
          continue;
        }
        if (item.release) this.notePanelRelease();
        try {
          await this.client.send(item.method, item.params, { sessionId: item.session });
          item.resolve();
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this._inputDraining = false;
    }
  }

  // ── close ────────────────────────────────────────────────────────────────

  /** Stop the screencast and drop the connection. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.updateState((state) => {
      state.status = 'idle';
      state.annotate = false;
      state.error = null;
    });
    const frames = this.frames;
    this.frames = null;
    frames?.close();
    if (this.screencast) {
      const session = this.active?.sessionId;
      if (session) this._notify('Page.stopScreencast', {}, { sessionId: session });
      this.screencast = null;
    }
    clearTimeout(this._holdTimer);
    clearTimeout(this._restartTimer);
    this._holdTimer = null;
    this._restartTimer = null;
    this.emit('close');
    // Rust closes the view's OWN BrokerClient, which detaches only that
    // session; the port's client is the manager's shared pipe, so closing
    // it would kill every other view. Detach this session instead.
    const session = this.active?.sessionId;
    if (session) this._notify('Target.detachFromTarget', { sessionId: session });
  }
}

const MOUSE_TYPES = ['mousePressed', 'mouseReleased', 'mouseMoved'];
const MOUSE_BUTTONS = ['none', 'left', 'middle', 'right', 'back', 'forward'];
const KEY_TYPES = ['keyDown', 'keyUp', 'rawKeyDown', 'char'];

/**
 * The frontend's InputEvent -> CDP command, mirroring
 * src-tauri/src/browser/view/input.rs `to_command` exactly (same allowed
 * sets, same param names, same refusals).
 */
function inputEventToCommand(ev = {}) {
  const oneOf = (what, value, allowed) => {
    if (!allowed.includes(value)) throw new Error(`invalid ${what} ${JSON.stringify(value)}`);
  };
  switch (ev.kind) {
    case 'mouse': {
      oneOf('mouse type', ev.type, MOUSE_TYPES);
      oneOf('mouse button', ev.button, MOUSE_BUTTONS);
      return ['Input.dispatchMouseEvent', {
        type: ev.type, x: ev.x, y: ev.y, button: ev.button,
        buttons: ev.buttons, clickCount: ev.clickCount, modifiers: ev.modifiers,
      }];
    }
    case 'wheel':
      return ['Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: ev.x, y: ev.y,
        deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers,
      }];
    case 'key': {
      oneOf('key type', ev.type, KEY_TYPES);
      const params = {
        type: ev.type, key: ev.key, code: ev.code, modifiers: ev.modifiers,
        windowsVirtualKeyCode: ev.windowsVirtualKeyCode,
      };
      if (ev.text != null) params.text = ev.text;
      return ['Input.dispatchKeyEvent', params];
    }
    case 'text':
      return ['Input.insertText', { text: ev.text }];
    default:
      throw new Error(`invalid input event kind ${JSON.stringify(ev.kind)}`);
  }
}

module.exports = {
  inputEventToCommand,
  View,
  FrameFlow,
  Frame,
  chromiumAck,
  jpegSize,
  makeSize,
  newState,
  messageOf,
  ACK_TIMEOUT_MS,
  FOLLOW_HOLD_MS,
  INPUT_QUEUE,
  NOT_ATTACHED,
};