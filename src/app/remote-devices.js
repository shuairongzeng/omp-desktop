/* remote-devices.js — the phone's paired-desktop registry (pure logic).
 *
 * Multi-device remote control: one phone can be paired with several
 * desktops behind the same relay. Each pairing is one room credential
 * ({device, token}) plus the display info that room's desktop last
 * reported ({name, os}). This module owns the localStorage shape, the
 * migration from the single-pairing key, and every list transition — as
 * pure functions over a plain store object ({devices, selected}), so the
 * socket code that uses them (remote-hub.js picker, remote-transport.js
 * control connection) stays out of the tests. Load before both.
 *
 * R8 E2E (docs/architecture/remote-e2e-contract.md): each entry also
 * carries the pairing's master secret `ms` (b64, 32B) — the root of
 * every per-connection session key. An entry without `ms` predates the
 * E2E protocol and cannot participate: needsPairing() marks it for a
 * re-pair (the hub shows the state, transport refuses the connection).
 * There is no plaintext fallback — the contract makes the cutover hard.
 */
(function () {
  "use strict";

  const KEY = "omp-remote:devices";
  const LEGACY_KEY = "omp-remote:auth";
  const MAX_NAME = 80; // the relay's display-string cap

  const emptyStore = () => ({ devices: [], selected: null });

  const isEntry = (d) =>
    !!d &&
    typeof d.device === "string" && d.device !== "" &&
    typeof d.token === "string" && d.token !== "";

  /** Sanitize anything read from storage into the store shape: drop
   * invalid/duplicate entries, cap display strings, keep `selected` only
   * when it points at a surviving entry. */
  function normalize(raw) {
    const out = emptyStore();
    if (!raw || !Array.isArray(raw.devices)) return out;
    for (const d of raw.devices) {
      if (!isEntry(d) || out.devices.some((x) => x.device === d.device)) continue;
      out.devices.push({
        device: d.device,
        token: d.token,
        // The E2E master secret (b64). A non-string value (or absent)
        // drops the field — the entry reads as pre-E2E and needs re-pair.
        ms: typeof d.ms === "string" && d.ms !== "" ? d.ms : "",
        name: typeof d.name === "string" ? d.name.slice(0, MAX_NAME) : "",
        os: typeof d.os === "string" ? d.os.slice(0, MAX_NAME) : "",
        lastUsed: Number.isFinite(d.lastUsed) ? d.lastUsed : 0,
      });
    }
    if (typeof raw.selected === "string" && out.devices.some((d) => d.device === raw.selected)) {
      out.selected = raw.selected;
    }
    return out;
  }

  /** Read the store, migrating the pre-multi-device single-pairing key
   * (`omp-remote:auth`) in place so an already-paired phone keeps working
   * after the upgrade — its one desktop stays selected. */
  function load(storage) {
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || "null"); } catch { raw = null; }
    let store = normalize(raw);
    if (store.devices.length === 0) {
      let legacy = null;
      try { legacy = JSON.parse(storage.getItem(LEGACY_KEY) || "null"); } catch { legacy = null; }
      if (isEntry(legacy)) {
        store = normalize({ devices: [legacy], selected: legacy.device });
        save(storage, store);
        try { storage.removeItem(LEGACY_KEY); } catch { /* private mode: fine */ }
      }
    }
    return store;
  }

  function save(storage, store) {
    try { storage.setItem(KEY, JSON.stringify(store)); } catch { /* quota/private mode */ }
  }

  /** Add or refresh one desktop's pairing. A fresh pairing selects its
   * device (scanning a QR means "control this one"); a re-pair of a known
   * device swaps the token AND the ms (a re-pair mints a fresh master
   * secret) and keeps name/os and the current selection. */
  function upsert(store, device, token, ms) {
    const out = { ...store, devices: store.devices.slice() };
    const clean = typeof ms === "string" && ms !== "" ? ms : "";
    const i = out.devices.findIndex((d) => d.device === device);
    if (i >= 0) {
      out.devices[i] = { ...out.devices[i], token, ms: clean };
    } else {
      out.devices.push({ device, token, ms: clean, name: "", os: "", lastUsed: 0 });
      out.selected = device;
    }
    if (!out.selected || !out.devices.some((d) => d.device === out.selected)) {
      out.selected = device;
    }
    return out;
  }

  function select(store, device) {
    if (!store.devices.some((d) => d.device === device)) return store;
    return { ...store, selected: device };
  }

  /** Forget one pairing locally: the desktop keeps its phone-token hash
   * until revoked there — this only drops the phone's copy. A forgotten
   * selection falls back to the first remaining device (or none → the
   * picker/pairing flow owns the screen again). */
  function forget(store, device) {
    const devices = store.devices.filter((d) => d.device !== device);
    const selected =
      store.selected === device ? (devices.length ? devices[0].device : null) : store.selected;
    return { devices, selected };
  }

  /** Fold a relay `device` frame ({name, os}) into one entry. Blank fields
   * never clobber a stored name. */
  function setInfo(store, device, info) {
    const i = store.devices.findIndex((d) => d.device === device);
    if (i < 0) return store;
    const out = { ...store, devices: store.devices.slice() };
    const e = { ...out.devices[i] };
    if (typeof info?.name === "string" && info.name.trim()) e.name = info.name.slice(0, MAX_NAME);
    if (typeof info?.os === "string" && info.os.trim()) e.os = info.os.slice(0, MAX_NAME);
    out.devices[i] = e;
    return out;
  }

  function touch(store, device, now) {
    const i = store.devices.findIndex((d) => d.device === device);
    if (i < 0) return store;
    const out = { ...store, devices: store.devices.slice() };
    out.devices[i] = { ...out.devices[i], lastUsed: Number.isFinite(now) ? now : 0 };
    return out;
  }

  const selectedEntry = (store) =>
    store.devices.find((d) => d.device === store.selected) || null;

  /** Row label: the desktop's reported name, else a short id-based tag. */
  const displayName = (entry) =>
    entry && entry.name ? entry.name : `桌面 ${(entry?.device || "").slice(0, 8)}`;

  const OS_LABELS = { windows: "Windows", macos: "macOS", linux: "Linux" };
  const osLabel = (os) => OS_LABELS[os] || os || "";

  /** True when the entry carries no E2E master secret — a pre-R8
   *  pairing. It cannot join an E2E room; the hub flags the row and the
   *  transport refuses to dial it (the user re-scans the QR). */
  const needsPairing = (entry) => !entry || typeof entry.ms !== "string" || entry.ms === "";

  window.OMP_REMOTE_DEVICES = {
    KEY, LEGACY_KEY,
    emptyStore, normalize, load, save,
    upsert, select, forget, setInfo, touch,
    selectedEntry, displayName, osLabel, needsPairing,
  };
})();
