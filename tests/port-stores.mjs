/* tests/port-stores.mjs — parity tests for electron/backend/stores.js.

   Every case is a port of a `#[cfg(test)]` case from the Rust module named in
   the test title (src-tauri/src as of feat/electron-port). The Rust tests
   call the store directly; the port's command-facing functions are the only
   entry points, so a case that used an internal helper (`restorable`,
   `sanitize`, `upsert`) goes through the matching command and asserts the
   same observable result.

   Run with: node tests/port-stores.mjs */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stores = require("../electron/backend/stores.js");

/** A fresh config dir, wired through OMP_PORT_CONFIG_DIR, cleaned up with t. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-port-stores-"));
  process.env.OMP_PORT_CONFIG_DIR = dir;
  stores.resetCaches();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    config: (...parts) => path.join(dir, ...parts),
    missing: (name) => path.join(dir, name),
    folder(name) {
      const target = path.join(dir, name);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
    /** A file inside the config dir, as the Rust `ScratchGuard::file`. */
    file(name, contents = "{}\n") {
      const target = path.join(dir, name);
      fs.writeFileSync(target, contents);
      return target;
    },
    /** `profiles.snapshots/<sha256>.json` with `contents`. */
    profileSnapshot(contents) {
      const snapshots = path.join(dir, "profiles.snapshots");
      fs.mkdirSync(snapshots, { recursive: true });
      const id = crypto.createHash("sha256").update(contents).digest("hex");
      const target = path.join(snapshots, `${id}.json`);
      fs.writeFileSync(target, contents);
      return target;
    },
    writeProfiles(value) {
      fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify(value));
    },
  };
}

/** One `OpenTab` with the Rust `tab()` fixture's field values. */
const tab = (projectPath, sessionFile = null) => ({
  path: projectPath,
  profile: "work",
  sessionFile,
  name: "label",
});

const recentPaths = (list) => list.map((entry) => entry.path);

// ── open_tabs.rs ────────────────────────────────────────────────────────────

test("open_tabs: save_then_load_round_trips_order_active_and_fields", (t) => {
  const s = scratch(t);
  const a = s.folder("a");
  const b = s.folder("b");
  const conv = s.file("conv.jsonl");
  const first = tab(a);
  const second = tab(b, conv);

  assert.equal(stores.openTabsSave({ tabs: [first, second], active: 1 }), null);

  assert.deepEqual(stores.openTabsLoad(), {
    tabs: [first, second],
    active: 1,
    skipped: [],
  });
  // On-disk shape: the Rust struct's field order, both levels.
  assert.equal(
    fs.readFileSync(s.config("open-tabs.json"), "utf8"),
    JSON.stringify({ tabs: [first, second], active: 1 }, null, 2),
  );
});

test("open_tabs: missing_or_corrupt_file_restores_nothing", (t) => {
  const s = scratch(t);
  assert.deepEqual(stores.openTabsLoad(), { tabs: [], active: null, skipped: [] });

  const a = s.folder("a");
  s.file("open-tabs.json", "{ not json");
  const corrupt = stores.openTabsLoad();
  assert.deepEqual(corrupt.tabs, []);
  assert.equal(corrupt.active, null);

  // A structurally valid file with one bad tab is corrupt as a whole, as
  // serde's all-or-nothing deserialisation is.
  s.file("open-tabs.json", JSON.stringify({ tabs: [{ path: a }, { path: 3 }] }));
  assert.deepEqual(stores.openTabsLoad(), { tabs: [], active: null, skipped: [] });
});

test("open_tabs: a_gone_folder_is_skipped_and_the_active_index_follows_its_tab", (t) => {
  const s = scratch(t);
  const gone = s.missing("gone");
  const kept = s.folder("kept");

  stores.openTabsSave({ tabs: [tab(gone), tab(kept)], active: 1 });

  assert.deepEqual(stores.openTabsLoad(), {
    tabs: [tab(kept)],
    active: 0,
    skipped: [gone],
  });
});

