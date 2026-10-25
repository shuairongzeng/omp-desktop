#!/usr/bin/env node
// Regression script for src/app/remote-transport.js — the phone side of
// remote control: the window.__TAURI__ WebSocket shim a plain browser
// gets when the relay serves the app. Covers the inert-under-real-Tauri
// guard, the boot states (pairing landing, selected device, paired-but-
// unselected picker hand-off, unpaired overlay), the multi-device
// registry interactions (legacy-key migration, appending pairings, the
// `device` frame routing), the pre-open send queue and its on-open flush
// order, res/evt frame handling, per-name sub refcounting, the
// noop/unsupported command walls, and the desktop-offline overlay with
// its switch-device action — plus the in-place reconnect: a non-blocking
// banner instead of a page reload, exponential backoff (1s→2s→…→15s cap),
// a reopen flush that skips timed-out invokes and queued subs in favor of
// one fresh sub per listener, _remoteResync on reopen and peer-wake, the
// 500-frame queue bound, and immediate reconnect on
// visibilitychange/pageshow.
// Run: node tests/test-remote-transport.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/remote-transport.js"), "utf8");
const devicesSrc = readFileSync(join(root, "src/app/remote-devices.js"), "utf8");
// The E2E chain the shim loads at runtime: the vendored noble bundle
// (window.NOBLE_E2E) then remote-crypto.js (window.OMP_E2E). The bundle
// is an IIFE with no imports — a Function body, same as the modules.
const nobleSrc = readFileSync(join(root, "src/noble-e2e.js"), "utf8");
const cryptoSrc = readFileSync(join(root, "src/app/remote-crypto.js"), "utf8");

/** A real master secret + the desktop side of the crypto, so tests can
 *  run a truthful handshake/enc exchange against the shim. Both ends use
 *  the same vendored noble primitives (their cross-implementation
 *  agreement is tests/test-remote-crypto.mjs's job). */
const cryptoHelpers = (() => {
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", nobleSrc)(win);
  // eslint-disable-next-line no-new-func
  new Function("window", cryptoSrc)(win);
  const E = win.OMP_E2E;
  const mkPairing = (pairId) => {
    const phone = E.pairEph();
    const desk = E.pairEph();
    const ms = E.masterSecret(phone.priv, desk.pub, phone.pub, desk.pub);
    return { phone, desk, ms };
  };
  const sha256Hex = (s) => E.sha256Hex(s);
  /** The desktop's hs reply for a phone hs frame: its own eph, and the
   *  MAC keyed by the MS over "D"||desk_pk||phone_pk. */
  const deskHsFrame = (ms, phonePkB64) => {
    const eph = E.pairEph();
    const phonePk = E.b64Bytes(phonePkB64);
    return {
      t: "hs", v: 2,
      pk: E.b64From(eph.pub),
      mac: E.b64From(E.macDesk(ms, eph.pub, phonePk)),
      __priv: eph.priv, // test-only: to derive the session keys
    };
  };
  /** Seal a frame desktop→phone: derive the SAME keys the phone will
   *  derive (X25519(desk_priv, phone_pk), salt phone||desk) and seal
   *  with K_d2c... from the phone's view d2c opens it, so the desktop
   *  seals with the key the phone calls d2c. */
  const sealFromDesk = (deskPriv, phonePkB64, deskPk, seq, frame) => {
    const keys = E.sessionKeys(deskPriv, E.b64Bytes(phonePkB64), E.b64Bytes(phonePkB64), deskPk);
    return E.seal(keys.d2c, seq, frame);
  };
  return { E, mkPairing, sha256Hex, deskHsFrame, sealFromDesk };
})();

// ── the browser the shim boots in ──────────────────────────────────────────
// No real network: WebSocket is a fake whose open/message/close the test
// triggers by hand, and setTimeout records instead of firing, so nothing
// ever depends on the event loop. window and document record their event
// listeners so visibilitychange / pageshow can be dispatched by hand.

