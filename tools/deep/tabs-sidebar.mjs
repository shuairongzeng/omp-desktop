/* tools/deep/tabs-sidebar.mjs — deep E2E group: the tab bar and the project
   sidebar (open/close/reopen/rename/middle-click + sidebar recents and the
   project row's context menu).

   Fixture (see the instance discipline): one seed tab on /Users/jackey/GitHub/
   chuti whose conversation already exists on disk. Everything the group does
   happens through REAL input (CDP mouse/keyboard events) or the app's own
   bridge, and every check ends on an external consequence:

     tab-switch           the header label follows the click AND a send lands in
                          the tab's own session jsonl (the other file's size is
                          reported, not asserted — sibling instances share it)
     tab-close            open-tabs.json loses the entry AND the scoped omp
                          process disappears from the process table
     reopen-closed        Ctrl+Shift+T brings the same conversation file back
     tab-rename           the typed title reaches open-tabs.json's `name`
     middle-click-close   tabs drop, process drops, the jsonl survives
     sidebar-recent-remove       recent-projects.json loses the path
     project-menu-copy           pbpaste equals the project path
     project-menu-reveal         Finder becomes the frontmost process

   `omp` normalises a `/rename` title (measured: typed "deep-probe-renamed"
   came back as "🔬 PROBE: deep-probe-renamed"), so the rename check asserts
   the typed title is CONTAINED in the persisted name, not equal to it. */

import { runStandalone } from "./ctx.mjs";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SEED_PATH = "/Users/jackey/GitHub/chuti";
const SEED_NAME = "chuti";
const PROJ_PATH = "/tmp/deep-cfg-tabs-sidebar-proj";
const PROJ_NAME = "deep-cfg-tabs-sidebar-proj";
const APP_NAME = "OMP Desktop";
const APP_PATH = "/Users/jackey/GitHub/omp-desktop-electron/release/OMP Desktop.app";
// Scoped so sibling deep-E2E instances (their own omp children are also
// `--mode rpc-ui`) cannot swing the count.
const PROC_PATTERN = `omp --mode rpc-ui.*--cwd=${PROJ_PATH}`;
const CFG_FALLBACK = "/tmp/deep-cfg-tabs-sidebar";

