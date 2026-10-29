/* tests/test-slash-pills.mjs — NOT in the npm test chain (needs the live
   production relay, a running desktop with CDP and a fresh phone-profile
   Chrome): proves the composer's frequent-slash-command pills end to end
   on a wide remote client (same Composer component as the desktop):

   1. send `/status <marker>`  → a `/usage` pill appears in .composer-foot
   2. draft "hello draft", click the pill → textarea leads `/usage hello draft`
   3. reload + re-attach        → the pill survives (localStorage persistence)
   4. a command omp stops listing hides (unit-covered; here: pill count ≤ 3)

   Usage: node tests/test-slash-pills.mjs <desktop-cdp-port> <phone-cdp-port>
*/

const DESK = Number(process.argv[2] ?? 9429);
const PHONE = Number(process.argv[3] ?? 9521);
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
// A wide remote client: the composer foot row renders its pills (the
// <=760px tier hides plan/goal/slash pills, exactly like the desktop's
// own narrow layout does).
await phone.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
await phone.send("Page.navigate", { url: RELAY });
await sleep(8000);

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
  for (let i = 0; i < 45 && !seen; i++) { await sleep(1000); seen = await desk.ev(`!!document.querySelector(".remote-pair-modal")`); }
  assert(seen, "the pair_request dialog never appeared on the desktop");
  await desk.ev(`[...document.querySelectorAll(".remote-pair-modal button")].find(b => (b.textContent || "").trim() === "允许配对")?.click()`);
  let attached = false;
  for (let i = 0; i < 30 && !attached; i++) { await sleep(1000); attached = await phone.ev(`!!document.querySelector(".composer textarea")`); }
  assert(attached, "the phone never attached to the desktop session view");
  return `paired and attached (code ${code})`;
});

const marker = `slash-pill-${Date.now()}`;
await check("send-records-pill", async () => {
  // The record filter only counts commands omp currently lists; the phone
  // gets that list as an event after attach, so wait for it before sending.
  let listed = false;
  for (let i = 0; i < 45 && !listed; i++) {
    await sleep(1000);
    listed = await phone.ev(`(window.OMP_BRIDGE.getState().commands || []).some(c => c.name === "usage")`);
    // omp emits available_commands_update only at process start; a phone
    // attaching later gets its copy from the activation fetch, which queues
    // behind a busy tab's stdin. One tab round trip forces a fresh fetch.
    if (i === 12 && !listed) {
      await phone.ev(`window.__TAURI__.core.invoke("js:list_tabs", {}).then(v => {
        const other = v.tabs.find(t => t.id !== v.active);
        if (!other) return null;
        return window.OMP_BRIDGE.activateSession(other.id)
          .then(() => window.OMP_BRIDGE.activateSession(v.active));
      }).catch(() => null)`);
    }
  }
  assert(listed, "the phone never received the command list");
  await phone.ev(`(() => { const ta = document.querySelector(".composer textarea"); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; set.call(ta, "/usage ${marker}"); ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(400);
  await phone.ev(`[...document.querySelectorAll(".composer button.btn.primary")].pop()?.click()`);
  let pill = false;
  for (let i = 0; i < 15 && !pill; i++) {
    await sleep(1000);
    pill = await phone.ev(`[...document.querySelectorAll(".composer-foot .slash-pill")].some(b => (b.textContent || "").trim() === "/usage")`);
  }
  assert(pill, "no /usage pill appeared after sending the command");
  const stored = await phone.ev(`localStorage.getItem("omp-desktop.slash-usage")`);
  assert(stored && stored.includes("usage"), `usage not persisted (${stored})`);
  return `/usage pill rendered and usage stored`;
});

await check("click-prepends-draft", async () => {
  await phone.ev(`(() => { const ta = document.querySelector(".composer textarea"); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; set.call(ta, "hello draft"); ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(300);
  await phone.ev(`[...document.querySelectorAll(".composer-foot .slash-pill")].find(b => (b.textContent || "").trim() === "/usage")?.click()`);
  await sleep(400);
  const value = await phone.ev(`document.querySelector(".composer textarea")?.value ?? null`);
  assert(value && value.startsWith("/usage hello draft"), `draft after pill click: ${JSON.stringify(value)}`);
  const focused = await phone.ev(`document.activeElement === document.querySelector(".composer textarea")`);
  assert(focused, "the composer did not take focus after the pill click");
  return `draft became "/usage hello draft" with focus in the textarea`;
});

await check("pill-survives-reload", async () => {
  // localStorage survives the reload; the pills also need the command list
  // again (same activation-fetch lag as the first attach), so wait long.
  const storedBefore = await phone.ev(`localStorage.getItem("omp-desktop.slash-usage")`);
  assert(storedBefore && storedBefore.includes("usage"), `usage was not in localStorage before reload (${storedBefore})`);
  await phone.send("Page.navigate", { url: RELAY });
  let back = false;
  for (let i = 0; i < 25 && !back; i++) { await sleep(1000); back = await phone.ev(`!!document.querySelector(".composer textarea")`); }
  assert(back, "the phone never re-attached after reload");
  let pill = false;
  for (let i = 0; i < 45 && !pill; i++) {
    await sleep(1000);
    pill = await phone.ev(`[...document.querySelectorAll(".composer-foot .slash-pill")].some(b => (b.textContent || "").trim() === "/usage")`);
    if (i === 12 && !pill) {
      await phone.ev(`window.__TAURI__.core.invoke("js:list_tabs", {}).then(v => {
        const other = v.tabs.find(t => t.id !== v.active);
        if (!other) return null;
        return window.OMP_BRIDGE.activateSession(other.id)
          .then(() => window.OMP_BRIDGE.activateSession(v.active));
      }).catch(() => null)`);
    }
  }
  assert(pill, "the /usage pill did not survive the reload");
  const count = await phone.ev(`document.querySelectorAll(".composer-foot .slash-pill").length`);
  assert(count <= 3, `more than three pills rendered (${count})`);
  return `pill persisted across reload, ${count} pill(s) shown`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\nslash-pills: ${results.length - failed.length}/${results.length} pass`);
process.exit(failed.length ? 1 : 0);
