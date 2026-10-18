// tests/test-quote-selection.mjs — app/quote-selection.js (window.OMP_QUOTE).
// Run: node tests/test-quote-selection.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/app/quote-selection.js", import.meta.url), "utf8");
const win = {};
new Function("window", src)(win);
const Q = win.OMP_QUOTE;

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("  ✓", label); }
  catch (err) { console.error("  ✗", label); console.error(err.message); process.exitCode = 1; }
}

// Minimal Element stub: `chain` maps a selector to whether closest() hits.
const el = (hits = {}) => ({
  nodeType: 1,
  closest: sel => (hits[sel] ? { sel } : null),
});
const textNode = inner => ({ nodeType: 3, parentElement: inner });
const sel = (anchor, focus, text = "some words", collapsed = false) =>
  ({ isCollapsed: collapsed, anchorNode: anchor, focusNode: focus, toString: () => text });

const chat = { ".chat-scroll": true };
const inInput = { ".chat-scroll": true, "input, textarea, [contenteditable]": true };

check("a chat selection returns its text, right-trimmed", () => {
  const s = sel(el(chat), el(chat), "pick me  \n");
  assert.equal(Q.quotableText(s), "pick me");
});

check("a collapsed selection (a click) earns nothing", () => {
  assert.equal(Q.quotableText(sel(el(chat), el(chat), "x", true)), null);
});

check("whitespace-only selections earn nothing", () => {
  assert.equal(Q.quotableText(sel(el(chat), el(chat), "  \n ")), null);
});

check("both ends must be in the chat — one outside rejects", () => {
  assert.equal(Q.quotableText(sel(el(chat), el({}), "crossing")), null);
});

check("selections inside typing surfaces are editing, not quoting", () => {
  assert.equal(Q.quotableText(sel(el(inInput), el(inInput), "draft")), null);
});

check("text nodes resolve through their parent element", () => {
  assert.equal(Q.quotableText(sel(textNode(el(chat)), textNode(el(chat)), "deep")), "deep");
});

check("popover floats above the selection, centered on its end", () => {
  const p = Q.popoverPos({ top: 100, bottom: 120, right: 300 }, 1000, 700, 132, 30);
  assert.deepEqual(p, { x: 234, y: 62 });
});

check("no headroom above → flips below the selection", () => {
  const p = Q.popoverPos({ top: 20, bottom: 40, right: 300 }, 1000, 700, 132, 30);
  assert.equal(p.y, 48);
});

check("a selection scrolled wholly above the viewport clamps back on-screen", () => {
  const p = Q.popoverPos({ top: -11031, bottom: -11014, right: 1057 }, 1000, 700, 132, 30);
  assert.equal(p.y, 8);
});

check("clamps to the viewport's side margins", () => {
  const nearRight = Q.popoverPos({ top: 100, bottom: 120, right: 995 }, 1000, 700, 132, 30);
  assert.equal(nearRight.x, 1000 - 132 - 8);
  const nearLeft = Q.popoverPos({ top: 100, bottom: 120, right: 20 }, 1000, 700, 132, 30);
  assert.equal(nearLeft.x, 8);
});

console.log(`quote-selection: ${passed} checks passed`);