export async function run(ctx) {
  const { ev, sleep, assert } = ctx;

  // ── this instance's config dir (the app's own answer, not a guess) ───────
  const kb = await ctx.invoke("keybindings_list", { profile: "default" });
  const cfgDir = kb?.ok && typeof kb.v?.overlayPath === "string"
    ? dirname(kb.v.overlayPath)
    : CFG_FALLBACK;
  const tabsFile = join(cfgDir, "open-tabs.json");
  const recentsFile = join(cfgDir, "recent-projects.json");

  const layout = () => JSON.parse(ctx.readDisk(tabsFile));
  const tryLayout = () => { try { return layout(); } catch { return null; } };
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return -1; } };
  const textOf = (f) => { try { return ctx.readDisk(f); } catch { return ""; } };
  const procs = () => Number(ctx.pgrep(PROC_PATTERN));

  /** Poll `fn` every 250ms; first truthy value wins, null on timeout. */
  const until = async (fn, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(250);
    }
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  const tabs = () => ev(`[...document.querySelectorAll('.tab[data-tab-id]:not(.app-tab)')].map(t => ({
    id: t.dataset.tabId,
    active: t.classList.contains('active'),
    name: (t.querySelector('.tab-name')?.textContent ?? '').trim(),
    closeLabel: t.querySelector('.tab-close')?.getAttribute('aria-label') ?? null,
  }))`);

  /** A tab's label is `folder · title` once the title adds information and
   *  just the title otherwise; the chrome header shows the title part. */
  const titleOf = (label) => (label.includes("·") ? label.split("·").slice(1).join("·").trim() : label);

  const pointOfExpr = (expr) => ev(`(() => {
    const el = ${expr};
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return { hidden: true };
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  const pointOf = (selector) => pointOfExpr(`document.querySelector(${JSON.stringify(selector)})`);

  const mouse = (type, p, button = "none", clickCount = 1) =>
    ctx.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button, clickCount });

  const clickPoint = async (p, button = "left") => {
    assert(p && !p.hidden, `click target is not visible (${JSON.stringify(p)})`);
    await mouse("mouseMoved", p, button === "left" ? "none" : button);
    await mouse("mousePressed", p, button, 1);
    await mouse("mouseReleased", p, button, 1);
  };

  const doubleClickPoint = async (p) => {
    assert(p && !p.hidden, `double-click target is not visible (${JSON.stringify(p)})`);
    await mouse("mouseMoved", p);
    await mouse("mousePressed", p, "left", 1);
    await mouse("mouseReleased", p, "left", 1);
    await mouse("mousePressed", p, "left", 2);
    await mouse("mouseReleased", p, "left", 2);
  };

  const keyEvent = (type, opts) => ctx.send("Input.dispatchKeyEvent", { type, ...opts });

  const ensureSidebar = async () => {
    if (await ev(`!!document.querySelector('.project-sidebar')`)) return;
    // The tab bar's first .tab-add is the sidebar toggle.
    await clickPoint(await pointOf(".tabs > button.tab-add"));
    const shown = await until(() => ev(`!!document.querySelector('.project-sidebar')`), 5000);
    assert(shown, "project sidebar did not open");
  };

  /** The open tab's project row (single-tab groups render one row). */
  const seedRowPoint = () => pointOfExpr(
    `[...document.querySelectorAll('.psb-row.psb-project')].find(r => (r.textContent || '').includes(${JSON.stringify(SEED_NAME)}))`,
  );

  /** A recent row's "remove from recent" button: `.psb-actions` renders on
   *  row hover (CSS), so hover first; the focus-within fallback keeps the
   *  click possible if the synthetic hover did not land. */
  const recentRemovePoint = async (canonical) => {
    const rowExpr = `[...document.querySelectorAll('.psb-row.psb-recent')]
      .find(r => r.querySelector('.psb-main')?.getAttribute('title') === ${JSON.stringify(canonical)})`;
    const row = await pointOfExpr(rowExpr);
    assert(row && !row.hidden, `recent row ${canonical} is not visible`);
    await mouse("mouseMoved", row);
    await sleep(400);
    const btnExpr = `(${rowExpr})?.querySelector('.psb-act[title="remove from recent"]')`;
    let p = await pointOfExpr(btnExpr);
    if (!p || p.hidden) {
      p = await ev(`(() => {
        const b = ${btnExpr};
        if (!b) return null;
        b.focus();
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        return r.width && r.height
          ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
          : { hidden: true };
      })()`);
    }
    return p;
  };

  const frontmost = () => {
    try {
      return execSync(`osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const activateApp = () => {
    try {
      execSync(`osascript -e 'tell application "${APP_NAME}" to activate'`, { stdio: "ignore" });
      return true;
    } catch {
      try { execSync(`open -a ${JSON.stringify(APP_PATH)}`, { stdio: "ignore" }); return true; }
      catch { return false; }
    }
  };

  // ── fixture helpers ──────────────────────────────────────────────────────
  /** Close every tab of the throwaway project (start + teardown). */
  const closeTempTabs = async () => {
    for (let i = 0; i < 6; i += 1) {
      const temp = (await tabs()).find((t) => t.name.includes(PROJ_NAME));
      if (!temp) return;
      const p = await pointOf(`[data-tab-id="${temp.id}"] .tab-close`);
      if (!p || p.hidden) return;
      await clickPoint(p);
      await sleep(1200);
    }
  };

  await ctx.clearPoison();
  mkdirSync(PROJ_PATH, { recursive: true });
  await closeTempTabs();

  // State handed between checks (the closed tab's conversation file).
  const shared = { tempFile: null };

  // ── 1. tab-switch ────────────────────────────────────────────────────────
  await ctx.check("tab-switch", async () => {
    const seedList = await tabs();
    assert(seedList.length === 1, `expected the seed tab alone before opening, saw ${seedList.length}`);
    assert(seedList[0].name.includes(SEED_NAME), `seed tab not in the bar (saw "${seedList[0].name}")`);
    assert(String(seedList[0].closeLabel ?? "").startsWith("close"),
      `seed tab close button aria-label was "${seedList[0].closeLabel}"`);

    await ctx.ev(`window.OMP_BRIDGE.openSession(${JSON.stringify(PROJ_PATH)})`);
    const opened = await until(async () => {
      const l = await tabs();
      return l.length === 2 && l.some((t) => t.name.includes(PROJ_NAME)) ? l : null;
    }, 20000);
    assert(opened, `the second tab did not appear (tabs: ${JSON.stringify(await tabs())})`);

    const seedTab = opened.find((t) => t.name.includes(SEED_NAME));
    const tempTab = opened.find((t) => t.name.includes(PROJ_NAME));
    assert(seedTab && tempTab, `could not identify both tabs: ${JSON.stringify(opened)}`);

    // The layout is written twice for a fresh tab: first with sessionFile
    // null (omp has not reported the conversation yet), then with the file.
    const saved = await until(() => {
      const l = tryLayout();
      const entry = l?.tabs.find((t) => t.path === PROJ_PATH);
      return l.tabs.length === 2 && entry && typeof entry.sessionFile === "string" && entry.sessionFile
        ? l : null;
    }, 20000);
    assert(saved, `open-tabs.json never carried both conversations with a sessionFile `
      + `(now: ${JSON.stringify(tryLayout()?.tabs.map((t) => ({ path: t.path, sessionFile: t.sessionFile })))})`);
    const seedEntry = saved.tabs.find((t) => t.path === SEED_PATH);
    const tempEntry = saved.tabs.find((t) => t.path === PROJ_PATH);
    assert(seedEntry?.sessionFile, "open-tabs.json has no sessionFile for the seed tab");
    assert(tempEntry?.sessionFile, "open-tabs.json has no planned sessionFile for the new tab");

    const header = () => ev(`document.querySelector('.chrome-title-project')?.textContent ?? ''`);
    const activateAndRead = (tab) => until(async () => {
      const l = await tabs();
      const active = l.find((t) => t.active);
      if (!active || active.id !== tab.id) return null;
      const label = await header();
      return label === titleOf(active.name) ? { header: label, id: active.id } : null;
    }, 10000);

    await clickPoint(await pointOf(`[data-tab-id="${seedTab.id}"] .tab-name`));
    const onSeed = await activateAndRead(seedTab);
    assert(onSeed, `clicking the seed tab did not activate it with its own header (header "${await header()}")`);

    await clickPoint(await pointOf(`[data-tab-id="${tempTab.id}"] .tab-name`));
    const onTemp = await activateAndRead(tempTab);
    assert(onTemp, `clicking the new tab did not switch to it (header "${await header()}")`);
    assert(onSeed.header !== onTemp.header,
      `header did not change between tabs ("${onSeed.header}" vs "${onTemp.header}")`);

    // The send must land in the ACTIVE tab's own conversation file. The
    // other tab's file is only reported: sibling instances resume the same
    // seed conversation, so asserting "untouched" would be a race.
    const seedBefore = sizeOf(seedEntry.sessionFile);
    const tempBefore = sizeOf(tempEntry.sessionFile);
    assert(await ctx.sendPrompt("/status") === 1, "window.OMP_BRIDGE.send is not available");
    const landed = await until(() => {
      const size = sizeOf(tempEntry.sessionFile);
      const txt = textOf(tempEntry.sessionFile);
      return txt.includes('"text":"/status"') && size > Math.max(0, tempBefore) ? size : null;
    }, 25000);
    assert(landed != null,
      `the send never reached ${tempEntry.sessionFile} (exists=${existsSync(tempEntry.sessionFile)})`);
    const seedAfter = sizeOf(seedEntry.sessionFile);

    return `tabs ${seedTab.id} ⇄ ${tempTab.id}; header "${onSeed.header}" ⇄ "${onTemp.header}"; `
      + `/status user row landed in ${PROJ_NAME}'s jsonl (${tempBefore}→${landed} bytes); `
      + `seed jsonl ${seedBefore}→${seedAfter}`;
  });

  // ── 2. tab-close ─────────────────────────────────────────────────────────
  await ctx.check("tab-close", async () => {
    const before = await tabs();
    assert(before.length === 2, `expected 2 tabs before closing, saw ${before.length}`);
    const temp = before.find((t) => t.name.includes(PROJ_NAME));
    assert(temp, `no tab for ${PROJ_NAME}: ${JSON.stringify(before)}`);
    const entry = tryLayout()?.tabs.find((t) => t.path === PROJ_PATH);
    assert(entry?.sessionFile, "the tab's conversation file is not in open-tabs.json");
    shared.tempFile = entry.sessionFile;
    const procsBefore = procs();
    assert(procsBefore === 1, `expected 1 omp child for ${PROJ_NAME}, saw ${procsBefore}`);

    const p = await pointOf(`[data-tab-id="${temp.id}"] .tab-close`);
    assert(p && !p.hidden, "the tab's × button is not clickable");
    await clickPoint(p);

    const after = await until(async () => {
      const l = await tabs();
      const l2 = tryLayout();
      const n = procs();
      return l.length === 1 && l2?.tabs.length === 1 && n === 0 ? { l, l2, n } : null;
    }, 15000);
    assert(after, `close did not take effect (tabs=${(await tabs()).length}, `
      + `layout=${JSON.stringify(tryLayout()?.tabs.map((t) => t.path))}, procs=${procs()})`);
    assert(after.l2.tabs[0].path === SEED_PATH,
      `the surviving tab is not the seed: ${after.l2.tabs[0].path}`);

    return `tab ${temp.id} closed via its × (aria-label "${temp.closeLabel}"); `
      + `open-tabs.json 2→1 entries; scoped pgrep ${procsBefore}→${after.n}`;
  });

  // ── 3. reopen-closed ─────────────────────────────────────────────────────
  await ctx.check("reopen-closed", async () => {
    assert(shared.tempFile, "no closed conversation recorded by tab-close");
    const before = await tabs();
    assert(before.length === 1, `expected the seed tab alone before reopening, saw ${before.length}`);

    const chord = { modifiers: 10, key: "t", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 };
    await keyEvent("rawKeyDown", chord);
    await keyEvent("keyUp", chord);

    const back = await until(async () => {
      const l = await tabs();
      const entry = tryLayout()?.tabs.find((t) => t.path === PROJ_PATH);
      return l.length === 2 && entry ? { l, entry } : null;
    }, 25000);
    assert(back, `Ctrl+Shift+T did not bring the tab back (tabs=${(await tabs()).length})`);
    assert(back.entry.sessionFile === shared.tempFile,
      `reopened a different conversation: ${back.entry.sessionFile} ≠ ${shared.tempFile}`);
    const reopened = back.l.find((t) => t.name.includes(PROJ_NAME));
    assert(reopened, `the reopened tab is not in the bar: ${JSON.stringify(back.l)}`);

    return `Ctrl+Shift+T: tabs 1→2, conversation ${shared.tempFile.split("/").pop()} resumed (tab ${reopened.id})`;
  });

  // ── 4. tab-rename ────────────────────────────────────────────────────────
  await ctx.check("tab-rename", async () => {
    const list = await tabs();
    const temp = list.find((t) => t.name.includes(PROJ_NAME));
    assert(temp, `no tab for ${PROJ_NAME}: ${JSON.stringify(list)}`);
    const title = `deep-renamed-${Date.now().toString(36)}`;

    await clickPoint(await pointOf(`[data-tab-id="${temp.id}"] .tab-name`));
    await sleep(700);
    await doubleClickPoint(await pointOf(`[data-tab-id="${temp.id}"] .tab-name`));

    const field = await until(() => ev(`(() => {
      const i = document.querySelector('.rename-field');
      return i ? { value: i.value, focused: document.activeElement === i } : null;
    })()`), 6000);
    assert(field, "double-clicking the tab title did not open the inline rename field");
    assert(field.focused, "the rename field is not focused");

    await ctx.send("Input.insertText", { text: title });
    const typed = await until(() => ev(`document.querySelector('.rename-field')?.value === ${JSON.stringify(title)}`), 5000);
    assert(typed, `typing did not reach the rename field (value "${await ev(`document.querySelector('.rename-field')?.value ?? null`)}")`);

    await keyEvent("keyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    await keyEvent("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

    const named = await until(() => {
      const entry = tryLayout()?.tabs.find((t) => t.path === PROJ_PATH);
      return typeof entry?.name === "string" && entry.name.includes(title) ? entry.name : null;
    }, 30000);
    assert(named, `open-tabs.json never recorded the typed title "${title}" `
      + `(name=${JSON.stringify(tryLayout()?.tabs.find((t) => t.path === PROJ_PATH)?.name)})`);

    return `double-click → typed "${title}" → open-tabs.json name = "${named}"`;
  });

  // ── 5. middle-click-close ────────────────────────────────────────────────
  await ctx.check("middle-click-close", async () => {
    const before = await tabs();
    assert(before.length === 2, `expected 2 tabs before the middle click, saw ${before.length}`);
    const temp = before.find((t) => t.name.includes(PROJ_NAME));
    assert(temp, `no tab for ${PROJ_NAME}: ${JSON.stringify(before)}`);
    const entry = tryLayout()?.tabs.find((t) => t.path === PROJ_PATH);
    assert(entry?.sessionFile, "open-tabs.json lost the tab's conversation file");
    const file = entry.sessionFile;
    const sizeBefore = sizeOf(file);
    assert(sizeBefore > 0, `conversation jsonl is missing/empty before the click: ${file}`);
    const procsBefore = procs();

    await clickPoint(await pointOf(`[data-tab-id="${temp.id}"]`), "middle");

    const after = await until(async () => {
      const l = await tabs();
      const l2 = tryLayout();
      const n = procs();
      return l.length === 1 && l2?.tabs.length === 1 && n === 0 ? { l, l2, n } : null;
    }, 15000);
    assert(after, `middle click did not close the tab (tabs=${(await tabs()).length}, procs=${procs()})`);
    assert(!after.l.some((t) => t.name.includes(PROJ_NAME)), `the middle-clicked tab is still in the bar`);

    assert(existsSync(dirname(file)), `the conversation's session dir was removed: ${dirname(file)}`);
    const sizeAfter = sizeOf(file);
    assert(sizeAfter > 0, `the conversation jsonl disappeared after the close: ${file}`);

    return `middle click closed tab ${temp.id}: tabs 2→1, scoped pgrep ${procsBefore}→${after.n}, `
      + `conversation kept on disk (${file.split("/").pop()}, ${sizeBefore}→${sizeAfter} bytes)`;
  });

  // ── 6. sidebar-recent-remove ─────────────────────────────────────────────
  await ctx.check("sidebar-recent-remove", async () => {
    await ensureSidebar();
    const canonical = realpathSync(PROJ_PATH);
    const rows = () => ev(`[...document.querySelectorAll('.psb-row.psb-recent')]
      .map(r => r.querySelector('.psb-main')?.getAttribute('title') ?? null)`);

    const row = await until(async () => ((await rows()) ?? []).includes(canonical) ? canonical : null, 10000);
    assert(row, `no recent row titled "${canonical}" (rows: ${JSON.stringify(await rows())})`);

    const before = JSON.parse(ctx.readDisk(recentsFile));
    assert(before.entries.some((e) => e.path === canonical),
      `recent-projects.json does not list ${canonical} before the click`);

    const p = await recentRemovePoint(canonical);
    assert(p && !p.hidden, '"remove from recent" button is not clickable');
    await clickPoint(p);

    const gone = await until(async () => {
      let after = null;
      try { after = JSON.parse(ctx.readDisk(recentsFile)); } catch { return null; }
      const stillRow = ((await rows()) ?? []).includes(canonical);
      return after.entries.every((e) => e.path !== canonical) && !stillRow ? after : null;
    }, 12000);
    assert(gone, `recent-projects.json still lists ${canonical} after the remove click`);

    return `"remove from recent" on ${canonical}: recent-projects.json ${before.entries.length}→${gone.entries.length} entries, row gone`;
  });

  // ── 7. project-menu-copy ─────────────────────────────────────────────────
  await ctx.check("project-menu-copy", async () => {
    await ensureSidebar();
    // Clipboard writes need the renderer focused; also makes the assertion
    // meaningful (the system clipboard starts from a sentinel value).
    activateApp();
    await sleep(1200);
    execSync("printf 'clipboard-sentinel' | pbcopy");

    const row = await seedRowPoint();
    assert(row && !row.hidden, "the seed project row is not in the sidebar");
    await clickPoint(row, "right");

    const labels = await until(() => ev(`[...document.querySelectorAll('.tab-menu-item')]
      .map(b => (b.textContent || '').trim())`), 6000);
    assert(Array.isArray(labels) && labels.some((t) => t.startsWith("Copy project path")),
      `context menu has no "Copy project path" row (saw ${JSON.stringify(labels)})`);

    const item = await pointOfExpr(`[...document.querySelectorAll('.tab-menu-item')]
      .find(b => (b.textContent || '').trim().startsWith('Copy project path'))`);
    await clickPoint(item);

    const pasted = await until(() => {
      const v = ctx.pbpaste().trim();
      return v === SEED_PATH ? v : null;
    }, 8000);
    assert(pasted, `clipboard holds "${ctx.pbpaste().trim()}" after "Copy project path" (expected ${SEED_PATH})`);
    await until(() => ev(`document.querySelectorAll('.tab-menu-item').length === 0`), 4000);

    return `context menu → "Copy project path": pbpaste = ${pasted}`;
  });

  // ── 8. project-menu-reveal ───────────────────────────────────────────────
  await ctx.check("project-menu-reveal", async () => {
    await ensureSidebar();
    activateApp();
    await sleep(1500);
    const before = frontmost();
    assert(before && before !== "Finder",
      `Finder was already/again frontmost before the click (frontmost="${before}")`);

    const row = await seedRowPoint();
    assert(row && !row.hidden, "the seed project row is not in the sidebar");
    await clickPoint(row, "right");

    const item = await until(() => pointOfExpr(`[...document.querySelectorAll('.tab-menu-item')]
      .find(b => (b.textContent || '').trim().startsWith('Reveal in Finder'))`), 6000);
    assert(item && !item.hidden, `context menu has no "Reveal in Finder" row (frontmost="${frontmost()}")`);
    await clickPoint(item);

    // Focus is unreliable on this machine (locked screen, no frontmost
    // process), so the evidence is Finder's own window list: reveal opens
    // a window named after the folder.
    const finderWindows = () => {
      try {
        return execSync(`osascript -e 'tell application "Finder" to get name of every window'`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { return ""; }
    };
    // Evidence = Finder's FRONT window target. A stale chuti window makes
    // counting useless (Finder reuses it), and Finder cannot close windows
    // by name here (-10010); so park the front window on /tmp first, then
    // the reveal must bring chuti to the front.
    const frontTarget = () => {
      try {
        return execSync(`osascript -e 'tell application "Finder" to get POSIX path of (target of front window as alias)'`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { return ""; }
    };
    try {
      execSync(`osascript -e 'tell application "Finder" to open (POSIX file "/tmp")'`, { stdio: "ignore" });
    } catch { /* no Finder window possible: the check below will fail loudly */ }
    await sleep(800);
    const parked = frontTarget();
    assert(parked && !parked.startsWith("/Users/jackey/GitHub/chuti"),
      `could not park Finder's front window off chuti (front="${parked}")`);
    await clickPoint(row, "right");
    const item2 = await until(() => pointOfExpr(`[...document.querySelectorAll('.tab-menu-item')]
      .find(b => (b.textContent || '').trim().startsWith('Reveal in Finder'))`), 6000);
    assert(item2 && !item2.hidden, "context menu has no Reveal row");
    await clickPoint(item2);
    const shown = await until(() => {
      const t = frontTarget();
      return t.replace(/\/$/, "") === SEED_PATH.replace(/\/$/, "") ? t : null;
    }, 12000);
    assert(shown, `Finder front window stayed "${frontTarget()}" after Reveal on ${SEED_PATH}`);
    return `Reveal in Finder on ${SEED_PATH}: front window "${parked}" → ${shown}`;
  });

  // ── teardown: leave only the seed tab, hand focus back to the app ────────
  await closeTempTabs();
  activateApp();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStandalone(run);
}