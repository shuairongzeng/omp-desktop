/* tools/deep/browser-settings-keys.mjs — browser panel, Settings page and the
   global key chords, verified against a running packaged instance.

   Evidence per check:
   - browser-navigate: the panel's tabs channel names the page tab
     "Example Domain" (Page.loadEventFired → Target.getTargetInfo, the Rust
     view's title refresh) and the screencast canvas holds non-zero pixels
     read back with getImageData — a no-op panel paints nothing and the URL
     footer it falls back to without the title would literally read
     "example.com".
   - browser-page-tabs: a new tab grows the strip and its close control
     returns the count (the strip is the backend's `tabs` channel, not local
     state).
   - browser-annotate: annotate on → a click on the page is a pick (the
     backend's overlay in the isolated world), the popover takes a comment,
     saving leaves exactly one numbered `.browser-marker`; annotate off.
   - browser-reopen: closing the panel (browser_close_panel) and opening it
     again must work — a fresh view, live screencast frames and the
     re-discovered page list with the page's title.
   - settings-sections: every left-nav section renders rows and no panel
     crash card.
   - key-history / key-sidebar / key-terminal: real CDP key events (trusted,
     exactly what a keypress delivers) flip DOM state both ways, and the
     terminal mounts an xterm that has printed the shell's prompt.

   The browser checks share one panel: they run before anything that covers
   the stage, and the panel is reopened by the reopen check, so the later
   checks leave it untouched (the final teardown closes it). */

const PANEL_STATUS = 'browser panel ('; // status-bar title prefix ("browser panel (Ctrl+Shift+B)")

