#!/usr/bin/env node
// Runtime regression for the terminal panel's phone tier: the touch key
// row (which caps render, the sequences they write, the sticky Ctrl's
// ride-and-disarm, the paste path) and the no-focus-on-open guard —
// app/use-terminal.jsx and design/terminal-panel.jsx against stubs, under
// the effect-running React stand-in from test-browser-runtime.mjs.
// Run: node tests/test-terminal-mobile.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Enough React for useTerminal's hook slots (test-browser-runtime.mjs's
 *  stand-in): state setters write the slot, so a re-render observes them. */
function fakeReact() {
  const slots = [];
  let i = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, k) => !Object.is(v, b[k]));
  let pending = [];
  const React = {
    useState(initial) {
      const k = i++;
      if (!(k in slots)) slots[k] = { value: typeof initial === "function" ? initial() : initial };
      const s = slots[k];
      return [s.value, (v) => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(initial) {
      const k = i++;
      return (slots[k] ??= { current: initial });
    },
    useMemo(fn, deps) {
      const k = i++;
      if (!slots[k] || changed(slots[k].deps, deps)) slots[k] = { deps, value: fn() };
      return slots[k].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (!prev || changed(prev.deps, deps)) pending.push(() => { prev?.cleanup?.(); slots[k] = { deps, cleanup: fn() }; });
    },
  };
  const render = (hook) => {
    i = 0;
    pending = [];
    const out = hook();
    for (const run of pending) run();
    return out;
  };
  const unmount = () => { for (const s of slots) s?.cleanup?.(); };
  return { React, render, unmount };
}

/** One hook's dependencies: OMP_TERMINAL, OMP_TERMINAL_STREAM (pure
 *  modules loaded into the same realm shape as the page), a recording
 *  xterm factory, a recording bridge and the mobile predicates. */
function harness({ touch = true, focusable = true } = {}) {
  const written = []; // bridge.terminalWrite args, [sid, bytes]
  const xterms = []; // the xterm stubs createXterm made
  const focused = [];
  const window = {
    OMP_TERMINAL: null, OMP_TERMINAL_STREAM: null, OMP_TERMINAL_XTERM: null,
    OMP_SESSION_UI: { pruneEntries: (s) => s },
    OMP_MOBILE: { isTouch: () => touch },
    // terminal.js reads detectMac at load (its copy/paste chords); no
    // chord is pressed in these tests, so a flat stub covers it.
    OMP_KEYMAP: { detectMac: () => false, chordFromEvent: () => null, guestShouldBypass: () => false },
    navigator: { clipboard: null },
    matchMedia: () => null,
  };
  runInNewContext(source("src/app/terminal.js"), { window });
  // The chords are not under test here; null keeps every key the shell's.
  window.OMP_TERMINAL.clipboardAction = () => null;
  runInNewContext(source("src/app/terminal-stream.js"), { window });
  // xterm factory stub: records what flows through it; `term.paste` is the
  // path useTerminal's paste() writes into, `onData` the one sendKey hooks.
  window.OMP_TERMINAL_XTERM = {
    SKIPPED_LINE: "\r\n[skipped]\r\n",
    exitLine: (c) => `exit ${c}`,
    failLine: (e) => `fail ${e}`,
    theme: () => ({}),
    scrollbackLines: () => 10,
    applyWindowsPty: () => {},
    ensureXterm: async () => {},
    // Mirrors terminal-xterm.js's exported paste(term): clipboard →
    // term.paste, read failures swallowed.
    paste: async (term) => {
      const clip = window.navigator?.clipboard;
      if (!clip?.readText) return;
      try { const text = await clip.readText(); if (text) term.paste(text); } catch { /* must not throw */ }
    },
    createXterm: ({ onData, onResize, tryRestart }) => {
      const term = {
        cols: 80, rows: 24,
        element: null,
        // useTerminal's mount path: open(node) + ResizeObserver; the stub
        // records the node and runs no observer (no refit under test).
        open: (node) => { term.element = node; },
        focus: () => { if (focusable) focused.push(term); },
        paste: (text) => { term.pasted.push(text); onData(text); },
        pasted: [],
        write: () => {},
        reset: () => {},
        refresh: () => {},
        hasSelection: () => false,
        options: {},
        _onResize: onResize,
        _tryRestart: tryRestart,
      };
      xterms.push(term);
      return { term, fit: { fit: () => {} } };
    },
    copySelection: () => false,
  };
  const bridge = {
    terminalWrite: (sid, data) => { written.push([sid, data]); },
    terminalResize: () => {},
    terminalAck: () => {},
    terminalStatus: async () => null,
    terminalReplay: async () => ({ chunks: [], acks: [] }),
    terminalOpen: async () => ({ ok: true, status: { instance: 1, shell: "sh", state: "running", exitCode: null } }),
    onTerminalData: () => ({ ready: Promise.resolve(), stop() {} }),
    onTerminalExit: () => ({ ready: Promise.resolve(), stop() {} }),
  };
  return { window, bridge, written, xterms, focused };
}

/** Mount useTerminal once over `window`'s realm; `show` re-renders it.
 *  The vm context carries the DOM surface the hook's mount path touches:
 *  a no-op ResizeObserver (no refit under test) and a document whose
 *  querySelector finds no Settings host, no overlay, no composer. */
function mountTerminal({ window, bridge }, sessionIds = ["a", "b"]) {
  const { React, render, unmount } = fakeReact();
  const code = source("src/app/use-terminal.jsx") + "\nuseTerminal";
  const useTerminal = runInNewContext(code, {
    window, React,
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0, clearTimeout: () => {},
    document: { querySelector: () => null },
    console: { warn: () => {}, error: () => {} },
  });
  const tweaks = { terminalHeight: 240, terminalScrollback: 10, fontSize: 100 };
  const setTweak = (key, value) => { tweaks[key] = value; };
  let activeSessionId = sessionIds[0];
  const show = () => render(() => useTerminal({ bridge, activeSessionId, sessionIds, tweaks, setTweak }));
  const setActive = (sid) => { activeSessionId = sid; };
  return { React, show, unmount, setActive, tweaks };
}
/** A panel's touch tier, rendered structurally (a11y.mjs's elStub). */
function elStub() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    Fragment: Symbol("fragment"),
  };
  return React;
}

