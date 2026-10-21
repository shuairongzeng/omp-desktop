#!/usr/bin/env node
// Regression script for src/app/tab-bar.js — the tab strip's density
// stages, which decide what a tab may show before the bar has to scroll.
// Run: node tests/test-tab-bar.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root  = join(dirname(fileURLToPath(import.meta.url)), "..");
const src   = readFileSync(join(root, "src/app/tab-bar.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const T = win.OMP_TAB_BAR;

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

// ── stage (tab-bar density) ───────────────────────────────────────────────

check("140px per tab is still the full stage", () => {
  assert.equal(T.stage(1400, 10), 0);
});

check("a hair below 140px per tab drops to compact", () => {
  assert.equal(T.stage(1399, 10), 1);
});

check("96px per tab stays compact", () => {
  assert.equal(T.stage(960, 10), 1);
});

check("a hair below 96px per tab drops to icon-only", () => {
  assert.equal(T.stage(959, 10), 2);
});

check("48px per tab stays icon-only", () => {
  assert.equal(T.stage(480, 10), 2);
});

check("a hair below 48px per tab adds scrolling and edge fades", () => {
  assert.equal(T.stage(479, 10), 3);
});

check("no tabs is the full stage", () => {
  assert.equal(T.stage(1000, 0), 0);
});

check("a non-finite width is the full stage", () => {
  assert.equal(T.stage(NaN, 5), 0);
});

check("a negative width is the full stage", () => {
  assert.equal(T.stage(-1, 5), 0);
});

// ── module shape ──────────────────────────────────────────────────────────

check("the module assigns exactly window.OMP_TAB_BAR and needs no other globals", () => {
  const bare = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(bare);
  assert.deepEqual(Object.keys(bare), ["OMP_TAB_BAR"]);
  assert.deepEqual(Object.keys(bare.OMP_TAB_BAR), ["stage"]);
  assert.equal(typeof bare.OMP_TAB_BAR.stage, "function");
});

console.log(`tab-bar: ${passed} checks passed`);