/* tests/port-profiles-mutate.mjs — parity tests for
   electron/backend/profiles-mutate.js.

   Each case mirrors a `#[cfg(test)]` case from src-tauri/src/profiles.rs (or
   a contract of the `lib.rs` command wrappers), as of feat/electron-port.
   Every test runs against a scratch config dir (OMP_PORT_CONFIG_DIR) and a
   scratch home (HOME/USERPROFILE), so neither profiles.json nor the seeded
   `~/.omp/profiles/<id>/agent/models.yml` can touch the real user tree.

   Run with: node tests/port-profiles-mutate.mjs */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const profiles = require("../electron/backend/profiles-mutate.js");
const stores = require("../electron/backend/stores.js");

const seedPath = (home, id) => path.join(home, ".omp", "profiles", id, "agent", "models.yml");

/** A scratch config dir + home, wired through the env, cleaned up with t. */
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-port-profiles-mutate-"));
  const config = path.join(root, "config");
  const home = path.join(root, "home");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const saved = {
    config: process.env.OMP_PORT_CONFIG_DIR,
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.OMP_PORT_CONFIG_DIR = config;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  stores.resetCaches();
  t.after(() => {
    if (saved.config === undefined) delete process.env.OMP_PORT_CONFIG_DIR;
    else process.env.OMP_PORT_CONFIG_DIR = saved.config;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userprofile;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    stores.resetCaches();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = {
    root,
    config,
    home,
    file: (name) => path.join(config, name),
    readProfiles() {
      return JSON.parse(fs.readFileSync(path.join(config, "profiles.json"), "utf8"));
    },
    writeProfiles(value) {
      fs.writeFileSync(path.join(config, "profiles.json"), JSON.stringify(value));
    },
    /** `profiles.snapshots/<sha256>.json` with exactly `contents`. */
    snapshot(contents) {
      const dir = path.join(config, "profiles.snapshots");
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.createHash("sha256").update(contents).digest("hex");
      const target = path.join(dir, `${id}.json`);
      fs.writeFileSync(target, contents);
      return target;
    },
  };
  return s;
}

const byId = (id) => ({ id, name: id });

// ── create ──────────────────────────────────────────────────────────────────

test("profiles-mutate: create_persists_and_is_visible_to_a_fresh_store", (t) => {
  const s = scratch(t);

  const created = profiles.createProfile("Work");
  assert.deepEqual(created, { id: "work", name: "Work" });

  const list = stores.profilesList();
  assert.deepEqual(list.profiles, [byId("default"), { id: "work", name: "Work" }]);
  assert.equal(list.startupId, "default");
  assert.equal(list.degraded, null);
  // The built-in profile is persisted so its label survives restarts.
  assert.deepEqual(s.readProfiles(), { profiles: [byId("default"), { id: "work", name: "Work" }] });
});

test("profiles-mutate: create_uniquifies_ids_derived_from_the_same_name", (t) => {
  scratch(t);

  assert.equal(profiles.createProfile("Work").id, "work");
  assert.equal(profiles.createProfile("Work").id, "work-2");
  assert.equal(profiles.createProfile(" work ").id, "work-3");
  assert.deepEqual(
    stores.profilesList().profiles.map((profile) => profile.id),
    ["default", "work", "work-2", "work-3"],
  );
});

test("profiles-mutate: explicit_duplicate_id_is_refused_not_uniquified", (t) => {
  scratch(t);

  assert.deepEqual(profiles.createProfile("Work", "work"), { id: "work", name: "Work" });
  // Port extension: the shipped frontend never sends an id, but a caller that
  // pins one gets a refusal instead of a silent `work-2`.
  assert.throws(() => profiles.createProfile("Other", "work"), {
    message: 'profile already exists: "work"',
  });
  assert.throws(() => profiles.createProfile("Bad", "../../etc"), {
    message: 'invalid profile id: "../../etc"',
  });
  assert.deepEqual(
    stores.profilesList().profiles.map((profile) => profile.id),
    ["default", "work"],
  );

  // The Tauri args object can be forwarded unchanged.
  assert.deepEqual(profiles.createProfile({ name: "From Args" }), { id: "from-args", name: "From Args" });
  assert.deepEqual(profiles.createProfile({ id: "pinned", name: "Pinned" }), { id: "pinned", name: "Pinned" });
  assert.throws(() => profiles.createProfile({ id: "pinned", name: "Again" }), {
    message: 'profile already exists: "pinned"',
  });
});

test("profiles-mutate: create_rejects_blank_and_control_names", (t) => {
  scratch(t);

  assert.throws(() => profiles.createProfile("   "), { message: "profile name must not be empty" });
  assert.throws(() => profiles.createProfile("bad\u0007name"), {
    message: "profile name must not contain control characters",
  });
  assert.deepEqual(stores.profilesList().profiles, [byId("default")]);
});

test("profiles-mutate: create_enforces_max_profiles_and_the_cap_survives_a_reload", (t) => {
  const s = scratch(t);
  const many = [byId("default")];
  for (let i = 1; i <= 63; i += 1) many.push(byId(`p${i}`));
  s.writeProfiles({ profiles: many });

  assert.throws(() => profiles.createProfile("One more"), {
    message: "profile limit reached (64)",
  });
  assert.equal(stores.profilesList().profiles.length, 64);
  assert.equal(s.readProfiles().profiles.length, 64);
});

test("profiles-mutate: create_seeds_the_bootstrap_models_yml", (t) => {
  const s = scratch(t);

  profiles.createProfile("Work");
  assert.equal(fs.readFileSync(seedPath(s.home, "work"), "utf8"), profiles.BOOTSTRAP_MODELS_YML);

  // Never clobbers an existing file (a re-created id keeps the user's).
  const custom = path.join(s.home, ".omp", "profiles", "seeded", "agent", "models.yml");
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, "providers:\n  openai:\n    auth: none\n");
  profiles.createProfile("Seeded", "seeded");
  assert.equal(fs.readFileSync(custom, "utf8"), "providers:\n  openai:\n    auth: none\n");
});

// ── validate_id / sanitize_name / slugify / unique_id ───────────────────────

test("profiles-mutate: validate_id_rejects_traversal_and_flag_shapes", (t) => {
  scratch(t);
  for (const bad of ["", "../etc", ".", "..", "-flag", "Work", "wörk", "a/b", "a b", "a".repeat(49), "work."]) {
    assert.throws(() => profiles.validateId(bad), {
      message: `invalid profile id: ${JSON.stringify(bad)}`,
    });
  }
  for (const good of ["a", "work", "work-2", "a_b.c", "0x", "a".repeat(48)]) {
    assert.equal(profiles.validateId(good), good);
  }
});

test("profiles-mutate: validate_id_rejects_windows_device_stems", (t) => {
  scratch(t);
  for (const bad of ["con", "prn", "aux", "nul", "com1", "lpt9", "nul.bak", "CON"]) {
    assert.throws(() => profiles.validateId(bad), {
      message: `invalid profile id: ${JSON.stringify(bad)}`,
    });
  }
  // Any `com<N>`/`lpt<N>` stem is reserved; longer names and bare stems are not.
  assert.throws(() => profiles.validateId("com0"), {
    message: 'invalid profile id: "com0"',
  });
  for (const good of ["com10", "com", "lpt", "nullable", "console", "auxiliary"]) {
    assert.equal(profiles.validateId(good), good);
  }
});

test("profiles-mutate: slugify_produces_valid_ids", (t) => {
  scratch(t);
  assert.equal(profiles.slugify("Work Stuff"), "work-stuff");
  assert.equal(profiles.slugify("  Work__Stuff!!  "), "work__stuff");
  assert.equal(profiles.slugify("NUL.bak"), "nul.bak");
  assert.equal(profiles.slugify("日本語"), "profile");
  assert.equal(profiles.slugify("a".repeat(80)).length, 48);
  for (const name of ["Work", "ünïcode name", "a/b", "---"]) {
    assert.equal(profiles.validateId(profiles.slugify(name)), profiles.slugify(name));
  }
});

test("profiles-mutate: unique_id_avoids_collisions_and_the_reserved_id", (t) => {
  scratch(t);
  assert.equal(profiles.uniqueId("work", []), "work");
  assert.equal(profiles.uniqueId("work", [byId("default"), byId("work")]), "work-2");
  assert.equal(
    profiles.uniqueId("nul.bak", [byId("default")]),
    "nul-2",
  );
  assert.equal(profiles.uniqueId("default", [byId("default")]), "default-2");
  // The `-<n>` suffix keeps the whole id within MAX_ID_LEN (46 + 2 = 48).
  assert.equal(profiles.uniqueId("a".repeat(48), [byId("a".repeat(48))]), `${"a".repeat(46)}-2`);
});

test("profiles-mutate: sanitize_name_trims_and_rejects_blank", (t) => {
  scratch(t);
  assert.equal(profiles.sanitizeName("  Work  "), "Work");
  assert.equal(profiles.sanitizeName("x".repeat(80)).length, 48);
  assert.throws(() => profiles.sanitizeName("   "), { message: "profile name must not be empty" });
  assert.throws(() => profiles.sanitizeName("a\u0000b"), {
    message: "profile name must not contain control characters",
  });
});

// ── rename ──────────────────────────────────────────────────────────────────

test("profiles-mutate: rename_keeps_the_id_stable_including_for_the_builtin", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");

  assert.deepEqual(profiles.renameProfile("work", "  Work Stuff "), { id: "work", name: "Work Stuff" });
  assert.deepEqual(profiles.renameProfile("default", "Primary"), { id: "default", name: "Primary" });
  // Blank means the built-in profile, like `is_default`.
  assert.deepEqual(profiles.renameProfile("", "Base"), { id: "default", name: "Base" });

  assert.deepEqual(stores.profilesList().profiles, [
    { id: "default", name: "Base" },
    { id: "work", name: "Work Stuff" },
  ]);
  assert.equal(s.readProfiles().profiles[0].name, "Base");
});