const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
function loadPanel(win, React) {
  const code = Babel.transform(source("src/design/terminal-panel.jsx"), { presets: ["react"] }).code;
  const ctx = { window: { ...win, useEdgeDrag: () => ({ size: null, handlers: {} }), React }, React };
  runInNewContext(code, ctx);
  return ctx.window;
}

test("hook: the touch key row's caps write the exact sequences", async () => {
  const h = harness();
  const { show, unmount } = mountTerminal(h);
  let ui = show();
  // create the tab's xterm the way the panel does: mountFor's node.
  const node = { isConnected: true };
  ui.mountFor("a")(node);
  await flush();
  show();

  // The API the panel wires: a cap writes its bytes through sendKey.
  ui.sendKey("a", "\x1b");
  ui.sendKey("a", "\x1b[A");
  ui.sendKey("a", "\x1b[B");
  ui.sendKey("a", "\t");
  assert.deepEqual(h.written, [
    ["a", "\x1b"], ["a", "\x1b[A"], ["a", "\x1b[B"], ["a", "\t"],
  ], "Esc/↑/↓/Tab reach the shell as their control sequences");

  // A cap on a tab with no xterm yet is still just a write (Rust decides
  // what a dead shell's input means, same as a keystroke into it).
  h.written.length = 0;
  ui.sendKey("b", "\x1b");
  assert.deepEqual(h.written, [["b", "\x1b"]]);
  unmount();
});

test("hook: sticky Ctrl rides the next single-char key, then disarms", async () => {
  const h = harness();
  const { show, unmount } = mountTerminal(h);
  let ui = show();
  const node = { isConnected: true };
  ui.mountFor("a")(node);
  await flush();
  show();

  // Arm, then type "c" into the terminal (xterm's onData path): the
  // rewrite turns it into \x03 — SIGINT, the interrupt a phone cannot
  // type any other way.
  ui.toggleCtrl("a");
  ui = show();
  assert.equal(ui.ctrlTabs.a, true, "the cap lights");
  const term = h.xterms.at(-1);
  term.paste("c");
  assert.deepEqual(h.written, [["a", "\x03"]], "ctrl+c reaches the shell as ETX");
  ui = show();
  assert.equal(ui.ctrlTabs.a, false, "the arm cleared with the key it rode");

  // Multi-char data (an IME composition, a paste through xterm) passes
  // through untouched and does not consume the arm.
  ui.toggleCtrl("a");
  ui = show();
  h.written.length = 0;
  term.paste("two words");
  assert.deepEqual(h.written, [["a", "two words"]], "no rewrite for non-key data");
  ui = show();
  assert.equal(ui.ctrlTabs.a, true, "the arm survives data it could not ride");

  // The next single-char key consumes it, upper or lower case (the
  // non-key data above is still in the log — one write per key).
  term.paste("A");
  assert.deepEqual(h.written, [["a", "two words"], ["a", "\x01"]], "ctrl+a as SOH");
  ui = show();
  assert.equal(ui.ctrlTabs.a, false);

  // A control character of its own (a cap, an Enter) passes through.
  ui.toggleCtrl("a");
  ui = show();
  h.written.length = 0;
  term.paste("\r");
  assert.deepEqual(h.written, [["a", "\r"]], "a control byte is not rewritten");
  unmount();
});

