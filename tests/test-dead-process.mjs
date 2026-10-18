#!/usr/bin/env node
// Regression script for the dead-process / interrupted-run settlement —
// the pure seams live.js leans on when a run ends without its closing
// frames (the process died, an abort cut tools off, or frames fell out of
// the replay journal):
//   - OMP_TURN_STATUS.settleInterrupted: running tool cards flip to
//     { status: "interrupted", isError: true } with the elapsed duration.
//   - OMP_TURN_STATUS.abandonPendingCompaction: a pending compact row
//     fails once nothing can answer it.
//   - OMP_QUEUE.failureNote: a refused bare prompt labels itself "Prompt".
// The full _endDeadProcessState flow is side-effectful (state, notify,
// listeners) and stays in live.js; what it decides is exactly these
// shapes, proven here.
// Run: node tests/test-dead-process.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
// marked-setup.js provides `OMP_MARKDOWN.fenceCode` (failureNote's fence)
// without marked/hljs; the rest of it returns early here.
for (const f of ["src/app/marked-setup.js", "src/app/message-queue.js", "src/app/turn-status.js"]) {
  vm.runInContext(readFileSync(join(root, f), "utf8"), ctx, { filename: f });
}
const T = ctx.OMP_TURN_STATUS;
const Q = ctx.OMP_QUEUE;

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

// ── settleInterrupted ─────────────────────────────────────────────────────
const card = (extra = {}) => ({
  kind: "tool", tool: "bash", title: "bash · ls", status: "running",
  duration: null, time: "12:00", _toolCallId: "t1", _startMs: Date.now() - 500, ...extra,
});

check("a running tool card flips to interrupted with isError and the elapsed duration", () => {
  const out = T.settleInterrupted([card()], Date.now());
  assert.equal(out[0].status, "interrupted");
  assert.equal(out[0].isError, true);
  assert.equal(out[0].tool, "bash");       // the card itself is intact
  assert.equal(out[0]._toolCallId, "t1");  // a late end frame still finds it
  assert.ok(out[0].duration >= 500 && out[0].duration < 5000);
});

check("a card without _startMs keeps its previous duration field", () => {
  const out = T.settleInterrupted([card({ _startMs: undefined, duration: 0 })]);
  assert.equal(out[0].status, "interrupted");
  assert.equal(out[0].duration, 0);
});

check("nothing running returns the same array (callers skip the notify)", () => {
  const msgs = [card({ status: "ok", isError: false }), { kind: "user", text: "hi" }];
  assert.equal(T.settleInterrupted(msgs), msgs);
});

check("non-tool messages are untouched and only running cards settle", () => {
  const ok = card({ _toolCallId: "t2", status: "ok", isError: false });
  const user = { kind: "user", text: "hi" };
  const out = T.settleInterrupted([user, ok, card()]);
  assert.equal(out[0], user);  // untouched entries keep their identity
  assert.equal(out[1], ok);
  assert.equal(out[2].status, "interrupted");
});

check("a card whose _startMs is in the future reads as zero, not negative", () => {
  const out = T.settleInterrupted([card({ _startMs: Date.now() + 60_000 })]);
  assert.equal(out[0].duration, 0);
});

// The invariant that makes the sweep safe to fire early (abort before the
// end frame): the interrupted card's entry in activeToolCards is kept, and
// a late tool_execution_end still finalizes with the real result.
check("a late tool_execution_end overwrites the interrupted verdict", () => {
  const ctx2 = vm.createContext({ console });
  ctx2.window = ctx2;
  for (const f of ["src/app/turn-status.js", "src/app/transcript-merge.js", "src/adapter.js"]) {
    vm.runInContext(readFileSync(join(root, f), "utf8"), ctx2, { filename: f });
  }
  const start = ctx2.window.buildToolStartCard({ toolName: "bash", toolCallId: "t1", args: { command: "ls" } }, "12:00");
  const swept = ctx2.OMP_TURN_STATUS.settleInterrupted([start]);
  assert.equal(swept[0].status, "interrupted");
  const done = ctx2.window.finalizeToolCard(swept[0], { toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(done.status, "ok");
  assert.equal(done.isError, false);
});

// ── abandonPendingCompaction ──────────────────────────────────────────────
check("a pending compact row fails; other statuses keep theirs", () => {
  const out = T.abandonPendingCompaction([
    { kind: "compact", status: "pending" },
    { kind: "compact", status: "done" },
    { kind: "compact", status: "error" },
    { kind: "user", text: "hi" },
  ]);
  assert.equal(out[0].status, "error");
  assert.equal(out[1].status, "done");
  assert.equal(out[2].status, "error");
  assert.deepEqual(out[3], { kind: "user", text: "hi" });
});

check("no pending compaction returns the same array", () => {
  const msgs = [{ kind: "compact", status: "done" }];
  assert.equal(T.abandonPendingCompaction(msgs), msgs);
});

// ── failureNote for a refused bare prompt ─────────────────────────────────
check("a refused bare prompt is labelled Prompt and carries the text", () => {
  const note = Q.failureNote("prompt", "session busy", "fix the login bug");
  assert.match(note, /^\*\*Prompt not sent:\*\* session busy/);
  assert.match(note, /fix the login bug/); // fenced (fenceCode's stub passes text through)
});

check("steer and follow-up labels are unchanged", () => {
  assert.match(Q.failureNote("steering", "x", null), /^\*\*Steer not sent:\*\* x/);
  assert.match(Q.failureNote("followUp", "x", null), /^\*\*Follow-up not sent:\*\* x/);
});

console.log(`test-dead-process: ${passed} checks passed`);
