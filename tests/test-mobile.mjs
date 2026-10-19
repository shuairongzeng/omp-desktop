// tests/test-mobile.mjs — app/mobile.js (window.OMP_MOBILE).
// Runs the module against a stubbed window.matchMedia and covers all
// three predicates across touch / non-touch / absent-API environments.
// Run: node tests/test-mobile.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/app/mobile.js", import.meta.url), "utf8");

/** Window stand-in whose matchMedia answers from a table the test
 *  controls per case: a query maps to { matches } or is absent. */
function windowStub(media = {}) {
  return {
    matchMedia: (q) => media[q] ?? { matches: false },
  };
}

/** The module loaded into a fresh stub. Returns OMP_MOBILE. */
function load(media) {
  const win = windowStub(media);
  new Function("window", src)(win);
  return win.OMP_MOBILE;
}

const COARSE = { "(pointer: coarse)": { matches: true } };
const FINE   = { "(pointer: coarse)": { matches: false } };

test("isTouch: true only on a coarse pointer", () => {
  assert.equal(load(COARSE).isTouch(), true);
  assert.equal(load(FINE).isTouch(), false);
  // No matchMedia at all (a bare window stub) must not throw: the module
  // guards and reports non-touch, the conservative default.
  const bare = {};
  new Function("window", src)(bare);
  assert.equal(bare.OMP_MOBILE.isTouch(), false);
});

test("submitOnEnter: false on touch, true on desktop", () => {
  assert.equal(load(COARSE).submitOnEnter(), false);
  assert.equal(load(FINE).submitOnEnter(), true);
});

test("placeholder: touch strings, desktop null", () => {
  const touch = load(COARSE);
  assert.equal(touch.placeholder("idle"), "message…");
  assert.equal(touch.placeholder("streaming"), "working… tap ⏹ to stop");
  // An unknown kind still answers the idle string, never null — the
  // caller's `?? desktopString` fallback must not fire on a touch device.
  assert.equal(touch.placeholder("other"), "message…");
  // Desktop: null for every kind — the desktop branch owns the string.
  const desk = load(FINE);
  assert.equal(desk.placeholder("idle"), null);
  assert.equal(desk.placeholder("streaming"), null);
});

test("the exported object is frozen and complete", () => {
  const m = load(FINE);
  assert.deepEqual(Object.keys(m).sort(), ["isTouch", "placeholder", "submitOnEnter"]);
  assert.ok(Object.isFrozen(m));
  assert.throws(() => { m.extra = 1; }, TypeError);
});