function makeEnv(opts = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = []; // parsed frames
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    message(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
    shut() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  // setTimeout records {fn, delay} instead of firing. The delay is the
  // discriminator tests use: the invoke timeout always passes 30000,
  // the reconnect backoff passes its current wait (≤15000).
  const timers = new Map();
  let timerSeq = 0;
  const fakeTimers = {
    setTimeout: (fn, delay) => { const id = ++timerSeq; timers.set(id, { fn, delay: delay ?? 0 }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    list: () => [...timers.entries()].map(([id, t]) => ({ id, delay: t.delay })),
    run: (id) => { const t = timers.get(id); if (!t) return false; timers.delete(id); t.fn(); return true; },
    runAll: () => { for (const [id, t] of [...timers.entries()]) { timers.delete(id); t.fn(); } },
    pending: () => timers.size,
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  if (opts.auth) localStorage.setItem("omp-remote:auth", JSON.stringify(opts.auth));
  if (opts.devices) localStorage.setItem("omp-remote:devices", JSON.stringify(opts.devices));
  // The E2E chain the shim's <script> order gives a real page: noble
  // first (NOBLE_E2E), then remote-crypto.js (OMP_E2E). Devices written
  // above get their ms injected here, so a plain opts.devices reads like
  // a real R8 pairing unless opts.noMs strips it on purpose.
  const pairing = opts.pairing ?? cryptoHelpers.mkPairing("pair-test");
  if (opts.devices && !opts.noMs) {
    localStorage.setItem("omp-remote:devices", JSON.stringify({
      ...opts.devices,
      devices: opts.devices.devices.map((d) => ({
        ...d,
        ms: d.ms ?? cryptoHelpers.E.b64From(pairing.ms),
      })),
    }));
  }
  if (opts.auth && !opts.noMs) {
    localStorage.setItem("omp-remote:auth", JSON.stringify({
      ...opts.auth,
      ms: opts.auth.ms ?? cryptoHelpers.E.b64From(pairing.ms),
    }));
  }

  const replaceCalls = [];
  const reloadCalls = [];
  const location = {
    protocol: opts.protocol ?? "https:",
    host: opts.host ?? "relay.example.com",
    pathname: opts.pathname ?? "/",
    hash: opts.hash ?? "",
    replace: (to) => { replaceCalls.push(to); },
    reload: () => { reloadCalls.push(1); },
  };

  const classList = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag,
      id: "",
      style: {},
      textContent: "",
      innerHTML: "",
      children: [],
      _bySel: new Map(),
      appendChild(child) { this.children.push(child); return child; },
      querySelector(sel) {
        if (!this._bySel.has(sel)) this._bySel.set(sel, mkEl("span"));
        return this._bySel.get(sel);
      },
      addEventListener() {},
    };
    return el;
  };
  const documentElement = mkEl("html");
  documentElement.classList = { add: (c) => classList.push(c) };

  // window/document event listeners are recorded, not dropped: the shim
  // registers visibilitychange (document) and pageshow (window) wakeups.
  const docListeners = new Map();
  const record = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const dispatchFrom = (map) => (type, ev) => {
    for (const fn of map.get(type) || []) fn(ev || {});
  };
  const document = {
    readyState: "complete",
    hidden: false,
    documentElement,
    head: mkEl("head"),
    body: mkEl("body"),
    createElement: (tag) => mkEl(tag),
    addEventListener: (type, fn) => record(docListeners, type, fn),
  };
  const dispatchDocumentEvent = dispatchFrom(docListeners);

  const winListeners = new Map();
  const win = {
    addEventListener: (type, fn) => record(winListeners, type, fn),
  };
  if (opts.tauri) win.__TAURI__ = opts.tauri;
  const dispatchWindowEvent = dispatchFrom(winListeners);

  const quiet = { log() {}, warn() {}, error() {} };
  // The paired-desktop registry the shim reads at boot — the real pure
  // module (it has no DOM or socket surface of its own).
  // eslint-disable-next-line no-new-func
  new Function("window", "localStorage", "console", devicesSrc)(win, localStorage, quiet);
  // The E2E modules, in page order: the noble bundle installs
  // NOBLE_E2E, remote-crypto.js builds OMP_E2E on top of it.
  // eslint-disable-next-line no-new-func
  new Function("window", "atob", "btoa", nobleSrc)(win, atob, btoa);
  // eslint-disable-next-line no-new-func
  new Function("window", "atob", "btoa", cryptoSrc)(win, atob, btoa);
  // The picker stays a fake: all the transport owes it is delegation —
  // open() when nothing is selected, noteDevice() for `device` frames.
  // (Its own behaviour is tests/test-remote-hub.mjs.) opts.hub === null
  // omits it entirely, proving the shim's optional chaining.
  const hubCalls = { open: 0, noteDevice: [] };
  if (opts.hub !== null) {
    win.OMP_REMOTE_HUB = {
      open: () => { hubCalls.open++; },
      close: () => {},
      isOpen: () => false,
      current: () => null,
      noteDevice: (device, frame) => { hubCalls.noteDevice.push([device, frame]); },
    };
  }
  new Function(
    "window", "document", "localStorage", "location", "WebSocket",
    "setTimeout", "clearTimeout", "console", "navigator",
    src,
  )(win, document, localStorage, location, FakeWebSocket,
    fakeTimers.setTimeout, fakeTimers.clearTimeout, quiet,
    opts.navigator ?? { userAgentData: { platform: "Android", mobile: true } });

  /** The session keys for ONE socket's hs exchange (the desktop half):
   *  c2d opens what the phone sealed, d2c seals what the phone opens. */
  const keysOf = (sock) => {
    const reply = sock.__deskReply;
    if (!reply) throw new Error("answerHs(sock) first");
    const phonePk = cryptoHelpers.E.b64Bytes(sock.__phonePk);
    return cryptoHelpers.E.sessionKeys(
      reply.__priv, phonePk, phonePk, cryptoHelpers.E.b64Bytes(reply.pk));
  };

  return {
    win, document, location, localStorage, sockets,
    replaceCalls, reloadCalls, classList, fakeTimers, hubCalls,
    saved: () => JSON.parse(localStorage.getItem("omp-remote:devices") || "null"),
    dispatchWindowEvent, dispatchDocumentEvent,
    overlay: () => document.body.children.find((c) => c.id === "remote-overlay") || null,
    banner: () => document.body.children.find((c) => c.id === "remote-banner") || null,
    pairing,
    // correct MAC, so a test that opens and answers the handshake gets
    // a READY session without duplicating crypto here.
    answerHs: (sock) => {
      const hsFrame = sock.sent.find((f) => f.t === "hs");
      if (!hsFrame) throw new Error("no hs frame on the socket");
      const reply = cryptoHelpers.deskHsFrame(pairing.ms, hsFrame.pk);
      sock.message({ t: "hs", v: 2, pk: reply.pk, mac: reply.mac });
      // The reply (with its __priv) AND the phone's hs pk are stashed
      // per-socket: a test may clear sock.sent, so key derivation must
      // not depend on the wire log staying intact.
      sock.__deskReply = reply;
      sock.__phonePk = hsFrame.pk;
      return reply;
    },
    keysFor: (sock) => {
      const reply = sock.__deskReply;
      if (!reply) throw new Error("answerHs(sock) first");
      const phonePk = cryptoHelpers.E.b64Bytes(sock.__phonePk);
      return cryptoHelpers.E.sessionKeys(
        reply.__priv, phonePk, phonePk, cryptoHelpers.E.b64Bytes(reply.pk));
    },
    /** Open every enc envelope the phone sent on this socket, back into
     *  its plaintext frames. */
    unwrapSent: (sock) => {
      const keys = keysOf(sock);
      return sock.sent.filter((f) => f.t === "enc").map((env) =>
        cryptoHelpers.E.open(keys.c2d, -1, env).frame);
    },
    /** Seal a frame as the DESKTOP for ONE socket's session (the
     *  phone's d2c view): a desktop→phone envelope with the given seq. */
    sealDesk: (sock, seq, frame) => cryptoHelpers.E.seal(keysOf(sock).d2c, seq, frame),
  };
}

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(label);
    console.error(`FAIL: ${label}`);
    console.error(err instanceof Error ? err.stack : err);
    return;
  }
  passed++;
}
const drain = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

