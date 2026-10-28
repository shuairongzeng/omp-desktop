/* tools/deep/external-open.mjs — the OS folder-open channel.

   Evidence chain: launch a SECOND instance of the packaged app with a
   folder argument; the running instance's single-instance/second-instance
   path queues it and the FIRST instance's frontend drains it into a new
   tab — observable as open-tabs.json gaining the folder and the tab bar
   showing it. */

import { runStandalone } from "./ctx.mjs";
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export const run = async (ctx) => {
  await ctx.check("external-open-argv", async () => {
    const dir = "/tmp/deep-external-open-proj";
    execSync(`mkdir -p ${dir}`);
    const kb = await ctx.invoke("keybindings_list", { profile: "default" });
    const cfg = kb?.v?.overlayPath?.replace(/[/][^/]+$/, "");
    ctx.assert(cfg, "no config dir discoverable via keybindings_list.overlayPath");
    const before = JSON.parse(readFileSync(`${cfg}/open-tabs.json`, "utf8")).tabs.length;
    // A second instance forwards its argv to the running one (Electron's
    // single-instance behaviour via requestSingleInstanceLock in main).
    const appPath = "/Users/jackey/GitHub/omp-desktop-electron/release/OMP Desktop.app/Contents/MacOS/OMP Desktop";
    // Same userData dir as the running instance: Electron's single-instance
    // lock is per userData, so a differently-configured second launch would
    // start its own app instead of forwarding argv.
    const child = spawn(appPath, [`--remote-debugging-port=${ctx.port + 500}`, `--user-data-dir=${cfg}/userdata`, dir], {
      detached: true, stdio: "ignore",
      env: { ...process.env, OMP_PORT_CONFIG_DIR: cfg },
    });
    child.unref();
    let tabs = before;
    for (let i = 0; i < 20 && tabs === before; i++) {
      await ctx.sleep(1000);
      tabs = JSON.parse(readFileSync(`${cfg}/open-tabs.json`, "utf8")).tabs.length;
    }
    ctx.assert(tabs === before + 1, `open-tabs.json did not gain the forwarded folder (${before} -> ${tabs})`);
    const shown = await ctx.ev(`[...document.querySelectorAll('.tab')]
      .some(t => (t.textContent || '').includes('deep-external-open-proj'))`);
    ctx.assert(shown, "the tab bar does not show the externally opened folder");
    // teardown: close the new tab through the UI's own path
    await ctx.ev(`(() => {
      const t = [...document.querySelectorAll('.tab')].find(x => (x.textContent || '').includes('deep-external-open-proj'));
      t?.querySelector('[aria-label^="close"]')?.click();
      return 1;
    })()`);
    await ctx.sleep(1500);
    return `forwarded argv opened ${dir} as a tab (open-tabs ${before} -> ${tabs})`;
  });
};

if (import.meta.url === `file://${process.argv[1]}`) await runStandalone(run);
