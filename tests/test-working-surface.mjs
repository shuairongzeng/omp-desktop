#!/usr/bin/env node
// Regression script for src/app/working-surface.js — the project sidebar's
// "working" section: which run states it shows, the attention order it sorts
// them in, and the badge counts/labels a header renders.
// Run: node tests/test-working-surface.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/working-surface.js"), "utf8"))(win);
const W = win.OMP_WORKING_SURFACE;

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

const row = (id, runState, extra = {}) => ({ id, name: id, path: `/p/${id}`, runState, ...extra });

// ── WORKING_STATES / PRIORITY ─────────────────────────────────────────────

check("every run state but idle counts as working, and idle does not", () => {
  const states = ["idle", "running", "retrying", "waiting-user", "background", "failed"];
  assert.deepEqual(states.filter(s => W.WORKING_STATES.has(s)).sort(),
    ["background", "failed", "retrying", "running", "waiting-user"]);
  assert.equal(W.WORKING_STATES.has("idle"), false);
});

check("priority runs waiting-user, failed, retrying, running, background", () => {
  const order = ["waiting-user", "failed", "retrying", "running", "background"];
  assert.deepEqual(order.map(s => W.PRIORITY[s]), [0, 1, 2, 3, 4]);
  assert.deepEqual(Object.keys(W.PRIORITY).sort(), [...W.WORKING_STATES].sort());
});

check("status meta covers every working state with a label, icon and tone", () => {
  for (const state of W.WORKING_STATES) {
    const meta = W.STATUS_META[state];
    assert.ok(meta, `no meta for ${state}`);
    assert.equal(typeof meta.label, "string");
    assert.ok(meta.label.length > 0);
    assert.equal(typeof meta.icon, "string");
    assert.equal(typeof meta.tone, "string");
  }
});

check("every badge icon exists in the icon pack", () => {
  const icons = readFileSync(join(root, "src/design/ui/icons.jsx"), "utf8");
  const start = icons.indexOf("const _ICON_PATHS = {");
  assert.ok(start >= 0, "icon map not found");
  const body = icons.slice(start, icons.indexOf("\n};", start));
  const names = new Set([...body.matchAll(/^  ([a-zA-Z]+):/gm)].map(m => m[1]));
  for (const state of W.WORKING_STATES) {
    assert.ok(names.has(W.STATUS_META[state].icon), `${state} icon ${W.STATUS_META[state].icon} missing`);
  }
});

check("badge labels are the planned short tags", () => {
  const labels = {};
  for (const state of W.WORKING_STATES) labels[state] = W.STATUS_META[state].label;
  assert.deepEqual(labels, {
    "waiting-user": "waiting",
    failed: "failed",
    retrying: "retrying",
    running: "running",
    background: "background",
  });
});

// ── workingTabs ───────────────────────────────────────────────────────────

check("workingTabs shows all five working states and drops idle", () => {
  const tabs = [
    row("a", "idle"), row("b", "running"), row("c", "retrying"),
    row("d", "waiting-user"), row("e", "background"), row("f", "failed"),
  ];
  assert.deepEqual(W.workingTabs(tabs).map(t => t.id), ["d", "f", "c", "b", "e"]);
});

check("workingTabs sorts a shuffled registry by attention priority", () => {
  const tabs = [
    row("bg", "background"), row("run", "running"), row("retry", "retrying"),
    row("fail", "failed"), row("ask", "waiting-user"),
  ];
  assert.deepEqual(W.workingTabs(tabs).map(t => t.id), ["ask", "fail", "retry", "run", "bg"]);
});

check("same-priority tabs keep their registry order", () => {
  const tabs = [row("r1", "running"), row("idle", "idle"), row("r2", "running"), row("r3", "running")];
  assert.deepEqual(W.workingTabs(tabs).map(t => t.id), ["r1", "r2", "r3"]);
});

check("stable order also holds across two priorities interleaved in the input", () => {
  const tabs = [row("f1", "failed"), row("r1", "running"), row("f2", "failed"), row("r2", "running")];
  assert.deepEqual(W.workingTabs(tabs).map(t => t.id), ["f1", "f2", "r1", "r2"]);
});

check("empty input and a non-array both yield an empty list", () => {
  assert.deepEqual(W.workingTabs([]), []);
  assert.deepEqual(W.workingTabs(null), []);
  assert.deepEqual(W.workingTabs(undefined), []);
});

check("workingTabs returns a new array and never mutates the registry", () => {
  const tabs = [row("b", "background"), row("a", "waiting-user"), row("c", "idle")];
  const before = tabs.map(t => t.id);
  const out = W.workingTabs(tabs);
  assert.notEqual(out, tabs);
  assert.notEqual(out[0], undefined);
  assert.deepEqual(tabs.map(t => t.id), before);
  assert.deepEqual(out.map(t => t.id), ["a", "b"]);
});

// ── countBadge ────────────────────────────────────────────────────────────

check("countBadge counts each working state", () => {
  const rows = [
    row("a", "running"), row("b", "running"), row("c", "failed"),
    row("d", "waiting-user"), row("e", "retrying"), row("f", "background"),
  ];
  const badge = W.countBadge(rows);
  assert.deepEqual({ ...badge }, { "waiting-user": 1, failed: 1, retrying: 1, running: 2, background: 1 });
});

check("countBadge omits zero-count states and ignores idle", () => {
  assert.deepEqual({ ...W.countBadge([row("a", "running"), row("b", "idle")]) }, { running: 1 });
  assert.deepEqual({ ...W.countBadge([row("a", "idle")]) }, {});
  assert.deepEqual({ ...W.countBadge([]) }, {});
  assert.deepEqual({ ...W.countBadge(null) }, {});
});

check("countBadge keys come out in priority order", () => {
  const rows = [row("a", "background"), row("b", "running"), row("c", "waiting-user")];
  assert.deepEqual(Object.keys(W.countBadge(rows)), ["waiting-user", "running", "background"]);
});

console.log(`test-working-surface: ${passed} checks passed`);