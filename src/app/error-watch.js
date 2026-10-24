/* ═════════════════════════════════════════════════════════════════════
   app/error-watch.js — fault evidence collector for the reliability
   round (R6). A passive listener (window "error" + "unhandledrejection")
   that records what broke into a bounded ring buffer so the smoke suite
   (tests/smoke) and the CDP diagnostics can ask "what failed?" even when
   the UI itself is on fire.

   Contract (see also the error-boundary.jsx header):
   - install(opts?) -> uninstall(); opts { limit=40, onEvent }. Repeat
     installs are idempotent: the previous listeners come off first, so
     one native event is never double-recorded.
   - The buffer never grows unbounded: overflows drop the OLDEST entries
     (newest survive — what just broke matters more) and count them in
     `dropped()`. `clear()` empties the list but KEEPS the dropped count:
     dropped is a fact about the window's lifetime, not about the list's
     current contents; the smoke runner reads both after a fault storm.
   - Never preventDefault: the native console (devtools) still shows the
     full stack; this watcher is additive evidence, not a filter.
   - onEvent is best-effort: a throwing callback is swallowed with a
     console.warn — the observer must not become the next failure.
   Exposed as `window.OMP_ERRORS` per the IIFE rule for plain <script>.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Longest message kept in an entry. The list feeds crash cards and CDP
  // queries, not a log viewer — 300 chars is a summary, the full text
  // stays in devtools (we never preventDefault).
  const MAX_MESSAGE = 300;
  const DEFAULT_LIMIT = 40;
  // Ring state. `entries` is oldest→newest; `droppedCount` counts entries
  // evicted by overflow (and survives clear() — overflow already happened,
  // hiding it would fake a healthy window). install() RESETS the ring
  // (list, dropped, limit, onEvent): a re-install is a fresh app-init
  // cycle, and test rings with different limits never leak state.
  let entries = [];
  let droppedCount = 0;
  let limit = DEFAULT_LIMIT;
  let onEvent = null;
  let errorHandler = null;
  let rejectionHandler = null;

  /** message → ≤300 chars. String() first: message can be any object
   * (e.reason may be a plain value); String(null) is "null", matching
   * what the console prints for a null rejection. */
  function clipMessage(m) {
    const s = typeof m === "string" ? m : String(m);
    return s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE) : s;
  }

  /** "filename:line:col" for error events, only when the browser filled
   * them in (inline handlers and cross-origin scripts may not). */
  function sourceOf(e) {
    if (!e || typeof e.filename !== "string" || !e.filename) return undefined;
    const line = e.lineno != null ? e.lineno : "";
    const col = e.colno != null ? e.colno : "";
    return `${e.filename}:${line}:${col}`;
  }

  /** Append one entry; returns it. Handles ring overflow (evict oldest,
   * count the drop) and fires onEvent in a swallowed try. */
  function push(kind, message, source) {
    const entry = { t: Date.now(), kind, message: clipMessage(message) };
    if (source != null) entry.source = source;
    entries.push(entry);
    const overflow = entries.length - limit;
    if (overflow > 0) {
      entries.splice(0, overflow);
      droppedCount += overflow;
    }
    if (onEvent) {
      try {
        onEvent(entry);
      } catch (err) {
        console.warn("[error-watch] onEvent callback failed:", err);
      }
    }
    return entry;
  }

  /** window "error" listener. Sync script errors carry message +
   * filename:lineno:colno; resource errors (Event, no message) also count
   * but are summarised — a storm of them is exactly what the smoke run
   * should catch. */
  function onError(e) {
    // Resource load failure (img/script): the browser dispatches an
    // Event whose target is the element and whose message is empty —
    // detected by "no message at all" rather than instanceof checks, so
    // test stubs and cross-window events classify the same way.
    if (e && !e.error && (e.message == null || e.message === "") && (e.target?.src || e.target?.href)) {
      const url = e.target.src || e.target.href;
      push("error", `resource failed to load: ${url}`, sourceOf(e));
      return;
    }
    const message = (e && e.error && e.error.message) || (e && e.message) || "unknown error";
    push("error", message, sourceOf(e));
  }

  /** "unhandledrejection" listener. e.reason is an Error for throw-in-
   * promise, but any value can cross a promise boundary (reject(42),
   * reject(null)) — stringify, Errors take their .message. */
  function onRejection(e) {
    const reason = e && e.reason;
    let message;
    if (reason instanceof Error) message = reason.message;
    else if (typeof reason === "string") message = reason;
    else {
      try {
        message = reason === undefined ? "undefined" : JSON.stringify(reason);
      } catch {
        message = String(reason);
      }
    }
    push("rejection", message);
  }

  /** Manual record for callers that already hold the failure (the
   * error boundaries). Accepts an entry-like object; kind defaults to
   * "render", message required-ish (falls back to a placeholder so a
   * malformed record still leaves a trace). Returns the stored entry. */
  function record(entryLike) {
    if (!entryLike || typeof entryLike !== "object") {
      return push("render", "record called without an entry");
    }
    const kind = entryLike.kind || "render";
    const message = entryLike.message != null ? entryLike.message : "record called without a message";
    return push(kind, message, entryLike.source);
  }

  /** Install the listeners (idempotent: a prior install is uninstalled
   * first, so re-running app init can't stack duplicate handlers). */
  function install(opts) {
    uninstall();
    entries = [];
    droppedCount = 0;
    limit = DEFAULT_LIMIT;
    onEvent = null;
    if (opts && typeof opts === "object") {
      if (opts.limit != null) limit = opts.limit;
      if (typeof opts.onEvent === "function") onEvent = opts.onEvent;
    }
    errorHandler = onError;
    rejectionHandler = onRejection;
    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectionHandler);
    return uninstall;
  }

  /** Remove the listeners (no-op when not installed). List, dropped and
   * the counts survive: the evidence stays queryable after teardown. */
  function uninstall() {
    if (errorHandler) {
      window.removeEventListener("error", errorHandler);
      errorHandler = null;
    }
    if (rejectionHandler) {
      window.removeEventListener("unhandledrejection", rejectionHandler);
      rejectionHandler = null;
    }
  }

  const OMP_ERRORS = {
    install,
    uninstall,
    /** Copy of the buffer, oldest → newest. */
    list: () => entries.slice(),
    count: () => entries.length,
    dropped: () => droppedCount,
    /** Empties the list. Dropped count intentionally survives: overflow
     * already happened, hiding it would fake a healthy window. */
    clear: () => { entries = []; },
    record,
  };

  Object.assign(window, { OMP_ERRORS });
})();