// Fire the armed reconnect timer (never one of the 30s invoke timeouts).
const runReconnect = (E) => {
  const t = E.fakeTimers.list().find((x) => x.delay !== 30000);
  assert.ok(t, "a reconnect timer is armed");
  E.fakeTimers.run(t.id);
};

// ── checks ─────────────────────────────────────────────────────────────────

await check("under a real Tauri webview the shim stays inert", async () => {
  const real = { core: { invoke: () => {} }, event: { listen: () => {} } };
  const E = makeEnv({ tauri: real });
  assert.equal(E.sockets.length, 0);
  assert.equal(E.win.__TAURI__, real); // untouched, not replaced by the shim
  assert.equal(E.win.__OMP_REMOTE__, undefined);
  assert.deepEqual(E.classList, []);
  assert.equal(E.overlay(), null);
});

await check("without stored auth the overlay asks to pair, invokes reject fast, and no socket is opened", async () => {
  const E = makeEnv();
  assert.equal(E.sockets.length, 0);
  const ov = E.overlay();
  assert.ok(ov, "the pairing overlay is mounted");
  assert.equal(ov.style.display, "flex");
  assert.notEqual(ov.querySelector(".ro-title").textContent, "");

  // No pairing: a frame can never reach the desktop, so invoke rejects
  // at once with "not paired" instead of hanging to the 30s timeout —
  // and no timer is ever armed.
  await assert.rejects(E.win.__TAURI__.core.invoke("get_state"), (e) => e.message === "not paired");
  assert.equal(E.sockets.length, 0);
  assert.equal(E.fakeTimers.pending(), 0); // nothing waiting on a timeout
});

await check("with auth: hs first, queued frames stay queued until the MAC verifies, then sealed in order", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1&name=Android%20%C2%B7%20mobile");

  const T = E.win.__TAURI__;
  assert.equal(T.__remoteShim, true);
  assert.equal(E.win.__OMP_REMOTE__, true);
  assert.deepEqual(E.classList, ["remote-shim"]);

  // invokes and a first subscription issued while the socket is connecting
  const p1 = T.core.invoke("get_state");
  const p2 = T.core.invoke("list_tabs", { all: true });
  const evts = [];
  const off1 = await T.event.listen("tab_update", (ev) => evts.push(ev));
  const off2 = await T.event.listen("tab_update", (ev) => evts.push(ev));
  assert.equal(E.sockets[0].sent.length, 0); // nothing on the wire yet

  const sock = E.sockets[0];
  sock.open();
  assert.deepEqual(E.reloadCalls, []); // connecting never reloads

  // THE handshake is the only frame on the wire: contract §hs —
  // v:2, ph (token sha256 hex), pk (fresh eph), mac over "P"||pk.
  assert.equal(sock.sent.length, 1);
  const hsFrame = sock.sent[0];
  assert.equal(hsFrame.t, "hs");
  assert.equal(hsFrame.v, 2);
  assert.equal(hsFrame.ph, cryptoHelpers.sha256Hex("t1"));
  assert.equal(typeof hsFrame.pk, "string");
  assert.equal(typeof hsFrame.mac, "string");
  // the queued invokes are STILL queued — the MAC gates the flush
  assert.equal(sock.sent.length, 1);

  // The desktop answers with its own eph + MAC; the keys derive and the
  // queue flushes — every business frame now an enc envelope, in the
  // order they queued (get_state, list_tabs, one fresh sub).
  const deskReply = E.answerHs(sock);
  assert.equal(sock.sent.length, 4); // hs + 3 envelopes
  assert.equal(sock.sent[1].t, "enc");
  assert.equal(sock.sent[1].seq, 0);
  // The phone's outbound frames are sealed with c2d — the DESKTOP side
  // of that key is what the test must use to open them. Both halves
  // derive from the hs frames both ends published.
  const phonePk = hsFrame.pk;
  const deskKeys = cryptoHelpers.E.sessionKeys(
    deskReply.__priv, cryptoHelpers.E.b64Bytes(phonePk),
    cryptoHelpers.E.b64Bytes(phonePk), cryptoHelpers.E.b64Bytes(deskReply.pk));
  const openPhone = (env) => cryptoHelpers.E.open(deskKeys.c2d, -1, env).frame;
  assert.deepEqual(openPhone(sock.sent[1]), { t: "cmd", id: 1, name: "get_state", args: {} });
  assert.deepEqual(openPhone(sock.sent[2]), { t: "cmd", id: 2, name: "list_tabs", args: { all: true } });
  // the queued sub frame (id 3) was skipped; the wire sub gets id 4
  assert.deepEqual(openPhone(sock.sent[3]), { t: "cmd", id: 4, name: "sub", args: { name: "tab_update" } });


  // out-of-order responses resolve the promise their id belongs to —
  // but replies arrive sealed now: seal with the phone's d2c view.
  const phoneKeys = E.win.OMP_E2E.sessionKeys(
    // the phone holds its own eph priv internally; the test cannot read
    // it, but deskReply.__priv + the public keys is enough to derive the
    // SAME secrets both halves derive.
    deskReply.__priv, cryptoHelpers.E.b64Bytes(phonePk),
    cryptoHelpers.E.b64Bytes(phonePk), cryptoHelpers.E.b64Bytes(deskReply.pk));
  const sealDesk = (seq, frame) => cryptoHelpers.E.seal(phoneKeys.d2c, seq, frame);
  let v1;
  let v2;
  p1.then((v) => { v1 = v; });
  p2.then((v) => { v2 = v; });
  sock.message(sealDesk(0, { t: "res", id: 2, ok: true, value: ["tab-b"] }));
  await drain();
  assert.equal(v1, undefined); // id 1 is still waiting
  assert.deepEqual(v2, ["tab-b"]);
  sock.message(sealDesk(1, { t: "res", id: 1, ok: true, value: { tabs: 0 } }));
  await drain();
  assert.deepEqual(v1, { tabs: 0 });

  // an evt fans out to every callback registered for that name
  sock.message(sealDesk(2, { t: "evt", name: "tab_update", payload: { id: "t9" } }));
  assert.deepEqual(evts, [
    { event: "tab_update", payload: { id: "t9" } },
    { event: "tab_update", payload: { id: "t9" } },
  ]);

  // a failing res rejects with the relay's error text
  let err = null;
  const p3 = T.core.invoke("boom_cmd");
  p3.catch((e) => { err = e; });
  const boomEnv = sock.sent.at(-1);
  assert.equal(boomEnv.t, "enc");
  assert.deepEqual(openPhone(boomEnv), { t: "cmd", id: 5, name: "boom_cmd", args: {} });
  sock.message(sealDesk(3, { t: "res", id: 5, ok: false, error: "relay exploded" }));
  await drain();
  assert.ok(err instanceof Error);
  assert.equal(err.message, "relay exploded");

  // unlisten is refcounted: only the last one sends an unsub (5 frames
  // on the wire: hs + 4 envelopes; the unsub makes 6)
  off1();
  assert.equal(sock.sent.length, 5); // still one holder left, nothing sent
  off2();
  assert.equal(sock.sent.length, 6);
  assert.deepEqual(openPhone(sock.sent[5]), { t: "cmd", id: 6, name: "unsub", args: { name: "tab_update" } });
  // and an evt for a name nobody holds reaches no one
  sock.message(sealDesk(4, { t: "evt", name: "tab_update", payload: { id: "t10" } }));
  assert.equal(evts.length, 2);
});

