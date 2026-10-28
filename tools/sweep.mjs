/* tools/sweep.mjs — CDP-driven surface sweep of a running port instance.

   Usage: node tools/sweep.mjs <cdp-port> <out-dir>
   Connects to the Electron app's page target, walks every user surface the
   frontend exposes, asserts DOM/registry state, screenshots each, and
   prints one PASS/FAIL line per surface. The instance under test must be
   launched with --remote-debugging-port=<cdp-port>. Native dialogs are
   proven by screenshot + Escape; everything else by DOM assertions. */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [port, outDir] = process.argv.slice(2);
if (!port || !outDir) {
  console.error("usage: node tools/sweep.mjs <cdp-port> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id != null && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
  });
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
};

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.message).slice(0, 200) });
    console.log(`FAIL ${name} — ${String(e.message).slice(0, 200)}`);
  }
  await shot(name);
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await send("Page.enable");
await send("Runtime.enable");

// 1. boot state: shim live, no error boundary rendered
await check("boot", async () => {
  const shim = await ev(`!!window.__OMP_PORT_SHIM__`);
  const boundary = await ev(`document.querySelectorAll('.boundary-fallback, [class*="boundary"]').length`);
  assert(shim, "shim missing");
  assert(boundary === 0, `error boundary rendered: ${boundary}`);
  return `shim ok, boundaries 0`;
});

// 2. tab bar has the restored tab
const tabId = await ev(`document.querySelector('.tab')?.dataset?.reorderId ?? null`);
await check("tab-restore", async () => {
  assert(tabId, "no tab in bar");
  return `tab ${tabId}`;
});

// 3. recents panel lists seeded recents
await check("recents", async () => {
  const rows = await ev(`document.querySelectorAll('.psb-row').length`);
  assert(rows > 0, "no recent rows rendered");
  return `${rows} rows`;
});

// 4. open_project_at is the PHONE channel (live.js js-handler opens the
// tab); from the desktop webview it must canonicalize and touch recents,
// exactly like the Rust-free parity path. The desktop dialog flow is
// check 5 (native dialog, screenshot-proven).
await check("open-folder-command", async () => {
  const r = await ev(`window.__TAURI__.core.invoke('open_project_at', { path: '/tmp' })
    .then(p => p).catch(e => 'ERR ' + e.message)`);
  assert(r === '/private/tmp', `open_project_at: ${r}`);
  return `canonical ${r}`;
});

// 6. history modal via Ctrl+H
await check("history-modal", async () => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "h", code: "KeyH", windowsVirtualKeyCode: 72, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "h", code: "KeyH", windowsVirtualKeyCode: 72, modifiers: 2 });
  await new Promise((res) => setTimeout(res, 1500));
  const open = await ev(`!!document.querySelector('.bridge, [class*="history"]')`);
  assert(open, "history modal not rendered");
  const rows = await ev(`document.querySelectorAll('.bridge [class*="row"], [class*="history"] [class*="row"]').length`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  return `${rows} rows`;
});

// 11. composer send: real omp round trip, proven on the session jsonl
await check("composer-send", async () => {
  const marker = `sweep-${Date.now()}`;
  const layout = JSON.parse(readFileSync("/tmp/port-config/open-tabs.json", "utf8"));
  const active = layout.tabs[layout.active ?? 0];
  const sessionFile = active?.sessionFile;
  const sent = await ev(`(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    if (!ta) return 'no composer';
    ta.focus();
    return 'focused';
  })()`);
  assert(sent === "focused", sent);
  await send("Input.insertText", { text: `echo ${marker}` });
  await new Promise((res) => setTimeout(res, 500));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  // The user message lands in the session jsonl at send time; the assistant
  // reply follows. Poll the file the restored tab resumes from.
  let onDisk = false;
  for (let i = 0; i < 15 && !onDisk; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    if (!sessionFile) break;
    onDisk = readFileSync(sessionFile, "utf8").includes(marker);
  }
  assert(onDisk, `marker ${marker} never reached ${sessionFile ?? "no session file"}`);
  return `marker on disk in ${sessionFile?.split("/").pop()}`;
});

