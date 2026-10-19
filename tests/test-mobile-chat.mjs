// tests/test-mobile-chat.mjs — the phone tier of the message flow
// (package C of docs/design/mobile-draft.html v1):
//   - chat-view.jsx `hasPendingAsk` — the "⚠ approval needed" state of
//     the jump-to-latest button
//   - ask-bubble.jsx `askOptionTone` — the is-primary / is-danger class
//     flags the phone CSS (ask.css) styles as the solid-accent Approve
//     and the rose-outline Deny
// Both are pure functions over message/option data; the sheet branch
// itself is a render-time window.OMP_MOBILE / window.MobileSheet read,
// late-bound by contract, covered here only through those two pure
// predicates (the app has no DOM-level test harness).
// Run: node tests/test-mobile-chat.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(rootDir, "src/babel.min.js"));

let passed = 0;
function check(label, fn) {
  try { fn(); }
  catch (err) { console.error(`FAILED: ${label}`); throw err; }
  passed++;
}

// Compile a jsx module the way index.html's Babel does and evaluate it
// against a stub window (test-chat-collapse.mjs's pattern); the modules
// only need window stubs for the globals they destructure at load.
function loadModule(relPath, win) {
  const code = Babel.transform(readFileSync(join(rootDir, relPath), "utf8"), { presets: ["react"] }).code;
  const ctx = {
    window: win,
    React: win.React,
    isSubmitKey: () => false,
    isSubmitEnter: () => false,
  };
  // eslint-disable-next-line no-new-func
  return new Function("window", "React", "isSubmitKey", "isSubmitEnter", `${code}`)(win, win.React, ctx.isSubmitKey, ctx.isSubmitEnter);
}

// ── chat-view.jsx `hasPendingAsk` ────────────────────────────────────────
{
  const React = {
    memo: (c) => c,
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const win = {
    React,
    OMP_SCROLL_PIN:   { nextPinned: () => true, shouldRepin: () => false, afterOutput: () => ({ pinned: true, stick: false }) },
    OMP_COLLAPSE:     { collapseStates: () => ({}), PREVIEW_LINES: 3 },
    OMP_TURN_STATUS:  { isHidden: (m) => !!m.superseded || (m.kind === "retry" && !!m.ended) },
    UserBubble: () => null, ToolCard: () => null, AssistantBubble: () => null, AskBubble: () => null,
    RetryRow: () => null, GoalRow: () => null, ApprovalRow: () => null, Icon: () => null, TOOL_META: {},
  };
  loadModule("src/design/chat/chat-view.jsx", win);
  const H = win.hasPendingAsk;
  const msg = (extra = {}) => ({ _id: 1, kind: "assistant", ...extra });

  check("hasPendingAsk: exported", () => {
    assert.equal(typeof H, "function", "window.hasPendingAsk exists");
  });
  check("hasPendingAsk: no messages, or no asks, is false", () => {
    assert.equal(H([]), false);
    assert.equal(H([msg(), msg({ kind: "tool", tool: "bash" })]), false);
  });
  check("hasPendingAsk: an unanswered ask is true", () => {
    assert.equal(H([msg(), msg({ kind: "ask", answered: false, cancelled: false })]), true);
  });
  check("hasPendingAsk: answered and cancelled asks do not count", () => {
    assert.equal(H([msg({ kind: "ask", answered: true })]), false);
    assert.equal(H([msg({ kind: "ask", cancelled: true })]), false);
  });
  check("hasPendingAsk: a hidden (superseded) ask does not count", () => {
    // runStateOf's stale-ask rule: a failed process can leave an ask
    // open forever; the retry recovery supersedes it — the button must
    // not cry approval needed over a dead prompt.
    assert.equal(H([msg({ kind: "ask", superseded: true })]), false);
  });
}

// ── ask-bubble.jsx `askOptionTone` ────────────────────────────────────────
{
  const React = {
    memo: (c) => c,
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useEffect: () => {},
  };
  const win = {
    React,
    Icon: () => null,
    AskDialog: () => null,
    OMP_ASK_DIALOG: { timeoutNote: () => null },
    OMP_APPROVAL: { approvalInfo: () => null },
    isSubmitKey: () => false,
    isSubmitEnter: () => false,
  };
  loadModule("src/design/chat/ask-bubble.jsx", win);
  const tone = win.askOptionTone;

  check("askOptionTone: exported", () => {
    assert.equal(typeof tone, "function", "window.askOptionTone exists");
  });
  check("askOptionTone: approval words are the solid primary", () => {
    for (const w of ["Approve", "allow", "Confirm", "OK", "Yes", "  approve  "]) {
      assert.equal(tone(w), "is-primary", `${w} should be is-primary`);
    }
  });
  check("askOptionTone: deny words get the rose outline", () => {
    for (const w of ["Deny", "no", "  deny "]) {
      assert.equal(tone(w), "is-danger", `${w} should be is-danger`);
    }
  });
  check("askOptionTone: extension picker labels stay neutral", () => {
    for (const w of ["18.5.1 now", "Refuse", "Pick a color", "", null, undefined]) {
      assert.equal(tone(w), "", `${JSON.stringify(w)} should be neutral`);
    }
  });
  check("askOptionTone: case-insensitive and trim-tolerant", () => {
    assert.equal(tone("APPROVE"), "is-primary");
    assert.equal(tone("\tdeny\n"), "is-danger");
    assert.equal(tone("approves"), ""); // not a word-boundary match by hand-list
  });
}

console.log(`mobile-chat: ${passed} checks passed`);
