#!/usr/bin/env node
// Regression script for src/app/remote-transport.js — the phone side of
// remote control: the window.__TAURI__ WebSocket shim a plain browser
// gets when the relay serves the app. Covers the inert-under-real-Tauri
// guard, the three boot states (pairing landing, stored auth, unpaired
// overlay), the pre-open send queue and its on-open flush order, res/evt
// frame handling, per-name sub refcounting, the noop/unsupported command
// walls, and the desktop-offline overlay — plus the in-place reconnect:
// a non-blocking banner instead of a page reload, exponential backoff
// (1s→2s→…→15s cap), a reopen flush that skips timed-out invokes and
// queued subs in favor of one fresh sub per listener, _remoteResync on
// reopen and peer-wake, the 500-frame queue bound, and immediate
// reconnect on visibilitychange/pageshow.
// Run: node tests/test-remote-transport.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/remote-transport.js"), "utf8");

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

  // eslint-disable-next-line no-new-func
  new Function(
    "window", "document", "localStorage", "location", "WebSocket",
    "setTimeout", "clearTimeout", "console",
    src,
  )(win, document, localStorage, location, FakeWebSocket,
    fakeTimers.setTimeout, fakeTimers.clearTimeout,
    { log() {}, warn() {}, error() {} });

  return {
    win, document, location, localStorage, sockets,
    replaceCalls, reloadCalls, classList, fakeTimers,
    dispatchWindowEvent, dispatchDocumentEvent,
    overlay: () => document.body.children.find((c) => c.id === "remote-overlay") || null,
    banner: () => document.body.children.find((c) => c.id === "remote-banner") || null,
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

await check("with auth: connects, queues pre-open frames in order, answers res by id, refcounts subs", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1");

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
  assert.deepEqual(sock.sent, [
    { t: "cmd", id: 1, name: "get_state", args: {} },
    { t: "cmd", id: 2, name: "list_tabs", args: { all: true } },
    // the queued sub frame (id 3) is skipped; subs always replay fresh
    // from the listener registry, so the wire sub gets the next id, 4
    { t: "cmd", id: 4, name: "sub", args: { name: "tab_update" } }, // one sub for both listens
  ]);

  // out-of-order responses resolve the promise their id belongs to
  let v1;
  let v2;
  p1.then((v) => { v1 = v; });
  p2.then((v) => { v2 = v; });
  sock.message({ t: "res", id: 2, ok: true, value: ["tab-b"] });
  await drain();
  assert.equal(v1, undefined); // id 1 is still waiting
  assert.deepEqual(v2, ["tab-b"]);
  sock.message({ t: "res", id: 1, ok: true, value: { tabs: 0 } });
  await drain();
  assert.deepEqual(v1, { tabs: 0 });

  // an evt fans out to every callback registered for that name
  sock.message({ t: "evt", name: "tab_update", payload: { id: "t9" } });
  assert.deepEqual(evts, [
    { event: "tab_update", payload: { id: "t9" } },
    { event: "tab_update", payload: { id: "t9" } },
  ]);

  // a failing res rejects with the relay's error text
  let err = null;
  const p3 = T.core.invoke("boom_cmd");
  p3.catch((e) => { err = e; });
  assert.deepEqual(sock.sent[3], { t: "cmd", id: 5, name: "boom_cmd", args: {} });
  sock.message({ t: "res", id: 5, ok: false, error: "relay exploded" });
  await drain();
  assert.ok(err instanceof Error);
  assert.equal(err.message, "relay exploded");

  // unlisten is refcounted: only the last one sends an unsub
  off1();
  assert.equal(sock.sent.length, 4); // still one holder left
  off2();
  assert.equal(sock.sent.length, 5);
  assert.deepEqual(sock.sent[4], { t: "cmd", id: 6, name: "unsub", args: { name: "tab_update" } });
  // and an evt for a name nobody holds reaches no one
  sock.message({ t: "evt", name: "tab_update", payload: { id: "t10" } });
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
  assert.deepEqual(sock.sent, [{ t: "cmd", id: 1, name: "close_all_tabs", args: {} }]);
});