await check("noop commands answer locally; a deliberate close_all_tabs passes through; desktop-only commands refuse", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];

  assert.equal(await T.core.invoke("open_tabs_save", { tabs: [] }), null);
  assert.equal(await T.core.invoke("set_close_guard", { guard: true }), null);
  assert.deepEqual(await T.core.invoke("take_pending_open_projects"), []);

  await assert.rejects(T.core.invoke("open_project", { path: "/x" }), (e) =>
    e.message === "open_project is unsupported on remote");

  // close_all_tabs is NOT a noop — the phone's deliberate close must run
  T.core.invoke("close_all_tabs");
  sock.open();
  const reply = E.answerHs(sock);
  // the queue held the invoke; the handshake flush releases it sealed
  assert.deepEqual(sock.sent.filter((f) => f.t !== "hs" && f.t !== "enc"), []);
  const envelopes = sock.sent.filter((f) => f.t === "enc");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].seq, 0);
  const deskKeys = cryptoHelpers.E.sessionKeys(
    reply.__priv, cryptoHelpers.E.b64Bytes(sock.sent[0].pk),
    cryptoHelpers.E.b64Bytes(sock.sent[0].pk), cryptoHelpers.E.b64Bytes(reply.pk));
  assert.deepEqual(
    cryptoHelpers.E.open(deskKeys.c2d, -1, envelopes[0]).frame,
    { t: "cmd", id: 1, name: "close_all_tabs", args: {} });
});

await check("the /p#token pairing landing exchanges the token for a registry entry and redirects", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", protocol: "http:", host: "relay.local" });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "ws://relay.local/ws?role=phone&pair=tok42");
  assert.equal(E.overlay().style.display, "flex");

  E.sockets[0].message({ t: "paired", device: "dev-9", token: "tk-9" });
  const saved = E.saved();
  assert.equal(saved.devices.length, 1);
  assert.deepEqual(
    { device: saved.devices[0].device, token: saved.devices[0].token },
    { device: "dev-9", token: "tk-9" });
  assert.equal(saved.selected, "dev-9");
  assert.deepEqual(E.replaceCalls, ["/"]);
  assert.equal(E.overlay().style.display, "flex"); // the success card until the redirect lands
});

await check("a denied pairing stores nothing and redirects nowhere", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", protocol: "http:", host: "relay.local" });
  E.sockets[0].message({ t: "pair_denied" });
  assert.equal(E.localStorage.getItem("omp-remote:devices"), null);
  assert.deepEqual(E.replaceCalls, []);
  assert.equal(E.overlay().style.display, "flex");
});

await check("peer frames flip the desktop-offline overlay", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  assert.equal(E.overlay(), null); // connected: nothing in the way

  sock.message({ t: "peer", desktop: false });
  const ov = E.overlay();
  assert.ok(ov, "the offline overlay is mounted");
  assert.equal(ov.style.display, "flex");

  sock.message({ t: "peer", desktop: true });
  assert.equal(ov.style.display, "none");
});

// ── in-place reconnect ──────────────────────────────────────────────────────

await check("a drop after a good connection reconnects in place: banner up (overlay stays down), never a reload, banner down on reopen", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  assert.deepEqual(E.reloadCalls, []);

  // mount and then dismiss the desktop-offline overlay first, so the
  // drop can prove the reconnect banner does NOT resurrect it
  sock.message({ t: "peer", desktop: false });
  assert.equal(E.overlay().style.display, "flex");
  sock.message({ t: "peer", desktop: true });
  assert.equal(E.overlay().style.display, "none");
  assert.equal(E.banner(), null);

  sock.shut(); // the drop

  const banner = E.banner();
  assert.ok(banner, "the reconnect banner is mounted");
  assert.equal(banner.style.display, "block");
  assert.equal(banner.textContent, "连接中断，正在重连…");
  assert.equal(E.overlay().style.display, "none"); // non-blocking: no blocking overlay
  assert.deepEqual(E.reloadCalls, []); // in place — the page is never reloaded
  assert.deepEqual(E.replaceCalls, []);

  // exactly one reconnect attempt is armed, 1s out
  const armed = E.fakeTimers.list();
  assert.equal(armed.length, 1);
  assert.equal(armed[0].delay, 1000);
  E.fakeTimers.run(armed[0].id);
  assert.equal(E.sockets.length, 2); // a fresh socket to the same room
  assert.equal(E.sockets[1].url, sock.url);
  assert.equal(E.banner().style.display, "block"); // still up while connecting
  assert.deepEqual(E.reloadCalls, []);

  E.sockets[1].open();
  E.answerHs(E.sockets[1]);
  assert.equal(E.banner().style.display, "none"); // gone on reopen
  assert.equal(E.overlay().style.display, "none");
  assert.deepEqual(E.reloadCalls, []); // never reloaded across the whole cycle
});