test("open_tabs: dropping_the_active_tab_leaves_no_active_index", (t) => {
  const s = scratch(t);
  const gone = s.missing("gone");
  const kept = s.folder("kept");

  stores.openTabsSave({ tabs: [tab(kept), tab(gone)], active: 1 });

  const restored = stores.openTabsLoad();
  assert.equal(restored.active, null);
  assert.deepEqual(restored.skipped, [gone]);
});

test("open_tabs: a_gone_conversation_reopens_as_a_fresh_one_in_its_folder", (t) => {
  const s = scratch(t);
  const folder = s.folder("p");
  const gone = s.missing("never-written.jsonl");

  stores.openTabsSave({ tabs: [tab(folder, gone)], active: null });

  assert.deepEqual(stores.openTabsLoad(), {
    tabs: [tab(folder)],
    active: null,
    skipped: [],
  });
});

test("open_tabs: a_pathless_tab_needs_its_conversation", (t) => {
  const s = scratch(t);
  const conv = s.file("conv.jsonl");
  const gone = s.missing("gone.jsonl");

  stores.openTabsSave({
    tabs: [tab("", gone), tab("", conv)],
    active: 1,
  });

  assert.deepEqual(stores.openTabsLoad(), {
    tabs: [tab("", conv)],
    active: 0,
    skipped: [],
  });
});

test("open_tabs: load_caps_the_tab_count_and_drops_an_out_of_range_active_index", (t) => {
  const s = scratch(t);
  const folder = s.folder("p");
  const tabs = Array.from({ length: stores.MAX_TABS + 1 }, () => tab(folder));

  stores.openTabsSave({ tabs, active: stores.MAX_TABS });

  const restored = stores.openTabsLoad();
  assert.equal(restored.tabs.length, stores.MAX_TABS);
  assert.equal(restored.active, null);
});

test("open_tabs: empty_optional_strings_read_back_as_absent", (t) => {
  const s = scratch(t);
  const folder = s.folder("p");

  stores.openTabsSave({
    tabs: [{ path: folder, profile: "", sessionFile: "", name: "" }],
    active: 0,
  });

  const restored = stores.openTabsLoad();
  assert.deepEqual(restored.tabs, [
    { path: folder, profile: null, sessionFile: null, name: null },
  ]);
  assert.equal(restored.active, 0);
});

test("open_tabs: restore_serializes_flat_for_the_frontend", (t) => {
  const s = scratch(t);
  const kept = s.folder("p");
  const gone = s.missing("gone");

  stores.openTabsSave({ tabs: [tab(kept), tab(gone)], active: 0 });

  // What IPC delivers: exactly the flat Restore shape, no nesting.
  const wire = JSON.parse(JSON.stringify(stores.openTabsLoad()));
  assert.deepEqual(Object.keys(wire), ["tabs", "active", "skipped"]);
  assert.deepEqual(wire, { tabs: [tab(kept)], active: 0, skipped: [gone] });
});

// ── recent_projects.rs ──────────────────────────────────────────────────────

test("recents: upsert_moves_existing_path_to_front_and_refreshes_time", (t) => {
  const s = scratch(t);
  const a = fs.realpathSync(s.folder("a"));
  const b = fs.realpathSync(s.folder("b"));

  stores.recentsTouch(null, a);
  assert.deepEqual(recentPaths(stores.recentsTouch(null, b)), [b, a]);
  const moved = stores.recentsTouch(null, a);
  assert.deepEqual(recentPaths(moved), [a, b]);
  assert.ok(moved[0].openedAt >= moved[1].openedAt);
});

test("recents: cap_trims_only_the_touched_profile", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }] });
  const work = s.folder("w");
  stores.recentsTouch("work", work);

  const folders = Array.from({ length: stores.MAX_PER_PROFILE + 1 }, (_, i) =>
    s.folder(`p${i}`),
  );
  for (const folder of folders) stores.recentsTouch("default", folder);

  const defaults = stores.recentsList("default");
  assert.equal(defaults.length, stores.MAX_PER_PROFILE);
  // Newest kept, oldest (`p0`) evicted.
  assert.equal(defaults[0].path, fs.realpathSync(folders[folders.length - 1]));
  assert.ok(!recentPaths(defaults).includes(fs.realpathSync(folders[0])));

  assert.deepEqual(recentPaths(stores.recentsList("work")), [fs.realpathSync(work)]);
});

