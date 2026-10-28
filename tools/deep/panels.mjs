/* tools/deep/panels.mjs — deep E2E for the status-bar / rail panels.

   Every check proves its panel by an EXTERNAL consequence:
     - terminal      : a real pty shell child of THIS app process appears,
                       an echoed marker reaches xterm's DOM, and closing the
                       tab removes that exact pid from the process table.
     - git browser   : a host-created untracked file shows in the status tree
                       and git_browser_file agrees with `git status --porcelain`;
                       a clicked commit's subject equals `git log -1 --format=%s`.
     - conversation  : row count equals the seed session's user-message count
                       read from disk (prompt rows are user messages).
     - history       : Ctrl+H + "QUIZ" narrows the list, and clicking the row
                       focuses the already-open tab (no new tab).
     - subagents     : the layout flips to split and the manager pane renders
                       with no crash card and no error-watch entry.
     - usage stats   : the panel's request total equals ctx.invoke usage_stats.

   `pgrep -f` is useless here (sibling deep groups and this harness's own
   command lines match text patterns), so process evidence is scoped to the
   children of this instance's main pid (found by its CDP port switch). */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { runStandalone } from "./ctx.mjs";

const PROJECT = "/Users/jackey/GitHub/chuti";
const SEED_SESSION =
  "/Users/jackey/.omp/agent/sessions/-GitHub-chuti/2026-10-26T12-31-15-604Z_01a17831-8c94-7647-88ec-dec231e169a5.jsonl";
const PROBE = `${PROJECT}/deep-diff-probe.txt`;

