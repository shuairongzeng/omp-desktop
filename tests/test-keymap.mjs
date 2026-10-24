#!/usr/bin/env node
// Regression script for src/app/keymap.js chord algebra.
// No test framework, no bundler — zero dependencies beyond node:assert/strict.
// Run: node tests/test-keymap.mjs  (or: npm run test:keymap)
//
// The file is a browser IIFE that writes to `window.OMP_KEYMAP`.  Load it by
// evaluating its source against a stub global; `detectMac()` tolerates a
// missing `navigator`, so no JSDOM is needed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root  = join(dirname(fileURLToPath(import.meta.url)), "..");
const src   = readFileSync(join(root, "src/app/keymap.js"), "utf8");
const win   = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const K = win.OMP_KEYMAP;

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

// ── canonicalChord ────────────────────────────────────────────────────────────

check("canonicalChord: modifier reorder Alt+Shift+P", () =>
  assert.equal(K.canonicalChord("Alt+Shift+P"), "shift+alt+p"));

check("canonicalChord: Ctrl+P stays ctrl+p (no implied shift)", () =>
  assert.equal(K.canonicalChord("Ctrl+P"), "ctrl+p"));

check("canonicalChord: bare uppercase P is no longer shift-inferred (matches omp's lowercase-before-canonicalise config path)", () =>
  assert.equal(K.canonicalChord("P"), "p"));

check("canonicalChord: lowercase p unchanged", () =>
  assert.equal(K.canonicalChord("p"), "p"));

check("canonicalChord: Esc → escape", () =>
  assert.equal(K.canonicalChord("Esc"), "escape"));

check("canonicalChord: Return → enter", () =>
  assert.equal(K.canonicalChord("Return"), "enter"));

check("canonicalChord: CTRL+ALT+] case-insensitive, symbol base survives", () =>
  assert.equal(K.canonicalChord("CTRL+ALT+]"), "ctrl+alt+]"));

check("canonicalChord: super+K with modifier → no implied shift", () =>
  assert.equal(K.canonicalChord("super+K"), "super+k"));

check("canonicalChord: missing base returns empty string", () =>
  assert.equal(K.canonicalChord("ctrl+"), ""));

check("canonicalChord: whitespace-only returns empty string", () =>
  assert.equal(K.canonicalChord("   "), ""));

check("canonicalChord: comma base survives (settings: ctrl+,)", () =>
  assert.equal(K.canonicalChord("Ctrl+,"), "ctrl+,"));


// ── chordFromEvent ────────────────────────────────────────────────────────────

