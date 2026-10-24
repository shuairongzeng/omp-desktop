#!/usr/bin/env node
// Smoke suite: drives the real release exe over CDP — app boots, the UI
// surfaces open and close by real DOM clicks, injected render faults are
// contained by the error boundaries, and modal churn does not leak the JS
// heap. Run: node tests/smoke/run.mjs [--exe <path>] [--skip-fault]
//
// #root must be non-empty before anything else is asserted: a black window
// (the git-browser incident) would make every later step fail for the same
// reason. See SMOKE.md for prerequisites, the console whitelist and how to
// read the heap numbers.

import { readFileSync, existsSync, copyFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const exe = resolve(root, opt("--exe") ?? join("src-tauri", "target", "release", "omp-desktop.exe"));
const skipFault = flag("--skip-fault");

if (!existsSync(exe)) {
  console.error(`[smoke] exe not found: ${exe} (build first, or pass --exe <path>)`);
  process.exit(1);
}

// ── Step tracking ─────────────────────────────────────────────────────────
const results = [];
async function step(name, fn) {
  const detail = await fn();
  results.push({ name, ok: true, detail: detail ?? "" });
  console.log(`[smoke] PASS ${name}${detail ? ` ${detail}` : ""}`);
}
function fail(name, err) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  results.push({ name, ok: false, detail });
  console.error(`[smoke] FAIL ${name}\n${detail}`);
}
async function runStep(name, fn) {
  try { await step(name, fn); }
  catch (err) { fail(name, err); }
}

// ── Console / exception collection (whole run) ────────────────────────────
// Environment noise that is provably not the app's fault. Every entry names
// the exact match and the reason; anything else fails the run. SMOKE.md
// documents the same list.
const CONSOLE_WHITELIST = [
  // The single-instance plugin: a first omp-desktop instance forwards this
  // launch's argv and exits; the visible app logs the duplicate. Caused by
  // the test environment (another instance may be running), not a defect.
  { match: e => /single instance|another instance|already running/i.test(textOf(e)), reason: "single-instance forward" },
];

function textOf(e) {
  const parts = [];
  if (e.type === "consoleAPICalled") {
    for (const a of e.args ?? []) {
      if (a.type === "string") parts.push(a.value);
      else if (a.description) parts.push(a.description);
      else if (a.value !== undefined) parts.push(String(a.value));
    }
  } else if (e.type === "exceptionThrown") {
    parts.push(e.exceptionDetails?.text ?? "");
    parts.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.exception?.value ?? "");
  } else if (e.type === "logEntry") {
    parts.push(e.entry?.text ?? "");
    parts.push(e.entry?.url ?? "");
  }
  return parts.filter(Boolean).join(" ");
}

const consoleEvents = [];
function startConsoleWatch(cdp) {
  cdp.on("Runtime.consoleAPICalled", p => { if (p.type === "error") consoleEvents.push({ type: "consoleAPICalled", ...p }); });
  cdp.on("Runtime.exceptionThrown", p => consoleEvents.push({ type: "exceptionThrown", ...p }));
  cdp.on("Log.entryAdded", p => { if (p.entry?.level === "error") consoleEvents.push({ type: "logEntry", ...p }); });
}

// ── open-tabs.json backup/restore ─────────────────────────────────────────
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tabsPath = join(process.env.APPDATA, conf.identifier, "open-tabs.json");
const backupPath = `${tabsPath}.smoke-backup`;
let hadTabs = existsSync(tabsPath);
if (hadTabs) copyFileSync(tabsPath, backupPath);

function restoreTabs() {
  try {
    if (hadTabs) copyFileSync(backupPath, tabsPath);
    else if (existsSync(tabsPath)) rmSync(tabsPath);
  } catch (e) { console.error(`[smoke] open-tabs restore failed: ${e.message}`); }
  if (existsSync(backupPath)) { try { rmSync(backupPath); } catch { /* best effort */ } }
}