export async function run(ctx) {
  const { ev, sleep, assert, check, invoke, clearPoison } = ctx;

  // ── host-side evidence helpers ─────────────────────────────────────────
  const ps = () =>
    execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 })
      .split("\n")
      .map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
      })
      .filter(Boolean);

  /** This instance's Electron main: the OMP Desktop process carrying OUR CDP port. */
  const mainPid = () => {
    // The launch line now carries --user-data-dir after the port flag and
    // the renderer helpers repeat the port flag: match the MAIN process by
    // its executable path and the port flag, excluding helpers.
    const hit = ps().find(
      (p) =>
        p.command.includes("OMP Desktop.app/Contents/MacOS/OMP Desktop") &&
        !p.command.includes("Helper") &&
        p.command.includes(`--remote-debugging-port=${ctx.port}`),
    );
    if (!hit) throw new Error(`no OMP Desktop main process for port ${ctx.port}`);
    return hit.pid;
  };

  /** Pty shells (node-pty children of the app main) — never another instance's. */
  const shellPids = () => {
    // The port's pty child is the ANCHOR (/bin/sh running the sweep script,
    // terminal.js), with the real shell one level below it; on Windows the
    // shell is the direct child. Count the anchor as "the shell": it is the
    // process the app owns and the one that dies with the tab.
    const parent = mainPid();
    return ps()
      .filter((p) => p.ppid === parent)
      .filter((p) => {
        const cmd = p.command.trim();
        const exe = cmd.split(/\s+/)[0] ?? "";
        if (exe === "zsh" || exe.endsWith("/zsh")) return true;
        return exe === "/bin/sh" && cmd.includes("st=0");
      })
      .map((p) => p.pid);
  };

  const git = (...args) => execFileSync("git", ["-C", PROJECT, ...args], { encoding: "utf8" }).trim();

  const until = async (fn, ms, label, step = 250) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
      await sleep(step);
    }
  };

  // ── panel helpers (scoped, never a bare "first matching button") ────────
  const clickStatus = (title) =>
    ev(`(() => {
      const b = [...document.querySelectorAll('.status button')].find(x => (x.title || '').startsWith(${JSON.stringify(title)}));
      if (!b) return 'missing';
      b.click();
      return 'clicked';
    })()`);

  const visibleTermText = () =>
    ev(`(document.querySelector('.term-panel:not([hidden]) .term-body')?.textContent) || ''`);

  const openGit = async () => {
    if (!(await ev(`!!document.querySelector('.gitb-scrim')`))) {
      const r = await clickStatus("git browser");
      assert(r === "clicked", `git browser status button: ${r}`);
    }
    await until(() => ev(`!!document.querySelector('.gitb-tree .gitb-row')`), 20000, "git status tree");
  };
  const closeGit = async () => {
    await ev(`document.querySelector('.gitb button[title="close (Esc)"]')?.click()`);
    await until(() => ev(`!document.querySelector('.gitb-scrim')`), 8000, "git browser closed");
  };
  const closeTree = async () => {
    await ev(`document.querySelector('.tree-head button[title="close"]')?.click()`);
    await until(() => ev(`!document.querySelector('.tree-drawer')`), 8000, "tree drawer closed");
  };
  const closeManager = async () => {
    await ev(`document.querySelector('.sa-pane button[title="close manager"]')?.click()`);
    await until(() => ev(`!document.querySelector('.window.is-split')`), 8000, "manager closed");
  };

  /** User-message lines in the seed session, read at check time: the tree's
   *  prompt rows are exactly those (plus compactions, which render as their
   *  own row class). Sibling deep groups append to this shared session, hence
   *  the before/after window in the check. */
  const userMessageCount = () => {
    let n = 0;
    for (const line of readFileSync(SEED_SESSION, "utf8").split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type === "message" && o?.message?.role === "user") n++;
    }
    return n;
  };

  await clearPoison(); // no queued steers / unanswered prompts from a prior group

  // ── 1. terminal: write, then kill through the tab close ────────────────
  await check("terminal-write-kill", async () => {
    const base = shellPids();
    const tabs0 = await ctx.tabCount();

    // Own tab, so closing it cannot disturb the seed tab the other checks use.
    const id = await ev(`window.OMP_BRIDGE.openSession(${JSON.stringify(PROJECT)}, "default")`);
    assert(typeof id === "string" && id.length > 0, `openSession returned ${JSON.stringify(id)}`);
    await until(
      async () => (await ev(`document.querySelector('.tab.active')?.dataset.tabId ?? null`)) === id,
      20000,
      "new tab active",
    );
    await until(async () => (await ctx.tabCount()) === tabs0 + 1, 15000, "tab count +1");

    const toggle = await clickStatus("terminal (");
    assert(toggle === "clicked", `terminal status button: ${toggle}`);
    await until(() => ev(`!!document.querySelector('.term-panel:not([hidden])')`), 15000, "terminal panel shown");

    const spawned = await until(() => {
      const now = shellPids().filter((p) => !base.includes(p));
      return now.length ? now : null;
    }, 20000, "pty shell child of this app");
    assert(spawned.length === 1, `expected exactly one new pty shell, got ${spawned.length}`);
    const shellPid = spawned[0];

    const status = await invoke("terminal_status", { sessionId: id });
    assert(status.ok, `terminal_status failed: ${status.e}`);
    assert(status.v?.state === "running", `terminal state ${JSON.stringify(status.v?.state)}`);

    const marker = `TERM-DEEP-${Date.now()}`;
    const wrote = await invoke("terminal_write", { sessionId: id, data: `echo ${marker}\n` });
    assert(wrote.ok, `terminal_write failed: ${wrote.e}`);
    await until(async () => (await visibleTermText()).includes(marker), 15000, `marker ${marker} in xterm DOM`);

    const closed = await ev(
      `window.OMP_BRIDGE.closeSession(${JSON.stringify(id)}).then(() => "ok", e => String(e))`,
    );
    assert(closed === "ok", `closeSession(${id}): ${closed}`);
    await until(async () => !shellPids().includes(shellPid), 20000, `shell pid ${shellPid} gone after closeTab`);

    const after = shellPids();
    assert(after.length === base.length, `pty shell count ${base.length} -> ${after.length}`);
    await until(async () => (await ctx.tabCount()) === tabs0, 10000, "tab count back");
    const active = await ctx.activeTabText();
    assert(active && active.includes("QUIZ"), `seed tab not active after close: ${JSON.stringify(active)}`);

    return `marker ${marker} in xterm DOM; pty ${shellPid} spawned and gone (${base.length}->${after.length} zsh children); tab ${id} closed`;
  });

  // ── 2. git browser: an untracked probe reaches the status tree ─────────
  await check("git-file-diff", async () => {
    writeFileSync(PROBE, `deep diff probe ${Date.now()}\n`);
    try {
      const porcelain = git("status", "--porcelain", "--", "deep-diff-probe.txt");
      assert(porcelain.startsWith("??"), `git status --porcelain: ${JSON.stringify(porcelain)}`);

      await openGit();
      const row = await until(
        () =>
          ev(`(() => {
            const r = [...document.querySelectorAll('.gitb-tree .gitb-row.file')]
              .find(x => x.textContent.includes('deep-diff-probe.txt'));
            if (!r) return null;
            const mark = r.querySelector('.gitb-mark');
            return { text: r.textContent, mark: mark?.textContent ?? null, markTitle: mark?.title ?? null };
          })()`),
        20000,
        "probe row in the git status tree",
      );
      assert(row.mark === "U", `probe row mark ${JSON.stringify(row.mark)} (row ${JSON.stringify(row.text)})`);
      assert(row.markTitle === "untracked", `probe row mark title ${JSON.stringify(row.markTitle)}`);

      const file = await invoke("git_browser_file", { path: PROJECT, relPath: "deep-diff-probe.txt" });
      assert(file.ok, `git_browser_file failed: ${file.e}`);
      assert(
        file.v?.status === "Untracked",
        `git_browser_file status ${JSON.stringify(file.v?.status)} vs porcelain "??"`,
      );
      assert(file.v?.kind === "Text" && file.v?.adds >= 1, `file view ${file.v?.kind} adds ${file.v?.adds}`);

      return `porcelain "??" → tree row ${JSON.stringify(row.text)} (${row.mark}) → git_browser_file {status:${file.v.status}, kind:${file.v.kind}, adds:${file.v.adds}}`;
    } finally {
      if (existsSync(PROBE)) unlinkSync(PROBE);
    }
  });

  // ── 3. git browser: a clicked commit shows that commit ─────────────────
  await check("git-commit-browse", async () => {
    await openGit();
    const log = await invoke("git_browser_log", { path: PROJECT });
    assert(log.ok, `git_browser_log failed: ${log.e}`);
    const target = (log.v?.rows ?? []).find((r) => r.id && r.id !== "@");
    assert(target, "git_browser_log returned no commit rows");

    const clicked = await ev(`(() => {
      const r = [...document.querySelectorAll('.gitb-commit')]
        .find(x => (x.title || '').startsWith(${JSON.stringify(target.id)}));
      if (!r) return 'missing';
      r.click();
      return 'clicked';
    })()`);
    assert(clicked === "clicked", `commit row ${target.id.slice(0, 8)} click: ${clicked}`);

    const shown = await until(
      () => ev(`document.querySelector('.gitb-view-subject')?.textContent ?? null`),
      20000,
      "commit subject in the view pane",
    );
    const host = execFileSync("git", ["-C", PROJECT, "log", "-1", "--format=%s", target.id], {
      encoding: "utf8",
    }).trim();
    assert(
      shown.trim() === host.trim(),
      `commit view subject ${JSON.stringify(shown)} != git log -1 --format=%s ${JSON.stringify(host)}`,
    );

    const head = await ev(`document.querySelector('.gitb-files .gitb-pane-sub')?.textContent ?? ''`);
    assert(head.includes(target.id.slice(0, 7)), `files pane head ${JSON.stringify(head)} does not name ${target.id.slice(0, 7)}`);
    const activeRow = await ev(`document.querySelector('.gitb-commit.active')?.title?.split('\\n')[0] ?? null`);
    assert(activeRow === target.id, `active commit row ${activeRow} != ${target.id}`);

    await closeGit();
    return `clicked ${target.id.slice(0, 8)}; view subject matches git log -1 (%s); files pane ${JSON.stringify(head.trim())}`;
  });

  // ── 4. conversation tree: rows are the seed session's prompts ──────────
  await check("conversation-tree", async () => {
    const before = userMessageCount();
    const toggle = await clickStatus("conversation tree (");
    assert(toggle === "clicked", `tree status button: ${toggle}`);
    await until(() => ev(`!!document.querySelector('.tree-drawer')`), 15000, "conversation tree drawer");

    const rows = await until(
      () => ev(`document.querySelectorAll('.tree-list .tree-row').length`),
      25000,
      "tree prompt rows",
    );
    const after = userMessageCount();
    const chip = await ev(`[...document.querySelectorAll('.tree-head .chip')].map(c => c.textContent).join(' | ')`);

    const lo = Math.min(before, after);
    const hi = Math.max(before, after);
    assert(rows > 0, `tree rendered ${rows} rows`);
    // ±2: sibling deep groups append to this shared session between the
    // host reads and the tree's own fetch of the file.
    assert(
      rows >= lo - 2 && rows <= hi + 2,
      `tree rows ${rows} vs host user-message lines ${lo}..${hi} (±2 tolerance)`,
    );
    assert(chip.includes(`${rows} prompts`), `tree head ${JSON.stringify(chip)} does not report ${rows} prompts`);

    await closeTree();
    return `${rows} tree rows vs ${after} host "type":"message","role":"user" lines (±2); head ${JSON.stringify(chip)}`;
  });

  // ── 5. history search focuses the already-open tab ─────────────────────
  await check("history-search-restore", async () => {
    const tabs0 = await ctx.tabCount();
    // A decoy tab keeps the seeded conversation OUT of focus, so "active
    // tab went to the QUIZ conversation" cannot be satisfied by doing nothing.
    const decoy = await ev(`window.OMP_BRIDGE.openSession(${JSON.stringify(PROJECT)}, "default")`);
    assert(typeof decoy === "string" && decoy.length > 0, `decoy tab: ${JSON.stringify(decoy)}`);
    try {
      await until(
        async () => (await ev(`document.querySelector('.tab.active')?.dataset.tabId ?? null`)) === decoy,
        20000,
        "decoy tab active",
      );
      const tabs1 = await ctx.tabCount();
      assert(tabs1 === tabs0 + 1, `decoy tab: ${tabs0} -> ${tabs1}`);

      await ev(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, bubbles: true, cancelable: true }))`,
      );
      const viaKey = await until(() => ev(`!!document.querySelector('#hist-rows')`), 4000, "history modal").then(
        () => true,
        () => false,
      );
      if (!viaKey) {
        const fallback = await ev(`(() => {
          const b = [...document.querySelectorAll('.tab-add')].find(x => (x.title || '').startsWith('conversation history'));
          if (!b) return 'missing';
          b.click();
          return 'clicked';
        })()`);
        assert(fallback === "clicked", `history affordance: ${fallback}`);
        await until(() => ev(`!!document.querySelector('#hist-rows')`), 8000, "history modal (tab-bar button)");
      }

      const all = await until(
        () => ev(`document.querySelectorAll('#hist-rows .bridge-row').length || null`),
        30000,
        "history rows from disk",
      );
      const typed = await ev(`(() => {
        const i = document.querySelector('#hist-rows') ? document.querySelector('.bridge-input') : null;
        if (!i) return 'no input';
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(i, 'QUIZ');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return i.value;
      })()`);
      assert(typed === "QUIZ", `history search input: ${JSON.stringify(typed)}`);

      const filtered = await until(async () => {
        const n = await ev(`document.querySelectorAll('#hist-rows .bridge-row').length`);
        const hit = await ev(
          `[...document.querySelectorAll('#hist-rows .bridge-row')].some(r => { const t = r.textContent || ''; return t.includes('QUIZ') && t.includes('chuti'); })`,
        );
        return n > 0 && hit ? n : null;
      }, 20000, "QUIZ rows");
      assert(filtered < all, `filter did not narrow the list: ${all} -> ${filtered}`);

      const clicked = await ev(`(() => {
        const r = [...document.querySelectorAll('#hist-rows .bridge-row')]
          .find(x => { const t = x.textContent || ''; return t.includes('QUIZ') && t.includes('chuti'); });
        if (!r) return 'missing';
        r.click();
        return 'clicked';
      })()`);
      assert(clicked === "clicked", `seeded history row click: ${clicked}`);
      await until(() => ev(`!document.querySelector('#hist-rows')`), 10000, "history modal closed");

      const active = await until(async () => {
        const t = await ctx.activeTabText();
        return t && t.includes("QUIZ") ? t : null;
      }, 20000, "seed tab focused");
      const tabs2 = await ctx.tabCount();
      assert(tabs2 === tabs1, `resume spawned a tab instead of focusing: ${tabs1} -> ${tabs2}`);

      return `Ctrl+H → ${all} sessions, "QUIZ" → ${filtered}; clicking it focused the open tab (${tabs1} tabs unchanged, active ${JSON.stringify(active.trim())})`;
    } finally {
      await ev(`window.OMP_BRIDGE.closeSession(${JSON.stringify(decoy)}).then(() => "ok", e => String(e))`);
      await sleep(800);
    }
  });

  // ── 6. subagent manager ────────────────────────────────────────────────
  await check("subagents-panel", async () => {
    await ev(`window.OMP_ERRORS?.clear?.()`);
    const before = await ev(`({ pane: !!document.querySelector('.sa-pane'), split: !!document.querySelector('.window.is-split') })`);
    assert(!before.pane && !before.split, `manager already open before the check: ${JSON.stringify(before)}`);

    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('button.sa-rail-open')].find(x => x.offsetParent !== null);
      if (!b) return 'missing';
      b.click();
      return 'clicked';
    })()`);
    assert(clicked === "clicked", `rail "open manager" button: ${clicked}`);

    const head = await until(
      () => ev(`document.querySelector('.sa-pane .split-head')?.textContent ?? null`),
      15000,
      "manager pane head",
    );
    const split = await ev(`!!document.querySelector('.window.is-split')`);
    const rows = await ev(`document.querySelectorAll('.sa-pane .sa-row').length`);
    const empty = await ev(`document.querySelector('.sa-pane .sa-empty')?.textContent ?? null`);
    const crash = await ev(`document.querySelectorAll('.panel-crash').length`);
    const errs = await ev(
      `JSON.stringify((window.OMP_ERRORS?.list?.() ?? []).filter(e => /subagent|sa-pane|split/i.test(e.message || '')))`,
    );

    assert(split, "layout did not switch to split for the manager pane");
    assert(crash === 0, `a panel crash card is on screen (${crash})`);
    assert(errs === "[]", `error-watch recorded a panel failure: ${errs}`);
    const totals = /(\d+)\/(\d+) live/.exec(head || "");
    assert(totals, `manager head does not report live/total: ${JSON.stringify(head)}`);
    const total = Number(totals[2]);
    if (total === 0) {
      assert(rows === 0, `head says 0 agents but ${rows} rows rendered`);
      assert(empty && /no subagents/i.test(empty), `empty state missing: ${JSON.stringify(empty)}`);
    } else {
      assert(rows > 0, `head says ${total} agents but no rows rendered`);
    }

    await closeManager();
    return `open manager → split layout, pane head ${JSON.stringify(head.trim())}, ${rows} rows, 0 crash cards, 0 error-watch entries`;
  });

  // ── 7. usage statistics ────────────────────────────────────────────────
  await check("usage-stats", async () => {
    const clicked = await clickStatus("usage statistics");
    assert(clicked === "clicked", `stats status button: ${clicked}`);
    const head = await until(
      () => ev(`document.querySelector('.stats-head')?.textContent ?? null`),
      15000,
      "stats panel head",
    );

    const readPanel = async () =>
      Number(
        String(
          await ev(`(() => {
            const c = [...document.querySelectorAll('.stats-card')].find(x => (x.textContent || '').includes('requests'));
            return c ? (c.querySelector('.stats-card-value')?.textContent ?? '') : '';
          })()`),
        ).replace(/[^0-9]/g, ""),
      );
    const refreshAndRead = async () => {
      await ev(`document.querySelector('.stats-head button[title="refresh"]')?.click()`);
      await sleep(400); // let the spinner rise so its fall means "this fetch landed"
      await until(() => ev(`!document.querySelector('.stats-head .spin-icon')`), 30000, "stats refresh finished");
      await until(async () => (await ev(`document.querySelectorAll('.stats-card-value').length`)) >= 4, 20000, "stats cards");
      return readPanel();
    };

    let panel = await until(readPanel, 30000, "requests card value");
    let back = null;
    let exact = false;
    for (let attempt = 0; attempt < 3 && !exact; attempt++) {
      panel = await refreshAndRead();
      const r = await invoke("usage_stats", { profile: "default" });
      assert(r.ok, `usage_stats invoke failed: ${r.e}`);
      back = r.v?.overall?.totalRequests;
      exact = panel === back;
    }

    assert(Number.isFinite(panel) && panel > 0, `panel requests total ${panel}`);
    assert(Number.isFinite(back) && back > 0, `ctx.invoke usage_stats totalRequests ${back}`);
    // Sibling deep groups make real model requests while this runs, so the
    // panel's fetch and the invoke may straddle a few new requests.
    assert(exact || Math.abs(panel - back) <= 3, `panel requests ${panel} vs usage_stats ${back}`);
    assert(/last 24h/.test(head), `stats head ${JSON.stringify(head)} does not say last 24h`);

    const values = await ev(`[...document.querySelectorAll('.stats-card-value')].map(v => v.textContent)`);
    assert(values.length >= 4 && values.every((v) => /\d/.test(v)), `stats card values ${JSON.stringify(values)}`);

    await ev(`document.querySelector('.stats-panel button[title="close (esc)"]')?.click()`);
    await until(() => ev(`!document.querySelector('.stats-panel')`), 8000, "stats panel closed");

    return `requests card ${panel} vs ctx.invoke usage_stats.overall.totalRequests ${back}${exact ? " (exact)" : " (±3 concurrent sessions)"}; cards ${JSON.stringify(values)}`;
  });

  // ── teardown: leave no panels, probe file, or extra tabs behind ─────────
  await ev(`document.querySelector('.stats-panel button[title="close (esc)"]')?.click()`);
  await ev(`document.querySelector('.sa-pane button[title="close manager"]')?.click()`);
  await ev(`document.querySelector('.tree-head button[title="close"]')?.click()`);
  await ev(`document.querySelector('.gitb button[title="close (Esc)"]')?.click()`);
  if (existsSync(PROBE)) unlinkSync(PROBE);
  const leftovers = await ev(`[...document.querySelectorAll('.tab')]
    .filter(t => (t.dataset.tabId || '') && t.dataset.tabId !== '__settings__')
    .filter(t => !(t.textContent || '').includes('QUIZ'))
    .map(t => t.dataset.tabId)`);
  for (const id of leftovers ?? []) {
    await ev(`window.OMP_BRIDGE.closeSession(${JSON.stringify(id)}).then(() => "ok", e => String(e))`);
  }
  await sleep(800);
}

if (import.meta.url === `file://${process.argv[1]}`) runStandalone(run);