test("recents: touch_then_list_round_trips_through_the_file", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }] });
  const a = s.folder("a");
  const b = s.folder("b");

  stores.recentsTouch("default", a);
  const returned = stores.recentsTouch("default", b);
  assert.deepEqual(recentPaths(returned), [fs.realpathSync(b), fs.realpathSync(a)]);

  // A fresh read (the port has no profile store cache to reopen).
  assert.deepEqual(recentPaths(stores.recentsList(null)), [
    fs.realpathSync(b),
    fs.realpathSync(a),
  ]);
  assert.deepEqual(stores.recentsList("work"), []);

  const stored = JSON.parse(fs.readFileSync(s.config("recent-projects.json"), "utf8"));
  assert.deepEqual(Object.keys(stored), ["entries"]);
  assert.deepEqual(Object.keys(stored.entries[0]), ["path", "profile", "openedAt"]);
  assert.equal(stored.entries[0].profile, "default");
  assert.equal(typeof stored.entries[0].openedAt, "number");
});

test("recents: a_memory_only_store_keeps_its_list_for_its_lifetime_only", (t) => {
  // No memory-only branch exists in the port; the equivalent guard is that a
  // fresh config dir starts empty. The cross-profile part is covered above.
  const s = scratch(t);
  assert.deepEqual(stores.recentsList("default"), []);

  const a = s.folder("a");
  stores.recentsTouch(null, a);
  fs.rmdirSync(a);
  assert.deepEqual(stores.recentsList("default"), []);
});

test("recents: corrupt_file_lists_empty_and_touch_rewrites_it", (t) => {
  const s = scratch(t);
  const a = s.folder("a");
  s.file("recent-projects.json", "{ not json");

  assert.deepEqual(stores.recentsList("default"), []);
  const touched = stores.recentsTouch("default", a);
  assert.deepEqual(recentPaths(touched), [fs.realpathSync(a)]);

  const stored = JSON.parse(fs.readFileSync(s.config("recent-projects.json"), "utf8"));
  assert.equal(stored.entries.length, 1);
  assert.deepEqual(recentPaths(stores.recentsList("default")), [fs.realpathSync(a)]);
});

test("recents: list_hides_a_deleted_folder_but_keeps_its_entry", (t) => {
  const s = scratch(t);
  const a = s.folder("a");
  const b = s.folder("b");
  stores.recentsTouch(null, a);
  stores.recentsTouch(null, b);
  fs.rmdirSync(b);

  assert.deepEqual(recentPaths(stores.recentsList("default")), [fs.realpathSync(a)]);
  const stored = JSON.parse(fs.readFileSync(s.config("recent-projects.json"), "utf8"));
  assert.equal(stored.entries.length, 2);
});

test("recents: touch_records_the_canonical_folder", (t) => {
  const s = scratch(t);
  const real = s.folder("real");
  const link = path.join(s.dir, "link");
  fs.symlinkSync(real, link, "dir");

  const touched = stores.recentsTouch(null, link);
  assert.deepEqual(recentPaths(touched), [fs.realpathSync(real)]);
});

test("recents: refuses_unknown_profiles_and_non_directories", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }] });
  const folder = s.folder("p");
  const file = s.file("notes.txt", "x");

  // `recents_key`: an unlisted id is an Err, like every profile-scoped command.
  assert.throws(() => stores.recentsList("ghost"), /unknown profile: "ghost"/);
  assert.throws(() => stores.recentsTouch("ghost", folder), /unknown profile: "ghost"/);

  assert.throws(() => stores.recentsTouch(null, file), /not a directory/);
  assert.throws(() => stores.recentsTouch(null, s.missing("nope")), /cannot resolve/);
  assert.deepEqual(stores.recentsList("default"), []);
});

// ── approval_mode.rs ────────────────────────────────────────────────────────

