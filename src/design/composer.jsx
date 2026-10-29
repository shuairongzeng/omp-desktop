/* ═════════════════════════════════════════════════════════════════════
   composer.jsx — input area + slash palette + ⌘K command bridge
   ═════════════════════════════════════════════════════════════════════ */

const { Icon } = window;
/* Phone-side helpers (app/mobile.js): read through `window.OMP_MOBILE`
 * at render time, never destructured at top level — the module loads
 * before this file, but the late-bound read keeps the dependency visible
 * where it is used. Null-safe: a window without it (an old cached
 * index.html) simply takes the desktop branch. */
const _cmpMobile = () => window.OMP_MOBILE;
// The phone's "＋" action panel rows, built once: labels/sub-labels are
// app-convention english, lowercase, no terminal punctuation. Icons are
// the shared Icon set; the terminal/usage/git rows fire the omp:mobile
// CustomEvent the app root (app-live.jsx) listens for — the composer
// never owns those panels.
const _CMP_SHEET_MS = 3000; // inline sheet notice, self-dismissing
// The ＋ panel's prompt-history sub-list: how many recent prompts it
// shows when the "prompt history" row drills in (newest first — the list
// itself is handed in already newest-first).
const _CMP_SHEET_HISTORY = 20;
const { parseMentionQuery, applyMention } = window.OMP_MENTIONS;
const { prepareImage, carriesFiles, dropHoverAfter, imageFilesFromTransfer, imageFilesFromClipboardAsync, toDataUrl, MAX_ATTACHMENTS } = window.OMP_IMAGES;
// How long the "attaching image…" chip on the input's top right lingers
// before fading itself out: a short beat, just enough to explain the
// swallowed Enter while a paste/pick is still preparing.
const _CMP_ATTACHING_MS = 1500;
const { splitDroppedPaths, pathsInsertText } = window.OMP_DROPPED;
const { isDesktop, slashMenu, midPromptSlashToken, skillMenu, matchesQuery, insertText: slashInsertText } = window.OMP_SLASH;
const {
  entryOf: draftEntryOf, updateEntry: updateDraftEntry, pruneEntries: pruneDrafts, DRAFT_IDLE, recallInDraft,
  normalizePaste, shouldCollapsePaste, collapsePaste, pastesIn, expandPastes, inlinePaste,
  DRAFTS_STORE_KEY, parseDraftsStore, draftStorePut, savedDraftText, serializeDraftsStore,
} = window.OMP_SESSION_UI;
// How long a draft edit waits before its text reaches localStorage
// (session-ui.js's store helpers hold the pure half; the timer lives
// here, with the draft itself).
const _CMP_DRAFT_SAVE_MS = 300;
const { restoredDraft: restoredQueueDraft } = window.OMP_QUEUE;
// The footer's send/newline chord labels per `submitKey` tweak
// (constants.js isSubmitKey decides what actually sends).
const _CMP_SEND_HINTS = {
  "enter":      { send: "↵", newline: "⇧↵" },
  "ctrl+enter": { send: window.OMP_KEYMAP?.detectMac?.() ? "⌘↵" : "Ctrl+↵", newline: "↵" },
};
// How long a transient attach-strip notice chip (an over-cap or decode
// failure count) lingers before fading itself out.
const _CMP_NOTICE_MS = 4000;
// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` (display
// logic lives there so chrome.jsx's ⌘K/history hints can reuse it too,
// instead of each file re-deriving chord display independently). The guard
// here is the one thing that can't move: "registry not loaded yet"
// (`window.OMP_KEYMAP` absent — first render before keymap.js runs, should
// never happen in normal script order but guarded anyway) keeps showing
// `fallback`, distinct from "loaded but unbound" (the user cleared the
// binding), which `OMP_KEYMAP.hintFor`/`hintKeyFor` already report as `""`.
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}
function hintKeyFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintKeyFor(actionId) : fallback;
}

