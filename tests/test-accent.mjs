#!/usr/bin/env node
// Regression script for src/app/accent.js — the `accent` tweak as the five
// CSS tokens the themes define, so an accent override also moves
// --accent-soft / --accent-glow / --accent-deep / --accent-fg (focus
// rings, xterm selection, text on the accent) instead of leaving the
// theme preset's colour in them. --accent-fg is the one addition of the
// R5 contrast fix; the other four derivations are unchanged.
// Run: node tests/test-accent.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/accent.js"), "utf8"))(win);
const A = win.OMP_ACCENT;

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

check("accentTokens: all five tokens from a #rrggbb accent", () => {
  assert.deepEqual(A.accentTokens("#FF7AC6"), {
    "--accent": "#ff7ac6",
    "--accent-soft": "rgba(255, 122, 198, 0.12)",
    "--accent-glow": "rgba(255, 122, 198, 0.45)",
    "--accent-deep": "#bf5c95",
    "--accent-fg": "#101018",
  });
});

check("accentTokens: #rgb shorthand expands", () => {
  assert.equal(A.accentTokens("#fff")["--accent"], "#ffffff");
  assert.equal(A.accentTokens(" #0F0 ")["--accent-soft"], "rgba(0, 255, 0, 0.12)");
});

check("accentTokens: --accent-fg follows the accent's luminance", () => {
  // Light accents take near-black text, dark accents near-white —
  // the poles the settings swatches actually pair with.
  assert.equal(A.accentTokens("#8AF0C8")["--accent-fg"], "#101018");
  assert.equal(A.accentTokens("#FFC56E")["--accent-fg"], "#101018");
  assert.equal(A.accentTokens("#1F8A5B")["--accent-fg"], "#ffffff");
  assert.equal(A.accentTokens("#D6336C")["--accent-fg"], "#ffffff");
  assert.equal(A.accentTokens("#B58900")["--accent-fg"], "#101018");
  assert.equal(A.accentTokens("#000000")["--accent-fg"], "#ffffff");
});

check("accentTokens: the token names are the ones the themes define", () => {
  assert.deepEqual(Object.keys(A.accentTokens("#000000")), A.TOKEN_NAMES);
});

check("accentTokens: non-hex input gives null (theme tokens stay)", () => {
  for (const bad of ["", null, undefined, "red", "#12", "#12345", "rgb(1,2,3)", "#ggg"]) {
    assert.equal(A.accentTokens(bad), null, String(bad));
  }
});

check("sameColor: case and shorthand insensitive; non-hex never matches", () => {
  assert.equal(A.sameColor("#8AF0C8", "#8af0c8"), true);
  assert.equal(A.sameColor("#abc", "#AABBCC"), true);
  assert.equal(A.sameColor("#8AF0C8", "#C4FF3F"), false);
  assert.equal(A.sameColor("", "#8AF0C8"), false);
  assert.equal(A.sameColor("red", "red"), false);
});

console.log(`accent: ${passed} checks passed`);
