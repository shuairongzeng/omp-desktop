/* tools/deep/composer.mjs — deep E2E checks for the prompt composer.

   Every check proves its feature by an external consequence: the seed
   session's .jsonl on disk, the DOM text a no-op could not produce, or the
   composer's own class/attribute state. Run standalone against an isolated
   instance:

     OMP_PORT_CONFIG_DIR=/tmp/deep-cfg-composer \
       "release/OMP Desktop.app/Contents/MacOS/OMP Desktop" \
       --remote-debugging-port=9342 &
     node tools/deep/composer.mjs 9342

   The instance's open-tabs.json must seed the tab whose session file is
   SESSION_FILE below (same project the checks type @-mentions in). */

import { runStandalone } from "./ctx.mjs";

const SESSION_FILE =
  "/Users/jackey/.omp/agent/sessions/-GitHub-chuti/2026-10-26T12-31-15-604Z_01a17831-8c94-7647-88ec-dec231e169a5.jsonl";
const PROJECT = "/Users/jackey/GitHub/chuti";

/** Poll `fn` until it returns something truthy (or the deadline passes). */
const poll = async (ctx, fn, ms, step = 400) => {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await ctx.sleep(step);
  }
};

/** Drive the composer's controlled textarea the way a keystroke would:
 *  native value setter + an input event, caret at the end so the composer's
 *  @-mention / slash derivation sees the whole text. */
const setDraft = async (ctx, value) =>
  ctx.ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    if (!ta) return null;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.focus();
    set.call(ta, ${JSON.stringify(value)});
    ta.selectionStart = ta.selectionEnd = ${value.length};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);

const draftValue = (ctx) => ctx.ev(`document.querySelector('.composer textarea')?.value ?? null`);

const composerPill = (ctx) => ctx.ev(`document.querySelector('.composer-foot .composer-pill')?.textContent ?? null`);

/** Click the session-scope bash approval if omp is asking for one. */
const approveBashForSession = (ctx) =>
  ctx.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x =>
      (x.textContent || '').trim() === 'Approve bash for this session' && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);

const enabledApproval = (ctx) =>
  ctx.ev(`[...document.querySelectorAll('button')].some(b => !b.disabled && /^Approve|^Deny/.test((b.textContent || '').trim()))`);

const thinkingPill = (ctx) =>
  ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.textContent ?? ''`);

/** Open the thinking pill and apply `level` through the popover. */
const pickThinkingLevel = async (ctx, level) => {
  await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.click()`);
  const clicked = await poll(ctx, async () => {
    const present = await ctx.ev(`[...document.querySelectorAll('.thinking-pop .thinking-item')].some(x =>
      x.querySelector('.thinking-item-name')?.textContent === ${JSON.stringify(level)})`);
    if (!present) return false;
    return ctx.ev(`(() => {
      const r = [...document.querySelectorAll('.thinking-pop .thinking-item')].find(x =>
        x.querySelector('.thinking-item-name')?.textContent === ${JSON.stringify(level)});
      if (!r) return false;
      r.click();
      return true;
    })()`);
  }, 12000, 300);
  if (!clicked) return false;
  return Boolean(await poll(ctx, async () => String(await thinkingPill(ctx)).includes(`thinking · ${level}`), 20000));
};

