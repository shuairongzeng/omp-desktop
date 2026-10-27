#!/usr/bin/env node
// Regression script for src/app/closed-tabs.js — the closed-tab stack behind
// Ctrl+Shift+T: LIFO order, the CAP eviction of the oldest entry, null on an
// empty stack, and the copy semantics in both directions.
// Run: node tests/test-closed-tabs.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
const src  = readFileSync(join(root, "src/app/closed-tabs.js"), "utf8");
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const S = win.OMP_CLOSED_TABS;

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

const entry = (n) => ({
  sessionFile: `/sessions/s${n}.jsonl`,
  profile: "default",
  path: `/work/project-${n}`,
});

// ── surface ───────────────────────────────────────────────────────────────

check("exposes exactly the documented members", () => {
  assert.deepEqual(Object.keys(S).sort(), ["CAP", "clear", "peek", "pop", "push", "size"]);
});

check("CAP is 20", () => {
  assert.equal(S.CAP, 20);
});

check("the module touches no globals besides the final assignment", () => {
  assert.ok(!/\bdocument\b/.test(src), "must not touch the DOM");
  assert.ok(!/\blocalStorage\b/.test(src), "must not persist");
  assert.ok(src.trimEnd().endsWith("})();"), "must be an IIFE");
});

// ── LIFO ──────────────────────────────────────────────────────────────────

check("pop returns the newest of three pushes first, then the older ones", () => {
  S.clear();
  S.push(entry(1));
  S.push(entry(2));
  S.push(entry(3));
  assert.equal(S.size(), 3);
  assert.equal(S.pop().sessionFile, "/sessions/s3.jsonl");
  assert.equal(S.pop().sessionFile, "/sessions/s2.jsonl");
  assert.equal(S.pop().sessionFile, "/sessions/s1.jsonl");
});

check("popping the whole stack leaves it empty", () => {
  S.clear();
  S.push(entry(1));
  S.pop();
  assert.equal(S.size(), 0);
  assert.equal(S.pop(), null);
});

check("pop on an empty stack is null", () => {
  S.clear();
  assert.equal(S.pop(), null);
});

// ── peek ──────────────────────────────────────────────────────────────────

check("peek returns the top without removing it", () => {
  S.clear();
  S.push(entry(1));
  S.push(entry(2));
  assert.equal(S.peek().sessionFile, "/sessions/s2.jsonl");
  assert.equal(S.size(), 2);
  assert.equal(S.peek().sessionFile, "/sessions/s2.jsonl");
  assert.equal(S.pop().sessionFile, "/sessions/s2.jsonl");
});

check("peek on an empty stack is null", () => {
  S.clear();
  assert.equal(S.peek(), null);
});

// ── CAP eviction ──────────────────────────────────────────────────────────

check("25 pushes keep only the newest 20, dropping the oldest 5", () => {
  S.clear();
  for (let n = 1; n <= 25; n++) S.push(entry(n));
  assert.equal(S.size(), 20);
  assert.equal(S.pop().sessionFile, "/sessions/s25.jsonl");
  assert.equal(S.pop().sessionFile, "/sessions/s24.jsonl");
  // The five oldest are gone: draining the rest starts at s6.
  const rest = [];
  for (let n = 0; n < 18; n++) rest.push(S.pop().sessionFile);
  assert.equal(rest[0], "/sessions/s23.jsonl");
  assert.equal(rest[rest.length - 1], "/sessions/s6.jsonl");
  assert.equal(S.pop(), null);
});

check("a push at exactly CAP does not evict anything", () => {
  S.clear();
  for (let n = 1; n <= 20; n++) S.push(entry(n));
  assert.equal(S.size(), 20);
  assert.equal(S.CAP, 20);
});

check("eviction is per push, so the stack never exceeds CAP", () => {
  S.clear();
  for (let n = 1; n <= 100; n++) {
    S.push(entry(n));
    assert.ok(S.size() <= S.CAP, `size ${S.size()} exceeded CAP after push ${n}`);
  }
  assert.equal(S.size(), 20);
});

// ── copy semantics ────────────────────────────────────────────────────────

check("mutating the pushed object afterwards does not change the stack", () => {
  S.clear();
  const e = entry(7);
  S.push(e);
  e.sessionFile = "/sessions/rewritten.jsonl";
  e.profile = "other";
  e.path = "/elsewhere";
  assert.deepEqual(S.peek(), entry(7));
});

check("mutating the object returned by pop does not change the stack", () => {
  S.clear();
  S.push(entry(1));
  S.push(entry(2));
  const top = S.pop();
  top.sessionFile = "/sessions/rewritten.jsonl";
  assert.deepEqual(S.peek(), entry(1));
});

check("mutating the object returned by peek does not change the stack", () => {
  S.clear();
  S.push(entry(1));
  const top = S.peek();
  top.path = "/elsewhere";
  assert.deepEqual(S.peek(), entry(1));
});

check("push stores a snapshot, not the live reference", () => {
  S.clear();
  const e = entry(8);
  S.push(e);
  assert.notEqual(S.peek(), e);
});

// ── round trip ────────────────────────────────────────────────────────────

check("entry fields survive a push/pop round trip", () => {
  S.clear();
  const e = { sessionFile: "/sessions/abc.jsonl", profile: "work", path: "/work/repo" };
  S.push(e);
  assert.deepEqual(S.pop(), e);
});

check("the popped entry carries exactly the three documented keys", () => {
  S.clear();
  S.push({ ...entry(2), extra: "ignored" });
  assert.deepEqual(Object.keys(S.pop()).sort(), ["path", "profile", "sessionFile"]);
});

check("an entry with empty optional fields round-trips as empty strings", () => {
  S.clear();
  S.push({ sessionFile: "/sessions/abc.jsonl" });
  assert.deepEqual(S.pop(), { sessionFile: "/sessions/abc.jsonl", profile: "", path: "" });
});

// ── clear ─────────────────────────────────────────────────────────────────

check("clear empties the stack", () => {
  S.clear();
  S.push(entry(1));
  S.push(entry(2));
  S.clear();
  assert.equal(S.size(), 0);
  assert.equal(S.pop(), null);
  assert.equal(S.peek(), null);
});

check("the stack is usable again after clear", () => {
  S.clear();
  S.push(entry(1));
  S.clear();
  S.push(entry(2));
  assert.equal(S.size(), 1);
  assert.equal(S.pop().sessionFile, "/sessions/s2.jsonl");
});

// ── invalid input ────────────────────────────────────────────────────────

check("a malformed entry is rejected instead of poisoning the stack", () => {
  S.clear();
  S.push(entry(1));
  assert.equal(S.push(null), false);
  assert.equal(S.push(undefined), false);
  assert.equal(S.push({ sessionFile: "", profile: "work", path: "/x" }), false);
  assert.equal(S.push({ profile: "work", path: "/x" }), false);
  assert.equal(S.size(), 1);
  assert.deepEqual(S.pop(), entry(1));
});

console.log(`test-closed-tabs: ${passed} checks passed`);