/* tools/deep-e2e.mjs — the port's operation-level regression matrix.

   Usage: node tools/deep-e2e.mjs <cdp-port> [shot-dir]
   Runs every group in tools/deep/ SEQUENTIALLY against one running port
   instance (groups share the instance; each clears its own poison first),
   prints one PASS/FAIL/SKIP line per feature, screenshots to shot-dir
   (default /tmp/deep-shots), writes deep-e2e.json there, and exits
   non-zero on any FAIL.

   Launching the instance under test:
     OMP_PORT_CONFIG_DIR=<cfg> "release/OMP Desktop.app/Contents/MacOS/OMP Desktop" \
       --remote-debugging-port=<port>
   with <cfg>/open-tabs.json seeded to one restorable tab (see the group
   tickets for the fixture). */

import { mkdirSync, writeFileSync } from "node:fs";
import { makeCtx } from "./deep/ctx.mjs";
import { run as runTabsSidebar } from "./deep/tabs-sidebar.mjs";
import { run as runComposer } from "./deep/composer.mjs";
import { run as runPanels } from "./deep/panels.mjs";
import { run as runBrowserSettings } from "./deep/browser-settings-keys.mjs";

const port = Number(process.argv[2]);
const shotDir = process.argv[3] ?? "/tmp/deep-shots";
if (!port) {
  console.error("usage: node tools/deep-e2e.mjs <cdp-port> [shot-dir]");
  process.exit(1);
}
mkdirSync(shotDir, { recursive: true });

const ctx = await makeCtx(port, shotDir);
const groups = [
  ["tabs-sidebar", runTabsSidebar],
  ["composer", runComposer],
  ["panels", runPanels],
  ["browser-settings-keys", runBrowserSettings],
];

for (const [name, run] of groups) {
  console.log(`\n── ${name} ──`);
  await ctx.clearPoison();
  try {
    await run(ctx);
  } catch (e) {
    console.log(`FAIL group ${name} crashed — ${String(e.message).slice(0, 200)}`);
    ctx.results.push({ name: `${name}:crash`, ok: false, detail: String(e.message).slice(0, 200) });
  }
}

writeFileSync(`${shotDir}/deep-e2e.json`, JSON.stringify(ctx.results, null, 2));
const failed = ctx.results.filter((r) => !r.ok);
const skipped = ctx.results.filter((r) => r.skipped);
console.log(`\ndeep e2e: ${ctx.results.length - failed.length - skipped.length}/${ctx.results.length} pass, ${skipped.length} skipped, ${failed.length} failed`);
ctx.close();
process.exit(failed.length ? 1 : 0);
