#!/usr/bin/env node
// Regression script for src/app/remote-devices.js — the phone's
// paired-desktop registry: store-shape sanitising, the migration from the
// legacy single-pairing key, every list transition (upsert / select /
// forget / setInfo / touch) as a pure function, and the display helpers.
// Run: node tests/test-remote-devices.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/remote-devices.js"), "utf8");

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: map,
  };
}

const win = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const D = win.OMP_REMOTE_DEVICES;
assert.ok(D, "module exports window.OMP_REMOTE_DEVICES");

let n = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); }
  n++;
  console.log(`  ok  ${msg}`);
};

const entry = (device, token, extra = {}) => ({ device, token, name: "", os: "", lastUsed: 0, ...extra });

// ── normalize ──────────────────────────────────────────────────────────────
{
  const s = D.normalize(null);
  assert.deepEqual(s, { devices: [], selected: null });
  ok(true, "normalize(null) is the empty store");
}
{
  const s = D.normalize({ devices: "nope" });
  assert.deepEqual(s, { devices: [], selected: null });
  ok(true, "a non-array devices field sanitises to empty");
}
{
  const s = D.normalize({
    devices: [
      entry("d1", "t1", { name: "x".repeat(200) }),
      entry("d1", "t1-dup"),            // duplicate device id: dropped
      { device: "", token: "t" },        // invalid: empty id
      { device: "d2" },                 // invalid: no token
      null,
      entry("d3", "t3", { lastUsed: "yesterday" }), // non-finite lastUsed → 0
    ],
    selected: "d9",                      // points at nothing → dropped
  });
  assert.equal(s.devices.length, 2);
  assert.deepEqual(s.devices.map((d) => d.device), ["d1", "d3"]);
  assert.equal(s.devices[0].token, "t1");       // first wins over the dup
  assert.equal(s.devices[0].name.length, 80);   // capped at the relay's limit
  assert.equal(s.devices[1].lastUsed, 0);
  assert.equal(s.selected, null);
  ok(true, "normalize drops invalid/duplicate entries, caps names, vetoes a dangling selection");
}
{
  const s = D.normalize({ devices: [entry("d1", "t1"), entry("d2", "t2")], selected: "d2" });
  assert.equal(s.selected, "d2");
  ok(true, "normalize keeps a selection that points at a surviving entry");
}

// ── load + legacy migration ────────────────────────────────────────────────
{
  const st = makeStorage();
  assert.deepEqual(D.load(st), { devices: [], selected: null });
  ok(true, "load on empty storage is the empty store");
}
{
  const st = makeStorage({ "omp-remote:auth": JSON.stringify({ device: "old-d", token: "old-t" }) });
  const s = D.load(st);
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].device, "old-d");
  assert.equal(s.devices[0].token, "old-t");
  assert.equal(s.selected, "old-d");
  // Migrated in place: the new key is written, the legacy key is gone.
  assert.ok(st.getItem("omp-remote:devices"), "the new key holds the migrated store");
  assert.equal(st.getItem("omp-remote:auth"), null);
  const again = D.load(st);
  assert.deepEqual(again, s);
  ok(true, "load migrates the legacy single-pairing key once, keeping the desktop selected");
}
{
  const st = makeStorage({
    "omp-remote:auth": JSON.stringify({ device: "old-d", token: "old-t" }),
    "omp-remote:devices": JSON.stringify({ devices: [entry("d1", "t1")], selected: "d1" }),
  });
  const s = D.load(st);
  assert.deepEqual(s.devices.map((d) => d.device), ["d1"]);
  ok(true, "an existing list wins over the legacy key (no re-migration)");
}
{
  const st = makeStorage({ "omp-remote:auth": "{broken json" });
  assert.deepEqual(D.load(st), { devices: [], selected: null });
  ok(true, "broken legacy JSON loads as empty, never throws");
}

