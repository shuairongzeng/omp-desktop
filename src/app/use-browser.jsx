/* app/use-browser.jsx — the browser panel's state (docs/architecture/browser.md).
   Rust owns Chromium, the screencast and the annotation
   overlay (src-tauri/src/browser/); this hook mirrors what the open tab's
   panel channel reports (one Tauri Channel per `browserOpenPanel`: state,
   tabs, picks, frames), keeps the annotation chips and routes
   localhost chat links (`onChatClick`, the markdown containers' delegated
   click). Whether the active tab shows the panel is app-live.jsx's per-tab
   side column (`open` / `setOpen`). Painting and input forwarding are
   app/browser-screen.js, the pure decisions app/browser.js. The panel
   element must stay mounted while `open` (the effect binds the
   `viewRef`/`canvasRef`/`sinkRef` elements of the commit that opened it).
   A navigation that fails restarts the panel's screencast and retries once
   (`navigate`), its error surfacing as `navError` for the toolbar. The
   comment popover is controlled (`noteDraft` / `pendingDraft`): its text
   is stashed as it is typed, so no dismissal path can lose it. */

const { OMP_BROWSER: _UB, OMP_BROWSER_SCREEN: _UBS } = window;
const _UB_IDLE = Object.freeze({ status: "idle", error: null, url: "", loading: false, canBack: false, canForward: false, annotate: false });
const _UB_NO_TABS = Object.freeze([]);
const _UB_LOG_EVERY_MS = 60_000;
let _ubChipSeq = 0;

