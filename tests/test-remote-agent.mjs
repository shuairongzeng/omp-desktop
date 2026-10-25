#!/usr/bin/env node
// Regression script for src/app/remote-agent.js — the desktop side of
// remote control: the webview executor for phone cmd frames. Covers its
// inertness under the phone shim, cmd→invoke→res round-trips (including
// command errors), the remote_send wire shape (the Rust command's `frame`
// parameter), per-phone event-subscription refcounting with `peer` offline
// teardown, evt forwarding, the unsupported/js:/start_session/close_tab
// routing walls, and the pair_request window event. The __TAURI__ stub is
// receiver-sensitive so an unbound core/event alias fails loudly here.
// Run: node tests/test-remote-agent.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/remote-agent.js"), "utf8");

// ── the desktop webview the agent runs in ──────────────────────────────────
// `__TAURI__.event.listen` records its callbacks so the test plays the
// connector by delivering frames; `core.invoke` records calls and answers
// from a scriptable table. No real Tauri, no network, no timers.
//
// core/event methods are receiver-sensitive, like methods on the real
// `__TAURI__` runtime objects: an unbound alias
// (`const f = __TAURI__.event.listen; f(…)`) loses its receiver and throws
// here — the exact trap that silently dropped every listener registration
// under real Tauri. `invoke` also records args verbatim, so the wire shape
// of `remote_send` (the Rust command's `frame` parameter) is assertable.

function makeEnv() {
  const tauriListeners = new Map(); // name → Set<cb>
  const unlistens = [];             // names whose unlisten ran
  const invokeCalls = [];           // { name, args } — args exactly as passed
  const sent = [];                  // frames the agent handed to remote_send
  let invokeImpl = () => null;      // test overrides per-check

  const core = {
    invoke(name, args) {
      if (this !== core) throw new TypeError("core.invoke lost its receiver — unbound __TAURI__ alias");
      invokeCalls.push({ name, args });
      if (name === "remote_send") { sent.push(args && args.frame); return Promise.resolve(null); }
      return invokeImpl(name, args);
    },
  };
  const event = {
    listen(name, cb) {
      if (this !== event) throw new TypeError("event.listen lost its receiver — unbound __TAURI__ alias");
      if (!tauriListeners.has(name)) tauriListeners.set(name, new Set());
      tauriListeners.get(name).add(cb);
      return Promise.resolve(() => {
        unlistens.push(name);
        const s = tauriListeners.get(name);
        if (s) { s.delete(cb); if (s.size === 0) tauriListeners.delete(name); }
      });
    },
  };

  // Tauri's IPC Channel: the agent opens the browser panel with one and
  // re-emits the frames it receives. The stub only needs the callback slot.
  class Channel {
    constructor() { this.onmessage = null; }
  }
  core.Channel = Channel;

  const win = {
    __TAURI__: { core, event },
    OMP_BRIDGE: { _remoteHandlers: {} },
  };

  const windowEvents = []; // { type, detail }
  win.addEventListener = () => {};
  win.dispatchEvent = (ev) => { windowEvents.push({ type: ev.type, detail: ev.detail }); };

  // setTimeout records {fn, delay} instead of firing: the coalescing
  // window (100 ms) is asserted by its armed delay, and its expiry is
  // run by hand — no real timers, ever.
  const timers = new Map();
  let timerSeq = 0;
  const fakeSetTimeout = (fn, delay) => {
    const id = ++timerSeq;
    timers.set(id, { fn, delay: delay ?? 0 });
    return id;
  };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const timerInfo = () => [...timers.entries()].map(([id, t]) => ({ id, delay: t.delay }));
  const runTimer = (id) => { const t = timers.get(id); if (!t) return false; timers.delete(id); t.fn(); return true; };
  const runTimersAll = () => { for (const [id, t] of [...timers.entries()]) { timers.delete(id); t.fn(); } };
  const timerCount = () => timers.size;
  const quiet = { log() {}, warn() {}, error() {} };
  const fireEvt = (name, ev) => {
    for (const cb of tauriListeners.get(name) || []) cb(ev);
  };

  // eslint-disable-next-line no-new-function
  new Function("window", "console", "CustomEvent", "setTimeout", "clearTimeout", src)(
    win, quiet, CustomEvent, fakeSetTimeout, fakeClearTimeout);
  return {
    win, sent, invokeCalls, unlistens, timerInfo, runTimer, runTimersAll, timerCount,
    // the connector delivering a frame to a remote:// channel
    phone: (f) => fireEvt("remote://phone", { payload: f }),
    control: (f) => fireEvt("remote://control", { payload: f }),
    status: (f) => fireEvt("remote://status", { payload: f }),
    windowEvents,
    setInvoke: (fn) => { invokeImpl = fn; },
    // fire a Tauri event the agent itself subscribed to (name, full ev)
    forEvt: (name, ev) => fireEvt(name, ev),
    subscribed: () => [...tauriListeners.keys()],
  };
}

