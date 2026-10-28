/* tests/port-browser-platform.mjs — the Windows boundary is a tested,
   user-visible refusal, not a silent gap.

   The port cannot hand Chromium its CDP pipe ends on Windows (Node has no
   OS-handle inheritance and no Job Object), so `launch()` refuses win32
   with a fatal, documented error instead of starting a browser nobody can
   talk to. The browser panel surfaces that error as its nav error, so a
   Windows user reads the reason instead of a dead panel. Windows support
   itself is deferred to a Windows-side round (user decision 2026-10-27). */

// Own config dir: the chain runs without OMP_PORT_CONFIG_DIR, where the
// real browser.json would make the unconfigured launch skip discovery and
// never reach the "no Chromium found" boundary.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OMP_PORT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "port-platform-"));

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
const proc = createRequire(import.meta.url)("../electron/backend/browser-process.js");

let checks = 0;
const ok = (cond, msg) => { checks += 1; assert.ok(cond, msg); };

test("launch refuses win32 with the documented fatal message", async () => {
  // A configured executable browser is required to reach the pipe-handoff
  // refusal; discovery alone already refuses earlier with "no Chromium
  // found". Both are boundaries — assert the fatal one with a real
  // executable (this node binary) as the configured browser.
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    // The config dir is this test's own (OMP_PORT_CONFIG_DIR); a leftover
    // browser.json from an earlier run would make the first launch skip
    // discovery entirely.
    try { rmSync(`${process.env.OMP_PORT_CONFIG_DIR}/browser.json`); } catch { /* absent */ }
    proc.resetSettingsCache?.();
    let first = null;
    try { await proc.launch({}); } catch (e) { first = e; }
    ok(first && /no Chromium found/i.test(first.message),
      `unconfigured win32 refuses at discovery: ${first?.message}`);
    proc.settingsSetPath(process.execPath);
    let error = null;
    try { await proc.launch({}); } catch (e) { error = e; }
    ok(error, "launch must throw on win32 with a configured browser");
    ok(/Windows/i.test(error.message), `the refusal names the platform: ${error.message}`);
    ok(/not implemented on Windows in the Node port/.test(error.message),
      `the refusal is the documented pipe-handoff boundary: ${error.message}`);
  } finally {
    Object.defineProperty(process, "platform", real);
    proc.resetSettingsCache?.();
  }
});

test("discovery still answers on win32 (the refusal is at launch, not lookup)", () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const found = proc.discover();
    ok(Array.isArray(found.binaries), "discover returns a binaries list on win32");
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

test("summary", () => {
  console.log(`browser-platform: ${checks} checks passed`);
});