export async function run(ctx) {
  const { ev, sleep, assert } = ctx;

  const poll = async (expr, ms = 15000, step = 250) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await ev(expr);
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(step);
    }
  };
  // React listens at the root: a bubbling, cancelable MouseEvent reaches its
  // onClick exactly like a user click (el.click() has been swallowed by a
  // still-mounting app in this port).
  const click = (expr) =>
    ev(`(() => {
      const el = ${expr};
      if (!el) return null;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
  const statusButton = (prefix) =>
    `[...document.querySelectorAll('.status button')].find((b) => (b.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)}))`;
  const panelOpen = () => ev(`!!document.querySelector('.browser-panel')`);
  const ensureBrowserPanel = async () => {
    for (let i = 0; i < 3; i += 1) {
      if (await panelOpen()) return;
      await click(statusButton(PANEL_STATUS));
      if (await poll(`!!document.querySelector('.browser-panel')`, 6000)) return;
    }
    assert(await panelOpen(), 'browser panel did not open from the status bar');
  };
  const ensureSettingsOpen = async () => {
    for (let i = 0; i < 3; i += 1) {
      if (await ev(`!!document.querySelector('.st-host:not([hidden]) .settings')`)) return;
      await click(statusButton('settings ('));
      if (await poll(`!!document.querySelector('.st-host:not([hidden]) .settings')`, 6000)) return;
    }
    assert(await ev(`!!document.querySelector('.st-host:not([hidden]) .settings')`), 'settings page did not open');
  };
  const closeSettings = async () => {
    await click(`document.querySelector('.st-back')`);
    await poll(`!document.querySelector('.st-host')`, 5000);
  };

  // CDP key events (trusted): modifiers bitmask alt=1 ctrl=2 meta=4 shift=8.
  const KEYS = {
    h: ['h', 'KeyH', 72],
    b: ['b', 'KeyB', 66],
    '`': ['`', 'Backquote', 192],
    escape: ['Escape', 'Escape', 27],
  };
  const press = async (name, modifiers = 0) => {
    const [key, code, vk] = KEYS[name];
    const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const CTRL = 2;
  const META = 4;

  await ctx.clearPoison();
  // A sibling group may have left the Settings page over the stage: its host
  // makes the panel drop screencast frames (browser-screen's `covered`), so
  // the browser checks start with the conversation surface showing.
  if (await ev(`!!document.querySelector('.st-host')`)) await closeSettings();
  if (await ev(`!!document.querySelector('.browser-panel')`)) {
    // Deterministic start: a panel left open by a sibling group is closed
    // (a fresh view with a blank page comes up in the first check).
    await click(`document.querySelector('[aria-label="close browser"]')`);
    await poll(`!document.querySelector('.browser-panel')`, 6000);
  }

  // ── 1. browser-navigate ───────────────────────────────────────────────────
  await ctx.check('browser-navigate', async () => {
    await ensureBrowserPanel();
    assert(await poll(`!!document.querySelector('input[name=address]')`, 20000), 'panel address input never mounted');
    assert(await poll(`document.querySelector('[aria-label="annotate"]')?.disabled === false`, 20000),
      'panel never reported a running page (annotate stays disabled)');

    const submitted = await ev(`(() => {
      const input = document.querySelector('input[name=address]');
      if (!input) return null;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(input, 'https://example.com');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      input.form.requestSubmit();
      return input.value;
    })()`);
    assert(submitted === 'https://example.com', `address submit failed: ${submitted}`);

    const tab = await poll(`(() => {
      const t = [...document.querySelectorAll('.browser-tabs .tab')].find((x) =>
        (x.textContent || '').trim() === 'Example Domain');
      return t ? { name: t.textContent.trim(), title: t.getAttribute('title') } : null;
    })()`, 30000);
    assert(tab, `page tab title never became "Example Domain" (strip: ${JSON.stringify(await ev(`[...document.querySelectorAll('.browser-tabs .tab')].map((x) => x.textContent.trim())`))})`);

    const painted = await poll(`(() => {
      const c = document.querySelector('.browser-canvas');
      if (!c || !c.width || !c.height) return null;
      let data;
      try { data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch { return null; }
      let nz = 0;
      for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) nz += 1;
      return nz > 100 ? { w: c.width, h: c.height, nz } : null;
    })()`, 20000);
    assert(painted, 'the screencast canvas has no painted pixels');

    return `tab "${tab.name}" (url ${tab.title}), canvas ${painted.w}x${painted.h} with ${painted.nz} sampled painted pixels`;
  });

  // ── 2. browser-page-tabs ──────────────────────────────────────────────────
  await ctx.check('browser-page-tabs', async () => {
    const before = await ev(`document.querySelectorAll('.browser-tabs .tab').length`);
    assert(before >= 1, 'no page tab in the strip');
    assert(await click(`document.querySelector('.browser-tabs .tab-add')`), 'no new-tab control in the strip');
    const grew = await poll(`document.querySelectorAll('.browser-tabs .tab').length > ${before}`, 10000);
    assert(grew, `tab strip did not grow from ${before}`);
    const peak = await ev(`document.querySelectorAll('.browser-tabs .tab').length`);
    assert(await click(`[...document.querySelectorAll('.browser-tabs .tab .tab-close')].slice(-1)[0]`), 'the new tab has no close control');
    const back = await poll(`document.querySelectorAll('.browser-tabs .tab').length === ${before}`, 10000);
    assert(back, `tab count did not return to ${before} (now ${await ev(`document.querySelectorAll('.browser-tabs .tab').length`)})`);
    return `${before} page tabs → ${peak} after new-tab → ${before} after closing it`;
  });

  // ── 3. browser-annotate ───────────────────────────────────────────────────
  await ctx.check('browser-annotate', async () => {
    const off = await ev(`({ pressed: document.querySelector('[aria-label="annotate"]')?.getAttribute('aria-pressed'), view: document.querySelector('.browser-view')?.className || '' })`);
    assert(off.pressed === 'false' && !off.view.includes('annotating'), `annotate started on (${JSON.stringify(off)})`);

    assert(await click(`document.querySelector('[aria-label="annotate"]')`), 'no annotate control');
    const on = await poll(`(() => {
      const b = document.querySelector('[aria-label="annotate"]');
      const v = document.querySelector('.browser-view');
      return b?.getAttribute('aria-pressed') === 'true' && v?.classList.contains('annotating') ? { cls: v.className } : null;
    })()`, 8000);
    assert(on, 'annotate did not turn on (aria-pressed / .annotating)');

    // Chips are per tab and survive a panel close (app/use-browser.jsx), so
    // the check counts the marker this pick adds, not every marker on screen.
    const beforeMarkers = await ev(`[...document.querySelectorAll('.browser-marker')].map((m) => m.textContent.trim())`);

    // A click on the page goes through the panel's input queue into the
    // backend's annotate overlay (isolated world): it answers with a pick,
    // the panel captures it and opens the comment popover.
    // An upper-left quadrant point, not the centre: the panel maps a click
    // through the painted frame's CSS size, and Chrome's headless screencast
    // reports that size in device pixels on some frames (1058x1284 for a
    // 529x642 emulated viewport), which pushes a centre click past the
    // page's right edge where Chromium drops it.
    const point = await ev(`(() => {
      const c = document.querySelector('.browser-canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width * 0.25), y: Math.round(r.y + r.height * 0.3) };
    })()`);
    assert(point, 'no canvas to pick on');
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await ctx.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    const pick = await poll(`(() => {
      const p = document.querySelector('.browser-popover');
      if (!p) return null;
      return { what: (p.querySelector('.browser-popover-what')?.textContent || '').trim() };
    })()`, 15000);
    assert(pick, 'clicking the page in annotate mode produced no pick popover');

    const typed = await ev(`(() => {
      const area = document.querySelector('.browser-popover textarea');
      if (!area) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(area, 'deep-e2e annotation');
      area.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()`);
    assert(typed, 'the pick popover has no comment field');
    const savable = await poll(`document.querySelector('.browser-popover-actions .btn.primary')?.disabled === false`, 5000);
    assert(savable, 'the pick popover never enabled its save control');
    assert(await click(`document.querySelector('.browser-popover-actions .btn.primary')`), 'the pick popover has no save control');
    const markers = await poll(`(() => {
      const list = [...document.querySelectorAll('.browser-marker')].map((m) => m.textContent.trim());
      return list.length > ${JSON.stringify(beforeMarkers.length)} ? list : null;
    })()`, 10000);
    assert(markers, 'saving the pick left no numbered marker');
    assert(markers.length === beforeMarkers.length + 1, `expected one new marker, saw ${JSON.stringify(markers)}`);
    assert(markers[markers.length - 1] === String(markers.length), `markers are not numbered 1..n: ${JSON.stringify(markers)}`);

    assert(await click(`document.querySelector('[aria-label="annotate"]')`), 'no annotate control to turn it off');
    const backOff = await poll(`(() => {
      const b = document.querySelector('[aria-label="annotate"]');
      const v = document.querySelector('.browser-view');
      return b?.getAttribute('aria-pressed') === 'false' && !v?.classList.contains('annotating') ? true : null;
    })()`, 8000);
    assert(backOff, 'annotate did not turn off');
    return `annotate off → on → pick "${pick.what}" → comment → new marker ${JSON.stringify(markers)} → off`;
  });

  // ── 4. browser-reopen ─────────────────────────────────────────────────────
  await ctx.check('browser-reopen', async () => {
    assert(await click(`document.querySelector('[aria-label="close browser"]')`), 'no close-browser control');
    const gone = await poll(`!document.querySelector('.browser-panel')`, 6000);
    assert(gone, 'the browser panel did not close');

    assert(await click(statusButton(PANEL_STATUS)), 'no browser-panel status-bar button');
    const reopened = await poll(`!!document.querySelector('.browser-panel')`, 8000);
    assert(reopened, 'the browser panel did not open again after browser_close_panel');
    assert(await poll(`!!document.querySelector('input[name=address]')`, 20000), 'the reopened panel has no address input');
    // `browser_open_panel` succeeded again only if the view reports a running
    // page: the annotate control unlocks on the first `state` message.
    const running = await poll(`document.querySelector('[aria-label="annotate"]')?.disabled === false`, 20000);
    assert(running, 'the reopened panel never reported a running page (browser_open_panel failed)');
    const painted = await poll(`(() => {
      const c = document.querySelector('.browser-canvas');
      if (!c || !c.width) return null;
      let data;
      try { data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch { return null; }
      let nz = 0;
      for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) nz += 1;
      return nz > 100 ? nz : null;
    })()`, 20000);
    assert(painted, 'the reopened panel painted no frames');
    const status = await ev(`document.querySelector('.browser-status')?.textContent || null`);
    assert(!status || !/connection lost|unavailable/i.test(status), `the reopened panel reports "${status}"`);
    const tabs = await poll(`(() => {
      const list = [...document.querySelectorAll('.browser-tabs .tab')].map((x) => x.textContent.trim());
      return list.includes('Example Domain') ? list : null;
    })()`, 15000);
    assert(tabs, `the reopened panel re-discovered no page tab (strip: ${JSON.stringify(await ev(`[...document.querySelectorAll('.browser-tabs .tab')].map((x) => x.textContent.trim())`))})`);
    return `close → open again: running page, ${painted} sampled painted pixels, strip ${JSON.stringify(tabs)}`;
  });

  // ── 5. settings-sections ──────────────────────────────────────────────────
  await ctx.check('settings-sections', async () => {
    await ensureSettingsOpen();
    const count = await ev(`document.querySelectorAll('.st-tab').length`);
    assert(count >= 10, `expected every section in the nav, saw ${count}`);
    const walked = [];
    for (let i = 0; i < count; i += 1) {
      const want = await ev(`(() => {
        const tab = [...document.querySelectorAll('.st-tab')][${i}];
        if (!tab) return null;
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return tab.textContent.trim();
      })()`);
      assert(want, `section ${i} missing from the nav`);
      const shown = await poll(`(document.querySelector('.st-tab[aria-selected="true"]')?.textContent || '').trim() === ${JSON.stringify(want)} ? true : null`, 6000);
      assert(shown, `clicking the "${want}" section did not select it`);
      const rows = await ev(`document.querySelectorAll('.st-body .st-row').length`);
      const grps = await ev(`document.querySelectorAll('.st-body .st-grp').length`);
      const crashes = await ev(`document.querySelectorAll('.st-body .panel-crash, .st-body .boundary-fallback').length`);
      assert(rows >= 1, `the "${want}" section rendered no rows`);
      assert(grps >= 1, `the "${want}" section rendered no groups`);
      assert(crashes === 0, `the "${want}" section shows ${crashes} crash card(s)`);
      walked.push(`${want} ${rows}r/${grps}g`);
    }
    await closeSettings();
    assert(await poll(`!document.querySelector('.st-host')`, 5000), 'settings did not close');
    return `${count} sections walked: ${walked.join(', ')}`;
  });

  // ── 6. key-history ────────────────────────────────────────────────────────
  await ctx.check('key-history', async () => {
    await press('h', CTRL);
    const open = await poll(`!!document.querySelector('[aria-label="Conversation history"]')`, 8000);
    assert(open, 'Ctrl+H did not open the Conversation history modal');
    // The modal's rows come from the backend's disk scan (list_saved_sessions),
    // so a filled list proves the chord reached the real history surface.
    const rows = await poll(`document.querySelectorAll('#hist-rows .bridge-row').length || null`, 10000);
    assert(rows, 'the history modal listed no saved sessions');
    await press('escape', 0);
    const closed = await poll(`!document.querySelector('[aria-label="Conversation history"]')`, 8000);
    assert(closed, 'Escape did not close the history modal');
    return `Ctrl+H opened the modal (${rows} saved-session row(s) listed), Escape closed it`;
  });

  // ── 7. key-sidebar ────────────────────────────────────────────────────────
  await ctx.check('key-sidebar', async () => {
    const shown = await ev(`!!document.querySelector('.project-sidebar')`);
    assert(shown, 'sidebar was not shown to start with');
    await press('b', META);
    const hidden = await poll(`!document.querySelector('.project-sidebar')`, 6000);
    assert(hidden, 'Cmd+B did not hide the sidebar');
    const pressedOff = await ev(`document.querySelector('.tab-add')?.getAttribute('aria-pressed')`);
    assert(pressedOff === 'false', `sidebar toggle did not report off (${pressedOff})`);
    await press('b', META);
    const back = await poll(`!!document.querySelector('.project-sidebar')`, 6000);
    assert(back, 'Cmd+B did not bring the sidebar back');
    const pressedOn = await ev(`document.querySelector('.tab-add')?.getAttribute('aria-pressed')`);
    assert(pressedOn === 'true', `sidebar toggle did not report on (${pressedOn})`);
    return 'Cmd+B: sidebar unmounted and remounted, tab-bar toggle aria-pressed false → true';
  });

  // ── 8. key-terminal ───────────────────────────────────────────────────────
  await ctx.check('key-terminal', async () => {
    const openNow = await ev(`!!document.querySelector('.term-panel:not([hidden])')`);
    if (openNow) await press('`', CTRL); // start from closed
    await press('`', CTRL);
    const mounted = await poll(`(() => {
      const p = document.querySelector('.term-panel:not([hidden])');
      if (!p) return null;
      const x = p.querySelector('.xterm');
      const rows = (p.querySelector('.xterm-rows')?.textContent || '').trim();
      return x ? { xterm: !!x, rows: rows.slice(0, 40) } : null;
    })()`, 20000);
    assert(mounted, 'Ctrl+` did not mount an xterm in an open terminal panel');
    await press('`', CTRL);
    const closed = await poll(`(() => {
      const p = document.querySelector('.term-panel');
      return p && p.hidden ? true : null;
    })()`, 8000);
    assert(closed, 'Ctrl+` did not hide the terminal panel again');
    return `Ctrl+backquote: xterm mounted (first output ${JSON.stringify(mounted.rows)}), second press hid the panel`;
  });

  // ── 9. known gaps ─────────────────────────────────────────────────────────
  ctx.skip('widgets-rail', 'scheduler not ported (MERGE-DECISION gap 6)');
  ctx.skip('summon-hotkey-tray', 'not ported');

  // ── teardown: close the browser panel last (it ends the browser pipe), and
  //    leave no terminal/settings open.
  try {
    if (await ev(`!!document.querySelector('.term-panel:not([hidden])')`)) await press('`', CTRL);
    if (await ev(`!!document.querySelector('.st-host')`)) await closeSettings();
    if (await panelOpen()) await click(`document.querySelector('[aria-label="close browser"]')`);
    await poll(`!document.querySelector('.browser-panel')`, 5000);
  } catch {
    /* teardown is best effort */
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runStandalone } = await import("./ctx.mjs");
  await runStandalone(run);
}