await check("reconnect-open flushes queued invokes, skips timed-out ones and queued subs, replays exactly one fresh sub per listener", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);

  // two live subscriptions registered while connected (ids 1 and 2)
  await T.event.listen("tab_update", () => {});
  await T.event.listen("chat_update", () => {});
  // wire frames: the 2 subs, as envelopes (the hs is not business)
  assert.equal(E.unwrapSent(sock).length, 2);

  sock.shut();

  // an invoke that times out while queued: its frame must NOT be replayed
  // on reopen — running it would double-execute a prompt the user was
  // told had failed
  let slowErr = null;
  const pSlow = T.core.invoke("slow_cmd"); // id 3
  pSlow.catch((e) => { slowErr = e; });
  const slowTimer = E.fakeTimers.list().find((t) => t.delay === 30000);
  assert.ok(slowTimer, "the queued invoke armed its 30s timeout");
  E.fakeTimers.run(slowTimer.id);
  await drain();
  assert.equal(slowErr.message, "slow_cmd: timed out waiting for the desktop");

  // then two fresh invokes and a new subscription, all queued while closed
  const pState = T.core.invoke("get_state"); // id 4
  const pTabs = T.core.invoke("list_tabs", { all: true }); // id 5
  await T.event.listen("new_evt", () => {}); // queued sub frame, id 6
  assert.equal(E.unwrapSent(sock).length, 2); // nothing on the dead wire

  runReconnect(E);
  const sock2 = E.sockets[1];
  sock2.open();
  // the reconnected socket sends a FRESH hs (new eph, same MS) before
  // anything business can flow again
  assert.ok(sock2.sent.find((f) => f.t === "hs"));
  E.answerHs(sock2);

  // flush: get_state/list_tabs (ids 4, 5) yes; slow_cmd (id 3) skipped —
  // its promise already timed out; the queued sub (id 6) skipped — subs
  // replay from the listener registry instead, one fresh frame per name
  const flushed = E.unwrapSent(sock2);
  assert.deepEqual(flushed, [
    { t: "cmd", id: 4, name: "get_state", args: {} },
    { t: "cmd", id: 5, name: "list_tabs", args: { all: true } },
    { t: "cmd", id: 7, name: "sub", args: { name: "tab_update" } },
    { t: "cmd", id: 8, name: "sub", args: { name: "chat_update" } },
    { t: "cmd", id: 9, name: "sub", args: { name: "new_evt" } },
  ]);
  const subNames = flushed.filter((f) => f.name === "sub").map((f) => f.args.name);
  assert.deepEqual([...subNames].sort(), ["chat_update", "new_evt", "tab_update"]); // exactly one each

  // a flushed invoke is live again: answering it by id resolves the promise
  let v;
  pState.then((x) => { v = x; });
  sock2.message(E.sealDesk(sock2, 0, { t: "res", id: 4, ok: true, value: { tabs: 1 } }));
  await drain();
  assert.deepEqual(v, { tabs: 1 });
});

await check("_remoteResync fires on reconnect-open and on peer desktop:true, never on first open", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  let resyncs = 0;
  E.win.OMP_BRIDGE = { _remoteResync: () => { resyncs++; } };

  E.sockets[0].open();
  E.answerHs(E.sockets[0]);
  assert.equal(resyncs, 0); // first open: nothing has been missed yet

  E.sockets[0].shut();
  runReconnect(E);
  E.sockets[1].open();
  E.answerHs(E.sockets[1]);
  assert.equal(resyncs, 1); // reopen pulled the gap

  // the peer waking up pulls the gap too; going offline does not
  E.sockets[1].message({ t: "peer", desktop: false });
  assert.equal(resyncs, 1);
  E.sockets[1].message({ t: "peer", desktop: true });
  assert.equal(resyncs, 2);
});

await check("reconnect backoff doubles from 1s and caps at 15s — the second failure waits longer than the first, and still no reload", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);

  const delays = [];
  let current = sock;
  for (let i = 0; i < 6; i++) {
    current.shut(); // every attempt fails without ever opening
    const armed = E.fakeTimers.list();
    assert.equal(armed.length, 1, "exactly one reconnect timer is armed");
    delays.push(armed[0].delay);
    E.fakeTimers.run(armed[0].id); // the wait elapses, connect() dials again
    current = E.sockets[E.sockets.length - 1];
  }
  assert.ok(delays[1] > delays[0], "the second failure waits longer than the first");
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]); // doubling, capped
  assert.equal(E.sockets.length, 7); // six retries, no page reload
  assert.deepEqual(E.reloadCalls, []);
  assert.equal(E.banner().style.display, "block"); // the outage shows the banner, not the overlay
  assert.equal(E.overlay(), null);
});

await check("the offline send queue is bounded at 500: the oldest frames are shed, the newest 500 flush on reopen", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  sock.shut();

  for (let i = 0; i < 600; i++) T.core.invoke("get_state"); // ids 1..600, all queued

  runReconnect(E);
  const sock2 = E.sockets[1];
  sock2.open();
  E.answerHs(sock2);
  // 600 queued PLAIN, the oldest 100 shed, the newest 500 sealed
  const flushed = E.unwrapSent(sock2);
  assert.equal(flushed.length, 500);
  assert.equal(flushed[0].id, 101); // frames 1..100 were shed
  assert.equal(flushed[499].id, 600);
  assert.ok(flushed.every((f) => f.name === "get_state"));
  // on the wire they are envelopes with a contiguous seq from 0
  const envelopes = sock2.sent.filter((f) => f.t === "enc");
  assert.equal(envelopes.length, 500);
  assert.ok(envelopes.every((f, i) => f.seq === i));
});

