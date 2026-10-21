#!/usr/bin/env node
// Regression script for src/app/settings-schema.js — the Settings page's
// rows (#37): every tweak row names a real TWEAK_DEFAULTS key, bounds come
// from the owning modules, search over label/desc/keywords, the
// collapse-after row's visibility, theme-aware modified checks, badge
// counts and section resets. Also design/settings/controls.jsx's search
// mark: the highlighting follows the search's tokenised AND.
// Run: node tests/test-settings-schema.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
// The schema loads before the modules it reads bounds from: they are read late.
for (const f of ["constants.js", "settings-schema.js", "accent.js", "chat-collapse.js", "prompt-history.js", "session-ui.js", "keymap.js"]) {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(join(root, "src/app", f), "utf8"))(win);
}
const S = win.OMP_SETTINGS;
const D = win.TWEAK_DEFAULTS;
const row = (id) => S.rows().find(r => r.id === id);
const vals = (edits = {}) => ({ ...D, ...edits });

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

check("sections in page order, separator before approvals", () => {
  assert.deepEqual(S.SECTIONS.map(s => s.id),
    ["appearance", "remote", "layout", "chat", "composer", "rail", "terminal", "browser", "agent", "session", "approvals", "shortcuts"]);
  assert.deepEqual(S.SECTIONS.filter(s => s.sep).map(s => s.id), ["approvals"]);
  for (const s of S.SECTIONS) assert.ok(s.icon && s.title && s.blurb && s.groups.length, s.id);
});

check("every tweak row names a TWEAK_DEFAULTS key whose default is valid", () => {
  const ids = new Set();
  for (const r of S.rows()) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
    ids.add(r.id);
    assert.ok(r.label && r.desc, r.id);
    if (r.kind !== "tweak") continue;
    assert.ok(r.key in D, r.key);
    if (r.fold) continue;
    assert.equal(S.clamp(r, D[r.key]), D[r.key], `default of ${r.key} survives clamp`);
  }
});

check("custom rows name the renderers the page expects", () => {
  assert.deepEqual(S.rows().filter(r => r.kind === "custom").map(r => r.type).sort(),
    ["approvalMode", "approvalRules", "bgImage", "chromium", "goalContinue", "remoteMain", "remotePair", "shell", "shortcuts", "startupProfile", "terminalHeight", "version", "widgets", "widths"]);
  for (const r of S.rows().filter(r => r.kind === "custom")) for (const k of r.keys ?? []) assert.ok(k in D, k);
});

check("bounds come from the owning modules", () => {
  assert.equal(row("collapseAfter").min, win.OMP_COLLAPSE.MIN_AFTER);
  assert.equal(row("collapseAfter").max, win.OMP_COLLAPSE.MAX_AFTER);
  assert.equal(row("promptHistoryLimit").min, win.OMP_PROMPT_HISTORY.MIN_LIMIT);
  assert.equal(row("promptHistoryLimit").max, win.OMP_PROMPT_HISTORY.MAX_LIMIT);
  assert.equal(row("pasteCollapseLines").min, win.OMP_SESSION_UI.PASTE_LINES_MIN);
  assert.equal(row("pasteCollapseLines").max, win.OMP_SESSION_UI.PASTE_LINES_MAX);
  assert.deepEqual(row("foldTools").options.map(o => o.value), [...win.OMP_COLLAPSE.MODES]);
  assert.deepEqual([row("fontSize").min, row("fontSize").max, row("fontSize").step], [75, 150, 5]);
});

check("clamp keeps values in bounds and on the step", () => {
  const fs = row("fontSize");
  assert.equal(S.clamp(fs, 300), 150);
  assert.equal(S.clamp(fs, 10), 75);
  assert.equal(S.clamp(fs, 103), 105);
  assert.equal(S.clamp(fs, "x"), D.fontSize);
  assert.equal(S.clamp(fs, null), D.fontSize);
  assert.equal(S.clamp(row("promptHistoryLimit"), 57), 60);
  assert.equal(S.clamp(row("density"), "huge"), D.density);
  assert.equal(S.clamp(row("terminalScrollback"), 10000), 10000);
  assert.equal(S.clamp(row("terminalScrollback"), "10000"), D.terminalScrollback);
  assert.equal(S.clamp(row("sidebar"), "yes"), D.sidebar);
});

check("value resolves unset fold modes and clamps stored numbers", () => {
  assert.equal(S.value(row("foldThinking"), vals()), "auto");
  assert.equal(S.value(row("foldThinking"), vals({ foldThinking: null, autoCollapse: false })), "open");
  assert.equal(S.value(row("collapseAfter"), vals({ collapseAfter: 99 })), win.OMP_COLLAPSE.MAX_AFTER);
});

