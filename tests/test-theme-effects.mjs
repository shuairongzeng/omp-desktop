// tests/test-theme-effects.mjs — OMP_THEME registry and pure helpers.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import assert from "assert";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const win = {};
new Function("window", readFileSync(join(root, "src/app/theme-effects.js"), "utf8"))(win);
const T = win.OMP_THEME;

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL ${label}: ${err.message}`); process.exit(1); }
}

check("every theme has a default accent, and vice versa", () => {
  assert.deepEqual(Object.keys(T.THEME_ACCENTS).sort(), [...T.THEMES].sort());
});

check("every theme has a styles.css block", () => {
  const css = readFileSync(join(root, "src/design/styles.css"), "utf8");
  for (const name of T.THEMES) {
    assert.ok(css.includes(`.theme-${name}`), `styles.css is missing .theme-${name}`);
  }
});

check("fgOverrideCss: zero means no override", () => {
  assert.equal(T.fgOverrideCss("#E6E9F2", 0, false), null);
});

check("fgOverrideCss: positive brightness on a dark theme mixes toward white", () => {
  assert.equal(T.fgOverrideCss("#E6E9F2", 20, false),
    "color-mix(in oklab, #E6E9F2 80%, white)");
});

check("fgOverrideCss: positive brightness on a light theme mixes toward black", () => {
  assert.equal(T.fgOverrideCss("#14181F", 10, true),
    "color-mix(in oklab, #14181F 90%, black)");
});

check("fgOverrideCss: negative brightness washes toward the window background", () => {
  assert.equal(T.fgOverrideCss("#E6E9F2", -15, false),
    "color-mix(in oklab, #E6E9F2 85%, var(--bg-window))");
});

console.log(`theme-effects: ${passed} checks passed`);
