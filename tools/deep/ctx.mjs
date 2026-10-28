/* tools/deep/ctx.mjs — shared harness context for the deep E2E matrix.

   A group module (tools/deep/<group>.mjs) exports `run(ctx)` and returns
   nothing; it records through ctx.check(name, fn). Every check must prove
   its feature by an EXTERNAL consequence (disk file, process table,
   clipboard, session jsonl) or a DOM state change that a no-op could not
   produce — "the panel rendered" is not evidence.

   The runner (tools/deep-e2e.mjs) builds one ctx per running instance and
   calls the groups in order. A group may also be run standalone:

     node tools/deep/<group>.mjs <cdp-port>

   which builds its own ctx against that port. */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export const makeCtx = async (port, shotDir) => {
  mkdirSync(shotDir, { recursive: true });
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`no page target on port ${port}`);
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
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  const send = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 200));
    if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.text).slice(0, 200));
    return r.result?.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${shotDir}/${name}.png`, Buffer.from(r.result.data, "base64"));
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail ?? "" });
      console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (e) {
      results.push({ name, ok: false, detail: String(e.message).slice(0, 200) });
      console.log(`FAIL ${name} — ${String(e.message).slice(0, 200)}`);
    }
    await shot(name).catch(() => {});
  };
  const skip = (name, reason) => {
    results.push({ name, ok: true, skipped: true, detail: reason });
    console.log(`SKIP ${name} — ${reason}`);
  };

  // ── evidence helpers ────────────────────────────────────────────────────
  const readDisk = (path) => readFileSync(path, "utf8");
  const pgrep = (pattern) => {
    try {
      return execSync(`pgrep -f '${pattern}' | wc -l`, { encoding: "utf8" }).trim();
    } catch {
      return "0";
    }
  };
  const pbpaste = () => {
    try {
      return execSync("pbpaste", { encoding: "utf8" });
    } catch {
      return "";
    }
  };

  // ── app-level helpers ───────────────────────────────────────────────────
  const invoke = (name, args) =>
    ev(`window.__TAURI__.core.invoke(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})
        .then(v => ({ ok: true, v })).catch(e => ({ ok: false, e: String(e?.message ?? e) }))`);
  const sendPrompt = (text) =>
    ev(`(() => { try { window.OMP_BRIDGE.send(${JSON.stringify(text)}); return 1; } catch (e) { return 0; } })()`);
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
  // Queued steers from an earlier check get delivered later under whatever
  // mode is current and can raise prompts that stall every following turn;
  // unanswered prompts stall too. Clear both before a group starts.
  const clearPoison = async () => {
    await ev(`(() => {
      let n = 0;
      for (const b of [...document.querySelectorAll('.queue-strip button[aria-label="remove"]')]) { b.click(); n++; }
      return n;
    })()`);
    await sleep(800);
    await ev(`(() => {
      let n = 0;
      for (const b of [...document.querySelectorAll('button')]) {
        if ((b.textContent || '').trim() === 'Deny') { b.click(); n++; }
      }
      return n;
    })()`);
    await sleep(1500);
    if (!(await waitIdle(20000))) {
      await ev(`(() => { try { window.OMP_BRIDGE.abort(); return 1; } catch { return 0; } })()`);
      await sleep(2500);
      await waitIdle(10000);
    }
  };
  const tabCount = () => ev(`document.querySelectorAll('.tab').length`);
  const activeTabText = () =>
    ev(`(document.querySelector('.tab.active') || document.querySelector('.tab[class*="active"]'))?.textContent ?? null`);
  const clickButton = (match) =>
    ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x =>
        ((x.getAttribute('aria-label') || '') + '|' + (x.getAttribute('title') || '') + '|' + (x.textContent || '')).includes(${JSON.stringify(match)}));
      if (!b) return 'no button matching ' + ${JSON.stringify(match)};
      b.click();
      return 'clicked';
    })()`);

  return {
    port, ws, send, ev, sleep, shot, assert, results, check, skip,
    readDisk, pgrep, pbpaste, invoke, sendPrompt, streamingNow, waitIdle,
    clearPoison, tabCount, activeTabText, clickButton,
    close: () => ws.close(),
  };
};

/* Standalone entry: a group file ends with
     if (import.meta.url === `file://${process.argv[1]}`) { … }
   which builds a ctx via runStandalone(run) below. */
export const runStandalone = async (run) => {
  const port = process.argv[2];
  if (!port) {
    console.error("usage: node tools/deep/<group>.mjs <cdp-port>");
    process.exit(1);
  }
  const ctx = await makeCtx(Number(port), `/tmp/deep-${process.argv[1].split("/").pop().replace(".mjs", "")}`);
  await run(ctx);
  const failed = ctx.results.filter((r) => !r.ok);
  console.log(`\n${ctx.results.length - failed.length}/${ctx.results.length} pass`);
  ctx.close();
  process.exit(failed.length ? 1 : 0);
};