await check("the /p#token pairing landing exchanges the token for stored auth and redirects", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", protocol: "http:", host: "relay.local" });
  assert.equal(E.sockets.length, 1);
  assert.equal(E.sockets[0].url, "ws://relay.local/ws?role=phone&pair=tok42");
  assert.equal(E.overlay().style.display, "flex");

  E.sockets[0].message({ t: "paired", device: "dev-9", token: "tk-9" });
  assert.deepEqual(JSON.parse(E.localStorage.getItem("omp-remote:auth")), { device: "dev-9", token: "tk-9" });
  assert.deepEqual(E.replaceCalls, ["/"]);
  assert.equal(E.overlay().style.display, "flex"); // the success card until the redirect lands
});

await check("a denied pairing stores nothing and redirects nowhere", async () => {
  const E = makeEnv({ pathname: "/p", hash: "#tok42", protocol: "http:", host: "relay.local" });
  E.sockets[0].message({ t: "pair_denied" });
  assert.equal(E.localStorage.getItem("omp-remote:auth"), null);
  assert.deepEqual(E.replaceCalls, []);
  assert.equal(E.overlay().style.display, "flex");
});

await check("peer frames flip the desktop-offline overlay", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
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
  assert.equal(E.banner().style.display, "none"); // gone on reopen
  assert.equal(E.overlay().style.display, "none");
  assert.deepEqual(E.reloadCalls, []); // never reloaded across the whole cycle
});

await check("reconnect-open flushes queued invokes, skips timed-out ones and queued subs, replays exactly one fresh sub per listener", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const T = E.win.__TAURI__;
  const sock = E.sockets[0];
  sock.open();

  // two live subscriptions registered while connected (ids 1 and 2)
  await T.event.listen("tab_update", () => {});
  await T.event.listen("chat_update", () => {});
  assert.equal(sock.sent.length, 2);

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
  assert.equal(sock.sent.length, 2); // nothing goes out on the dead wire

  runReconnect(E);
  const sock2 = E.sockets[1];
  sock2.open();

  // flush: get_state/list_tabs (ids 4, 5) yes; slow_cmd (id 3) skipped —
  // its promise already timed out; the queued sub (id 6) skipped — subs
  // replay from the listener registry instead, one fresh frame per name
  assert.deepEqual(sock2.sent, [
    { t: "cmd", id: 4, name: "get_state", args: {} },
    { t: "cmd", id: 5, name: "list_tabs", args: { all: true } },
    { t: "cmd", id: 7, name: "sub", args: { name: "tab_update" } },
    { t: "cmd", id: 8, name: "sub", args: { name: "chat_update" } },
    { t: "cmd", id: 9, name: "sub", args: { name: "new_evt" } },
  ]);
  const subNames = sock2.sent.filter((f) => f.name === "sub").map((f) => f.args.name);
  assert.deepEqual([...subNames].sort(), ["chat_update", "new_evt", "tab_update"]); // exactly one each

  // a flushed invoke is live again: answering it by id resolves the promise
  let v;
  pState.then((x) => { v = x; });
  sock2.message({ t: "res", id: 4, ok: true, value: { tabs: 1 } });
  await drain();
  assert.deepEqual(v, { tabs: 1 });
});

await check("_remoteResync fires on reconnect-open and on peer desktop:true, never on first open", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  let resyncs = 0;
  E.win.OMP_BRIDGE = { _remoteResync: () => { resyncs++; } };

  E.sockets[0].open();
  assert.equal(resyncs, 0); // first open: nothing has been missed yet

  E.sockets[0].shut();
  runReconnect(E);
  E.sockets[1].open();
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
  sock.shut();

  for (let i = 0; i < 600; i++) T.core.invoke("get_state"); // ids 1..600, all queued

  runReconnect(E);
  const sock2 = E.sockets[1];
  sock2.open();
  assert.equal(sock2.sent.length, 500); // 600 queued, the oldest 100 dropped
  assert.equal(sock2.sent[0].id, 101); // frames 1..100 were shed
  assert.equal(sock2.sent[499].id, 600);
  assert.ok(sock2.sent.every((f) => f.name === "get_state"));
});

await check("waking the page (visibilitychange visible / persisted pageshow) reconnects at once instead of waiting out the backoff", async () => {
  const E = makeEnv({ auth: { device: "d1", token: "t1" } });
  const sock = E.sockets[0];
  sock.open();
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

// ── summary ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`test-remote-transport: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`test-remote-transport: ${passed} checks passed`);