function useBrowser({ bridge, activeSessionId, sessionIds, open: shown, setOpen, tweaks, setTweak }) {
  const sid = activeSessionId || null;
  // precedent:ignore — hook state declarations, alike in every component
  const [fullView, setFullView] = React.useState(false);
  const [state, setState] = React.useState(_UB_IDLE);
  const [tabs, setTabs] = React.useState(_UB_NO_TABS);
  const [page, setPage] = React.useState(null); // { cssW, cssH } of the shown page
  const [annotate, setAnnotateState] = React.useState(false);
  const [pendingAny, setPending] = React.useState(null); // { sid, pick, image }
  const [chips, setChips] = React.useState(_UB.EMPTY); // sid → chip[]
  const canvasRef = React.useRef(null);
  const viewRef = React.useRef(null);
  const sinkRef = React.useRef(null);
  const screenRef = React.useRef(null);
  const onMessageRef = React.useRef(null); // the open panel's channel handler (restart reopens with it)
  const open = Boolean(sid && shown);
  const pending = pendingAny && pendingAny.sid === sid ? pendingAny : null;
  const wantUrl = React.useRef(null); // { sid, url } to navigate to once the panel is open
  // The active effect's open token; pending resizes stay local to that run.
  // A stale open completion must not release a newer run's queued work.
  const openInFlight = React.useRef(null);
  // What the key handlers (bound once per open) must see current.
  const latest = React.useRef({});
  latest.current = { annotate, pending, fullView };
  // Comment drafts of picks that were left (a new pick, a tab switch,
  // a restart): sid → pick key → text, restored on the same element.
  const [draftsAny, setDrafts] = React.useState(_UB.EMPTY);
  // Bumped whenever annotate is left, so a capture that settles after the
  // pick has been dismissed (Esc / annotate off / restart) is dropped.
  const pickGen = React.useRef(0);

  // A closed tab drops its chips, pick and comment drafts.
  const idsKey = (sessionIds ?? []).join("\0");
  React.useEffect(() => {
    const ids = idsKey ? idsKey.split("\0") : [];
    setChips((s) => window.OMP_SESSION_UI.pruneEntries(s, ids));
    setPending((p) => (p && ids.includes(p.sid) ? p : null));
    setDrafts((s) => window.OMP_SESSION_UI.pruneEntries(s, ids));
  }, [idsKey]);
  // Leaving the panel leaves full view.
  React.useEffect(() => { if (!open) setFullView(false); }, [open]);

  // Annotate mode as shown; Rust's `state.annotate` is the truth and
  // overrides it (it also turns off when the agent acts on the page).
  // Leaving it ends the pick: its popover closes, and a pick made before
  // must not land (`pickGen`).
  const showAnnotate = React.useCallback((on) => {
    if (!on) {
      pickGen.current += 1;
      setPending(null);
    }
    setAnnotateState(on);
  }, []);
  const setAnnotate = React.useCallback((on) => {
    if (!sid) return;
    showAnnotate(on);
    bridge?.browserAnnotate(sid, on);
  }, [bridge, sid, showAnnotate]);

  // The open tab's panel: open it with the handler of its channel (the
  // backend's first `state` message arrives during the open). Leaving
  // (close, another tab) stops the screencast; Chromium stays.
  React.useEffect(() => {
    const view = viewRef.current;
    const canvas = canvasRef.current;
    const sink = sinkRef.current;
    if (!bridge || !sid || !open || !view || !canvas || !sink) return undefined;
    let live = true;
    // While `browserOpenPanel` settles the view is not live: a resize is
    // queued here (latest wins) and a URL by `wantUrl`, both flushed once
    // the open resolves.
    const opening = { pending: true };
    openInFlight.current = opening;
    let pendingSize = null;
    setState(_UB_IDLE);
    setTabs(_UB_NO_TABS);
    setPage(null);
    // The backend refuses input while no page is shown: logged at most once
    // a minute per open.
    let loggedAt = -Infinity;
    const send = (ev) => bridge.browserInput(sid, ev).then((r) => {
      const now = Date.now();
      if (r.ok || now - loggedAt < _UB_LOG_EVERY_MS) return;
      loggedAt = now;
      console.error("[browser] input refused:", r.error);
    });
    const screen = _UBS.createScreen({
      view, canvas, sink, send,
      ack: (seq) => bridge.browserFrameAck(sid, seq),
      // The Settings page over the stage hides the panel: drop its frames
      // (dropped = acked) until it leaves. Read from the DOM per frame:
      // app-live.jsx's render region is shared, and this is one
      // querySelector on the way to a JPEG decode it skips.
      covered: () => Boolean(window.document?.querySelector?.(".st-host:not([hidden])")),
      onResize: (w, h, dpr) => {
        if (opening.pending) pendingSize = { w, h, dpr };
        else bridge.browserResize(sid, w, h, dpr);
      },
      onPage: setPage,
      // Esc while annotating closes the comment popover, else leaves annotate,
      // else full view (OMP_BROWSER.escapeAction).
      escape: () => _UB.escapeAction(latest.current.annotate, latest.current.pending, latest.current.fullView),
      onEscape: (action) => {
        if (action === "cancelPick") setPending(null);
        else if (action === "leaveAnnotate") setAnnotate(false);
        else if (action === "leaveFullView") setFullView(false);
      },
    });
    screenRef.current = screen;
    // A pick stands only if annotate was not left before its capture
    // settled (`pickGen`). A failed capture still opens the popover:
    // `image: null` keeps the text flowing, the popover notes the failure.
    const onPick = async (pick) => {
      const gen = pickGen.current;
      const r = await bridge.browserCapture(sid, pick.docRect);
      const shot = r.ok ? { type: "image", data: r.value.data, mimeType: r.value.mimeType } : null;
      const image = shot && (await window.OMP_IMAGES.normalizeImage(shot).catch(() => null));
      if (!live || gen !== pickGen.current) return;
      setPending({ sid, pick, image });
    };
    const onState = (s) => {
      setState(s);
      const on = Boolean(s?.annotate);
      if (on !== latest.current.annotate) showAnnotate(on);
    };
    // Messages of a channel this effect no longer owns (the panel closed or
    // moved to another tab) are dropped. A pick's promise settles once its
    // capture did.
    const onMessage = (m) => {
      if (!live) return undefined;
      if (m instanceof ArrayBuffer) return screen.frame(m);
      if (m?.type === "state") return onState(m.value);
      if (m?.type === "tabs") return setTabs(m.value ?? _UB_NO_TABS);
      if (m?.type === "pick") return onPick(m.value);
      return undefined;
    };
    onMessageRef.current = onMessage;
    (async () => {
      const s = screen.size();
      try {
        await bridge.browserOpenPanel(sid, s.width, s.height, s.dpr, onMessage);
      } finally {
        opening.pending = false;
      }
      if (!live) return;
      // Live now: the latest queued resize, then the latest queued URL (a
      // `/browser <url>` or localhost link asked for while Chromium started).
      if (pendingSize) bridge.browserResize(sid, pendingSize.w, pendingSize.h, pendingSize.dpr);
      const want = wantUrl.current;
      if (want?.sid === sid) {
        wantUrl.current = null;
        bridge.browserNavigate(sid, want.url);
      }
    })();
    return () => {
      live = false;
      if (openInFlight.current === opening) openInFlight.current = null;
      screen.destroy();
      screenRef.current = null;
      onMessageRef.current = null;
      bridge.browserClosePanel(sid);
      showAnnotate(false);
    };
  }, [bridge, sid, open, setAnnotate, showAnnotate]);

  const close = React.useCallback(() => setOpen(false), [setOpen]);

  // A plain click on a localhost link in the chat opens it here (when the
  // tweak is on); a modifier click opens it in the system browser through
  // the external opener — wry has no `on_new_window` handler, so the native
  // new-window behaviour would open nothing. `onChatClick` is the markdown
  // containers' delegated click (MarkdownLinkContext, ui/markdown.jsx):
  // null while the tweak is off or no tab is open, stable otherwise, so the
  // chat does not re-render as the panel changes.
  const localLinks = (tweaks?.browserLocalhostInPanel ?? true) && Boolean(sid);
  const openLink = React.useRef(null);
  openLink.current = (url, external) => {
    if (!external) return openUrl(url);
    Promise.resolve(bridge?.openExternalUrl(url)).then(
      (res) => { if (res && !res.ok) console.error("[browser] open failed:", res.error); },
      (err) => console.error("[browser] open failed:", err),
    );
  };
  const onChatClick = React.useMemo(() => (localLinks ? (e) => {
    const link = _UB.linkClick(e);
    if (!link) return;
    e.preventDefault();
    openLink.current(link.url, link.external);
  } : null), [localLinks]);

  // A pick left unsubmitted keeps its comment as a draft, stored per tab
  // under the element's key (OMP_BROWSER.pickKey): picked again — this tab,
  // another one, after a restart — the text comes back. Saving drops it.
  // The popover's comment field is controlled (browser-panel.jsx): its
  // onChange is `ui.noteDraft`, and the text is stashed as it is typed, so
  // every path that dismisses the pick — the popover's own Esc / cancel,
  // the panel's Esc (`onEscape("cancelPick")`), a new pick replacing it,
  // annotate off (by hand, by Rust, on leaving the panel or switching
  // tabs), a restart, closing the panel — leaves the draft on the element,
  // and picking it again restores it (`pendingDraft`). A cleared field
  // spends it.
  const noteDraft = (text) => {
    if (!pending) return;
    const key = _UB.pickKey(pending.pick);
    setDrafts((s) => {
      const tab = window.OMP_SESSION_UI.entryOf(s, pending.sid, _UB.EMPTY);
      if (text) return tab[key] === text ? s : { ...s, [pending.sid]: { ...tab, [key]: text } };
      if (!(key in tab)) return s;
      const { [key]: _cleared, ...rest } = tab;
      const next = { ...s };
      if (Object.keys(rest).length) next[pending.sid] = rest;
      else delete next[pending.sid];
      return next;
    });
  };
  const savePending = React.useCallback((comment) => {
    const text = comment.trim();
    if (!pending || !text) return;
    const chip = { id: `bc${++_ubChipSeq}`, pick: pending.pick, comment: text, image: pending.image };
    setChips((s) => _UB.addChip(s, pending.sid, chip));
    // Saved: the draft of this element is spent.
    const key = _UB.pickKey(pending.pick);
    setDrafts((s) => {
      const tab = window.OMP_SESSION_UI.entryOf(s, pending.sid, _UB.EMPTY);
      if (!(key in tab)) return s;
      const { [key]: _used, ...rest } = tab;
      const next = { ...s };
      if (Object.keys(rest).length) next[pending.sid] = rest;
      else delete next[pending.sid];
      return next;
    });
    setPending(null);
  }, [pending, sessionIds]);
  // The draft is already stashed as it was typed (`noteDraft`): every
  // dismissal path just closes the popover.
  const cancelPending = React.useCallback(() => setPending(null), []);
  // A submit takes its chips with the rest of the draft (`takeChips`: those
  // ids only, chips added since stay); a goal start that fails hands them
  // back with the draft (`restoreChips`). `id` defaults to the tab shown.
  const chipActions = React.useMemo(() => ({
    removeChip: (id) => setChips((s) => _UB.removeChip(s, sid, id)),
    takeChips: (ids, id = sid) => setChips((s) => _UB.removeChips(s, id, ids)),
    restoreChips: (list, id = sid) => setChips((s) => _UB.restoreChips(s, id, list)),
  }), [sid]);
  // Page actions on the open tab. A navigate that fails (bridge fault, a
  // browser gone) restarts the panel's screencast once and retries; if it
  // still fails the toolbar shows the error (`navError`) instead of doing
  // nothing behind an unchanged address bar.
  const [navError, setNavError] = React.useState(null);
  const act = React.useMemo(() => ({
    navigate: async (url) => {
      if (!bridge) return;
      let r = await bridge.browserNavigate(sid, url);
      if (r?.ok) { setNavError(null); return; }
      act.restart();
      r = await bridge.browserNavigate(sid, url);
      if (r?.ok) { setNavError(null); return; }
      setNavError(r?.error ?? "navigation failed");
    },
    history: (delta) => bridge?.browserHistory(sid, delta),
    newTab: () => bridge?.browserTabNew(sid),
    closeTab: (id) => bridge?.browserTabClose(sid, id),
    activateTab: (id) => bridge?.browserTabActivate(sid, id),
    // After a crash the screencast is gone: open the panel again.
    restart: () => {
      showAnnotate(false);
      setPending(null);
      setNavError(null);
      const s = screenRef.current?.size();
      if (s) bridge?.browserOpenPanel(sid, s.width, s.height, s.dpr, onMessageRef.current);
    },
  }), [bridge, sid, showAnnotate]);

  // Show `url` (already normalised) in the panel, opening it first if needed.
  // While `browserOpenPanel` is still in flight the backend has no view to
  // navigate yet, so the URL is queued (latest wins) and the open flushes it.
  // Live navigations go through `act.navigate` (restart + retry on a fault).
  const openUrl = React.useCallback((url) => {
    if (!sid) return;
    if (open && !openInFlight.current?.pending) {
      void act.navigate(url);
      return;
    }
    wantUrl.current = { sid, url };
    if (!open) setOpen(true);
  }, [bridge, sid, open, setOpen, act]);

  return {
    open, close, openUrl, onChatClick, fullView, setFullView,
    width: tweaks?.browserWidth ?? 0, // px; 0 = default (half the stage) — see OMP_BROWSER.clampWidth
    setWidth: (px) => setTweak("browserWidth", Math.round(px)),
    state, tabs, page, annotate, setAnnotate, navError,
    // The popover's text is controlled: `noteDraft(text)` stashes it as it
    // is typed, `pendingDraft` is what a reopened popover starts from (the
    // same drafts map, so both read the same truth).
    pendingDraft: pending
      ? window.OMP_SESSION_UI.entryOf(draftsAny, pending.sid, _UB.EMPTY)[_UB.pickKey(pending.pick)] ?? ""
      : "",
    noteDraft,
    pending, savePending, cancelPending,
    chips: _UB.chipsOf(chips, sid),
    ...chipActions, canvasRef, viewRef, sinkRef, ...act,
  };
}

window.useBrowser = useBrowser;