// ── The composer (input + plan/steer modes + send) ────────────────────
// `submitKey` ("enter" | "ctrl+enter") and `pasteCollapseLines` come from the
// tweaks (Settings › Composer); the defaults match TWEAK_DEFAULTS.
function Composer({ sessionId, sessionIds, draftStoreKey = null, onSend, onPick, planMode, onTogglePlan, planBlocked = "", goalMode = false, goalTint = false, onToggleGoal, goalBlocked = "", goalStrip = null, onOpenCmd, onOpenModel, currentModel, thinking, onLoadThinkingLevels, onSetThinking, isStreaming, backgroundWork = false, onAbort, onApprove, annotationCount = 0, microcopy, onFollowUp, draftInsert, promptHistory = [], promptInsert, queue, queueSending, onRemoveQueued, onPromoteQueued, onSendQueuedNow, browserChips = [], onRemoveBrowserChip, onBrowserChipClick, submitKey = "enter", pasteCollapseLines = 5, approvalCell = null, exitReason = null, onRestart = null, frequentCommands = [] }) {
  // Drafts are per tab (issue #28). The composer stays mounted across tab
  // switches and keeps one draft per session id (app/session-ui.js
  // DRAFT_IDLE): text, pending image attachments (sent alongside the next
  // message), collapsed pastes, the prompt-history recall position, and the
  // count of image preparations still in flight — sendWith blocks while
  // that is nonzero, so a fast Enter can't race ahead of a paste/pick and
  // ship the image on the *next* message.
  // Everything below reads and writes the active tab's entry, except an
  // image preparation landing after a switch: it goes back to the tab it
  // was started in.
  const [drafts, setDrafts] = React.useState({});
  const draft = draftEntryOf(drafts, sessionId, DRAFT_IDLE);
  const { text, attachments, pendingImages } = draft;
  // What the draft can send. A goal needs its objective as text; a steer
  // (mid-turn) can be images or browser annotation chips alone — app-live
  // merges the chips into the message; a plain send can also be plan
  // annotations alone.
  const hasText = !!text.trim();
  const steerable = goalMode ? hasText : hasText || attachments.length > 0 || browserChips.length > 0;
  const sendable = steerable || (!goalMode && planMode && annotationCount > 0);
  const updateDraft = (id, fn) => setDrafts(m => updateDraftEntry(m, id, DRAFT_IDLE, fn));
  // Any text edit ends a prompt-history recall; only the recall step itself
  // (onKey) writes `historyNav` alongside the text.
  const setText = (next) => updateDraft(sessionId, d => ({ ...d, text: next, historyNav: null }));
  // Open tab ids, also read when an image preparation lands: a tab closed
  // meanwhile must not get its entry back.
  const sessionIdsRef = React.useRef(sessionIds);
  sessionIdsRef.current = sessionIds;
  const updateOpenDraft = (id, fn) => setDrafts(m => (sessionIdsRef.current?.includes(id)
    ? updateDraftEntry(m, id, DRAFT_IDLE, fn)
    : m));
  const sessionIdRef = React.useRef(sessionId);
  sessionIdRef.current = sessionId;
  React.useEffect(() => { setDrafts(m => pruneDrafts(m, sessionIds)); }, [sessionIds]);

  // ── Draft persistence across restarts (R7) ────────────────────────────
  // Text only, in localStorage key OMP_SESSION_UI.DRAFTS_STORE_KEY, written
  // 300 ms after the last edit. A send removes the entry so a restart after
  // sending does not resurrect the message. Never sends, never restores
  // attachments, pastes or a recall position — the restored value is only
  // textarea text. A write failure (quota, privacy mode) is logged once per
  // document and never breaks typing.
  //
  // The store key is `draftStoreKey`, NOT `sessionId`: live.js mints
  // `session-<ms>` ids per launch, so a restart never sees the same id and
  // an id-keyed store would restore nothing. app-live.jsx passes the tab's
  // stable identity — its conversation file, else its folder (a fresh tab
  // with no conversation yet) — so a restored draft lands on the tab it
  // was typed in. null (no file, no folder: a pathless resumed tab) is not
  // persisted at all.
  const draftsStoreRef = React.useRef(null); // parsed map, or null = unread
  // Set once a localStorage write threw: every later write is skipped, so
  // a hostile store cannot spam the console per keystroke.
  const draftsBrokenRef = React.useRef(false);
  const loadDraftsStore = () => {
    if (draftsStoreRef.current === null) {
      draftsStoreRef.current = parseDraftsStore(
        typeof localStorage !== "undefined" ? localStorage.getItem(DRAFTS_STORE_KEY) : null
      );
    }
    return draftsStoreRef.current;
  };
  const saveDraftText = (storeKey, nextText) => {
    if (draftsBrokenRef.current || !storeKey) return;
    const store = draftStorePut(loadDraftsStore(), storeKey, nextText);
    draftsStoreRef.current = store;
    try {
      localStorage.setItem(DRAFTS_STORE_KEY, serializeDraftsStore(store));
    } catch (e) {
      draftsBrokenRef.current = true;
      console.error("[composer] persisting the draft failed:", e);
    }
  };
  // Store keys this document has saved (the session they were written for
  // is remembered for the restore side): the tab-close prune below needs
  // it, because the in-memory drafts map is keyed by session id, not by
  // store key — the only place both meet is this map.
  const draftKeyOwners = React.useRef(new Map()); // storeKey → sessionId
  const rememberKeyOwner = (storeKey, id) => {
    if (storeKey && id) draftKeyOwners.current.set(storeKey, id);
  };
  // Debounced save of the active tab's draft text.
  const draftSaveTimer = React.useRef(null);
  React.useEffect(() => {
    rememberKeyOwner(draftStoreKey, sessionId);
    if (!draftStoreKey) return undefined;
    clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      draftSaveTimer.current = null;
      saveDraftText(draftStoreKey, text);
    }, _CMP_DRAFT_SAVE_MS);
    return () => clearTimeout(draftSaveTimer.current);
  }, [draftStoreKey, text]);
  // A closed tab drops its stored draft: the prune effect above removed the
  // in-memory entry, and nothing else would write the removal.
  React.useEffect(() => {
    clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      draftSaveTimer.current = null;
      for (const [storeKey, id] of draftKeyOwners.current) {
        if (sessionIdsRef.current?.includes(id)) continue;
        draftKeyOwners.current.delete(storeKey);
        saveDraftText(storeKey, "");
      }
    }, _CMP_DRAFT_SAVE_MS);
    return () => clearTimeout(draftSaveTimer.current);
  }, [sessionIds]);
  // Restore: only for a session this document has never held a draft for
  // (the restart case — composer.jsx mounts fresh, `drafts` starts `{}`),
  // and only while it still owns the same store key (a conversation
  // switched files mid-document keeps what was typed; the new file's own
  // saved draft is not fetched over it). A webview reload while React
  // state survives, or a draft already typed, is left alone: the live text
  // is newer than anything on disk.
  React.useEffect(() => {
    if (!sessionId || !draftStoreKey) return;
    rememberKeyOwner(draftStoreKey, sessionId);
    let saved;
    setDrafts(m => {
      if (Object.hasOwn(m, sessionId)) return m;
      saved ??= savedDraftText(loadDraftsStore(), draftStoreKey);
      if (saved === "") return m;
      return { ...m, [sessionId]: { ...DRAFT_IDLE, text: saved } };
    });
  }, [sessionId, draftStoreKey]);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const taRef   = React.useRef(null);
  // Global "focus the composer" chord (desktop.composer.focus): app-live
  // dispatches this window event; the textarea focuses and selects nothing.
  React.useEffect(() => {
    const onFocusReq = () => { taRef.current?.focus(); };
    window.addEventListener("omp:focus-composer", onFocusReq);
    return () => window.removeEventListener("omp:focus-composer", onFocusReq);
  }, []);
  // Prompt-history recall (issues #16, #55, Arrow Up/Down): the recall
  // position lives in the tab's draft entry (`historyNav`, an index into the
  // tab's history, null = not recalling), so each tab keeps its own recall.
  // onKey steps it via recallInDraft.
  const listRef = React.useRef(null);
  const attachCounterRef = React.useRef(0);
  const fileInputRef     = React.useRef(null);
  // Fresh key per transient notice, so two identical back-to-back notices
  // (e.g. two over-cap pastes in a row) still re-arm the 4s timer.
  const noticeCounterRef = React.useRef(0);
  // File/folder drop from the OS (#50): with `dragDropEnabled` the drop
  // arrives as Tauri's drag-drop event carrying full paths (the effect by
  // `onTauriDrop`); in demo mode (no Tauri) the webview's own HTML5 drop
  // handles images. `dropActive` drives the highlight either way; the
  // HTML5 path's hover element lives in `dropHoverRef`, so crossing
  // children re-renders only when the highlight itself flips.
  const [dropActive, setDropActive] = React.useState(false);
  // What is being dragged over the composer, for the drop highlight's
  // label: "images" or "paths" (OMP_DROPPED.splitDroppedPaths on the
  // hover payload's paths — Tauri sends them on enter/over, before the
  // drop; the HTML5 path can't peek at files before the drop, so it stays
  // null there). Null = no hover → no label.
  const [dropKind, setDropKind] = React.useState(null);
  const dropHoverRef = React.useRef(null);
  // The .composer root: the Tauri drop event is window-global, so the
  // highlight and the drop hit-test its rect.
  const rootRef = React.useRef(null);

  // ── Phone tier: the "＋" action panel ───────────────────────────────
  // isTouch() decides everything mobile here; the flag is read once per
  // render. The sheet state is the composer's own: the ＋ button, its
  // rows and the notice line all live inside this component; only the
  // terminal/usage/git rows delegate through the omp:mobile CustomEvent.
  const touch = Boolean(_cmpMobile()?.isTouch?.());
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // The thinking-menu row in the sheet opens the real menu, which lives
  // on ThinkingMenu's own pill in the foot row (thinking-menu.jsx is not
  // this package's file to extend). Late-bound DOM trigger: the sheet
  // closes first, then the pill gets one synthetic click. The pill is
  // always in the composer root; a missing one (a model-less tab still
  // renders it) is a no-op.
  // A one-line notice at the top of the open sheet (a blocked toggle
  // tap): red, self-dismissing after _CMP_SHEET_MS. The contract's
  // fallback chain runs first — a real notify mechanism, when one
  // exists, wins over the in-sheet line.
  const [sheetNotice, setSheetNotice] = React.useState(null);
  // The ＋ panel's second-level view: null = the row list (default),
  // "history" = the prompt-history drill-in listing this tab's prompts
  // (the same newest-first array the desktop's Ctrl+Up modal reads),
  // capped to _CMP_SHEET_HISTORY rows. Closing the sheet resets it;
  // the back row returns to the list without closing.
  const [sheetView, setSheetView] = React.useState(null);
  React.useEffect(() => {
    if (!sheetNotice) return undefined;
    const t = setTimeout(() => setSheetNotice(null), _CMP_SHEET_MS);
    return () => clearTimeout(t);
  }, [sheetNotice]);
  const sheetNotify = (msg) => {
    if (typeof window.OMP_BRIDGE?.notify === "function") { try { window.OMP_BRIDGE.notify(msg); return; } catch { /* fall through */ } }
    setSheetNotice(msg);
  };
  const closeSheet = () => { setSheetOpen(false); setSheetView(null); };
  // Sheet row "thinking": close, then click the real pill once — after
  // the sheet unmounts, so the pop it opens is not inside a closing
  // sheet. rAF defers past React's unmount commit.
  const openThinkingFromSheet = () => {
    closeSheet();
    requestAnimationFrame(() => {
      rootRef.current?.querySelector(".thinking-menu > button.composer-pill")?.click();
    });
  };
  // The sheet rows that map to app-level panels (terminal/usage/git):
  // one CustomEvent, `action` the contract's verb, the app root owns
  // every one of those panels.
  const dispatchMobile = (action) => {
    closeSheet();
    window.dispatchEvent(new CustomEvent("omp:mobile", { detail: { action } }));
  };
  const togglePlanInSheet = () => {
    if (!planMode && planBlocked) { sheetNotify(planBlocked); return; }
    onTogglePlan?.();
    closeSheet();
  };
  const toggleGoalInSheet = () => {
    if (!goalMode && goalBlocked) { sheetNotify(goalBlocked); return; }
    onToggleGoal?.();
    closeSheet();
  };
  // The mode pill at the foot's right end reads the *active tab*'s
  // approval cell, which app-live.jsx already computes for the status
  // bar. Composer never received it; the mobile foot needs it, so the
  // prop is optional and the pill simply doesn't render without it
  // (demo mode / old callers stay correct).
  const approvalModeLabel = approvalCell?.label ?? null;
  const cmds = window.OMP_DATA?.commands || [];

  // ── @-mention file-path autocomplete ─────────────────────────────────
  // Caret tracked separately from `text`: the mention token depends on
  // *where* the cursor sits, not just the text content — arrow-key/mouse
  // moves into an existing @token must re-derive it without an edit.
  const [caret, setCaret]                       = React.useState(0);
  const [mentionItems, setMentionItems]         = React.useState([]);
  const [mentionActiveIdx, setMentionActiveIdx] = React.useState(0);
  const [mentionDismissedKey, setMentionDismissedKey] = React.useState(null);
  const [slashDismissedKey, setSlashDismissedKey]     = React.useState(null);
  const mentionListRef = React.useRef(null);
  const mentionReqRef  = React.useRef(0);

  const mentionRange = React.useMemo(() => parseMentionQuery(text, caret), [text, caret]);
  const mentionKey    = mentionRange ? `${mentionRange.start}:${mentionRange.query}` : null;
  const showMention   = mentionRange !== null && mentionItems.length > 0 && mentionDismissedKey !== mentionKey;

  // A tab switch swaps the draft under the textarea: the caret, the slash
  // selection and the mention list (fetched from the other tab's project)
  // all described the previous tab. A layout effect, so nothing flashes
  // against the new draft; setting the textarea's value has already put
  // the native caret at its end. The mention fetch below re-runs on the
  // switch for the same reason.
  React.useLayoutEffect(() => {
    setCaret(text.length);
    setActiveIdx(0);
    setMentionItems([]);
    setMentionDismissedKey(null);
    setSlashDismissedKey(null);
  }, [sessionId]);

  // Debounced fetch — keyed on the query text, not the caret, so moving
  // the caret within an unchanged token never re-fires it, and on the tab,
  // whose project the list comes from. A monotonic request id drops a
  // response that lands after a newer query fired.
  React.useEffect(() => {
    // No active token — also forget any Escape-dismissal recorded for a
    // token that no longer exists, and invalidate any request already in
    // flight for it, so neither can resurrect stale items for an unrelated
    // later "@src" at the same offset (e.g. next message, or after fully
    // clearing the draft). A dismissal survives a same-offset backspace-
    // then-retype of the identical query, by design — Escape means "not
    // this exact text", and re-arriving at exactly that text should still
    // honor it until the query actually differs.
    if (!mentionRange) {
      mentionReqRef.current++;
      setMentionItems([]);
      setMentionDismissedKey(null);
      return;
    }
    const myReq = ++mentionReqRef.current;
    const timer = setTimeout(async () => {
      const items = await window.OMP_BRIDGE.listFiles(mentionRange.query, 30);
      if (mentionReqRef.current === myReq) { setMentionItems(items); setMentionActiveIdx(0); }
    }, 60);
    return () => clearTimeout(timer);
  }, [mentionRange?.query, mentionRange !== null, sessionId]);

  // Derive slash state inline — no useEffect, no stale flicker. Suppressed
  // while the mention menu is showing: both can't render in the same
  // absolutely-positioned spot (e.g. "/plan add @src/foo.js"). Once
  // arguments are typed after a non-desktop (RPC) command, slashMenu
  // returns [] — that command runs inside omp, not here, so the popup
  // gets out of the way and Enter sends the literal text as a prompt.
  //
  // Mid-prompt (#30): a `/token` ending at the caret after other prompt
  // text lists matching skills, by omp's own editor rules (see
  // slash-commands.js). It wins over the leading-command popup, as in omp
  // ("/plan do /sk"); when no skill matches, the leading popup applies as
  // before. Escape always dismisses the popup only — for a leading "/…"
  // draft as well as a mid-prompt token — so a stray Esc never clears the
  // text the user is still composing.
  const slashRange = React.useMemo(() => midPromptSlashToken(text, caret), [text, caret]);
  const slashKey   = slashRange ? `${slashRange.start}:${slashRange.query}` : null;
  // A dismissal belongs to one token: once there is none (sent, deleted,
  // caret moved off it), forget it, or the same offset and query in a later
  // message would never open the list — same rule as the @ list.
  React.useEffect(() => { if (!slashRange) setSlashDismissedKey(null); }, [slashRange === null]);
  const skillHits  = slashRange && slashDismissedKey !== slashKey ? skillMenu(cmds, slashRange.query) : [];
  const midSlash   = skillHits.length > 0;
  // The leading "/…" popup keys its dismissal on the whole draft: there is
  // no separate token to anchor on, and the dismissal should survive until
  // the draft actually changes (the same key it would re-derive from).
  const leadingKey = midSlash ? null : `lead:${text}`;
  const filtered   = midSlash ? skillHits : slashDismissedKey !== leadingKey ? slashMenu(cmds, text) : [];
  const showSlash  = filtered.length > 0 && !showMention;

  // Keep activeIdx in bounds; auto-select when single result
  const clampedIdx = showSlash ? Math.min(activeIdx, filtered.length - 1) : 0;

  // Scroll active item into view
  React.useEffect(() => {
    if (!showSlash || !listRef.current) return;
    const el = listRef.current.children[clampedIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx, showSlash]);

  // Scroll active mention row into view
  React.useEffect(() => {
    if (!showMention || !mentionListRef.current) return;
    const el = mentionListRef.current.children[mentionActiveIdx];
    el?.scrollIntoView({ block: "nearest" });
  }, [mentionActiveIdx, showMention]);

  // Grow with the text up to the CSS max-height, then scroll: hidden
  // overflow past it would leave the rest of a long draft unreachable.
  // `measure` is also re-run on a *width* change (ResizeObserver below):
  // wrapping is what decides the height, so a container resize — a rail
  // toggled, a drag handle moved, the window itself — must re-measure the
  // same text, not just a text edit.
  const measure = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    // Read before the writes below, while style is still clean. Measure
    // without the last pass's scrollbar, whose width would change wrapping.
    const max = parseFloat(getComputedStyle(ta).maxHeight) || Infinity;
    ta.style.height = "auto";
    ta.style.overflowY = "hidden";
    const full = ta.scrollHeight;
    ta.style.height = `${Math.min(full, max)}px`;
    if (full > max) ta.style.overflowY = "auto";
  }, []);
  React.useEffect(() => { measure(); }, [text, measure]);
  // Re-measure on width changes only: height changes are this component's
  // own doing (the measure above), and feeding them back here would loop.
  // The last-seen width guards the observer's initial callback, which fires
  // with the current size before any real change happens.
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return undefined;
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentBoxSize?.[0]?.inlineSize ?? ta.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      measure();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [measure]);

  // Restore focus when the agent finishes streaming and the textarea
  // re-enables — unless the user is typing somewhere else by then (an
  // inline tab rename, #32, commits on blur; the ⌘K input): taking focus
  // from it would commit a half-typed name or drop the keystrokes. The
  // Settings page needs the same bail: it covers this composer, and its
  // controls are buttons, not typing targets — focus jumping here
  // mid-Settings-use leaves Enter to invisibly send. The host carries the
  // `hidden` attribute exactly while a project tab covers it, so it is the
  // "Settings is showing" test — and it also covers focus on the body
  // (a click on the page's background blurs to it) and on an overlay
  // opened from the page (the approvals panel), which sit outside it.
  React.useEffect(() => {
    if (isStreaming) return;
    // Phone: refocusing here would pop the software keyboard open the
    // moment a stream ends — over whatever the user is reading. The
    // draft is kept; focus returns when they tap the input themselves.
    if (touch) return;
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el && window.OMP_KEYMAP?.isTypingTarget(el)) return;
      const host = document.querySelector(".st-host");
      if (host && !host.hidden) return;
      // An open overlay (approvals, updates, history…) owns focus while it
      // shows: taking it from under a scrim hides keystrokes behind it. The
      // bottom overlays are named too — the kanban and the git browser sit
      // under the .bridge-scrim panels in z (90 vs 100) but are equally
      // wrong to steal from: their panels hold buttons whose Enter/Space a
      // refocused composer would turn into an invisible send.
      if (document.querySelector(".bridge-scrim, .kanban-scrim, .gitb-scrim")) return;
      if (el?.closest?.(".st-host, .settings")) return;
      taRef.current?.focus();
    });
  }, [isStreaming, touch]);

  // Shared by the inline `/` popup's non-desktop pick and the ⌘K bridge's
  // draftInsert below — both replace the composer's text with a command
  // token and put the caret at its end, ready for arguments.
  const replaceDraft = (next) => {
    setText(next);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = next.length;
    });
  };

  // CommandBridge (⌘K) hands a non-desktop pick here the same way — see
  // its `onInsertDraft` prop. Keyed on `nonce` (not `text`) so picking the
  // same command twice in a row still re-fires the effect. Unlike the
  // inline popup (only ever visible while `text` already starts with the
  // command being replaced), ⌘K has no textarea of its own — the composer
  // may be holding an unrelated typed draft when it's opened. A non-empty,
  // non-slash draft is kept as the inserted command's argument instead of
  // silently discarded; `text` is deliberately read directly (not depended
  // on) so this only fires on a new pick, using whatever draft is current
  // at that moment.
  React.useEffect(() => {
    if (!draftInsert) return;
    const trimmed = text.trim();
    const next = trimmed && !trimmed.startsWith("/") ? draftInsert.text + trimmed : draftInsert.text;
    replaceDraft(next);
  }, [draftInsert?.nonce]);

  // Prompt-history picker (Ctrl+Up modal) hands a pick here the same way
  // ⌘K's draftInsert does — keyed on `nonce` so picking the same prompt
  // twice in a row still re-fires. Unlike draftInsert, this
  // *replaces* the draft (the modal's contract is "put this message
  // directly in the prompt box"), never appends an existing one. `images`
  // (a goal start omp refused) go back in as attachments. An `append`
  // insert (a rail widget click) goes *after* the current draft instead —
  // never in front of it and never replacing it, a `/command` draft
  // included (OMP_WIDGETS.appendToDraft). An insert from before this
  // composer mounted (it unmounts while no tab is open) is not replayed
  // into the next tab's draft.
  const seenInsertRef = React.useRef(promptInsert?.nonce);
  React.useEffect(() => {
    if (!promptInsert || promptInsert.nonce === seenInsertRef.current) return;
    seenInsertRef.current = promptInsert.nonce;
    replaceDraft(promptInsert.append ? window.OMP_WIDGETS.appendToDraft(text, promptInsert.text) : promptInsert.text);
    const images = promptInsert.images ?? [];
    if (images.length === 0) return;
    const back = images.map(image => ({ id: `att-${++attachCounterRef.current}`, name: "", image, src: toDataUrl(image) }));
    updateDraft(sessionId, d => ({ ...d, attachments: [...d.attachments, ...back].slice(0, MAX_ATTACHMENTS) }));
  }, [promptInsert?.nonce]);

  const execCmd = (cmd) => {
    // A mid-prompt skill pick replaces only its `/token` with
    // `/skill:name `; the prose around it stays, and omp passes it to the
    // skill as arguments on send.
    if (midSlash) {
      spliceDraft(slashRange, slashInsertText(cmd));
      setActiveIdx(0);
      return;
    }
    // A non-desktop (RPC) command has no handler in app-live.jsx's
    // handleCommand — it runs inside omp. Insert `/name ` and leave focus
    // in the composer instead of firing it immediately: the user adds
    // arguments (or none) and Enter sends it as a normal prompt, same as
    // typing the whole thing by hand. Guards against a one-click accident
    // on a destructive command like `/delete`.
    if (!isDesktop(cmd)) {
      replaceDraft(slashInsertText(cmd));
      return;
    }
    // Text typed after a desktop command goes to its handler: `/goal
    // <objective>` puts the objective back into the composer in goal mode.
    const args = expandPastes(/^\/\S*\s+([\s\S]*)$/.exec(text)?.[1]?.trim() ?? "", draft.pastes);
    updateDraft(sessionId, d => ({ ...d, text: "", pastes: DRAFT_IDLE.pastes, pasteCounter: 0 }));
    setActiveIdx(0);
    setMentionDismissedKey(null);
    onPick?.(cmd, args);
  };

  // Replace `range` (an @mention or mid-prompt `/token`) with `insert` and
  // put the caret right after it.
  const spliceDraft = (range, insert) => {
    const { text: nextText, caret: nextCaret } = applyMention(text, range, insert);
    setText(nextText);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = nextCaret;
      ta.focus();
    });
  };

  // The '@' itself is part of `insertText`, not just a display trigger:
  // the sent message keeps "@path/to/file" as a recognizable in-text file
  // reference (same convention as Claude Code's own @file mentions).
  // A directory pick's trailing '/' (no space) keeps the token "open" so
  // parseMentionQuery still matches it next render, re-querying one level
  // deeper — dropping the '@' here would silently break that, since the
  // token detector has nothing left to anchor on.
  //
  // A name containing whitespace or an embedded '@' can never stay
  // "open": parseMentionQuery stops its backward scan at the first space,
  // and separately rejects a query containing '@' (and an '@' preceded by
  // an ordinary character fails the token's own precursor check) — so
  // either character in the middle of the inserted path would make the
  // token permanently unrecoverable (drill-down silently dead for that
  // one directory, e.g. a Next.js parallel-route dir like `app/@modal`).
  // Closing normally instead still reaches nested entries — the backend
  // fuzzy-matches a full relative path in one query, so a fresh
  // "@dir with space/sub" from scratch works; drill-down is a
  // convenience, not a requirement.
  const pickMention = (item) => {
    if (!item || !mentionRange) return;
    const canStayOpen = item.isDir && !/[\s@]/.test(item.path);
    spliceDraft(mentionRange, canStayOpen ? `@${item.path}/` : `@${item.path} `);
  };

  // The long pastes still collapsed in the draft, for the chip strip.
  const collapsed = React.useMemo(() => pastesIn(text, draft.pastes), [text, draft.pastes]);

  // Applies a paste edit from session-ui.js and puts the caret where it
  // says, once the new text has rendered.
  const applyPasteEdit = (r) => {
    updateDraft(sessionId, d => ({ ...d, ...r.patch }));
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = r.caret;
    });
  };

  // A chip's "expand": the paste becomes editable text again.
  const expandPaste = (id) => {
    const r = inlinePaste(draft, id);
    if (r) applyPasteEdit(r);
  };

  // Route a completed draft through the full send pipeline. `dispatcher` is
  // either `onSend` (normal) or `onFollowUp` (follow-up); both get the same
  // paste-expansion, state-reset and focus-restore treatment. The slash-popup
  // shortcut only applies to a plain send — a follow-up must always send the
  // literal draft (plan §7: Ctrl+Q/Ctrl+Enter sends a follow-up even while a
  // '/' command is being typed), never silently reroute into executing the
  // highlighted palette command instead.
  // The transient "attaching image…" chip on the input's top right: the
  // one explanation a swallowed Enter gets while a paste/pick is still
  // preparing. Fresh key per chip so back-to-back ones re-arm the timer.
  const [attaching, setAttaching] = React.useState(null); // { key }
  React.useEffect(() => {
    if (!attaching) return undefined;
    const t = setTimeout(() => setAttaching(null), _CMP_ATTACHING_MS);
    return () => clearTimeout(t);
  }, [attaching]);
  const sendWith = (dispatcher, { followUp = false } = {}) => {
    if (showSlash && !followUp) { execCmd(filtered[clampedIdx]); return; }
    // A paste/pick is still preparing: the Enter is swallowed (its image
    // must not ship on the *next* message) — the transient chip says why.
    if (pendingImages > 0) { setAttaching({ key: ++noticeCounterRef.current }); return; }
    // A follow-up (`onFollowUp` dispatcher) requires non-empty text.
    if (!(followUp ? hasText : sendable)) return;
    const images = attachments.map(a => a.image);
    dispatcher(expandPastes(text.trim(), draft.pastes), images);
    // Back to an empty draft: text, attachments and collapsed pastes all
    // went out with this message, and the reset ends any prompt-history
    // recall. The in-flight image count is kept: an async-clipboard paste
    // can have queued its increment after the render this send read, and
    // its decrement still lands later.
    updateDraft(sessionId, d => (d.pendingImages ? { ...DRAFT_IDLE, pendingImages: d.pendingImages } : DRAFT_IDLE));
    // The sent text leaves the persisted store too (session-ui.js's
    // draftStorePut drops the entry on empty text): a restart after a
    // send must not resurrect the message into the composer. Immediate,
    // not debounced — a quit racing the timer would otherwise re-show it.
    saveDraftText(draftStoreKey, "");
    setMentionDismissedKey(null);
    setSlashDismissedKey(null);
    // Phone: no refocus after send — the keyboard is only up when the
    // user is holding it up; a programmatic focus would re-summon it.
    if (!touch) requestAnimationFrame(() => taRef.current?.focus());
  };

  // ✎ on a queued message (QueueStrip): omp removes it first, and only a
  // confirmed removal puts its text back — into the tab it was queued
  // from, ahead of anything typed there since. omp's queue does not hand
  // back attached images.
  const editQueued = async (row) => {
    const target = sessionId;
    const removed = await onRemoveQueued(row.text, row.kind);
    if (removed) {
      updateOpenDraft(target, d => ({ ...d, text: restoredQueueDraft(row.text, d.text), historyNav: null }));
      if (sessionIdRef.current === target) requestAnimationFrame(() => taRef.current?.focus());
    }
    return removed;
  };
  const send = () => sendWith(onSend);

  // Pick, downscale/re-encode and queue image files as pending attachments.
  // Files that fail to decode, and any that would push the batch over
  // MAX_ATTACHMENTS, are dropped rather than blocking the rest (keep what
  // fits — the user can always attach the dropped ones separately). The
  // drop count surfaces as a transient chip at the end of the attach strip
  // (`droppedNotice`), instead of vanishing silently.
  const [droppedNotice, setDroppedNotice] = React.useState(null); // { key, text }
  React.useEffect(() => {
    if (!droppedNotice) return undefined;
    const timer = setTimeout(() => setDroppedNotice(null), _CMP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [droppedNotice]);
  // The notice chip is tab-scoped, like the strip it rides on (the composer
  // stays mounted across tab switches): a switch away and back must not
  // resurrect the previous tab's "N images were dropped" — it describes
  // that tab's paste, not this one's. Cleared on any sessionId change.
  const noticeSessionRef = React.useRef(sessionId);
  React.useEffect(() => {
    if (noticeSessionRef.current === sessionId) return;
    noticeSessionRef.current = sessionId;
    setDroppedNotice(null);
  }, [sessionId]);
  const notifyDropped = (count) => {
    if (count > 0) setDroppedNotice({ key: ++noticeCounterRef.current, text: `${count} image${count === 1 ? "" : "s"} over the ${MAX_ATTACHMENTS}-image cap were dropped` });
  };
  const addFiles = async (fileList) => {
    // The tab this paste/pick/drop belongs to: preparation is async, and the
    // result must not land in whichever tab is active by then.
    const target = sessionId;
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
    const room  = MAX_ATTACHMENTS - attachments.length;
    if (files.length === 0) return;
    notifyDropped(room <= 0 ? files.length : files.length - room);
    if (room <= 0) return;
    const slice = files.slice(0, room);
    // Counted only while the tab is open: a paste resolved through the
    // async clipboard path may land after its tab closed.
    updateOpenDraft(target, d => ({ ...d, pendingImages: d.pendingImages + slice.length }));
    let ok = [];
    let failed = 0;
    try {
      const prepared = await Promise.all(slice.map(async (file) => {
        try {
          const image = await prepareImage(file);
          return { id: `att-${++attachCounterRef.current}`, name: file.name, image, src: toDataUrl(image) };
        } catch {
          failed++; // undecodable file — drop, don't block the rest of the batch
          return null;
        }
      }));
      ok = prepared.filter(Boolean);
      if (failed > 0) setDroppedNotice({ key: ++noticeCounterRef.current, text: `${failed} image${failed === 1 ? "" : "s"} could not be decoded and were dropped` });
    } finally {
      // Cap against the latest entry, not the `attachments` this call closed
      // over — a concurrent addFiles (fast double-paste) may have already
      // appended by the time this resolves. A tab closed meanwhile is left
      // without an entry rather than given one back.
      updateOpenDraft(target, d => ({
        ...d,
        attachments: ok.length > 0 ? [...d.attachments, ...ok].slice(0, MAX_ATTACHMENTS) : d.attachments,
        pendingImages: d.pendingImages - slice.length,
      }));
    }
  };
  const removeAttachment = (attId) =>
    updateDraft(sessionId, d => ({ ...d, attachments: d.attachments.filter(a => a.id !== attId) }));

  // Insert OS file/folder paths as draft text at the caret (OMP_DROPPED's
  // quoting and padding), for the agent to read with its own tools.
  // `insertPaths` runs asynchronously (a paste resolves `copied_file_paths`
  // over IPC; a drop reads image bytes first), so it must not trust this
  // render's `text` or the textarea's *current* selection: the caret is
  // captured synchronously by the caller (paste time / drop time, before
  // any await), the splice is computed against the tab's *latest* draft
  // entry inside the functional update, and focus is only restored when
  // the session is still the one the insert was started in — a tab switch
  // mid-flight must neither splice into the new tab nor steal its focus.
  // Mirrors how addFiles guards via target/updateOpenDraft.
  const insertPaths = (paths, sel = null) => {
    const target = sessionId;
    const ta = taRef.current;
    const start = sel?.start ?? (ta ? ta.selectionStart : null);
    const end   = sel?.end   ?? (ta ? ta.selectionEnd   : null);
    if (start === null || end === null) return;
    let nextCaret = null;
    let applied = false;
    setDrafts(m => updateDraftEntry(m, target, DRAFT_IDLE, d => {
      const r = pathsInsertText(d.text, start, end, paths);
      if (!r) return d;
      const a = applyMention(d.text, r.range, r.insert);
      nextCaret = a.caret;
      applied = true;
      return { ...d, text: a.text, historyNav: null };
    }));
    if (!applied) return;
    // Same-tab caret placement + focus as spliceDraft; guarded so an
    // insert that raced a tab switch leaves the new tab alone.
    if (sessionIdRef.current === target) {
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.selectionStart = el.selectionEnd = nextCaret;
        el.focus();
      });
    }
  };

  // A drop delivered by Tauri (`dragDropEnabled`): `paths` carries files
  // and folders alike. Images keep the byte-attachment pipeline — their
  // bytes come back over IPC (`read_dropped_file`) as a File for
  // `addFiles` — everything else is inserted as text. A read failure (a
  // folder named like an image, a file gone between drag and drop) falls
  // back to inserting its path.
  const onTauriDrop = async (paths) => {
    // The caret at drop time, captured before the first await: the image
    // reads below are IPC round-trips during which the user may type or
    // switch tabs, so the eventual text insert must anchor where the caret
    // *was*, not wherever the (possibly unfocused) textarea reports later.
    const ta0 = taRef.current;
    const sel = ta0 ? { start: ta0.selectionStart, end: ta0.selectionEnd } : null;
    const { images, others } = splitDroppedPaths(paths);
    const files = [];
    const failed = [];
    for (const img of images) {
      try {
        const r = await window.__TAURI__.core.invoke("read_file_bytes", { path: img.path });
        const bytes = Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
        files.push(new File([bytes], r.name || img.name, { type: img.mime }));
      } catch (err) {
        console.error("[composer] read_dropped_file failed:", err);
        failed.push(img.path);
      }
    }
    if (files.length) await addFiles(files);
    const asText = [...others, ...failed];
    // insertPaths guards the focus/restore itself (same-session check);
    // the unconditional focus below was what stole focus across a tab
    // switch mid-flight, so it's gone.
    if (asText.length) insertPaths(asText, sel);
  };

  // The drop event is window-global, so the highlight and the drop both
  // hit-test the composer rect; positions are physical pixels. The handler
  // goes through a ref: the listener registers once, and a stale `text`
  // closure must not misplace an insert.
  const tauriDropRef = React.useRef(null);
  tauriDropRef.current = onTauriDrop;
  React.useEffect(() => {
    if (!window.__TAURI__?.webview) return undefined;
    const inside = (pos) => {
      const el = rootRef.current;
      if (!el || !pos) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    let off = null;
    let dead = false;
    window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((ev) => {
      const { type, paths, position } = ev.payload;
      if (type === "drop") {
        setDropActive(false);
        setDropKind(null);
        if (inside(position)) void tauriDropRef.current?.(paths);
      } else if (type === "leave") {
        setDropActive(false);
        setDropKind(null);
      } else {
        const hit = inside(position); // enter / over
        setDropActive(hit);
        // The hover payload carries the paths being dragged: preview
        // which pipeline would take them (images attach, the rest insert
        // as text), so the highlight can say what the drop will do.
        setDropKind(hit && paths?.length ? (splitDroppedPaths(paths).images.length > 0 ? "images" : "paths") : null);
      }
    }).then(
      (u) => { if (dead) u(); else off = u; },
      (err) => console.error("[composer] drag-drop listener failed:", err),
    );
    return () => { dead = true; off?.(); };
  }, []);

  // Demo mode only (no __TAURI__ — index.html in a plain browser): the
  // webview's own HTML5 drop handles images the paste/pick way (`addFiles`);
  // non-images are ignored. In the app, Tauri's native file drop claims
  // these events before the page sees them. One handler for all four drag
  // events (dragleave is not cancelable, so its preventDefault is a no-op).
  const onFileDrag = (e) => {
    if (!carriesFiles(e.dataTransfer)) return;
    // On dragover, accepting the drop is what makes the drop event fire at all.
    e.preventDefault();
    if (e.type === "dragover") {
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    dropHoverRef.current = dropHoverAfter(dropHoverRef.current, e.type, e.target);
    const hover = dropHoverRef.current !== null;
    setDropActive(hover);
    // Demo mode only ever attaches images, so the hover is always the
    // image kind (carriesFiles already filtered non-files out).
    setDropKind(hover ? "images" : null);
    if (e.type === "drop") {
      setDropKind(null);
      addFiles(imageFilesFromTransfer(e.dataTransfer));
      taRef.current?.focus();
    }
  };

  // Collapse long pastes (session-ui.js shouldCollapsePaste) into a token
  // so the textarea stays navigable; the chip strip above shows and
  // expands them. An image on the clipboard is attached in every case; it
  // only short-circuits the text handling below when there's no
  // accompanying text to preserve.
  const onPaste = (e) => {
    // A file-manager copy shows in the paste event's DataTransfer only as a
    // "Files" type — file bytes without usable paths, folders not at all;
    // the real path list lives on the OS clipboard (`copied_file_paths`). A
    // screenshot arrives as "Files" too but leaves that list empty, which
    // is the discriminator between inserting paths and attaching image
    // bytes. clipboardData dies with the event, so the images are
    // snapshotted before the await.
    // `?.webview`: the remote shim (phone browser) provides __TAURI__
    // without the webview API — there the OS-clipboard path is desktop-side
    // and wrong, so the plain HTML5 paste branch below runs instead.
    if (window.__TAURI__?.webview && carriesFiles(e.clipboardData)) {
      e.preventDefault();
      const copied = imageFilesFromTransfer(e.clipboardData);
      // The caret at paste time, snapshotted before the `copied_file_paths`
      // IPC: keystrokes typed while that resolves (or a tab switch) must
      // not move where the paths land — the DOM selection by then is not
      // the one the user pasted at, and insertPaths applies against the
      // *latest* draft entry inside its functional update.
      const ta0 = taRef.current;
      const sel = ta0 ? { start: ta0.selectionStart, end: ta0.selectionEnd } : null;
      window.__TAURI__.core.invoke("copied_file_paths").then((paths) => {
        if (paths?.length > 0) insertPaths(paths, sel);
        else if (copied.length > 0) addFiles(copied);
        else imageFilesFromClipboardAsync().then((files) => { if (files.length > 0) addFiles(files); });
      }).catch((err) => {
        console.error("[composer] copied_file_paths failed:", err);
        if (copied.length > 0) addFiles(copied);
      });
      return;
    }
    const imageFiles = imageFilesFromTransfer(e.clipboardData);
    const raw = normalizePaste(e.clipboardData?.getData("text/plain") ?? "");
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
      // Some sources (spreadsheet cells, rich-text apps) put a rendered
      // bitmap on the clipboard *alongside* real text — attach the image
      // but keep going into the text handling below instead of discarding
      // it. Only an image with no accompanying text short-circuits here.
      if (!raw) { e.preventDefault(); return; }
    } else {
      // WebKitGTK never puts image/* into the synchronous paste event's
      // DataTransfer (only text/*), so the extraction above always comes
      // back empty there for an image paste — fall back to the async
      // Clipboard API, which does see it. Fire-and-forget: there is no
      // synchronous default action to block when the sync DataTransfer
      // carried no image, and on engines where the sync path already
      // works this resolves to zero files and is a no-op.
      imageFilesFromClipboardAsync().then((files) => { if (files.length > 0) addFiles(files); });
    }
    if (!shouldCollapsePaste(raw, pasteCollapseLines)) return; // short — let browser handle normally
    e.preventDefault();
    const ta    = taRef.current;
    const start = ta ? ta.selectionStart : text.length;
    const end   = ta ? ta.selectionEnd   : text.length;
    applyPasteEdit(collapsePaste(draft, raw, start, end));
  };

  const onKey = (e) => {
    // An IME composition (CJK candidate window) owns these keys while it
    // runs: its arrows pick candidates, its Escape/Tab close or commit the
    // window. Acting here — navigating the popup, dismissing it — would
    // both drop the keystrokes and leave the composer's state diverged from
    // what the IME still thinks it is composing. `isComposing` rides only
    // the native event (React's SyntheticEvent does not copy it; see
    // isSubmitEnter in app/constants.js for the proof).
    if (showMention || showSlash) {
      if (e.nativeEvent?.isComposing ?? e.isComposing) return;
    }
    if (showMention) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionActiveIdx(i => (i + 1) % mentionItems.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionActiveIdx(i => (i - 1 + mentionItems.length) % mentionItems.length); return; }
      if (e.key === "Escape")    { e.preventDefault(); setMentionDismissedKey(mentionKey); return; }
      if (e.key === "Tab" || (isSubmitEnter(e) && !e.shiftKey)) { e.preventDefault(); pickMention(mentionItems[mentionActiveIdx]); return; }
    }
    if (showSlash) {
      if (e.key === "ArrowDown")  { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      // Esc dismisses the popup only — both a mid-prompt skill token and a
      // leading "/…" draft. Dismissing (not clearing) keeps the prose: the
      // draft-cleared-on-Esc trap loses text a user meant to keep, and the
      // token-scoped key re-opens the popup once the query differs anyway.
      if (e.key === "Escape")     { e.preventDefault(); setSlashDismissedKey(midSlash ? slashKey : leadingKey); return; }
      if (e.key === "Tab")        { e.preventDefault(); setActiveIdx(i => (i + 1) % filtered.length); return; }
      // A plain Enter runs the highlighted command whatever the send chord:
      // it picks from the popup, it does not send a message.
      if (isSubmitEnter(e) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); send(); return; }
    }
    // Prompt-history recall (issues #16, #55) — only when neither popup owns
    // the arrows and no modifier is held (a modified arrow is a different
    // chord, e.g. the Ctrl+Up picker handled globally by use-keymap.jsx, and
    // Shift+Up/Down is the native select-to-start/end gesture). Up starts a
    // recall only from an empty composer (recallInDraft); during one, Up on
    // the first line / Down on the last line steps it, so a multi-line entry
    // still moves the caret line by line. Anything else is a caret move.
    if (!showMention && !showSlash && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const ta = taRef.current;
      const start = ta ? ta.selectionStart : text.length;
      const end   = ta ? ta.selectionEnd   : text.length;
      const H = window.OMP_PROMPT_HISTORY;
      const eligible = dir < 0 ? H.caretOnFirstLine(text, start, end) : H.caretOnLastLine(text, start, end);
      // recallInDraft (app/session-ui.js) refuses a typed draft and drops a
      // recall position the text has drifted from (an edit, a lowered
      // Settings history limit) instead of trusting a stale index.
      const next = eligible ? recallInDraft(draft, promptHistory, dir, H.step) : null;
      if (next) {
        e.preventDefault();
        updateDraft(sessionId, d => ({ ...d, text: next.text, historyNav: next.historyNav }));
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (!el) return;
          el.selectionStart = el.selectionEnd = next.text.length;
        });
        return;
      }
    }
    // Phone: Enter never sends — the send button is the only sender. The
    // textarea's own default inserts the newline; the IME guard above
    // already ran, and the send chord is not even computed (a hardware
    // keyboard paired to a phone would fire chords through OMP_KEYMAP
    // below, which is a global, keymap-bound path — untouched here).
    // Keymap chords (Ctrl/Cmd+Enter via app.message.followUp and any
    // rebound global send) still work for the rare physical-keyboard case;
    // only the *bare* Enter chord is disabled.
    if (touch && _cmpMobile()?.submitOnEnter?.() === false) {
      if (window.OMP_KEYMAP?.matches(e.nativeEvent ?? e, "app.message.followUp")) {
        e.preventDefault();
        if (onFollowUp) sendWith(onFollowUp, { followUp: true });
      }
      return;
    }
    // isSubmitKey (app/constants.js) owns the IME-composition guard and the
    // `submitKey` chord. With "ctrl+enter" the send check runs first, as
    // `ctrl+enter` is also a default followUp chord; with "enter" followUp
    // goes first, since isSubmitKey's Enter would match `ctrl+enter` too.
    const sendChord = isSubmitKey(e, submitKey);
    if (sendChord && submitKey === "ctrl+enter") { e.preventDefault(); send(); return; }
    if (window.OMP_KEYMAP?.matches(e.nativeEvent ?? e, "app.message.followUp")) {
      e.preventDefault();
      if (onFollowUp) sendWith(onFollowUp, { followUp: true });
      return;
    }
    if (sendChord) { e.preventDefault(); send(); return; }
  };

  // Live keymap hints — computed once per render, reused across the
  // placeholder, title, kbd chips and footer so they can never disagree.
  const bridgeHint    = hintFor("desktop.commands.open", "⌘K");
  const bridgeKeyHint = hintKeyFor("desktop.commands.open", "K");
  const abortHint = hintFor("app.interrupt", "⎋");
  // The recall chord is the plain arrow (issues #16, #55) — same keys the
  // desktop.composer.promptHistory action's picker opens with, so its keymap
  // hint is the chord to advertise in the footer's "history" segment.
  const historyHint = hintFor("desktop.composer.promptHistory", "↑");
  const cycleThinkingHint = hintFor("app.thinking.cycle", "⇧Tab");
  const sendHints = _CMP_SEND_HINTS[submitKey] ?? _CMP_SEND_HINTS.enter;
  // live.js ships the key-dependent microcopy with `{abort}`/`{bridge}`
  // placeholders; the actual chords live here (keymap-aware, so a rebind
  // or a platform without ⌘ can't show a stale glyph). An unbound action
  // drops its whole clause instead of leaving "Press  to interrupt".
  const fillHints = (s) => {
    if (typeof s !== "string" || !s.includes("{")) return s;
    return s
      // An unbound abort drops its whole clause ("Press … to interrupt — ")
      // rather than leaving a keyless "Press  to interrupt —", so the rest
      // ("your cursor is in the room") still reads as a sentence. The
      // clause spans up to and including the "—" separator after it.
      .replace(/^Press \{abort\} to interrupt —\s*/i, abortHint ? `Press ${abortHint} to interrupt — ` : "")
      .replace(/\{abort\}/g, abortHint ? abortHint : "")
      .replace(/\{bridge\}/g, bridgeHint ? ` · ${bridgeHint} opens the bridge` : "")
      .replace(/\s+/g, " ").trim().replace(/[·—]\s*$/, "").trim();
  };
  const streamingPlaceholder = fillHints(microcopy?.streamingTip) || "agent is working…";
  const palettePlaceholder    = fillHints(microcopy?.paletteTip) || `what should we ship?  ·  / for commands${bridgeHint ? `  ·  ${bridgeHint} for the bridge` : ""}`;
  // Phone placeholder (OMP_MOBILE.placeholder): touch flavour, or null
  // when the environment is not touch — the desktop expressions below
  // stand. The kind matches the desktop ternary's own two states: idle
  // (goal/plan/plain, all one short hint on a phone) and streaming.
  const mobilePlaceholder = _cmpMobile()?.placeholder?.(isStreaming ? "streaming" : "idle") ?? null;

  return (
    <div className={`composer${planMode ? " plan-on" : ""}${goalTint ? " goal-on" : ""}${goalMode ? " goal-draft" : ""}${dropActive ? " drop-on" : ""}`}
      ref={rootRef}
      data-drop-kind={dropActive ? dropKind ?? "" : undefined}
      {...(window.__TAURI__?.webview ? {} : { onDragEnter: onFileDrag, onDragOver: onFileDrag, onDragLeave: onFileDrag, onDrop: onFileDrag })}>
      {/* Dead agent (omp process exited): the transcript explains it via a
          note, and this strip is the way back — one click respawns the tab
          with --resume (live.js `restartSession`). */}
      {exitReason && !isStreaming && onRestart && (
        <div className="restart-strip" role="alert">
          <Icon name="warn" size={12} color="var(--rose)" />
          <span style={{ color: "var(--fg-2)" }}>agent process exited — the conversation is saved</span>
          <button className="btn ghost outlined" style={{ marginLeft: "auto", height: 24 }}
            onClick={onRestart}>
            <Icon name="refresh" size={11} /> restart agent
          </button>
        </div>
      )}
      {planMode && (
        <div className="plan-strip">
          <Icon name="plan" size={12} color="var(--amber)" />
          <span style={{ color: "var(--amber)" }}>plan mode</span>
          <span style={{ color: "var(--fg-3)" }}>· I'll draft before I write</span>
          <button className="btn ghost" onClick={onTogglePlan} style={{ marginLeft: "auto", height: 22 }}>exit</button>
        </div>
      )}
      {/* Goal mode (goal-strip.jsx): built by app-live.jsx, keyed by tab. */}
      {goalStrip}

      {showSlash && (
        <div className="slash-pop" id="slash-pop" role="listbox" aria-label="slash commands" ref={listRef}>
          {filtered.map((c, i) => (
            <button key={c.name}
              id={`slash-row-${i}`}
              role="option"
              aria-selected={i === clampedIdx}
              className={`slash-row${i === clampedIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); execCmd(c); }}>
              <span className="slash-glyph">{c.icon}</span>
              <span className="slash-name mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
              <span className="slash-hint" style={{ color: "var(--fg-3)" }} title={c.hint}>{c.hint}</span>
              <span className="chip muted" style={{ marginLeft: "auto", flex: "none" }}>{c.group}</span>
            </button>
          ))}
        </div>
      )}

      {showMention && (
        <MentionMenu
          items={mentionItems}
          activeIndex={mentionActiveIdx}
          onPick={pickMention}
          onHover={setMentionActiveIdx}
          listRef={mentionListRef}
        />
      )}

      {/* Keyed by tab, like the paste strip: a pending action or notice
          belongs to the tab it was taken in. */}
      <QueueStrip key={`queue-${sessionId}`} queue={queue} sending={queueSending}
        canSendNow={isStreaming}
        onSendNow={row => onSendQueuedNow(row.text, row.kind)}
        onRemove={row => onRemoveQueued(row.text, row.kind)}
        onPromote={row => onPromoteQueued(row.text)}
        onEdit={editQueued} />

      <BrowserChips
        chips={browserChips}
        dropped={window.OMP_BROWSER.droppedScreenshots(attachments.length, browserChips)}
        onRemove={onRemoveBrowserChip}
        onChipClick={onBrowserChipClick} />

      {(attachments.length > 0 || droppedNotice) && (
        <div className="attach-strip">
          {attachments.map(a => (
            <div className="attach-chip" key={a.id}>
              <img className="attach-thumb" src={a.src} alt={a.name || "attached image"} />
              <button className="attach-remove" title="remove attachment" aria-label="remove attachment" onClick={() => removeAttachment(a.id)}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ))}
          {droppedNotice && (
            <span className="attach-notice" role="status" key={droppedNotice.key}>{droppedNotice.text}</span>
          )}
        </div>
      )}

      {/* Keyed by tab: an open preview is that tab's, not the next one's. */}
      <PasteStrip key={sessionId} pastes={collapsed} onExpand={expandPaste} />

      <div className="composer-row">
        {/* Phone "＋" (the action-panel trigger): cmp-only class — desktop
            CSS keeps it display:none, the ≤760px tier in composer.css
            shows it. Renders on every width so a narrow desktop window
            gets the same panel; behaviour (sheet) is the same. */}
        <button className="cmp-mobile-plus" title="more actions" aria-label="more actions" onClick={() => setSheetOpen(true)}>
          <Icon name="plus" size={14} color="var(--fg-3)" />
        </button>
        <button className="btn icon ghost" title="attach image" aria-label="attach image" onClick={() => fileInputRef.current?.click()}>
          <Icon name="image" size={13} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        {/* The dictation control is still "coming soon" (permanently
            disabled below) — hidden on every width, not just the phone
            tier: a visible control that can never be tapped is noise.
            Kept as a component for the day it works; CSS owns the
            removal (composer.css .cmp-dead-dictate) so behaviour and
            markup stay in sync when it lands. */}
        <button className="btn icon ghost cmp-dead-dictate" title="dictation coming soon" aria-label="dictate" disabled aria-hidden="true">
          <Icon name="voice" size={13} />
        </button>
        <div className={`composer-input${text.length > 0 ? " has-clear" : ""}`}>
          <textarea
            ref={taRef}
            rows="1"
            placeholder={
              mobilePlaceholder !== null
                ? mobilePlaceholder
                : goalMode && !isStreaming
                ? "describe the goal — the agent works toward it until it calls it done…"
                : planMode && !isStreaming
                ? (microcopy?.planTip ?? "describe what to build, or give feedback on the plan…")
                : isStreaming
                  ? streamingPlaceholder
                  : palettePlaceholder
            }
            value={text}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            onKeyDown={onKey}
            onPaste={onPaste}
            className={`selectable${draft.historyNav !== null ? " recalling" : ""}`}
            role={showMention || showSlash ? "combobox" : undefined}
            aria-expanded={showMention || showSlash ? true : undefined}
            aria-controls={showMention ? "mention-menu" : showSlash ? "slash-pop" : undefined}
            aria-activedescendant={showMention ? `mention-row-${mentionActiveIdx}` : showSlash ? `slash-row-${clampedIdx}` : undefined}
          />
          {text.length > 0 && (
            <button type="button" className="composer-clear" title="clear input" aria-label="clear input"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setText(""); setCaret(0); setActiveIdx(0); requestAnimationFrame(() => taRef.current?.focus()); }}>
              <Icon name="trash" size={11} />
            </button>
          )}
          {/* Enter swallowed mid-preparation: the transient "attaching
              image…" chip (sendWith), sharing the clear button's top-right
              corner — the trash never renders while a send is blocked, so
              the spot is free exactly when this is needed. */}
          {attaching && (
            <span className="composer-attaching" role="status" key={attaching.key}>attaching image…</span>
          )}
        </div>
        <button className="btn outlined" title={bridgeHint ? `open command bridge (${bridgeHint})` : "open command bridge"} onClick={onOpenCmd}>
          <Icon name="command" size={11} />
          {bridgeKeyHint && <span className="kbd" style={{ marginLeft: 2 }}>{bridgeKeyHint}</span>}
        </button>
        {/* Phone streaming row, reworked: the big accent key stays the
            *send* key — streaming included — because the send path already
            steers mid-turn (handleSend routes a submit to bridge.steer
            while a run is live), so mid-turn interjection needs only a
            visible key, not a second path. Stop moves beside it as a
            smaller rose circle (cmp-mobile-stop in composer.css); both
            are width-gated cmp-only classes, so the desktop row keeps
            its own steer + abort pair. Steer still honors goal mode's
            "no mid-turn goal text" rule via `steerable` here; a
            non-steerable draft keeps the plain stop-only layout. */}
        {isStreaming && touch && (
          <>
            {steerable && (
              <button className="cmp-mobile-send" title="steer: send while the agent works" aria-label="steer"
                onClick={send} disabled={pendingImages > 0}>
                <Icon name={goalMode ? "goal" : "arrow"} size={13} color={goalMode ? "var(--lilac)" : undefined} />
              </button>
            )}
            <button className="cmp-mobile-send cmp-mobile-stop" title="stop" aria-label="stop" onClick={onAbort}>
              <Icon name="stop" size={10} />
            </button>
          </>
        )}
        {/* Desktop streaming pair (or the phone's Enter-chord fallback
            on a non-touch narrow window): the phone tier above renders
            its own pair, so this branch is touch-free. */}
        {isStreaming && !touch ? (
          <>
            {steerable && (
              <button className={`btn outlined${goalMode ? " goal-resume" : ""}`} onClick={send} disabled={pendingImages > 0}
                style={goalMode ? undefined : { color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name={goalMode ? "goal" : "arrow"} size={10} color={goalMode ? "var(--lilac)" : "var(--amber)"} /> {goalMode ? "start goal" : "steer"}
              </button>
            )}
            <button className="btn danger" onClick={onAbort}>
              <Icon name="stop" size={10} /> abort {abortHint && <span className="kbd">{abortHint}</span>}
            </button>
          </>
        ) : !isStreaming && (
          <>
            {planMode && (
              <button className="btn outlined" onClick={onApprove}
                style={{ color: "var(--amber)", borderColor: "color-mix(in oklab, var(--amber) 40%, var(--line))" }}>
                <Icon name="play" size={10} color="var(--amber)" /> approve
              </button>
            )}
            <button className={`btn primary${goalMode ? " goal-start" : ""}`} onClick={send}
              disabled={!sendable || pendingImages > 0}>
              {goalMode
                ? "start goal"
                : planMode
                ? `send feedback${annotationCount > 0 ? ` · ${annotationCount} comment${annotationCount !== 1 ? "s" : ""}` : ""}`
                : "send"}
              {" "}<Icon name="arrow" size={11} />
            </button>
          </>
        )}
      </div>

      <div className="composer-foot">
        <button className="composer-pill" onClick={onOpenModel}>
          <span className="dot live" />
          <span style={{ color: "var(--fg-2)" }}>{currentModel?.name}</span>
          <Icon name="chev" size={10} color="var(--fg-4)" />
        </button>
        <ThinkingMenu key={sessionId} model={currentModel} level={thinking}
          cycleHint={cycleThinkingHint} onLoad={onLoadThinkingLevels} onSet={onSetThinking} />
        <button className={`composer-pill plan-pill${planMode ? " on" : ""}`} onClick={onTogglePlan}
          disabled={!!planBlocked && !planMode} title={planBlocked && !planMode ? planBlocked : undefined}>
          <Icon name="plan" size={11} color={planMode ? "var(--amber)" : "var(--fg-3)"} />
          <span style={{ color: planMode ? "var(--amber)" : "var(--fg-2)" }}>plan mode</span>
        </button>
        <button className={`composer-pill goal-pill${goalMode ? " on" : ""}`} onClick={onToggleGoal}
          disabled={!!goalBlocked && !goalMode}
          title={goalBlocked && !goalMode ? goalBlocked : "goal mode: your next message becomes a goal the agent works toward"}>
          <Icon name="goal" size={11} color={goalMode ? "var(--lilac)" : "var(--fg-3)"} />
          <span style={{ color: goalMode ? "var(--lilac)" : "var(--fg-2)" }}>goal</span>
        </button>
        {/* Your three most-used slash commands (app/slash-usage.js), only
            while omp still lists them — a deleted command hides at once.
            A click prepends `/name ` to whatever is drafted. */}
        {frequentCommands.map(name => (
          <button key={name} className="composer-pill slash-pill mono"
            title={`insert /${name} at the start of your draft`}
            onClick={() => {
              // Same contract as ⌘K's draftInsert: a draft that already
              // leads with a command is replaced, never double-prefixed.
              const trimmed = text.trim();
              setText(trimmed && !trimmed.startsWith("/") ? `/${name} ${text}` : `/${name} `);
              taRef.current?.focus();
            }}>
            <span style={{ color: "var(--fg-2)" }}>/{name}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {backgroundWork && (
          <span className="composer-bg-note" title="omp reports background work (an async bash, task or eval job) whose result will wake the agent">
            <TabRunDot state="background" />
            background job running · the agent resumes when it finishes
          </span>
        )}
        <span className="mono" style={{ color: "var(--fg-4)", fontSize: "var(--d-text-xs)" }}>
          {[
            ...(isStreaming && steerable
              ? [goalMode ? `${sendHints.send} start goal` : `${sendHints.send} steer`]
              : [goalMode ? `${sendHints.send} start goal` : `${sendHints.send} send`, `${sendHints.newline} newline`]),
            // Recall lives on the plain arrows, so the segment rides the
            // non-streaming branch only (steering has no recall). Dropped
            // entirely when unbound, like the abort segment.
            ...(!(isStreaming && steerable) && historyHint ? [`${historyHint} history`] : []),
            // Dropped entirely when unbound rather than showing a keyless
            // "abort" segment that advertises a shortcut that isn't there.
            ...(abortHint ? [`${abortHint} abort`] : []),
          ].join(" · ")}
        </span>
        {/* Phone: the right-end mode indicator (mobile-draft frame 1).
            yolo shows the ⚠; any other mode shows its plain name.
            cmp-only class, hidden above 760px; only rendered when the
            app passed the cell (PkgB wires approvalCell=approvalCell),
            so old callers see nothing. */}
        {approvalModeLabel && (
          <span className={`cmp-mobile-mode${approvalCell?.warn ? " warn" : ""}`}
            title={approvalCell?.warn ? "yolo: every tool runs without asking" : "tool approval mode"}>
            {approvalCell?.warn ? <><Icon name="warn" size={10} color="var(--amber)" /> yolo</> : approvalModeLabel}
          </span>
        )}
      </div>

      {/* Phone: the "＋" action panel (mobile-draft frame 3). Mounted only
          on a touch device — the sheet's whole gesture surface assumes a
          finger. window.MobileSheet is read here, inside the render, per
          the late-bound cross-package contract. */}
      {touch && sheetOpen && (() => {
        const MobileSheet = window.MobileSheet;
        if (!MobileSheet) return null;
        return (
          <MobileSheet title="actions" onClose={closeSheet}>
            {sheetNotice && <div className="cmp-sheet-notice" role="status">{sheetNotice}</div>}
            {/* Second level: this tab's prompt history (the desktop's
                Ctrl+Up modal capability, phone-sized). A row per prompt,
                newest first, capped to _CMP_SHEET_HISTORY; a pick replaces
                the draft exactly the way the modal's does (promptInsert's
                replace contract, app-live.jsx's handlePickHistoryPrompt),
                not appended to it. The back row returns to the row list
                without closing — the sheet's own gestures still own
                dismissal. */}
            {sheetView === "history" ? (
              <>
                <button className="cmp-sheet-row" onClick={() => setSheetView(null)}>
                  <span className="cmp-sheet-ic"><Icon name="back" size={14} /></span>
                  <span className="cmp-sheet-tx">prompt history<span className="s">back to actions</span></span>
                </button>
                <div className="cmp-sheet-list">
                  {promptHistory.length === 0 && (
                    <div className="cmp-sheet-row cmp-sheet-empty">no prompts sent in this tab yet</div>
                  )}
                  {promptHistory.slice(0, _CMP_SHEET_HISTORY).map((p, i) => (
                    <button className="cmp-sheet-row" key={`${i}-${p}`} onClick={() => { replaceDraft(p); closeSheet(); }}>
                      <span className="cmp-sheet-tx cmp-sheet-pt">{p}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (<>
            <button className="cmp-sheet-row" onClick={() => { closeSheet(); fileInputRef.current?.click(); }}>
              <span className="cmp-sheet-ic"><Icon name="image" size={14} /></span>
              <span className="cmp-sheet-tx">image<span className="s">photos / files</span></span>
            </button>
            <button className="cmp-sheet-row" onClick={() => { closeSheet(); onOpenCmd?.(); }}>
              <span className="cmp-sheet-ic"><Icon name="command" size={14} /></span>
              <span className="cmp-sheet-tx">commands<span className="s">slash commands and skills</span></span>
            </button>
            <div className="cmp-sheet-sep" />
            <button className="cmp-sheet-row" onClick={openThinkingFromSheet}>
              <span className="cmp-sheet-ic"><Icon name="thinking" size={14} color="var(--lilac)" /></span>
              <span className="cmp-sheet-tx">thinking<span className="s">reasoning depth</span></span>
              <span className="cmp-sheet-val">{thinking ?? "auto"}</span>
            </button>
            <button className={`cmp-sheet-row${planMode ? " on" : ""}`} onClick={togglePlanInSheet}>
              <span className="cmp-sheet-ic"><Icon name="plan" size={14} color={planMode ? "var(--amber)" : undefined} /></span>
              <span className="cmp-sheet-tx">{planMode ? "plan mode on" : "plan mode"}<span className="s">draft first, then write · not with goal mode</span></span>
            </button>
            <button className={`cmp-sheet-row${goalMode ? " on" : ""}`} onClick={toggleGoalInSheet}>
              <span className="cmp-sheet-ic"><Icon name="goal" size={14} color={goalMode ? "var(--lilac)" : undefined} /></span>
              <span className="cmp-sheet-tx">{goalMode ? "goal mode on" : "goal mode"}<span className="s">run until the goal is done · not with plan mode</span></span>
            </button>
            <div className="cmp-sheet-sep" />
            {/* App-level rows: "new conversation" follows the shared
                omp:mobile contract (the app root owns tab creation — the
                same handler the tab bar's "+" and the sidebar's "new
                conversation" row use); "prompt history" drills into
                the in-sheet list above instead of leaving the composer. */}
            <button className="cmp-sheet-row" onClick={() => dispatchMobile("open-new")}>
              <span className="cmp-sheet-ic"><Icon name="plus" size={14} /></span>
              <span className="cmp-sheet-tx">new conversation<span className="s">start a fresh chat in this project</span></span>
            </button>
            <button className="cmp-sheet-row" onClick={() => setSheetView("history")}>
              <span className="cmp-sheet-ic"><Icon name="clock" size={14} /></span>
              <span className="cmp-sheet-tx">prompt history<span className="s">recent prompts from this tab</span></span>
            </button>
            <div className="cmp-sheet-sep" />
            <button className="cmp-sheet-row" onClick={() => dispatchMobile("open-terminal")}>
              <span className="cmp-sheet-ic"><Icon name="terminal" size={14} /></span>
              <span className="cmp-sheet-tx">terminal</span>
            </button>
            <button className="cmp-sheet-row" onClick={() => dispatchMobile("open-usage")}>
              <span className="cmp-sheet-ic"><Icon name="radar" size={14} /></span>
              <span className="cmp-sheet-tx">usage and stats</span>
            </button>
            <button className="cmp-sheet-row" onClick={() => dispatchMobile("open-git")}>
              <span className="cmp-sheet-ic"><Icon name="branch" size={14} /></span>
              <span className="cmp-sheet-tx">git changes</span>
            </button>
            </>)}
          </MobileSheet>
        );
      })()}
    </div>
  );
}

// ── ⌘K Command bridge — two views: commands → model picker ────────────
//
//  commands view  — lists all slash-commands; /model drills into picker
//  models view    — filterable model list, the profile's most recently used
//                   models (omp's own MRU, #11) first; Esc returns to commands
//

// Recently used models pinned above the full list (#11).
const RECENT_MODEL_LIMIT = 5;

function CommandBridge({ open, onClose, onPick, onPickModel, currentModelId, profileId, onPickLogin, onInsertDraft, loginProviders, initialView = "commands" }) {
  const [q, setQ]       = React.useState("");
  const [view, setView] = React.useState("commands");
  // Which row the filter input's ↑↓/Enter drive (the footer's "navigate"
  // hint is real, not decoration): an index into the current view's flat
  // row list. Reset on every filter/view change so it never points past
  // the end; `clamped` guards the in-between renders.
  const [activeIdx, setActiveIdx] = React.useState(0);
  const inputRef = React.useRef(null);
  // The scrollable rows container (bridge-body) — the active row scrolls
  // into view as ↑↓ moves, the way history-modal.jsx does it.
  const rowsRef = React.useRef(null);
  // omp's MRU is per profile (each has its own agent.db), so the list is
  // fetched *for* `profileId` and tagged with it, and only shown while that
  // is still the active tab's profile — a tab switch or a profile respawn
  // never shows another profile's order, not even until the refetch lands.
  // Refetched on every entry into the models view and on a profile change
  // while open: omp records a switch the moment it happens (here, in
  // another tab, or in its terminal UI). A response for a profile left
  // meanwhile is dropped (`live`).
  const [recent, setRecent] = React.useState({ profileId: null, keys: [] });
  const recentKeys = recent.profileId === profileId ? recent.keys : [];

  React.useEffect(() => {
    if (open) {
      setQ("");
      setView(initialView);
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);
  // A narrower filter (or a drill-in's reset of `q`) re-clamps the index;
  // resetting to 0 also means ↑ always starts from the top row.
  React.useEffect(() => { setActiveIdx(0); }, [q, view]);

  // Escape is the shared Escape stack's business (app/use-esc-close.js):
  // exactly one window listener dispatches it to the topmost *active*
  // overlay, so the bridge closes only when nothing renders above it, and
  // the drill-in views still fall back one level before closing. The
  // stack's listener also prevents the key, so the global keymap's
  // `app.interrupt` never aborts a turn underneath.
  window.useEscClose(() => {
    if (view === "models") { if (initialView === "models") onClose(); else { setView("commands"); setQ(""); } }
    else if (view === "login") { if (initialView === "login") onClose(); else { setView("commands"); setQ(""); } }
    else onClose();
  }, open);

  // The app behind is inert while the bridge is open (the shared
  // useModalLayer, ui/use-modal-layer.js — same behaviour as the history
  // modal and the lightbox): Tab can't reach the composer underneath, and
  // focus comes back to whatever had it. The bridge is always mounted, so
  // the hook's `open` dependency is what re-runs the effect per open (the
  // modals that mount only while open get it from the default); the views
  // below render in a portal on <body> so inerting #root leaves them
  // interactive. The scrim is the initial focus target; the 30ms timer
  // above moves focus into the filter input (the login view's rows take it
  // via its own key handler).
  const panelRef = React.useRef(null);
  const scrimRef = React.useRef(null);
  window.useModalLayer(scrimRef, open);
  React.useEffect(() => {
    if (!open || view !== "models") return undefined;
    let live = true;
    // The model list is fetched lazily, on this first open — not at startup
    // or on every tab switch (live.js `ensureModels`).
    window.OMP_BRIDGE?.ensureModels?.();
    window.OMP_BRIDGE?.recentModels?.(profileId).then((keys) => {
      if (live && Array.isArray(keys)) setRecent({ profileId, keys });
    });
    return () => { live = false; };
  }, [open, view, profileId]);

  // ── Keyboard navigation plumbing (all three views) ────────────────
  // ↑↓ move the active row, ↵ fires it, and the active row scrolls into
  // view. Declared before the `!open` early return (and before any view
  // branch) so the login view's useEffect below sees a stable reference —
  // it lives at window level there, since the login view has no filter
  // input to carry the keys.
  const scrollActiveRef = React.useRef(null);
  scrollActiveRef.current = () => {
    const el = rowsRef.current?.querySelector(".bridge-row.kb-active");
    el?.scrollIntoView({ block: "nearest" });
  };
  const loginProvidersList = loginProviders ?? [];
  React.useEffect(() => {
    if (!open || view !== "login") return undefined;
    const enterProvider = (p) => { if (p?.available) { onPickLogin(p); onClose(); } };
    const onKey = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, loginProvidersList.length - 1)); requestAnimationFrame(() => scrollActiveRef.current?.()); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); requestAnimationFrame(() => scrollActiveRef.current?.()); }
      else if (e.key === "Enter") { e.preventDefault(); enterProvider(loginProvidersList[Math.min(activeIdx, loginProvidersList.length - 1)]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, loginProviders, activeIdx, onPickLogin, onClose]);

  if (!open) return null;

  const fil    = (s) => s.toLowerCase().includes(q.toLowerCase());
  const models = window.OMP_DATA.models;

  // Filter-input key nav for the models/commands views: `count` is the
  // view's flat row list length, `enterRow(i)` fires row i's action.
  const makeInputKeyNav = (count, enterRow) => (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, count - 1)); requestAnimationFrame(() => scrollActiveRef.current?.()); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); requestAnimationFrame(() => scrollActiveRef.current?.()); }
    else if (e.key === "Enter") { e.preventDefault(); enterRow(Math.min(activeIdx, count - 1)); }
  };

  // ── Model picker view ──────────────────────────────────────────────
  if (view === "models") {
    const modelHits = models.filter((m) => !q || fil(m.name) || fil(m.id));
    const recentHits = window.pickRecentModels(modelHits, recentKeys, RECENT_MODEL_LIMIT);
    // Flat row list in DOM order: recents first, then the full list, with
    // any model that already appeared in recents skipped (the button keys
    // are `${group}:…`, so a model can appear in both groups only when
    // pickRecentModels already deduped it — verify with the row keys).
    // `restHits` — the full list minus anything already in `recentHits`, so
    // the 'all models' group below can render it without repeating the
    // recents (each model must own exactly one row id and one kb-active
    // glow; flatRows and `rowIdx` assume exactly that).
    const restHits = modelHits.filter((m) => !recentHits.includes(m));
    const flatRows = [...recentHits, ...restHits];
    const clampedIdx = Math.min(activeIdx, flatRows.length - 1);
    const enterModel = (m) => { if (m) { onPickModel(m); onClose(); } };
    const inputKeyNav = makeInputKeyNav(flatRows.length, (i) => enterModel(flatRows[i]));
    const modelRow = (m, group) => {
      const rowIdx = flatRows.indexOf(m);
      return (
      <button key={`${group}:${window.modelKey(m)}`}
        id={`bridge-model-row-${rowIdx}`}
        className={`bridge-row${m.id === currentModelId ? " active" : ""}${rowIdx === clampedIdx ? " kb-active" : ""}`}
        onClick={() => { onPickModel(m); onClose(); }}>
        <span className="bridge-glyph">
          {m.id === currentModelId
            ? <Icon name="check" size={10} color="var(--accent)" />
            : <Icon name="bolt"  size={10} color="var(--cyan)" />}
        </span>
        <span style={{ color: m.id === currentModelId ? "var(--accent)" : "var(--fg)" }}>{m.name}</span>
        <span className="mono" style={{ color: "var(--fg-4)" }}>{m.id}</span>
        <span style={{ color: "var(--fg-3)" }}>· {m.note}</span>
        <span className="chip muted" style={{ marginLeft: "auto" }}>{m.latency}ms</span>
      </button>
      );
    };
    return ReactDOM.createPortal(
        <div ref={scrimRef} tabIndex={-1} className="bridge-scrim" onClick={onClose}>
          <div ref={panelRef} tabIndex={-1} className="bridge slide-in" role="dialog" aria-modal="true" aria-label="command bridge" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back" aria-label="back to commands"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <input ref={inputRef} className="bridge-input mono"
              placeholder="filter models…" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={inputKeyNav}
              role="combobox" aria-expanded aria-controls="bridge-model-rows" aria-activedescendant={flatRows.length ? `bridge-model-row-${clampedIdx}` : undefined} />
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body" ref={rowsRef} id="bridge-model-rows" role="listbox" aria-label="models">
            {recentHits.length > 0 && (
              <div className="bridge-group">
                <div className="bridge-group-head mono">recently used</div>
                {recentHits.map((m) => modelRow(m, "recent"))}
              </div>
            )}
            <div className="bridge-group">
              <div className="bridge-group-head mono" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                all models
                <span style={{ color: "var(--fg-4)" }}>
                  tauri:{window.__TAURI__ ? "✓" : "✗"}
                  · connected:{window.OMP_BRIDGE?.isConnected ? "✓" : "✗"}
                  · models:{window.OMP_DATA.models.length}
                </span>
                <button className="btn ghost" style={{ marginLeft: "auto", height: 18, fontSize: "var(--d-text-xs)", padding: "0 6px" }}
                  onClick={() => window.OMP_BRIDGE?.refreshModels()}>
                  refresh
                </button>
              </div>
              {restHits.map((m) => modelRow(m, "all"))}
              {modelHits.length === 0 && <div className="bridge-empty">no models found</div>}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↑↓</span> navigate
            <span className="kbd">↵</span> switch
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (view === "login") {
    const providers = loginProviders ?? [];
    const clampedIdx = Math.min(activeIdx, providers.length - 1);
    return ReactDOM.createPortal(
      <div ref={scrimRef} tabIndex={-1} className="bridge-scrim" onClick={onClose}>
        <div ref={panelRef} tabIndex={-1} className="bridge slide-in" role="dialog" aria-modal="true" aria-label="command bridge" onClick={(e) => e.stopPropagation()}>
          <div className="bridge-input-row">
            <button className="btn icon ghost" title="back" aria-label="back to commands"
              onClick={() => { setView("commands"); setQ(""); }}
              style={{ marginRight: 4 }}>
              <Icon name="chevR" size={12} color="var(--fg-3)"
                style={{ transform: "rotate(180deg)", display: "block" }} />
            </button>
            <span className="bridge-input mono" style={{ cursor: "default", lineHeight: "normal" }}>
              login
            </span>
            <span className="kbd">esc</span>
          </div>
          <div className="bridge-body" ref={rowsRef} role="listbox" aria-label="login providers">
            <div className="bridge-group">
              <div className="bridge-group-head mono">select provider</div>
              {loginProviders === null && (
                <div className="bridge-empty" style={{ padding: "16px 32px" }}>loading providers…</div>
              )}
              {loginProviders !== null && loginProviders.length === 0 && (
                <div className="bridge-empty">no providers available</div>
              )}
              {loginProviders !== null && loginProviders.map((p, i) => (
                <button key={p.id}
                  id={`bridge-login-row-${i}`}
                  className={`bridge-row ${p.authenticated ? "active" : ""}${i === clampedIdx ? " kb-active" : ""}`}
                  onClick={() => { if (p.available) { onPickLogin(p); onClose(); } }}>
                  <span className="bridge-glyph">
                    {p.authenticated
                      ? <Icon name="check" size={10} color="var(--accent)" />
                      : <Icon name="bolt"  size={10} color={p.available ? "var(--cyan)" : "var(--fg-5)"} />}
                  </span>
                  <span style={{ color: p.authenticated ? "var(--accent)" : p.available ? "var(--fg)" : "var(--fg-4)" }}>
                    {p.name}
                  </span>
                  <span className="mono" style={{ color: "var(--fg-4)" }}>{p.id}</span>
                  <span className="chip muted" style={{ marginLeft: "auto" }}>
                    {p.authenticated ? "logged in" : p.available ? "available" : "unavailable"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="bridge-foot mono">
            <span className="kbd">↵</span> authenticate
            <span className="kbd">esc</span> back
          </div>
        </div>
      </div>,
      document.body,
    );
  }


  // ── Commands view ──────────────────────────────────────────────────
  const cmds    = window.OMP_DATA.commands;
  const cmdHits = cmds.filter((c) => matchesQuery(c, q));
  const groups  = {};
  cmdHits.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  // The model list loads lazily (live.js `ensureModels`); until it arrives,
  // the current-model name falls back to get_state's `model.name`.
  const activeModelName = models.find((m) => m.id === currentModelId)?.name ?? window.OMP_DATA.model?.name ?? "–";
  // Groups render in insertion order, so the flat list matches the DOM.
  const flatCmds = Object.values(groups).flat();
  const clampedIdx = Math.min(activeIdx, flatCmds.length - 1);
  const runCmd = (c) => {
    if (!c) return;
    if (c.name === "model") { setQ(""); setView("models"); }
    else if (c.name === "login") { setQ(""); setView("login"); }
    else if (isDesktop(c)) { onPick(c); onClose(); }
    else { onInsertDraft(slashInsertText(c)); onClose(); }
  };
  const inputKeyNav = makeInputKeyNav(flatCmds.length, (i) => runCmd(flatCmds[i]));
  const cmdRowIdx = (c) => flatCmds.indexOf(c);

  return ReactDOM.createPortal(
    <div ref={scrimRef} tabIndex={-1} className="bridge-scrim" onClick={onClose}>
      <div ref={panelRef} tabIndex={-1} className="bridge slide-in" role="dialog" aria-modal="true" aria-label="command bridge" onClick={(e) => e.stopPropagation()}>
        <div className="bridge-input-row">
          <Icon name="command" size={14} color="var(--accent)" />
          <input ref={inputRef} className="bridge-input mono"
            placeholder="cross the bridge — type to filter…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={inputKeyNav}
            role="combobox" aria-expanded aria-controls="bridge-cmd-rows" aria-activedescendant={flatCmds.length ? `bridge-cmd-row-${clampedIdx}` : undefined} />
          <span className="kbd">esc</span>
        </div>
        <div className="bridge-body" ref={rowsRef} id="bridge-cmd-rows" role="listbox" aria-label="commands">
          {Object.entries(groups).map(([g, list]) => (
            <div key={g} className="bridge-group">
              <div className="bridge-group-head mono">{g.toLowerCase()}</div>
              {list.map((c) => {
                const isModel = c.name === "model";
                const isLogin = c.name === "login";
                const drillsIn = isModel || isLogin;
                return (
                  <button key={c.name}
                    id={`bridge-cmd-row-${cmdRowIdx(c)}`}
                    className={`bridge-row${cmdRowIdx(c) === clampedIdx ? " kb-active" : ""}`}
                    onClick={() => runCmd(c)}>
                    <span className="bridge-glyph">{c.icon}</span>
                    <span className="bridge-cmd-name mono" style={{ color: "var(--accent)" }}>/{c.name}</span>
                    <span className="bridge-cmd-hint" style={{ color: "var(--fg-3)" }} title={c.hint}>{c.hint}</span>
                    {isModel && (
                      <span className="mono" style={{ color: "var(--fg-4)", marginLeft: "auto" }}>
                        {activeModelName}
                      </span>
                    )}
                    <Icon name={drillsIn ? "chevR" : "arrow"} size={11} color="var(--fg-4)"
                      style={{ marginLeft: drillsIn ? 8 : "auto" }} />
                  </button>
                );
              })}
            </div>
          ))}
          {cmdHits.length === 0 && (
            <div className="bridge-empty">no luck — try `plan`, `branch`, `model`…</div>
          )}
        </div>
        <div className="bridge-foot mono">
          <span className="kbd">↑↓</span> navigate
          <span className="kbd">↵</span> run
          <span className="kbd">esc</span> close
          <span style={{ marginLeft: "auto", color: "var(--fg-4)" }}>{(window.OMP_DATA.microcopy?.paletteTip ?? "").replace(/\{[^}]*\}/g, "").trim() || "type / to give orders"}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

Object.assign(window, { Composer, CommandBridge });