await check("waking the page (visibilitychange visible / persisted pageshow) reconnects at once instead of waiting out the backoff", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  sock.shut(); // outage: a 1s reconnect timer is armed
  assert.equal(E.fakeTimers.pending(), 1);

  // a visibilitychange while still hidden does nothing
  E.document.hidden = true;
  E.dispatchDocumentEvent("visibilitychange");
  assert.equal(E.sockets.length, 1);
  assert.equal(E.fakeTimers.pending(), 1);

  // a plain (non-bfcache) pageshow does nothing either
  E.dispatchWindowEvent("pageshow", { persisted: false });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.fakeTimers.pending(), 1);

  // becoming visible reconnects NOW and disarms the backoff timer
  E.document.hidden = false;
  E.dispatchDocumentEvent("visibilitychange");
  assert.equal(E.sockets.length, 2);
  assert.equal(E.fakeTimers.pending(), 0);
  E.sockets[1].open();
  E.answerHs(E.sockets[1]);
  assert.equal(E.banner().style.display, "none");

  // and a bfcache restore after another drop does the same: it dials at
  // once. (Its handler doesn't disarm the pending backoff timer, but the
  // stale timer is harmless — firing it just re-enters connect(), which
  // no-ops while the fresh socket is already connecting.)
  E.sockets[1].shut();
  assert.equal(E.fakeTimers.pending(), 1);
  E.dispatchWindowEvent("pageshow", { persisted: true });
  assert.equal(E.sockets.length, 3); // dialed immediately, not after the backoff
  const stale = E.fakeTimers.list().find((t) => t.delay !== 30000);
  if (stale) {
    E.fakeTimers.run(stale.id); // elapse the leftover backoff timer
    assert.equal(E.sockets.length, 3); // no extra dial: already connecting
  }
});

// ── multi-device: registry, picker hand-off, device-frame routing ─────────

const twoDevices = (selected = "d1") => ({
  devices: [
    { device: "d1", token: "t1", name: "One", os: "windows", lastUsed: 2 },
    { device: "d2", token: "t2", name: "", os: "", lastUsed: 0 },
  ],
  selected,
});

await check("a legacy single-pairing phone migrates at boot and connects unchanged", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1&name=Android%20%C2%B7%20mobile");
  const saved = E.saved();
  assert.equal(saved.devices.length, 1);
  assert.equal(saved.selected, "d1");
  assert.equal(E.localStorage.getItem("omp-remote:auth"), null, "the legacy key is consumed");
});

await check("with several devices paired, boot connects the SELECTED room and leaves the picker shut", async () => {
  const E = makeEnv({ devices: twoDevices("d2") });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d2&token=t2&name=Android%20%C2%B7%20mobile");
  assert.equal(E.hubCalls.open, 0);
});

await check("paired but nothing selected: the picker takes over, no socket dials, invokes reject", async () => {
  const E = makeEnv({ devices: twoDevices(null) });
  assert.equal(E.sockets.length, 0);
  assert.equal(E.hubCalls.open, 1);
  await assert.rejects(E.win.__TAURI__.core.invoke("get_state"), (e) => e.message === "not paired");
  assert.equal(E.fakeTimers.pending(), 0);
});

await check("a missing hub module degrades gracefully (optional chaining, invokes still reject)", async () => {
  const E = makeEnv({ devices: twoDevices(null), hub: null });
  assert.equal(E.sockets.length, 0);
  await assert.rejects(E.win.__TAURI__.core.invoke("get_state"), (e) => e.message === "not paired");
});

await check("pairing a SECOND desktop appends without touching the first and selects the newcomer", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", devices: twoDevices("d1") });
  E.sockets[0].message({ t: "paired", device: "d3", token: "t3" });
  const saved = E.saved();
  assert.deepEqual(saved.devices.map((d) => d.device), ["d1", "d2", "d3"]);
  assert.equal(saved.devices[0].token, "t1", "the first pairing is untouched");
  assert.equal(saved.devices[0].name, "One");
  assert.equal(saved.selected, "d3");
  assert.ok(saved.devices[2].lastUsed > 0);
  assert.deepEqual(E.replaceCalls, ["/"]);
});

await check("re-pairing a KNOWN desktop swaps its token and keeps name and selection", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", devices: twoDevices("d1") });
  E.sockets[0].message({ t: "paired", device: "d2", token: "t2-fresh" });
  const saved = E.saved();
  assert.equal(saved.devices.length, 2);
  assert.equal(saved.devices[1].token, "t2-fresh");
  assert.equal(saved.selected, "d1");
});

await check("a `device` frame routes to the hub tagged with the room's device id", async () => {
  const E = makeEnv({ devices: twoDevices("d1") });
  E.sockets[0].message({ t: "device", name: "Renamed", os: "windows" });
  assert.deepEqual(E.hubCalls.noteDevice, [
    ["d1", { t: "device", name: "Renamed", os: "windows" }],
  ]);
});

await check("the offline overlay offers a switch-device action that opens the picker", async () => {
  const E = makeEnv({ devices: twoDevices("d1") });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  sock.message({ t: "peer", desktop: false });
  const act = E.overlay().querySelector(".ro-action");
  assert.equal(act.style.display, "block");
  assert.equal(act.textContent, "切换设备");
  act.onclick();
  assert.equal(E.hubCalls.open, 1);
  assert.equal(E.overlay().style.display, "none", "the overlay steps aside for the hub");

  // The desktop returning hides everything again; the action is disarmed
  // for the next plain overlay (the unpaired card must not carry it).
  sock.message({ t: "peer", desktop: true });
  assert.equal(E.overlay().style.display, "none");
});

