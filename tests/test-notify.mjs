#!/usr/bin/env node
// tests/test-notify.mjs — app/notify.js's shouldNotify (the attention
// system's pure half): the busy→idle / busy→waiting-user transitions, the
// notifyDone/notifyAsk tweaks, and the "only when not looking" visibility
// gate. The effect half (fire) is guarded best-effort and exercised by the
// integrator, not here.
// Run: node tests/test-notify.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/app/notify.js", import.meta.url), "utf8");

/** The module against a fresh window stub; returns its OMP_NOTIFY export. */
function load() {
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(win);
  return win.OMP_NOTIFY;
}

const T = load();

// The argument builder: visibility defaults to "not looking" (the gate
// must not block), tweaks default to the TWEAK_DEFAULTS pair (both on).
const args = (over = {}) => ({
  prevRun: "running",
  nextRun: "idle",
  documentHidden: true,
  isActiveTab: true,
  tweaks: { notifyDone: true, notifyAsk: true },
  ...over,
});

test("running → idle with notifyDone on (not looking) notifies", () => {
  assert.equal(T.shouldNotify(args()), true);
});

test("busy (aggregated) → waiting-user with notifyAsk on notifies", () => {
  assert.equal(T.shouldNotify(args({ prevRun: "busy", nextRun: "waiting-user" })), true);
});

test("running → waiting-user with notifyAsk on notifies", () => {
  assert.equal(T.shouldNotify(args({ nextRun: "waiting-user" })), true);
});

test("done: notifyDone off suppresses the idle notification", () => {
  assert.equal(T.shouldNotify(args({ tweaks: { notifyDone: false, notifyAsk: true } })), false);
});

test("ask: notifyAsk off suppresses the waiting-user notification", () => {
  assert.equal(
    T.shouldNotify(args({ nextRun: "waiting-user", tweaks: { notifyDone: true, notifyAsk: false } })),
    false
  );
});

test("both tweaks off suppress everything", () => {
  assert.equal(
    T.shouldNotify(args({ nextRun: "waiting-user", tweaks: { notifyDone: false, notifyAsk: false } })),
    false
  );
});

test("watching the run live (visible + active tab) is silent", () => {
  assert.equal(T.shouldNotify(args({ documentHidden: false, isActiveTab: true })), false);
});

test("visible document but inactive tab still notifies", () => {
  assert.equal(T.shouldNotify(args({ documentHidden: false, isActiveTab: false })), true);
});

test("hidden document but wrong-window active still notifies", () => {
  // documentHidden covers "another window focused"; the tab gate covers
  // "same window, another tab". Either alone is not-looking.
  assert.equal(T.shouldNotify(args({ documentHidden: true, isActiveTab: false })), true);
});

test("idle → running (the turn starting) never notifies", () => {
  assert.equal(T.shouldNotify(args({ prevRun: "idle", nextRun: "running" })), false);
});

test("busy → failed is not an announcement (the rose dot covers it)", () => {
  assert.equal(T.shouldNotify(args({ prevRun: "busy", nextRun: "failed" })), false);
});

test("still busy → busy is not a transition", () => {
  assert.equal(T.shouldNotify(args({ prevRun: "busy", nextRun: "busy" })), false);
});

test("null tweaks keeps the TWEAK_DEFAULTS behaviour (both on)", () => {
  assert.equal(T.shouldNotify(args({ tweaks: null, nextRun: "waiting-user" })), true);
});

test("undefined visibility fields fall to the not-looking default", () => {
  assert.equal(
    T.shouldNotify({ prevRun: "running", nextRun: "idle", isActiveTab: true, tweaks: {} }),
    true
  );
});

// node:test's own tail is counts only; state the verdict plainly too, and
// stay silent when the runner already marked the process failed.
process.on("exit", () => {
  if (!process.exitCode) console.log("test-notify: all checks passed");
});
