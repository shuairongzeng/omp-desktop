// tests/test-typography.mjs — the reading dial (#C): Settings → Appearance
// → Text rows for font family / reading size / compact reading, the
// TWEAK_DEFAULTS they persist through, the hook that applies them to
// <html>, and layout/typography.css the hook feeds. Mirrors
// test-theme-effects.mjs's structure: load the plain modules through
// `new Function("window", …)`, assert on the registries, then pin the
// CSS by source text (the way test-settings-schema.mjs pins page.jsx).
//
// The zero-change default is the hard rule: every check below asserts
// the default values produce byte-identical output to the pre-dial app.
// Run: node tests/test-typography.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ── registries ───────────────────────────────────────────────────────────
const win = {};
// The schema reads TWEAK_DEFAULTS late (a getter), so load order is free;
// use-bridge-snapshot.jsx is a Babel script in the app — compile it the
// way index.html's in-browser Babel does (test-goal.mjs's pattern) so the
// READING_FONTS table and applyReadingDial are real, not prose.
for (const f of ["src/app/constants.js", "src/app/settings-schema.js"]) {
  new Function("window", read(f))(win);
}
const { createRequire } = await import("node:module");
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
{
  const { code } = Babel.transform(read("src/app/use-bridge-snapshot.jsx"), { presets: ["react"] });
  const hooks = {};
  new Function("window", "React", `${code}
window.__hooks = { READING_FONTS, applyReadingDial };`)(hooks, { useEffect: () => {}, useState: () => [null, () => {}] });
  win.__hooks = hooks.__hooks;
}

const S = win.OMP_SETTINGS;
const D = win.TWEAK_DEFAULTS;
const row = (id) => S.rows().find(r => r.id === id);
const css = read("src/design/layout/typography.css");
const idx = read("src/design/layout/_index.css");

let passed = 0;
function check(label, fn) {
  try { fn(); }
  catch (err) { console.error(`FAILED: ${label}\n${err && err.stack || err}`); process.exit(1); }
  passed++;
}

// ── TWEAK_DEFAULTS: the three keys, at today's pixels ────────────────────
check("TWEAK_DEFAULTS carries the three dial keys at the shipped look", () => {
  assert.equal(D.uiFontFamily, "default");
  // 12.5px is --d-text @ density-compact, the size chat prose renders at
  // today (styles.css: `body { font-size: var(--d-text) }` + the compact
  // ladder); the default must be exactly that, not a rounder number.
  assert.equal(D.uiFontSize, 12.5);
  assert.equal(D.uiDensity, "comfortable");
  // The old fontSize (whole-window zoom, 75–150%) is untouched by the dial.
  assert.equal(D.fontSize, 100);
  assert.notEqual(D.density, undefined, "the pre-existing density ladder key stays");
});

// ── schema: three rows in the Appearance section's Text group ───────────
check("the three rows are registered in the Appearance section", () => {
  for (const id of ["uiFontFamily", "uiFontSize", "uiDensity"]) {
    const r = row(id);
    assert.ok(r, `${id} is a row`);
    assert.equal(r.kind, "tweak", id);
    assert.equal(r.key, id, `${id} row owns its key`);
    assert.ok(r.label && r.desc, `${id} has label and desc`);
  }
  const appearance = S.SECTIONS.find(s => s.id === "appearance");
  const text = appearance.groups.find(g => g.name === "Text");
  const ids = text.rows.map(r => r.id);
  assert.ok(ids.includes("uiFontFamily") && ids.includes("uiFontSize") && ids.includes("uiDensity"),
    "all three live in Appearance → Text");
});

check("font family is a seg over the five picks, default valid", () => {
  const r = row("uiFontFamily");
  assert.equal(r.type, "seg");
  assert.deepEqual(r.options.map(o => o.value), ["default", "segoe", "yahei", "consolas", "georgia"]);
  assert.equal(S.clamp(r, "default"), "default");
  assert.equal(S.clamp(r, "comic-sans"), "default", "an unknown id falls back to the default");
  assert.equal(S.clamp(r, "georgia"), "georgia");
});

check("reading size is a slider in [12, 18] on 0.5 steps, default 12.5", () => {
  const r = row("uiFontSize");
  assert.equal(r.type, "slider");
  assert.deepEqual([r.min, r.max, r.step], [12, 18, 0.5]);
  // The requested 13–18 span is covered; 12–12.5 keeps the shipped size a
  // legal value (the slider's own default IS the min+0.5).
  assert.ok(r.min <= 13 && r.max === 18, "13–18 covered");
  assert.equal(S.clamp(r, D.uiFontSize), D.uiFontSize, "the default survives clamp");
  assert.equal(S.clamp(r, 99), 18, "over the top clamps");
  assert.equal(S.clamp(r, "x"), D.uiFontSize, "a malformed stored value falls back");
});