test("hook: switching tabs disarms the Ctrl the panel left behind", async () => {
  const h = harness();
  const { show, unmount, setActive } = mountTerminal(h);
  let ui = show();
  ui.toggleCtrl("a");
  ui = show();
  assert.equal(ui.ctrlTabs.a, true);
  setActive("b");
  show(); // the effect that disarms runs after this render's return
  ui = show();
  assert.equal(ui.ctrlTabs.a, false, "leaving the tab cleared its arm");
  unmount();
});

test("hook: paste reads the clipboard into term.paste, not a bare write", async () => {
  const h = harness();
  const window = h.window;
  let clip = "";
  window.navigator = { clipboard: { readText: async () => clip } };
  const { show, unmount } = mountTerminal(h);
  let ui = show();
  const node = { isConnected: true };
  ui.mountFor("a")(node);
  await flush();
  show();
  const term = h.xterms.at(-1);

  clip = "echo hi";
  ui.paste("a");
  await flush();
  assert.deepEqual(term.pasted, ["echo hi"], "the clipboard text went through xterm's paste");

  // A failed read is logged, not thrown (the 粘贴 cap must not crash the
  // panel): readText rejects, nothing lands.
  term.pasted.length = 0;
  window.navigator = { clipboard: { readText: async () => { throw new Error("denied"); } } };
  ui.paste("a");
  await flush();
  assert.deepEqual(term.pasted, []);
  unmount();
});

test("hook: a touch panel never focuses on open; a mouse one does", async () => {
  for (const touch of [true, false]) {
    const h = harness({ touch });
    const { show, unmount } = mountTerminal(h);
    const ui = show();
    const node = { isConnected: true };
    ui.mountFor("a")(node);
    await flush();
    show();
    // Open the panel (terminalAutoOpen is off; togglePanel opens it) and
    // let the visibility effect run: touch skips the focus, mouse takes it.
    ui.toggle("a");
    show();
    assert.equal(h.focused.length, touch ? 0 : 1, touch ? "touch: no auto focus" : "mouse: focus on open");
    unmount();
  }
});

test("panel: the key row renders for touch only, caps carry their sequences", () => {
  const React = elStub();
  const win = loadPanel({
    OMP_MOBILE: { isTouch: () => true },
    OMP_TERMINAL: terminalStub(), Icon: () => null,
  }, React);
  const caps = [];
  const toggled = [];
  const pasted = [];
  // TerminalPanels (the exported component) wires one panel from the
  // useTerminal-shaped `terminal` object; the row's caps record their
  // calls through it, exactly as the live app runs them.
  const terminal = {
    state: { a: { open: true, created: true, status: null, error: null } },
    height: 240, setHeight: () => {}, close: () => {}, respawn: () => {},
    mountFor: () => () => {}, copySelection: () => false, paste: () => { pasted.push("a"); },
    sendKey: (sid, seq) => caps.push([sid, seq]),
    ctrlTabs: {}, toggleCtrl: () => { toggled.push("a"); },
  };
  const tree = win.TerminalPanels({ sessions: [{ id: "a", path: null }], activeId: "a", terminal });
  const row = find(tree, (n) => n.props?.className === "term-keyrow");
  assert.ok(row, "the touch key row renders");
  const buttons = findAll(row, (n) => n.type === "button");
  assert.equal(buttons.length, 6, "Esc, Ctrl, ↑, ↓, Tab, 粘贴");

  // Click every cap: the four byte-writing caps fire their sequences,
  // Ctrl toggles and 粘贴 pastes (their effects are the hook tests above).
  for (const b of buttons) b.props.onClick?.();
  assert.deepEqual(caps, [["a", "\x1b"], ["a", "\x1b[A"], ["a", "\x1b[B"], ["a", "\t"]],
    "Esc/↑/↓/Tab reach the shell as their control sequences");
  assert.deepEqual(toggled, ["a"], "the Ctrl cap toggled");
  assert.deepEqual(pasted, ["a"], "the 粘贴 cap pasted");

  // Not touch: no row at all (the module-level isTouch read).
  const desktopWin = loadPanel({
    OMP_MOBILE: { isTouch: () => false },
    OMP_TERMINAL: terminalStub(), Icon: () => null,
  }, React);
  const desktop = desktopWin.TerminalPanels({ sessions: [{ id: "a", path: null }], activeId: "a", terminal });
  assert.equal(find(desktop, (n) => n.props?.className === "term-keyrow"), undefined, "desktop renders no key row");

  // The Ctrl cap is a toggle (aria-pressed), lit when armed.
  const armed = win.TerminalPanels({
    sessions: [{ id: "a", path: null }], activeId: "a",
    terminal: { ...terminal, ctrlTabs: { a: true } },
  });
  const ctrl = find(armed, (n) => n.props?.className === "term-key term-key-ctrl on");
  assert.ok(ctrl, "the armed Ctrl cap carries its lit class");
  assert.equal(ctrl.props["aria-pressed"], true);
});

