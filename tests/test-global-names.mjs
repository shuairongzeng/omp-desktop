// tests/test-global-names.mjs — every `window.<name> =` a loaded script
// makes is a global the whole document shares, and a second assignment
// silently overwrites the first (plain <script> tags and Babel scripts all
// land in one top-level scope). That is how `app/notify.js`'s
// `window.OMP_NOTIFY` got squatted by `live.js`'s pre-existing export of
// the same name: the overwrite only bites at effect time, as a TypeError
// that unmounts the whole React tree (no error boundary), so no unit test
// of either module could see it. This scan pins the invariant instead:
// each global name is assigned by exactly one loaded file.
//
// Exempt: the idempotent `window.X = window.X || {}` init that the
// `OMP_SETTINGS_ROWS` family of row files share by design (each row file
// merges into the same registry object).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`✔ ${name}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The scripts the document actually loads: `src/index.html`'s <script>
 *  tags. A file outside that set (a dead prototype like `design/data.js`,
 *  the unused half of the React dev/prod pair) cannot squat a global at
 *  runtime, so scanning the whole tree would flag ghosts. */
function loadedScripts() {
  const html = readFileSync(join(root, "src/index.html"), "utf8");
  const out = [];
  for (const m of html.matchAll(/<script[^>]*src="([^"?]+)[^"]*"/g)) out.push(m[1]);
  return out;
}

/** Strip block and line comments so prose mentions never count. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** name → [files that assign it], over `window.X =` and
 *  `Object.assign(window, { X: … })` forms. */
function assignments() {
  const map = new Map();
  const add = (name, file) => {
    if (!map.has(name)) map.set(name, []);
    if (!map.get(name).includes(file)) map.get(name).push(file);
  };
  for (const rel of loadedScripts()) {
    const src = stripComments(readFileSync(join(root, "src", rel), "utf8"));
    // `window.X = …` but not the idempotent `window.X = window.X || {}`
    // registry init, and not a member write (`window.X.y =`).
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      const name = m[1];
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (new RegExp(`^\\s*window\\.${name}\\s*\\|\\|`).test(after)) continue;
      add(name, rel);
    }
    // Object.assign(window, { A, B: c, … })
    for (const m of src.matchAll(/Object\.assign\(\s*window\s*,\s*\{([^}]*)\}/g)) {
      for (const key of m[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*[:,}]/g)) add(key[1], rel);
    }
  }
  return map;
}

const map = assignments();

check("no global name is assigned by two loaded files", () => {
  const dupes = [...map].filter(([, files]) => files.length > 1);
  assert(dupes.length === 0,
    `shared window globals: ${dupes.map(([n, f]) => `${n} ← ${f.join(", ")}`).join("; ")}`);
});

check("the notify pair keeps its own name (live.js owns OMP_NOTIFY)", () => {
  assert(map.get("OMP_NOTIFY")?.length === 1, "OMP_NOTIFY must be assigned exactly once");
  assert(map.get("OMP_NOTIFY")[0] === "live.js", "OMP_NOTIFY belongs to live.js");
  assert(map.get("OMP_OSNOTIFY")?.length === 1, "OMP_OSNOTIFY must be assigned exactly once");
  assert(map.get("OMP_OSNOTIFY")[0] === "app/notify.js", "OMP_OSNOTIFY belongs to app/notify.js");
});

check("the scan sees the loaded script set, not an empty one", () => {
  const scripts = loadedScripts();
  assert(scripts.length > 40, `expected the full load list, got ${scripts.length} scripts`);
  assert(scripts.includes("live.js") && scripts.includes("app/notify.js"),
    "live.js and app/notify.js must both be in the loaded set");
  assert(!scripts.includes("design/data.js"), "the dead prototype must stay unloaded");
});

console.log(`test-global-names: ${passed} checks passed`);
