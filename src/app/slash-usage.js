// Slash-command usage frequency — the `/` palette's "most used" ordering.
// `live.js` calls `record` when a command actually runs and `topThree` when it
// renders the palette's pinned rows. This module owns the localStorage shape
// and every transition as pure functions over a plain map, so the socket and
// React code stay out of the tests.
//
// Exposes `window.OMP_SLASH_USAGE`; wrapped as an IIFE per the project rule
// for plain <script> tags (see AGENTS.md "IIFE rule").
//
// Map shape: `{ "<name>": { count: <int>, last: <ms epoch> } }`, persisted as
// JSON under `KEY`. `load` never throws (absent key, corrupt JSON, non-object
// JSON and a hostile storage all read as `{}`); `save` swallows quota and
// private-mode errors. `record` returns a NEW map and never mutates its input,
// so a caller can hand in the currently rendered value and diff afterwards.
// The map is capped at `CAP` names, evicting the least recently used (`last`)
// first — a long-lived install cannot grow the key without bound.
//
// `topThree` ranks by count descending, then by recency, and drops names the
// caller does not offer right now (`available` is the palette's current list;
// `null`/`undefined` means "everything is available", the no-filter case).
(function () {
  const KEY = "omp-desktop.slash-usage";
  const CAP = 50;
  const TOP = 3;

  /** The page's storage, or null when the environment has none / denies it
   *  (accessing `localStorage` itself can throw under blocked cookies). */
  function _storage() {
    try {
      return window.localStorage || null;
    } catch {
      return null;
    }
  }

  const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);

  /** One sanitized `{count, last}` pair, or null when the entry is junk. */
  function _entry(value) {
    if (!isMap(value)) return null;
    const count = Number.isFinite(value.count) ? Math.max(0, Math.floor(value.count)) : 0;
    const last = Number.isFinite(value.last) ? value.last : 0;
    return { count, last };
  }

  /** A copy of the whole map with junk entries dropped — the shared start of
   *  every transition, and what keeps a hand-edited key from breaking them. */
  function _clean(map) {
    const out = {};
    if (!isMap(map)) return out;
    for (const name of Object.keys(map)) {
      const entry = _entry(map[name]);
      if (entry) out[name] = entry;
    }
    return out;
  }

  /** Read the persisted map; `{}` for anything that is not the documented
   *  shape (missing key, corrupt JSON, `[]`, `null`, `"5"`, no storage). */
  function load() {
    const storage = _storage();
    if (!storage) return {};
    let raw;
    try {
      raw = storage.getItem(KEY);
    } catch {
      return {};
    }
    if (typeof raw !== "string" || raw === "") return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    return isMap(parsed) ? _clean(parsed) : {};
  }

  /** Persist the map. Quota and absent-storage failures are ignored: usage
   *  ranking is a convenience, never a reason to break the palette. */
  function save(map) {
    const storage = _storage();
    if (!storage) return;
    try {
      storage.setItem(KEY, JSON.stringify(_clean(map)));
    } catch {
      /* quota exceeded / private mode */
    }
  }

  /** Drop the oldest `last` entries past CAP. Ties break on count, then name,
   *  so the outcome is deterministic for equal timestamps. */
  function _cap(map) {
    const names = Object.keys(map);
    if (names.length <= CAP) return map;
    const evict = names
      .sort((a, b) => map[a].last - map[b].last || map[a].count - map[b].count || a.localeCompare(b))
      .slice(0, names.length - CAP);
    for (const name of evict) delete map[name];
    return map;
  }

  /** Count one use of `name`. Returns a NEW map; the input is untouched even
   *  when it is returned-near-identical (an ignored call still copies). */
  function record(map, name) {
    const next = _clean(map);
    if (typeof name !== "string" || name === "") return next;
    const prev = next[name] || { count: 0, last: 0 };
    next[name] = { count: prev.count + 1, last: Date.now() };
    return _cap(next);
  }

  /** The up-to-TOP most used names: count desc, then `last` desc. Names are
   *  filtered to `available` when that is an array; a non-array (null,
   *  undefined) filters nothing. The input map is never modified. */
  function topThree(map, available) {
    const clean = _clean(map);
    const filter = Array.isArray(available) ? new Set(available) : null;
    return Object.keys(clean)
      .filter((name) => !filter || filter.has(name))
      .sort((a, b) => clean[b].count - clean[a].count || clean[b].last - clean[a].last || a.localeCompare(b))
      .slice(0, TOP);
  }

  window.OMP_SLASH_USAGE = Object.freeze({ KEY, load, save, record, topThree });
})();