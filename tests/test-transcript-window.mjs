// tests/test-transcript-window.mjs — app/transcript-window.js
// (window.OMP_TRANSCRIPT_WINDOW). Covers the window arithmetic live.js
// relies on: the newest tail window, paging backwards through
// nextBefore, the head, a stale cursor, degenerate inputs, purity, and
// cursor stability across appends at the tail.
// Run: node tests/test-transcript-window.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/app/transcript-window.js", import.meta.url), "utf8");

/** The module loaded into a bare window stand-in. Returns
 *  OMP_TRANSCRIPT_WINDOW. */
function load() {
  const win = {};
  new Function("window", src)(win);
  return win.OMP_TRANSCRIPT_WINDOW;
}

/** Message rows 0..n-1 — the row itself is its absolute index, so a
 *  window's contents read back as its index range. */
const rows = (n) => Array.from({ length: n }, (_, i) => i);

test("newest window: the tail slice, with older rows behind it", () => {
  const { sliceWindow } = load();
  const all = rows(10);
  assert.deepEqual(sliceWindow(all, null, 4), {
    messages: [6, 7, 8, 9],
    hasOlder: true,
    nextBefore: 6,
  });
  // undefined means the same as null: the newest window.
  assert.deepEqual(sliceWindow(all, undefined, 4), {
    messages: [6, 7, 8, 9],
    hasOlder: true,
    nextBefore: 6,
  });
});

test("second window via nextBefore is the slice right before the first", () => {
  const { sliceWindow } = load();
  const all = rows(10);
  const newest = sliceWindow(all, null, 4);
  const older = sliceWindow(all, newest.nextBefore, 4);
  assert.deepEqual(older.messages, [2, 3, 4, 5]);
  assert.equal(older.hasOlder, true);
  assert.equal(older.nextBefore, 2);
  // Contiguous: the older window ends exactly where the newer one
  // starts, and together they are the tail of `all`.
  assert.equal(older.messages.at(-1) + 1, newest.messages[0]);
  assert.deepEqual(older.messages.concat(newest.messages), all.slice(2));
});

test("hasOlder is false once the window reaches the head", () => {
  const { sliceWindow } = load();
  const all = rows(10);
  assert.deepEqual(sliceWindow(all, 2, 4), { messages: [0, 1], hasOlder: false, nextBefore: 0 });
  // A transcript shorter than the window is one window, already at the
  // head.
  assert.deepEqual(sliceWindow(rows(3), null, 4), {
    messages: [0, 1, 2],
    hasOlder: false,
    nextBefore: 0,
  });
});

test("a stale cursor past the end clamps to the end", () => {
  const { sliceWindow } = load();
  const all = rows(10);
  // The reply shrank under a trim after the cursor was handed out.
  assert.deepEqual(sliceWindow(all, 42, 4), {
    messages: [6, 7, 8, 9],
    hasOlder: true,
    nextBefore: 6,
  });
  // Clamped to the end with a limit covering everything: the head, so
  // there is nothing older.
  assert.deepEqual(sliceWindow(all, 42, 20), {
    messages: all,
    hasOlder: false,
    nextBefore: 0,
  });
});

test("degenerate inputs answer an empty window instead of throwing", () => {
  const { sliceWindow } = load();
  const empty = { messages: [], hasOlder: false, nextBefore: 0 };
  assert.deepEqual(sliceWindow(null, null, 4), empty);
  assert.deepEqual(sliceWindow(undefined, 3, 4), empty);
  assert.deepEqual(sliceWindow("messages", null, 4), empty);
  assert.deepEqual(sliceWindow(rows(5), null, 0), empty);
  assert.deepEqual(sliceWindow(rows(5), null, -2), empty);
  assert.deepEqual(sliceWindow(rows(5), null, undefined), empty);
});

test("sliceWindow never mutates the input array", () => {
  const { sliceWindow } = load();
  const all = rows(8);
  const snapshot = all.slice();
  const win = sliceWindow(all, 6, 3);
  assert.deepEqual(all, snapshot);
  // The returned rows are a copy, not a view of the caller's array.
  assert.notEqual(win.messages, all);
  win.messages.push(99);
  assert.deepEqual(all, snapshot);
});

test("an append at the tail does not shift an outstanding cursor", () => {
  const { sliceWindow } = load();
  const all = rows(10);
  const newest = sliceWindow(all, null, 4);          // [6,7,8,9], cursor 6
  const older = sliceWindow(all, newest.nextBefore, 4); // [2,3,4,5], cursor 2
  const head = sliceWindow(all, older.nextBefore, 4);   // [0,1]
  all.push(10, 11, 12); // the agent streamed three more rows
  // Re-slicing with the outstanding cursor still answers that same
  // older window — the cursor indexes from the head, so rows arriving
  // at the tail cannot shift it.
  assert.deepEqual(sliceWindow(all, older.nextBefore, 4), head);
  // And re-asking for the window that was the newest before the append,
  // using its absolute end as the cursor, still returns it unchanged.
  assert.deepEqual(
    sliceWindow(all, newest.nextBefore + newest.messages.length, 4).messages,
    newest.messages,
  );
});