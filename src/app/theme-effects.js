// app/theme-effects.js — theme registry + pure helpers for the appearance
// tweaks (text brightness, background image, frosted glass). Plain IIFE so
// use-bridge-snapshot.jsx (and the demo app.jsx) can destructure at top
// level; tests load it with new Function + a stubbed window.

(function () {

// Every theme has a `.theme-<name>` block in styles.css and a default
// accent the Look section applies when the theme is picked.
const THEMES = ["aurora", "phosphor", "daylight", "nordic", "solarized", "sakura", "midnight"];
const THEME_ACCENTS = {
  aurora: "#8AF0C8",
  phosphor: "#C4FF3F",
  daylight: "#1F8A5B",
  nordic: "#88C0D0",
  solarized: "#B58900",
  sakura: "#D6336C",
  midnight: "#7C6CFA",
};

// The fg ladder a text-brightness tweak shifts, strongest rung first.
const FG_VARS = ["--fg", "--fg-2", "--fg-3", "--fg-4", "--fg-5"];

// textBrightness n in [-20, 20]: positive pushes the ladder toward the
// scheme's contrast pole (white on dark themes, black on light ones),
// negative washes it toward the window background. Returns the CSS value
// to set, or null for "no override" (n = 0). `base` is the theme's own
// value for the variable, read after the theme class is applied and any
// previous override removed.
function fgOverrideCss(base, n, lightScheme) {
  if (!n) return null;
  const pct = 100 - Math.abs(n);
  const toward = n > 0 ? (lightScheme ? "black" : "white") : "var(--bg-window)";
  return `color-mix(in oklab, ${base} ${pct}%, ${toward})`;
}

// atob + Blob for the background-image tweak: the tweak stores a path, the
// bytes come from Rust's read_file_bytes, and the CSS variable takes a
// blob: URL (allowed by the img-src CSP, unlike file: or asset:).
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

Object.assign(window, {
  OMP_THEME: { THEMES, THEME_ACCENTS, FG_VARS, fgOverrideCss, base64ToBlob },
});
})();
