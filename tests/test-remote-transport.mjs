#!/usr/bin/env node
// Regression script for src/app/remote-transport.js — the phone side of
// remote control: the window.__TAURI__ WebSocket shim a plain browser
// gets when the relay serves the app. Covers the inert-under-real-Tauri
// guard, the three boot states (pairing landing, stored auth, unpaired
// overlay), the pre-open send queue and its on-open flush order, res/evt
// frame handling, per-name sub refcounting, the noop/unsupported command
// walls, and the desktop-offline overlay.
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
// ever depends on the event loop.

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

  const timers = new Map();
  let timerSeq = 0;
  const fakeTimers = {
    setTimeout: (fn) => { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    runAll: () => { for (const fn of [...timers.values()]) fn(); timers.clear(); },
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
  const document = {
    readyState: "complete",
    documentElement,
    head: mkEl("head"),
    body: mkEl("body"),
    createElement: (tag) => mkEl(tag),
    addEventListener() {},
  };

  const win = {};
  if (opts.tauri) win.__TAURI__ = opts.tauri;

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
    overlay: () => document.body.children.find((c) => c.id === "remote-overlay") || null,
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
  assert.deepEqual(E.reloadCalls, []); // first connect, not a resync reconnect
  assert.deepEqual(sock.sent, [
    { t: "cmd", id: 1, name: "get_state", args: {} },
    { t: "cmd", id: 2, name: "list_tabs", args: { all: true } },
    { t: "cmd", id: 3, name: "sub", args: { name: "tab_update" } }, // one sub for both listens
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
  assert.deepEqual(sock.sent[3], { t: "cmd", id: 4, name: "boom_cmd", args: {} });
  sock.message({ t: "res", id: 4, ok: false, error: "relay exploded" });
  await drain();
  assert.ok(err instanceof Error);
  assert.equal(err.message, "relay exploded");

  // unlisten is refcounted: only the last one sends an unsub
  off1();
  assert.equal(sock.sent.length, 4); // still one holder left
  off2();
  assert.equal(sock.sent.length, 5);
  assert.deepEqual(sock.sent[4], { t: "cmd", id: 5, name: "unsub", args: { name: "tab_update" } });
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

// ── summary ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`test-remote-transport: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`test-remote-transport: ${passed} checks passed`);