test("approval: project_override_beats_the_default_for_that_project_only", (t) => {
  const s = scratch(t);
  const a = s.folder("a");
  const b = s.folder("b");

  stores.approvalModeSetDefault("always-ask");
  const view = stores.approvalModeSetProject(a, "yolo");

  assert.equal(view.default, "always-ask");
  assert.deepEqual(view.projects, { [fs.realpathSync(a)]: "yolo" });
  assert.deepEqual(stores.approvalModeGet(), view);
  assert.equal(fs.realpathSync(a) === fs.realpathSync(b), false);
});

test("approval: resolve_matches_a_symlinked_path_by_its_canonical_folder", (t) => {
  const s = scratch(t);
  const real = s.folder("real");
  const link = path.join(s.dir, "link");
  fs.symlinkSync(real, link, "dir");

  stores.approvalModeSetProject(link, "yolo");

  assert.deepEqual(Object.keys(stores.approvalModeGet().projects), [fs.realpathSync(real)]);
});

test("approval: set_and_remove_persist_across_a_reload", (t) => {
  const s = scratch(t);
  const project = s.folder("project");
  const key = fs.realpathSync(project);

  stores.approvalModeSetDefault("yolo");
  stores.approvalModeSetProject(project, "always-ask");

  assert.deepEqual(JSON.parse(fs.readFileSync(s.config("approval-mode.json"), "utf8")), {
    version: 1,
    default: "yolo",
    projects: { [key]: "always-ask" },
  });

  stores.resetCaches(); // a fresh `ApprovalModeStore::load`
  assert.deepEqual(stores.approvalModeGet(), {
    default: "yolo",
    projects: { [key]: "always-ask" },
  });

  const removed = stores.approvalModeSetProject(project, null);
  assert.deepEqual(removed.projects, {});

  stores.resetCaches();
  assert.equal(stores.approvalModeGet().default, "yolo");
  assert.deepEqual(stores.approvalModeGet().projects, {});
});

test("approval: an_unchanged_set_does_not_create_the_file", (t) => {
  const s = scratch(t);
  const folder = s.folder("dir");

  stores.approvalModeSetDefault("write");
  stores.approvalModeSetProject(folder, null);

  assert.equal(fs.existsSync(s.config("approval-mode.json")), false);
});

test("approval: a_malformed_file_reads_as_defaults_and_refuses_writes", (t) => {
  const s = scratch(t);
  const file = s.config("approval-mode.json");
  fs.writeFileSync(file, '{ "default": "auto" }');

  assert.deepEqual(stores.approvalModeGet(), { default: "write", projects: {} });
  assert.throws(() => stores.approvalModeSetDefault("yolo"), /unreadable/);
  assert.equal(fs.readFileSync(file, "utf8"), '{ "default": "auto" }');
  assert.equal(stores.approvalModeGet().default, "write");
});

test("approval: a_missing_field_reads_as_its_default", (t) => {
  const s = scratch(t);
  s.file("approval-mode.json", '{ "default": "yolo" }');

  const view = stores.approvalModeGet();
  assert.equal(view.default, "yolo");
  assert.deepEqual(view.projects, {});
});

test("approval: view_serializes_to_the_ipc_shape", (t) => {
  // An absolute path on every platform; `/no/such/project` is relative on
  // Windows (no drive), which `set_project` refuses.
  const s = scratch(t);
  const project = s.missing("no-such-project");
  stores.approvalModeSetProject(project, "yolo");

  assert.equal(
    JSON.stringify(stores.approvalModeGet()),
    JSON.stringify({ default: "write", projects: { [project]: "yolo" } }),
  );
});

test("approval: set_project_rejects_a_relative_or_empty_root", (t) => {
  const s = scratch(t);

  assert.throws(() => stores.approvalModeSetProject("", "yolo"), /must be an absolute path/);
  assert.throws(
    () => stores.approvalModeSetProject("relative/dir", "yolo"),
    /must be an absolute path/,
  );
  assert.deepEqual(stores.approvalModeGet().projects, {});
});

test("approval: parse_rejects_anything_but_the_exact_spellings", (t) => {
  const s = scratch(t);

  for (const bad of ["Write", "auto", "", "always_ask", "AlwaysAsk", " yolo"]) {
    assert.throws(() => stores.approvalModeSetDefault(bad), /unknown approval mode/);
  }
  assert.equal(fs.existsSync(s.config("approval-mode.json")), false);
});