check("reading density is a seg of comfortable/compact", () => {
  const r = row("uiDensity");
  assert.equal(r.type, "seg");
  assert.deepEqual(r.options.map(o => o.value), ["comfortable", "compact"]);
  assert.equal(S.clamp(r, "comfortable"), "comfortable");
  assert.equal(S.clamp(r, "compact"), "compact");
  assert.equal(S.clamp(r, "dense"), "comfortable", "not the old density ladder's value");
});

// ── the hook: three writes on <html> ─────────────────────────────────────
check("applyReadingDial writes the stack, the size and the compact class", () => {
  const H = win.__hooks;
  const style = new Map();
  const classes = new Set();
  const fakeRoot = {
    style: { setProperty: (k, v) => style.set(k, v), removeProperty: (k) => style.delete(k) },
    classList: { toggle: (_c, on) => { if (on) classes.add("ui-compact"); else classes.delete("ui-compact"); } },
  };
  // Defaults: the app's own stack, scale 1 (unchanged), no compact class.
  H.applyReadingDial(fakeRoot, { uiFontFamily: "default", uiFontSize: 12.5, uiDensity: "comfortable" });
  assert.equal(style.get("--font-ui"), "var(--font-sans)");
  assert.equal(style.get("--font-scale"), "1");
  assert.equal(classes.has("ui-compact"), false, "comfortable writes no class");

  // A picked family resolves to its table entry; 15px is a 1.2 ratio.
  H.applyReadingDial(fakeRoot, { uiFontFamily: "yahei", uiFontSize: 15, uiDensity: "compact" });
  assert.equal(style.get("--font-ui"), "var(--font-ui-yahei)");
  assert.equal(style.get("--font-scale"), "1.2");
  assert.equal(classes.has("ui-compact"), true);
  // A malformed size falls back to scale 1, never 0 or negative.
  H.applyReadingDial(fakeRoot, { uiFontFamily: "nope", uiFontSize: NaN, uiDensity: "compact" });
  assert.equal(style.get("--font-ui"), "var(--font-sans)", "unknown family id falls back");
  assert.equal(style.get("--font-scale"), "1", "a malformed size falls back to 1");
  H.applyReadingDial(fakeRoot, { uiFontSize: 0 });
  assert.equal(style.get("--font-scale"), "1", "a zero size falls back to 1");
  H.applyReadingDial(fakeRoot, { uiFontSize: -3 });
  assert.equal(style.get("--font-scale"), "1", "a negative size falls back to 1");

  // The table covers exactly the schema's options, default included.
  assert.deepEqual(Object.keys(H.READING_FONTS).sort(), ["consolas", "default", "georgia", "segoe", "yahei"]);
});

check("useThemeEffect depends on the three dial keys (a tweakchange re-runs it)", () => {
  const src = read("src/app/use-bridge-snapshot.jsx");
  const deps = src.match(/\[t\.theme, t\.density[^\]]*\]/)[0];
  for (const k of ["t.uiFontFamily", "t.uiFontSize", "t.uiDensity"]) {
    assert.ok(deps.includes(k), `${k} is a dependency of useThemeEffect`);
  }
  assert.ok(src.includes("applyReadingDial(root, t);"), "the effect calls applyReadingDial");
});

// ── typography.css: the variables, the wiring, the red line ──────────────
check("typography.css exists, is imported last by _index.css, and defines the vars", () => {
  assert.ok(css.includes("--font-ui:"), "--font-ui is defined");
  assert.ok(css.includes("--font-scale: 1;"), "--font-scale is defined at the neutral 1");
  assert.ok(css.includes("--row-h:") && css.includes("--status-h:"), "compact row/status heights are defined");
  assert.ok(idx.includes('@import "./typography.css";'), "_index.css imports typography.css");
  // Last in the file: its body/reading rules must win over the component
  // sheets' own font-family/font-size declarations at equal specificity.
  const imports = [...idx.matchAll(/@import "(.+?)";/g)].map(m => m[1]);
  assert.equal(imports[imports.length - 1], "./typography.css", "typography.css imports last");
});