// ── upsert ─────────────────────────────────────────────────────────────────
{
  let s = D.upsert(D.emptyStore(), "d1", "t1");
  assert.equal(s.selected, "d1");
  ok(true, "the first pairing selects its device");

  s = D.upsert(s, "d2", "t2");
  assert.equal(s.devices.length, 2);
  assert.equal(s.selected, "d2");
  ok(true, "pairing a second desktop appends and selects it (the QR's intent)");

  const named = D.setInfo(s, "d2", { name: "Studio", os: "macos" });
  const re = D.upsert(named, "d2", "t2-new");
  assert.equal(re.devices.find((d) => d.device === "d2").token, "t2-new");
  assert.equal(re.devices.find((d) => d.device === "d2").name, "Studio");
  assert.equal(re.selected, "d2");
  ok(true, "re-pairing a known device swaps the token, keeps name/os and the selection");

  const keep = D.upsert(named, "d1", "t1b");
  assert.equal(keep.selected, "d2");
  ok(true, "re-pairing a non-selected device does not steal the selection");

  const orphan = { devices: [entry("d1", "t1")], selected: "ghost" };
  assert.equal(D.upsert(orphan, "d1", "t1c").selected, "d1");
  ok(true, "a dangling selection heals on the next upsert");
}

// ── select / forget ────────────────────────────────────────────────────────
{
  const s = { devices: [entry("d1", "t1"), entry("d2", "t2")], selected: "d1" };
  assert.equal(D.select(s, "d2").selected, "d2");
  assert.deepEqual(D.select(s, "nope"), s);
  ok(true, "select switches to a known device and refuses unknown ones");

  const f = D.forget(s, "d1");
  assert.deepEqual(f.devices.map((d) => d.device), ["d2"]);
  assert.equal(f.selected, "d2");
  ok(true, "forgetting the selected device falls back to the first remaining");

  assert.equal(D.forget({ devices: [entry("d1", "t1")], selected: "d1" }, "d1").selected, null);
  ok(true, "forgetting the last device clears the selection (picker/pairing takes over)");

  const other = D.forget(s, "d2");
  assert.equal(other.selected, "d1");
  ok(true, "forgetting a non-selected device keeps the selection");
}

// ── setInfo / touch ────────────────────────────────────────────────────────
{
  const s = { devices: [entry("d1", "t1", { name: "Old", os: "linux" })], selected: "d1" };
  const updated = D.setInfo(s, "d1", { name: "New", os: "windows" });
  assert.equal(updated.devices[0].name, "New");
  assert.equal(updated.devices[0].os, "windows");
  ok(true, "setInfo folds a relay `device` frame into the entry");

  const blank = D.setInfo(s, "d1", { name: "  ", os: "" });
  assert.equal(blank.devices[0].name, "Old");
  ok(true, "blank fields never clobber a stored name");

  assert.deepEqual(D.setInfo(s, "nope", { name: "x" }), s);
  ok(true, "setInfo on an unknown device is a no-op");

  const t = D.touch(s, "d1", 1234);
  assert.equal(t.devices[0].lastUsed, 1234);
  assert.equal(D.touch(s, "d1", NaN).devices[0].lastUsed, 0);
  assert.deepEqual(D.touch(s, "nope", 1), s);
  ok(true, "touch stamps lastUsed and no-ops on unknown devices");
}

// ── display helpers ────────────────────────────────────────────────────────
{
  assert.equal(D.selectedEntry({ devices: [entry("d1", "t1")], selected: "d1" }).device, "d1");
  assert.equal(D.selectedEntry({ devices: [], selected: null }), null);
  ok(true, "selectedEntry finds the chosen device or null");

  assert.equal(D.displayName(entry("abcdef123456", "t", { name: "My PC" })), "My PC");
  assert.equal(D.displayName(entry("abcdef123456", "t")), "桌面 abcdef12");
  assert.equal(D.displayName(null), "桌面 ");
  ok(true, "displayName prefers the reported name, falls back to a short id tag");

  assert.equal(D.osLabel("windows"), "Windows");
  assert.equal(D.osLabel("macos"), "macOS");
  assert.equal(D.osLabel("linux"), "Linux");
  assert.equal(D.osLabel("plan9"), "plan9");
  assert.equal(D.osLabel(""), "");
  ok(true, "osLabel maps the std os tags and passes unknown ones through");
}

console.log(`remote-devices: ${n} checks passed`);
