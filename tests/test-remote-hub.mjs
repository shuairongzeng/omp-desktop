#!/usr/bin/env node
// Regression script for src/app/remote-hub.js — the phone's device picker:
// the inert-under-Tauri guard, one presence socket per listed device
// (opened only while the hub is visible, closed on hide), peer frames
// flipping row status, `device` frames persisting the display name and
// announcing it to the app, online-only choose (persist + deliberate
// reload), local forget with its confirm gate, the pair-code entry, and
// noteDevice (the control socket's delegate). DOM and WebSocket are
// hand-triggered fakes; nothing touches the network or the event loop.
// Run: node tests/test-remote-hub.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devicesSrc = readFileSync(join(root, "src/app/remote-devices.js"), "utf8");
const hubSrc = readFileSync(join(root, "src/app/remote-hub.js"), "utf8");

const KEY = "omp-remote:devices";
const storeWith = (...devices) => JSON.stringify({
  devices: devices.map(([device, token, name = "", os = ""]) =>
    ({ device, token, name, os, lastUsed: 0 })),
  selected: devices.length ? devices[0][0] : null,
});

function makeEnv(opts = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onmessage = null;
      this.onclose = null;
      sockets.push(this);
    }
    message(f) { if (this.onmessage) this.onmessage({ data: JSON.stringify(f) }); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const created = [];
  const mkEl = (tag) => {
    const el = {
      tagName: tag, id: "", className: "", textContent: "",
      placeholder: "", maxLength: 0, value: "",
      style: {}, children: [], _listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      click() { for (const fn of this._listeners.click || []) fn({ stopPropagation() {} }); },
    };
    created.push(el);
    return el;
  };

  const map = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };

  const events = [];
  const listeners = new Map();
  const win = {
    dispatchEvent: (ev) => { events.push(ev); for (const fn of listeners.get(ev.type) || []) fn(ev); },
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener: (t, fn) => { listeners.set(t, (listeners.get(t) || []).filter((f) => f !== fn)); },
    confirm: opts.confirm ?? (() => true),
  };
  if (opts.tauri) win.__TAURI__ = opts.tauri;
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }

  const reloadCalls = [];
  const replaceCalls = [];
  const location = {
    protocol: "https:", host: "relay.example.com", pathname: "/",
    reload: () => reloadCalls.push(1),
    replace: (to) => replaceCalls.push(to),
  };

  const document = { head: mkEl("head"), body: mkEl("body"), createElement: (tag) => mkEl(tag) };

  const argNames = ["window", "document", "localStorage", "location", "WebSocket", "CustomEvent", "console"];
  const argVals = [win, document, localStorage, location, FakeWebSocket, CustomEvent,
    { log() {}, warn() {}, error() {} }];
  // eslint-disable-next-line no-new-func
  new Function(...argNames, devicesSrc)(...argVals);
  // eslint-disable-next-line no-new-func
  new Function(...argNames, hubSrc)(...argVals);

  const listBox = () => created.find((e) => e.className === "rh-list");
  return {
    win, document, location, localStorage, sockets, created, events,
    reloadCalls, replaceCalls,
    hub: win.OMP_REMOTE_HUB,
    overlay: () => document.body.children.find((c) => c.id === "remote-hub") || null,
    rows: () => listBox()?.children || [],
    saved: () => JSON.parse(localStorage.getItem(KEY) || "null"),
  };
}

const rowName = (row) => row.children[1].children[0].textContent;
const rowMeta = (row) => row.children[1].children[1].textContent;
const forgetBtn = (row) => row.children[row.children.length - 1];

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// ── the guard ──────────────────────────────────────────────────────────────
{
  const E = makeEnv({ tauri: { core: {}, event: {} } });
  assert.equal(E.hub, undefined);
  assert.equal(E.sockets.length, 0);
  ok("under a real Tauri webview the hub never initializes");
}

// ── open: overlay + one presence socket per device ─────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "PC One", "windows"], ["d2", "t2"]) } });
  E.hub.open();
  assert.ok(E.overlay(), "the hub overlay is mounted");
  assert.equal(E.overlay().style.display, "flex");
  assert.equal(E.hub.isOpen(), true);
  assert.equal(E.sockets.length, 2);
  assert.equal(E.sockets[0].url, "wss://relay.example.com/ws?role=phone&device=d1&token=t1");
  assert.equal(E.sockets[1].url, "wss://relay.example.com/ws?role=phone&device=d2&token=t2");

  const rows = E.rows();
  assert.equal(rows.length, 2);
  assert.equal(rowName(rows[0]), "PC One");
  assert.ok(rows[0].className.includes("connecting"), "status starts as connecting");
  assert.equal(rowName(rows[1]), "桌面 d2"); // no reported name yet
  assert.equal(rowMeta(rows[1]), "连接中…");
  // The selected device wears the 当前 tag.
  assert.ok(rows[0].children.some((c) => c.textContent === "当前"));
  assert.ok(!rows[1].children.some((c) => c.textContent === "当前"));
  ok("open builds one row + one presence socket per paired device");
}

