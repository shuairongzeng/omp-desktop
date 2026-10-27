# Electron migration assessment (2026-10-27)

Decision-grade evaluation of moving omp-desktop from Tauri 2 to Electron.
All counts are reproducible with the audit commands in §6; all runtime
numbers were measured on this machine (darwin arm64, macOS 26) by two
identical hello-world spikes (`/tmp/electron-spike`, `/tmp/tauri-spike`;
results in `/tmp/electron-spike-result.json`, `/tmp/tauri-spike-result.json`,
raw timings in each spike's `spike.log`).

## 1. What would have to move

| Asset | Size | Portable to Electron? |
|---|---|---|
| Rust backend (`src-tauri/src`) | 55,160 LOC | Not as-is. Route A rewrites it in Node; Route B keeps it as a sidecar process |
| `#[tauri::command]` fns | 99 | Each becomes an IPC handler in the chosen backend |
| Distinct invoke command names called from JS | 92 | Contract surface; names can stay, transport changes |
| Distinct event names (`agent://…`, `terminal://…`, `browser://…`, …) | 15 emitted Rust-side, 9 subscribed JS-side | Electron `webContents.send` covers them; the phone relay's evt channel is JS-level and unaffected |
| Binary `ipc::Channel` (screencast frames) | 2 Rust sites / 2 JS sites | Electron has no Channel type; needs a dedicated stream (MessagePort or raw socket) |
| `unsafe` blocks (job objects, ConPTY, CDP pipe hand-over, peer-user SID) | 33 | Route A: reimplement in a Node native addon (node-gyp/N-API) — the hard part of the security model survives either way; Route B: untouched |
| Frontend `window.__TAURI__` call sites | 93 | A thin shim can map them to a preload bridge in both routes |
| Rust tests | 1,050 passing | Route A discards them; Route B keeps every one |
| JS regression suites | 67 | Unaffected by either route (pure modules) |
| Cargo dependencies | 22 direct (gix, portable-pty, ring, rustls, tokio…) | Route A loses all of them; Route B keeps all |

## 2. Runtime measurements (spikes, this machine)

| Metric | Tauri spike (2.12.5) | Electron spike (45.0.0) | Production Tauri app |
|---|---|---|---|
| Install size (runtime payload) | 9.5 MB binary | **258 MB** (`electron/dist`) | 16 MB app bundle |
| Cold start (process → first IPC) | 378 ms | 302 ms | ~2 s (dominated by omp spawn, not the shell) |
| IPC round-trip avg (1000 calls) | 0.148 ms | **0.044 ms** | n/a |
| IPC round-trip p95 | 0.185 ms (native-side) | 0.1 ms (100 µs clock floor; batched refinement 0.05) | n/a |
| Resident set (app + renderer/GPU/net helpers) | 192.8 MB (1 app process + 3 WebKit XPC helpers) | **380.1 MB** (4 processes) | 135 MB shell + 2,149 MB in 4 omp children |

Both `rssTotalMb` figures sum the same structural set (the app process plus
its renderer/GPU/network helpers), so they compare directly. Electron's IPC
is ~3× faster per call; that advantage is invisible in this app, whose hot
paths are bulk frames (terminal pump, screencast) sized in KB–MB, where the
0.1 ms difference per call is noise against payload transfer. The production
row is the load-bearing one: the shell is 135 MB while the *omp children*
are 2.1 GB. Any framework swap changes the 135 MB line only.

Methodology caveats (from the spikes' own logs): WebKit's
`performance.now()` is 1 ms-quantized, so the Tauri mean is one wall span
over the whole loop and its p95 is native-side arrival deltas; Electron's
renderer clock is 100 µs-quantized, so its p95 sits on that floor. The means
remain directly comparable. Electron's RSS was sampled 3 s after window show
over the main process's ppid tree; the Tauri figure adds the WebKit XPC
helpers that appear within ms of launch.

## 3. Three routes

### A — Full port: Electron + Node backend
Rewrite 55k LOC of Rust (git reads via gix, PTY, CDP broker, E2E crypto,
widget scheduler, spawn gate) in Node/TypeScript plus a native addon for the
33 unsafe sites. Discards 1,050 Rust tests.
- Cost: **6–9 person-months**, high regression risk on the security model
  (handle inheritance, same-user CDP admission) which is exactly the code
  that is hardest to test.
- Gain: one language, Chromium-everywhere CSS, Electron's plugin ecosystem.
- Verdict: **not recommended** — the gains do not touch any measured pain.

### B — Electron shell + existing Rust as a sidecar
Electron main spawns the current Rust binary (compiled as a headless IPC
server over stdio/socket); the 99 commands become one multiplexed bridge.
- Cost: **3–5 person-weeks** (shell swap, preload bridge, updater re-sign,
  packaging, the Channel replacement).
- Gain: Chromium renderer everywhere (drops the WKWebView quirks:
  `color-mix(in oklab)`, container-query floors, WebKitGTK variance on Linux).
- Loss: +1 process, +~190 MB RSS per the spike delta (380 vs 193), a second
  update channel, and the Rust side still needs its own IPC framing — the
  hard 90% stays Rust.
- Verdict: only worth it **if** Linux WebKitGTK or renderer-parity is a real,
  user-felt pain. No such report exists in this project's history.

### C — Stay on Tauri, fix pains individually (recommended)
Every pain found so far had a Tauri-local fix (the optimization log's R1–R4,
the phone projection work, the cert TOFU). Continue that.
- Cost: zero migration; each fix priced on its own.
- Verdict: **recommended** unless a specific pain from §4 is confirmed.

## 4. Tauri's real weaknesses in this project (and their local fixes)

1. **Linux WebKitGTK variance** — the only platform where the renderer is
   not Chromium. Local fix: none cheap; this is the one argument for B.
   No Linux user report exists for this project.
2. **No built-in per-route code splitting** — a bundler-less dev model by
   choice; the optimization log's R1 esbuild merge already cut first paint
   57%. Local fix: continue in `build-frontend.mjs` (backlog: Service Worker,
   ESM lazy load).
3. **Updater signing chain is Tauri-specific** — rotating keys strands
   installs; Electron's electron-updater has the same property. Not a
   migration argument.
4. **Install size** — Tauri's 9.5–16 MB vs Electron's 258 MB runtime is a
   Tauri *advantage*; it appears here only to show the trade direction.

## 5. Recommendation

**Route C.** The measured case for Electron is a renderer-parity bet with no
user-felt pain behind it, priced at 3–5 weeks (B) or 6–9 months (A), against
a shell that is 135 MB of a 2.3 GB working set, in exchange for +190 MB RSS
and +242 MB install. Re-open this assessment only if a Linux/WebKitGTK or
renderer-parity pain is reported; then Route B is the only sane migration
and §1's table is its work breakdown.

## 6. Reproducible audit commands

```sh
find src-tauri/src -name '*.rs' | xargs wc -l | tail -1            # Rust LOC
grep -rc '#\[tauri::command\]' src-tauri/src | awk -F: '{s+=$2} END{print s}'
grep -rhoE '"(agent|terminal|browser|git|widgets|app|remote|omp)://[^"]*"' src-tauri/src | sort -u | wc -l
grep -rc '__TAURI__' src | awk -F: '{s+=$2} END{print s}'
grep -rc 'unsafe' src-tauri/src | awk -F: '{s+=$2} END{print s}'
ps -ax -o rss=,args | grep '[O]MP Desktop.app/Contents/MacOS/omp-desktop' | awk '{s+=$1} END{print s/1024}'
```
