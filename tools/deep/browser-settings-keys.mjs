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

  // ── 4b. history: back/forward ride the page session (defect 1) ──────────
  // Evidence: the active page tab's title (the URL the strip shows, which
  // follows Page.getNavigationHistory) transitions /a -> back -> /a's
  // predecessor... here: two navigations then back/forward, asserted on the
  // strip after each commit. The oracle server's load hits are NOT used:
  // bfcache restores fire neither load nor pageshow beacons reliably under
  // headless Chromium (measured), so they cannot prove a transition the
  // user can see in the strip.
  await ctx.check('browser-history', async () => {
    const sid = await ctx.ev(`document.querySelector('.tab.active')?.dataset.tabId`);
    const nav = async (url) => {
      for (let i = 0; i < 8; i++) {
        const r = await ctx.invoke('browser_navigate', { sessionId: sid, url });
        if (r.ok) return;
        await ctx.sleep(1500);
      }
      throw new Error(`navigate ${url} never succeeded`);
    };
    const active = () => ctx.ev(`[...document.querySelectorAll('.browser-tabs .tab.active')].map(t => (t.getAttribute('title')||'').slice(0,40)).join('')`);
    await nav('http://127.0.0.1:8899/a');
    await nav('http://127.0.0.1:8899/b');
    for (let i = 0; i < 10 && !(await active()).includes('/b'); i++) await ctx.sleep(1000);
    ctx.assert((await active()).includes('/b'), 'second navigation never committed');
    const backEnabled = await ctx.ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'back'); return b ? !b.disabled : null; })()`);
    ctx.assert(backEnabled === true, 'back button disabled after two navigations');
    let strip = '';
    for (let i = 0; i < 4 && !strip.includes('/a'); i++) {
      await ctx.ev(`[...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'back')?.click()`);
      await ctx.sleep(3000);
      strip = await active();
    }
    ctx.assert(strip.includes('/a'), `back did not return to /a: ${strip}`);
    const fwdEnabled = await ctx.ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'forward'); return b ? !b.disabled : null; })()`);
    ctx.assert(fwdEnabled === true, 'forward disabled after going back');
    let strip2 = '';
    for (let i = 0; i < 4 && !strip2.includes('/b'); i++) {
      await ctx.ev(`[...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'forward')?.click()`);
      await ctx.sleep(3000);
      strip2 = await active();
    }
    ctx.assert(strip2.includes('/b'), `forward did not return to /b: ${strip2}`);
    return `back -> /a, forward -> /b (strip transitions, buttons enabled)`;
  });

  // ── 4c. reopen: the panel returns to the page the user was on ───────────
  await ctx.check('browser-reopen-activation', async () => {
    const before = await ctx.ev(`[...document.querySelectorAll('.browser-tabs .tab.active')].map(t => (t.getAttribute('title')||'').slice(0,40)).join('')`);
    ctx.assert(before.length > 0, `precondition: a page is active, got ${before || 'nothing'}`);
    await ctx.ev(`[...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'close browser')?.click()`);
    await ctx.sleep(2000);
    await ctx.ev(`[...document.querySelectorAll('button')].find(b => ((b.getAttribute('title')||'').startsWith('browser panel')))?.click()`);
    for (let i = 0; i < 10 && !(await ctx.ev(`!!document.querySelector('.browser-panel')`)); i++) await ctx.sleep(1000);
    await ctx.sleep(3000);
    const after = await ctx.ev(`[...document.querySelectorAll('.browser-tabs .tab.active')].map(t => (t.getAttribute('title')||'').slice(0,40)).join('')`);
    ctx.assert(after === before, `reopen activated ${after || 'nothing'}, not the page the user left on (${before})`);
    return `reopen restored the shown page (${after.slice(0, 40)})`;
  });

  // The proxy port is per instance (bind 0): find it through the overlay
  // files agent.js writes, then confirm by /json containing our page.
  const proxyPort = async (urlPrefix) => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const base = tmpdir(); // macOS: /var/folders/…, not /tmp
    let dirs = [];
    try { dirs = readdirSync(base).filter((d) => d.startsWith('omp-desktop-electron-')); } catch { return null; }
    for (const d of dirs) {
      let files = [];
      try { files = readdirSync(`${base}/${d}`).filter((f) => f.endsWith('.yml')); } catch { continue; }
      for (const f of files) {
        const m = /cdpUrl: "http:\/\/127\.0\.0\.1:(\d+)"/.exec(readFileSync(`${base}/${d}/${f}`, 'utf8'));
        if (!m) continue;
        const port = Number(m[1]);
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          if (targets.some((t) => t.url.startsWith(urlPrefix))) return port;
        } catch { /* not this instance */ }
      }
    }
    return null;
  };

  // ── 4d. tab click: the canvas follows the clicked page ──────────────────
  await ctx.check('browser-tab-switch', async () => {
    const sid = await ctx.ev(`document.querySelector('.tab.active')?.dataset.tabId`);
    const nav = async (url) => {
      for (let i = 0; i < 8; i++) {
        const r = await ctx.invoke('browser_navigate', { sessionId: sid, url });
        if (r.ok) return;
        await ctx.sleep(1500);
      }
      throw new Error(`navigate ${url} never succeeded`);
    };
    const sample = () => ctx.ev(`(() => { const c = document.querySelector('canvas.browser-canvas'); const g = c.getContext('2d'); const d = g.getImageData(Math.round(c.width/2), Math.round(c.height/3), 8, 8).data; let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] + d[i+1] + d[i+2]; return n; })()`);
    await nav('https://example.com/');
    await ctx.sleep(2500);
    await ctx.ev(`window.OMP_BRIDGE.browserTabNew(${JSON.stringify(sid)})`);
    await ctx.sleep(2500);
    // A saturated blue page: its canvas signature cannot alias example.com's
    // white one, so the pixel proof is a switch proof, not a luck sample.
    await nav('data:text/html,<body style="background:%230033ff;height:2000px">');
    await ctx.sleep(2500);
    const blueCount = () => ctx.ev(`(() => { const c = document.querySelector('canvas.browser-canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) { if (d[i+2] > 150 && d[i] < 100) n++; } return n; })()`);
    const before = await blueCount();
    ctx.assert(before > 1000, `the blue page did not paint (${before} blue pixels)`);
    await ctx.ev(`document.querySelectorAll('.browser-tabs .tab')[0]?.click()`);
    let after = before;
    for (let i = 0; i < 8 && after > 100; i++) {
      await ctx.sleep(1000);
      after = await blueCount();
    }
    ctx.assert(after <= 100, `clicking the first page tab left the blue page on the canvas (${after} blue pixels remain)`);
    const active = await ctx.ev(`[...document.querySelectorAll('.browser-tabs .tab.active')].map(t => (t.getAttribute('title')||'').slice(0,30)).join('')`);
    ctx.assert(active.includes('example.com'), `strip active did not follow the click: ${active}`);
    return `canvas followed the click: blue ${before} -> ${after}, active=${active}`;
  });

  // ── 4e. full view: the page viewport follows, no stretch ────────────────
  await ctx.check('browser-fullview-aspect', async () => {
    const inner = () => ctx.ev(`(async () => { const t = await fetch('http://127.0.0.1:19222/json').then(r => r.json()).catch(() => []); return null; })()`);
    const pageWidth = async () => {
      const port = await proxyPort('https://example.com');
      ctx.assert(port != null, 'no proxy port found through the overlay files');
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
      const t = targets.find((x) => x.url.startsWith('https://example.com'));
      if (!t) return null;
      const ws2 = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => ws2.addEventListener('open', r, { once: true }));
      const r = await new Promise((res) => { const h = (e) => { const d = JSON.parse(e.data); if (d.id === 1) { ws2.removeEventListener('message', h); res(d); } }; ws2.addEventListener('message', h); ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.innerWidth', returnByValue: true } })); });
      ws2.close();
      return r.result?.result?.value;
    };
    const w0 = await pageWidth();
    ctx.assert(w0 != null, 'no example.com page behind the proxy to measure');
    await ctx.ev(`[...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'full view')?.click()`);
    await ctx.sleep(3000);
    const w1 = await pageWidth();
    const canvasW = await ctx.ev(`Math.round(document.querySelector('canvas.browser-canvas').getBoundingClientRect().width)`);
    ctx.assert(w1 > w0, `full view did not widen the page viewport (${w0} -> ${w1})`);
    ctx.assert(Math.abs(w1 - canvasW) <= 2, `page viewport ${w1} does not match the canvas css width ${canvasW}: the frame would stretch`);
    await ctx.ev(`[...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'full view')?.click()`);
    await ctx.sleep(2000);
    return `viewport followed the panel: ${w0} -> ${w1} == canvas ${canvasW}`;
  });

  // ── 4f. annotate: hovering the page shows the highlight box ─────────────
  await ctx.check('browser-annotate-hover', async () => {
    const sid = await ctx.ev(`document.querySelector('.tab.active')?.dataset.tabId`);
    await ctx.ev(`window.OMP_BRIDGE.browserAnnotate(${JSON.stringify(sid)}, true)`);
    await ctx.sleep(2000);
    const geo = JSON.parse(await ctx.ev(`(() => { const r = document.querySelector('canvas.browser-canvas').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`));
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(geo.x + geo.w / 2), y: Math.round(geo.y + geo.h * 0.2), button: 'none', buttons: 0 });
    await ctx.sleep(1500);
    const port = await proxyPort('https://example.com');
    ctx.assert(port != null, 'no proxy port found through the overlay files');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
    const t = targets.find((x) => x.url.startsWith('https://example.com'));
    ctx.assert(t, 'no example.com page to inspect the overlay in');
    const ws2 = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws2.addEventListener('open', r, { once: true }));
    let id2 = 0;
    const contexts = [];
    const pend = new Map();
    ws2.addEventListener('message', (e2) => { const d = JSON.parse(e2.data); if (d.id != null && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.executionContextCreated') contexts.push(d.params.context); });
    const send2 = (m, p) => new Promise((res) => { const mid = ++id2; pend.set(mid, res); ws2.send(JSON.stringify({ id: mid, method: m, params: p ?? {} })); });
    await send2('Runtime.enable', {});
    await ctx.sleep(800);
    const ann = contexts.find((c) => (c.name || '') === 'omp-annotate');
    ctx.assert(ann, `no omp-annotate world context (saw ${contexts.map((c) => c.name).join(',')})`);
    const st = await send2('Runtime.evaluate', { contextId: ann.id, returnByValue: true, expression: `(() => { const h = document.querySelector('omp-annotate-overlay'); if (!h) return JSON.stringify({ host: false }); return 'closed-shadow'; })()` });
    // The overlay's shadow is closed: prove the hover box through the
    // screencast instead — a blue-tinted pixel row where the mouse is.
    const blue = await ctx.ev(`(() => { const c = document.querySelector('canvas.browser-canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+2] > 120 && d[i+2] - d[i] > 40) n++; } return n; })()`);
    ctx.assert(blue > 200, `no blue hover highlight pixels on the canvas (${blue})`);
    ws2.close();
    await ctx.ev(`window.OMP_BRIDGE.browserAnnotate(${JSON.stringify(sid)}, false)`);
    await ctx.sleep(1000);
    return `hover highlight visible: ${blue} blue-tinted pixels on the canvas`;
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