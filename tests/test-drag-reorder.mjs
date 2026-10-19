#!/usr/bin/env node
// Regression script for src/app/drag-reorder.js — where a dragged tab-bar
// item or sidebar row lands (issue #40).
// Run: node tests/test-drag-reorder.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src  = readFileSync(join(root, "src/app/drag-reorder.js"), "utf8");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const D = win.OMP_DRAG_REORDER;

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

// Three 100px-wide items side by side: a [0,100) b [100,200) c [200,300).
const items = ["a", "b", "c"].map((id, i) => ({ id, start: i * 100, end: i * 100 + 100 }));

check("a press only becomes a drag once the pointer has travelled the threshold", () => {
  assert.equal(D.pastThreshold(3, 3), false);
  assert.equal(D.pastThreshold(D.DRAG_THRESHOLD_PX, 0), true);
  assert.equal(D.pastThreshold(0, -D.DRAG_THRESHOLD_PX), true);
});

// ── Touch: the 16px threshold + main-axis gate (mobile walk-through) ───────

check("a fine pointer keeps the 5px threshold and no axis gate", () => {
  // A diagonal 4px move is under 5px: still a click, either way.
  assert.equal(D.pastThreshold(3, 3), false);
  // The axis opt-in only applies on coarse pointers — a mouse drag that
  // starts mostly sideways on a horizontal bar still reorders.
  assert.equal(D.pastThreshold(0, 10, { axis: "x" }), true);
  assert.equal(D.pastThreshold(10, 0, { axis: "y" }), true);
});

check("a coarse pointer arms at the 16px threshold, not 5", () => {
  // 5px — a decisive mouse drag — is still a touch tap's landing slop.
  assert.equal(D.pastThreshold(6, 0, { coarse: true, axis: "x" }), false);
  assert.equal(D.pastThreshold(0, 6, { coarse: true, axis: "y" }), false);
  assert.equal(D.pastThreshold(D.TOUCH_DRAG_THRESHOLD_PX, 0, { coarse: true, axis: "x" }), true);
  assert.equal(D.pastThreshold(0, D.TOUCH_DRAG_THRESHOLD_PX, { coarse: true, axis: "y" }), true);
});

check("a coarse pointer's first travel must run along the list's axis", () => {
  // Horizontal bar ("x"): a mostly-vertical swipe is a scroll, never a drag.
  assert.equal(D.pastThreshold(12, 20, { coarse: true, axis: "x" }), false);
  assert.equal(D.pastThreshold(20, 12, { coarse: true, axis: "x" }), true);
  // Vertical list ("y"): the mirror image.
  assert.equal(D.pastThreshold(20, 12, { coarse: true, axis: "y" }), false);
  assert.equal(D.pastThreshold(12, 20, { coarse: true, axis: "y" }), true);
  // The gate is strict (main must exceed cross): an exact diagonal is a
  // scroll on either reading, so it stays a no-drag.
  assert.equal(D.pastThreshold(15, 15, { coarse: true, axis: "x" }), false);
});

check("a coarse pointer without an axis keeps only the longer threshold", () => {
  assert.equal(D.pastThreshold(6, 0, { coarse: true }), false);
  assert.equal(D.pastThreshold(16, 0, { coarse: true }), true);
});

check("the slot flips at the target's middle", () => {
  assert.deepEqual(D.dropSlot(items, "a", 249), { targetId: "c", after: false });
  assert.deepEqual(D.dropSlot(items, "a", 251), { targetId: "c", after: true });
  assert.deepEqual(D.dropSlot(items, "c", 49), { targetId: "a", after: false });
});

check("a pointer beyond either end of the list still lands at that end", () => {
  assert.deepEqual(D.dropSlot(items, "a", 5000), { targetId: "c", after: true });
  assert.deepEqual(D.dropSlot(items, "c", -5000), { targetId: "a", after: false });
});

check("a slot right before or after the dragged item is no move", () => {
  // b over its own halves, or the far half of either neighbour.
  for (const pos of [60, 120, 180, 240]) assert.equal(D.dropSlot(items, "b", pos), null, `pos ${pos}`);
  assert.deepEqual(D.dropSlot(items, "b", 40), { targetId: "a", after: false });
  assert.deepEqual(D.dropSlot(items, "b", 260), { targetId: "c", after: true });
});

check("an item missing from the list never gets a slot", () => {
  assert.equal(D.dropSlot(items, "gone", 10), null);
  assert.equal(D.dropSlot([], "a", 10), null);
});

console.log(`drag-reorder: ${passed} checks passed`);
