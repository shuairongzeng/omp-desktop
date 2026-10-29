#!/usr/bin/env node
// Regression script for src/app/slash-usage.js — the `/` palette's usage
// ranking: the persisted `{name: {count, last}}` map, the never-throwing
// load/save pair, the immutable `record` with its 50-name cap, and
// `topThree`'s count-then-recency order with its `available` filter.
// Run: node tests/test-slash-usage.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src  = readFileSync(join(root, "src/app/slash-usage.js"), "utf8");

/** Load the module against a fake window whose `localStorage` is `storage`
 *  (omitted → a window without storage at all, the test/SSR case). */
function loadModule(storage) {
  const win = storage === undefined ? {} : { localStorage: storage };
  // eslint-disable-next-line no-new-func
  new Function("window", src)(win);
  return win.OMP_SLASH_USAGE;
}

/** Minimal localStorage stand-in over a Map; `seed` maps keys to raw strings. */
function makeStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

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

const KEY = "omp-desktop.slash-usage";
const entry = (count, last) => ({ count, last });

// ── surface ───────────────────────────────────────────────────────────────

check("exposes exactly the documented members, frozen", () => {
  const S = loadModule(makeStorage());
  assert.deepEqual(Object.keys(S).sort(), ["KEY", "load", "record", "save", "topThree"]);
  assert.ok(Object.isFrozen(S));
});

check("KEY is the documented storage key", () => {
  assert.equal(loadModule(makeStorage()).KEY, "omp-desktop.slash-usage");
});

check("the module is an IIFE and touches no DOM", () => {
  assert.ok(!/\bdocument\b/.test(src), "must not touch the DOM");
  assert.ok(src.trimEnd().endsWith("})();"), "must be an IIFE");
});

// ── load ──────────────────────────────────────────────────────────────────

check("load on an empty storage is {}", () => {
  assert.deepEqual(loadModule(makeStorage()).load(), {});
});

check("load without any localStorage is {} (never throws)", () => {
  assert.deepEqual(loadModule().load(), {});
});

check("load on a corrupt JSON value is {}", () => {
  const S = loadModule(makeStorage({ [KEY]: "{not json" }));
  assert.deepEqual(S.load(), {});
});

check("load on non-object JSON is {} (array, null, number, string)", () => {
  for (const raw of ["[]", "null", "42", '"hello"', "true"]) {
    const S = loadModule(makeStorage({ [KEY]: raw }));
    assert.deepEqual(S.load(), {}, `raw=${raw}`);
  }
});

check("load sanitizes junk entries and drops non-object ones", () => {
  const S = loadModule(makeStorage({
    [KEY]: JSON.stringify({ a: entry(3, 10), b: "nope", c: { count: "x" }, d: entry(1.9, 5) }),
  }));
  assert.deepEqual(S.load(), { a: entry(3, 10), c: entry(0, 0), d: entry(1, 5) });
});

check("load survives a storage whose getItem throws", () => {
  const S = loadModule({ getItem() { throw new Error("denied"); }, setItem() {} });
  assert.deepEqual(S.load(), {});
});

// ── record ────────────────────────────────────────────────────────────────

check("record starts a new name at count 1 with a timestamp", () => {
  const S = loadModule(makeStorage());
  const before = Date.now();
  const next = S.record({}, "/model");
  const after = Date.now();
  assert.equal(next["/model"].count, 1);
  assert.ok(next["/model"].last >= before && next["/model"].last <= after, "last is Date.now()");
});

check("record increments an existing name and returns a NEW map", () => {
  const S = loadModule(makeStorage());
  const first = { "/model": entry(1, 100) };
  const next = S.record(first, "/model");
  assert.notEqual(next, first);
  assert.equal(next["/model"].count, 2);
  assert.ok(next["/model"].last > 100, "last is refreshed");
});

check("record never mutates its input map", () => {
  const S = loadModule(makeStorage());
  const input = { "/model": entry(1, 100), "/goal": entry(4, 200) };
  const snapshot = JSON.parse(JSON.stringify(input));
  S.record(input, "/model");
  assert.deepEqual(input, snapshot);
});

check("record copies entries, so mutating the result leaves the input alone", () => {
  const S = loadModule(makeStorage());
  const input = { "/model": entry(1, 100) };
  const next = S.record(input, "/model");
  next["/model"].count = 99;
  assert.equal(input["/model"].count, 1);
});

check("record ignores names that are not non-empty strings", () => {
  const S = loadModule(makeStorage());
  const input = { "/model": entry(2, 100) };
  for (const bad of ["", null, undefined, 42, {}, []]) {
    const next = S.record(input, bad);
    assert.deepEqual(next, input, `name=${String(bad)}`);
    assert.notEqual(next, input, "still a fresh map");
  }
});

check("record tolerates a non-object input map", () => {
  const S = loadModule(makeStorage());
  const next = S.record(null, "/x");
  assert.equal(next["/x"].count, 1);
  assert.equal(typeof next["/x"].last, "number");
  assert.deepEqual(S.record("nope", "/x"), { "/x": S.record(null, "/x")["/x"] });
});

// ── the 50-name cap ───────────────────────────────────────────────────────

check("record caps the map at 50, dropping the oldest last first", () => {
  const S = loadModule(makeStorage());
  const input = {};
  for (let n = 1; n <= 50; n++) input[`cmd${n}`] = entry(1, n);
  const next = S.record(input, "/fresh");
  assert.equal(Object.keys(next).length, 50);
  assert.ok(!("cmd1" in next), "oldest last (1) is evicted");
  assert.ok("cmd2" in next);
  assert.ok("/fresh" in next);
});

