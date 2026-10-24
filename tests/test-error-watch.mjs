#!/usr/bin/env node
// Regression script for src/app/error-watch.js — window.OMP_ERRORS, the
// fault-evidence ring buffer behind the R6 reliability round.
// Run: node tests/test-error-watch.mjs
//
// Semantics pinned by this file (choices, not accident):
// - clear() zeroes the list but KEEPS dropped(): overflow is a lifetime
//   fact about the window, and hiding it would fake a healthy run.
// - limit can be passed via install({ limit }) and survives until the
//   next install (a later install without limit resets to default 40 —
//   "re-init the app" semantics; an explicit limit is honoured).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/error-watch.js"), "utf8");

// ── window stub: addEventListener/removeEventListener recording + fire ────
function makeWindow() {
  const listeners = new Map(); // type → Set of handlers
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    // Trigger the registered handlers for `type` with event `e`.
    // A handler that throws must not break the others (matches DOM).
    fire(type, e) {
      const fns = [...(listeners.get(type) || [])];
      for (const fn of fns) fn(e);
    },
    // How many handlers are live for `type` (0, 1, …).
    handlerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    console: { warn: () => {}, error: () => {}, log: () => {} },
  };
  return win;
}

// Load the IIFE into a fresh stub. The module reads the global `console`
// for onEvent warnings — in a browser that's window.console; under the
// stub, globalThis.console (node's) is used, so we spy that instead.
const realWarn = console.warn;
let warns = 0;
console.warn = () => { warns++; };

const win = makeWindow();
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const E = win.OMP_ERRORS;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.warn = realWarn;
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

// Helper: a minimal ErrorEvent shape as browsers dispatch it.
function errorEvent({ message, filename, lineno, colno, error } = {}) {
  return { message, filename, lineno, colno, error, target: null };
}

// ── install / uninstall plumbing ─────────────────────────────────────────

check("install returns uninstall and hooks both listeners", () => {
  assert.equal(typeof E.install, "function");
  const un = E.install();
  assert.equal(typeof un, "function");
  assert.equal(win.handlerCount("error"), 1);
  assert.equal(win.handlerCount("unhandledrejection"), 1);
  un();
  assert.equal(win.handlerCount("error"), 0);
  assert.equal(win.handlerCount("unhandledrejection"), 0);
});

check("uninstall stops recording; list/dropped stay queryable", () => {
  const un = E.install();
  win.fire("error", errorEvent({ message: "before teardown", filename: "a.js", lineno: 3, colno: 7 }));
  assert.equal(E.count(), 1);
  un();
  win.fire("error", errorEvent({ message: "after teardown" }));
  assert.equal(E.count(), 1, "event after uninstall must not be recorded");
  assert.equal(E.list()[0].message, "before teardown");
});

check("repeated install is idempotent — one event, one entry", () => {
  E.clear(); // drop the previous check's leftover entry
  E.install(); // second install must unhook the first
  assert.equal(win.handlerCount("error"), 1, "duplicate install stacked handlers");
  win.fire("error", errorEvent({ message: "boom" }));
  assert.equal(E.count(), 1, "one native event produced more than one entry");
  E.clear();
});

// ── error events ─────────────────────────────────────────────────────────

check("error event → entry with kind/message/source", () => {
  E.uninstall();
  E.clear();
  E.install();
  win.fire("error", errorEvent({ message: "cannot read props of undefined", filename: "https://x/app.js", lineno: 42, colno: 11 }));
  const [entry] = E.list();
  assert.equal(entry.kind, "error");
  assert.equal(entry.message, "cannot read props of undefined");
  assert.equal(entry.source, "https://x/app.js:42:11");
  assert.equal(typeof entry.t, "number");
  E.clear();
});

check("error.error.message wins over the event message field", () => {
  win.fire("error", errorEvent({ message: "field message", error: new Error("inner message") }));
  assert.equal(E.list().at(-1).message, "inner message");
  E.clear();
});