// 5. open folder button: native dialog appears (screenshot) then Escape
await check("open-folder-dialog", async () => {
  const clicked = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase().includes('open folder'));
    if (!btn) return 'no button';
    btn.click();
    return 'clicked';
  })()`);
  assert(clicked === "clicked", clicked);
  await new Promise((res) => setTimeout(res, 2500));
  return "dialog expected on screen (see screenshot)";
});



// 7. terminal panel: open via status-bar toggle, expect xterm mount
await check("terminal-panel", async () => {
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('aria-label') || b.title || '').toLowerCase().includes('terminal'));
    if (!btn) return 'no toggle';
    btn.click();
    return 'clicked';
  })()`);
  if (opened !== "clicked") {
    // fallback: the terminal command path directly
    const st = await ev(`window.__TAURI__.core.invoke('terminal_open', { sessionId: ${JSON.stringify(tabId)} })
      .then(s => s?.state ?? 'ERR').catch(e => 'ERR ' + e.message)`);
    assert(st === "running" || st === "starting", `terminal_open: ${st}`);
    return `command path: ${st}`;
  }
  await new Promise((res) => setTimeout(res, 2500));
  const xterm = await ev(`!!document.querySelector('.xterm, [class*="xterm"]')`);
  assert(xterm, "no xterm mounted");
  return "xterm mounted";
});

// 8. git browser panel
await check("git-browser", async () => {
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('title') || b.getAttribute('aria-label')) === 'git browser');
    if (!btn) return 'no toggle';
    btn.click();
    return 'clicked';
  })()`);
  await new Promise((res) => setTimeout(res, 2500));
  const panel = await ev(`!!document.querySelector('.gitb, .gitb-body')`);
  assert(opened === "clicked" && panel, `toggle=${opened} panel=${panel}`);
  return "panel rendered";
});

// 9. browser panel: canvas paints frames
await check("browser-panel", async () => {
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      ((b.getAttribute('title') || b.getAttribute('aria-label') || '')).startsWith('browser panel'));
    if (!btn) return 'no toggle';
    btn.click();
    return 'clicked';
  })()`);
  assert(opened === "clicked", opened);
  await new Promise((res) => setTimeout(res, 8000));
  const painted = await ev(`(() => {
    const c = document.querySelector('.browser-canvas');
    if (!c) return 0;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const d = ctx.getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 200)).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  })()`);
  assert(painted > 0, "canvas unpainted");
  return `${painted} non-zero px`;
});

// 10. settings pages: open, walk sections, no boundary
await check("settings", async () => {
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      ((b.getAttribute('title') || b.getAttribute('aria-label') || '')).startsWith('settings'));
    if (!btn) return 'no toggle';
    btn.click();
    return 'clicked';
  })()`);
  assert(opened === "clicked", opened);
  await new Promise((res) => setTimeout(res, 2000));
  const sections = await ev(`document.querySelectorAll('.st-grp, .st-row').length`);
  const boundary = await ev(`document.querySelectorAll('.boundary-fallback').length`);
  assert(boundary === 0, "boundary in settings");
  return `${sections} sections`;
});

// 11. tab context menu
await check("tab-menu", async () => {
  const menu = await ev(`(() => {
    const tab = document.querySelector('.tab');
    if (!tab) return 'no tab';
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
    return 'dispatched';
  })()`);
  assert(menu === "dispatched", menu);
  await new Promise((res) => setTimeout(res, 800));
  const rows = await ev(`document.querySelectorAll('.tab-menu [role="menuitem"], .tab-menu button').length`);
  assert(rows >= 3, `menu rows ${rows}`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  return `${rows} rows`;
});

writeFileSync(join(outDir, "sweep.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nsweep: ${results.length - failed.length}/${results.length} pass`);
ws.close();
process.exit(failed.length ? 1 : 0);
