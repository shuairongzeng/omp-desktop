#!/usr/bin/env node
// Regression script for the round-4 accessibility fixes.
//   chat/chat-view.jsx — role="log" on the transcript, the sr-live digest
//     that updates only when a turn settles (not per streaming delta)
//   history-modal.jsx — dialog semantics on the panel, the search input's
//     combobox/listbox/option wiring
//   ui/icons.jsx — the svg is aria-hidden by default
// Runs each module the way index.html's Babel does (test-goal.mjs's
// pattern) against window stubs, with a React.createElement stand-in that
// records the tree so roles/attrs can be asserted structurally.
// Run: node tests/test-a11y.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));

/** A React.createElement stand-in that builds inspectable trees:
 *  { type, props } with children flattened into an array. */
function elStub() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    Fragment: Symbol("fragment"),
    memo: (c) => c,
  };
  return React;
}

/** Compile a jsx module and evaluate it against `win`, returning win. */
function loadModule(relPath, win, React) {
  const code = Babel.transform(readFileSync(join(root, relPath), "utf8"), { presets: ["react"] }).code;
  const ctx = {
    window: win,
    React,
    // createPortal returns its node so the tree stays inspectable; the
    // history modal's portaled render resolves `document.body` up front.
    ReactDOM: { createPortal: (node) => node },
    document: { getElementById: () => null, body: {} },
  };
  runInNewContext(code, ctx);
  return win;
}

/** Depth-first walk of an element tree, yielding every node. */
function* nodes(node) {
  if (!node || typeof node !== "object") return;
  yield node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) yield* nodes(c);
  }
}

const find = (tree, pred) => [...nodes(tree)].find(pred);
const findAll = (tree, pred) => [...nodes(tree)].filter(pred);

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

// ── icons.jsx: the svg is aria-hidden by default ─────────────────────────
{
  const React = elStub();
  const win = {};
  loadModule("src/design/ui/icons.jsx", win, React);
  const icon = win.Icon({ name: "close", size: 10 });
  assert.ok(icon, "Icon renders a node");
  check("Icon svg carries aria-hidden by default", () => {
    assert.equal(icon.props["aria-hidden"], "true");
  });
  check("Icon passes explicit props through after the default", () => {
    const titled = win.Icon({ name: "close", size: 10, "aria-label": "dismiss" });
    assert.equal(titled.props["aria-label"], "dismiss");
    assert.equal(titled.props["aria-hidden"], "true");
  });
}