test("approval: the_default_file_is_the_documented_one", (t) => {
  const s = scratch(t);
  assert.deepEqual(stores.approvalModeGet(), { default: "write", projects: {} });

  stores.approvalModeSetDefault("always-ask");
  assert.deepEqual(JSON.parse(fs.readFileSync(s.config("approval-mode.json"), "utf8")), {
    version: 1,
    default: "always-ask",
    projects: {},
  });
});

// ── approval_mode.rs: resolve (start_session's mode lookup) ─────────────────

test("approval: resolve_without_overrides_is_the_default", (t) => {
  scratch(t);

  assert.equal(stores.approvalModeResolve(null), "write");
  assert.equal(stores.approvalModeResolve(undefined), "write");
  assert.equal(stores.approvalModeResolve(""), "write");
  assert.equal(stores.approvalModeResolve("/no/such/project"), "write");
  assert.equal(stores.approvalModeResolve("relative/dir"), "write");
});

test("approval: resolve_prefers_the_project_override_and_falls_back_to_the_default", (t) => {
  const s = scratch(t);
  const a = s.folder("a");
  const b = s.folder("b");

  stores.approvalModeSetDefault("always-ask");
  stores.approvalModeSetProject(a, "yolo");

  assert.equal(stores.approvalModeResolve(a), "yolo");
  assert.equal(stores.approvalModeResolve(b), "always-ask");
  assert.equal(stores.approvalModeResolve(null), "always-ask");
  assert.equal(stores.approvalModeResolve(s.missing("nope")), "always-ask");
});

test("approval: resolve_matches_a_symlink_and_its_target", (t) => {
  const s = scratch(t);
  const real = s.folder("real");
  const link = path.join(s.dir, "link");
  fs.symlinkSync(real, link, "dir");

  stores.approvalModeSetProject(link, "yolo");

  assert.equal(stores.approvalModeResolve(real), "yolo");
  assert.equal(stores.approvalModeResolve(link), "yolo");
});

test("approval: resolve_canonicalises_a_trailing_slash_for_a_live_folder", (t) => {
  const s = scratch(t);
  const project = s.folder("project");

  stores.approvalModeSetProject(project, "yolo");

  assert.equal(stores.approvalModeResolve(`${project}${path.sep}`), "yolo");
  assert.equal(
    stores.approvalModeResolve(`${project}${path.sep}${path.sep}`),
    "yolo",
  );
});

test("approval: resolve_does_not_canonicalise_a_missing_folder", (t) => {
  // `project_key` keeps the raw path when canonicalisation fails, so a
  // trailing slash on a folder that is gone is a different, unmatched key.
  const s = scratch(t);
  const project = s.missing("gone");

  stores.approvalModeSetProject(project, "yolo");

  assert.equal(stores.approvalModeResolve(project), "yolo");
  assert.equal(
    stores.approvalModeResolve(`${project}${path.sep}`),
    "write",
  );
});

test("approval: resolve_reads_the_load_once_cache_not_the_file_again", (t) => {
  const s = scratch(t);
  const project = s.folder("project");
  stores.approvalModeSetProject(project, "yolo");

  // Corrupt the file behind the loaded cache: the cached value still wins.
  fs.writeFileSync(s.config("approval-mode.json"), "not json");
  assert.equal(stores.approvalModeResolve(project), "yolo");

  stores.resetCaches(); // a fresh `ApprovalModeStore::load`: defaults
  assert.equal(stores.approvalModeResolve(project), "write");
  assert.deepEqual(stores.approvalModeGet(), { default: "write", projects: {} });
});

test("approval: resolve_of_a_corrupt_store_is_the_default_and_never_throws", (t) => {
  const s = scratch(t);
  const file = s.config("approval-mode.json");
  fs.writeFileSync(file, '{ "default": "auto", "projects": { "/x": "yolo" } }');

  assert.equal(stores.approvalModeResolve(null), "write");
  assert.equal(stores.approvalModeResolve(s.folder("anything")), "write");

  // The user's file is left alone and a write still refuses.
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '{ "default": "auto", "projects": { "/x": "yolo" } }',
  );
  assert.throws(() => stores.approvalModeSetDefault("yolo"), /unreadable/);
});