check("the body carries the dial's font; reading size targets chat, composer and settings only", () => {
  assert.ok(/body\s*{\s*font-family:\s*var\(--font-ui\);/.test(css), "body uses --font-ui");
  for (const sel of [".ass-body > .md-content", ".user-text", ".composer-input textarea", ".st-rd"]) {
    assert.ok(css.includes(sel), `${sel} gets the reading size`);
  }
  assert.ok(css.includes("calc(var(--d-text) * var(--font-scale))"), "the size scales the ladder value");
  // NOT html's font-size: the px layout must not re-scale.
  assert.ok(!/^html\s*{\s*font-size:/m.test(css), "no html font-size write");
});

check("compact tightens chat gap, sidebar row height and status bar height", () => {
  assert.ok(css.includes(".chat-pad"), "chat message spacing is targeted");
  assert.ok(css.includes(".psb-row"), "sidebar rows are targeted");
  assert.ok(/\.status\s*{[^}]*height:\s*var\(--status-h\)/s.test(css), "the status bar height is targeted");
  assert.ok(css.includes("html.ui-compact"), "compact is class-gated on <html>");
});

// ── the red line: monospace never touched ────────────────────────────────
check("no rule in typography.css touches the monospace surfaces", () => {
  // Rules only: strip comments first so prose in them never counts.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const mono = [".xterm", ".mono", ".eval-code", ".diff-body", ".term-panel", ".code-block"];
  for (const sel of mono) {
    assert.ok(!rules.includes(sel), `${sel} must not appear in typography.css rules`);
  }
  // No bare `pre`/`code` selectors either (md-content's inline code is
  // sized in em relative to its parent — it follows the prose scale by
  // design, but its family is pinned in platform.css).
  for (const bare of [/\bpre\s*[,{]/, /\bcode\s*[,{:]/]) {
    assert.ok(!bare.test(rules), "no bare pre/code selectors");
  }
  // The mono stack is never assigned here.
  assert.ok(!rules.includes("var(--font-mono)"), "the mono stack is never assigned");
  // The family override list is auditable: every selector in it is a
  // reading surface, none of the monospace set.
  const familyRules = rules.match(/^(.+?)\s*\{[^}]*font-family:\s*var\(--font-ui\)/gm) ?? [];
  assert.ok(familyRules.length >= 2, "the family rule set is present");
  for (const line of familyRules) {
    for (const sel of mono) assert.ok(!line.includes(sel), `${sel} not in the family rules`);
  }
  // And no font-size write ever lands on those selectors' names.
  const sizeRules = rules.match(/^(.+?)\s*\{[^}]*font-size[^}]*/gm) ?? [];
  for (const line of sizeRules) {
    for (const sel of mono) assert.ok(!line.includes(sel), `${sel} not in the size rules`);
  }
});

// ── the font table: every named pick carries a CJK fallback ──────────────
check("every named font stack carries a CJK fallback", () => {
  const table = {
    segoe: css.match(/--font-ui-segoe:\s*([^;]+);/)?.[1],
    yahei: css.match(/--font-ui-yahei:\s*([^;]+);/)?.[1],
    consolas: css.match(/--font-ui-consolas:\s*([^;]+);/)?.[1],
    georgia: css.match(/--font-ui-georgia:\s*([^;]+);/)?.[1],
  };
  // One CJK face per stack, before the generic escape, so mixed
  // Chinese/Latin text never falls to the browser's default.
  const cjk = /["']?(Microsoft YaHei(?: UI)?|PingFang SC|Noto (?:Sans|Serif) CJK SC|SimHei|SimSun)["']?/;
  for (const [name, stack] of Object.entries(table)) {
    assert.ok(stack, `--font-ui-${name} is defined`);
    assert.ok(cjk.test(stack), `--font-ui-${name} carries a CJK fallback: ${stack}`);
    assert.ok(/sans-serif|serif|monospace/.test(stack), `--font-ui-${name} ends in a generic`);
  }
  // Segoe UI, Microsoft YaHei, Consolas and Georgia are all actually present.
  assert.ok(table.segoe.includes('"Segoe UI"'));
  assert.ok(table.yahei.includes('"Microsoft YaHei"'));
  assert.ok(table.consolas.includes("Consolas"));
  assert.ok(table.georgia.includes("Georgia"));
});

check("the default stack is the app's own --font-sans (zero change)", () => {
  assert.ok(css.includes("--font-ui: var(--font-sans);"), "the fallback is the shipped stack");
  assert.equal(win.__hooks.READING_FONTS.default, "var(--font-sans)");
});

check("phone guards keep the dial off the handset layout", () => {
  assert.ok(css.includes("@media (max-width: 760px)"), "the phone tier is guarded");
  assert.ok(css.includes("html.remote-shim"), "the remote shim neutralises the dial");
  // 16px floor on the phone: iOS focus zoom.
  assert.ok(/font-size:\s*16px/.test(css), "16px floor on the phone");
});

console.log(`typography: ${passed} checks passed`);
