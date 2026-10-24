#!/usr/bin/env node
// Investigation probe for the DCL → #root gap (R7 startup timing round).
// Not part of the smoke suite: run directly —
//   node tests/smoke/startup-probe.mjs [--exe <path>] [--runs N]
//
// Launches the release exe, attaches CDP as early as possible, then reads:
//   - navigation timing (responseEnd, DCL, FP, FCP) from the page
//   - performance.getEntriesByType("resource") for every script fetch
//   - in-page marks the exe already logs (console "[live] ..." lines)
//   - a MutationObserver on #root: the exact ms React's first commit lands
//   - window.OMP_BRIDGE.isConnected / composer presence timestamps
// and prints a segment table breaking the spawn → root-rendered wall into
// its phases, so the ~2 s DCL → root hole gets named, not guessed.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const exe = resolve(root, opt("--exe") ?? join("src-tauri", "target", "release", "omp-desktop.exe"));
const runs = Number(opt("--runs") ?? 1);

if (!existsSync(exe)) {
  console.error(`exe not found: ${exe} (build it, or pass --exe <path>)`);
  process.exit(1);
}

// console + network arrival times, recorded from the wire (Node clock)
async function once() {
  const cdp = await launch(exe);
  const t0 = cdp.t0;
  const nodeMs = () => Date.now() - t0;
  const consoleLines = [];      // {nodeMs, text} — Runtime.consoleAPICalled
  const requests = new Map();   // requestId → {url, nodeMsStart, nodeMsEnd}

  cdp.on("Runtime.consoleAPICalled", p => {
    const text = (p.args ?? []).map(a => a.type === "string" ? a.value : (a.description ?? "")).join(" ");
    if (text) consoleLines.push({ nodeMs: nodeMs(), text: text.slice(0, 160) });
  });
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    // resource timing comes from the page; requestWillBeSent/network timing
    // from Node gives the Node-clock view of the same fetches
    try {
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", p => {
        if (!requests.has(p.requestId)) requests.set(p.requestId, { url: p.request.url, nodeMsStart: nodeMs() });
      });
      cdp.on("Network.loadingFinished", p => {
        const r = requests.get(p.requestId);
        if (r) r.nodeMsEnd = nodeMs();
      });
      cdp.on("Network.loadingFailed", p => {
        const r = requests.get(p.requestId);
        if (r) r.nodeMsEnd = nodeMs();
      });
    } catch { /* Network domain optional */ }
  } catch (e) {
    console.error(`[probe] CDP enable failed: ${e.message}`);
  }

  // ── page-side milestones ────────────────────────────────────────────────
  // Poll documentElement for a MutationObserver on #root as soon as the
  // document exists, so the first React commit is caught at ms precision
  // instead of the 200 ms waitExpr granularity. The observer is attached
  // via an in-page poll loop that survives until #root gets a child.
  const attachObserver = `(() => {
    if (window.__probeObs) return true;
    const root = document.getElementById("root");
    if (!root) return false;
    window.__probeMarks = window.__probeMarks || {};
    const stamp = (name) => { if (window.__probeMarks[name] == null) window.__probeMarks[name] = performance.now(); };
    const obs = new MutationObserver(() => { if (root.childElementCount > 0) { stamp("rootChildren"); obs.disconnect(); } });
    obs.observe(root, { childList: true, subtree: true });
    window.__probeObs = true;
    return "attached@" + document.readyState;
  })()`;

  // Attach as early as we can (document may not even exist yet — retry).
  // childList+subtree, not the nonexistent "childElements" option: that
  // one throws inside observe() and the loop below would spin to the
  // deadline. 25 ms poll: the CDP websocket is open by ~1 s after spawn
  // and React commits at ~1.4 s, so there is a real window to catch.
  const observerDeadline = Date.now() + 20000;
  let observerAttached = false;
  while (Date.now() < observerDeadline) {
    try {
      const res = await cdp.evaluate(attachObserver);
      if (res) { observerAttached = res; break; }
    } catch { /* document not there yet */ }
    await new Promise(r => setTimeout(r, 25));
  }

  // wait for boot to complete
  const composerSel = ".composer-input textarea, .composer textarea";
  const waitFor = async (expr, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await cdp.evaluate(expr)) return true; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  };
  const hasComposer = await waitFor(`!!document.querySelector(${JSON.stringify(composerSel)})`, 30000);
  const hasBridge = await waitFor(`window.OMP_BRIDGE?.isConnected === true`, 10000);

  // give the observer one more beat to fire (it stamps on the first commit)
  await new Promise(r => setTimeout(r, 300));

  // ── read everything the page knows ──────────────────────────────────────
  const page = await cdp.evaluate(`(() => {
    const marks = window.__probeMarks || {};
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByType("paint");
    const fp = paint.find(p => p.name === "first-paint");
    const fcp = paint.find(p => p.name === "first-contentful-paint");
    const resources = performance.getEntriesByType("resource")
      .filter(r => r.initiatorType === "script" || /\\.(js|css)$/.test(r.name.split("?")[0]))
      .map(r => ({
        name: r.name.split("/").pop().slice(0, 60),
        start: Math.round(r.startTime),
        dur: Math.round(r.duration),
        size: r.transferSize ?? 0,
      }));
    const t = k => (k ? Math.round(k) : null);
    return {
      navigationStart: 0,
      fetchStart: t(nav?.fetchStart),
      responseEnd: t(nav?.responseEnd),
      domInteractive: t(nav?.domInteractive),
      dcl: t(nav?.domContentLoadedEventEnd),
      loadEvent: t(nav?.loadEventEnd),
      fp: t(fp?.startTime),
      fcp: t(fcp?.startTime),
      rootChildren: marks.rootChildren != null ? Math.round(marks.rootChildren) : null,
      bridgeConnected: marks.bridge != null ? Math.round(marks.bridge) : null,
      resources,
      scripts: document.scripts.length,
      readyState: document.readyState,
    };
  })()`);

  const rootChildrenMs = page.rootChildren;       // page clock (performance.now)
  const nodeRoot = rootChildrenMs != null ? nodeMs() : null; // wall fallback

  // OMP_BRIDGE connect moment: live.js sets isConnected — find when by
  // reading the app's own console line for it (below) plus final state
  const finalBridge = await cdp.evaluate(`window.OMP_BRIDGE?.isConnected === true`);

  await cdp.close();

  // ── report ──────────────────────────────────────────────────────────────
  const fmt = (v) => v == null ? "—" : `${v}`;
  console.log(`\n=== probe run (spawn t0 →) ===`);
  console.log(`observer attached early: ${observerAttached}, composer: ${hasComposer}, bridge: ${finalBridge}`);
  console.log(`page clock (performance.now, 0 = navigation start):`);
  console.log(`  responseEnd    ${fmt(page.responseEnd)}`);
  console.log(`  domInteractive ${fmt(page.domInteractive)}`);
  console.log(`  DCL end        ${fmt(page.dcl)}`);
  console.log(`  FP             ${fmt(page.fp)}`);
  console.log(`  FCP            ${fmt(page.fcp)}`);
  console.log(`  root first child (mutation stamp) ${fmt(page.rootChildren)}`);
  console.log(`  load event     ${fmt(page.loadEvent)}`);
  const gap = page.rootChildren != null && page.dcl != null ? page.rootChildren - page.dcl : null;
  console.log(`  DCL → root     ${fmt(gap)} ms  ${gap != null && gap > 1000 ? "<— the hole under investigation" : ""}`);
  console.log(`script resources (${page.resources.length} shown, page clock):`);
  for (const r of page.resources) {
    console.log(`  ${String(r.start).padStart(6)} +${String(r.dur).padStart(6)} ms  ${String(r.size).padStart(8)} B  ${r.name}`);
  }
  console.log(`[live] console lines (Node clock, ms since spawn):`);
  for (const l of consoleLines) {
    console.log(`  ${String(l.nodeMs).padStart(6)}  ${l.text}`);
  }
  return { hasComposer, finalBridge, gap, page };
}

const gaps = [];
for (let i = 0; i < runs; i++) {
  const r = await once();
  if (r.gap != null) gaps.push(r.gap);
}
if (runs > 1) {
  console.log(`\nDCL → root across ${runs} runs: ${gaps.join(", ")} ms`);
}
