// CDP driver for the smoke suite: launches the release exe with a remote
// debugging port (WebView2 honours WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS),
// picks the tauri.localhost page target, and wraps the protocol over Node's
// built-in WebSocket. Zero dependencies on purpose (AGENTS.md: Node 24's
// built-in fetch/WebSocket).
//
// Exports: launch(exePath, { port }) -> CdpSession
//   send(method, params)   promise of the result (id auto-increments)
//   on(event, cb)          protocol event subscription
//   evaluate(expr)         Runtime.evaluate, awaitPromise + returnByValue
//   waitExpr(expr, ms)     polls evaluate until truthy (or throws)
//   t0                     Date.now() right before the spawn call — the
//                          shared zero point for every startup timing
//   close()                Browser.close, then taskkill /T /F as backstop

import { spawn } from "node:child_process";
import net from "node:net";

const HOST = "127.0.0.1";

/** Grab a free port by binding 0 and closing — the OS is unlikely to hand
 *  the same port out again before the browser takes it, and a clash would
 *  surface immediately as a connect failure. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll the HTTP discovery endpoint until the page target exists. */
async function waitForTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find(t =>
          t.type === "page" && typeof t.url === "string" && t.url.startsWith("http://tauri.localhost"));
        if (page && page.webSocketDebuggerUrl) return page;
        lastErr = `no tauri.localhost page yet (${targets.map(t => t.type).join(",") || "none"})`;
      } else lastErr = `http ${res.status}`;
    } catch (e) { lastErr = e.code ?? String(e); }
    await sleep(300);
  }
  throw new Error(`cdp: page target never appeared on port ${port} (${lastErr})`);
}

export async function launch(exePath, { port } = {}) {
  const debugPort = port ?? (await freePort());
  // Date.now() immediately before the spawn call: run.mjs's boot/timing
  // step measures spawn→root/composer/bridge against this zero. Node and
  // the webview share the same wall clock, so ms deltas are meaningful.
  const t0 = Date.now();
  const child = spawn(exePath, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${debugPort} ${process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? ""}`.trim(),
    },
    stdio: "ignore",
    windowsHide: true,
  });

  const target = await waitForTarget(debugPort);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp: websocket connect failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();          // id -> {resolve, reject}
  const listeners = new Map();        // event -> Set<cb>

  ws.addEventListener("message", ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`cdp: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const cb of listeners.get(msg.method)) {
        try { cb(msg.params ?? {}); } catch { /* a listener must not break the pump */ }
      }
    }
  });
  ws.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("cdp: websocket closed"));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error(`cdp: send ${method} on closed socket`));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const on = (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  };

  const evaluate = (expr) => send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }).then(res => {
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? "evaluate failed";
      throw new Error(`cdp: evaluate threw: ${String(text).split("\n").slice(0, 3).join(" | ")}`);
    }
    return res.result?.value;
  });

  const waitExpr = (expr, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      (async function tick() {
        try {
          const v = await evaluate(expr);
          if (v) return resolve(v);
        } catch (e) { /* keep polling; a transient throw is not a verdict */ }
        if (Date.now() > deadline) return reject(new Error(`cdp: waitExpr timed out (${expr.slice(0, 60)})`));
        setTimeout(tick, 200);
      })();
    });
  };

  const close = async () => {
    try { await send("Browser.close"); } catch { /* already gone */ }
    await sleep(500);
    if (child.exitCode === null && !child.killed) {
      // /T: the exe's children (the omp processes it spawned) too.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    try { ws.close(); } catch { /* ignore */ }
  };

  return { child, port: debugPort, target, send, on, evaluate, waitExpr, close, t0 };
}