test("profiles-mutate: rename_rejects_unknown_profile_and_blank_name", (t) => {
  scratch(t);
  profiles.createProfile("Work");

  assert.throws(() => profiles.renameProfile("ghost", "Ghost"), {
    message: 'unknown profile: "ghost"',
  });
  // `sanitize_name` runs before the mutation, like Rust.
  assert.throws(() => profiles.renameProfile("ghost", "  "), {
    message: "profile name must not be empty",
  });
  assert.deepEqual(stores.profilesList().profiles, [byId("default"), { id: "work", name: "Work" }]);
});

// ── delete ──────────────────────────────────────────────────────────────────

test("profiles-mutate: remove_unlists_the_profile_and_persists", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  profiles.createProfile("Personal");
  profiles.setStartupProfile("work");

  assert.equal(profiles.deleteProfile("work"), null);
  const list = stores.profilesList();
  assert.deepEqual(list.profiles.map((profile) => profile.id), ["default", "personal"]);
  // Deleting the startup profile falls the pointer back to the built-in one.
  assert.equal(list.startupId, "default");
  assert.equal("startup" in s.readProfiles(), false);
});

test("profiles-mutate: remove_leaves_the_data_directory_alone", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  const sessions = path.join(s.home, ".omp", "profiles", "work", "agent", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "keep.jsonl"), "{}\n");

  profiles.deleteProfile("work");
  assert.equal(fs.existsSync(path.join(sessions, "keep.jsonl")), true);

  // Re-creating the same name re-adopts the existing id/directory.
  assert.deepEqual(profiles.createProfile("Work"), { id: "work", name: "Work" });
  assert.equal(fs.existsSync(seedPath(s.home, "work")), true);
});