// Rebuilt per scenario so state never leaks between checks.
const load = (handlers = {}) => {
  const E = makeEnv();
  Object.assign(E.win.OMP_BRIDGE._remoteHandlers, handlers);
  return E;
};
const drain = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const lastRes = (E) => E.sent[E.sent.length - 1];

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

// ── checks ─────────────────────────────────────────────────────────────────

await check("under the phone shim the agent is inert", async () => {
  const win = {
    __TAURI__: { __remoteShim: true, core: { invoke: () => {} }, event: { listen: async () => {} } },
    addEventListener() {}, dispatchEvent() {},
  };
  // eslint-disable-next-line no-new-function
  new Function("window", "console", "CustomEvent", src)(win, { log() {}, warn() {}, error() {} }, CustomEvent);
  assert.equal(win.__TAURI__.core.invoke("x"), undefined); // never wrapped, never used
});

await check("a cmd runs through core.invoke and answers res ok with the value", async () => {
  const E = load();
  E.setInvoke(() => "value-1");
  E.phone({ t: "cmd", id: 11, name: "get_state", args: { deep: true } });
  await drain();
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["get_state", "remote_send"]);
  assert.deepEqual(E.invokeCalls[0].args, { deep: true });
  assert.deepEqual(lastRes(E), { t: "res", id: 11, ok: true, value: "value-1" });
});

await check("a throwing command answers res ok:false with the error message", async () => {
  const E = load();
  E.setInvoke(() => { throw new Error("rust says no"); });
  E.phone({ t: "cmd", id: 12, name: "get_state" });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 12, ok: false, error: "rust says no" });
});

await check("a null invoke value answers res ok with value null, not undefined", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 13, name: "get_state" });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 13, ok: true, value: null });
});

await check("sub refcounts a Tauri listener per name across phones; last unsub tears it down", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "tab_update" } });
  E.phone({ t: "cmd", id: 2, from: "p2", name: "sub", args: { name: "tab_update" } });
  await drain();
  // exactly one Tauri listener for the shared name, plus the agent's own three
  assert.deepEqual(E.subscribed().sort(), ["remote://control", "remote://phone", "remote://status", "tab_update"]);

  // one phone unsubscribes: the listener stays
  E.phone({ t: "cmd", id: 3, from: "p1", name: "unsub", args: { name: "tab_update" } });
  await drain();
  assert.ok(E.subscribed().includes("tab_update"));
  assert.deepEqual(E.unlistens, []);
  assert.deepEqual(lastRes(E), { t: "res", id: 3, ok: true, value: null, from: "p1" });

  // the last phone goes: the Tauri listener is unlistened
  E.phone({ t: "cmd", id: 4, from: "p2", name: "unsub", args: { name: "tab_update" } });
  await drain();
  assert.ok(!E.subscribed().includes("tab_update"));
  assert.deepEqual(E.unlistens, ["tab_update"]);
});

await check("a phone going offline (peer online:false) drops only its subs; the listener survives other phones", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "tab_update" } });
  E.phone({ t: "cmd", id: 2, from: "p2", name: "sub", args: { name: "tab_update" } });
  await drain();

  E.control({ t: "peer", phone: "p1", online: false });
  await drain();
  assert.ok(E.subscribed().includes("tab_update")); // p2 still holds it
  assert.deepEqual(E.unlistens, []);

  E.control({ t: "peer", phone: "p2", online: false });
  await drain();
  assert.ok(!E.subscribed().includes("tab_update"));
  assert.deepEqual(E.unlistens, ["tab_update"]);
});

