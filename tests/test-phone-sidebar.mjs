/* tests/test-phone-sidebar.mjs — NOT in the npm test chain (needs the live
   production relay, a running desktop with CDP and a phone-profile Chrome):
   proves the phone drawer's three click paths against a real desktop:

   1. history row click  → new tab + its transcript renders + drawer closes
   2. recent row click   → the project group appears expanded with its
      on-disk history rows listed
   3. that history row   → transcript renders on the phone

   Usage: node tests/test-phone-sidebar.mjs <desktop-cdp-port> <phone-cdp-port>
   The phone browser must be unpaired (fresh profile); the script pairs it
   through the desktop's Settings → Remote QR code. */

import { execSync } from "node:child_process";

const DESK = Number(process.argv[2] ?? 9425);
const PHONE = Number(process.argv[3] ?? 9511);
const RELAY = "https://39.105.79.222.nip.io/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = async (port) => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === mid) { ws.removeEventListener("message", h); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 160));
    return r.result.value;
  };
  await send("Runtime.enable", {});
  return { send, ev };
};

const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} — ${detail}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name} — ${error.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const desk = await connect(DESK);
const phone = await connect(PHONE);
await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await phone.send("Page.navigate", { url: RELAY });
await sleep(8000);

const openDrawer = async () => {
  // The real burger path: chrome.jsx listens for omp:mobile toggle-drawer.
  if (await phone.ev(`document.documentElement.classList.contains("mobile-sidebar-open")`)) return;
  await phone.ev(`window.dispatchEvent(new CustomEvent("omp:mobile", { detail: { action: "toggle-drawer" } }))`);
  await sleep(700);
  const open = await phone.ev(`document.documentElement.classList.contains("mobile-sidebar-open")`);
  if (!open) throw new Error("the burger tap did not open the drawer");
};
const drawerRows = () => phone.ev(`[...document.querySelectorAll(".psb-row")].map(r => r.className.replace("psb-row", "").trim().slice(0, 14) + ":" + (r.textContent || "").slice(0, 22)).join(" | ")`);

await check("pair-phone", async () => {
  await desk.ev(`[...document.querySelectorAll("button")].find(b => (b.getAttribute("title") || "").startsWith("settings ("))?.click()`);
  await sleep(1200);
  await desk.ev(`[...document.querySelectorAll(".st-host button")].find(b => (b.textContent || "").trim() === "Remote")?.click()`);
  await sleep(1200);
  await desk.ev(`[...document.querySelectorAll("button")].find(b => (b.textContent || "").trim() === "配对新手机")?.click()`);
  let code = null;
  for (let i = 0; i < 12 && !code; i++) { await sleep(1000); code = await desk.ev(`document.querySelector(".remote-qr-code code")?.textContent ?? null`); }
  assert(code, "no pair code on the desktop QR modal");
  await phone.ev(`(() => { const i = document.querySelector("#remote-overlay .ro-input"); if (!i) throw new Error("no pairing overlay on the phone"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(i, ${JSON.stringify(code)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(400);
  await phone.ev(`[...document.querySelectorAll("#remote-overlay .ro-btn")].find(b => (b.textContent || "").trim() === "配对")?.click()`);
  let seen = false;
  // The relay decision window is 60 s from pair_begin; a cold phone profile
  // can take >20 s to boot /p#, so poll most of the window.
  for (let i = 0; i < 45 && !seen; i++) { await sleep(1000); seen = await desk.ev(`!!document.querySelector(".remote-pair-modal")`); }
  assert(seen, "the pair_request dialog never appeared on the desktop");
  await desk.ev(`[...document.querySelectorAll(".remote-pair-modal button")].find(b => (b.textContent || "").trim() === "允许配对")?.click()`);
  let attached = false;
  for (let i = 0; i < 20 && !attached; i++) { await sleep(1000); attached = await phone.ev(`!!document.querySelector(".composer textarea")`); }
  assert(attached, "the phone never attached to the desktop session view");
  return `paired and attached (code ${code})`;
});

let historyTitle = null;
await check("history-row-renders-transcript", async () => {
  await openDrawer();
  // expand the first project group that has history rows
  await phone.ev(`document.querySelector(".psb-row.psb-project .psb-main")?.click()`);
  await sleep(1500);
  historyTitle = await phone.ev(`(() => { const b = [...document.querySelectorAll(".psb-row.psb-history button.psb-main")].find(b => !(b.textContent || "").startsWith("all ")); if (!b) return null; const t = (b.textContent || "").trim(); b.click(); return t; })()`);
  assert(historyTitle, "no history row to click in the drawer");
  let rendered = false;
  for (let i = 0; i < 25 && !rendered; i++) {
    await sleep(1200);
    rendered = await phone.ev(`(window.OMP_BRIDGE.getState().messages || []).length > 0`);
  }
  assert(rendered, `the resumed session's transcript never rendered (clicked "${historyTitle}")`);
  const drawerOpen = await phone.ev(`document.documentElement.classList.contains("mobile-sidebar-open")`);
  assert(!drawerOpen, "the drawer stayed open after resuming a session");
  const text = await phone.ev(`(document.querySelector(".chat-scroll")?.innerText || "").slice(0, 60)`);
  return `"${historyTitle}" rendered (${text.replace(/\n/g, " ")}) with the drawer closed`;
});

await check("recent-row-expands-with-history", async () => {
  // Recents list only folders with NO open tab; earlier checks (and prior
  // runs' persisted layout) may have opened every recent folder, so close
  // everything but the active tab first — the folders return to recents.
  const closed = await phone.ev(`window.__TAURI__.core.invoke("js:list_tabs", {}).then(v => {
    const ids = v.tabs.map(t => t.id).filter(id => id !== v.active);
    return ids.length ? window.OMP_BRIDGE.closeSessions(ids).then(() => ids.length) : 0;
  })`);
  await sleep(4000);
  await openDrawer();
  // pick a recent whose folder is NOT an open group yet
  // Any recent row is the user's gesture; prefer one whose group does not
  // already list history rows (that is the case the force-expand fixes).
  const target = await phone.ev(`(() => {
    const rows = [...document.querySelectorAll(".psb-row")];
    const groupHasHistory = name => {
      const gi = rows.findIndex(r => r.classList.contains("psb-project") && (r.textContent || "").trim().startsWith(name));
      if (gi < 0) return false;
      const after = rows.slice(gi + 1);
      const end = after.findIndex(r => r.classList.contains("psb-project") || r.classList.contains("psb-recent"));
      return after.slice(0, end < 0 ? after.length : end).some(r => r.classList.contains("psb-history"));
    };
    const label = b => (b.querySelector(".psb-name")?.firstChild?.textContent || b.textContent || "").trim();
    const btns = [...document.querySelectorAll(".psb-row.psb-recent button.psb-main")];
    const row = btns.find(b => !groupHasHistory(label(b))) || btns[0];
    if (!row) return null;
    const name = label(row);
    row.click();
    return name;
  })()`);
  assert(target, "no recent row to click in the drawer");
  let listed = false;
  for (let i = 0; i < 25 && !listed; i++) {
    await sleep(1200);
    // The group renders expanded: its history rows follow the project row
    // before the next group (or the recents section) begins.
    listed = await phone.ev(`(() => {
      const rows = [...document.querySelectorAll(".psb-row")];
      const gi = rows.findIndex(r => r.classList.contains("psb-project") && (r.textContent || "").trim().startsWith(${JSON.stringify(target)}));
      if (gi < 0) return false;
      const after = rows.slice(gi + 1);
      const end = after.findIndex(r => r.classList.contains("psb-project") || r.classList.contains("psb-recent"));
      return after.slice(0, end < 0 ? after.length : end).some(r => r.classList.contains("psb-history"));
    })()`);
  }
  assert(listed, `the "${target}" group never listed its on-disk conversations`);
  return `"${target}" appeared expanded with its history rows`;
});

await check("expanded-history-row-renders", async () => {
  const title = await phone.ev(`(() => { const b = [...document.querySelectorAll(".psb-row.psb-history button.psb-main")].find(b => !(b.textContent || "").startsWith("all ")); if (!b) return null; const t = (b.textContent || "").trim(); b.click(); return t; })()`);
  assert(title, "no history row in the expanded group");
  let rendered = false;
  for (let i = 0; i < 25 && !rendered; i++) {
    await sleep(1200);
    rendered = await phone.ev(`(window.OMP_BRIDGE.getState().messages || []).length > 0`);
  }
  assert(rendered, `the second history row's transcript never rendered ("${title}")`);
  return `"${title}" rendered on the phone`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\nphone-sidebar: ${results.length - failed.length}/${results.length} pass`);
desk.ws?.close?.(); phone.ws?.close?.();
process.exit(failed.length ? 1 : 0);