check("collapse-after shows only while a fold mode is auto", () => {
  const r = row("collapseAfter");
  assert.ok(S.visible(r, vals()));
  assert.ok(S.visible(r, vals({ foldThinking: "open" })));
  assert.ok(!S.visible(r, vals({ foldThinking: "open", foldTools: "folded" })));
  assert.ok(!S.visible(r, vals({ autoCollapse: false })), "legacy auto-collapse off resolves to open");
  assert.ok(S.visible(row("fontSize"), vals({ foldThinking: "open", foldTools: "open" })));
});

check("isModified compares with defaults, accent with the theme's own", () => {
  assert.ok(!S.rows().some(r => S.isModified(r, vals())), "fresh tweaks are unmodified");
  assert.ok(S.isModified(row("fontSize"), vals({ fontSize: 110 })));
  const daylight = vals({ theme: "daylight", accent: S.themeAccent("daylight") });
  assert.ok(S.isModified(row("theme"), daylight));
  assert.ok(!S.isModified(row("accent"), daylight));
  assert.ok(S.isModified(row("accent"), vals({ accent: "#FF7AC6" })));
  assert.ok(!S.isModified(row("accent"), vals({ accent: "#8af0c8" })), "case-insensitive");
  assert.ok(!S.isModified(row("foldTools"), vals({ foldTools: "auto" })), "explicit auto equals unset");
  assert.ok(S.isModified(row("foldTools"), vals({ foldTools: "open" })));
});

check("custom rows count their owned tweak keys", () => {
  assert.ok(S.isModified(row("custom:widths"), vals({ railWidth: 400 })));
  assert.ok(S.isModified(row("custom:terminalHeight"), vals({ terminalHeight: 300 })));
  assert.ok(!S.isModified(row("custom:widgets"), vals({ "widget:plugin:git": true })));
  assert.ok(S.isModified(row("custom:widgets"), vals({ "widget:ext-status": false })));
  assert.ok(!S.isModified(row("custom:shell"), vals({ railWidth: 400 })), "Rust-backed rows never count");
  const orphan = vals({ "widget:plugin:gone": false, "widget:plugin:git": false });
  const shown = { prefixKeys: ["widget:plugin:git", "widget:ext-status"] };
  assert.ok(S.isModified(row("custom:widgets"), orphan), "without prefixKeys every stored key counts");
  assert.ok(!S.isModified(row("custom:widgets"), vals({ "widget:plugin:gone": false }), shown), "an unrendered key never counts");
  assert.deepEqual(S.resetRow(row("custom:widgets"), orphan, shown), { "widget:plugin:git": true });
  assert.equal(S.modifiedCount("rail", vals({ "widget:plugin:gone": false }), shown), 0);
  assert.equal(S.modifiedCount("rail", vals({ "widget:plugin:gone": false })), 1);
});

check("modifiedCount per section and overall, hidden rows included; hiddenCount the rest", () => {
  const v = vals({ fontSize: 110, showMinimap: false, railWidth: 300 });
  assert.equal(S.modifiedCount("appearance", v), 1);
  assert.equal(S.modifiedCount("rail", v), 1);
  assert.equal(S.modifiedCount("layout", v), 1);
  assert.equal(S.modifiedCount("all", v), 3);
  assert.equal(S.modifiedCount(undefined, v), 3);
  // A changed row hidden by visibleIf still counts: the badge and the
  // section reset cover the same rows (page.jsx).
  const hidden = vals({ foldThinking: "open", foldTools: "open", collapseAfter: 9 });
  assert.equal(S.modifiedCount("chat", hidden), 3, "the hidden collapse-after row counts");
  assert.equal(S.hiddenCount("chat", hidden), 1);
  assert.equal(S.hiddenCount("chat", vals()), 0);
  assert.equal(S.hiddenCount("all", hidden), 1);
});

check("resetEdits resets only changed rows; theme brings its accent", () => {
  const v = vals({ theme: "phosphor", accent: "#FF7AC6", fontSize: 120, showRadar: false });
  assert.deepEqual(S.resetEdits("appearance", v), { theme: D.theme, accent: S.themeAccent(D.theme), fontSize: D.fontSize });
  assert.deepEqual(S.resetEdits("rail", vals({ "widget:plugin:git": false })), { "widget:plugin:git": true });
  assert.deepEqual(S.resetEdits("layout", vals({ railWidth: 400, sidebar: false })), { sidebar: true, railWidth: 0 });
  assert.deepEqual(S.resetEdits("session", vals()), {});
  const all = S.resetEdits("all", v);
  assert.equal(all.showRadar, true);
  assert.deepEqual(S.resetRow(row("accent"), vals({ theme: "daylight", accent: "#fff" })), { accent: S.themeAccent("daylight") });
});

