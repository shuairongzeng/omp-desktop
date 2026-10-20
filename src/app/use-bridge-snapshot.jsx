/* app/use-bridge-snapshot.jsx — custom hooks that decouple the App
   component from the cross-cutting effects:
   - useBridgeSnapshot:  subscribes to OMP_BRIDGE.onUpdate and routes the
                         snapshot fields into a setter map.
   - useThemeEffect:     reflects tweaks state onto <html> classes /
                         CSS custom properties. Shortcuts dispatch is handled
                         by useKeymapDispatch in app/use-keymap.jsx. */

const { NULL_MODEL: _UB_NULL_MODEL, DEFAULT_PROFILE_ID: _UB_DEFAULT_PROFILE_ID } = window;

function useBridgeSnapshot(bridge, setters) {
  React.useEffect(() => {
    if (!bridge) return undefined;
    const unsub = bridge.onUpdate((snap) => {
      setters.setMessages(snap.messages);
      setters.setStreaming(snap.isStreaming);
      setters.setCtx(snap.ctx);
      if (setters.setTrimmedCount) setters.setTrimmedCount(snap.trimmedCount ?? 0);
      if (setters.setWindowed) setters.setWindowed(snap.windowed ?? false);
      if (setters.setWindowCursor) setters.setWindowCursor(snap.windowCursor ?? null);
      setters.setKanban(snap.kanban);
      setters.setPlanMeta(snap.planMeta);
      setters.setModels(snap.models);
      setters.setActivity(snap.activity);
      setters.setSparkline(snap.sparkline);
      setters.setModelState(snap.model || _UB_NULL_MODEL);
      if (snap.thinkingLevel) setters.setThinkingLevel(snap.thinkingLevel);
      setters.setSessions(snap.sessions ?? []);
      setters.setPromptHistory(snap.promptHistory ?? []);
      setters.setSubagents(snap.subagents);
      setters.setSubagentTranscripts(snap.subagentTranscripts ?? {});
      setters.setQueue(snap.queue);
      setters.setQueueSending(snap.queueSending);
      setters.setGoal(snap.goal);
      setters.setExtWidgets(snap.extWidgets);
      setters.setProfiles(snap.profiles ?? []);
      setters.setStartupProfileId(snap.startupProfileId ?? _UB_DEFAULT_PROFILE_ID);
      setters.setRecentProjects(snap.recentProjects ?? []);
      setters.setNoTabProfileId(snap.noTabProfileId ?? _UB_DEFAULT_PROFILE_ID);
      setters.setWorkspaceNotes(snap.workspaceNotes ?? []);
      setters.setApprovalModes(snap.approvalModes ?? null);
      setters.setCloseConfirm(snap.closeConfirm ?? null);
      if (snap.activeSessionId) setters.setActiveSessionId(snap.activeSessionId);
    });
    return unsub;
  }, [bridge]);
}

function useThemeEffect(t) {
  React.useEffect(() => {
    const root = document.documentElement;
    const T = window.OMP_THEME;
    root.classList.remove(...T.THEMES.map((n) => `theme-${n}`));
    root.classList.add(`theme-${t.theme}`);
    root.classList.remove("density-cozy", "density-compact", "density-dense");
    root.classList.add(`density-${t.density}`);
    if (t.monoChat) root.classList.add("mono-chat");
    else            root.classList.remove("mono-chat");
    // The accent override and its four derived tokens (app/accent.js), so
    // focus rings, glows, the xterm selection and the text on the accent
    // follow it. Cleared first: an accent equal to the theme's own keeps
    // the theme's hand-tuned set.
    const A = window.OMP_ACCENT;
    for (const name of A.TOKEN_NAMES) root.style.removeProperty(name);
    const tokens = t.accent ? A.accentTokens(t.accent) : null;
    if (tokens && !A.sameColor(getComputedStyle(root).getPropertyValue("--accent").trim(), t.accent)) {
      for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    } else if (t.accent && !tokens) {
      root.style.setProperty("--accent", t.accent);
    }
    if (t.fontSize) root.style.fontSize = `${t.fontSize}%`;

    // Chat width: `chat-wide`/`chat-full` on <html> lift the reading
    // column's caps (chat.css); standard is the absence of both classes.
    root.classList.toggle("chat-wide", t.chatWidth === "wide");
    root.classList.toggle("chat-full", t.chatWidth === "full");

    // Text brightness: shift the fg ladder toward the contrast pole (or
    // wash it toward the window background). Overrides come off first so
    // the computed base is the theme's own value, not a previous mix.
    for (const v of T.FG_VARS) root.style.removeProperty(v);
    const n = t.textBrightness ?? 0;
    if (n) {
      const cs = getComputedStyle(root);
      const light = (cs.colorScheme || "").includes("light");
      for (const v of T.FG_VARS) {
        const css = T.fgOverrideCss(cs.getPropertyValue(v).trim(), n, light);
        if (css) root.style.setProperty(v, css);
      }
    }

    // Frosted glass: floating surfaces go translucent. The <html> hook is
    // `glass-root` (styles.css) — a bare `.glass` here would also match the
    // card-surface rule and put a permanent backdrop-filter on the viewport
    // root. Phosphor keeps its crisp CRT look — blur under scanlines is mud.
    const glass = !!t.glassEffect && t.theme !== "phosphor";
    root.classList.toggle("glass-root", glass);
    root.style.setProperty("--glass-alpha", `${t.glassOpacity ?? 85}%`);
    root.style.setProperty("--glass-blur", `${t.glassBlur ?? 12}px`);
  }, [t.theme, t.density, t.accent, t.monoChat, t.fontSize, t.chatWidth,
      t.textBrightness, t.glassEffect, t.glassOpacity, t.glassBlur]);
}

// Background image tweak. The tweak stores a path inside the app's data
// dir (pick_background_image copies the choice there); the bytes come back
// over IPC and become a blob: URL, which the img-src CSP already allows —
// file:/asset: would need CSP and asset-protocol changes for no benefit.
function useBackgroundImage(t) {
  const { bgImage, bgImageDim = 40, bgImageBlur = 0 } = t;

  // Path → blob URL (one file read per change, revoked on cleanup).
  React.useEffect(() => {
    const root = document.documentElement;
    if (!bgImage) {
      root.classList.remove("has-bg-image");
      root.style.removeProperty("--bg-image");
      return;
    }
    let alive = true, url = null;
    (async () => {
      const ext = String(bgImage).split(".").pop();
      const { data } = await window.__TAURI__.core.invoke("read_file_bytes", { path: bgImage });
      if (!alive) return;
      const blob = window.OMP_THEME.base64ToBlob(data, window.OMP_DROPPED?.IMAGE_MIME?.[String(ext).toLowerCase()]);
      url = URL.createObjectURL(blob);
      root.style.setProperty("--bg-image", `url("${url}")`);
      root.classList.add("has-bg-image");
    })().catch((e) => {
      // File unreadable (deleted, permissions): fall back to the theme's
      // plain backdrop rather than wedging the class on with no image.
      console.error("background image load failed", e);
      if (alive) root.classList.remove("has-bg-image");
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bgImage]);

  // Dim/blur are plain variable writes — no need to reload the image.
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bg-dim", `${bgImageDim}%`);
    root.style.setProperty("--bg-blur", `${bgImageBlur}px`);
  }, [bgImageDim, bgImageBlur]);
}


Object.assign(window, { useBridgeSnapshot, useThemeEffect, useBackgroundImage });