await check("remote_set_name joins the desktop-only command wall", async () => {
  const E = makeEnv({ devices: twoDevices("d1") });
  await assert.rejects(E.win.__TAURI__.core.invoke("remote_set_name", { name: "x" }),
    (e) => e.message === "remote_set_name is unsupported on remote");
});

// ── protocol v2: hello caps, dropped rejects, desktop-restart replay ──────

await check("a hello frame stores the desktop's caps on __remoteCaps", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  const T = E.win.__TAURI__;
  assert.equal(T.__remoteCaps, null); // nothing before a hello lands

  sock.message({ t: "hello", v: 1, caps: ["res-unicast", "transcript-window", "hello"] });
  assert.deepEqual(T.__remoteCaps, ["res-unicast", "transcript-window", "hello"]);

  // a caps-less or non-array hello resets to an empty array, never garbage
  sock.message({ t: "hello", v: 1 });
  assert.deepEqual(T.__remoteCaps, []);
});

await check("a dropped frame with a live pending id rejects it with the oversize reason", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);

  let err = null;
  const p = T.core.invoke("big_window");
  p.catch((e) => { err = e; });
  // the invoke rode an envelope; its id comes from the plaintext inside
  const id = E.unwrapSent(sock).at(-1).id;
  sock.message({ t: "dropped", reason: "oversize", id });
  await drain();
  assert.ok(err instanceof Error, "the pending invoke rejected");
  assert.equal(err.message, "relay dropped the reply (oversize)");

  // the 30s timeout was disarmed with the rejection
  assert.equal(E.fakeTimers.pending(), 0);

  // a dropped frame for an unknown id (an evt, or a resolved reply) only logs
  sock.message({ t: "dropped", reason: "oversize", id: 999 });
  assert.equal(E.fakeTimers.pending(), 0);
  // ...and a dropped frame with no id at all is equally inert
  sock.message({ t: "dropped", reason: "oversize" });
  assert.equal(E.fakeTimers.pending(), 0);
});

await check("a res whose value is gzipped but undecodable rejects the pending, never resolves garbage", async () => {
  // Node has DecompressionStream; shadow it for this one env so the
  // shim's missing-codec path runs (a very old handset browser). The
  // restore is in a finally so a failed assert can't leak the shadow.
  const origDecompressionStream = globalThis.DecompressionStream;
  globalThis.DecompressionStream = undefined;
  try {
    const E = makeEnv({ auth: { device: "d1", token: "t1" } });
    const T = E.win.__TAURI__;
    const sock = E.sockets[0];
    sock.open();
    E.answerHs(sock);

    const p = T.core.invoke("huge_fetch");
    const id = E.unwrapSent(sock).at(-1).id;
    sock.message(E.sealDesk(sock, 0, { t: "res", id, ok: true, value: { gz: "bm90LWd6aXA=" } }));
    let err = null;
    p.catch((e) => { err = e; });
    await drain();
    assert.ok(err instanceof Error, "the gzipped reply rejected");
    assert.equal(err.message, "unsupported frame encoding");
  } finally {
    globalThis.DecompressionStream = origDecompressionStream;
  }

  // with the codec present, a valid gz round-trips (the desktop's agent
  // encodes exactly this shape) and a plain value still resolves verbatim
  const E2 = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T2 = E2.win.__TAURI__;
  const sock2 = E2.sockets[0];
  sock2.open();
  E2.answerHs(sock2);
  const gz = await new Promise((resolve) => {
    const stream = new Blob([JSON.stringify({ ok: true, n: 7 })]).stream()
      .pipeThrough(new CompressionStream("gzip"));
    new Response(stream).arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      resolve(btoa(bin));
    });
  });
  const p2 = T2.core.invoke("huge_fetch");
  sock2.message(E2.sealDesk(sock2, 0, { t: "res", id: E2.unwrapSent(sock2).at(-1).id, ok: true, value: { gz } }));
  // await the decode chain itself (Blob/Response/DecompressionStream are
  // real async here), not a guessed number of microtask turns
  const v = await p2;
  assert.deepEqual(v, { ok: true, n: 7 });

  const p3 = T2.core.invoke("small_fetch");
  let v3;
  p3.then((x) => { v3 = x; });
  sock2.message(E2.sealDesk(sock2, 1, { t: "res", id: E2.unwrapSent(sock2).at(-1).id, ok: true, value: { a: 1 } }));
  await drain();
  assert.deepEqual(v3, { a: 1 });
});

await check("a desktop restart (peer desktop:true) replays every live subscription and resyncs, without a resync on desktop:false", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  let resyncs = 0;
  E.win.OMP_BRIDGE = { _remoteResync: () => { resyncs++; } };

  await T.event.listen("tab_update", () => {});
  await T.event.listen("agent://line/s-1", () => {});
  // subs ride envelopes; count them in the plaintext view
  const subCount = () => E.unwrapSent(sock).filter((f) => f.name === "sub").length;
  const base = subCount();

  // desktop away and back: the return is a NEW room membership — its
  // subscription table is empty, so every live listener replays
  sock.message({ t: "peer", desktop: false });
  assert.equal(resyncs, 0);
  assert.equal(subCount(), base); // going offline replays nothing

  sock.message({ t: "peer", desktop: true });
  assert.equal(resyncs, 1);
  assert.equal(subCount(), base + 2); // one fresh sub per listener
  const names = E.unwrapSent(sock).slice(-2).map((f) => f.args.name).sort();
  assert.deepEqual(names, ["agent://line/s-1", "tab_update"]);

  // a second return (a bounce) replays again — each return is its own room
  sock.message({ t: "peer", desktop: false });
  sock.message({ t: "peer", desktop: true });
  assert.equal(resyncs, 2);
  assert.equal(subCount(), base + 4);

  // listeners added after the restart replay too (ordinary refcount path)
  await T.event.listen("chat_update", () => {});
  assert.equal(subCount(), base + 5);
});