test("profiles-mutate: remove_refuses_the_builtin_and_unknown_profiles", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");

  assert.throws(() => profiles.deleteProfile("default"), {
    message: "the default profile cannot be deleted",
  });
  assert.throws(() => profiles.deleteProfile(""), {
    message: "the default profile cannot be deleted",
  });
  assert.throws(() => profiles.deleteProfile("ghost"), {
    message: 'unknown profile: "ghost"',
  });
  assert.deepEqual(
    s.readProfiles().profiles.map((profile) => profile.id),
    ["default", "work"],
  );
});

// ── startup pointer ─────────────────────────────────────────────────────────

test("profiles-mutate: set_startup_persists_and_survives_a_reload", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");

  assert.equal(profiles.setStartupProfile("work"), null);
  assert.equal(stores.profilesList().startupId, "work");
  assert.equal(s.readProfiles().startup, "work");

  // Blank/"default" selects the built-in profile, stored as an absent pointer.
  profiles.setStartupProfile("default");
  assert.equal(stores.profilesList().startupId, "default");
  assert.deepEqual(s.readProfiles(), { profiles: [byId("default"), { id: "work", name: "Work" }] });

  profiles.setStartupProfile("work");
  profiles.setStartupProfile("");
  assert.equal("startup" in s.readProfiles(), false);
});