await check("a stale unsub from a phone that left does NOT unlisten while another phone holds the name", async () => {
  // Only a phone that actually holds the name may release it: p1 left
  // (its bookkeeping was dropped), so its in-flight 'unsub' is a no-op
  // and p2's Tauri listener survives.
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "tab_update" } });
  E.phone({ t: "cmd", id: 2, from: "p2", name: "sub", args: { name: "tab_update" } });
  await drain();
  E.control({ t: "peer", phone: "p1", online: false });
  await drain();

  E.phone({ t: "cmd", id: 3, from: "p1", name: "unsub", args: { name: "tab_update" } });
  await drain();
  assert.deepEqual(E.unlistens, []);
  assert.deepEqual(lastRes(E), { t: "res", id: 3, ok: true, value: null, from: "p1" });

  // a ghost unsub from a phone that never subscribed is equally inert
  E.phone({ t: "cmd", id: 4, from: "p3", name: "unsub", args: { name: "tab_update" } });
  await drain();
  assert.deepEqual(E.unlistens, []);
  assert.ok(E.subscribed().includes("tab_update"));
});

await check("a Tauri event under a subscribed name is forwarded as an evt frame", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "tab_update" } });
  await drain();
  E.forEvt("tab_update", { payload: { id: "t9", state: "running" } });
  assert.deepEqual(lastRes(E), { t: "evt", name: "tab_update", payload: { id: "t9", state: "running" } });
  // a null payload is normalized, never undefined
  E.forEvt("tab_update", { payload: null });
  assert.deepEqual(lastRes(E), { t: "evt", name: "tab_update", payload: null });
});

await check("an unsupported command is refused without ever reaching core.invoke", async () => {
  const E = load();
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 21, name: "open_project", args: { path: "/x" } });
  await drain();
  // the only invoke is the remote_send carrying the refusal itself
  assert.deepEqual(E.invokeCalls, [{ name: "remote_send", args: { frame: { t: "res", id: 21, ok: false, error: "open_project is unsupported on remote" } } }]);
});

await check("remote_send wraps its frame under the Rust command's `frame` parameter", async () => {
  // The Rust command is `remote_send(frame: Value, …)`; the args object
  // passed to core.invoke must nest the frame under that key, not pass it
  // bare (the bug E2E found: a bare args object deserialized to `Value::Null`).
  const E = load();
  E.setInvoke(() => "value-1");
  E.phone({ t: "cmd", id: 61, name: "get_state" });
  await drain();
  const call = E.invokeCalls.find(c => c.name === "remote_send");
  assert.ok(call, "remote_send was invoked");
  assert.deepEqual(Object.keys(call.args), ["frame"]);
  assert.deepEqual(call.args.frame, { t: "res", id: 61, ok: true, value: "value-1" });

  // evt forwards carry the same wrapper
  E.phone({ t: "cmd", id: 62, from: "p1", name: "sub", args: { name: "tab_update" } });
  await drain();
  E.forEvt("tab_update", { payload: { id: "t9" } });
  const evtCall = E.invokeCalls.filter(c => c.name === "remote_send").at(-1);
  assert.deepEqual(Object.keys(evtCall.args), ["frame"]);
  assert.deepEqual(evtCall.args.frame, { t: "evt", name: "tab_update", payload: { id: "t9" } });
});

await check("js: commands route to OMP_BRIDGE._remoteHandlers, unknown ones refuse", async () => {
  // live.js registers the handler under the wire name `list_tabs`
  // (snake_case, what the phone's _attachRemoteTabs calls).
  const E = load({ list_tabs: async () => ({ tabs: ["a", "b"] }) });
  E.phone({ t: "cmd", id: 31, name: "js:list_tabs" });
  await drain();
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 31, ok: true, value: { tabs: ["a", "b"] } });

  E.phone({ t: "cmd", id: 32, name: "js:nonexistent" });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 32, ok: false, error: "unknown js handler js:nonexistent" });
});

await check("a js: handler that throws answers ok:false with its message", async () => {
  const E = load({ boom: () => { throw new Error("handler exploded"); } });
  E.phone({ t: "cmd", id: 33, name: "js:boom" });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 33, ok: false, error: "handler exploded" });
});

