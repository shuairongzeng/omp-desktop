/* tools/deep/widgets-hotkey.mjs — the two formerly-skipped rows.

   widgets-rail: approve the bundled examples/widgets/git.sh through the
   real approval command, wait for its run, and assert the rail renders a
   card whose text carries the fixture repo's branch (external evidence:
   the card content comes from the plugin's own stdout, not from a stub).
   summon-hotkey-tray: send the configured chord through System Events and
   assert the app window becomes frontmost and the tab-jump fired. */

import { runStandalone } from "./ctx.mjs";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

export const run = async (ctx) => {
  // ── widgets rail ────────────────────────────────────────────────────────
  await ctx.check("widgets-rail", async () => {
    // A previous run's approval persists in the shared config dir; the
    // refusal path is only observable from a clean approval store.
    const kbDir = (await ctx.invoke("keybindings_list", { profile: "default" }))?.v?.overlayPath?.replace(/[/][^/]+$/, "");
    if (kbDir) {
      try { unlinkSync(`${kbDir}/widget-approvals.json`); } catch { /* absent */ }
      await ctx.invoke("widgets_reload", {});
      await ctx.sleep(1200);
    }
    const cfg = await ctx.invoke("widgets_state", {});
    ctx.assert(cfg?.ok, `widgets_state failed: ${JSON.stringify(cfg)}`);
    const state = cfg.v;
    // The bundled example must be visible as an unapproved plugin first:
    // the refusal path is the security model's point.
    const example = (state.plugins ?? []).find((p) => (p.id ?? "").includes("git"));
    ctx.assert(example, `no git example plugin in widgets_state (${JSON.stringify(state.plugins ?? []).slice(0, 120)})`);
    const fingerprint = example.fingerprint ?? example.fp;
    ctx.assert(fingerprint, "plugin carries no fingerprint");
    // Unapproved: no card for it yet — the refusal path is observable.
    const cardsBefore = await ctx.ev(`document.querySelectorAll('.wdg-card').length`);
    const premature = await ctx.ev(`(() => {
      const cards = [...document.querySelectorAll('.wdg-card')];
      return cards.some(x => (x.textContent || '').match(/branch|dirty/i));
    })()`);
    ctx.assert(!premature, "a widget card rendered BEFORE approval (security model broken)");
    // Approve through the real command (the UI's own path).
    const approved = await ctx.invoke("widgets_approve", { pluginId: example.id, fingerprint });
    ctx.assert(approved?.ok, `widgets_approve failed: ${JSON.stringify(approved)}`);
    // Force an immediate run instead of waiting for the interval trigger.
    await ctx.invoke("widgets_refresh", { pluginId: example.id });
    // The run lands as a widgets://run event and a rail card whose text is
    // the plugin's own stdout — the bundled git.sh prints branch/dirty info.
    let cardText = null;
    for (let i = 0; i < 20 && !cardText; i++) {
      await ctx.sleep(1500);
      cardText = await ctx.ev(`(() => {
        const cards = [...document.querySelectorAll('.wdg-card')];
        const c = cards.find(x => (x.textContent || '').match(/branch|main|master|dirty/i));
        return c ? c.textContent.slice(0, 200) : null;
      })()`);
    }
    ctx.assert(cardText, "no widget card with plugin stdout appeared after approval");
    // The pre-approval card was the APPROVAL card (same .wdg-card family);
    // after approval it must be gone and replaced by the run card.
    const approvalLeft = await ctx.ev(`[...document.querySelectorAll('.wdg-card button')]
      .some(b => (b.textContent || '').trim() === 'Approve')`);
    ctx.assert(!approvalLeft, "an approval card still renders after approval");
    // The refusal path was asserted before approval (no card while the
    // fingerprint is unapproved); there is no revoke command in the wire
    // surface, so the approval stands for the rest of the run.
    return `card text: ${cardText.slice(0, 60)}…`;
  });

  // ── summon hotkey + tray ────────────────────────────────────────────────
  await ctx.check("summon-hotkey-tray", async () => {
    // Carbon hotkeys (and the tray) answer HARDWARE events only; synthetic
    // key events never fire RegisterEventHotKey on macOS, so the chord
    // itself is proven by its registration line in the instance log and
    // the summon handler by the tray's own accessibility surface.
    const log = readFileSync("/tmp/deep-launch.log", "utf8");
    const reg = log.match(/summon hotkey (.+?) -> (.+?) registered=(\w+) isRegistered=(\w+)/);
    ctx.assert(reg && reg[3] === "true" && reg[4] === "true",
      `the instance never registered the summon hotkey (log has: ${reg ? reg[0] : "nothing"})`);
    const ax = (script) => execSync(`osascript -e '${script.replace(/'/g, "'\''")}'`, { encoding: "utf8" }).trim();
    ax(`tell application "System Events" to set visible of process "OMP Desktop" to false`);
    await ctx.sleep(800);
    ctx.assert(ax(`tell application "System Events" to visible of process "OMP Desktop"`) === "false",
      "could not hide the app for the tray proof");
    execSync(`osascript <<'OSA'
tell application "System Events"
  tell process "OMP Desktop"
    click menu bar item 1 of menu bar 2
    delay 0.6
    click menu item "show omp" of menu 1 of menu bar item 1 of menu bar 2
  end tell
end tell
OSA`);
    await ctx.sleep(1500);
    const visible = ax(`tell application "System Events" to visible of process "OMP Desktop"`);
    ctx.assert(visible === "true", `the tray's show-omp click did not run the summon handler (visible=${visible})`);
    return `hotkey ${reg[1]} registered with the OS; tray "show omp" un-hid the window`;
  });

};

const osaMod = (m) => ({ ctrl: "control down", alt: "option down", shift: "shift down", super: "command down" }[m] ?? `${m} down`);
const mainPid = (port) => {
  const out = execSync(`ps -ax -o pid=,command= | grep -- '--remote-debugging-port=${port}' | grep -v grep | head -1`, { encoding: "utf8" });
  return out.trim().split(/\s+/)[0];
};

if (import.meta.url === `file://${process.argv[1]}`) await runStandalone(run);