test("profiles-mutate: set_startup_rejects_unknown_and_keeps_the_previous_one", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  profiles.setStartupProfile("work");

  assert.throws(() => profiles.setStartupProfile("ghost"), {
    message: 'unknown profile: "ghost"',
  });
  assert.equal(stores.profilesList().startupId, "work");
  assert.equal(s.readProfiles().startup, "work");
});

test("profiles-mutate: set_startup_rejects_a_profile_another_instance_deleted", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  // Another instance unlists `work` between our resolve and our write: the
  // mutation re-reads under the lock and must not persist a dangling pointer.
  s.writeProfiles({ profiles: [byId("default")] });

  assert.throws(() => profiles.setStartupProfile("work"), {
    message: 'unknown profile: "work"',
  });
  assert.equal("startup" in s.readProfiles(), false);
});

test("profiles-mutate: a_hand_edited_dangling_startup_pointer_reads_back_as_the_builtin", (t) => {
  const s = scratch(t);
  s.writeProfiles({ profiles: [byId("default"), byId("work")], startup: "ghost" });

  profiles.createProfile("Fresh");
  // The next mutation drops the dangling pointer instead of persisting it.
  assert.equal("startup" in s.readProfiles(), false);
  assert.equal(stores.profilesList().startupId, "default");
});

test("profiles-mutate: renaming_the_startup_profile_keeps_it_the_default", (t) => {
  scratch(t);
  profiles.createProfile("Work");
  profiles.setStartupProfile("work");
  profiles.renameProfile("work", "Work Stuff");
  assert.equal(stores.profilesList().startupId, "work");
});

test("profiles-mutate: startup_id_always_names_a_listed_profile", (t) => {
  scratch(t);
  profiles.createProfile("Work");
  profiles.createProfile("Personal");
  profiles.setStartupProfile("personal");
  profiles.deleteProfile("work");

  const list = stores.profilesList();
  assert.ok(list.profiles.some((profile) => profile.id === list.startupId));
});

// ── bootstrap cleanup ───────────────────────────────────────────────────────

test("profiles-mutate: clear_bootstrap_removes_only_our_own_untouched_seed", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  const file = seedPath(s.home, "work");

  assert.equal(profiles.clearProfileBootstrap("work"), null);
  assert.equal(fs.existsSync(file), false);

  // Absent is a no-op.
  assert.equal(profiles.clearProfileBootstrap("work"), null);
});

test("profiles-mutate: clear_bootstrap_leaves_a_semantically_modified_file", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");
  const file = seedPath(s.home, "work");

  const modified = "providers:\n  openai:\n    auth: none\n";
  fs.writeFileSync(file, modified);
  profiles.clearProfileBootstrap("work");
  assert.equal(fs.readFileSync(file, "utf8"), modified);

  // A prose-only edit of the seed is still recognised.
  fs.writeFileSync(file, profiles.BOOTSTRAP_MODELS_YML.replace(
    "# Written by OMP Desktop when this profile was created.",
    "# Written by OMP Desktop (different prose).",
  ));
  profiles.clearProfileBootstrap("work");
  assert.equal(fs.existsSync(file), false);
});

test("profiles-mutate: clear_bootstrap_ignores_the_builtin_and_unknown_ids", (t) => {
  const s = scratch(t);
  profiles.createProfile("Work");

  assert.equal(profiles.clearProfileBootstrap("default"), null);
  assert.equal(profiles.clearProfileBootstrap(""), null);
  assert.throws(() => profiles.clearProfileBootstrap("ghost"), {
    message: 'unknown profile: "ghost"',
  });
  // The built-in tree's models.yml is never a target.
  assert.equal(fs.existsSync(seedPath(s.home, "default")), false);
  assert.equal(fs.existsSync(seedPath(s.home, "work")), true);
});