check("chordFromEvent: ctrl+shift+p from event", () =>
  assert.equal(K.chordFromEvent({ key: "P", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), "ctrl+shift+p"));

check("chordFromEvent: bare modifier returns null", () =>
  assert.equal(K.chordFromEvent({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: alt+up from ArrowUp", () =>
  assert.equal(K.chordFromEvent({ key: "ArrowUp", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), "alt+up"));

check("chordFromEvent: shifted symbol drops shift", () =>
  assert.equal(K.chordFromEvent({ key: "?", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }), "?"));

check("chordFromEvent: metaKey maps to super", () =>
  assert.equal(K.chordFromEvent({ key: "k", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }), "super+k"));

check("chordFromEvent: macOS Alt+M yields composed char — recover from e.code", () =>
  assert.equal(K.chordFromEvent({ key: "µ", code: "KeyM", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), "alt+m"));

check("chordFromEvent: AZERTY Ctrl+A — plain ASCII key must not use e.code", () =>
  assert.equal(K.chordFromEvent({ key: "a", code: "KeyQ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), "ctrl+a"));

check("chordFromEvent: AltGraph key is not a chord", () =>
  assert.equal(K.chordFromEvent({ key: "AltGraph", ctrlKey: true, shiftKey: false, altKey: true, metaKey: false }), null));

check("chordFromEvent: CapsLock key is not a chord", () =>
  assert.equal(K.chordFromEvent({ key: "CapsLock", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: IME Process key is not a chord", () =>
  assert.equal(K.chordFromEvent({ key: "Process", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: unrecovered Dead compose step is not a chord", () =>
  assert.equal(K.chordFromEvent({ key: "Dead", code: "BracketLeft", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), null));

check("chordFromEvent: Dead key recovers the physical letter from e.code", () =>
  assert.equal(K.chordFromEvent({ key: "Dead", code: "KeyN", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }), "alt+n"));

check("chordFromEvent: IME composition is never a chord regardless of key", () =>
  assert.equal(K.chordFromEvent({ key: "Escape", isComposing: true, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: ASCII shifted symbol ignores e.code even under Ctrl", () =>
  assert.equal(K.chordFromEvent({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), "ctrl+@"));

check("chordFromEvent: NON_CHORD_KEYS covers the Super/Hyper/Fn family so a stray press never becomes a bogus recordable chord", () => {
  for (const key of ["Super", "Hyper", "OS", "Fn", "FnLock", "Symbol", "SymbolLock"]) {
    assert.equal(
      K.chordFromEvent({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }),
      null,
      `key=${key} must not yield a chord`
    );
  }
});

check("chordFromEvent: real-world WebKitGTK bug — key=Unidentified, code=Tab recovers shift+tab", () =>
  assert.equal(K.chordFromEvent({ key: "Unidentified", code: "Tab", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }), "shift+tab"));

check("chordFromEvent: key=Unidentified recovers any KEY_MAP-named code, e.g. Escape", () =>
  assert.equal(K.chordFromEvent({ key: "Unidentified", code: "Escape", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }), "escape"));

check("chordFromEvent: key=Unidentified with an unmapped code still yields no chord", () =>
  assert.equal(K.chordFromEvent({ key: "Unidentified", code: "KeyQ", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }), null));

check("chordFromEvent: key=Unidentified with no code at all still yields no chord", () =>
  assert.equal(K.chordFromEvent({ key: "Unidentified", ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }), null));

check("chordFromEvent: Ctrl+, and Cmd+, give the comma chords", () => {
  assert.equal(K.chordFromEvent({ key: ",", code: "Comma", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), "ctrl+,");
  assert.equal(K.chordFromEvent({ key: ",", code: "Comma", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }), "super+,");
});


// ── resolve ───────────────────────────────────────────────────────────────────

check("resolve: empty config gives every action its defaultKeys", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, {});
  for (const a of K.KEYMAP_ACTIONS) {
    assert.deepEqual(r.byAction.get(a.id), a.defaultKeys, `action ${a.id}`);
  }
});

check("resolve: [] disables an action (beats default)", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": [] });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), []);
  assert.equal(r.byChord.get("shift+alt+p"), undefined);
});

check("resolve: bare string value is accepted and canonicalised", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": "Ctrl+Shift+O" });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+shift+o"]);
});

check("resolve: configured chord beats default — two-pass semantics", () => {
  // desktop.tab.new default is ctrl+t. Explicitly bind it to ctrl+k.
  // ctrl+k is desktop.commands.open's *default* — the configured binding wins.
  const r = K.resolve(K.KEYMAP_ACTIONS, { "desktop.tab.new": "ctrl+k" });
  const winner = r.byChord.get("ctrl+k");
  assert.equal(winner, "desktop.tab.new",  // configured beats default, regardless of registry order
    `expected desktop.tab.new to win but got ${winner}`);
  assert.ok(r.conflicts.some(c => c.chord === "ctrl+k"), "conflict recorded");
  const conflict = r.conflicts.find(c => c.chord === "ctrl+k");
  assert.ok(conflict.actions.includes("desktop.tab.new"), "winner in conflict");
  assert.ok(conflict.actions.includes("desktop.commands.open"), "loser in conflict");
});

check("resolve: duplicate chords for one action are de-duplicated", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": ["ctrl+x", "ctrl+x"] });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+x"]);
});

// ── Layer precedence (the load-bearing behaviour) ─────────────────────────────

check("resolve: overlay wins over omp layer per action", () => {
  const omp     = { "app.plan.toggle": ["shift+alt+o"] };
  const overlay = { "app.plan.toggle": ["ctrl+shift+o"] };
  const r = K.resolve(K.KEYMAP_ACTIONS, { ...omp, ...overlay });
  assert.deepEqual(r.byAction.get("app.plan.toggle"), ["ctrl+shift+o"]);
});

check("resolve: setResolved + lookup/keysFor reflect a rebind", () => {
  const r = K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": "ctrl+shift+o" });
  K.setResolved(r);
  assert.equal(K.lookup("ctrl+shift+o"), "app.plan.toggle");
  assert.deepEqual(K.keysFor("app.plan.toggle"), ["ctrl+shift+o"]);
  assert.deepEqual(K.keysFor("no.such.action"), []);
});

check("matches: true for the event that resolves to the given action under the current resolution", () => {
  K.setResolved(K.resolve(K.KEYMAP_ACTIONS, { "app.plan.toggle": "ctrl+shift+o" }));
  assert.equal(
    K.matches({ key: "O", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, "app.plan.toggle"),
    true
  );
  assert.equal(
    K.matches({ key: "O", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, "app.other.action"),
    false
  );
});

// ── allowedInInput ────────────────────────────────────────────────────────────

check("allowedInInput: ctrl+ combos allowed in input", () =>
  assert.equal(K.allowedInInput("ctrl+p"), true));

check("allowedInInput: escape allowed in input", () =>
  assert.equal(K.allowedInInput("escape"), true));

check("allowedInInput: shift+tab allowed in input", () =>
  assert.equal(K.allowedInInput("shift+tab"), true));

check("allowedInInput: F5 allowed in input", () =>
  assert.equal(K.allowedInInput("f5"), true));

check("allowedInInput: bare p not allowed in input", () =>
  assert.equal(K.allowedInInput("p"), false));

check("allowedInInput: shift+p not allowed in input", () =>
  assert.equal(K.allowedInInput("shift+p"), false));

// ── isTypingTarget ────────────────────────────────────────────────────────────

check("isTypingTarget: TEXTAREA is a typing target", () =>
  assert.equal(K.isTypingTarget({ tagName: "TEXTAREA" }), true));

check("isTypingTarget: contentEditable is a typing target", () =>
  assert.equal(K.isTypingTarget({ isContentEditable: true }), true));

check("isTypingTarget: DIV is not a typing target", () =>
  assert.equal(K.isTypingTarget({ tagName: "DIV" }), false));

// ── Shift+Tab composer scoping (dispatch guard) ──────────────────────────────
//
// The default `app.thinking.cycle` chord (shift+tab) is scoped to the
// composer textarea in useKeymapDispatch: it must not preventDefault
// (and so must not steal backward focus traversal) anywhere else. The
// predicates the dispatcher consults are `isComposerScoped` and
// `isComposerTarget`; `fires` mirrors the dispatcher's exact guard order.

/** Minimal Element-shaped stub: `closest` walks a fixed ancestor chain of
 *  selector strings (the composer textarea is `.composer-input textarea`). */
const stubEl = (chain) => ({
  closest: (sel) => (chain.includes(sel) ? { chain } : null),
});
const COMPOSER_TA = stubEl(["textarea", ".composer-input textarea"]);
const CHAT_TEXT  = stubEl(["div", ".chat-wrap"]);
const STUB_BODY  = stubEl(["body"]);

// The dispatcher's guard, verbatim: composer-scoped chords fire only
// inside the composer; everything else fires wherever focus is.
const fires = (e, chord = K.chordFromEvent(e)) => {
  if (!chord) return false;
  const id = K.lookup(chord);
  if (!id) return false;
  if (K.isComposerScoped(id, chord) && !K.isComposerTarget(e.target)) return false;
  return true;
};
const shiftTab = { key: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false };

check("shift+tab: default binding resolves to the thinking cycle", () =>
  assert.equal(K.lookup("shift+tab"), "app.thinking.cycle"));

check("shift+tab: isComposerScoped is the thinking cycle on its default chord only", () => {
  assert.equal(K.isComposerScoped("app.thinking.cycle", "shift+tab"), true);
  // Any other action, or the same action on a rebound chord, is global.
  assert.equal(K.isComposerScoped("desktop.tab.prev", "ctrl+shift+tab"), false);
  assert.equal(K.isComposerScoped("app.thinking.cycle", "ctrl+shift+t"), false);
  assert.equal(K.isComposerScoped("app.plan.toggle", "shift+alt+p"), false);
});

check("shift+tab: isComposerTarget accepts only the composer textarea", () => {
  assert.equal(K.isComposerTarget(COMPOSER_TA), true);
  assert.equal(K.isComposerTarget(CHAT_TEXT), false);
  assert.equal(K.isComposerTarget(STUB_BODY), false);
  assert.equal(K.isComposerTarget(null), false);
  // The window itself (target is not an Element) is not the composer.
  assert.equal(K.isComposerTarget({ tagName: "WINDOW" }), false);
});

check("shift+tab: fires with the composer textarea focused", () =>
  assert.equal(fires({ ...shiftTab, target: COMPOSER_TA }), true));

check("shift+tab: falls through everywhere else (chat, body, window)", () => {
  assert.equal(fires({ ...shiftTab, target: CHAT_TEXT }), false);
  assert.equal(fires({ ...shiftTab, target: STUB_BODY }), false);
  assert.equal(fires({ ...shiftTab, target: null }), false);
  assert.equal(fires({ ...shiftTab, target: { tagName: "WINDOW" } }), false);
});

check("shift+tab: a rebound thinking cycle is a plain global — fires off the composer too", () => {
  withBindings({ "app.thinking.cycle": ["ctrl+shift+t"] }, () => {
    const ev = { key: "T", shiftKey: true, ctrlKey: true, altKey: false, metaKey: false, isComposing: false };
    assert.equal(K.chordFromEvent(ev), "ctrl+shift+t");
    assert.equal(fires({ ...ev, target: CHAT_TEXT }), true);
    // And the default chord is no longer claimed: native Shift+Tab
    // traversal works everywhere, composer included.
    assert.equal(fires({ ...shiftTab, target: COMPOSER_TA }), false);
  });
});

check("shift+tab: unbinding the thinking cycle leaves the chord native everywhere", () => {
  withBindings({ "app.thinking.cycle": [] }, () => {
    assert.equal(fires({ ...shiftTab, target: COMPOSER_TA }), false);
    assert.equal(fires({ ...shiftTab, target: CHAT_TEXT }), false);
  });
});

check("shift+tab: other actions keep firing outside the composer", () => {
  // The guard is chord-specific, not a blanket Shift+Tab swallow.
  withBindings({ "app.plan.toggle": ["shift+alt+p"] }, () => {
    const ev = { key: "P", shiftKey: true, altKey: true, ctrlKey: false, metaKey: false, isComposing: false };
    assert.equal(fires({ ...ev, target: CHAT_TEXT }), true);
    assert.equal(fires({ ...ev, target: COMPOSER_TA }), true);
  });
});
 
// ── formatChord ───────────────────────────────────────────────────────────────

check("formatChord: shift+alt+p on non-Mac", () =>
  assert.equal(K.formatChord("shift+alt+p", false), "Shift+Alt+P"));

check("formatChord: shift+alt+p on Mac uses Option", () =>
  assert.equal(K.formatChord("shift+alt+p", true), "Shift+Option+P"));

check("formatChord: escape → Esc", () =>
  assert.equal(K.formatChord("escape", false), "Esc"));

check("formatChord: super on Mac → Cmd", () =>
  assert.equal(K.formatChord("super+k", true), "Cmd+K"));

// ── Registry integrity ────────────────────────────────────────────────────────

check("registry: all action ids are unique", () => {
  const ids = K.KEYMAP_ACTIONS.map(a => a.id);
  const set = new Set(ids);
  assert.equal(set.size, ids.length, "duplicate action id found");
});

check("registry: all defaultKeys are already canonical", () => {
  for (const a of K.KEYMAP_ACTIONS) {
    for (const k of a.defaultKeys) {
      assert.equal(K.canonicalChord(k), k, `${a.id} defaultKey ${k} is not canonical`);
    }
  }
});

check("registry: no duplicate chord across actions in the default set", () => {
  const seen = new Map();
  for (const a of K.KEYMAP_ACTIONS) {
    for (const k of a.defaultKeys) {
      if (seen.has(k)) {
        assert.fail(`chord ${k} claimed by both ${seen.get(k)} and ${a.id}`);
      }
      seen.set(k, a.id);
    }
  }
});

// ── guestShouldBypass (terminal xterm + browser panel page) ──────────────────

/** Resolve the keymap with `config` (action id → chords) for `fn`, then restore the defaults. */
function withBindings(config, fn) {
  K.setResolved(K.resolve(K.KEYMAP_ACTIONS, config));
  try { fn(); } finally { K.setResolved(K.resolve(K.KEYMAP_ACTIONS, {})); }
}
K.setResolved(K.resolve(K.KEYMAP_ACTIONS, {}));

const ev = (key, mods = "") => ({
  key,
  ctrlKey: mods.includes("c"),
  shiftKey: mods.includes("s"),
  altKey: mods.includes("a"),
  metaKey: mods.includes("m"),
  isComposing: false,
});

// Explicit platform per assertion: the result must not depend on the host.
const LINUX = false;
const MAC = true;
const bypass = (e, isMac = LINUX) => K.guestShouldBypass(e, isMac);

check("guest: bound super chords bypass on every platform", () => {
  for (const k of ["t", "w", "k", "h", "b", "/", "`", ","]) {
    assert.equal(bypass(ev(k, "m"), LINUX), true, `super+${k}`);
    assert.equal(bypass(ev(k, "m"), MAC), true, `super+${k} (mac)`);
  }
  assert.equal(bypass(ev("T", "m")), true, "caps lock → super+t");
});

check("guest: fromGuest actions bypass whatever their modifiers", () => {
  for (const isMac of [LINUX, MAC]) {
    assert.equal(bypass(ev("`", "c"), isMac), true, "ctrl+` (terminal toggle)");
    assert.equal(bypass(ev("Tab", "c"), isMac), true, "ctrl+tab (next tab)");
    assert.equal(bypass(ev("Tab", "cs"), isMac), true, "ctrl+shift+tab (previous tab)");
    assert.equal(bypass(ev("B", "cs"), isMac), true, "ctrl+shift+b (browser toggle), macOS too");
  }
  assert.equal(bypass(ev("B", "ms"), MAC), true, "⌘⇧B (browser toggle)");
});

check("guest: a rebound panel toggle bypasses; its old default stays the guest's", () => {
  withBindings({ "desktop.terminal.toggle": ["ctrl+j"] }, () => {
    assert.equal(bypass(ev("j", "c")), true, "ctrl+j is the toggle now");
    assert.equal(bypass(ev("`", "c")), false, "ctrl+` is unbound now");
    assert.equal(bypass(ev("`", "m")), false, "super+` is unbound now");
  });
  withBindings({ "desktop.terminal.toggle": ["alt+t"] }, () => {
    assert.equal(bypass(ev("t", "a")), true, "an alt chord still reaches the toggle");
  });
  withBindings({ "desktop.browser.toggle": ["ctrl+e"] }, () => {
    assert.equal(bypass(ev("e", "c"), LINUX), true, "the browser toggle on plain ctrl+e still leaves the page");
    assert.equal(bypass(ev("e", "c"), MAC), true, "… on macOS too");
  });
});

check("guest: an unbound default no longer steals its chord", () => {
  withBindings({ "desktop.terminal.toggle": [] }, () => {
    assert.equal(bypass(ev("`", "c")), false, "ctrl+`");
  });
  withBindings({ "desktop.tab.new": [] }, () => {
    assert.equal(bypass(ev("t", "m")), false, "super+t");
  });
  withBindings({ "desktop.browser.toggle": [] }, () => {
    assert.equal(bypass(ev("B", "cs"), MAC), false, "ctrl+shift+b on macOS");
  });
});

check("guest: bound ctrl+shift chords bypass off macOS only", () => {
  assert.equal(bypass(ev("p", "cs"), LINUX), true, "ctrl+shift+p (model backward)");
  assert.equal(bypass(ev("PageUp", "cs"), LINUX), true, "ctrl+shift+pageup (move tab)");
  assert.equal(bypass(ev("p", "cs"), MAC), false, "ctrl+shift+p on macOS");
  withBindings({ "desktop.commands.open": ["ctrl+shift+k"] }, () => {
    assert.equal(bypass(ev("k", "cs"), LINUX), true, "a rebound ctrl+shift chord");
    assert.equal(bypass(ev("k", "c"), LINUX), false, "its old ctrl+k default is unbound");
  });
});

check("guest: bound plain ctrl and alt chords stay the guest's", () => {
  for (const isMac of [LINUX, MAC]) {
    assert.equal(bypass(ev("w", "c"), isMac), false, "ctrl+w: a shell's kill-word, never closes the tab from a page");
    assert.equal(bypass(ev("t", "c"), isMac), false, "ctrl+t");
    assert.equal(bypass(ev("k", "c"), isMac), false, "ctrl+k: a page's command palette");
    assert.equal(bypass(ev("b", "c"), isMac), false, "ctrl+b: bold in a page editor");
    assert.equal(bypass(ev("h", "c"), isMac), false, "ctrl+h");
    assert.equal(bypass(ev("ArrowUp", "c"), isMac), false, "ctrl+up");
    assert.equal(bypass(ev("p", "c"), isMac), false, "ctrl+p is shell history");
    assert.equal(bypass(ev("m", "a"), isMac), false, "alt+m");
    assert.equal(bypass(ev("p", "as"), isMac), false, "shift+alt+p");
  }
});

check("guest: unbound chords and plain keys stay the guest's", () => {
  assert.equal(bypass(ev("Escape")), false, "escape (bound to interrupt, no modifier)");
  assert.equal(bypass(ev("c", "c")), false, "ctrl+c");
  assert.equal(bypass(ev("Tab")), false, "plain Tab completes");
  assert.equal(bypass(ev("Tab", "s")), false, "shift+Tab");
  assert.equal(bypass(ev("a")), false);
  assert.equal(bypass(ev("Enter")), false);
  assert.equal(bypass(ev("t", "ms")), false, "super+shift+t");
  assert.equal(bypass(ev("t", "ma")), false, "super+alt+t");
  assert.equal(bypass(ev("x", "cs")), false, "ctrl+shift+x");
  assert.equal(bypass(ev("~", "m")), false, "super+~ (shifted backtick) is not bound");
});

check("guest: shifted variants match the bound chord (chordFromEvent normalisation)", () => {
  // German Cmd+Shift+7 → key "/" with shiftKey — shift cleared for non-alpha
  assert.equal(bypass({ key: "/", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, isComposing: false }), true);
});

check("guest: a composer-scope action never bypasses", () => {
  withBindings({ "app.message.followUp": ["super+j"] }, () => {
    assert.equal(bypass(ev("j", "m")), false);
  });
});

check("guest: copy/paste chords never bypass, even when bound", () => {
  withBindings({ "desktop.commands.open": ["ctrl+shift+c", "ctrl+shift+v", "super+c", "super+v"] }, () => {
    assert.equal(bypass(ev("C", "cs"), LINUX), false, "ctrl+shift+c copies");
    assert.equal(bypass(ev("V", "cs"), LINUX), false, "ctrl+shift+v pastes");
    assert.equal(bypass(ev("c", "m"), MAC), false, "⌘C copies");
    assert.equal(bypass(ev("v", "m"), MAC), false, "⌘V pastes");
  });
  assert.equal(bypass(ev("c", "m")), false, "super+c unbound");
});

check("guest: a composing event never bypasses", () => {
  assert.equal(bypass({ ...ev("t", "m"), isComposing: true }), false);
});

check("guest: AltGr (reported as ctrl+alt) types, even on a bound chord", () => {
  const altGr = (key) => ({ ...ev(key, "ca"), getModifierState: (m) => m === "AltGraph" });
  withBindings({ "desktop.terminal.toggle": ["ctrl+alt+q"] }, () => {
    assert.equal(bypass(ev("q", "ca")), true, "a real ctrl+alt chord bound to a fromGuest action");
    assert.equal(bypass(altGr("q")), false, "AltGr+Q types @ on a German layout");
  });
});

// ── desktop.tab.jump (Ctrl+1..9, R7) ─────────────────────────────────────────
//
// The action is registered with nine digit chords; app-live.jsx derives N
// from the pressed event's key. These pin the registry rows and the two
// dispatch-level guards the handler relies on: `allowedInInput` (the chord
// fires from inside a text field — ctrl+ carries a command, it is not
// typing) and `guestShouldBypass` (the chord does NOT leave the terminal's
// xterm or the browser panel's page, matching plain ctrl+t/ctrl+w's rule).

check("tab jump: the action is registered under Tabs with exactly the nine digit chords", () => {
  const action = K.KEYMAP_ACTIONS.find(a => a.id === "desktop.tab.jump");
  assert.ok(action, "desktop.tab.jump missing from KEYMAP_ACTIONS");
  assert.equal(action.group, "Tabs");
  assert.equal(action.scope, "global");
  assert.equal(action.fromGuest, undefined, "a plain ctrl+digit chord stays the guest's");
  assert.deepEqual(action.defaultKeys, [
    "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5",
    "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
  ]);
});

check("tab jump: ctrl+digit events resolve to the action (chordFromEvent + lookup)", () => {
  for (const digit of "123456789") {
    const chord = K.chordFromEvent({ key: digit, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false });
    assert.equal(chord, `ctrl+${digit}`);
    assert.equal(K.lookup(chord), "desktop.tab.jump", `ctrl+${digit}`);
  }
  // Nothing beyond 9 is bound.
  assert.equal(K.lookup("ctrl+0"), null);
});

check("tab jump: a chordFromEvent shift+1 is ctrl+shift+1, which is not the jump chord", () => {
  // Shift+1 produces "!" on most layouts; the non-alpha branch clears shift
  // so the chord is "ctrl+!". Either way it must not resolve to the action.
  const shifted = K.chordFromEvent({ key: "!", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false });
  assert.notEqual(shifted, null);
  assert.notEqual(K.lookup(shifted), "desktop.tab.jump");
});

check("tab jump: every chord is allowed in a typing target (allowedInInput)", () => {
  for (const k of K.keysFor("desktop.tab.jump")) {
    assert.equal(K.allowedInInput(k), true, k);
  }
});

check("tab jump: an IME-composing ctrl+digit never fires", () => {
  const e = { key: "3", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: true };
  assert.equal(K.chordFromEvent(e), null);
});

check("tab jump: a composing dispatch guard runs the dispatcher's own order", () => {
  // The dispatcher (use-keymap.jsx) bails before the handler when the target
  // is a typing target and the chord is not allowedInInput. Mirror it, so a
  // regression in either predicate fails here, not in a user's textarea.
  const dispatches = (e) => {
    const chord = K.chordFromEvent(e);
    if (!chord) return false;
    const id = K.lookup(chord);
    if (!id) return false;
    if (e.target && K.isTypingTarget(e.target) && !K.allowedInInput(chord)) return false;
    return true;
  };
  const ctrl5 = { key: "5", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false };
  assert.equal(dispatches(ctrl5), true, "anywhere");
  assert.equal(dispatches({ ...ctrl5, target: { tagName: "TEXTAREA" } }), true, "in the composer's textarea");
  assert.equal(dispatches({ ...ctrl5, target: { tagName: "INPUT" } }), true, "in an input");
  assert.equal(dispatches({ ...ctrl5, isComposing: true }), false, "while composing");
});

check("tab jump: the chords stay the guest's in xterm and the browser panel", () => {
  for (const isMac of [LINUX, MAC]) {
    for (const digit of ["1", "5", "9"]) {
      assert.equal(bypass(ev(digit, "c"), isMac), false, `ctrl+${digit} isMac=${isMac} — plain ctrl chords belong to the guest`);
    }
  }
});

check("tab jump: rebinding the block moves all nine chords together", () => {
  withBindings({ "desktop.tab.jump": ["super+1", "super+2"] }, () => {
    assert.equal(K.lookup("super+1"), "desktop.tab.jump");
    assert.equal(K.lookup("super+2"), "desktop.tab.jump");
    assert.equal(K.lookup("ctrl+1"), null, "the old default chord is unbound");
    // super+ chords do bypass a guest, so a rebound block still works in xterm.
    assert.equal(bypass(ev("1", "m"), LINUX), true);
  });
  // Restored by withBindings' finally.
  assert.equal(K.lookup("ctrl+1"), "desktop.tab.jump");
});

check("tab jump: unbinding the action frees all nine chords", () => {
  withBindings({ "desktop.tab.jump": [] }, () => {
    for (const digit of "123456789") assert.equal(K.lookup(`ctrl+${digit}`), null);
    assert.equal(bypass(ev("1", "c"), LINUX), false);
  });
});

check("registry: tab jump's default chords collide with nothing else in the default set", () => {
  // Redundant with the global no-duplicate check above, but names the new
  // action explicitly: ctrl+1..9 were previously unclaimed.
  const others = K.KEYMAP_ACTIONS.filter(a => a.id !== "desktop.tab.jump");
  const claimed = new Set(others.flatMap(a => a.defaultKeys));
  for (const chord of K.KEYMAP_ACTIONS.find(a => a.id === "desktop.tab.jump").defaultKeys) {
    assert.equal(claimed.has(chord), false, `${chord} already claimed`);
  }
});

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`keymap: ${passed} checks passed`);