await check("start_session mirrors the tab into the registry, normalized, BEFORE the Rust invoke", async () => {
  const order = [];
  const E = load({
    registerTab: (a) => { order.push(["registerTab", a]); },
  });
  E.setInvoke(() => { order.push(["invoke"]); return "ok"; });
  // camelCase payload (Rust's StartSessionArgs shape) at the frame's args
  E.phone({ t: "cmd", id: 41, name: "start_session", args: { sessionId: "s-1", cwd: "/repo", resume: null, profile: "default" } });
  await drain();
  assert.deepEqual(order, [
    ["registerTab", { id: "s-1", cwd: "/repo", name: null, profile: "default", resume: null }],
    ["invoke"],
  ]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["start_session", "remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 41, ok: true, value: "ok" });

  // without a sessionId there is nothing to mirror; the spawn still runs
  const seen = [];
  const E2 = load({ registerTab: (a) => { seen.push(a); } });
  E2.phone({ t: "cmd", id: 42, name: "start_session", args: { cwd: "/x" } });
  await drain();
  assert.deepEqual(seen, []);
});

await check("start_session on the real wire shape (args.args nesting) mirrors the tab before the Rust invoke", async () => {
  // live.js invokes `start_session` with `{ args: { sessionId, … } }` (the
  // Rust command's parameter is itself named `args`), and the shim frames
  // invoke() arguments verbatim — so the frame's args nests one level
  // deeper than other commands. The gate unwraps it.
  const order = [];
  const E = load({ registerTab: (a) => { order.push(["registerTab", a]); } });
  E.setInvoke(() => { order.push(["invoke"]); return "ok"; });
  E.phone({ t: "cmd", id: 43, name: "start_session", args: { args: { sessionId: "s-1", cwd: "/repo", resume: null, profile: "default" } } });
  await drain();
  assert.deepEqual(order, [
    ["registerTab", { id: "s-1", cwd: "/repo", name: null, profile: "default", resume: null }],
    ["invoke"],
  ]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["start_session", "remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 43, ok: true, value: "ok" });
});

await check("close_tab takes the desktop's own close path, never a bare close_tab invoke", async () => {
  const closed = [];
  const E = load({ closeTab: async (id) => { closed.push(id); return "closed"; } });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 42, name: "close_tab", args: { session_id: "s-9" } });
  await drain();
  assert.deepEqual(closed, ["s-9"]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 42, ok: true, value: null });

  // the sessionId spelling routes too
  E.phone({ t: "cmd", id: 43, name: "close_tab", args: { sessionId: "s-8" } });
  await drain();
  assert.deepEqual(closed, ["s-9", "s-8"]);
});

await check("close_all_tabs routes to the handler instead of Rust", async () => {
  const calls = [];
  const E = load({ closeAllTabs: async () => { calls.push("closeAllTabs"); } });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 44, name: "close_all_tabs" });
  await drain();
  assert.deepEqual(calls, ["closeAllTabs"]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
});

await check("open_project_at routes the phone's folder pick to the desktop handler, never the native dialog", async () => {
  const opened = [];
  const E = load({ openProjectAt: async (path) => { opened.push(path); return "id-1"; } });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 45, name: "open_project_at", args: { path: "/repo/x" } });
  await drain();
  assert.deepEqual(opened, ["/repo/x"]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 45, ok: true, value: "id-1" });

  // a handler failure answers false with the message, not a silent drop
  const E2 = load({ openProjectAt: async () => { throw new Error("spawn refused"); } });
  E2.setInvoke(() => { throw new Error("must not run"); });
  E2.phone({ t: "cmd", id: 46, name: "open_project_at", args: { path: "/nope" } });
  await drain();
  assert.deepEqual(lastRes(E2), { t: "res", id: 46, ok: false, error: "spawn refused" });
});

await check("js:get_messages_window routes the phone's transcript fetch to the desktop slicer", async () => {
  const seen = [];
  const E = load({ get_messages_window: async (a) => { seen.push(a); return { messages: [], hasOlder: true, nextBefore: 5 }; } });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 71, name: "js:get_messages_window", args: { sessionId: "s1", before: null, limit: 200 } });
  await drain();
  assert.deepEqual(seen, [{ sessionId: "s1", before: null, limit: 200 }]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 71, ok: true, value: { messages: [], hasOlder: true, nextBefore: 5 } });
});

await check("remote_list_dirs reaches the generic invoke (no unsupported/js wall)", async () => {
  const E = load();
  E.setInvoke(() => ({ parent: "/", entries: [] }));
  E.phone({ t: "cmd", id: 70, name: "remote_list_dirs", args: { path: "/x" } });
  await drain();
  const call = E.invokeCalls.find(c => c.name === "remote_list_dirs");
  assert.ok(call, "remote_list_dirs was invoked");
  assert.deepEqual(call.args, { path: "/x" });
  assert.deepEqual(lastRes(E), { t: "res", id: 70, ok: true, value: { parent: "/", entries: [] } });
});

await check("replay_events routes to the projected desktop handler, never the raw journal", async () => {
  const seen = [];
  const E = load({ remoteReplay: async (a) => { seen.push(a); return { events: [], headSeq: 7, dropped: false }; } });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 73, name: "replay_events", args: { sessionId: "s1", afterSeq: 3 } });
  await drain();
  assert.deepEqual(seen, [{ sessionId: "s1", afterSeq: 3 }]);
  assert.deepEqual(E.invokeCalls.map(c => c.name), ["remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 73, ok: true, value: { events: [], headSeq: 7, dropped: false } });
});