check("resetRows resets only the given rows (the search matches)", () => {
  const v = vals({ fontSize: 120, monoChat: !D.monoChat, showRadar: false });
  const matched = S.search("font", v).groups.flatMap(g => g.rows);
  assert.deepEqual(S.resetRows(matched, v), { fontSize: D.fontSize, monoChat: D.monoChat });
  assert.deepEqual(S.resetRows([], v), {});
});

check("search matches label, desc text and keywords, grouped in page order", () => {
  const r = S.search("font", vals());
  assert.deepEqual(r.groups.flatMap(g => g.rows.map(x => x.id)), ["fontSize", "monoChat"]);
  assert.equal(r.total, 2);
  assert.equal(r.bySection.appearance, 2);
  assert.equal(r.bySection.chat, 0);
  assert.deepEqual(r.groups.map(g => [g.sectionId, g.sectionTitle, g.groupName]), [["appearance", "Appearance", "Text"]]);
  assert.equal(S.search("POWERSHELL", vals()).groups[0].src, "terminal.json", "keywords, case-insensitive");
  assert.equal(S.search("/compact", vals()).total, 1, "desc text with backticks stripped");
  assert.deepEqual(S.search("   ", vals()), { total: 0, hiddenCount: 0, bySection: Object.fromEntries(S.SECTIONS.map(s => [s.id, 0])), groups: [] });
});

check("search skips hidden rows and counts them as hiddenCount", () => {
  assert.equal(S.search("collapse after", vals()).total, 1);
  assert.equal(S.search("collapse after", vals()).hiddenCount, 0);
  const hidden = S.search("collapse after", vals({ foldThinking: "open", foldTools: "open" }));
  assert.equal(hidden.total, 0);
  assert.equal(hidden.hiddenCount, 1, "a match hidden by visibleIf is counted, not dropped silently");
  assert.deepEqual(hidden.groups, []);
  // glassEffect defaults off, so the opacity/blur rows hide even by default;
  // turning it on shows them (kw "translucent" is on all three).
  const glassOn = S.search("translucent", vals({ glassEffect: true }));
  assert.equal(glassOn.total, 3);
  assert.equal(glassOn.hiddenCount, 0, "nothing hidden while the effect is on");
  const noGlass = S.search("translucent", vals({ glassEffect: false }));
  assert.equal(noGlass.total, 1, "the master toggle always matches");
  assert.equal(noGlass.hiddenCount, 2, "its dependent rows hide while it is off");
});

check("search matches every whitespace-separated token (tokenised AND)", () => {
  // "font mono" needs both tokens: label "Font size" + label "Monospace chat"
  const both = S.search("font mono", vals());
  assert.equal(both.total, 1);
  assert.equal(both.groups[0].rows[0].id, "monoChat", "label token + label token");
  // Order does not matter.
  assert.equal(S.search("mono font", vals()).total, 1);
  // A keyword token and a desc token AND together on one row.
  assert.equal(S.search("spacing compact", vals()).groups[0].rows[0].id, "density", "kw + desc");
  // One token missing: no match.
  assert.equal(S.search("font nonexistent", vals()).total, 0);
  // Repeated whitespace is one separator.
  assert.equal(S.search("  font   mono  ", vals()).total, 1);
});

check("the key bindings row is found by any shortcut action's name or id", () => {
  const sidebar = win.OMP_KEYMAP.KEYMAP_ACTIONS.find(a => a.id === "desktop.sidebar.toggle");
  assert.ok(sidebar);
  for (const q of [sidebar.label, sidebar.id]) {
    assert.ok(S.search(q, vals()).groups.some(g => g.rows.some(r => r.id === "custom:shortcuts")), q);
  }
});

check("the corpus merges the section title, group name and src file name", () => {
  // Section title: "appearance" hits every visible row of that section.
  const app = S.search("appearance", vals());
  assert.deepEqual(app.groups.flatMap(g => g.rows.map(r => r.id)),
    ["theme", "accent", "density", "fontSize", "monoChat", "chatWidth", "textBrightness", "custom:bgImage", "glassEffect"]);
  // Group name: "updates" is not on any row's own text.
  assert.ok(S.search("updates", vals()).groups.flatMap(g => g.rows).some(r => r.id === "updateCheck"));
  // The src file name, verbatim and without ".json".
  assert.deepEqual(S.search("terminal.json", vals()).groups.flatMap(g => g.rows.map(r => r.id)), ["custom:shell"]);
  assert.deepEqual(S.search("keybindings", vals()).groups.flatMap(g => g.rows.map(r => r.id)), ["custom:shortcuts"]);
});

