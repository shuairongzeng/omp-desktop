// Closed-tab stack behind Ctrl+Shift+T — the "reopen closed tab" gesture every
// desktop app has (Chrome, Firefox, VS Code). `live.js` pushes an entry on
// `_closeTab`; the keymap action pops the newest entry and reopens it.
//
// Exposes `window.OMP_CLOSED_TABS`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule"). Pure data structure:
// no DOM, no storage, no reads of other globals — an in-memory stack only,
// so a reload starts empty.
//
// Entry shape is `{ sessionFile, profile, path }`, all strings, with a
// non-empty `sessionFile` (the entry is useless without a session to reopen).
// Entries are stored as copies in both directions: mutating the object handed
// to `push` — or the object returned by `pop`/`peek` — must never reach into
// the stack. The stack is LIFO and capped at `CAP` entries; the oldest is
// evicted first, so the most recent 20 closes stay reopenable.
(function () {
  const CAP = 20;
  const stack = [];

  /** Extract the documented fields of a candidate entry, or null when it
   *  cannot be reopened. Non-string optional fields collapse to "" so a
   *  malformed push can never leave `undefined` in the stack. */
  function _snapshot(entry) {
    if (!entry || typeof entry !== "object") return null;
    const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : "";
    if (!sessionFile) return null;
    return {
      sessionFile,
      profile: typeof entry.profile === "string" ? entry.profile : "",
      path: typeof entry.path === "string" ? entry.path : "",
    };
  }

  /** Push a closed tab as the newest entry; the oldest is evicted past CAP.
   *  Returns false (and leaves the stack untouched) for a malformed entry. */
  function push(entry) {
    const copy = _snapshot(entry);
    if (!copy) return false;
    stack.push(copy);
    if (stack.length > CAP) stack.splice(0, stack.length - CAP);
    return true;
  }

  /** Remove and return the newest entry, or null when the stack is empty. */
  function pop() {
    const top = stack.pop();
    return top ? _snapshot(top) : null;
  }

  /** Return the newest entry without removing it, or null when empty. */
  function peek() {
    const top = stack[stack.length - 1];
    return top ? _snapshot(top) : null;
  }

  /** Number of entries currently reopenable. */
  function size() {
    return stack.length;
  }

  /** Forget every entry (e.g. the project windows they referred to are gone). */
  function clear() {
    stack.length = 0;
  }

  window.OMP_CLOSED_TABS = { push, pop, peek, size, clear, CAP };
})();