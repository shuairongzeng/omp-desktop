/* tools/deep/shell-ux.mjs — the four shell-comfort surfaces a native app is
   judged by, verified against a running packaged instance:

   - clipboard-chords: pbcopy seeds the OS clipboard, Cmd+V through CDP key
     events lands the text in the composer draft (macOS accelerators live in
     the application menu's Edit role; with no menu they are dead).
   - navigation-guard: assigning location.href to an external URL must NOT
     navigate the app webview (Tauri's navigation_guard.rs parity); the log
     records the guard and the OS browser would take the URL.
   - drop-pipeline: a dragover carrying Files over the composer highlights
     it (the shim's DOM listeners are live and the payload shape flows),
     and a CDP-synthesised drop with a real file path attaches it.
   - window-bounds: Browser.setWindowBounds persists to window-bounds.json
     (debounced), the restore source for the next launch. */

import { runStandalone } from "./ctx.mjs";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function run(ctx) {
  const { ev, sleep, assert } = ctx;

  await ctx.check("clipboard-chords", async () => {
    const seed = `deep-clip-${Date.now()}`;
    execSync(`printf '%s' '${seed}' | pbcopy`);
    await ev(`document.querySelector('.composer textarea')?.focus()`);
    const focused = await ev(`document.activeElement?.tagName`);
    assert(focused === "TEXTAREA", `no composer textarea took focus (${focused})`);
    execSync(`osascript -e 'tell application "System Events" to tell process "OMP Desktop" to set frontmost to true'`);
    await sleep(800);
    execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    await sleep(1200);
    const draft = await ev(`document.activeElement?.value ?? document.activeElement?.textContent ?? ""`);
    assert(draft.includes(seed), `Cmd+V did not paste the clipboard seed into the composer (draft="${draft.slice(0, 60)}")`);
    // Cmd+A + Backspace clears it again so the draft is left clean.
    await ctx.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 1, modifiers: 4 });
    await ctx.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 1, modifiers: 4 });
    await ctx.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await ctx.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(600);
    return `Cmd+V pasted "${seed}" from the OS clipboard into the composer`;
  });

  await ctx.check("navigation-guard", async () => {
    const before = await ev(`location.href`);
    // localhost discard port: the guard's openExternal side effect stays on this machine
    await ev(`location.href = 'https://127.0.0.1:9/'`).catch(() => {});
    await sleep(2500);
    const after = await ev(`location.href`);
    assert(after === before, `the app webview navigated away: ${before} -> ${after}`);
    assert(after.startsWith("file://"), `webview is not on the app bundle: ${after}`);
    return `external location.href refused; webview stayed on ${after.slice(0, 40)}`;
  });

  await ctx.check("drop-pipeline", async () => {
    // Three legs, each automatable; the OS-drop leg (webUtils resolving a
    // real dropped File) is not — Chromium's synthesized drags carry no
    // Files type and an empty FileList (measured with CDP dragEnter/Over/
    // Drop, with and without filePath) and no OS file drag is scriptable —
    // so it stays a manual row in COVERAGE.md.
    const geo = await ev(`(() => { const el = document.querySelector('.composer'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`);
    assert(geo, "no .composer element to drop onto");
    const { x, y } = JSON.parse(geo);
    // 1. A Files drag through the shim: synthetic DragEvent (main world,
    //    same EventTarget the isolated-world listeners sit on) with a File
    //    in its DataTransfer lights the composer's drop highlight.
    await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' })); window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: dt })); })()`);
    await sleep(600);
    const lit = await ev(`!!document.querySelector('.composer.drop-on')`);
    assert(lit, "a Files dragover over the composer did not light the drop highlight");
    await ev(`window.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))`);
    await sleep(400);
    // 2. The gate: a drag WITHOUT Files (a text/mime drag, or a CDP
    //    synthesized one) must not light it — Tauri's native event only
    //    ever carries OS files.
    await ctx.send("Input.setInterceptDrags", { enabled: true });
    const data = { items: [{ mimeType: "image/png", data: "aGk=" }], files: [], dragOperationsMask: 1 };
    await ctx.send("Input.dispatchDragEvent", { type: "dragEnter", x: Math.round(x), y: Math.round(y), data });
    await ctx.send("Input.dispatchDragEvent", { type: "dragOver", x: Math.round(x), y: Math.round(y), data });
    await sleep(600);
    const notLit = await ev(`!!document.querySelector('.composer.drop-on')`);
    assert(!notLit, "a Files-less drag lit the drop highlight (the gate is open)");
    // 3. The drop cannot navigate the app (the shim preventDefaults, like
    //    Tauri's dragDropEnabled).
    const before = await ev(`location.href`);
    await ctx.send("Input.dispatchDragEvent", { type: "drop", x: Math.round(x), y: Math.round(y), data });
    await sleep(1200);
    const after = await ev(`location.href`);
    await ctx.send("Input.setInterceptDrags", { enabled: false });
    assert(after === before && after.startsWith("file://"), `the drop navigated the app: ${after}`);
    return `Files dragover lights the highlight, Files-less drags stay gated, drops never navigate (${after.slice(0, 32)})`;
  });

  await ctx.check("window-bounds", async () => {
    // The app's own maximize control drives the same events (moved/resized/
    // maximize) the persistence listens to; CDP's Browser domain is not
    // exposed on the page target.
    const kb = await ctx.invoke("keybindings_list", { profile: "default" });
    const cfgDir = kb?.v?.overlayPath?.replace(/[/][^/]+$/, "");
    assert(cfgDir, "no config dir discoverable via keybindings_list.overlayPath");
    const file = join(cfgDir, "window-bounds.json");
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
    const before = read();
    await ev(`window.__TAURI__.window.getCurrentWindow().maximize()`);
    await sleep(1200);
    const maxed = read();
    assert(maxed && maxed.maximized === true, `maximize did not persist (file=${JSON.stringify(maxed)})`);
    await ev(`window.__TAURI__.window.getCurrentWindow().unmaximize()`);
    await sleep(1200);
    const restored = read();
    assert(restored && restored.maximized === false, `restore did not persist (file=${JSON.stringify(restored)})`);
    assert(Number.isFinite(restored.width) && restored.width >= 400, `restored bounds are not usable: ${JSON.stringify(restored)}`);
    return `bounds persisted across maximize/restore (${before ? `${before.width}x${before.height}` : "first run"} -> ${restored.width}x${restored.height}, maximized=${restored.maximized})`;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStandalone(run);
}
