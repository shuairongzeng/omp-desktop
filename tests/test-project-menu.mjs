#!/usr/bin/env node
// Regression script for src/app/project-menu.js — the sidebar project group's
// context menu: the platform wording of "reveal", the row list and its order,
// and when the rows are disabled for a group with no path.
// Run: node tests/test-project-menu.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", readFileSync(join(root, "src/app/project-menu.js"), "utf8"))(win);
const M = win.OMP_PROJECT_MENU;

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

const group = (path) => ({ id: "g1", name: "omp-desktop", path });

// ── revealLabel ───────────────────────────────────────────────────────────

check("macOS reveals in the Finder", () => {
  assert.equal(M.revealLabel("darwin"), "Reveal in Finder");
});

check("Windows reveals in File Explorer", () => {
  assert.equal(M.revealLabel("win32"), "Reveal in File Explorer");
});

check("other platforms open the file manager", () => {
  for (const platform of ["linux", "freebsd", "aix", undefined, "", "Darwin"]) {
    assert.equal(M.revealLabel(platform), "Open in File Manager", String(platform));
  }
});

// ── rows: shape, order, labels ────────────────────────────────────────────

check("rows are reveal then copy-path, with the platform label", () => {
  assert.deepEqual(M.rows(group("/tmp/p"), "darwin"), [
    { id: "reveal", label: "Reveal in Finder", disabled: false },
    { id: "copy-path", label: "Copy project path", disabled: false },
  ]);
});

check("rows carry exactly the three documented keys", () => {
  for (const row of M.rows(group("/tmp/p"), "win32")) {
    assert.deepEqual(Object.keys(row).sort(), ["disabled", "id", "label"]);
  }
});

check("row ids are stable across platforms and states", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const g of [group("/p"), group(""), group(undefined), null]) {
      assert.deepEqual(M.rows(g, platform).map((r) => r.id), ["reveal", "copy-path"]);
    }
  }
});

check("reveal is always the first row and copy-path the second", () => {
  const [first, second] = M.rows(group("/p"), "linux");
  assert.equal(first.id, "reveal");
  assert.equal(second.id, "copy-path");
  assert.equal(first.label, "Open in File Manager");
  assert.equal(second.label, "Copy project path");
});

// ── rows: disabled ────────────────────────────────────────────────────────

check("a path enables both rows", () => {
  for (const row of M.rows(group("/Users/me/project"), "darwin")) {
    assert.equal(row.disabled, false, row.id);
  }
});

check("an empty path disables both rows", () => {
  for (const row of M.rows(group(""), "darwin")) {
    assert.equal(row.disabled, true, row.id);
  }
});

check("a missing path disables both rows", () => {
  for (const row of M.rows({ id: "g1", name: "orphan" }, "darwin")) {
    assert.equal(row.disabled, true, row.id);
  }
  for (const row of M.rows(group(undefined), "darwin")) {
    assert.equal(row.disabled, true, row.id);
  }
});

check("a null-ish group disables both rows instead of throwing", () => {
  for (const g of [null, undefined]) {
    for (const row of M.rows(g, "linux")) {
      assert.equal(row.disabled, true, row.id);
    }
  }
});

check("a disabled group keeps the platform reveal label", () => {
  assert.equal(M.rows(group(""), "win32")[0].label, "Reveal in File Explorer");
});

// ── rows: purity ──────────────────────────────────────────────────────────

check("rows returns a fresh array each call", () => {
  const first = M.rows(group("/p"), "darwin");
  const second = M.rows(group("/p"), "darwin");
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[1], second[1]);
  assert.deepEqual(first, second);
});

check("mutating a returned row does not leak into the next call", () => {
  const first = M.rows(group("/p"), "darwin");
  first.push({ id: "extra", label: "x", disabled: false });
  first[0].label = "changed";
  first[1].disabled = true;

  const second = M.rows(group("/p"), "darwin");
  assert.equal(second.length, 2);
  assert.deepEqual(second, [
    { id: "reveal", label: "Reveal in Finder", disabled: false },
    { id: "copy-path", label: "Copy project path", disabled: false },
  ]);
});

check("rows never mutates the group", () => {
  const g = group("/p");
  const before = JSON.stringify(g);
  M.rows(g, "darwin");
  M.rows(g, "win32");
  M.rows(g, "linux");
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(Object.keys(g).sort(), ["id", "name", "path"]);
});

check("an empty group object is not given a path as a side effect", () => {
  const g = {};
  M.rows(g, "darwin");
  assert.deepEqual(g, {});
});

console.log(`test-project-menu: ${passed} checks passed`);