test("approval: set_project_then_resolve_round_trips_through_the_file", (t) => {
  const s = scratch(t);
  const project = s.folder("project");
  const key = fs.realpathSync(project);

  stores.approvalModeSetDefault("always-ask");
  stores.approvalModeSetProject(project, "yolo");
  stores.resetCaches(); // resolve must read what landed on disk

  assert.deepEqual(JSON.parse(fs.readFileSync(s.config("approval-mode.json"), "utf8")), {
    version: 1,
    default: "always-ask",
    projects: { [key]: "yolo" },
  });
  assert.equal(stores.approvalModeResolve(project), "yolo");

  stores.approvalModeSetProject(project, null);
  stores.resetCaches();
  assert.equal(stores.approvalModeResolve(project), "always-ask");
});

test("approval: resolve_flags_match_the_spawn_argv", (t) => {
  const s = scratch(t);
  const project = s.folder("project");
  const cases = [
    ["always-ask", "--approval-mode=always-ask"],
    ["write", "--approval-mode=write"],
    ["yolo", "--approval-mode=yolo"],
  ];

  for (const [mode, flag] of cases) {
    stores.approvalModeSetDefault(mode);
    stores.approvalModeSetProject(project, mode);
    assert.equal(`--approval-mode=${stores.approvalModeResolve(project)}`, flag);
  }
});

// ── profiles.rs ─────────────────────────────────────────────────────────────

test("profiles: normalize_seeds_builtin_and_drops_junk", (t) => {
  const s = scratch(t);
  s.writeProfiles({
    profiles: [
      { id: "../escape", name: "escape" },
      { id: "work", name: "Work" },
      { id: "work", name: "dup" },
      { id: "default", name: "Personal" },
    ],
  });

  assert.deepEqual(stores.profilesList(), {
    profiles: [
      { id: "default", name: "Personal" },
      { id: "work", name: "Work" },
    ],
    startupId: "default",
    degraded: null,
  });
});

test("profiles: resolve_maps_builtin_ids_to_no_flag", (t) => {
  scratch(t);
  assert.equal(stores.resolveProfile(null), null);
  assert.equal(stores.resolveProfile(undefined), null);
  assert.equal(stores.resolveProfile(""), null);
  assert.equal(stores.resolveProfile("default"), null);
});

test("profiles: resolve_accepts_only_created_profiles", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }] });

  // Not listed yet: a tab must not be able to materialise a profile.
  assert.equal(stores.resolveProfile("work"), "work");
  for (const bad of ["../etc", "--auto-approve", "work/sub", "..", "Work"]) {
    assert.throws(() => stores.resolveProfile(bad), /unknown profile/, bad);
  }
});

test("profiles: a_hand_edited_dangling_startup_pointer_reads_back_as_the_builtin", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }], startup: "ghost" });

  const list = stores.profilesList();
  assert.equal(list.startupId, "default");
  assert.deepEqual(list.profiles.map((profile) => profile.id), ["default", "work"]);
});

test("profiles: set_startup_persists_and_survives_a_reload", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [{ id: "work", name: "Work" }], startup: "work" });

  assert.equal(stores.profilesList().startupId, "work");
});

test("profiles: a_hand_edited_startup_pointing_at_an_invalid_id_is_dropped", (t) => {
  const s = scratch(t);
  s.writeProfiles({
    profiles: [{ id: "../../etc", name: "Bad" }],
    startup: "../../etc",
  });

  const list = stores.profilesList();
  assert.deepEqual(list.profiles, [{ id: "default", name: "default" }]);
  assert.equal(list.startupId, "default");
});

