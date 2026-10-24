# smoke suite — CDP against the real release exe

`tests/smoke/run.mjs` launches the built exe, drives the actual UI over the
Chrome DevTools Protocol and asserts the app boots, its surfaces open and
close, render faults stay contained, and modal churn does not leak the heap.

## prerequisites

- a built exe: `src-tauri/target/release/omp-desktop.exe` (or pass
  `--exe <path>`), not compressed — class names must survive (the fault step
  identifies boundaries by `instance.constructor.name`)
- **no other omp-desktop instance running**: the single-instance plugin
  forwards a second launch's argv to the first instance and exits, so the
  suite would drive nothing (check `tasklist`; `taskkill /IM omp-desktop.exe
  /T /F` if needed)
- open tabs get restored and then *spawned* — each restored tab is a real
  omp process; heavy saved transcripts make the run slower but not less
  valid. **At least one restorable tab is required**: the composer (and with
  it the bridge button) and the git-browser button only render with an
  active project tab; an empty tab store makes the UI steps fail with
  "button not found". The suite backs the store up and restores it
  byte-identical, but never seeds one — seed
  `%APPDATA%/<identifier>/open-tabs.json` yourself first if it is empty.
- clicks and fiber probes retry (up to ~5 s each): while tab restore spawns
  omp processes, React sits between two commits of a heavy transition and a
  synthetic click can land on a stale fiber — retrying separates that
  window from a real regression

## usage

```
node tests/smoke/run.mjs                                  # default exe path
node tests/smoke/run.mjs --exe <path-to-exe>              # explicit exe
node tests/smoke/run.mjs --skip-fault                     # green run on old builds
```

exit 0 = every step passed; exit 1 = any FAIL. `%APPDATA%/<identifier>/
open-tabs.json` is backed up before launch and restored in a `finally` —
the run leaves the tab layout byte-identical to how it found it.

## steps

| step | what it proves |
|---|---|
| `boot/cdp-connect` | the exe launches, WebView2 accepts the debug port, the tauri.localhost page target answers |
| `boot/timing` | the startup budget: spawn → root / composer / bridge in ms, hard assert composer < 8000 ms, WARN over 6500 ms (see below) |
| `boot/no-recorded-errors` | `window.OMP_ERRORS` ring is empty once the app boots — the only sentinel for module-eval failures (a missing top-level global kills a script before React exists, so no boundary can catch it) |
| `ui/settings-open-close` | status-bar settings button → `.settings` visible → tab close works |
| `ui/command-bridge-open-close` | composer bridge button → `.bridge[aria-label="command bridge"]` → Escape through the real esc stack |
| `ui/git-browser-open-close` | status-bar git button → `.gitb` dialog → Escape (needs an active project tab) |
| `fault/panel-boundary` | `setState({error})` on a `PanelBoundary` instance → `.panel-crash`, `#root` stays populated, cleared again |
| `fault/app-boundary` | same on `AppBoundary` → `.app-crash`, `Page.reload` restores the tree |
| `durability/heap` | `Performance.getMetrics` JSHeapUsedSize before/after 20× settings + 20× bridge + 5× tab churn |
| `console/clean` | zero error-level `Runtime.consoleAPICalled` / `exceptionThrown` / `Log.entryAdded` over the whole run |

steps print `[smoke] PASS/FAIL <name> <detail>`; any FAIL exits 1. If the
exe predates the boundaries (no `PanelBoundary`/`AppBoundary` in the react
tree) the two fault steps FAIL with "exe lacks boundaries" — that is the
documented verdict for an old build, not a suite bug; `--skip-fault` omits
them.

## startup budget (boot/timing)

every phase is measured from `cdp.t0` — the `Date.now()` right before the
spawn call in `cdp.mjs`. Node and the webview share the wall clock, so the
deltas are honest wall time:

- **spawn → root rendered** — `#root` has children (React committed)
- **spawn → composer** — `.composer-input textarea, .composer textarea`
  exists: an active tab's UI is usable
- **spawn → bridge connected** — `window.OMP_BRIDGE?.isConnected === true`

the step prints a `[smoke] timing` table, then:

- **hard assert: composer < 8000 ms** — the budget. the integrator's
  hot-machine baseline is 5161 ms; 8000 leaves headroom for a cold file
  cache, a first-boot WebView2 profile and heavier saved transcripts
  without flaking
- **WARN at > 6500 ms** — inside the assert but drifting from baseline;
  regressions should surface here first, as a signal before they become
  failures

the numbers are **upper bounds**: `cdp.waitExpr` polls at 200 ms and each
probe is an IPC round-trip, so the printed value can sit up to ~200 ms
past the true moment. watch trends across runs, not single milliseconds.

baseline (release exe @270ce01, same machine, hot cache; the integrator's
colder baseline in parentheses):

| phase | this machine | integrator baseline |
|---|---|---|
| spawn → root | 1336–2441 ms | 4922 ms |
| spawn → composer | 1564–2718 ms | 5161 ms |
| spawn → bridge | 1571–2729 ms | 5379 ms |

what sits between DCL and the first React commit (and where the startup
wall actually goes) is broken down in `startup-notes.md`, produced with
`tests/smoke/startup-probe.mjs`.

## console whitelist

entries are whitelisted only with a reason:

- **single-instance forward** — the plugin's duplicate-launch log. Test
  environment noise (another instance was up), not an app defect.

nothing else is whitelisted; anything new that appears is a real regression
and fails `console/clean`.

## reading the heap numbers

the durability table is `JSHeapUsedSize` (bytes → MB shown):

- **baseline** — right after boot + UI walk
- **after** — 20 settings open/close + 20 command-bridge open/close + 5×
  `openSession(path)`/`closeSession(id)` (a real tab lifecycle: each cycle
  spawns an omp process and tears it down; the folder dialog is unusable
  from CDP, so the path comes from the bridge snapshot)
- **delta** — the growth; the step fails at ≥ 15 MB

a small positive delta is normal (the collector has not settled, restored
transcripts stream in); a monotone climb across runs is the leak signature
this step exists to catch. compare the delta, not the absolutes.
