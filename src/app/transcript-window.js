/* app/transcript-window.js — the phone's windowed transcript channel.
   The remote (phone) client fetches get_messages in windows instead of
   in one shot: a full transcript reaches hundreds of MB over a 3 Mbit/s
   uplink, so shipping all of it to the handset would spend minutes of
   radio time on data nobody scrolls to. The desktop path stays
   unwindowed — this module exists only for the phone branch, and it is
   pure so both live.js and its tests can share the exact arithmetic.
   Exposed as `window.OMP_TRANSCRIPT_WINDOW` (the late-bound `window.X`
   convention): live.js reads it at call time, never destructures it at
   module load.
     - sliceWindow(all, before, limit):
         `all`    every message row, oldest first, exactly as
                  get_messages returns them;
         `before` the cursor the caller already holds — the absolute
                  start index of the window it delivered — or null /
                  undefined to ask for the newest window;
         `limit`  the window size.
       Returns `{ messages, hasOlder, nextBefore }` where `nextBefore`
       is the cursor to pass back for the next-older window.
   Cursors are absolute indices from the head, not offsets from the
   tail: an append at the tail never shifts an outstanding cursor, so a
   window the user is paging through stays put while the agent streams.
   A cursor past the end (the reply shrank under a trim) clamps to the
   end rather than throwing. */
(function () {
  "use strict";

  /** One window of the transcript. See the file header for the
   *  contract; `all` is never mutated (slice copies), and the degenerate
   *  inputs — a non-array reply, a limit below one — answer an empty
   *  window at the head instead of throwing, so a bad reply degrades to
   *  "no older messages" rather than a dead channel. */
  function sliceWindow(all, before, limit) {
    if (!Array.isArray(all) || !(limit >= 1)) {
      return { messages: [], hasOlder: false, nextBefore: 0 };
    }
    const size = Math.floor(limit);
    // A numeric cursor asks for the window ending before it; a stale one
    // (past the end after a trim) clamps to the end. No cursor means the
    // newest window, anchored to the tail.
    const end = typeof before === "number" && Number.isFinite(before)
      ? Math.min(Math.floor(before), all.length)
      : all.length;
    const start = Math.max(0, end - size);
    return {
      messages: all.slice(start, end),
      hasOlder: start > 0,
      nextBefore: start,
    };
  }

  window.OMP_TRANSCRIPT_WINDOW = Object.freeze({ sliceWindow });
})();