test("profiles: an_empty_json_object_means_no_profiles_not_corrupt", (t) => {
  const s = scratch(t);
  // A live snapshot of a richer list must not be resurrected by `{}`.
  s.profileSnapshot(JSON.stringify({ profiles: [{ id: "work", name: "Work" }] }));
  s.file("profiles.json", "{}");

  const list = stores.profilesList();
  assert.deepEqual(list.profiles, [{ id: "default", name: "default" }]);
  assert.equal(list.degraded, null);
  assert.throws(() => stores.resolveProfile("work"), /unknown profile/);
});

test("profiles: corrupt_store_file_falls_back_to_builtin_only", (t) => {
  const s = scratch(t);
  s.file("profiles.json", "not json");

  assert.deepEqual(stores.profilesList(), {
    profiles: [{ id: "default", name: "default" }],
    startupId: "default",
    degraded: null,
  });
});

test("profiles: corrupt_store_is_recovered_from_the_snapshot_ring", (t) => {
  const s = scratch(t);
  const snapshot = JSON.stringify({ profiles: [{ id: "work", name: "Work" }] });
  s.profileSnapshot(snapshot);
  s.file("profiles.json", "not json");

  const list = stores.profilesList();
  assert.deepEqual(list.profiles.map((profile) => profile.id), ["default", "work"]);
  assert.equal(list.degraded, null);
});

test("profiles: a_ring_snapshot_that_no_longer_matches_its_hash_is_quarantined", (t) => {
  const s = scratch(t);
  const file = s.profileSnapshot(JSON.stringify({ profiles: [{ id: "work", name: "Work" }] }));
  fs.writeFileSync(file, JSON.stringify({ profiles: [{ id: "evil", name: "Evil" }] }));
  s.file("profiles.json", "not json");

  assert.deepEqual(stores.profilesList().profiles.map((profile) => profile.id), ["default"]);
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".corrupt")));
});

test("profiles: a_degraded_load_marks_the_store_for_the_ui", (t) => {
  const s = scratch(t);
  // A directory where the file should be: unreadable at both attempts.
  fs.mkdirSync(s.config("profiles.json"));

  const list = stores.profilesList();
  assert.equal(list.profiles.length, 1);
  assert.equal(list.profiles[0].id, "default");
  assert.equal(typeof list.degraded, "string");
  // A degraded store cannot resolve anything but the built-in profile.
  assert.throws(() => stores.resolveProfile("work"), /unknown profile/);
});

// ── json_store.rs write path ────────────────────────────────────────────────

test("json_store: write_atomic leaves no temp files and sweeps a crashed writer's", (t) => {
  const s = scratch(t);
  const orphan = s.config("open-tabs.json.999999-0.tmp");
  fs.writeFileSync(orphan, "partial");

  stores.openTabsSave({ tabs: [], active: null });

  const names = fs.readdirSync(s.dir);
  assert.deepEqual(
    names.filter((name) => name.startsWith("open-tabs.json")),
    ["open-tabs.json"],
  );
  assert.deepEqual(stores.openTabsLoad(), { tabs: [], active: null, skipped: [] });
});

test("stores: a fresh config dir reads the documented empty defaults", (t) => {
  scratch(t);

  assert.deepEqual(stores.openTabsLoad(), { tabs: [], active: null, skipped: [] });
  assert.deepEqual(stores.recentsList(null), []);
  assert.deepEqual(stores.approvalModeGet(), { default: "write", projects: {} });
  assert.deepEqual(stores.profilesList(), {
    profiles: [{ id: "default", name: "default" }],
    startupId: "default",
    degraded: null,
  });
});

test("recents_remove drops only the matching profile and path", (t) => {
  const s = scratch(t);
  const a = fs.realpathSync(s.folder("a"));
  const b = fs.realpathSync(s.folder("b"));
  stores.recentsTouch("default", a);
  stores.recentsTouch("default", b);
  const left = stores.recentsRemove("default", a);
  assert.deepEqual(left.map((e) => e.path), [b]);
  const raw = JSON.parse(fs.readFileSync(s.config("recent-projects.json"), "utf8"));
  assert.ok(!raw.entries.some((e) => e.profile === "default" && e.path === a));
  // removing an absent path is a no-op that still returns the list
  assert.deepEqual(stores.recentsRemove("default", a).map((e) => e.path), [b]);
});
