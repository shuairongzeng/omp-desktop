/* ═════════════════════════════════════════════════════════════════════
   app/use-terminal.jsx — per-tab terminal view for app-live.jsx.
   Rust owns each tab's shell (folder, program, lifetime, output ring);
   this hook renders it. One xterm `Terminal` per tab (built by
   app/terminal-xterm.js), kept in a Map ref and mounted into its panel's
   node (design/terminal-panel.jsx); an instance stays mounted until its
   tab goes. Panel state (open / created / Rust's status) is the pure
   reducer in app/terminal.js.

   Output sync: the decisions (instance adoption, seq dedupe, gap →
   replay, the queue while a replay runs, which writes are acked) are the
   pure stream reducer in app/terminal-stream.js; this hook runs its
   actions. It subscribes, waits until both listeners are registered, asks
   Rust for the status and replays the ring, so nothing emitted before the
   subscription is lost; replays run one after another on a per-tab
   promise chain.

   View policy stays here: the shell starts the first time a tab's panel
   is shown with no shell yet, at the fitted size; Enter in an exited
   (or failed) shell starts a new one; auto-open, height and focus (a
   panel hidden while it holds the focus hands it to the composer; on a
   touchscreen the panel never takes the focus on open — the software
   keyboard would cover the output the panel was opened to watch, and
   the composer's refocus guard bails the same way).

   Touch key row (design/terminal-panel.jsx's phone tier): the caps call
   `sendKey`, whose sequences go through `bridge.terminalWrite` — the
   same channel xterm's own keys end in — and the sticky Ctrl
   (`toggleCtrl`, per tab) rides the next key the terminal sends, a
   letter typed into it or an arrow cap, then disarms. `paste` reads the
   clipboard into the shell (the row's 粘贴 cap and the panel's
   right-click), via terminal-xterm.js's exported `paste`.
   ═════════════════════════════════════════════════════════════════════ */

const {
  EMPTY: _UT_EMPTY, openPanel: _UT_open, closePanel: _UT_close, togglePanel: _UT_toggle,
  applyStatus: _UT_applyStatus, applyExit: _UT_applyExit, spawnFailed: _UT_spawnFailed,
  needsSpawn: _UT_needsSpawn, shellLive: _UT_shellLive, canRestart: _UT_canRestart,
  noteActivity: _UT_noteActivity, clearDirty: _UT_clearDirty,
  entryOf: _UT_entryOf,
} = window.OMP_TERMINAL;
const { pruneEntries: _UT_pruneEntries } = window.OMP_SESSION_UI;
const {
  SKIPPED_LINE: _UT_SKIPPED, exitLine: _UT_exitLine, failLine: _UT_failLine, theme: _UT_theme,
  applyWindowsPty: _UT_applyWindowsPty, createXterm: _UT_createXterm, copySelection: _UT_copySelection, paste: _UT_paste,
  scrollbackLines: _UT_scrollbackLines, ensureXterm: _UT_ensureXterm,
} = window.OMP_TERMINAL_XTERM;
const {
  EMPTY: _UT_STREAM, beginSync: _UT_beginSync, onEvent: _UT_onEvent, replayCursor: _UT_replayCursor,
  onReplay: _UT_onReplay, endSync: _UT_endSync, onAttach: _UT_onAttach, onOpened: _UT_onOpened,
} = window.OMP_TERMINAL_STREAM;

const _UT_FONT_PX = 13;