check("the cap's input map is untouched", () => {
  const S = loadModule(makeStorage());
  const input = {};
  for (let n = 1; n <= 50; n++) input[`cmd${n}`] = entry(1, n);
  S.record(input, "/fresh");
  assert.equal(Object.keys(input).length, 50);
  assert.ok("cmd1" in input);
});

check("the cap evicts by last, not by name order", () => {
  const S = loadModule(makeStorage());
  const input = {};
  for (let n = 1; n <= 50; n++) input[`cmd${n}`] = entry(1, 1000 - n);
  const next = S.record(input, "/fresh");
  assert.ok(!("cmd50" in next), "smallest last wins the eviction");
  assert.ok("cmd1" in next);
});

check("49 names plus one record stays at 50 without evicting", () => {
  const S = loadModule(makeStorage());
  const input = {};
  for (let n = 1; n < 50; n++) input[`cmd${n}`] = entry(1, n);
  const next = S.record(input, "/fresh");
  assert.equal(Object.keys(next).length, 50);
  assert.ok("cmd1" in next);
});

// ── topThree ordering ─────────────────────────────────────────────────────

check("topThree orders by count desc, then last desc", () => {
  const S = loadModule(makeStorage());
  const map = {
    "/a": entry(2, 10),
    "/b": entry(9, 5),
    "/c": entry(2, 30),
    "/d": entry(2, 20),
    "/e": entry(9, 6),
  };
  assert.deepEqual(S.topThree(map), ["/e", "/b", "/c"]);
});

check("topThree returns at most three, and fewer when the map is smaller", () => {
  const S = loadModule(makeStorage());
  assert.deepEqual(S.topThree({}), []);
  assert.deepEqual(S.topThree({ "/a": entry(1, 1) }), ["/a"]);
  assert.deepEqual(S.topThree({ "/a": entry(1, 1), "/b": entry(1, 2) }), ["/b", "/a"]);
});

check("topThree never mutates its input map", () => {
  const S = loadModule(makeStorage());
  const map = { "/a": entry(2, 10), "/b": entry(9, 5), "/c": entry(2, 30), "/d": entry(2, 20) };
  const snapshot = JSON.parse(JSON.stringify(map));
  S.topThree(map, ["/a"]);
  assert.deepEqual(map, snapshot);
});

// ── topThree filtering ───────────────────────────────────────────────────

check("topThree drops names absent from available", () => {
  const S = loadModule(makeStorage());
  const map = { "/a": entry(9, 1), "/b": entry(8, 1), "/c": entry(7, 1), "/d": entry(6, 1) };
  assert.deepEqual(S.topThree(map, ["/b", "/d"]), ["/b", "/d"]);
});

check("topThree with an empty available list is empty", () => {
  const S = loadModule(makeStorage());
  assert.deepEqual(S.topThree({ "/a": entry(9, 1) }, []), []);
});

check("topThree with null/undefined available keeps every name", () => {
  const S = loadModule(makeStorage());
  const map = { "/a": entry(3, 1), "/b": entry(2, 1), "/c": entry(1, 1), "/d": entry(0, 99) };
  assert.deepEqual(S.topThree(map, null), ["/a", "/b", "/c"]);
  assert.deepEqual(S.topThree(map, undefined), ["/a", "/b", "/c"]);
  assert.deepEqual(S.topThree(map), ["/a", "/b", "/c"]);
});

check("topThree ignores non-array available values as 'no filter'", () => {
  const S = loadModule(makeStorage());
  const map = { "/a": entry(3, 1), "/b": entry(2, 1) };
  assert.deepEqual(S.topThree(map, "/a"), ["/a", "/b"]);
});

check("topThree tolerates a non-object input map", () => {
  const S = loadModule(makeStorage());
  assert.deepEqual(S.topThree(null), []);
  assert.deepEqual(S.topThree(null, ["/a"]), []);
});

// ── save / load round trip ───────────────────────────────────────────────

check("save/load round trip through localStorage preserves the map", () => {
  const storage = makeStorage();
  const S = loadModule(storage);
  const map = { "/model": entry(3, 1700000000000), "/goal": entry(1, 1700000000500) };
  S.save(map);
  assert.equal(storage.data.get(KEY), JSON.stringify(map));
  assert.deepEqual(S.load(), map);
});

check("save overwrites the previous value", () => {
  const storage = makeStorage({ [KEY]: JSON.stringify({ "/old": entry(9, 1) }) });
  const S = loadModule(storage);
  S.save({ "/new": entry(1, 2) });
  assert.deepEqual(S.load(), { "/new": entry(1, 2) });
});

check("save swallows a quota/private-mode error", () => {
  const S = loadModule({ getItem() { return null; }, setItem() { throw new Error("QuotaExceededError"); } });
  S.save({ "/a": entry(1, 1) });
  assert.deepEqual(S.load(), {});
});

check("save without any localStorage is a no-op, not a throw", () => {
  loadModule().save({ "/a": entry(1, 1) });
});

check("record → save → load keeps the incremented count", () => {
  const storage = makeStorage();
  const S = loadModule(storage);
  S.save(S.record(S.record(S.load(), "/dp"), "/dp"));
  assert.equal(S.load()["/dp"].count, 2);
});

console.log(`test-slash-usage: ${passed} checks passed`);