await check("reply values over the gzip threshold ride compressed and inflate back", async () => {
  const big = { messages: Array.from({ length: 4000 }, (_, i) => `row-${i}-padding-padding-padding`) };
  const E = load({ bigThing: async () => big });
  E.setInvoke(() => { throw new Error("must not run"); });
  E.phone({ t: "cmd", id: 74, name: "js:bigThing", args: {} });
  await new Promise((r) => setTimeout(r, 100)); // CompressionStream resolves on real tasks
  const res = lastRes(E);
  assert.equal(res.ok, true);
  assert.equal(typeof res.value.gz, "string", "value rode gzipped");
  const bin = atob(res.value.gz);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  assert.deepEqual(JSON.parse(text), big);
  // small values stay verbatim
  const E2 = load({ smallThing: async () => ({ a: 1 }) });
  E2.phone({ t: "cmd", id: 75, name: "js:smallThing", args: {} });
  await drain();
  assert.deepEqual(lastRes(E2).value, { a: 1 });
});

await check("a pair_request control frame dispatches remote-pair-request on the window", async () => {
  const E = load();
  E.control({ t: "pair_request", token: "tok", device: "Pixel" });
  const [ev] = E.windowEvents.slice(-1);
  assert.equal(ev.type, "remote-pair-request");
  assert.deepEqual(ev.detail, { t: "pair_request", token: "tok", device: "Pixel" });
});

await check("other control frames dispatch remote-control; status frames dispatch remote-status", async () => {
  const E = load();
  // A phone joining now rides a hello broadcast, not a window event
  E.control({ t: "peer", phone: "p1", online: true });
  assert.deepEqual(E.windowEvents, []);
  E.control({ t: "peer", phone: "p1", online: false }); // the drop: no event either
  assert.deepEqual(E.windowEvents, []);
  E.control({ t: "other", x: 1 });
  E.status({ state: "online", url: "wss://relay" });
  assert.equal(E.windowEvents.at(-1).type, "remote-status");
  E.status(null);
  assert.equal(E.windowEvents.at(-1).type, "remote-status");
  assert.equal(E.windowEvents.at(-1).detail, null);
});

await check("non-cmd phone frames are ignored; a nameless cmd answers without crashing", async () => {
  const E = load();
  E.phone({ t: "evt", name: "tab_update", payload: {} });
  E.phone(null);
  E.control(null);
  await drain();
  assert.deepEqual(E.sent, []);
  // no name → the dispatch falls through every gate to a plain invoke,
  // answered like any other command; nothing throws
  E.phone({ t: "cmd", id: 51, args: {} });
  await drain();
  assert.deepEqual(E.invokeCalls.map(c => c.name), [undefined, "remote_send"]);
  assert.deepEqual(lastRes(E), { t: "res", id: 51, ok: true, value: null });
});

// ── protocol v2: res `from` unicast, hello broadcast, update coalescing ──

await check("respond backfills the triggering cmd's `from` into every res frame", async () => {
  const E = load();
  E.setInvoke(() => "v1");
  E.phone({ t: "cmd", id: 81, from: "conn-7", name: "get_state", args: {} });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 81, ok: true, value: "v1", from: "conn-7" });

  // error replies carry it too
  E.setInvoke(() => { throw new Error("nope"); });
  E.phone({ t: "cmd", id: 82, from: "conn-7", name: "boom", args: {} });
  await drain();
  assert.deepEqual(lastRes(E), { t: "res", id: 82, ok: false, error: "nope", from: "conn-7" });

  // js: routing and the unsupported wall alike
  const E2 = load({ thing: async () => ({ a: 1 }) });
  E2.phone({ t: "cmd", id: 83, from: "c2", name: "js:thing", args: {} });
  await drain();
  assert.deepEqual(lastRes(E2), { t: "res", id: 83, ok: true, value: { a: 1 }, from: "c2" });
  E2.phone({ t: "cmd", id: 84, from: "c2", name: "open_project", args: {} });
  await drain();
  assert.deepEqual(lastRes(E2), { t: "res", id: 84, ok: false, error: "open_project is unsupported on remote", from: "c2" });

  // sub/unsub replies and a frame with NO from (legacy/relay broadcast)
  const E3 = load();
  E3.phone({ t: "cmd", id: 85, from: "c3", name: "sub", args: { name: "tab_update" } });
  await drain();
  assert.deepEqual(lastRes(E3), { t: "res", id: 85, ok: true, value: null, from: "c3" });
  E3.setInvoke(() => null);
  E3.phone({ t: "cmd", id: 86, name: "get_state", args: {} });
  await drain();
  assert.deepEqual(lastRes(E3), { t: "res", id: 86, ok: true, value: null }); // no from key at all
});