check("the known misses now hit: theme names, CJK terms, chord keywords", () => {
  assert.deepEqual(S.search("midnight", vals()).groups.flatMap(g => g.rows.map(r => r.id)), ["theme"], "theme name");
  for (const [term, id, why] of [
    ["字体", "fontSize", "CJK font"], ["通知", "notifyDone", "CJK notification"], ["外观", "theme", "CJK appearance"],
    ["主题", "theme", "CJK theme"], ["终端", "custom:shell", "CJK terminal"], ["浏览器", "custom:chromium", "CJK browser"],
    ["手机", "custom:remoteMain", "CJK phone"], ["远程", "custom:remoteMain", "CJK remote"], ["快捷键", "custom:shortcuts", "CJK shortcut"],
    ["审批", "custom:approvalMode", "CJK approval"], ["历史", "promptHistoryLimit", "CJK history"], ["更新", "updateCheck", "CJK update"],
  ]) assert.ok(S.search(term, vals()).groups.flatMap(g => g.rows).some(r => r.id === id), `${why} (${term})`);
  // 通知 lands on both notify rows.
  assert.deepEqual(S.search("通知", vals()).groups.flatMap(g => g.rows.map(r => r.id)), ["notifyDone", "notifyAsk"]);
  // "ctrl+enter" as a submitKey option label, "mode" as a theme keyword.
  assert.deepEqual(S.search("ctrl+enter", vals()).groups.flatMap(g => g.rows.map(r => r.id)), ["submitKey"]);
  assert.ok(S.search("mode", vals()).groups.flatMap(g => g.rows).some(r => r.id === "theme"));
  // Option labels are corpus: "yolo" names a choice of the approval mode.
  assert.ok(S.search("yolo", vals()).groups.flatMap(g => g.rows).some(r => r.id === "custom:approvalMode"));
});

check("the shortcut action names no longer create false positives", () => {
  // "port" is a substring of an action label ("Export session to HTML")
  // but not a word of one: no hit at all now.
  assert.equal(S.search("port", vals()).total, 0);
  // A multi-token query where every token is an action word still finds
  // the Shortcuts row, after any real match of the same group.
  const close = S.search("close tab", vals());
  assert.ok(close.groups.flatMap(g => g.rows.map(r => r.id)).includes("custom:shortcuts"), "all action words still match");
  // A multi-token query where one token is not an action word does not
  // pull the Shortcuts row in through moreKw.
  assert.ok(!S.search("sidebar banana", vals()).groups.flatMap(g => g.rows).some(r => r.id === "custom:shortcuts"));
  // moreKw matches are ordered after real matches of the same group.
  const toggle = S.search("Toggle project sidebar", vals());
  const toggleGroup = toggle.groups.find(g => g.rows.some(r => r.id === "custom:shortcuts"));
  assert.equal(toggleGroup.rows[toggleGroup.rows.length - 1].id, "custom:shortcuts", "the moreKw-only row comes last");
});

check("notification toggles are TWEAK_DEFAULTS-backed Session rows", () => {
  assert.equal(D.notifyDone, true);
  assert.equal(D.notifyAsk, true);
  for (const key of ["notifyDone", "notifyAsk"]) {
    const r = row(key);
    assert.equal(r.type, "toggle", key);
    assert.equal(r.label, key === "notifyDone" ? "Notify when a reply completes" : "Notify when approval is needed");
    assert.ok(/background/.test(r.desc), `${key} desc says background-only`);
  }
  // They sit in the Session section, so its reset and badge count them.
  assert.ok(S.SECTIONS.find(s => s.id === "session").groups.flatMap(g => g.rows).some(r => r.id === "notifyDone"));
  assert.equal(S.search("notify", vals()).total, 2);
});

check("the reopen-tabs desc states when the saved list is forgotten", () => {
  assert.ok(row("restoreTabs").desc.includes("Turning this off forgets the saved tab list at your next tab change."));
});

// ---- design/settings/controls.jsx: the mark follows the tokenised AND --
// SettingsMark is compiled as index.html's Babel does (test-goal.mjs's
// pattern) with a React.createElement stand-in, so the tree is inspected
// structurally: flattened into { text, mark } pieces.
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const { code } = Babel.transform(
  readFileSync(join(root, "src/design/settings/controls.jsx"), "utf8"),
  { presets: ["react"] });