await check("first-connect failure retries with backoff and a 立即重试 button, and settles into the normal reconnect loop", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.shut(); // first-connect FAILURE: onopen never ran, everConnected is false

  // the retry overlay is up (not the old dead-end card), with the button
  const ov = E.overlay();
  assert.ok(ov, "the retry overlay is mounted");
  assert.equal(ov.style.display, "flex");
  assert.equal(ov.querySelector(".ro-title").textContent, "连不上服务器");
  const act = ov.querySelector(".ro-action");
  assert.equal(act.style.display, "block");
  assert.equal(act.textContent, "立即重试");
  assert.equal(E.banner(), null); // no banner: never had a session to keep alive

  // the same capped backoff as a mid-session drop
  const armed = E.fakeTimers.list();
  assert.equal(armed.length, 1);
  assert.equal(armed[0].delay, 1000);
  E.fakeTimers.run(armed[0].id);
  assert.equal(E.sockets.length, 2);
  E.sockets[1].shut();
  assert.equal(E.fakeTimers.list()[0].delay, 2000);
  assert.equal(act.textContent, "立即重试"); // still the retry card

  // the button dials at once (retryMs 0), not after the backoff wait
  act.onclick();
  assert.equal(E.sockets.length, 3); // dialed immediately
  assert.equal(E.sockets[2].url, E.sockets[1].url);

  // and a SUCCESSFUL open clears the card: everConnected flips, a later
  // drop shows the in-place banner instead
  E.sockets[2].open();
  E.answerHs(E.sockets[2]);
  assert.equal(ov.style.display, "none");
  E.sockets[2].shut();
  const banner = E.banner();
  assert.ok(banner, "a post-connection drop shows the reconnect banner");
  assert.equal(banner.style.display, "block");
  assert.equal(ov.style.display, "none"); // the retry card stays down
});

await check("the pair connection URL carries the phone's friendly name (UA-Data platform · mobile)", async () => {
  const E = makeEnv({
    auth: { device: "d1", token: "t1" },
    navigator: { userAgentData: { platform: "Pixel 9", mobile: true } },
  });
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1&name=Pixel%209%20%C2%B7%20mobile");

  // UA-Data absent: the UA-string fallback, first parens segment
  const E2 = makeEnv({
    auth: { device: "d1", token: "t1" },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" },
  });
  assert.equal(E2.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1&name=iPhone");
});

// ── browser panel channel (phone screencast) ──────────────────────────────
// The desktop opens the panel with its own Tauri Channel and re-emits every
// screencast frame as a `browser://frame/{sid}` evt; the shim's stand-in
// Channel is what live.js hands to the panel, so frames must land on its
// onmessage — and the stand-in must ride the wire as a plain placeholder.
await check("browser_open_panel: the Channel arg rides as a placeholder and subscribes the frame name", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  sock.__deskReply = sock.__deskReply; // keys stay bound to this socket
  sock.sent.length = 0;
  const ch = new T.core.Channel();
  const got = [];
  ch.onmessage = (m) => got.push(m);
  const p = T.core.invoke("browser_open_panel", { sessionId: "s1", width: 10, height: 10, dpr: 2, events: ch });
  // the commands ride envelopes; look at the plaintext inside
  const plain = () => E.unwrapSent(sock);
  const cmd = plain().find(f => f.t === "cmd" && f.name === "browser_open_panel");
  assert.deepEqual(cmd.args.events, { __remoteChannel: true });
  assert.deepEqual(plain().filter(f => f.t === "cmd" && f.name === "sub").map(f => f.args.name), ["browser://frame/s1"]);
  sock.message(E.sealDesk(sock, 0, { t: "res", id: cmd.id, ok: true, value: null }));
  assert.equal(await p, null);
  // a frame evt reaches the stand-in Channel, not the event listeners
  sock.message(E.sealDesk(sock, 1, { t: "evt", name: "browser://frame/s1", payload: { seq: 3, data: "abc" } }));
  assert.deepEqual(got, [{ seq: 3, data: "abc" }]);
  // closing unsubscribes the frame name and detaches the channel
  const pc = T.core.invoke("browser_close_panel", { sessionId: "s1" });
  const cc = plain().find(f => f.t === "cmd" && f.name === "browser_close_panel");
  assert.ok(cc);
  assert.deepEqual(plain().filter(f => f.t === "cmd" && f.name === "unsub").map(f => f.args.name), ["browser://frame/s1"]);
  sock.message(E.sealDesk(sock, 2, { t: "res", id: cc.id, ok: true, value: null }));
  await pc;
  sock.message(E.sealDesk(sock, 3, { t: "evt", name: "browser://frame/s1", payload: { seq: 4 } }));
  assert.deepEqual(got, [{ seq: 3, data: "abc" }]);
});
await check("a frame evt for an unknown session reaches no channel", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  sock.message(E.sealDesk(sock, 0, { t: "evt", name: "browser://frame/zzz", payload: { seq: 1 } }));
  assert.equal(E.unwrapSent(sock).filter(f => f.t === "cmd" && f.name === "unsub").length, 0);
});

await check("a base64 frame evt reaches the stand-in Channel as an ArrayBuffer", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();
  E.answerHs(sock);
  const ch = new T.core.Channel();
  const got = [];
  ch.onmessage = (m) => got.push(m);
  const p = T.core.invoke("browser_open_panel", { sessionId: "s2", width: 1, height: 1, dpr: 1, events: ch });
  const c = E.unwrapSent(sock).find(f => f.t === "cmd" && f.name === "browser_open_panel");
  sock.message(E.sealDesk(sock, 0, { t: "res", id: c.id, ok: true, value: null }));
  await p;
  // base64 of [9, 8, 7]
  sock.message(E.sealDesk(sock, 1, { t: "evt", name: "browser://frame/s2", payload: { bin: btoa(String.fromCharCode(9, 8, 7)) } }));
  assert.equal(got.length, 1);
  assert.ok(got[0] instanceof ArrayBuffer || (got[0] && got[0].byteLength === 3));
  assert.deepEqual([...new Uint8Array(got[0])], [9, 8, 7]);
});

// ── summary ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`test-remote-transport: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`test-remote-transport: ${passed} checks passed`);