await check("the desktop broadcasts hello on connector-online and on every phone join (not on phone leave)", async () => {
  const E = load();
  assert.deepEqual(E.sent, []);

  // the connector reports its WS connection live → one hello
  E.status({ enabled: true, status: "online" });
  assert.deepEqual(E.sent, [{ t: "hello", v: 2, caps: ["gz", "transcript-window", "ask-sync", "e2e"] }]);
  // a duplicate online report does not re-broadcast
  E.status({ enabled: true, status: "online" });
  assert.equal(E.sent.length, 1);

  // a new phone joins the room → one more hello
  E.control({ t: "peer", phone: "p1", online: true });
  assert.equal(E.sent.length, 2);
  assert.deepEqual(E.sent.at(-1), { t: "hello", v: 2, caps: ["gz", "transcript-window", "ask-sync", "e2e"] });
  // a phone leaving never broadcasts
  E.control({ t: "peer", phone: "p1", online: false });
  assert.equal(E.sent.length, 2);

  // offline then online again (a desktop restart) re-announces once
  E.status({ enabled: true, status: "reconnecting (closed)" });
  E.status({ enabled: true, status: "online" });
  assert.equal(E.sent.length, 3);
  // and going fully off disarms it for the next enable cycle
  E.status({ enabled: false, status: "off" });
  E.status({ enabled: true, status: "online" });
  assert.equal(E.sent.length, 4);
});

await check("a peer with a phone id but no online field is left to the generic dispatch (no hello)", async () => {
  const E = load();
  E.control({ t: "peer", phone: "p1" });
  assert.deepEqual(E.sent, []);
  assert.equal(E.windowEvents.at(-1).type, "remote-control");
});

// Streaming-update coalescing: per session, 100 ms trailing edge.
const upd = (n) => ({ seq: n, text: JSON.stringify({ type: "message_update", message: { text: "t" + n } }) });

await check("message_update lines coalesce per session: the timer sends only the newest, 100 ms out", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
  E.phone({ t: "cmd", id: 2, from: "p1", name: "sub", args: { name: "agent://line/s-2" } });
  await drain();
  E.sent.length = 0; // drop the two sub acks

  // three updates for s-1, one for s-2: two timers arm, both 100 ms
  E.forEvt("agent://line/s-1", { payload: upd(1) });
  E.forEvt("agent://line/s-1", { payload: upd(2) });
  E.forEvt("agent://line/s-1", { payload: upd(3) });
  E.forEvt("agent://line/s-2", { payload: upd(1) });
  assert.deepEqual(E.sent, []); // nothing rides yet
  const timers = E.timerInfo();
  assert.equal(timers.length, 2, "one timer per session");
  assert.ok(timers.every((t) => t.delay === 100), "every timer is the 100 ms window");

  // let both timers fire: each session sends exactly ONE frame — its newest
  for (const t of timers) E.runTimer(t.id);
  assert.deepEqual(E.sent, [
    { t: "evt", name: "agent://line/s-1", payload: upd(3) },
    { t: "evt", name: "agent://line/s-2", payload: upd(1) },
  ]);
  assert.equal(E.timerCount(), 0);
});

await check("an update AFTER the window closes opens a fresh window (no spanning flush)", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
  await drain();
  E.sent.length = 0;

  E.forEvt("agent://line/s-1", { payload: upd(1) });
  E.runTimer(E.timerInfo()[0].id);
  assert.deepEqual(E.sent, [{ t: "evt", name: "agent://line/s-1", payload: upd(1) }]);

  // the next update starts a NEW window (the previous one already sent)
  E.forEvt("agent://line/s-1", { payload: upd(2) });
  assert.equal(E.timerCount(), 1);
  E.runTimer(E.timerInfo()[0].id);
  assert.deepEqual(E.sent.at(-1), { t: "evt", name: "agent://line/s-1", payload: upd(2) });
});