// ── Fault injection (shared contract §2/§3) ───────────────────────────────
// React 19's createRoot marks host nodes with __reactFiber$ keys; a class
// component's fiber has stateNode = the instance. We climb `return` from a
// host node to find PanelBoundary / AppBoundary instances and force the
// error state exactly like a render throw would (getDerivedStateFromError
// then rerenders the fallback).
const FIND_INSTANCE = name => `(() => {
  const rootEl = document.getElementById("root");
  if (!rootEl) return null;
  // React 19 marks the root container with __reactContainer$ (host nodes
  // inside get __reactFiber$). The committed tree can briefly sit in a
  // truncated state mid-transition (its full twin lives on .alternate),
  // so the walk covers both trees and retries a few times.
  const key = Object.keys(rootEl).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
  if (!key) return null;
  const walk = start => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      if (f.stateNode && f.stateNode.constructor && f.stateNode.constructor.name === ${JSON.stringify(name)}) {
        return f.stateNode;
      }
      if (f.return) queue.push(f.return);
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
      if (f.stateNode && f.stateNode instanceof Element) {
        for (const k of Object.keys(f.stateNode)) {
          if (k.startsWith("__reactFiber$")) queue.push(f.stateNode[k]);
        }
      }
    }
    return null;
  };
  const root = rootEl[key];
  return walk(root) || walk(root?.alternate) || null;
})()`;

// The CDP reply must be JSON-serialisable, so the retry probe returns a
// boolean; the in-page trigger/clear expressions use FIND_INSTANCE.
const FIND_BOUNDARY = name => `((${FIND_INSTANCE(name)}) ? true : null)`;

