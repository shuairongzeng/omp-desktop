// tests/test-esc-close.mjs — app/use-esc-close.js (the shared Escape stack).
// Runs the module against a tiny window stub and a React stand-in (refs,
// memo, effects with deps + cleanup — enough for useEscClose), covering the
// round-1 regression: stacked overlays must close topmost-first, not
// bottom-first.
// Run: node tests/test-esc-close.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/app/use-esc-close.js", import.meta.url), "utf8");

/** A window stand-in: addEventListener/removeEventListener with listener
 *  counts, and `fire(type, ev)` that runs the listeners in registration
 *  order (the order same-target listeners run in a real browser). */
function windowStub() {
  const on = new Map();
  const fire = (type, ev = {}) => {
    ev.defaultPrevented ??= false;
    ev.propagationStopped ??= false;
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev.propagationStopped = true; };
    for (const fn of [...(on.get(type) ?? [])]) fn(ev);
    return ev;
  };
  return {
    addEventListener(type, fn) { if (!on.has(type)) on.set(type, new Set()); on.get(type).add(fn); },
    removeEventListener(type, fn) { on.get(type)?.delete(fn); },
    listeners: (type) => on.get(type)?.size ?? 0,
    fire,
  };
}

const depsEqual = (a, b) => a.length === b.length && a.every((d, i) => d === b[i]);

/** React stand-in, like tests/test-browser-runtime.mjs's fakeReact but
 *  minimal for this hook: per-component slots, effects run after the render
 *  when their deps changed (cleanup first), cleanups run on unmount. */
function reactStub() {
  let current = null;
  let cursor = 0;
  const React = {
    useRef(init) {
      const s = current.refs[cursor] ?? (current.refs[cursor] = { current: init });
      cursor++;
      return s;
    },
    useMemo(fn, deps) {
      const i = cursor;
      const s = current.memos[i];
      cursor++;
      if (!s || !depsEqual(s.deps, deps)) {
        current.memos[i] = { deps: [...deps], value: fn() };
        return current.memos[i].value;
      }
      return s.value;
    },
    useEffect(fn, deps) {
      const i = cursor;
      cursor++;
      const prev = current.effects[i];
      if (!prev || !depsEqual(prev.deps, deps)) {
        prev?.cleanup?.();
        current.effects[i] = { deps: [...deps], cleanup: fn() ?? null };
      }
    },
  };
  const mount = (fn) => {
    const comp = { refs: [], memos: [], effects: [] };
    const run = (f) => { current = comp; cursor = 0; f(); current = null; };
    run(fn);
    return {
      rerender: run,
      unmount: () => {
        comp.effects.forEach((e) => e.cleanup?.());
        comp.effects = [];
      },
    };
  };
  return { React, mount };
}

/** The module against a fresh window; `mount(fn)` runs a component body
 *  (which calls window.useEscClose) and returns { rerender, unmount }. */
function harness() {
  const win = windowStub();
  const { React, mount } = reactStub();
  new Function("window", "React", src)(win, React);
  const use = (onClose, active = true) => win.useEscClose(onClose, active);
  return { win, use, mount, fire: (ev) => win.fire("keydown", ev) };
}

test("one capture-phase window listener serves any number of registrations", () => {
  const { win, use, mount } = harness();
  assert.equal(win.listeners("keydown"), 0); // nothing installed before a mount
  const a = mount(() => use(() => {}));
  assert.equal(win.listeners("keydown"), 1);
  const b = mount(() => use(() => {}));
  const c = mount(() => use(() => {}));
  assert.equal(win.listeners("keydown"), 1); // still exactly one
  b.unmount();
  c.unmount();
  a.unmount();
  assert.equal(win.listeners("keydown"), 1); // the shared listener stays installed
});

test("topmost (last registered) wins: a stacked overlay above does not close the one below", () => {
  const { use, mount, fire } = harness();
  const closed = [];
  mount(() => use(() => closed.push("bottom"))); // kanban, z-90
  mount(() => use(() => closed.push("top")));    // bridge, z-100
  const ev = fire({ key: "Escape" });
  assert.deepEqual(closed, ["top"]);
  assert.ok(ev.defaultPrevented);
  assert.ok(ev.propagationStopped);
});

test("unregister on unmount: the next one down takes the next Escape", () => {
  const { use, mount, fire } = harness();
  const closed = [];
  const a = mount(() => use(() => closed.push("a")));
  const b = mount(() => use(() => closed.push("b")));
  const c = mount(() => use(() => closed.push("c")));
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["c"]);
  c.unmount();
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["c", "b"]);
  b.unmount();
  a.unmount();
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["c", "b"]); // nothing left to close
});

test("inactive registrations are skipped, not displaced", () => {
  const { use, mount, fire } = harness();
  const closed = [];
  const a = mount(() => use(() => closed.push("a")));
  const b = mount(() => use(() => closed.push("b"), false)); // mounted, not open
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["a"]); // b's later registration does not shadow a
  // Re-activate b without re-registering: it is now the topmost.
  b.rerender(() => use(() => closed.push("b"), true));
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["a", "b"]);
  b.unmount();
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["a", "b", "a"]);
});

test("an always-mounted overlay that re-opens moves to the top of the stack", () => {
  const { use, mount, fire } = harness();
  const closed = [];
  // The command bridge: mounted once at app start, opens and closes on
  // `active` without unmounting.
  const bridge = mount(() => use(() => closed.push("bridge"), false));
  const kanban = mount(() => use(() => closed.push("kanban"))); // mounts later, z-90
  bridge.rerender(() => use(() => closed.push("bridge"), true)); // bridge opens above it
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["bridge"]); // z-100 closes, z-90 stays — the reported bug
  bridge.rerender(() => use(() => closed.push("bridge"), false)); // closed, still mounted
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["bridge", "kanban"]); // now the kanban is topmost
  kanban.unmount();
  fire({ key: "Escape" });
  assert.deepEqual(closed, ["bridge", "kanban"]); // bridge inactive: nothing closes
});

test("only a bare, unclaimed Escape dispatches", () => {
  const { use, mount, fire } = harness();
  const closed = [];
  mount(() => use(() => closed.push("x")));
  fire({ key: "Enter" });
  fire({ key: "Escape", ctrlKey: true });
  fire({ key: "Escape", altKey: true });
  fire({ key: "Escape", metaKey: true });
  fire({ key: "Escape", isComposing: true });
  const claimed = fire({ key: "Escape", defaultPrevented: true });
  assert.deepEqual(closed, []);
  assert.equal(claimed.propagationStopped, false); // a claimed key is left entirely alone
});

test("onClose is read through a ref: a rerender swaps the callback without re-registering", () => {
  const { win, use, mount, fire } = harness();
  const calls = [];
  const m = mount(() => use(() => calls.push("first")));
  m.rerender(() => use(() => calls.push("second")));
  assert.equal(win.listeners("keydown"), 1);
  fire({ key: "Escape" });
  assert.deepEqual(calls, ["second"]);
});

test("the close callback receives the event", () => {
  const { use, mount, fire } = harness();
  let got = null;
  mount(() => use((e) => { got = e; }));
  const ev = fire({ key: "Escape" });
  assert.equal(got, ev);
});