check("error event without filename carries no source key", () => {
  win.fire("error", errorEvent({ message: "no location" }));
  const entry = E.list().at(-1);
  assert.equal(entry.source, undefined);
  assert.ok(!("source" in entry), "source must be absent, not null");
  E.clear();
});

check("resource load failure (Event without message) is recorded", () => {
  // DOM Event: target is a getter, so a plain object shaped like the
  // dispatched event (browsers dispatch these with a null message).
  const ev = { message: null, error: null, filename: null, lineno: null, colno: null, target: { src: "https://x/img.png" } };
  win.fire("error", ev);
  const entry = E.list().at(-1);
  assert.equal(entry.kind, "error");
  assert.ok(entry.message.includes("img.png"), `message names the resource: ${entry.message}`);
  assert.equal(entry.source, undefined); // source is script location, not the resource URL
  E.clear();
});

// ── unhandledrejection ───────────────────────────────────────────────────

check("rejection with an Error reason records its message", () => {
  win.fire("unhandledrejection", { reason: new Error("async boom") });
  const entry = E.list().at(-1);
  assert.equal(entry.kind, "rejection");
  assert.equal(entry.message, "async boom");
  E.clear();
});

check("rejection with a string reason records the string", () => {
  win.fire("unhandledrejection", { reason: "plain string rejection" });
  assert.equal(E.list().at(-1).message, "plain string rejection");
  E.clear();
});

check("rejection with an object reason is stringified, never crashes", () => {
  win.fire("unhandledrejection", { reason: { code: 7 } });
  const entry = E.list().at(-1);
  assert.equal(entry.kind, "rejection");
  assert.ok(entry.message.length > 0);
  E.clear();
  win.fire("unhandledrejection", { reason: null });
  assert.equal(E.list().at(-1).message, "null");
  E.clear();
  // circular object: JSON.stringify throws → String() fallback
  const circular = {};
  circular.self = circular;
  win.fire("unhandledrejection", { reason: circular });
  assert.ok(E.list().at(-1).message.length > 0);
  E.clear();
});

// ── ring buffer ──────────────────────────────────────────────────────────

check("ring overflow: limit=3, five events → 3 kept, 2 dropped, newest last", () => {
  E.uninstall();
  E.clear();
  E.install({ limit: 3 });
  for (let i = 1; i <= 5; i++) {
    win.fire("error", errorEvent({ message: `fault ${i}` }));
  }
  const list = E.list();
  assert.equal(list.length, 3, `kept entries: ${list.length}`);
  assert.equal(E.dropped(), 2);
  // oldest evicted first: the survivors are 3, 4, 5 — newest at the tail.
  assert.deepEqual(list.map(e => e.message), ["fault 3", "fault 4", "fault 5"]);
});

check("record() participates in the same ring (boundary entries drop too)", () => {
  E.uninstall();
  E.install({ limit: 2 }); // fresh ring; install reset dropped to 0
  E.record({ kind: "render", message: "panel a: smoke" });
  E.record({ kind: "render", message: "panel b: smoke" });
  E.record({ kind: "render", message: "panel c: smoke" });
  const list = E.list();
  assert.deepEqual(list.map(e => e.message), ["panel b: smoke", "panel c: smoke"]);
  assert.equal(E.dropped(), 1, "record() overflow must count as dropped");
  E.uninstall();
});

// ── record() ─────────────────────────────────────────────────────────────

check("record() defaults kind to render and forwards source", () => {
  E.clear();
  E.record({ message: "chat: widget failed to render" });
  const [entry] = E.list();
  assert.equal(entry.kind, "render");
  assert.equal(entry.message, "chat: widget failed to render");
  E.record({ message: "with source", source: "b.jsx:1:2" });
  assert.equal(E.list().at(-1).source, "b.jsx:1:2");
  E.clear();
});

check("record() tolerates malformed input and still leaves a trace", () => {
  E.record(null);
  E.record({});
  assert.equal(E.count(), 2);
  assert.ok(E.list().every(e => e.message.length > 0));
  assert.equal(E.list()[0].kind, "render");
  E.clear();
});