// ── chat-view.jsx: log role + the sr-live digest ─────────────────────────
{
  const React = {
    ...elStub(),
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const win = {
    React,
    OMP_SCROLL_PIN:   { nextPinned: () => true, shouldRepin: () => false, afterOutput: () => ({ pinned: true, stick: false }) },
    OMP_COLLAPSE:     { collapseStates: () => ({}), PREVIEW_LINES: 4 },
    OMP_TURN_STATUS:  { isHidden: () => false },
    UserBubble: () => null, ToolCard: () => null, AssistantBubble: () => null, AskBubble: () => null,
    RetryRow: () => null, GoalRow: () => null, ApprovalRow: () => null, Icon: () => null, TOOL_META: {},
  };
  loadModule("src/design/chat/chat-view.jsx", win, React);

  check("liveSummary: a settled reply announces the reply", () => {
    assert.equal(win.liveSummary([{ kind: "assistant", streaming: false }]), "assistant replied");
  });
  check("liveSummary: a streaming bubble announces nothing", () => {
    assert.equal(win.liveSummary([{ kind: "assistant", streaming: true }]), "");
  });
  check("liveSummary: a failed reply announces the failure", () => {
    assert.equal(win.liveSummary([{ kind: "assistant", streaming: false, failure: { headline: "HTTP 429" } }]), "reply failed: HTTP 429");
    assert.equal(win.liveSummary([{ kind: "assistant", streaming: false, failure: {} }]), "reply failed");
  });
  check("liveSummary: an aborted reply says stopped", () => {
    assert.equal(win.liveSummary([{ kind: "assistant", streaming: false, aborted: true }]), "reply stopped");
  });
  check("liveSummary: scans back past tool cards to the last assistant message", () => {
    const msgs = [
      { kind: "assistant", streaming: false },
      { kind: "tool" },
      { kind: "compact" },
    ];
    assert.equal(win.liveSummary(msgs), "assistant replied");
  });
  check("liveSummary: no assistant message, nothing to announce", () => {
    assert.equal(win.liveSummary([{ kind: "user" }]), "");
    assert.equal(win.liveSummary([]), "");
  });

  check("liveKey: identical while the tail streams, flips at message end only", () => {
    // Three successive message_update frames on the same bubble.
    const delta1 = [{ _id: 1, kind: "user" }, { _id: 2, kind: "assistant", streaming: true, blocks: [{ type: "text", text: "Hel" }] }];
    const delta2 = [{ _id: 1, kind: "user" }, { _id: 2, kind: "assistant", streaming: true, blocks: [{ type: "text", text: "Hello" }] }];
    const delta3 = [{ _id: 1, kind: "user" }, { _id: 2, kind: "assistant", streaming: true, blocks: [{ type: "text", text: "Hello, world" }] }];
    const end    = [{ _id: 1, kind: "user" }, { _id: 2, kind: "assistant", streaming: false, blocks: [{ type: "text", text: "Hello, world." }] }];
    assert.equal(win.liveKey(delta1), win.liveKey(delta2));
    assert.equal(win.liveKey(delta2), win.liveKey(delta3));
    assert.notEqual(win.liveKey(delta3), win.liveKey(end), "the end frame changes the key");
  });

  const renderChat = (messages) => win.ChatView({ messages, foldModes: { thinking: "folded", tool: "folded" } });
  // the sr-live node.
  const tree = renderChat([{ _id: 1, kind: "assistant", streaming: false }]);
  check("the transcript container has role=log with a label", () => {
    const log = find(tree, (n) => n.props?.role === "log");
    assert.ok(log, "role=log node exists");
    assert.equal(log.props["aria-label"], "conversation");
  });
  check("a visually-hidden polite status node exists for the digest", () => {
    const status = find(tree, (n) => n.props?.role === "status");
    assert.ok(status, "role=status node exists");
    assert.equal(status.props["aria-live"], "polite");
    assert.equal(status.props.className, "sr-live");
    assert.equal(status.children.join(""), "assistant replied");
  });
  check("no live node content while streaming (no churn to announce)", () => {
    const streaming = renderChat([{ _id: 2, kind: "assistant", streaming: true }]);
    const status = find(streaming, (n) => n.props?.role === "status");
    assert.equal(status.children.join(""), "");
  });
}

// ── history-modal.jsx: dialog semantics ─────────────────────────────────
{
  // A stateful React stand-in: useState slots start at the initializer's
  // value, but the first slot (HistoryModal's `sessions`) is seeded with
  // two sessions so the list renders rows without driving effects.
  const state = [];
  const React = {
    ...elStub(),
    useState(init) {
      const i = state.length;
      state.push(typeof init === "function" ? init() : init);
      return [i === 0 ? sessionsSeed : state[i], () => {}];
    },
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  const sessionsSeed = [
    { id: "a", title: "Fix the parser", path: "/x/a", project_name: "p", message_count: 2, cwd: "/x", preview: "…", updated_at: Date.now() },
    { id: "b", title: "Ship the bridge", path: "/x/b", project_name: "p", message_count: 3, cwd: "/x", preview: "…", updated_at: Date.now() },
  ];
  const win = {
    React,
    Icon: () => null,
    OMP_PROJECT_NAV: { sessionProjects: () => [], normPath: (p) => p },
    useModalFocus: () => {},
    useModalLayer: () => {},
    useEscClose: () => {},
    requestAnimationFrame: (fn) => fn(),
  };
  loadModule("src/design/history-modal.jsx", win, React);

  const tree = win.HistoryModal({
    open: true, onClose: () => {}, onResume: () => {},
    activeCwd: null, initialCwd: null,
  });
  // The useState seed above gives the modal two sessions, so the list
  // renders real rows for the option/id checks below.
  assert.ok(tree, "an open modal renders a node");

  check("the panel is a labelled modal dialog", () => {
    const dialog = find(tree, (n) => n.props?.role === "dialog");
    assert.ok(dialog, "role=dialog node exists");
    assert.equal(dialog.props["aria-modal"], "true");
    assert.equal(dialog.props["aria-label"], "Conversation history");
  });

  check("the search input is a combobox aimed at the listbox", () => {
    const input = find(tree, (n) => n.type === "input");
    assert.equal(input.props.role, "combobox");
    assert.equal(input.props["aria-controls"], "hist-rows");
    assert.ok(input.props["aria-expanded"] === "true" || input.props["aria-expanded"] === "false");
  });

  check("the list is a listbox of options with row ids", () => {
    const listbox = find(tree, (n) => n.props?.role === "listbox");
    assert.ok(listbox, "role=listbox node exists");
    assert.equal(listbox.props.id, "hist-rows");
    const options = findAll(listbox, (n) => n.props?.role === "option");
    assert.ok(options.length > 0, "rows render as options");
    assert.ok(options[0].props.id.startsWith("hist-row-"), `row id shape: ${options[0].props.id}`);
    assert.ok(options.every((o) => typeof o.props["aria-selected"] === "boolean"), "options carry aria-selected");
  });

  check("the per-row Resume button names its session", () => {
    const resumes = findAll(tree, (n) => n.type === "button" && /Resume/.test(String(n.children.join(""))));
    assert.ok(resumes.length > 0, "Resume buttons exist");
    assert.ok(resumes.every((b) => b.props["aria-label"]?.startsWith("resume ")), "each Resume carries aria-label");
  });

  check("header icon buttons carry accessible names", () => {
    const buttons = findAll(tree, (n) => n.type === "button");
    const iconOnly = buttons.filter((b) => String(b.props.className).includes("btn icon"));
    assert.ok(iconOnly.length >= 1, "icon-only buttons exist in the header");
    assert.ok(iconOnly.every((b) => b.props["aria-label"]), "every icon-only button is labelled");
  });
}

console.log(`a11y: ${passed} checks passed`);