await check("message_end/agent_end/turn_end and non-update frames flush the pending update first, then ride immediately", async () => {
  for (const terminal of ["message_end", "agent_end", "turn_end"]) {
    const E = load();
    E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
    await drain();
    E.sent.length = 0;

    E.forEvt("agent://line/s-1", { payload: upd(1) });
    E.forEvt("agent://line/s-1", { payload: upd(2) }); // superseded
    const terminalPayload = { seq: 3, text: JSON.stringify({ type: terminal, message: { role: "assistant" } }) };
    E.forEvt("agent://line/s-1", { payload: terminalPayload });
    // order: the newest pending update, THEN the terminal frame — and no timer left
    assert.deepEqual(E.sent, [
      { t: "evt", name: "agent://line/s-1", payload: upd(2) },
      { t: "evt", name: "agent://line/s-1", payload: terminalPayload },
    ]);
    assert.equal(E.timerCount(), 0, `${terminal} disarmed the timer`);
  }

  // any NON-update frame (a tool_execution_start, a non-JSON line) rides
  // the same way: flush, then itself
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
  await drain();
  E.sent.length = 0;
  E.forEvt("agent://line/s-1", { payload: upd(1) });
  const nonUpdate = { seq: 9, text: JSON.stringify({ type: "tool_execution_start", tool: "bash" }) };
  E.forEvt("agent://line/s-1", { payload: nonUpdate });
  assert.deepEqual(E.sent, [
    { t: "evt", name: "agent://line/s-1", payload: upd(1) },
    { t: "evt", name: "agent://line/s-1", payload: nonUpdate },
  ]);

  // a raw non-JSON line is forwarded verbatim too (nothing parses it here)
  E.forEvt("agent://line/s-1", { payload: { seq: 10, text: "not json" } });
  assert.deepEqual(E.sent.at(-1), { t: "evt", name: "agent://line/s-1", payload: { seq: 10, text: "not json" } });
});

await check("coalescing never crosses sessions; unsubscribing a session clears its timer and pending update", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
  E.phone({ t: "cmd", id: 2, from: "p1", name: "sub", args: { name: "agent://line/s-2" } });
  await drain();
  E.sent.length = 0;

  // an update on s-1 flushes NOTHING pending on s-2 — and vice versa
  E.forEvt("agent://line/s-1", { payload: upd(1) });
  const endFrame = { seq: 5, text: JSON.stringify({ type: "message_end", message: {} }) };
  E.forEvt("agent://line/s-2", { payload: endFrame });
  assert.deepEqual(E.sent, [
    { t: "evt", name: "agent://line/s-2", payload: endFrame },
  ]); // s-2's terminal rode alone: s-1's pending update is still pending
  assert.equal(E.timerCount(), 1); // s-1's timer still armed

  // the phone drops s-1: its timer and pending frame are dropped with it
  E.phone({ t: "cmd", id: 3, from: "p1", name: "unsub", args: { name: "agent://line/s-1" } });
  await drain();
  assert.equal(E.timerCount(), 0);
  E.runTimersAll(); // nothing fires
  // the unsub's own res ack is the last frame; the pending update never sent
  assert.deepEqual(E.sent.at(-2), { t: "evt", name: "agent://line/s-2", payload: endFrame });
  assert.deepEqual(E.sent.at(-1), { t: "res", id: 3, ok: true, value: null, from: "p1" });
  assert.equal(E.sent.length, 2);
});

await check("a phone dropping offline flushes nothing stale: its sessions' pending updates die with the listener", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "agent://line/s-1" } });
  await drain();
  E.sent.length = 0;
  E.forEvt("agent://line/s-1", { payload: upd(1) });
  assert.equal(E.timerCount(), 1);

  E.control({ t: "peer", phone: "p1", online: false });
  await drain();
  assert.equal(E.timerCount(), 0);
  E.runTimersAll();
  assert.deepEqual(E.sent, []); // the pending update never reached the wire
});

await check("non-agent://line events are never coalesced (evt rides immediately)", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 1, from: "p1", name: "sub", args: { name: "tab_update" } });
  await drain();
  E.sent.length = 0;
  E.forEvt("tab_update", { payload: { id: "t1", state: "running" } });
  E.forEvt("tab_update", { payload: { id: "t1", state: "done" } });
  assert.deepEqual(E.sent, [
    { t: "evt", name: "tab_update", payload: { id: "t1", state: "running" } },
    { t: "evt", name: "tab_update", payload: { id: "t1", state: "done" } },
  ]);
  assert.equal(E.timerCount(), 0);
});

// ── browser panel channel (phone screencast) ──────────────────────────────

