// Accent colour tokens: the `accent` tweak as the five CSS custom
// properties the themes define (styles.css): `--accent`, `--accent-soft`
// (12% alpha: focus rings, xterm selection), `--accent-glow` (45%),
// `--accent-deep` (darker) and `--accent-fg` (the text colour on the
// accent: near-black or white by its relative luminance). The derived
// values are plain rgba()/hex, not color-mix(): xterm reads
// `--accent-soft` through getPropertyValue, which returns a custom
// property's text uncomputed.
//
// Exposes `window.OMP_ACCENT`; an IIFE (AGENTS.md "IIFE rule").
// app/use-bridge-snapshot.jsx (useThemeEffect) looks it up at call time.
(function () {
  const SOFT_ALPHA = 0.12;
  const GLOW_ALPHA = 0.45;
  // Share of black mixed into `--accent-deep`.
  const DEEP_SHADE = 0.25;
  // `--accent-fg` picks its pole from the accent's WCAG relative
  // luminance. 0.2 is the crossover where the two poles contrast equally
  // (≈4.4:1 each); every theme's own text-on-accent pairing and every
  // settings swatch lands on the side its hand-tuned colour already uses.
  const FG_LUM_MIN = 0.2;
  const FG_DARK = "#101018";
  const FG_LIGHT = "#ffffff";

  /** `#rgb` / `#rrggbb` → [r, g, b], null for anything else. */
  function parseHex(color) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? "").trim());
    if (!m) return null;
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  }

  const toHex = rgb => `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;

  /** WCAG relative luminance (0–1) of an [r, g, b] triple. */
  function luminance([r, g, b]) {
    const lin = v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /** The five tokens for a hex accent, keyed by property name; null when
   *  `color` is not a hex colour (the caller leaves the theme's own). */
  function accentTokens(color) {
    const rgb = parseHex(color);
    if (!rgb) return null;
    const [r, g, b] = rgb;
    return {
      "--accent": toHex(rgb),
      "--accent-soft": `rgba(${r}, ${g}, ${b}, ${SOFT_ALPHA})`,
      "--accent-glow": `rgba(${r}, ${g}, ${b}, ${GLOW_ALPHA})`,
      "--accent-deep": toHex(rgb.map(v => Math.round(v * (1 - DEEP_SHADE)))),
      "--accent-fg": luminance(rgb) >= FG_LUM_MIN ? FG_DARK : FG_LIGHT,
    };
  }

  /** True when `a` and `b` name the same hex colour (`#ABC` = `#aabbcc`). */
  function sameColor(a, b) {
    const x = parseHex(a);
    const y = parseHex(b);
    return !!x && !!y && x.every((v, i) => v === y[i]);
  }

  const TOKEN_NAMES = ["--accent", "--accent-soft", "--accent-glow", "--accent-deep", "--accent-fg"];

  window.OMP_ACCENT = { TOKEN_NAMES, accentTokens, sameColor };
})();