test("panel: a touch double-tap flips the height between 240 and half the column", () => {
  const React = elStub();
  const sent = [];
  const session = { getBoundingClientRect: () => ({ height: 800 }) };
  const clamp = (px, col) => Math.min(Math.floor(col * 0.7), Math.max(120, Math.round(px)));
  const terminal = {
    state: { a: { open: true, created: true, status: null, error: null } },
    height: 240, setHeight: (px) => sent.push(px), close: () => {}, respawn: () => {},
    mountFor: () => () => {}, copySelection: () => false, paste: () => {},
    sendKey: () => {}, ctrlTabs: {}, toggleCtrl: () => {},
  };
  const win = loadPanel({
    OMP_MOBILE: { isTouch: () => true },
    OMP_TERMINAL: { ...terminalStub(), clampHeight: clamp }, Icon: () => null,
  }, React);
  // The double-click's event carries its own node: the handle, inside the
  // panel, inside the session column (the DOM path the handler reads).
  const handleNode = { closest: (sel) => (sel === ".session" ? session : null) };
  const dbl = { currentTarget: handleNode };
  const tree = win.TerminalPanels({ sessions: [{ id: "a", path: null }], activeId: "a", terminal });
  const handle = find(tree, (n) => n.props?.role === "separator");
  assert.ok(handle, "the resize handle exists");
  handle.props.onDoubleClick(dbl);
  assert.deepEqual(sent, [400], "240 (under half the column) grows to half");

  const tall = win.TerminalPanels({
    sessions: [{ id: "a", path: null }], activeId: "a",
    terminal: { ...terminal, height: 400 },
  });
  find(tall, (n) => n.props?.role === "separator").props.onDoubleClick(dbl);
  assert.deepEqual(sent, [400, 240], "a height at or over half snaps back to the default");

  // Desktop keeps the single-level reset, and never reads the DOM: a
  // null event still resets.
  const desktopWin = loadPanel({
    OMP_MOBILE: { isTouch: () => false },
    OMP_TERMINAL: { ...terminalStub(), clampHeight: clamp }, Icon: () => null,
  }, React);
  const desk = desktopWin.TerminalPanels({
    sessions: [{ id: "a", path: null }], activeId: "a",
    terminal: { ...terminal, height: 400 },
  });
  find(desk, (n) => n.props?.role === "separator").props.onDoubleClick(null);
  assert.deepEqual(sent, [400, 240, 240], "desktop: double-click still resets to 240");
});

/** The OMP_TERMINAL surface a panel load needs. */
function terminalStub() {
  return {
    clampHeight: (px) => Math.round(px),
    isExited: () => false,
    entryOf: (s, sid) => s?.[sid] ?? {},
    shellLabel: () => "sh",
  };
}

/** Depth-first walk of a structural tree; a function-typed `type` is a
 *  component React would call — call it here with its props and walk its
 *  returned tree (the elStub convention from test-a11y.mjs, one level of
 *  component nesting deeper). */
function* nodes(node) {
  if (Array.isArray(node)) { for (const c of node) yield* nodes(c); return; }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "function") { yield* nodes(node.type(node.props)); return; }
  yield node;
  if (Array.isArray(node.children)) for (const c of node.children) yield* nodes(c);
}
const find = (tree, pred) => [...nodes(tree)].find(pred);
const findAll = (tree, pred) => [...nodes(tree)].filter(pred);