await check("browser_open_panel swaps the phone's placeholder for the desktop's real Channel", async () => {
  const E = load();
  E.setInvoke(() => null);
  E.phone({
    t: "cmd", id: 90, from: "p1", name: "browser_open_panel",
    args: { sessionId: "s1", width: 10, height: 10, dpr: 2, events: { __remoteChannel: true } },
  });
  await drain();
  const call = E.invokeCalls.find((c) => c.name === "browser_open_panel");
  assert.ok(call, "browser_open_panel was invoked");
  assert.ok(call.args.events instanceof E.win.__TAURI__.core.Channel, "placeholder replaced by a real Channel");
  // the rest of the phone's args ride verbatim
  assert.equal(call.args.sessionId, "s1");
  assert.equal(call.args.width, 10);
  assert.equal(call.args.height, 10);
  assert.equal(call.args.dpr, 2);
  assert.deepEqual(lastRes(E), { t: "res", id: 90, ok: true, value: null, from: "p1" });
});

await check("every frame the desktop's Channel receives rides out as one browser://frame evt", async () => {
  const E = load();
  E.setInvoke(() => null);
  E.phone({
    t: "cmd", id: 91, name: "browser_open_panel",
    args: { sessionId: "s1", width: 10, height: 10, dpr: 2, events: { __remoteChannel: true } },
  });
  await drain();
  const ch = E.invokeCalls.find((c) => c.name === "browser_open_panel").args.events;
  E.sent.length = 0;
  ch.onmessage({ seq: 1, data: "x" });
  assert.deepEqual(E.sent, [{ t: "evt", name: "browser://frame/s1", payload: { seq: 1, data: "x" } }]);
});

await check("browser_close_panel drops the mapping: the dead channel sends nothing more", async () => {
  const E = load();
  E.setInvoke(() => null);
  E.phone({
    t: "cmd", id: 92, name: "browser_open_panel",
    args: { sessionId: "s1", events: { __remoteChannel: true } },
  });
  await drain();
  const ch = E.invokeCalls.find((c) => c.name === "browser_open_panel").args.events;

  E.phone({ t: "cmd", id: 93, name: "browser_close_panel", args: { sessionId: "s1" } });
  await drain();
  const close = E.invokeCalls.find((c) => c.name === "browser_close_panel");
  assert.ok(close, "browser_close_panel was invoked");
  assert.deepEqual(close.args, { sessionId: "s1" });
  assert.deepEqual(lastRes(E), { t: "res", id: 93, ok: true, value: null });

  E.sent.length = 0;
  ch.onmessage({ seq: 2, data: "late" });
  assert.deepEqual(E.sent, []);
});

await check("a browser://frame sub registers no Tauri listener and still acks", async () => {
  const E = load();
  E.phone({ t: "cmd", id: 94, from: "p1", name: "sub", args: { name: "browser://frame/s1" } });
  await drain();
  assert.ok(!E.subscribed().includes("browser://frame/s1"));
  assert.deepEqual(lastRes(E), { t: "res", id: 94, ok: true, value: null, from: "p1" });

  // and the matching unsub stays inert (nothing was ever counted)
  E.phone({ t: "cmd", id: 95, from: "p1", name: "unsub", args: { name: "browser://frame/s1" } });
  await drain();
  assert.deepEqual(E.unlistens, []);
  assert.deepEqual(lastRes(E), { t: "res", id: 95, ok: true, value: null, from: "p1" });
});

// ── binary screencast frames ───────────────────────────────────────────────
await check("a binary channel message rides the evt as base64 and decodes back", async () => {
  const E = load({});
  E.phone({ t: "cmd", id: 90, name: "browser_open_panel", args: { sessionId: "s9", width: 1, height: 1, dpr: 1, events: { __remoteChannel: true } } });
  await drain();
  const ch = E.channels && E.channels.length ? E.channels[E.channels.length - 1] : null;
  // harness may not expose channels; find it through the invoke stub instead
  const call = E.invokeCalls.find(c => c.name === "browser_open_panel");
  const channel = call.args.events;
  const bytes = new Uint8Array([1, 2, 3, 250]);
  channel.onmessage(bytes.buffer);
  const evt = E.sent.filter(f => f.t === "evt" && f.name === "browser://frame/s9").pop();
  assert.ok(evt.payload.bin);
  const bin = atob(evt.payload.bin);
  assert.deepEqual([...bin].map(c => c.charCodeAt(0)), [1, 2, 3, 250]);
});

// ── summary ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`test-remote-agent: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`test-remote-agent: ${passed} checks passed`);