const cwin = {};
// eslint-disable-next-line no-new-func
new Function("window", "React", `${code}
window.__exports = { SettingsMark };`)(cwin, { createElement: (type, props, ...children) => ({ type, props, children }) });

/** A SettingsMark tree as ordered { text, mark } pieces. */
function markPieces(text, query) {
  const flat = (n) => {
    if (typeof n === "string" || typeof n === "number") return [{ text: String(n), mark: false }];
    if (Array.isArray(n)) return n.flatMap(flat);
    if (n && typeof n === "object" && n.type === "mark") return [{ text: flat(n.children).map(p => p.text).join(""), mark: true }];
    if (n && typeof n === "object" && n.type) return flat(n.children);
    return [];
  };
  return flat(cwin.__exports.SettingsMark({ text, query }));
}

check("SettingsMark highlights each token independently, like the search's AND", () => {
  // search("font mono") matches rows whose label/desc carry both tokens
  // separately; the mark must light up each token where it lives, not the
  // whole "font mono" string verbatim (which never appears).
  const out = markPieces("Monospace font", "font mono");
  assert.deepEqual(out.filter(p => p.mark).map(p => p.text), ["Mono", "font"], "both tokens marked");
  assert.equal(out.filter(p => !p.mark).map(p => p.text).join(""), "space ", "the rest stays plain");
  // Token order in the query does not matter.
  const rev = markPieces("Monospace font", "mono font");
  assert.equal(rev.filter(p => p.mark).length, 2);
});

check("SettingsMark still marks a single-token query, case-insensitive", () => {
  assert.deepEqual(markPieces("Font size", "FONT").filter(p => p.mark).map(p => p.text), ["Font"]);
});

check("SettingsMark marks every occurrence, and escapes regex characters", () => {
  assert.equal(markPieces("data data", "data").filter(p => p.mark).length, 2);
  assert.deepEqual(markPieces("a.b*c (x)", "b*c (").filter(p => p.mark).map(p => p.text), ["b*c", "("]);
});

check("the page's arrow guard skips only arrow-owning groups, not every switch", () => {
  // ←/→ must stay alive on a switch (no arrow keynav) and on the approvals
  // mode seg (a radiogroup without keynav): the guard's selector is the
  // keynav groups' own marker, not role=switch/radio at large.
  // Source-text pins, the test-theme-effects.mjs way.
  const page = readFileSync(join(root, "src/design/settings/page.jsx"), "utf8");
  const controls = readFileSync(join(root, "src/design/settings/controls.jsx"), "utf8");
  const guard = page.match(/_SP_RADIO = "(.*?)"/)?.[1];
  assert.ok(guard, "the guard selector is defined");
  assert.ok(guard.includes("[data-st-arrows]"), "the guard skips the keynav groups");
  assert.ok(!guard.includes("[role='switch']"), "a switch is not skipped");
  // Every group that runs _ST_radioKeyNav carries the marker.
  const groups = controls.split("\n").filter(l => l.includes("_ST_radioKeyNav}"));
  assert.ok(groups.length >= 3, "the three keynav groups render");
  for (const line of groups) assert.ok(line.includes("data-st-arrows"), `group missing the marker: ${line.trim()}`);
});

check("the row's flash cannot restart the mount animation", () => {
  // The flash swaps animation-name on the row, so the mount animation must
  // ride a one-shot class (st-fresh) dropped on its own animationend —
  // otherwise removing .flash re-matches the mount rule and replays it.
  const css = readFileSync(join(root, "src/design/layout/settings.css"), "utf8");
  assert.ok(css.includes(".st-row.st-fresh"), "mount animation is pinned to st-fresh");
  assert.ok(!/^\.st-row \{ animation: st-row-in/m.test(css), "no bare .st-row mount rule left to re-match");
  const controls = readFileSync(join(root, "src/design/settings/controls.jsx"), "utf8");
  assert.ok(controls.includes("st-row-in\") setFresh(false)"), "st-fresh is dropped on the entrance's animationend");
  assert.ok(controls.includes("st-flash\") setFlash(false)"), "the flash still clears on its own animationend");
});
check("SettingsMark leaves text alone with no query", () => {
  assert.deepEqual(markPieces("Font size", ""), [{ text: "Font size", mark: false }]);
  assert.deepEqual(markPieces("Font size", null), [{ text: "Font size", mark: false }]);
});

console.log(`test-settings-schema: ${passed} checks passed`);
