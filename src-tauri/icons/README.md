# OMP Desktop — Application Icon

The icon's source of truth is **`icon-source.svg`** (hand-authored, 1024×1024 grid).
Everything else in this directory is generated from it — never edit the PNGs/ico/icns by hand.

## Design notes

- **Mark: the pulse line.** A bold white throughput pulse — the live sparkline
  of an agent at work — running left to right across a deep blue-black squircle
  and ending in the orange **cursor dot** (`#ff8a4c`, the app's accent). The line
  is a single polyline (stroke 96/1024, round caps and joins), tuned to stay
  readable at 16px.
- **Squircle** (Apple superellipse) container with the deep blue-black gradient,
  the warm orange glow climbing from the bottom-right, and a faint top
  highlight. Corners outside the squircle are transparent.
- Chosen from a seven-direction exploration board (`design/logo/`, gitignored):
  it beat a monospace π, a block-cursor, a swarm cluster, an `omp` lettermark, a
  neon π and a pixel-art π on small-size legibility + container consistency.

## Regenerating all assets

```bash
# 1. Rasterise the SVG to a 1024×1024 PNG with transparent corners
#    (Chrome headless; wrap the SVG in a full-viewport <img>):
chrome --headless --disable-gpu --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot=master.png wrap.html

# 2. Tauri's icon pipeline (ico/icns/PNG ladder/Store tiles/Android/iOS):
npx @tauri-apps/cli icon master.png -o src-tauri/icons

# 3. Two committed files are NOT produced by the CLI — regenerate from the same
#    master with a plain LANCZOS downscale:
#    16x16.png (external/favicon use) and 512x512.png (stores and docs)
```

`tauri.conf.json` references only `32x32.png`, `128x128.png`, `128x128@2x.png`,
`icon.icns` and `icon.ico`.

**Rebuild trap:** cargo does not re-embed a changed `icon.ico` on its own —
tauri-build's resource compiler caches on the generated `.rc` file's text (which
holds the icon's *path*, not its bytes), so the stale icon survives full
rebuilds and even `cargo clean -p omp-desktop`. After changing the icon, force
the resource to recompile before `npm run build`:

```bash
rm -rf src-tauri/target/release/build/omp-desktop-* && touch src-tauri/build.rs
```

Verify the embedded result before shipping — extract the exe's icon and eyeball it:

```powershell
powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; \
  [System.Drawing.Icon]::ExtractAssociatedIcon('src-tauri\target\release\omp-desktop.exe')\
  .ToBitmap().Save('exe-icon.png', [System.Drawing.Imaging.ImageFormat]::Png)"
```