export async function run(ctx) {
  try {
    // ── 1. A prompt round-trips through omp and onto disk ────────────────
    await ctx.check("send-roundtrip", async () => {
      await ctx.clearPoison();
      const marker = `deep-composer-send-${Date.now()}`;
      const sent = await ctx.sendPrompt(marker);
      ctx.assert(sent === 1, "OMP_BRIDGE.send was not callable");
      const inDom = await poll(ctx, () =>
        ctx.ev(`[...document.querySelectorAll('.user-text')].some(e => e.textContent.includes(${JSON.stringify(marker)}))`), 20000);
      ctx.assert(inDom, "marker never appeared as a .user-text row in the DOM");
      const onDisk = await poll(ctx, () => ctx.readDisk(SESSION_FILE).includes(marker), 40000, 1000);
      ctx.assert(onDisk, "marker not found in the seed session .jsonl on disk");
      // The agent often answers with its own `echo` bash call, and the
      // default `write` approval mode asks before running it. Grant bash
      // for this session (the same grant the later streaming checks need),
      // then let the turn finish instead of stalling on the card.
      const granted = await poll(ctx, () => approveBashForSession(ctx), 6000, 400);
      const idle = await ctx.waitIdle(90000);
      ctx.assert(idle, "the turn did not finish (an unresolved prompt?)");
      return `${marker} in .user-text and in ${SESSION_FILE.split("/").pop()} (bash approval granted: ${granted})`;
    });

    // ── 2. A message sent mid-stream is queued and later delivered ──────
    await ctx.check("queue-while-streaming", async () => {
      await ctx.clearPoison();
      const marker = `deep-composer-queue-${Date.now()}`;
      // Anchor the long turn on MODEL streaming: omp auto-backgrounds long
      // bash, which ends the turn before a queue row can exist. Counting
      // output streams for tens of seconds with no tool call.
      ctx.assert(await ctx.sendPrompt("write the integers from 1 to 400, one per line, with no commentary") === 1, "sendPrompt failed");
      const streaming = await poll(ctx, () => ctx.streamingNow(), 30000, 150);
      ctx.assert(streaming, "the long turn never started streaming");
      ctx.assert(await ctx.streamingNow(), "the long turn ended before the second message was sent");
      // send() mid-stream is a STEER, which omp may deliver at its next
      // step without ever queueing it; the queue strip is the follow-up
      // path (held until turn end), so that is what this check exercises.
      const queued = await ctx.ev(`(() => {
        try { window.OMP_BRIDGE.followUp(${JSON.stringify(marker)}); return 1; } catch { return 0; }
      })()`);
      ctx.assert(queued === 1, "followUp failed");
      const row = await poll(ctx, () =>
        ctx.ev(`(() => {
          const r = [...document.querySelectorAll('.queue-strip .queue-row')].find(x =>
            (x.querySelector('.queue-text')?.textContent || '').includes(${JSON.stringify(marker)}));
          if (!r) return null;
          return { kind: r.querySelector('.queue-kind')?.textContent ?? '', text: r.querySelector('.queue-text')?.textContent ?? '' };
        })()`), 15000, 400);
      ctx.assert(row, "no .queue-strip row carrying the second message appeared");
      const idle = await ctx.waitIdle(240000);
      ctx.assert(idle, "the turn never came back to idle");
      const deliveredDom = await poll(ctx, () =>
        ctx.ev(`[...document.querySelectorAll('.user-text')].some(e => e.textContent.includes(${JSON.stringify(marker)}))`), 30000);
      ctx.assert(deliveredDom, "the queued message was never delivered as a user row");
      const deliveredDisk = await poll(ctx, () => ctx.readDisk(SESSION_FILE).includes(marker), 20000, 1000);
      ctx.assert(deliveredDisk, "the queued message was never persisted to the session .jsonl");
      return `.queue-row kind=${row.kind} text=${marker}; delivered after idle (DOM + jsonl)`;
    });

    // ── 3. Abort ends a running turn and leaves the tab usable ───────────
    await ctx.check("abort", async () => {
      await ctx.clearPoison();
      ctx.assert(await ctx.sendPrompt("write the integers from 1 to 400, one per line, with no commentary") === 1, "sendPrompt failed");
      const streaming = await poll(ctx, () => ctx.streamingNow(), 30000, 150);
      ctx.assert(streaming, "the counting turn never started streaming");
      const t0 = Date.now();
      const clicked = await ctx.ev(`(() => {
        const b = [...document.querySelectorAll('button')].find(x =>
          (x.textContent || '').includes('abort') && x.classList.contains('danger'));
        if (!b) return 'no abort button';
        b.click();
        return 'clicked';
      })()`);
      ctx.assert(clicked === "clicked", `abort button not found (${clicked})`);
      const stopped = await poll(ctx, async () => !(await ctx.streamingNow()), 8000, 250);
      const elapsed = Date.now() - t0;
      ctx.assert(stopped, "streaming did not stop after abort");
      ctx.assert(elapsed <= 5000, `abort took ${elapsed}ms (expected within ~5s)`);
      // omp can finish the in-flight step it had already started; clear the
      // leftovers (a late approval card, a queued steer) before the probe.
      await ctx.clearPoison();
      // The tab must not be wedged: a fresh prompt has to run through.
      const after = `deep-composer-afterabort-${Date.now()}`;
      ctx.assert(await ctx.sendPrompt(after) === 1, "follow-up sendPrompt failed");
      const ran = await poll(ctx, () =>
        ctx.ev(`[...document.querySelectorAll('.user-text')].some(e => e.textContent.includes(${JSON.stringify(after)}))`), 30000);
      ctx.assert(ran, "the follow-up prompt never appeared after the abort");
      const idle = await ctx.waitIdle(150000);
      ctx.assert(idle, "the follow-up turn did not finish");
      return `streaming stopped ${elapsed}ms after abort; follow-up ${after} ran to idle`;
    });

    // ── 4. Plan mode pill flips the composer state ───────────────────────
    await ctx.check("plan-mode", async () => {
      await ctx.clearPoison();
      const hasPlan = () => ctx.ev(`document.querySelector('.composer')?.classList.contains('plan-on') ?? null`);
      if (await hasPlan()) {
        await ctx.ev(`document.querySelector('.plan-pill')?.click()`);
        await poll(ctx, async () => !(await hasPlan()), 4000, 200);
      }
      ctx.assert((await hasPlan()) === false, "composer started in plan mode");
      ctx.assert((await ctx.ev(`document.querySelector('.plan-pill')?.disabled`)) === false, "plan pill is disabled (goal active?)");
      await ctx.ev(`document.querySelector('.plan-pill')?.click()`);
      const on = await poll(ctx, async () => (await hasPlan()) &&
        (await ctx.ev(`!!document.querySelector('.composer .plan-strip')`)), 5000, 200);
      ctx.assert(on, "composer never gained plan-on / the plan strip");
      ctx.assert((await ctx.ev(`document.querySelector('.plan-pill')?.classList.contains('on')`)) === true, "plan pill did not show its on state");
      await ctx.ev(`document.querySelector('.plan-pill')?.click()`);
      const off = await poll(ctx, async () => (await hasPlan()) === false &&
        (await ctx.ev(`!document.querySelector('.composer .plan-strip')`)), 5000, 200);
      ctx.assert(off, "composer did not leave plan mode when the pill was clicked again");
      return "plan-on + .plan-strip appeared, then both cleared on the second click";
    });

    // ── 5. Thinking menu lists omp's levels and applies a pick ───────────
    await ctx.check("thinking-menu", async () => {
      await ctx.clearPoison();
      // The levels come from omp's RPC `get_available_thinking_levels`.
      // There is no Tauri command for it (ctx.invoke cannot reach an omp
      // RPC), so parity is read through the same bridge method the menu
      // calls; the menu's DOM rows are then compared against it.
      const levels = await ctx.ev(`window.OMP_BRIDGE.thinkingLevels()`);
      ctx.assert(Array.isArray(levels) && levels.length > 1, `unusable level list: ${JSON.stringify(levels)}`);
      const before = await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.textContent ?? ''`);
      const current = String(before).replace(/^thinking\s*·\s*/, "").trim();
      ctx.assert(levels.includes(current), `pill level '${current}' is not in ${JSON.stringify(levels)}`);
      await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.click()`);
      const rows = await poll(ctx, async () => {
        const r = await ctx.ev(`[...document.querySelectorAll('.thinking-pop .thinking-item-name')].map(e => e.textContent)`);
        return Array.isArray(r) && r.length > 0 ? r : null;
      }, 10000, 300);
      ctx.assert(rows, "the thinking popover never rendered");
      ctx.assert(JSON.stringify(rows) === JSON.stringify(levels),
        `menu rows ${JSON.stringify(rows)} differ from get_available_thinking_levels ${JSON.stringify(levels)}`);
      const pick = levels.find((l) => l !== current && l !== "off");
      ctx.assert(pick, "no other level to pick");
      const clicked = await ctx.ev(`(() => {
        const r = [...document.querySelectorAll('.thinking-pop .thinking-item')].find(x =>
          x.querySelector('.thinking-item-name')?.textContent === ${JSON.stringify(pick)});
        if (!r) return false;
        r.click();
        return true;
      })()`);
      ctx.assert(clicked, `no row for level '${pick}'`);
      const changed = await poll(ctx, async () =>
        String(await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.textContent ?? ''`)).includes(`thinking · ${pick}`), 20000);
      ctx.assert(changed, `pill never showed the picked level '${pick}'`);
      // Put the original level back.
      await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.click()`);
      await poll(ctx, () => ctx.ev(`document.querySelectorAll('.thinking-pop .thinking-item').length`), 8000, 300);
      const back = await ctx.ev(`(() => {
        const r = [...document.querySelectorAll('.thinking-pop .thinking-item')].find(x =>
          x.querySelector('.thinking-item-name')?.textContent === ${JSON.stringify(current)});
        if (!r) return false;
        r.click();
        return true;
      })()`);
      ctx.assert(back, `no row to restore level '${current}'`);
      const restored = await poll(ctx, async () =>
        String(await ctx.ev(`document.querySelector('.thinking-menu button.composer-pill')?.textContent ?? ''`)).includes(`thinking · ${current}`), 20000);
      ctx.assert(restored, `pill never returned to '${current}'`);
      return `menu showed ${JSON.stringify(rows)} (parity with get_available_thinking_levels); ${current} → ${pick} → ${current}`;
    });

    // ── 6. Model picker switches the session's model and back ────────────
    await ctx.check("model-picker", async () => {
      await ctx.clearPoison();
      await ctx.ev(`window.OMP_BRIDGE.ensureModels()`);
      const loaded = await poll(ctx, async () => (await ctx.ev(`window.OMP_DATA.models.length`)) > 1, 15000, 500);
      ctx.assert(loaded, "the model catalog never loaded");
      const cur = await ctx.ev(`window.OMP_DATA.model`);
      ctx.assert(cur?.id, "no current model");
      const levelBefore = String(await thinkingPill(ctx)).replace(/^thinking\s*·\s*/, "").trim();
      const before = await composerPill(ctx);
      ctx.assert(String(before).includes(cur.name), `model pill '${before}' does not name the current model '${cur.name}'`);
      await ctx.ev(`document.querySelector('.composer-foot .composer-pill')?.click()`);
      const opened = await poll(ctx, () =>
        ctx.ev(`document.querySelector('.bridge-input')?.getAttribute('placeholder') === 'filter models…'`), 8000, 300);
      ctx.assert(opened, "the model picker did not open");
      const rows = await ctx.ev(`[...document.querySelectorAll('#bridge-model-rows .bridge-row')].map(r => ({
        id: r.querySelector('.mono')?.textContent ?? '',
        name: r.querySelector('span:nth-child(2)')?.textContent ?? '',
        active: r.classList.contains('active'),
      }))`);
      const currentRow = rows.find((r) => r.id === cur.id);
      ctx.assert(currentRow, `menu has no row for the current model ${cur.id}`);
      ctx.assert(currentRow.active, "the current model's row is not marked active");
      const target = (await ctx.ev(`window.OMP_DATA.models.map(m => ({ id: m.id, name: m.name, provider: m.provider }))`))
        .find((m) => m.provider === cur.provider && m.id !== cur.id);
      ctx.assert(target, "no other model from the same provider to switch to");
      const picked = await ctx.ev(`(() => {
        const r = [...document.querySelectorAll('#bridge-model-rows .bridge-row')].find(x =>
          x.querySelector('.mono')?.textContent === ${JSON.stringify(target.id)});
        if (!r) return false;
        r.click();
        return true;
      })()`);
      ctx.assert(picked, `no row for ${target.id}`);
      const switched = await poll(ctx, async () =>
        String(await composerPill(ctx)).includes(target.name), 30000, 500);
      ctx.assert(switched, `model pill never changed to '${target.name}'`);
      // Back to the original model.
      await ctx.ev(`document.querySelector('.composer-foot .composer-pill')?.click()`);
      const reopened = await poll(ctx, () =>
        ctx.ev(`document.querySelectorAll('#bridge-model-rows .bridge-row').length > 0`), 12000, 300);
      ctx.assert(reopened, "the model picker did not reopen");
      const back = await ctx.ev(`(() => {
        const r = [...document.querySelectorAll('#bridge-model-rows .bridge-row')].find(x =>
          x.querySelector('.mono')?.textContent === ${JSON.stringify(cur.id)});
        if (!r) return false;
        r.click();
        return true;
      })()`);
      ctx.assert(back, `no row to restore ${cur.id}`);
      const restored = await poll(ctx, async () =>
        String(await composerPill(ctx)).includes(cur.name), 30000, 500);
      ctx.assert(restored, `model pill never returned to '${cur.name}'`);
      // omp drops the thinking level to `off` when a model switch lands on
      // a model without levels, and switching back does not restore it —
      // which leaves this provider refusing turns (`enable_thinking` must
      // be true). Put the level the tab had back, so the session is left
      // healthy for the rest of the matrix.
      let thinkingNote = "";
      if (levelBefore && levelBefore !== "off") {
        const now = String(await thinkingPill(ctx)).replace(/^thinking\s*·\s*/, "").trim();
        if (now !== levelBefore) {
          ctx.assert(await pickThinkingLevel(ctx, levelBefore),
            `thinking level '${levelBefore}' was not restored after the model round-trip (now '${now}')`);
          thinkingNote = `; thinking re-applied ${now} → ${levelBefore}`;
        }
      }
      return `${rows.length} rows incl. current ${cur.id}; switched to ${target.id} and back${thinkingNote}`;
    });

    // ── 7. @-mention popup lists project files and inserts the path ──────
    await ctx.check("at-mention", async () => {
      await ctx.clearPoison();
      const files = await ctx.invoke("list_project_files", { cwd: PROJECT, query: "", limit: 30 });
      ctx.assert(files.ok && Array.isArray(files.v) && files.v.length > 0, `list_project_files failed: ${JSON.stringify(files).slice(0, 160)}`);
      const paths = files.v.map((f) => f.path);
      await setDraft(ctx, "@");
      const shown = await poll(ctx, () =>
        ctx.ev(`document.querySelectorAll('.mention-pop .mention-row').length`), 12000, 300);
      ctx.assert(shown > 0, "the @-mention popup never appeared");
      const rows = await ctx.ev(`[...document.querySelectorAll('.mention-pop .mention-row')].map(r => r.textContent)`);
      for (const text of rows) {
        const p = text.replace(/\/$/, "");
        ctx.assert(paths.includes(p), `popup row '${text}' is not in list_project_files' output`);
      }
      const picked = await ctx.ev(`(() => {
        const r = [...document.querySelectorAll('.mention-pop .mention-row')].find(x => !x.textContent.endsWith('/'));
        if (!r) return null;
        const text = r.textContent;
        r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return text;
      })()`);
      ctx.assert(picked, "no file (non-directory) row to pick");
      await ctx.sleep(500);
      const value = await draftValue(ctx);
      const expected = `@${picked} `;
      ctx.assert(value === expected, `draft is ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
      await setDraft(ctx, "");
      return `${shown} rows ⊂ list_project_files(${paths.length}); picked ${picked} → draft ${JSON.stringify(value)}`;
    });

    // ── 8. Slash popup renders omp's command registry ────────────────────
    await ctx.check("slash-command-popup", async () => {
      await ctx.clearPoison();
      const cmds = await ctx.ev(`window.OMP_DATA.commands.map(c => ({ name: c.name, source: c.source }))`);
      ctx.assert(Array.isArray(cmds) && cmds.length > 0, "no commands registered");
      await setDraft(ctx, "/");
      const count = await poll(ctx, () =>
        ctx.ev(`document.querySelectorAll('.slash-pop .slash-row').length`), 12000, 300);
      ctx.assert(count > 0, "the slash popup never appeared");
      const rows = await ctx.ev(`[...document.querySelectorAll('.slash-pop .slash-row')].map(r => ({
        name: (r.querySelector('.slash-name')?.textContent || '').slice(1),
        group: r.querySelector('.chip')?.textContent ?? '',
      }))`);
      for (const r of rows) {
        ctx.assert(cmds.some((c) => c.name === r.name), `popup row /${r.name} is not a registered command`);
      }
      const security = rows.find((r) => r.name === "security");
      ctx.assert(security, "the builtin /security command is missing from the popup");
      ctx.assert(security.group === "Commands", `/security rendered as '${security.group}', not Commands`);
      ctx.assert(cmds.find((c) => c.name === "security")?.source === "builtin", "security is not a builtin RPC command");
      const plan = rows.find((r) => r.name === "plan");
      ctx.assert(plan && plan.group === "Mode", "the desktop-local /plan entry is missing");
      await setDraft(ctx, "");
      return `${count} rows, all registered; /security (builtin from get_available_commands) + /plan (desktop) present`;
    });
  } finally {
    // Leave the harness clean: no queued steers, no open approval, no draft,
    // plan mode off, nothing streaming.
    try { await setDraft(ctx, ""); } catch { /* window may be gone */ }
    try { await ctx.ev(`document.querySelector('.plan-pill.on')?.click()`); } catch { /* noop */ }
    await ctx.clearPoison();
    try {
      if (await ctx.streamingNow()) {
        await ctx.ev(`window.OMP_BRIDGE?.abort?.()`);
        await ctx.waitIdle(15000);
      }
    } catch { /* teardown is best effort */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runStandalone(run);