function useTerminal({ bridge, activeSessionId, sessionIds, tweaks, setTweak }) {
  const [state, setState] = React.useState(_UT_EMPTY);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // Bumped when a tab's initial sync settles, so the spawn effect re-checks.
  const [syncTick, setSyncTick] = React.useState(0);
  // The active tab, read by the stream runner (a late render's closure
  // must not own it).
  const activeRef = React.useRef(activeSessionId);
  activeRef.current = activeSessionId;

  // sid → rec: { term, fit, mounted, disposed, subs, stream, sync, spawning,
  // opened, observer, fitTimer }. `stream` = the output sync record
  // (app/terminal-stream.js), `sync` = the promise chain its replays run
  // on; `opened` = the live instance the last `terminal_open` returned
  // (ahead of the rendered panel state until the next render).
  // sid → stable ref callback for the panel's mount node.
  const recs = React.useRef(new Map());
  const mountRefs = React.useRef(new Map());

  const fontSize = Math.round((_UT_FONT_PX * (tweaks.fontSize ?? 100)) / 100);
  // Read by `create`, whose ref callback outlives the render that made it.
  const fontSizeRef = React.useRef(fontSize);
  fontSizeRef.current = fontSize;
  const scrollback = _UT_scrollbackLines(tweaks.terminalScrollback);
  const scrollbackRef = React.useRef(scrollback);
  scrollbackRef.current = scrollback;
  const height = tweaks.terminalHeight;

  const fit = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (!rec?.mounted) return;
    try {
      rec.fit.fit();
      // Output written while the panel was hidden is parsed but not painted.
      rec.term.refresh(0, rec.term.rows - 1);
    } catch { /* hidden or detached: refit on reveal */ }
  }, []);

  /** Rust reported the tab's shell: panel state, and xterm's ConPTY mode. */
  const noteStatus = React.useCallback((sid, status) => {
    const rec = recs.current.get(sid);
    if (rec && !rec.disposed) _UT_applyWindowsPty(rec.term, status);
    setState((s) => _UT_applyStatus(s, sid, status));
  }, []);

  /** Ask Rust for the tab's status (a shell we have not been told about). */
  const refreshStatus = React.useCallback(async (sid) => {
    noteStatus(sid, await bridge.terminalStatus(sid));
  }, [bridge, noteStatus]);

  // Runs the stream reducer's actions (app/terminal-stream.js) for one tab.
  // `run` and `replay` reference each other (a replay's end runs queued
  // events, which may replay again): plain functions over refs, rebuilt
  // with `bridge`, reached through `ops.current` by long-lived callbacks.
  const ops = React.useRef(null);
  ops.current = React.useMemo(() => {
    /** Store the next stream record and perform its actions, in order.
     *  Output or an exit on a tab the user is not viewing marks it dirty
     *  (terminal.js `noteActivity`) — a dot on its project tab. */
    function run(sid, rec, { stream, actions }) {
      rec.stream = stream;
      const seen = { any: false };
      for (const a of actions) {
        if (a.type === "write") {
          seen.any = true;
          const { ack } = a;
          if (ack) rec.term.write(a.bytes, () => bridge.terminalAck(sid, ack.instance, ack.n));
          else rec.term.write(a.bytes);
        } else if (a.type === "skipped") {
          rec.term.write(_UT_SKIPPED);
        } else if (a.type === "exit") {
          seen.any = true;
          setState((s) => _UT_applyExit(s, sid, a.instance, a.code));
          if (_UT_entryOf(stateRef.current, sid).status?.instance !== a.instance) void refreshStatus(sid);
        } else if (a.type === "exitLine") {
          rec.term.write(_UT_exitLine(a.code));
        } else if (a.type === "status") {
          void refreshStatus(sid);
        } else if (a.type === "replay") {
          replay(sid, rec);
        }
      }
      if (seen.any) setState((s) => _UT_noteActivity(s, sid, sid === activeRef.current && _UT_entryOf(s, sid).open));
    }

    /** Chain `step` (async; already counted by `beginSync`) on the rec's
     *  sync chain; its end runs the events queued meanwhile. */
    function chain(sid, rec, step) {
      rec.sync = rec.sync
        .then(() => (rec.disposed ? undefined : step()))
        .catch((err) => console.error("[terminal] sync failed:", err))
        .finally(() => { if (!rec.disposed) run(sid, rec, _UT_endSync(rec.stream)); });
    }

    /** Rust's held output after the stream's `lastSeq` (written unacked). */
    function replay(sid, rec) {
      chain(sid, rec, async () => {
        const { instance, afterSeq } = _UT_replayCursor(rec.stream);
        const r = await bridge.terminalReplay(sid, instance, afterSeq);
        if (!rec.disposed) run(sid, rec, _UT_onReplay(rec.stream, afterSeq, r));
      });
    }

    const handle = (sid, rec, ev) => { if (!rec.disposed) run(sid, rec, _UT_onEvent(rec.stream, ev)); };

    /** First sync of a new xterm: listeners first, then status, then replay. */
    function attach(sid, rec) {
      const data = bridge.onTerminalData(sid, (p) => handle(sid, rec, { kind: "data", ...p }));
      const exit = bridge.onTerminalExit(sid, (p) => handle(sid, rec, { kind: "exit", ...p }));
      rec.subs = [data, exit];
      rec.stream = _UT_beginSync(rec.stream);
      chain(sid, rec, async () => {
        await Promise.all([data.ready, exit.ready]);
        if (rec.disposed) return;
        const status = await bridge.terminalStatus(sid);
        if (rec.disposed) return;
        noteStatus(sid, status);
        const r = status ? await bridge.terminalReplay(sid, status.instance, 0) : null;
        if (!rec.disposed) run(sid, rec, _UT_onAttach(rec.stream, status, r));
      });
      rec.sync = rec.sync.finally(() => { if (!rec.disposed) setSyncTick((n) => n + 1); });
    }

    /** Start the tab's shell (Rust returns a live one as is), then fetch
     *  whatever it printed before the reply. */
    async function spawn(sid) {
      const rec = recs.current.get(sid);
      if (!rec || rec.spawning || rec.disposed) return;
      rec.spawning = true;
      // A resize while the open is in flight is not sent (no live shell):
      // compared with the size the shell starts at once the reply is in.
      const { cols, rows } = rec.term;
      const res = await bridge.terminalOpen(sid, cols, rows);
      rec.spawning = false;
      if (rec.disposed) return;
      if (!res.ok) {
        // Shown as an exited shell: Enter tries again.
        rec.term.write(_UT_failLine(res.error));
        setState((s) => _UT_spawnFailed(s, sid, res.error));
        return;
      }
      const { status } = res;
      if (status.state !== "exited") {
        rec.opened = Math.max(rec.opened, status.instance);
        if (rec.term.cols !== cols || rec.term.rows !== rows) {
          bridge.terminalResize(sid, rec.term.cols, rec.term.rows);
        }
      }
      noteStatus(sid, status);
      run(sid, rec, _UT_onOpened(rec.stream, status));
    }

    return { attach, spawn };
  }, [bridge, noteStatus, refreshStatus]);

  const spawn = React.useCallback((sid) => ops.current.spawn(sid), []);

  const respawn = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (!rec || rec.spawning) return;
    rec.term.reset();
    spawn(sid);
  }, [spawn]);

  // Builds the tab's xterm once the vendored xterm.js is on the page
  // (ensureXterm injects it on first use; index.html still loads it
  // eagerly, so the await is normally a microtask). A second call for a
  // tab whose xterm landed meanwhile (or went with its tab) is a no-op.
  const create = React.useCallback(async (sid) => {
    const xterm = recs.current.get(sid);
    if (xterm) return xterm;
    await _UT_ensureXterm();
    const existing = recs.current.get(sid);
    if (existing) return existing;
    // `rec` (declared below) exists by the time any of these callbacks runs.
    const { term, fit: fitAddon } = _UT_createXterm({
      fontSize: fontSizeRef.current,
      scrollback: scrollbackRef.current,
      theme: _UT_theme(),
      tryRestart: () => {
        if (!_UT_canRestart(_UT_entryOf(stateRef.current, sid), rec.opened)) return false;
        respawn(sid);
        return true;
      },
      // Every key xterm sends reaches Rust through this one callback, so
      // the sticky Ctrl (a touch key row cap) hooks the same place: one
      // path defines what "typed into this terminal" means. `rewriteKeyRef`
      // exists (see below) by the time xterm can fire onData.
      onData: (data) => bridge.terminalWrite(sid, rewriteKeyRef.current(sid, data)),
      // Only a live shell has a pty to resize; the size a shell starts at is
      // the one `spawn` sends (and corrects once the reply is in).
      onResize: ({ cols, rows }) => {
        if (_UT_shellLive(_UT_entryOf(stateRef.current, sid), rec.opened)) bridge.terminalResize(sid, cols, rows);
      },
    });
    const rec = {
      term, fit: fitAddon, mounted: false, disposed: false, subs: [],
      stream: _UT_STREAM, sync: Promise.resolve(), spawning: false, opened: 0, observer: null, fitTimer: 0,
    };
    recs.current.set(sid, rec);
    ops.current.attach(sid, rec);
    return rec;
  }, [bridge, respawn]);

  const dispose = React.useCallback((sid) => {
    const rec = recs.current.get(sid);
    if (rec) {
      rec.disposed = true;
      for (const sub of rec.subs) sub.stop();
      rec.observer?.disconnect();
      clearTimeout(rec.fitTimer);
      rec.term.dispose();
    }
    recs.current.delete(sid);
    mountRefs.current.delete(sid);
  }, []);

  // The panel's mount node: the first time it appears the tab's xterm opens
  // into it. (The shell itself is spawned by the effect below, once visible.)
  const mountFor = React.useCallback((sid) => {
    if (!mountRefs.current.has(sid)) {
      mountRefs.current.set(sid, (node) => {
        if (!node || !bridge) return;
        // create() awaits the vendored xterm.js (normally already loaded);
        // by the time it lands, a re-render may have unmounted the node or
        // closed the tab — both leave the node alone.
        void Promise.resolve(create(sid)).then((rec) => {
          if (!rec || rec.disposed || !node.isConnected) return;
          if (rec.mounted) return;
          rec.term.open(node);
          rec.mounted = true;
          // Layout changes that resize the body without a window resize
          // (sidebar, tree, subagent pane) still refit. A hidden panel reports
          // 0×0: nothing to fit, the reveal observes the real size.
          rec.observer = new ResizeObserver((entries) => {
            const { width, height: h } = entries[entries.length - 1].contentRect;
            if (width === 0 || h === 0) return;
            clearTimeout(rec.fitTimer);
            // Past the panel's height transition (140ms, terminal.css): a
            // mid-transition fit locks the transition's size in.
            rec.fitTimer = setTimeout(() => fit(sid), 160);
          });
          rec.observer.observe(node);
        });
      });
    }
    return mountRefs.current.get(sid);
  }, [bridge, create, fit]);

  /** Right-click on a selection copies it; true when it did (no menu then). */
  const copySelection = React.useCallback((sid) => {
    const term = recs.current.get(sid)?.term;
    return term ? _UT_copySelection(term) : false;
  }, []);
  /** The clipboard into the shell: terminal-panel.jsx's right-click (no
   *  selection) and the phone tier's 粘贴 cap. Goes through
   *  terminal-xterm.js's `paste` (xterm normalises the line endings and
   *  brackets the text when the running program turned bracketed paste
   *  on; a read failure is logged, not thrown). */
  const paste = React.useCallback((sid) => {
    const term = recs.current.get(sid)?.term;
    if (term) _UT_paste(term);
  }, []);

  // ── Phone tier: the touch key row (design/terminal-panel.jsx) ────────
  // Sticky Ctrl per tab: set by the row's cap, shown lit in the panel
  // head, riding the next key that terminal sends (the row's own caps or
  // a letter typed into xterm), then disarming itself. A switch to
  // another tab disarms its panel — a cap "armed" twice panels away
  // would be a trap.
  const [ctrlTabs, setCtrlTabs] = React.useState({});
  const ctrlTabsRef = React.useRef(ctrlTabs);
  ctrlTabsRef.current = ctrlTabs;
  /** The sticky-ctrl transform of one key `data` (xterm's exact bytes for
   *  it): a single-char key from an armed tab is rewritten to its ctrl
   *  sequence, the tab's arm clearing with the key it rode. Everything
   *  else — control codes, ESC sequences, IME text, a multi-char paste
   *  through xterm — passes through untouched, and the arm survives only
   *  for a key it could have ridden. */
  const rewriteKey = React.useCallback((sid, data) => {
    if (data.length !== 1 || !ctrlTabsRef.current[sid]) return data;
    const code = data.toUpperCase().charCodeAt(0);
    const seq = code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
    setCtrlTabs((s) => (seq != null ? { ...s, [sid]: false } : s));
    return seq ?? data;
  }, []);
  const rewriteKeyRef = React.useRef(rewriteKey);
  rewriteKeyRef.current = rewriteKey;
  /** The touch key row's writer: a cap's exact bytes to the tab's shell,
   *  through the same bridge channel xterm's own keys end in. The
   *  sticky-ctrl transform applies first (a cap is "the next key" when
   *  the arm is on), so an armed Ctrl plus the ↓ cap sends ctrl+↓, not
   *  a bare ↓. */
  const sendKey = React.useCallback((sid, data) => {
    bridge.terminalWrite(sid, rewriteKey(sid, data));
  }, [bridge, rewriteKey]);
  /** Toggle the tab's sticky-ctrl arm; returns nothing (the panel reads
   *  the lit state through `ctrlTabs`, re-rendered by setState). */
  const toggleCtrl = React.useCallback((sid) => {
    setCtrlTabs((s) => (s[sid] ? { ...s, [sid]: false } : { ...s, [sid]: true }));
  }, []);
  const focus = React.useCallback((sid) => recs.current.get(sid)?.term.focus(), []);
  // Hiding a panel that holds the focus (xterm's textarea, the close
  // button) would drop it on <body>, where keys reach nothing: the
  // composer's prompt box takes it instead.
  const releaseFocus = React.useCallback((sid) => {
    const panel = recs.current.get(sid)?.term.element?.closest(".term-panel");
    if (!panel?.contains(document.activeElement)) return;
    document.querySelector(".composer-input textarea")?.focus();
  }, []);
  const toggle = React.useCallback((sid) => {
    if (!sid) return;
    if (_UT_entryOf(stateRef.current, sid).open) releaseFocus(sid);
    setState((s) => _UT_toggle(s, sid));
  }, [releaseFocus]);
  const close = React.useCallback((sid) => {
    releaseFocus(sid);
    setState((s) => _UT_close(s, sid));
  }, [releaseFocus]);
  const setHeight = React.useCallback((px) => setTweak("terminalHeight", px), [setTweak]);

  // A visible panel: size the xterm to it, start the shell of a tab that has
  // none (once its initial sync settled), and focus the terminal that was
  // just opened. Runs on every open/close, tab switch, height change and
  // settled sync. Becoming visible clears the tab's dirty mark. The deps
  // pin the ACTIVE tab's entry, not the whole panel-state map: a background
  // tab's state change must not refit (and repaint) the terminal the user
  // is looking at.
  const prevOpen = React.useRef(null);
  // The tab the effect last saw active: the "left tab" whose sticky Ctrl
  // arm clears when the user switches away (see below).
  const prevActive = React.useRef(null);
  const activeEntry = _UT_entryOf(state, activeSessionId);
  React.useEffect(() => {
    const entry = activeEntry;
    const rec = recs.current.get(activeSessionId);
    if (entry.open && rec?.mounted) {
      setState((s) => _UT_clearDirty(s, activeSessionId));
      fit(activeSessionId);
      if (_UT_needsSpawn(entry) && rec.stream.syncing === 0) spawn(activeSessionId);
      // Focus the terminal that just became the shown one — but not while
      // Settings covers the stage: the host's `hidden` attribute is the
      // exact "Settings is showing" test (the composer's refocus guard
      // reads it the same way). The page owns focus then; xterm grabbing
      // it would leave the page's keys — Enter on its buttons, its search
      // — typing into a terminal the user cannot see. And not on a
      // touchscreen: an opened panel popping the software keyboard over
      // the output it was opened to watch is the one thing no terminal
      // user wants (composer.jsx's refocus guard bails the same way); the
      // panel keeps the focus, focus arrives when they tap the body.
      if (prevOpen.current !== activeSessionId
        && !window.OMP_MOBILE?.isTouch?.()
        && !document.querySelector(".st-host:not([hidden])")) {
        focus(activeSessionId);
      }
      // Leaving a tab whose sticky Ctrl was armed disarms it (the glow
      // belongs to the panel being typed into, not one two tabs away);
      // the update runs whatever the new tab's panel state, so a switch
      // to a tab with no terminal yet still disarms the left one.
    }
    if (prevActive.current && prevActive.current !== activeSessionId
      && ctrlTabsRef.current[prevActive.current]) {
      const left = prevActive.current;
      setCtrlTabs((s) => (s[left] ? { ...s, [left]: false } : s));
    }
    prevActive.current = activeSessionId;
    prevOpen.current = entry.open ? activeSessionId : null;
  }, [activeEntry, activeSessionId, height, syncTick, fit, spawn, focus]);

  // Tab list changes: drop the panel state and the instance of closed tabs
  // (`closeSession` in live.js already had Rust end the tab and its shell),
  // and open the panel of a new tab when "open with new tab" is on. A tab
  // restored at launch counts as new; its shell starts once it is active.
  const seen = React.useRef(new Set());
  const idsKey = sessionIds.join("\0");
  React.useEffect(() => {
    const fresh = sessionIds.filter((sid) => !seen.current.has(sid));
    seen.current = new Set(sessionIds);
    setState((s) => {
      let next = _UT_pruneEntries(s, sessionIds);
      if (tweaks.terminalAutoOpen) for (const sid of fresh) next = _UT_open(next, sid);
      return next;
    });
    for (const sid of [...recs.current.keys()]) if (!sessionIds.includes(sid)) dispose(sid);
  }, [idsKey, dispose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme, font and scrollback follow the tweaks for every instance.
  React.useEffect(() => {
    for (const [sid, rec] of recs.current) {
      rec.term.options.theme = _UT_theme();
      rec.term.options.fontSize = fontSize;
      if (rec.term.options.scrollback !== scrollback) rec.term.options.scrollback = scrollback;
      fit(sid);
    }
  }, [tweaks.theme, tweaks.accent, fontSize, scrollback, fit]);

  // Per-tab dirty marks (output or an exit while not viewed): chrome.jsx's
  // project tab dot reads this — the integrator wires it there.
  const dirtyTabs = React.useMemo(() => {
    const out = {};
    for (const sid of Object.keys(state)) if (state[sid].dirty) out[sid] = true;
    return out;
  }, [state]);
  // `sendKey` (per-key, with the sticky-ctrl rewrite), `ctrlTabs` (which
  // panels' Ctrl caps are lit) and `toggleCtrl` arm/disarm them — the
  // phone tier's touch key row (design/terminal-panel.jsx) calls these.
  return {
    state, height, toggle, close, setHeight, mountFor, copySelection, paste, respawn, dirtyTabs,
    sendKey, ctrlTabs, toggleCtrl,
  };
}

Object.assign(window, { useTerminal });
