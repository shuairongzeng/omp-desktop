/* tools/deep/phone-port-e2e.mjs — the phone chain against the PORT desktop
   through the production relay, in a real Chromium at phone size:

   1. desktop (CDP): Settings → Remote → 配对新手机 → read the pair code.
   2. phone (own Chromium, iPhone metrics): hub → type the code → 配对.
   3. desktop: the pair_request dialog appears; click 允许配对.
   4. phone: the hub now lists the port desktop; select it and enter.
   5. phone: the transcript renders; send a marker message; the port's omp
      session jsonl on disk must carry it; the assistant reply streams back.

   Usage: node tools/deep/phone-port-e2e.mjs <desktop-cdp-port> <phone-cdp-port> */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DESK = Number(process.argv[2] ?? 9424);
const PHONE = Number(process.argv[3] ?? 9508);
const RELAY = "https://39.105.79.222.nip.io/";

const connect = async (port) => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const contexts = [];
  ws.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context);
  });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === mid) { ws.removeEventListener("message", h); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  await send("Runtime.enable", {});
  return { ws, send, ev, contexts };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} — ${detail}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name} — ${error.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const desk = await connect(DESK);
const phone = await connect(PHONE);
await phone.send("Security.enable", {}).catch(() => {});
await phone.send("Security.setIgnoreCertificateErrors", { override: true }).catch(() => {});
await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await phone.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });

let pairCode = null;
await check("desktop-pair-code", async () => {
  await desk.ev(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').startsWith('settings ('))?.click()`);
  await sleep(1200);
  await desk.ev(`[...document.querySelectorAll('.st-host button')].find(b => (b.textContent||'').trim() === 'Remote')?.click()`);
  await sleep(1200);
  const state = await desk.ev(`window.OMP_BRIDGE.remoteGetState().then(s => s.status)`);
  assert(state === "online", `desktop not online (${state})`);
  await desk.ev(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '配对新手机')?.click()`);
  await sleep(2500);
  pairCode = await desk.ev(`document.querySelector('.remote-qr-code code')?.textContent ?? null`);
  assert(pairCode && /^\S{4}-\S{4}$/.test(pairCode), `no pair code in the QR modal (got ${pairCode})`);
  return `pair code ${pairCode}`;
});

await check("phone-pair-submit", async () => {
  await phone.send("Page.navigate", { url: RELAY });
  await sleep(6000);
  // Unpaired first screen is the #remote-overlay card with .ro-input/.ro-btn
  const overlay = await phone.ev(`!!document.querySelector('#remote-overlay .ro-input')`);
  assert(overlay, "the phone did not show the unpaired pairing overlay");
  await phone.ev(`(() => { const i = document.querySelector('#remote-overlay .ro-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(pairCode)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(400);
  await phone.ev(`[...document.querySelectorAll('#remote-overlay .ro-btn')].find(b => (b.textContent||'').trim() === '配对')?.click()`);
  await sleep(4000);
  return `phone submitted the code and is waiting on the desktop's approval`;
});

await check("desktop-approve", async () => {
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(1000);
    seen = await desk.ev(`!!document.querySelector('.remote-pair-modal')`);
  }
  assert(seen, "the pair_request dialog never appeared on the port desktop");
  await desk.ev(`[...document.querySelectorAll('.remote-pair-modal button')].find(b => (b.textContent||'').trim() === '允许配对')?.click()`);
  await sleep(3000);
  return "pair_request dialog approved on the port desktop";
});

await check("phone-enter-port-desktop", async () => {
  // Pairing selects the device, so the phone usually enters straight into
  // the control view; the hub row is the fallback when it lands on the list.
  let entered = false;
  let rows = null;
  for (let i = 0; i < 20 && !entered; i++) {
    await sleep(1500);
    entered = await phone.ev(`!!document.querySelector('.composer textarea')`);
    if (!entered) rows = await phone.ev(`[...document.querySelectorAll('#remote-hub .rh-row')].map(r => (r.textContent||'').slice(0, 60)).join(' | ') || null`);
    if (rows && rows.includes("port-desktop")) {
      await phone.ev(`[...document.querySelectorAll('#remote-hub .rh-row')].find(r => (r.textContent||'').includes('port-desktop'))?.click()`);
      await sleep(4000);
      entered = await phone.ev(`!!document.querySelector('.composer textarea')`);
    }
  }
  assert(entered, `the phone never reached the control view (hub rows: ${rows})`);
  return `phone entered the port desktop's session view (composer live)`;
});

await check("phone-message-roundtrip", async () => {
  const marker = `phone-port-e2e-${Date.now()}`;
  await phone.ev(`(() => { const t = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(marker)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(600);
  await phone.ev(`[...document.querySelectorAll('.composer button')].find(b => (b.textContent||'').includes('send'))?.click()`);
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    await sleep(2000);
    try {
      execSync(`grep -rl ${JSON.stringify(marker)} ${join(homedir(), ".omp/agent/sessions")} 2>/dev/null | head -1`, { encoding: "utf8" });
      found = true;
    } catch { /* not yet */ }
  }
  assert(found, `the marker never reached any session jsonl on the port desktop`);
  let reply = false;
  for (let i = 0; i < 40 && !reply; i++) {
    await sleep(2000);
    // the marker's own bubble plus an assistant bubble after it
    reply = await phone.ev(`(() => { const t = document.body.innerText; const at = t.indexOf(${JSON.stringify(marker)}); return at >= 0 && t.length > at + ${marker.length} + 40; })()`);
  }
  assert(reply, "no assistant reply streamed back to the phone after the marker");
  return `marker ${marker} landed in the port's session jsonl and a reply streamed to the phone`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\nphone-port-e2e: ${results.length - failed.length}/${results.length} pass`);
desk.ws.close(); phone.ws.close();
process.exit(failed.length ? 1 : 0);