// ── corrupt / unreadable files and the snapshot ring ────────────────────────

test("profiles-mutate: corrupt_store_is_recovered_from_the_snapshot_ring", (t) => {
  const s = scratch(t);
  const snapshot = JSON.stringify({
    profiles: [byId("default"), byId("work")],
    startup: "work",
  });
  s.snapshot(snapshot);
  fs.writeFileSync(path.join(s.config, "profiles.json"), "not json");

  profiles.createProfile("Fresh");

  const list = stores.profilesList();
  assert.deepEqual(list.profiles.map((profile) => profile.id), ["default", "work", "fresh"]);
  assert.equal(list.startupId, "work");
  // The bad bytes are quarantined immediately before the replacement write.
  assert.equal(fs.readFileSync(path.join(s.config, "profiles.json.corrupt"), "utf8"), "not json");
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.config, "profiles.json"), "utf8")).startup, "work");
});

test("profiles-mutate: corrupt_store_with_no_ring_falls_back_to_builtin_only", (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.config, "profiles.json"), "{\"profiles\": 3}");

  assert.deepEqual(profiles.createProfile("Fresh"), { id: "fresh", name: "Fresh" });
  assert.deepEqual(
    stores.profilesList().profiles.map((profile) => profile.id),
    ["default", "fresh"],
  );
});

test("profiles-mutate: mutate_refuses_when_the_ring_is_unreadable", (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.config, "profiles.json"), "not json");
  // A ring *read* failure is not "no snapshot": the mutation must abort
  // rather than overwrite a file it could not recover.
  fs.writeFileSync(path.join(s.config, "profiles.snapshots"), "not a directory");

  assert.throws(() => profiles.createProfile("Fresh"), /^Error: read profile snapshots: /);
  assert.equal(fs.readFileSync(path.join(s.config, "profiles.json"), "utf8"), "not json");
});

test("profiles-mutate: mutate_refuses_to_persist_over_an_unreadable_store", (t) => {
  const s = scratch(t);
  // A directory where the file should be is the portable "unreadable".
  fs.mkdirSync(path.join(s.config, "profiles.json"));

  assert.throws(() => profiles.createProfile("Fresh"), /^Error: read profiles: /);
  assert.equal(fs.statSync(path.join(s.config, "profiles.json")).isDirectory(), true);
});

test("profiles-mutate: the_snapshot_ring_prunes_to_eight_versions", (t) => {
  const s = scratch(t);
  for (let i = 1; i <= 10; i += 1) profiles.createProfile(`Profile ${i}`);

  const snapshots = fs.readdirSync(path.join(s.config, "profiles.snapshots"))
    .filter((name) => name.endsWith(".json"));
  assert.equal(snapshots.length, 8);
});

// ── advisory lock ───────────────────────────────────────────────────────────

test("profiles-mutate: a_live_lock_owner_blocks_the_mutation", (t) => {
  const s = scratch(t);
  const now = Math.max(0, Math.trunc(Date.now() / 1000));
  fs.writeFileSync(path.join(s.config, "profiles.lock"), `${process.pid}:${now}:0`);

  assert.throws(() => profiles.createProfile("Work"), {
    message: "another window is updating this file; try again",
  });
  // The lock file is left for its real owner.
  assert.equal(fs.existsSync(path.join(s.config, "profiles.lock")), true);
});

test("profiles-mutate: a_dead_or_malformed_lock_is_taken_over", (t) => {
  const s = scratch(t);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(dead.status, 0);
  const now = Math.max(0, Math.trunc(Date.now() / 1000));

  fs.writeFileSync(path.join(s.config, "profiles.lock"), `${dead.pid}:${now}:0`);
  assert.deepEqual(profiles.createProfile("Work"), { id: "work", name: "Work" });
  assert.equal(fs.existsSync(path.join(s.config, "profiles.lock")), false);

  fs.writeFileSync(path.join(s.config, "profiles.lock"), "garbage");
  assert.deepEqual(profiles.createProfile("Personal"), { id: "personal", name: "Personal" });
  assert.equal(fs.existsSync(path.join(s.config, "profiles.lock")), false);
});