// ── presence + identity frames drive the rows ──────────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "PC One", "windows"], ["d2", "t2"]) } });
  E.hub.open();

  E.sockets[0].message({ t: "peer", desktop: true });
  let rows = E.rows();
  assert.ok(rows[0].className.includes("online"));
  assert.equal(rowMeta(rows[0]), "Windows · 在线");
  assert.ok(rows[1].className.includes("connecting"), "the other row is untouched");

  E.sockets[1].message({ t: "peer", desktop: false });
  rows = E.rows();
  assert.ok(rows[1].className.includes("offline"));
  assert.equal(rowMeta(rows[1]), "离线");
  ok("peer frames flip the row status live (online / offline)");

  E.sockets[1].message({ t: "device", name: "Mac Studio", os: "macos" });
  assert.equal(E.saved().devices.find((d) => d.device === "d2").name, "Mac Studio");
  const ev = E.events.find((e) => e.type === "omp:remote-device");
  assert.deepEqual(ev.detail, { device: "d2", name: "Mac Studio", os: "macos" });
  rows = E.rows();
  assert.equal(rowName(rows[1]), "Mac Studio");
  assert.ok(rowMeta(rows[1]).includes("macOS"));
  ok("a device frame persists the name and announces it via omp:remote-device");

  // A socket drop reads as offline (status light only, no retry loop).
  E.sockets[0].close();
  rows = E.rows();
  assert.ok(rows[0].className.includes("offline"));
  ok("a dropped presence socket marks its row offline");
}

// ── choose ─────────────────────────────────────────────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "PC One", "windows"], ["d2", "t2", "Two", "linux"]) } });
  E.hub.open();
  // d2 comes online; the selection is d1 — pick d2.
  E.sockets[1].message({ t: "peer", desktop: true });
  E.rows()[1].click();
  assert.equal(E.reloadCalls.length, 1);
  const saved = E.saved();
  assert.equal(saved.selected, "d2");
  assert.ok(saved.devices.find((d) => d.device === "d2").lastUsed > 0, "lastUsed stamped");
  assert.equal(E.overlay().style.display, "none", "the hub hides on choose");
  assert.equal(E.hub.isOpen(), false);
  assert.ok(E.sockets.every((s) => s.readyState === 3), "presence sockets close with the hub");
  ok("choosing an online device persists the selection, stamps lastUsed and reloads once");
}
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1"], ["d2", "t2"]) } });
  E.hub.open();
  E.sockets[0].message({ t: "peer", desktop: false });
  E.rows()[0].click();
  assert.equal(E.reloadCalls.length, 0);
  assert.equal(E.saved().selected, "d1");
  // A row still "connecting" is not selectable either — presence unknown.
  E.rows()[1].click();
  assert.equal(E.reloadCalls.length, 0);
  ok("offline (and still-connecting) rows refuse the switch");
}

// ── forget ─────────────────────────────────────────────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "One"], ["d2", "t2", "Two"]) } });
  E.hub.open();
  assert.equal(forgetBtn(E.rows()[0]).textContent, "遗忘");
  forgetBtn(E.rows()[0]).click(); // confirm → true
  const saved = E.saved();
  assert.deepEqual(saved.devices.map((d) => d.device), ["d2"]);
  assert.equal(saved.selected, "d2", "the forgotten selection falls back");
  assert.equal(E.rows().length, 1);
  ok("forgetting drops the local pairing and moves the selection");

  const E2 = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1"], ["d2", "t2"]) }, confirm: () => false });
  E2.hub.open();
  forgetBtn(E2.rows()[0]).click();
  assert.equal(E2.saved().devices.length, 2);
  ok("a declined confirm keeps the pairing");
}

// ── noteDevice (the control socket's delegate) ─────────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "Old", "windows"]) } });
  E.hub.noteDevice("d1", { t: "device", name: "Renamed", os: "windows" });
  assert.equal(E.saved().devices[0].name, "Renamed");
  assert.equal(E.events.filter((e) => e.type === "omp:remote-device").length, 1);
  E.hub.noteDevice("nope", { name: "x" }); // unknown device: ignored
  assert.equal(E.saved().devices.length, 1);
  assert.equal(E.saved().devices[0].name, "Renamed");
  ok("noteDevice folds control-socket device frames into the registry");
}

// ── reopen, empty list, pair-code entry, current ───────────────────────────
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1", "One"]) } });
  E.hub.open();
  E.hub.close();
  assert.equal(E.overlay().style.display, "none");
  E.hub.open();
  assert.equal(E.sockets.length, 2, "reopening dials fresh presence sockets");

  const cur = E.hub.current();
  assert.equal(cur.device, "d1");
  ok("close hides + drops sockets; reopen redials; current() is the selected entry");
}
{
  const E = makeEnv({ storage: {} });
  E.hub.open();
  assert.equal(E.sockets.length, 0);
  assert.equal(E.rows().length, 1);
  assert.ok(E.rows()[0].textContent.includes("配对新桌面"));
  assert.equal(E.hub.current(), null);
  ok("an empty registry shows the pairing hint and dials nothing");
}
{
  const E = makeEnv({ storage: { [KEY]: storeWith(["d1", "t1"]) } });
  E.hub.open();
  const input = E.created.find((e) => e.className === "rh-input");
  const go = E.created.find((e) => e.className === "rh-btn" && e.textContent === "配对");
  input.value = " ABCD-1234 ";
  go.click();
  assert.deepEqual(E.replaceCalls, ["/p#ABCD-1234"]);
  ok("the pair pane redeems a typed code by opening /p#<code>");
}

console.log(`remote-hub: ${n} checks passed`);