// ── message clipping ─────────────────────────────────────────────────────

check("messages are clipped at 300 characters", () => {
  E.clear();
  const long = "x".repeat(500);
  E.record({ message: long });
  assert.equal(E.list()[0].message.length, 300);
  assert.ok(E.list()[0].message.startsWith("x"));
  // exactly at the boundary is untouched
  E.record({ message: "y".repeat(300) });
  assert.equal(E.list()[1].message.length, 300);
  assert.ok(E.list()[1].message.startsWith("y"));
  E.clear();
});

// ── list() copies / count() / clear() semantics ──────────────────────────

check("list() returns a copy; mutating it cannot corrupt the buffer", () => {
  E.clear();
  E.record({ message: "keep me" });
  const copy = E.list();
  copy.push({ fake: true });
  copy.pop();
  assert.equal(E.count(), 1);
  E.clear();
});

check("clear() zeroes count but keeps dropped (pinned choice)", () => {
  E.uninstall();
  E.clear();
  E.install({ limit: 2 });
  win.fire("error", errorEvent({ message: "a" }));
  win.fire("error", errorEvent({ message: "b" }));
  win.fire("error", errorEvent({ message: "c" }));
  assert.equal(E.dropped(), 1, "one entry evicted from the limit-2 ring");
  assert.equal(E.count(), 2);
  E.clear();
  assert.equal(E.count(), 0);
  assert.equal(E.list().length, 0);
  assert.equal(E.dropped(), 1, "dropped must survive clear()");
  E.uninstall();
  E.clear();
  E.install(); // restore default-40 install for the remaining checks
});

// ── onEvent ──────────────────────────────────────────────────────────────

check("onEvent receives each entry as recorded", () => {
  E.clear();
  const seen = [];
  E.install({ onEvent: (entry) => seen.push(entry) });
  win.fire("error", errorEvent({ message: "observed", filename: "c.js", lineno: 1, colno: 1 }));
  E.record({ message: "observed too" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].message, "observed");
  assert.equal(seen[0].kind, "error");
  assert.equal(seen[1].kind, "render");
  // same object identity as what list() holds
  assert.equal(seen[0].message, E.list()[0].message);
  E.uninstall();
  E.clear();
});

check("a throwing onEvent is swallowed with a warn; the entry survives", () => {
  E.clear();
  const before = warns;
  E.install({ onEvent: () => { throw new Error("observer bug"); } });
  win.fire("error", errorEvent({ message: "still recorded" }));
  assert.equal(E.count(), 1, "entry must land even if onEvent throws");
  assert.equal(E.list()[0].message, "still recorded");
  assert.equal(warns, before + 1, "exactly one console.warn for the throwing callback");
  E.uninstall();
  E.clear();
});

// ── entry shape sanity (contract: t, kind, message, source?) ─────────────

check("entries carry t timestamps in non-decreasing order", () => {
  E.clear();
  E.install();
  win.fire("error", errorEvent({ message: "t1" }));
  E.record({ message: "t2" });
  win.fire("unhandledrejection", { reason: "t3" });
  const list = E.list();
  assert.ok(list.every(e => Number.isFinite(e.t)));
  assert.ok(list[0].t <= list[1].t && list[1].t <= list[2].t);
  assert.deepEqual(list.map(e => e.kind), ["error", "render", "rejection"]);
  E.uninstall();
  E.clear();
});

// ── no preventDefault / no listener swamping ─────────────────────────────

check("install never calls preventDefault or stopPropagation on events", () => {
  E.clear();
  E.install();
  let prevented = false;
  let stopped = false;
  const ev = errorEvent({ message: "p" });
  ev.preventDefault = () => { prevented = true; };
  ev.stopPropagation = () => { stopped = true; };
  win.fire("error", ev);
  assert.equal(prevented, false, "watcher must not preventDefault");
  assert.equal(stopped, false, "watcher must not stopPropagation");
  E.uninstall();
  E.clear();
});

console.warn = realWarn;

console.log(`error-watch: ${passed} checks passed`);