// The truncated-commit window is transient (self-heals within ~3 s); retry
// so the fault step never races it.
async function findBoundary(cdp, name) {
  for (let i = 0; i < 10; i++) {
    const inst = await cdp.evaluate(FIND_BOUNDARY(name));
    if (inst) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const trigger = async (cdp, name) => {
  if (!await findBoundary(cdp, name)) return false;
  return cdp.evaluate(`(() => {
    const inst = ${FIND_INSTANCE(name)};
    if (!inst) return false;
    inst.setState({ error: new Error("smoke-fault") });
    return true;
  })()`);
};

// ── Durability helpers ────────────────────────────────────────────────────
async function heapUsed(cdp) {
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = metrics.find(x => x.name === "JSHeapUsedSize");
  return m ? m.value : null;
}

const openSettings = (cdp) => cdp.evaluate(
  `(() => { const b = [...document.querySelectorAll(".status-cell")].find(x => (x.title || "").startsWith("settings")); if (!b) return false; b.click(); return true; })()`
);
const closeSettings = (cdp) => cdp.evaluate(
  `(() => { const t = document.querySelector('.tab[data-tab-id="__settings__"]'); if (!t) return false; const c = t.querySelector(".tab-close"); if (!c) return false; c.click(); return true; })()`
);
const openBridge = (cdp) => cdp.evaluate(
  `(() => { const b = document.querySelector('.btn[title^="open command bridge"]'); if (!b) return false; b.click(); return true; })()`
);
const closeBridge = (cdp) => cdp.evaluate(
  `(() => { const s = document.querySelector(".bridge-scrim"); if (!s) return false; s.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`
);

// ── Main ──────────────────────────────────────────────────────────────────
let cdp = null;
process.on("SIGINT", async () => {
  try { await cdp?.close(); } catch {}
  restoreTabs();
  process.exit(130);
});

try {
  cdp = await launch(exe);
  startConsoleWatch(cdp);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  // a. boot — the launch, the target pick and the first paint
  await runStep("boot/cdp-connect", async () => {
    await cdp.waitExpr(`document.readyState === "complete" || true`, 5000); // any evaluate reply proves the pipe
    return `pid=${cdp.child.pid} port=${cdp.port} url=${cdp.target.url.slice(0, 40)}`;
  });

  await runStep("boot/root-rendered", async () => {
    const n = await cdp.waitExpr(`(() => { const n = document.getElementById("root")?.childElementCount ?? 0; return n > 0 ? n : false; })()`, 15000);
    return `root children: ${n}`;
  });

  // b. boot/timing — the startup budget. All three phases measured from
  // cdp.t0 (the Date.now() right before the spawn call, Node's clock):
  //   root      — spawn → #root has children (React mounted)
  //   composer  — spawn → the composer textarea exists (an active tab's
  //               UI is usable; tab restore has produced something)
  //   bridge    — spawn → window.OMP_BRIDGE?.isConnected === true
  // Hard budget: composer < 8000 ms (the integrator's hot-machine baseline
  // is 5161 ms; 8000 leaves headroom for a cold file cache, a first-boot
  // WebView2 profile and heavier saved transcripts without flaking).
  // > 6500 ms prints a WARN — a real machine should not sit that close to
  // the cliff; regressions should surface here before the hard assert.
  // Note the poll granularity (200 ms in cdp.waitExpr) and IPC latency
  // both round these numbers up; they are upper bounds, not exact points.
  await runStep("boot/timing", async () => {
    const t0 = cdp.t0;
    const ms = () => Date.now() - t0;

    // root-rendered already passed, but re-derive its number from t0 for
    // the table (cheap: one evaluate on the already-mounted tree).
    await cdp.waitExpr(`document.getElementById("root")?.childElementCount > 0`, 15000);
    const rootMs = ms();

    const composerSel = ".composer-input textarea, .composer textarea";
    await cdp.waitExpr(`!!document.querySelector(${JSON.stringify(composerSel)})`, 30000);
    const composerMs = ms();

    await cdp.waitExpr(`window.OMP_BRIDGE?.isConnected === true`, 30000);
    const bridgeMs = ms();

    const rows = [
      ["spawn → root rendered", `${rootMs} ms`],
      ["spawn → composer", `${composerMs} ms`],
      ["spawn → bridge connected", `${bridgeMs} ms`],
    ];
    console.log(rows.map(([k, v]) => `[smoke] timing ${k.padEnd(28)} ${v}`).join("\n"));

    if (composerMs >= 8000) {
      throw new Error(`startup budget blown: spawn → composer ${composerMs} ms (budget 8000 ms, baseline 5161 ms)`);
    }
    if (composerMs > 6500) {
      console.log(`[smoke] WARN spawn → composer ${composerMs} ms is over the 6500 ms soft budget — within the 8000 ms assert but drifting from the 5161 ms baseline`);
    }
    return `root ${rootMs} composer ${composerMs} bridge ${bridgeMs} ms (budget: composer < 8000)`;
  });

  // A module-eval failure (a missing top-level global, a script that died
  // half-loaded) never reaches a React boundary — error-watch is the only
  // sentinel for that class, so the ring must be empty once the app boots.
  await runStep("boot/no-recorded-errors", async () => {
    const n = await cdp.waitExpr(`window.OMP_ERRORS ? window.OMP_ERRORS.count() === 0 : false`, 10000);
    if (!n) {
      const list = await cdp.evaluate(`(window.OMP_ERRORS?.list?.() ?? []).map(e => e.kind + ": " + e.message).join(" | ")`);
      throw new Error(`error ring not empty at boot: ${list || "watcher missing"}`);
    }
    return "error ring empty at boot";
  });

  // The tab restore (open-tabs.json → omp spawns) is async; the composer
  // and git button only render with an active tab. Wait for it, bounded.
  const tabCount = await cdp.waitExpr(
    `(() => { const n = document.querySelectorAll('.tabs .tab[data-tab-id]:not([data-tab-id="__settings__"])').length; return n > 0 ? n : false; })()`,
    20000,
  ).catch(() => 0);
  console.log(`[smoke] INFO restored tabs: ${tabCount}`);

  // d. UI walk — real DOM clicks, selectors from src/design/
  // Clicks dispatched while React sits between two commits of a heavy
  // transition (tab restore spawning omp processes) can be lost — the
  // synthetic event walks a stale fiber. Every open/close therefore
  // retries until its DOM effect lands.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const SETTINGS_VIS = `(() => { const s = document.querySelector(".settings"); if (!s) return false; const host = s.closest(".st-host"); return !host || !host.hasAttribute("hidden"); })()`;
  await runStep("ui/settings-open-close", async () => {
    let vis = false;
    for (let i = 0; i < 8 && !vis; i++) {
      if (!await openSettings(cdp)) throw new Error("settings status-bar button not found (.status-cell[title^=settings])");
      vis = await cdp.waitExpr(SETTINGS_VIS, 3000).catch(() => false);
      if (!vis) await sleep(400);
    }
    if (!vis) throw new Error(".settings never became visible");
    let gone = false;
    for (let i = 0; i < 8 && !gone; i++) {
      if (!await closeSettings(cdp)) throw new Error("settings tab close button not found (.tab-close)");
      gone = await cdp.waitExpr(`!document.querySelector(".settings")`, 3000).catch(() => false);
      if (!gone) await sleep(400);
    }
    if (!gone) throw new Error(".settings never closed");
    return "settings opened via status bar, closed via tab close";
  });

  await runStep("ui/command-bridge-open-close", async () => {
    let vis = false;
    for (let i = 0; i < 8 && !vis; i++) {
      if (!await openBridge(cdp)) throw new Error("command bridge button not found (.btn[title^='open command bridge'])");
      vis = await cdp.waitExpr(`!!document.querySelector('.bridge[aria-label="command bridge"]')`, 3000).catch(() => false);
      if (!vis) await sleep(400);
    }
    if (!vis) throw new Error(".bridge never appeared");
    // Esc through the real stack: dispatch on window (capture-phase stack
    // listener) — the same path a real Escape takes.
    let gone = false;
    for (let i = 0; i < 8 && !gone; i++) {
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      gone = await cdp.waitExpr(`!document.querySelector(".bridge-scrim")`, 3000).catch(() => false);
      if (!gone) await sleep(400);
    }
    if (!gone) throw new Error(".bridge-scrim never closed");
    return "bridge opened via composer button, closed via Escape";
  });

  await runStep("ui/git-browser-open-close", async () => {
    const hasTab = await cdp.evaluate(`!!document.querySelector('.tabs .tab[data-tab-id]:not([data-tab-id="__settings__"])')`);
    if (!hasTab) return "skipped: no active project tab (git browser needs the active tab's project)";
    let vis = false;
    for (let i = 0; i < 8 && !vis; i++) {
      const btn = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll(".status-cell")].find(x => x.title === "git browser"); if (!b) return false; b.click(); return true; })()`);
      if (!btn) throw new Error("git browser status-bar button not found");
      vis = await cdp.waitExpr(`!!document.querySelector('.gitb[aria-label="git browser"]')`, 3000).catch(() => false);
      if (!vis) await sleep(400);
    }
    if (!vis) throw new Error(".gitb dialog never appeared");
    let gone = false;
    for (let i = 0; i < 8 && !gone; i++) {
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      gone = await cdp.waitExpr(`!document.querySelector(".gitb-scrim")`, 3000).catch(() => false);
      if (!gone) await sleep(400);
    }
    if (!gone) throw new Error(".gitb-scrim never closed");
    return "git browser opened via status bar, closed via Escape";
  });

  // e. fault injection
  if (!skipFault) {
    await runStep("fault/panel-boundary", async () => {
      const found = await trigger(cdp, "PanelBoundary");
      if (!found) throw new Error("exe lacks boundaries: no PanelBoundary instance in the react tree");
      await cdp.waitExpr(`!!document.querySelector(".panel-crash")`, 5000);
      const n = await cdp.evaluate(`document.getElementById("root").childElementCount`);
      if (!(n > 0)) throw new Error(`#root empty while panel crashed (children: ${n})`);
      let cleared = false;
      for (let i = 0; i < 10 && !cleared; i++) {
        cleared = await cdp.evaluate(`(() => { const inst = (${FIND_INSTANCE("PanelBoundary")}); if (!inst) return false; inst.setState({ error: null }); return true; })()`);
        if (!cleared) await new Promise(r => setTimeout(r, 500));
      }
      if (!cleared) throw new Error("panel boundary instance lost after fault");
      await cdp.waitExpr(`!document.querySelector(".panel-crash")`, 5000);
      return "crash card shown, #root stayed populated, cleared";
    });

    await runStep("fault/app-boundary", async () => {
      const found = await trigger(cdp, "AppBoundary");
      if (!found) throw new Error("exe lacks boundaries: no AppBoundary instance in the react tree");
      await cdp.waitExpr(`!!document.querySelector(".app-crash")`, 5000);
      await cdp.send("Page.reload");
      await cdp.waitExpr(`document.getElementById("root")?.childElementCount > 0`, 20000);
    });
  } else {
    console.log("[smoke] SKIP fault injection (--skip-fault)");
  }

  // f. durability — heap before/after 40 modal cycles
  await runStep("durability/heap", async () => {
    const before = await heapUsed(cdp);
    if (before == null) throw new Error("Performance.getMetrics returned no JSHeapUsedSize");

    const guard = async (label, open, close, goneSel) => {
      for (let i = 0; i < 20; i++) {
        if (!await open(cdp)) throw new Error(`${label}: open #${i + 1} failed`);
        await cdp.waitExpr(`true`, 2000); // settle a frame
        if (!await close(cdp)) throw new Error(`${label}: close #${i + 1} failed`);
        await cdp.waitExpr(`!document.querySelector(${JSON.stringify(goneSel)})`, 5000);
      }
    };
    await guard("settings", openSettings, closeSettings, ".st-host");
    await guard("command bridge", openBridge, closeBridge, ".bridge-scrim");

    // 5x tab churn via OMP_BRIDGE. The native folder dialog would block a
    // CDP-driven run, so the programmable path is used instead: read the
    // active tab's project folder out of the snapshot (onUpdate hands the
    // registry view to a subscriber and returns the unsubscribe), then
    // openSession(path) spawns a real new tab (a real omp process) and
    // closeSession(id) tears it back down. newSession() alone would only
    // reset one process's conversation — not a tab lifecycle.
    let churn = "no tab churn";
    const churnReady = await cdp.evaluate(`!!(window.OMP_BRIDGE && typeof window.OMP_BRIDGE.openSession === "function" && typeof window.OMP_BRIDGE.closeSession === "function")`);
    const cwd = churnReady ? await cdp.evaluate(`(() => {
      let path = null;
      const snap = window.OMP_BRIDGE.onUpdate(s => { path = s.sessions?.find(t => t.id === s.activeSessionId)?.path ?? s.sessions?.[0]?.path ?? null; });
      snap && snap();
      return path;
    })()`) : null;
    if (cwd) {
      for (let i = 0; i < 5; i++) {
        const id = await cdp.evaluate(`window.OMP_BRIDGE.openSession(${JSON.stringify(cwd)}).then(r => r || null).catch(() => null)`);
        if (!id) throw new Error(`tab churn #${i + 1}: openSession failed`);
        await cdp.waitExpr(`!!document.querySelector('.tabs .tab[data-tab-id="${id}"]')`, 10000);
        const closed = await cdp.evaluate(`window.OMP_BRIDGE.closeSession(${JSON.stringify(id)}).then(() => true).catch(() => false)`);
        if (!closed) throw new Error(`tab churn #${i + 1}: closeSession failed`);
        await cdp.waitExpr(`!document.querySelector('.tabs .tab[data-tab-id="${id}"]')`, 10000);
      }
      churn = `5x openSession/closeSession churn (${cwd})`;
    } else {
      churn = churnReady ? "no tab churn: no project path in snapshot" : "no tab churn: OMP_BRIDGE lacks openSession/closeSession";
    }

    const after = await heapUsed(cdp);
    if (after == null) throw new Error("second Performance.getMetrics returned no JSHeapUsedSize");
    const deltaMB = (after - before) / 1048576;
    const rows = [
      ["baseline", (before / 1048576).toFixed(2)],
      ["after 20x settings + 20x bridge + churn", (after / 1048576).toFixed(2)],
      ["delta", `${deltaMB.toFixed(2)} MB (${churn})`],
    ];
    const table = rows.map(([k, v]) => `${k.padEnd(38)} ${v}`).join("\n");
    console.log(table);
    if (deltaMB >= 15) throw new Error(`heap grew ${deltaMB.toFixed(2)} MB after modal churn (limit 15 MB)`);
    return `delta ${deltaMB.toFixed(2)} MB < 15 MB`;
  });

  // c. zero unexpected console errors — judged after everything ran
  await runStep("console/clean", () => {
    const offenders = consoleEvents.filter(e => !CONSOLE_WHITELIST.some(w => w.match(e)));
    if (offenders.length) {
      const lines = offenders.slice(0, 10).map(e => `  [${e.type}] ${textOf(e).slice(0, 200)}`);
      throw new Error(`${offenders.length} unwhitelisted error-level console/log entries:\n${lines.join("\n")}`);
    }
    const whitelisted = consoleEvents.length - offenders.length;
    return `0 errors (${whitelisted} whitelisted)`;
  });
} catch (err) {
  fail("run", err);
} finally {
  try { await cdp?.close(); } catch {}
  restoreTabs();
}

const failed = results.filter(r => !r.ok);
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} steps passed${skipFault ? " (fault injection skipped)" : ""}`);
if (failed.length) {
  console.log(`[smoke] failed: ${failed.map(r => r.name).join(", ")}`);
  process.exit(1);
}
