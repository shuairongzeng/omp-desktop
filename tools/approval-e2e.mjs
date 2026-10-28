/* tools/approval-e2e.mjs — prove the approvals panel mode reaches omp.

   Usage: node tools/approval-e2e.mjs <cdp-port>
   1. store view says yolo for the fixture project;
   2. yolo: a bash tool request runs with NO new approval prompt and its
      output lands (fake-negative guard: the tool really ran);
   3. the panel's own project row switches to "always ask" (live.js then
      respawns the tab);
   4. the same tool request now raises a NEW approval prompt;
   5. the panel switches back to yolo (respawn argv follows the store).
   Prints one PASS/FAIL line per step; screenshots to /tmp/approval-e2e/. */

import { mkdirSync, writeFileSync } from "node:fs";

const port = process.argv[2];
const out = "/tmp/approval-e2e";
mkdirSync(out, { recursive: true });
const activeProject = "/Users/jackey/GitHub/chuti"; // fixture tab

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
  writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, "base64"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.message).slice(0, 160) });
    console.log(`FAIL ${name} — ${String(e.message).slice(0, 160)}`);
  }
  await shot(name);
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Two leftovers from earlier runs poison every later step: queued steers
// (the queue strip) get delivered after a mode-change respawn under the
// CURRENT mode and raise prompts, and an unanswered prompt keeps the turn
// waiting forever. Clear the queue first (so nothing new arrives), then
// deny the open prompts.
await ev(`(() => {
  let n = 0;
  for (const b of [...document.querySelectorAll('.queue-strip button[aria-label="remove"]')]) {
    b.click(); n++;
  }
  return n;
})()`);
await sleep(1000);
await ev(`(() => {
  let n = 0;
  for (const b of [...document.querySelectorAll('button')]) {
    if ((b.textContent || '').trim() === 'Deny') { b.click(); n++; }
  }
  return n;
})()`);
await sleep(2000);

// Idle = the composer shows no abort control (it shows one while a turn
// streams). send() steers mid-turn, which would not raise a fresh prompt.
const streamingNow = () =>
  ev(`!![...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('abort'))`);
const waitIdle = async (ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await streamingNow())) return true;
    if (Date.now() > deadline) return false;
    await sleep(1000);
  }
};
// A turn left running by an earlier step (or by denying a stale prompt) is
// ended the way a user would: the bridge's id-less abort (Esc).
const forceIdle = async () => {
  if (await waitIdle(45000)) return true;
  await ev(`(() => { try { window.OMP_BRIDGE.abort(); return 1; } catch { return 0; } })()`);
  await sleep(3000);
  return waitIdle(15000);
};
const askCount = () => ev(`document.querySelectorAll('.row.ask').length`);

// The panel: status-bar "approvals" button, then the fixture project's row.
const clickMode = async (mode) => {
  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      ((b.getAttribute('aria-label') || b.getAttribute('title') || '')).startsWith('approvals'));
    if (!btn) return 'no approvals toggle';
    btn.click();
    return 'opened';
  })()`);
  if (opened !== "opened") return opened;
  await sleep(1200);
  const clicked = await ev(`((mode) => {
    const rows = [...document.querySelectorAll('div,section')].filter(e =>
      e.textContent.includes(${JSON.stringify(activeProject)}) && e.querySelector('button'));
    const row = rows.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return 'no project row';
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === mode);
    if (!btn) return 'no ' + mode + ' button in row';
    btn.click();
    return 'clicked ' + mode;
  })(${JSON.stringify(mode)})`);
  if (!String(clicked).startsWith("clicked")) return clicked;
  await sleep(800);
  // the popover swallows the composer's Enter; close it
  await ev(`(() => {
    const x = [...document.querySelectorAll('button')].find(b =>
      (b.getAttribute('aria-label') || '') === 'close' && (b.closest('[class*="approval"]') || b.closest('[class*="popover"]')));
    if (x) { x.click(); return 'closed'; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'esc';
  })()`);
  await sleep(600);
  return clicked;
};

// 1. store says yolo for the fixture project
await check("store-yolo", async () => {
  const view = await ev(`window.__TAURI__.core.invoke('approval_mode_get', {})`);
  assert(view?.default === "yolo" || view?.projects?.[activeProject] === "yolo", JSON.stringify(view));
  return `default=${view.default} project=${view.projects?.[activeProject]}`;
});

// 2. yolo: tool runs, no new approval prompt
const marker = `yolo-${Date.now()}`;
await check("yolo-no-approval", async () => {
  assert(await forceIdle(), "composer not idle before the yolo turn");
  await ev(`(() => { window.OMP_BRIDGE.send('run this exact bash command and report its output: echo ${marker}'); return 1; })()`);
  const before = await askCount();
  let ran = false;
  let approval = false;
  for (let i = 0; i < 20 && !ran; i++) {
    await sleep(1500);
    approval = (await askCount()) > before;
    ran = await ev(`document.body.innerText.includes(${JSON.stringify(marker)})`);
    if (approval) break;
  }
  assert(!approval, "an approval prompt rendered under yolo");
  assert(ran, `tool output ${marker} never appeared (fake-negative guard)`);
  return "output present, no new prompt";
});

// 3. panel switches the project to always ask; live.js respawns
await check("set-always-ask", async () => {
  const r = await clickMode("always ask");
  assert(r === "clicked always ask", r);
  await sleep(7000);
  assert(await ev(`!document.body.innerText.includes('Agent process exited')`), "tab died on respawn");
  return "panel click -> respawn";
});

// 4. same request now raises a new approval prompt
await check("always-ask-approves", async () => {
  assert(await forceIdle(), "composer not idle before the always-ask turn");
  await ev(`(() => { window.OMP_BRIDGE.send('run this exact bash command and report its output: echo ask-${Date.now()}'); return 1; })()`);
  const before = await askCount();
  let approval = false;
  for (let i = 0; i < 15 && !approval; i++) {
    await sleep(1500);
    approval = (await askCount()) > before;
  }
  assert(approval, "no approval prompt under always-ask (policy did not reach omp)");
  return "approval prompt rendered";
});

// 5. restore yolo through the panel
await check("restore-yolo", async () => {
  const r = await clickMode("yolo");
  assert(r === "clicked yolo", r);
  await sleep(7000);
  return "restored through the panel";
});

writeFileSync(`${out}/approval-e2e.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\napproval e2e: ${results.length - failed.length}/${results.length} pass`);
ws.close();
process.exit(failed.length ? 1 : 0);
