// tests/test-remote-tabs.mjs — app/remote-tabs.js (window.OMP_REMOTE_TABS).
// Loads the IIFE against a stubbed window and covers the phone's tab-table
// merge: default state for newly attached desktop tabs, skipping rows that
// are already attached or have no usable id, ordering, and the purity
// guarantee (registry and snapshot untouched).
// Run: node tests/test-remote-tabs.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/app/remote-tabs.js", import.meta.url), "utf8");

/** The module loaded into a fresh stub. Returns OMP_REMOTE_TABS. */
function load() {
  const win = {};
  new Function("window", src)(win);
  return win.OMP_REMOTE_TABS;
}

/** The six fields a freshly attached tab starts with, before the
 *  snapshot row is spread over them. */
const DEFAULTS = {
  approvalMode: null,
  sessionFile: null,
  autoRenameArmed: false,
  autoRenameInFlight: false,
  autoRenameTurns: 0,
  autoRenameLeft: 0,
};

test("unknown ids get the six defaults plus the snapshot row", () => {
  const { mergeSnapshot } = load();
  const registry = new Map();
  const tabs = [{ id: "a", name: "Alpha", path: "/work/alpha", extra: 42 }];
  const { added } = mergeSnapshot(registry, tabs);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], {
    id: "a",
    entry: { ...DEFAULTS, id: "a", name: "Alpha", path: "/work/alpha", extra: 42 },
  });
  // Snapshot values win over the defaults, not the other way round.
  assert.equal(added[0].entry.extra, 42);
});

test("ids already in the registry are not returned and stay untouched", () => {
  const { mergeSnapshot } = load();
  const existing = { approvalMode: "acceptEdits", name: "Desktop's own" };
  const registry = new Map([["a", existing]]);
  const { added, ids } = mergeSnapshot(registry, [
    { id: "a", name: "Snapshot's copy" },
    { id: "b", name: "Beta" },
  ]);
  assert.deepEqual(ids, ["b"]);
  assert.deepEqual(added.map((x) => x.id), ["b"]);
  // The attached entry is the same object the desktop registered — the
  // merge must never overwrite its state from the snapshot.
  assert.equal(registry.get("a"), existing);
  assert.equal(registry.get("a").name, "Desktop's own");
});

test("rows without a non-empty string id are skipped entirely", () => {
  const { mergeSnapshot } = load();
  const { added, ids } = mergeSnapshot(new Map(), [
    null,
    undefined,
    {},
    { id: 7, name: "number id" },
    { id: "", name: "empty id" },
    { id: "ok" },
  ]);
  assert.deepEqual(ids, ["ok"]);
  assert.deepEqual(added.map((x) => x.id), ["ok"]);
});

test("ids mirror the added order across skipped rows", () => {
  const { mergeSnapshot } = load();
  const registry = new Map([["skip", {}]]);
  const { added, ids } = mergeSnapshot(registry, [
    { id: "one" },
    { id: "skip" },
    { id: "two" },
    { id: "three" },
  ]);
  assert.deepEqual(ids, ["one", "two", "three"]);
  assert.deepEqual(added.map((x) => x.id), ids);
});

test("empty or undefined tabs array yields an empty result", () => {
  const { mergeSnapshot } = load();
  assert.deepEqual(mergeSnapshot(new Map(), []), { added: [], ids: [] });
  assert.deepEqual(mergeSnapshot(new Map(), undefined), { added: [], ids: [] });
});

test("registry and snapshot rows are not mutated", () => {
  const { mergeSnapshot } = load();
  const registry = new Map();
  const tabs = [{ id: "a", name: "Alpha" }, { id: "b", path: "/b" }];
  const before = JSON.parse(JSON.stringify(tabs));
  mergeSnapshot(registry, tabs);
  assert.equal(registry.size, 0);
  assert.deepEqual(tabs, before);
});

test("refetchWindow: a newly reported session file asks for a re-fetch", () => {
  const { refetchWindow } = load();
  assert.equal(refetchWindow(null, "/s/a.jsonl"), true);
  assert.equal(refetchWindow(undefined, "/s/a.jsonl"), true);
  assert.equal(refetchWindow("", "/s/a.jsonl"), true);
});

test("refetchWindow: an unchanged or missing session file does not", () => {
  const { refetchWindow } = load();
  assert.equal(refetchWindow("/s/a.jsonl", "/s/a.jsonl"), false);
  assert.equal(refetchWindow(null, null), false);
  assert.equal(refetchWindow("/s/a.jsonl", null), false);
  assert.equal(refetchWindow("/s/a.jsonl", undefined), false);
  assert.equal(refetchWindow("/s/a.jsonl", ""), false);
});

test("refetchWindow: a different session file asks for a re-fetch", () => {
  const { refetchWindow } = load();
  assert.equal(refetchWindow("/s/a.jsonl", "/s/b.jsonl"), true);
});

test("the exported object is frozen and complete", () => {
  const m = load();
  assert.deepEqual(Object.keys(m), ["mergeSnapshot", "refetchWindow"]);
  assert.ok(Object.isFrozen(m));
  assert.throws(() => { m.extra = 1; }, TypeError);
});

// node:test's own tail is counts only; state the verdict plainly too, and
// stay silent when the runner already marked the process failed.
process.on("exit", () => {
  if (!process.exitCode) console.log("test-remote-tabs: all checks passed");
});