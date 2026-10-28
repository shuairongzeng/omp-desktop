/* tests/port-widgets-core.mjs — parity tests for the widget-core port:
   electron/backend/widgets/{config,trust,snapshot,redact}.js.

   Every case is a port of a `#[cfg(test)]` case from the Rust module named in
   the test title (src-tauri/src/widgets as of feat/electron-port), plus the
   cases the ticket adds for the JS-only surface (module-level approvals,
   `verifiedCopy`, `setStoreRoot`). Where a Rust test used an internal helper
   (`expand_home`, `path_matches`, `parse_triggers`, `holds_only`), the port
   exports it for exactly this use.

   Run with: node tests/port-widgets-core.mjs */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const config = require("../electron/backend/widgets/config.js");
const trust = require("../electron/backend/widgets/trust.js");
const snapshot = require("../electron/backend/widgets/snapshot.js");
const redact = require("../electron/backend/widgets/redact.js");
const agent = require("../electron/backend/agent.js");

// ── helpers ─────────────────────────────────────────────────────────────────

/** A scratch directory removed with the test. */
function scratch(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-widgets-core-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A `widgets.json` in its own scratch dir (`TmpConfig`). */
function tmpConfig(t, name, body) {
  const dir = scratch(t, name);
  fs.writeFileSync(
    path.join(dir, "widgets.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return dir;
}

const loadBody = (t, name, body) => config.loadConfig(tmpConfig(t, name, body));
const ids = (loaded) => loaded.plugins.map((plugin) => plugin.id);

/** `config.rs::tests::plugin`. */
function plugin(matchPath, matchRemote) {
  return {
    id: "p",
    title: "P",
    command: ["x"],
    matchPath: matchPath ?? null,
    matchRemote: matchRemote ?? null,
    triggers: ["activate"],
    timeoutMs: config.TIMEOUT_MIN_MS,
    intervalMs: null,
    enabled: true,
    scope: "tab",
  };
}

/** `config.rs::test_entry`. */
function testEntry(command) {
  return {
    id: "probe",
    title: "Probe",
    command: command.slice(),
    matchPath: null,
    matchRemote: null,
    triggers: ["activate"],
    timeoutMs: 10000,
    intervalMs: null,
    enabled: true,
    scope: "tab",
  };
}

/** `ApprovalStore` over `<dir>/nested/widget-approvals.json` when asked. */
const approvalsPathOf = (dir, nested = false) =>
  nested ? path.join(dir, "nested", "widget-approvals.json") : path.join(dir, "widget-approvals.json");

/** Overwrite a copy, which is read-only on unix (`snapshot.rs::tests::tamper`). */
function tamper(copy, bytes) {
  try {
    fs.chmodSync(copy, 0o600);
  } catch {
    // Windows.
  }
  fs.writeFileSync(copy, bytes);
}

/** `subdirs(staging)` two levels deep (`staged_runs`). */
function stagedRuns(root) {
  let count = 0;
  for (const [, dir] of snapshot.subdirs(path.join(root, snapshot.STAGING))) {
    count += snapshot.subdirs(dir).length;
  }
  return count;
}

/** A store rooted in `<dir>/runs`. */
function scriptStore(dir) {
  return new snapshot.ScriptStore(path.join(dir, "runs"));
}

/** `prepare` under the entry's current fingerprint, expected to run. */
function ready(store, entry) {
  const prepared = store.prepare(entry, trust.fingerprint(entry));
  assert.equal(prepared.kind, "ready", JSON.stringify(prepared));
  return prepared;
}

const read = (file) => fs.readFileSync(file);

// ── config.rs ───────────────────────────────────────────────────────────────

test("config.rs: missing_file_is_empty_config", (t) => {
  const dir = scratch(t, "missing");
  const loaded = config.loadConfig(dir);
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.fatal, null);
  assert.equal(loaded.configPath, path.join(dir, "widgets.json"));
});

test("config.rs: config_rejects_a_bom", (t) => {
  const loaded = loadBody(t, "bom", Buffer.from("\uFEFF{\"version\":1,\"plugins\":[]}"));
  assert.ok(loaded.fatal !== null, "BOM must fail");
  assert.ok(loaded.fatal.includes("widgets.json"), loaded.fatal);
});

test("config.rs: config_rejects_a_trailing_comma", (t) => {
  const loaded = loadBody(t, "comma", '{"version":1,"plugins":[],}');
  assert.ok(loaded.fatal !== null, "trailing comma must fail");
  assert.ok(loaded.fatal.includes("widgets.json"), loaded.fatal);
});

test("config.rs: config_rejects_unknown_version", (t) => {
  const loaded = loadBody(t, "v2", '{"version":2,"plugins":[]}');
  assert.ok(loaded.fatal !== null);
  assert.ok(loaded.fatal.includes("version 2"), loaded.fatal);
});

test("config.rs: config_rejects_missing_version", (t) => {
  const loaded = loadBody(t, "nov", '{"plugins":[]}');
  assert.equal(loaded.fatal, 'widgets.json: missing "version"');
});

test("config.rs: entry_defaults_and_clamps", (t) => {
  const loaded = loadBody(
    t,
    "defaults",
    `{"version":1,"plugins":[
      {"id":"git","title":"Git","command":["bash","x.sh"]},
      {"id":"slow","title":"Slow","command":["sleep"],"timeoutMs":999999,"triggers":["branch"],"enabled":false},
      {"id":"int","title":"Interval","command":["date"],"intervalMs":1000},
      {"id":"big","title":"Big","command":["date"],"intervalMs":1000000000},
      {"id":"fast","command":["date"],"timeoutMs":5},
      {"id":"zero","command":["date"],"intervalMs":0}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.plugins.length, 6);
  const git = loaded.plugins[0];
  assert.equal(git.timeoutMs, config.TIMEOUT_DEFAULT_MS);
  assert.deepEqual(git.triggers, config.CONFIG_TRIGGERS);
  assert.equal(git.enabled, true);
  assert.equal(git.intervalMs, null);
  assert.equal(git.scope, "tab");
  const slow = loaded.plugins[1];
  assert.equal(slow.timeoutMs, config.TIMEOUT_MAX_MS);
  assert.deepEqual(slow.triggers, ["branch"]);
  assert.equal(slow.enabled, false);
  assert.equal(loaded.plugins[2].intervalMs, config.INTERVAL_MIN_MS);
  assert.equal(loaded.plugins[3].intervalMs, config.INTERVAL_MAX_MS);
  assert.equal(loaded.plugins[4].timeoutMs, config.TIMEOUT_MIN_MS, "raised to the minimum");
  assert.equal(loaded.plugins[4].title, "fast", "title falls back to the id");
  assert.equal(loaded.plugins[5].intervalMs, null, "0 means no interval");
});

test("config.rs: interval_and_unknown_triggers_are_reported_and_dropped", (t) => {
  const loaded = loadBody(
    t,
    "triggers",
    `{"version":1,"plugins":[
      {"id":"a","command":["true"],"triggers":["interval","turnEnd","branch","manual","branch"]},
      {"id":"b","command":["true"],"triggers":[]}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(ids(loaded), ["a", "b"], "the entries stay valid");
  assert.deepEqual(loaded.plugins[0].triggers, ["branch"], "deduplicated");
  assert.deepEqual(loaded.plugins[1].triggers, []);
  assert.deepEqual(loaded.errors, [
    'plugin "a": "interval" is not a valid trigger; set "intervalMs" instead',
    'plugin "a": unknown trigger "turnEnd" (expected activate, turn_end, branch or manual)',
  ]);
});

test("config.rs: unknown_keys_are_reported_without_dropping_the_entry", (t) => {
  const loaded = loadBody(
    t,
    "keys",
    `{"version":1,"plugin":[],"plugins":[
      {"id":"a","command":["true"],"timeout":5000,"interval_ms":20000,"match":{"path":"/x","remotes":"y"}},
      {"id":"Bad","cmd":["true"]}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(ids(loaded), ["a"]);
  const a = loaded.plugins[0];
  assert.equal(a.timeoutMs, config.TIMEOUT_DEFAULT_MS, "the typo is not read");
  assert.equal(a.intervalMs, null);
  assert.equal(a.matchPath, "/x");
  assert.deepEqual(loaded.errors, [
    'widgets.json: unknown key "plugin"',
    'plugin "a": unknown key "interval_ms"',
    'plugin "a": unknown key "timeout"',
    'plugin "a": unknown key "match.remotes"',
    'plugin #1: unknown key "cmd"',
    'plugin #1: id "Bad" must match [a-z0-9-]{1,32}',
  ]);
});

test("config.rs: bad_entries_are_reported_not_fatal", (t) => {
  const loaded = loadBody(
    t,
    "bad",
    `{"version":1,"plugins":[
      {"id":"Bad Id","title":"x","command":["a"]},
      {"id":"dup","title":"x","command":["a"]},
      {"id":"dup","title":"y","command":["b"]},
      {"id":"nocmd","title":"x","command":[]},
      {"id":"ok","title":"Ok","command":["true"]}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(ids(loaded), ["dup", "ok"]);
  assert.equal(loaded.plugins[0].title, "x", "first duplicate wins");
  assert.equal(loaded.errors.length, 3, JSON.stringify(loaded.errors));
  assert.ok(loaded.errors.some((e) => e.includes("Bad Id")));
  assert.ok(loaded.errors.some((e) => e.includes("duplicate")));
  assert.ok(loaded.errors.some((e) => e.includes("nocmd")));
});

test("config.rs: relative_command_paths_are_rejected", (t) => {
  const abs = process.platform === "win32" ? "C:\\\\x\\\\run" : "/abs/x";
  const body = `{"version":1,"plugins":[
    {"id":"dot","command":["./x"]},
    {"id":"sub","command":["bin/x"]},
    {"id":"back","command":["bin\\\\x"]},
    {"id":"abs","command":["${abs}"]},
    {"id":"bare","command":["bash"]}
  ]}`;
  const loaded = loadBody(t, "argv0", body);
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(ids(loaded), ["abs", "bare"]);
  assert.equal(loaded.errors.length, 3, JSON.stringify(loaded.errors));
  assert.ok(
    loaded.errors.every((e) => e.includes("command path must be absolute or a bare program name")),
    JSON.stringify(loaded.errors),
  );
});

test("config.rs: leading_tilde_is_expanded_in_every_argv_element", () => {
  const command = ["~/bin/run", "~/conf.json", "~x", "~", "a~/b"];
  assert.equal(config.expandHome(command, "/home/u"), true);
  assert.deepEqual(command, [
    path.join("/home/u", "bin/run"),
    path.join("/home/u", "conf.json"),
    "~x",
    "~",
    "a~/b",
  ]);
});

test("config.rs: tilde_without_home_is_an_error_but_plain_commands_pass", () => {
  assert.equal(config.expandHome(["~/x"], null), false);
  assert.equal(config.expandHome(["bash", "~x"], null), true);
});

test("config.rs: tilde_command_passes_the_absolute_check", (t) => {
  const home = scratch(t, "home");
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
  const loaded = loadBody(
    t,
    "tilde",
    `{"version":1,"plugins":[
      {"id":"t","command":["~/.omp-desktop/widgets/x","~/arg"]},
      {"id":"u","command":["~x"]}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.equal(loaded.plugins.length, 2, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.plugins[0].command, [
    path.join(home, ".omp-desktop/widgets/x"),
    path.join(home, "arg"),
  ]);
  // `~x` is left alone: a bare program name.
  assert.deepEqual(loaded.plugins[1].command, ["~x"]);
});

test("config.rs: tilde_in_match_path_is_expanded", (t) => {
  const home = scratch(t, "home-match");
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
  const loaded = loadBody(
    t,
    "tilde-match",
    `{"version":1,"plugins":[
      {"id":"t","command":["true"],"match":{"path":"~/GIT/work","remote":"~/kept"}}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.equal(loaded.plugins[0].matchPath, path.join(home, "GIT/work"));
  // `remote` is a substring, never a path.
  assert.equal(loaded.plugins[0].matchRemote, "~/kept");
});

test("config.rs: empty_matchers_are_absent", (t) => {
  const loaded = loadBody(
    t,
    "empty-match",
    '{"version":1,"plugins":[{"id":"t","command":["true"],"match":{"path":"","remote":""}}]}',
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.equal(loaded.plugins[0].matchPath, null);
  assert.equal(loaded.plugins[0].matchRemote, null);
});

test("config.rs: plugin_count_is_capped", (t) => {
  const entries = [];
  for (let i = 0; i <= config.MAX_PLUGINS; i += 1) entries.push({ id: `p${i}`, command: ["true"] });
  const loaded = loadBody(t, "cap", { version: 1, plugins: entries });
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.equal(loaded.plugins.length, config.MAX_PLUGINS);
  assert.deepEqual(loaded.errors, [
    "widgets.json: 1 plugin entries ignored (at most 32 are read)",
  ]);
});

test("config.rs: bad_entry_types_are_isolated", (t) => {
  const loaded = loadBody(
    t,
    "types",
    `{"version":1,"plugins":[
      {"id":"bad","command":"true"},
      {"id":"ok","command":["true"]},
      {"id":"x","title":5,"command":["a"]}
    ]}`,
  );
  assert.equal(loaded.fatal, null, "entry type errors are not fatal");
  assert.deepEqual(ids(loaded), ["ok"]);
  assert.equal(loaded.errors.length, 2, JSON.stringify(loaded.errors));
  assert.ok(loaded.errors.some((e) => e.includes("#0")), JSON.stringify(loaded.errors));
  assert.ok(loaded.errors.some((e) => e.includes("#2")), JSON.stringify(loaded.errors));
});

test("config.rs: scope_defaults_to_tab_and_rejects_unknown_values", (t) => {
  const loaded = loadBody(
    t,
    "scope",
    `{"version":1,"plugins":[
      {"id":"a","command":["true"]},
      {"id":"b","command":["true"],"scope":"global"},
      {"id":"c","command":["true"],"scope":"tab"},
      {"id":"d","command":["true"],"scope":"window"}
    ]}`,
  );
  assert.equal(loaded.fatal, null, loaded.fatal);
  assert.deepEqual(
    loaded.plugins.map((p) => [p.id, p.scope]),
    [["a", "tab"], ["b", "global"], ["c", "tab"]],
  );
  assert.deepEqual(loaded.errors, ['plugin "d": scope must be "tab" or "global"']);
});

test("config.rs: config_trigger_names_parse", () => {
  const warnings = [];
  assert.deepEqual(
    config.parseTriggers(["activate", "turn_end", "branch"], "p", warnings),
    config.CONFIG_TRIGGERS,
  );
  assert.deepEqual(warnings, []);
});

test("config.rs: no_matcher_applies_everywhere", () => {
  const p = plugin(null, null);
  assert.equal(config.pluginMatches(p, "/a", ""), true);
  assert.equal(config.pluginMatches(p, "", ""), true, "tab without a project");
});

test("config.rs: path_prefix_and_remote_substring_must_both_match_when_given", () => {
  const a = plugin("/Users/me/GIT", null);
  const b = plugin(null, "gitlab.example");
  const c = plugin("/Users/me/GIT", "gitlab.example");
  const applicable = (project, remote) =>
    [["a", a], ["b", b], ["c", c]]
      .filter(([, p]) => config.pluginMatches(p, project, remote))
      .map(([id]) => id);
  const remote = "git@gitlab.example:g/x.git";
  assert.deepEqual(applicable("/Users/me/GIT/x", remote), ["a", "b", "c"]);
  assert.deepEqual(applicable("/tmp/x", remote), ["b"]);
  assert.deepEqual(applicable("/Users/me/GIT/x", ""), ["a"]);
});

test("config.rs: path_match_is_prefix_on_separators_not_characters", () => {
  const p = plugin("/Users/me/GIT", null);
  assert.equal(config.pluginMatches(p, "/Users/me/GITHUB/x", ""), false);
  assert.equal(config.pluginMatches(p, "/Users/me/GIT", ""), true, "the folder itself");
  assert.equal(config.pluginMatches(p, "/Users/me/GIT/", ""), true, "trailing separator");
  assert.equal(config.pluginMatches(p, "/Users/me", ""), false, "a parent is not inside");
  assert.equal(config.pluginMatches(p, "", ""), false, "tab without a project");
  assert.equal(config.pluginMatches(plugin("/Users/me/GIT/", null), "/Users/me/GIT/x", ""), true);
});

test("config.rs: path_match_normalises_backslashes", () => {
  const p = plugin("C:\\Users\\me\\GIT", null);
  assert.equal(config.pluginMatches(p, "C:\\Users\\me\\GIT\\x", ""), true);
  assert.equal(config.pluginMatches(p, "C:/Users/me/GIT/x", ""), true);
  assert.equal(config.pluginMatches(p, "C:\\Users\\me\\GITHUB", ""), false);
  assert.equal(config.pluginMatches(plugin("/a/b", null), "\\a\\b\\c", ""), true);
});

test("config.rs: root_match_path_matches_any_absolute_project_only", () => {
  const p = plugin("/", null);
  assert.equal(config.pluginMatches(p, "/a/b", ""), true);
  assert.equal(config.pluginMatches(p, "/", ""), true);
  assert.equal(config.pluginMatches(p, "\\a", ""), true);
  assert.equal(config.pluginMatches(p, "relative/x", ""), false);
  assert.equal(config.pluginMatches(p, "", ""), false);
  assert.equal(config.pluginMatches(plugin("//", null), "/a", ""), true);
});

test("config.rs: remote_match_is_a_plain_substring", () => {
  const p = plugin(null, "example.com/team");
  assert.equal(config.pluginMatches(p, "", "https://example.com/team/x.git"), true);
  assert.equal(config.pluginMatches(p, "", "https://example.com/other/x.git"), false);
  assert.equal(config.pluginMatches(p, "", ""), false, "no remote");
});

test("config.rs: wants_honours_the_list_and_always_allows_manual", () => {
  const p = plugin(null, null);
  p.triggers = ["branch"];
  assert.equal(config.pluginWants(p, "branch"), true);
  assert.equal(config.pluginWants(p, "turn_end"), false);
  assert.equal(config.pluginWants(p, "activate"), false);
  assert.equal(config.pluginWants(p, "manual"), true);
  p.triggers = [];
  assert.equal(config.pluginWants(p, "manual"), true);
});

test("config.rs: wants_interval_exactly_when_interval_ms_is_set", () => {
  const p = plugin(null, null);
  assert.equal(config.pluginWants(p, "interval"), false);
  p.intervalMs = 60000;
  p.triggers = [];
  assert.equal(config.pluginWants(p, "interval"), true, "interval ignores the triggers list");
});

// ── trust.rs ────────────────────────────────────────────────────────────────

test("trust.rs: fingerprint_is_stable_and_follows_argv", () => {
  const a = testEntry(["sh", "-c", "echo {}"]);
  assert.equal(trust.fingerprint(a), trust.fingerprint(a));
  assert.equal(trust.fingerprint(a).length, 64);
  assert.notEqual(trust.fingerprint(a), trust.fingerprint(testEntry(["sh", "-c", "echo []"])));
  // NUL termination keeps the argument boundaries in the hash.
  assert.notEqual(trust.fingerprint(testEntry(["ab", "c"])), trust.fingerprint(testEntry(["a", "bc"])));
  assert.equal(trust.isFingerprint(trust.fingerprint(a)), true);
  assert.equal(trust.isFingerprint(trust.fingerprint(a).toUpperCase()), false);
});

test("trust.rs: fingerprint_changes_with_script_content_only", (t) => {
  const dir = scratch(t, "content");
  const script = path.join(dir, "plugin.sh");
  fs.writeFileSync(script, "echo '{\"v\":1}'\n");
  const e = testEntry(["sh", script]);
  const before = trust.fingerprint(e);
  assert.equal(before, trust.fingerprint(e), "unchanged script, unchanged fingerprint");

  // Same length, different bytes: content is hashed, not just metadata.
  fs.writeFileSync(script, "echo '{\"v\":2}'\n");
  const after = trust.fingerprint(e);
  assert.notEqual(before, after);

  fs.writeFileSync(script, "echo '{\"v\":1}'\n");
  assert.equal(before, trust.fingerprint(e), "restored content restores the fingerprint");
});

test("trust.rs: fingerprint_ignores_directories_and_missing_paths", (t) => {
  const dir = scratch(t, "dirs");
  const missing = path.join(dir, "missing.sh");
  const e = testEntry(["sh", missing]);
  const before = trust.fingerprint(e);
  fs.mkdirSync(missing);
  assert.equal(before, trust.fingerprint(e), "a directory contributes nothing");
  fs.rmdirSync(missing);
  fs.writeFileSync(missing, "x");
  assert.notEqual(before, trust.fingerprint(e), "a file appearing at the path counts");
});

test("trust.rs: store_round_trips_and_reports_status", (t) => {
  const dir = scratch(t, "store");
  const file = approvalsPathOf(dir, true);
  const store = trust.ApprovalStore.load(file);
  assert.equal(store.status("probe", "aa"), "pending");
  store.approve("probe", "aa", "aa");

  const reread = trust.ApprovalStore.load(file);
  assert.equal(reread.status("probe", "aa"), "approved");
  assert.equal(reread.status("probe", "bb"), "changed");
  assert.equal(reread.status("other", "aa"), "pending");
  assert.equal(reread.holds("aa"), true);

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    approved: { probe: "aa" },
  });
});

test("trust.rs: approving_a_stale_fingerprint_is_rejected", (t) => {
  const dir = scratch(t, "stale");
  const script = path.join(dir, "plugin.sh");
  fs.writeFileSync(script, "echo {}\n");
  const e = testEntry(["sh", script]);
  const shown = trust.fingerprint(e);
  fs.writeFileSync(script, "rm -rf ~\n");

  const file = approvalsPathOf(dir);
  const store = trust.ApprovalStore.load(file);
  assert.throws(() => store.approve("probe", shown, trust.fingerprint(e)), /changed/);
  assert.equal(store.approved("probe"), null);
  assert.equal(fs.existsSync(file), false, "a refused approval writes nothing");
});

test("trust.rs: unknown_version_approves_nothing", (t) => {
  const dir = scratch(t, "version");
  const file = approvalsPathOf(dir);
  fs.writeFileSync(file, '{"version":2,"approved":{"probe":"aa"}}');
  const store = trust.ApprovalStore.load(file);
  assert.equal(store.status("probe", "aa"), "pending");
  assert.ok(store.error.startsWith(file), store.error);
});

test("trust.rs: reload_returns_the_error_of_an_unusable_file", (t) => {
  const dir = scratch(t, "reload-error");
  const file = approvalsPathOf(dir);
  fs.writeFileSync(file, "not json");
  const store = trust.ApprovalStore.load(file);
  // The message names the file (the parse detail is the tail).
  assert.ok(store.reloadError().startsWith(file), store.reloadError());
  assert.throws(() => store.reload(), (error) => error.message.startsWith(file));
  assert.equal(store.status("probe", "aa"), "pending");

  // Deleting the file returns to the clean missing-file state: the error
  // clears and a later reload succeeds.
  fs.rmSync(file);
  assert.equal(store.reloadError(), null);
  assert.equal(store.status("probe", "aa"), "pending");
});

test("trust.rs: approving_keeps_a_revocation_made_on_disk", (t) => {
  const dir = scratch(t, "revoke");
  const file = approvalsPathOf(dir);
  const store = trust.ApprovalStore.load(file);
  store.approve("a", "aa", "aa");
  store.approve("b", "bb", "bb");
  // The user revokes `b` by editing the file, then approves `c` before
  // reloading: `b` must stay revoked on disk.
  fs.writeFileSync(file, '{"version":1,"approved":{"a":"aa"}}');
  store.approve("c", "cc", "cc");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    approved: { a: "aa", c: "cc" },
  });
  store.reloadError();
  assert.equal(store.status("b", "bb"), "pending");
  assert.equal(store.status("c", "cc"), "approved");
});

test("trust.rs: approving_never_overwrites_an_unusable_file", (t) => {
  const dir = scratch(t, "unusable");
  const file = approvalsPathOf(dir);
  for (const bad of [
    // A revoke that left a trailing comma.
    '{"version":1,"approved":{"a":"aa",}}',
    '{"version":2,"approved":{"a":"aa"}}',
  ]) {
    fs.writeFileSync(file, bad);
    const store = trust.ApprovalStore.load(file);
    assert.throws(() => store.approve("c", "cc", "cc"), /fix or delete/);
    assert.equal(fs.readFileSync(file, "utf8"), bad, "file untouched");
    assert.equal(store.status("c", "cc"), "pending");
  }
});

test("trust.rs: approving_without_a_config_dir_fails", () => {
  const store = trust.ApprovalStore.load(null);
  assert.throws(() => store.approve("probe", "aa", "aa"), /no app config directory/);
  assert.equal(store.status("probe", "aa"), "pending");
});

test("trust: module-level approve/isApproved/revoke use <config>/widget-approvals.json", (t) => {
  const dir = scratch(t, "module");
  const saved = process.env.OMP_PORT_CONFIG_DIR;
  process.env.OMP_PORT_CONFIG_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.OMP_PORT_CONFIG_DIR;
    else process.env.OMP_PORT_CONFIG_DIR = saved;
  });
  const file = path.join(dir, "widget-approvals.json");
  assert.equal(trust.approvalsPath(), file);
  const fingerprint = "a".repeat(64);
  assert.equal(trust.isApproved("probe", fingerprint), false);
  assert.equal(trust.approvalStatus("probe", fingerprint), "pending");

  trust.approve("probe", fingerprint, { presented: fingerprint });
  assert.equal(trust.isApproved("probe", fingerprint), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    approved: { probe: fingerprint },
  });

  // A changed script means a new fingerprint that is not approved.
  const changed = "b".repeat(64);
  assert.equal(trust.isApproved("probe", changed), false);
  assert.equal(trust.approvalStatus("probe", changed), "changed");

  // The card showed something else: refused, nothing written.
  assert.throws(() => trust.approve("other", changed, changed.replace(/b/g, "c")), /changed/);
  assert.equal(trust.isApproved("other", changed), false);

  assert.equal(trust.revoke("probe"), true);
  assert.equal(trust.isApproved("probe", fingerprint), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, approved: {} });
  assert.equal(trust.revoke("probe"), false, "already revoked");
  assert.deepEqual(trust.readApprovals().approved, {});
});

test("trust: fingerprint byte layout matches the documented form", (t) => {
  const u64 = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  /** The layout written out again, independently of trust.js. */
  const reference = (args) => {
    const hasher = crypto.createHash("sha256");
    hasher.update(Buffer.from("omp-widget-v1\0", "latin1"));
    hasher.update(u64(args.length));
    for (const arg of args) {
      hasher.update(Buffer.from(arg, "utf8"));
      hasher.update(Buffer.from([0]));
    }
    args.forEach((arg, index) => {
      if (!path.isAbsolute(arg)) return;
      let meta;
      try {
        meta = fs.statSync(arg, { bigint: true });
      } catch {
        return;
      }
      if (!meta.isFile()) return;
      hasher.update(u64(index));
      hasher.update(u64(meta.size));
      if (meta.size > 8n * 1024n * 1024n) {
        hasher.update(Buffer.from("large\0", "latin1"));
        hasher.update(u64(meta.mtimeNs));
        return;
      }
      hasher.update(Buffer.from("file\0", "latin1"));
      const bytes = fs.readFileSync(arg);
      hasher.update(bytes);
      hasher.update(u64(bytes.length));
    });
    return hasher.digest("hex");
  };

  // Goldens computed from the Rust layout: DOMAIN + u64le(argv.len) + argv
  // NUL-terminated. A mismatch invalidates every existing approval.
  assert.equal(
    trust.fingerprint({ command: ["sh", "-c", "echo {}"] }),
    "17586000962933827cc59b42c1808f02762f63646e3c774e5f819494b01d254a",
  );
  assert.equal(
    trust.fingerprint({ command: ["node", "-e", "console.log(1)"] }),
    "5a728e3389b2b6fcbeac594d57d7278273918e7889674e489fafcfdb8e1073dc",
  );

  // File branch: size, contents and the bytes actually read; over the 8 MiB
  // limit size + mtime instead; a directory or missing path contributes
  // nothing.
  const dir = scratch(t, "layout");
  const script = path.join(dir, "s.sh");
  fs.writeFileSync(script, "echo {}\n");
  const empty = path.join(dir, "empty.txt");
  fs.writeFileSync(empty, "");
  const big = path.join(dir, "big.bin");
  const fd = fs.openSync(big, "w");
  fs.ftruncateSync(fd, trust.MAX_HASHED_FILE_BYTES + 1);
  fs.closeSync(fd);
  const args = ["sh", script, empty, big, path.join(dir, "missing"), dir, "flag"];
  assert.equal(trust.fingerprint({ command: args }), reference(args));
});

// ── snapshot.rs ─────────────────────────────────────────────────────────────

test("snapshot: storeRoot defaults to <tmp>/omp-port-widget-runs and is overridable", (t) => {
  const saved = process.env.OMP_PORT_WIDGET_STORE;
  delete process.env.OMP_PORT_WIDGET_STORE;
  t.after(() => {
    snapshot.setStoreRoot(null);
    if (saved === undefined) delete process.env.OMP_PORT_WIDGET_STORE;
    else process.env.OMP_PORT_WIDGET_STORE = saved;
  });
  assert.equal(snapshot.storeRoot(), path.join(os.tmpdir(), "omp-port-widget-runs"));
  const dir = scratch(t, "root");
  assert.equal(snapshot.setStoreRoot(dir), dir);
  assert.equal(snapshot.storeRoot(), dir);
  assert.equal(snapshot.setStoreRoot(null), path.join(os.tmpdir(), "omp-port-widget-runs"));
  assert.equal(new snapshot.ScriptStore(dir).root, dir);
});

test("snapshot.rs: copies_hashed_files_once_under_the_approved_fingerprint", (t) => {
  const dir = scratch(t, "copies");
  const script = path.join(dir, "hello.mjs");
  fs.writeFileSync(script, "console.log('{}')\n");
  const missing = path.join(dir, "missing.txt");
  const e = testEntry(["node", "-e", script, missing, dir]);
  const root = path.join(dir, "runs");
  const store = new snapshot.ScriptStore(root);

  const run = ready(store, e);
  const copy = run.argv[2];
  const fingerprint = trust.fingerprint(e);
  assert.equal(copy, path.join(root, snapshot.STORE, fingerprint, "2", "hello.mjs"));
  assert.deepEqual(read(copy), read(script));
  // Neither a bare name, a flag, a missing path nor a directory is a file
  // the fingerprint hashed.
  assert.deepEqual(run.argv.slice(0, 2), e.command.slice(0, 2));
  assert.deepEqual(run.argv.slice(3), e.command.slice(3));
  assert.equal(stagedRuns(root), 0);

  assert.deepEqual(ready(store, e).argv, run.argv, "a later run reuses the path");
});

test("snapshot.rs: a_stored_copy_that_differs_from_the_original_is_rebuilt", (t) => {
  const dir = scratch(t, "verify");
  const script = path.join(dir, "out.json");
  fs.writeFileSync(script, '{"v":1}');
  const e = testEntry(["cat", script]);
  const root = path.join(dir, "runs");
  const store = new snapshot.ScriptStore(root);
  const index = e.command.length - 1;
  const copy = path.join(
    root,
    snapshot.STORE,
    trust.fingerprint(e),
    String(index),
    "out.json",
  );

  // Planted before the first run.
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, '{"evil":1}');
  const run = ready(store, e);
  assert.equal(run.argv[index], copy);
  assert.deepEqual(read(copy), Buffer.from('{"v":1}'));

  for (const bad of ['{"v":2}', '{"v":1', '{"v":1}extra', '']) {
    tamper(run.argv[index], bad);
    ready(store, e);
    assert.deepEqual(read(copy), Buffer.from('{"v":1}'), `after ${JSON.stringify(bad)}`);
  }
  fs.rmSync(copy);
  ready(store, e);
  assert.deepEqual(read(copy), Buffer.from('{"v":1}'), "after removal");
});

test("snapshot.rs: a_store_entry_with_anything_beside_its_copies_is_rebuilt", (t) => {
  const dir = scratch(t, "layout");
  const script = path.join(dir, "w.py");
  fs.writeFileSync(script, "import json\n");
  const e = testEntry(["python3", "-I", script]);
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));
  const copy = ready(store, e).argv[2];
  const slot = path.dirname(copy);
  const entryDir = path.dirname(slot);

  for (const planted of [path.join(slot, "json.py"), path.join(entryDir, "7", "x")]) {
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "evil");
    assert.equal(ready(store, e).argv[2], copy);
    assert.equal(fs.existsSync(planted), false, planted);
    assert.deepEqual(read(copy), Buffer.from("import json\n"));
  }
});

test("snapshot.rs: a_linked_store_entry_or_copy_is_rebuilt", { skip: process.platform === "win32" }, (t) => {
  const dir = scratch(t, "links");
  const script = path.join(dir, "out.json");
  fs.writeFileSync(script, '{"v":1}');
  const e = testEntry(["cat", script]);
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));
  const copy = ready(store, e).argv[1];
  const entryDir = path.dirname(path.dirname(copy));

  fs.rmSync(copy);
  fs.symlinkSync(script, copy);
  ready(store, e);
  assert.equal(fs.lstatSync(copy).isFile(), true);

  const elsewhere = path.join(dir, "elsewhere");
  fs.renameSync(entryDir, elsewhere);
  fs.symlinkSync(elsewhere, entryDir);
  ready(store, e);
  assert.equal(fs.lstatSync(entryDir).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(elsewhere, "1")), true, "the link's target is left alone");
});

test("snapshot.rs: an_edited_original_is_refused_and_leaves_the_store_alone", (t) => {
  const dir = scratch(t, "edited");
  const script = path.join(dir, "w.sh");
  fs.writeFileSync(script, "echo {}");
  const e = testEntry(["sh", script]);
  const approved = trust.fingerprint(e);
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));
  const run = ready(store, e);

  fs.writeFileSync(script, "echo []");
  const got = store.prepare(e, approved);
  assert.equal(got.kind, "changed");
  assert.equal(got.fingerprint, trust.fingerprint(e));
  assert.deepEqual(read(run.argv[1]), Buffer.from("echo {}"), "kept for runs in flight");
});

test("snapshot.rs: a_changed_or_malformed_approval_stores_nothing", (t) => {
  const dir = scratch(t, "changed");
  const script = path.join(dir, "w.sh");
  fs.writeFileSync(script, "echo {}");
  const e = testEntry(["sh", script]);
  const root = path.join(dir, "runs");
  const store = new snapshot.ScriptStore(root);

  for (const approved of ["0".repeat(64), "../escape"]) {
    const got = store.prepare(e, approved);
    assert.equal(got.kind, "changed");
    assert.equal(got.fingerprint, trust.fingerprint(e));
  }
  assert.equal(snapshot.subdirs(path.join(root, snapshot.STORE)).length, 0);
  assert.equal(stagedRuns(root), 0);
  assert.equal(fs.existsSync(path.join(root, "escape")), false);
  assert.equal(fs.existsSync(path.join(dir, "escape")), false);
});

test("snapshot.rs: a_run_executes_the_checked_bytes_not_a_later_replacement", (t) => {
  const dir = scratch(t, "swap");
  const script = path.join(dir, "out.json");
  fs.writeFileSync(script, '{"v":1}');
  const e = testEntry(["cat", script]);
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));

  const run = ready(store, e);
  fs.writeFileSync(script, '{"v":2}');
  // The argv names the copy, whose bytes are the ones the approval check saw.
  assert.deepEqual(read(run.argv[1]), Buffer.from('{"v":1}'));

  fs.writeFileSync(script, '{"v":1}');
  const again = ready(store, e);
  const evil = path.join(dir, "evil.json");
  fs.writeFileSync(evil, '{"v":3}');
  fs.renameSync(evil, script);
  assert.deepEqual(read(again.argv[1]), Buffer.from('{"v":1}'));
});

test("snapshot.rs: copies_run_from_staging_when_they_cannot_be_stored", (t) => {
  const dir = scratch(t, "scratch");
  const script = path.join(dir, "out.json");
  fs.writeFileSync(script, '{"v":1}');
  const e = testEntry(["cat", script]);
  const root = path.join(dir, "runs");
  // `store` itself is a file: no entry can be created under it.
  const blocker = path.join(root, snapshot.STORE);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(blocker, "not a directory");

  const run = ready(new snapshot.ScriptStore(root), e);
  const copy = run.argv[run.argv.length - 1];
  assert.ok(copy.startsWith(path.join(root, snapshot.STAGING)), copy);
  assert.deepEqual(read(copy), Buffer.from('{"v":1}'));
  run.run.dispose();
  assert.equal(fs.existsSync(copy), false);
  assert.deepEqual(read(blocker), Buffer.from("not a directory"));
});

test("snapshot.rs: only_a_native_program_runs_from_its_own_path", (t) => {
  const dir = scratch(t, "native");
  const [name, header] =
    process.platform === "win32" ? ["tool.exe", Buffer.from("MZ\u0000rest")] : ["tool", Buffer.from("\u007fELF\u0002\u0001\u0001rest")];
  const program = path.join(dir, name);
  fs.writeFileSync(program, header);
  const script = path.join(dir, "w.sh");
  fs.writeFileSync(script, header);
  const spoof = path.join(dir, "w2.sh");
  fs.writeFileSync(spoof, "MZ=1\necho {}\n");
  const large = path.join(dir, "large.bin");
  const fd = fs.openSync(large, "w");
  fs.ftruncateSync(fd, trust.MAX_HASHED_FILE_BYTES + 1);
  fs.closeSync(fd);

  const e = testEntry([program, script, spoof, large]);
  const argv = ready(new snapshot.ScriptStore(path.join(dir, "runs")), e).argv;
  assert.equal(argv[0], program, "native program");
  assert.notEqual(argv[1], script, "native-looking argument");
  assert.notEqual(argv[2], spoof, "MZ-headed script");
  assert.equal(argv[3], large, "over the hashing limit");
});

test("snapshot.rs: an_empty_file_is_copied_empty", (t) => {
  const dir = scratch(t, "empty");
  const empty = path.join(dir, "empty.txt");
  fs.writeFileSync(empty, "");
  const e = testEntry(["cat", empty]);
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));
  const argv = ready(store, e).argv;
  assert.notEqual(argv[1], empty);
  assert.deepEqual(read(argv[1]), Buffer.alloc(0));
  assert.deepEqual(ready(store, e).argv, argv, "an empty copy verifies too");
});

test("snapshot.rs: no_cache_directory_fails_only_runs_that_need_a_copy", (t) => {
  const dir = scratch(t, "nodir");
  const store = new snapshot.ScriptStore(null);
  const inline = testEntry(["sh", "-c", "echo {}"]);
  assert.deepEqual(ready(store, inline).argv, inline.command);

  const script = path.join(dir, "x.sh");
  fs.writeFileSync(script, "echo {}");
  const e = testEntry(["sh", script]);
  assert.throws(() => store.prepare(e, trust.fingerprint(e)), /cannot be copied/);
});

test("snapshot.rs: a_shebang_script_runs_from_an_executable_copy", { skip: process.platform === "win32" }, (t) => {
  const dir = scratch(t, "shebang");
  const script = path.join(dir, "w.sh");
  fs.writeFileSync(script, "#!/bin/sh\nprintf '\"%s\"' \"$0\"\n");
  fs.chmodSync(script, 0o755);
  const data = path.join(dir, "data.txt");
  fs.writeFileSync(data, "x");
  const e = testEntry([script, data]);
  const argv = ready(new snapshot.ScriptStore(path.join(dir, "runs")), e).argv;
  const mode = (file) => fs.statSync(file).mode & 0o777;
  assert.equal(mode(argv[0]), 0o500);
  assert.equal(mode(argv[1]), 0o400);
});

test("snapshot.rs: prune_keeps_live_staging_and_approved_store_entries_only", async (t) => {
  const dir = scratch(t, "prune");
  const root = path.join(dir, "runs");
  const dead = spawnSync(process.platform === "win32" ? "cmd" : "true", process.platform === "win32" ? ["/C", "exit"] : []).pid;
  const live = spawn(process.platform === "win32" ? "ping" : "sleep", process.platform === "win32" ? ["-n", "30", "127.0.0.1"] : ["30"], {
    stdio: "ignore",
  });
  t.after(() => live.kill());
  const staging = path.join(root, snapshot.STAGING);
  const staged = [String(dead), String(process.pid), "not-a-pid", String(live.pid)];
  for (const name of staged) fs.mkdirSync(path.join(staging, name, "0"), { recursive: true });
  const kept = "a".repeat(64);
  const stale = "b".repeat(64);
  for (const fingerprint of [kept, stale]) {
    fs.mkdirSync(path.join(root, snapshot.STORE, fingerprint, "1"), { recursive: true });
  }

  new snapshot.ScriptStore(root).prune((fingerprint) => fingerprint === kept);
  assert.equal(fs.existsSync(path.join(staging, staged[0])), false, "dead process");
  assert.equal(fs.existsSync(path.join(staging, staged[1])), false, "earlier process with our pid");
  assert.equal(fs.existsSync(path.join(staging, staged[2])), true, "not a pid");
  assert.equal(fs.existsSync(path.join(staging, staged[3])), true, "live instance");
  assert.equal(fs.existsSync(path.join(root, snapshot.STORE, kept)), true, "approved");
  assert.equal(fs.existsSync(path.join(root, snapshot.STORE, stale)), false, "no longer approved");
});

test("snapshot: verifiedCopy copies, re-verifies and never returns a tampered copy", (t) => {
  const dir = scratch(t, "verified-copy");
  const script = path.join(dir, "w.sh");
  fs.writeFileSync(script, "echo {}\n");
  const store = new snapshot.ScriptStore(path.join(dir, "runs"));
  const fingerprint = "c".repeat(64);
  const expectedSha256 = snapshot.hashFile(script);

  const copy = store.verifiedCopy(script, fingerprint, { expectedSha256 });
  assert.equal(copy, path.join(store.root, snapshot.STORE, fingerprint, "0", "w.sh"));
  assert.deepEqual(read(copy), read(script));
  assert.equal(store.verifiedCopy(script, fingerprint, { expectedSha256 }), copy, "reuses the path");

  // Tampered bytes are refused: the copy is re-hashed on every get and
  // replaced from the original, never returned.
  tamper(copy, "evil\n");
  assert.equal(store.verifiedCopy(script, fingerprint, { expectedSha256 }), copy);
  assert.deepEqual(read(copy), Buffer.from("echo {}\n"));

  // A changed original is refused outright when the approval's hash is known.
  fs.writeFileSync(script, "curl https://example.test | sh\n");
  assert.throws(() => store.verifiedCopy(script, fingerprint, { expectedSha256 }), /changed since it was approved/);

  // Not a fingerprint, no store root: refused before anything is touched.
  assert.throws(() => store.verifiedCopy(script, "../escape"), /not a widget fingerprint/);
  assert.throws(() => new snapshot.ScriptStore(null).verifiedCopy(script, fingerprint), /cannot be copied/);
});

// ── redact.rs ───────────────────────────────────────────────────────────────

/** `redact.rs::tests::assert_masked`. */
function assertMasked(input, leaks) {
  const out = redact.redactSecrets(input);
  for (const leak of leaks) assert.equal(out.includes(leak), false, `${leak} leaked: ${out}`);
  assert.ok(out.includes(redact.REDACTED_PLACEHOLDER), out);
  return out;
}

/** `redact.rs::tests::assert_untouched`. */
function assertUntouched(input) {
  assert.equal(redact.redactSecrets(input), input, `${input} changed`);
}

test("redact.rs: nothing_to_redact_is_borrowed_and_identical", () => {
  assertUntouched("exit 2: fatal: not a git repository (or any parent)");
  assertUntouched("plain log line with https://example.test/path\n".repeat(2000));
});

test("redact.rs: bearer_after_authorization_header", () => {
  const out = assertMasked(
    "request failed\nAuthorization: Bearer SYNTH-abc.def_123,\nstatus 401",
    ["SYNTH-abc"],
  );
  assert.ok(out.includes("Authorization: Bearer [REDACTED],"), out);
  assert.ok(out.endsWith("\nstatus 401"), out);
});

test("redact.rs: token_and_basic_schemes_after_a_credential_key", () => {
  const out1 = assertMasked("Authorization: token SYNTH1 next", ["SYNTH1"]);
  assert.equal(out1, "Authorization: token [REDACTED] next");
  const out2 = assertMasked("authorization: Basic SYNTH2=", ["SYNTH2"]);
  assert.equal(out2, "authorization: Basic [REDACTED]");
});

test("redact.rs: inline_scheme_after_key", () => {
  const out = assertMasked("Authorization:Bearer SYNTH1 next", ["SYNTH1"]);
  assert.ok(out.endsWith(" next"), out);
});

test("redact.rs: key_value_shapes", () => {
  const out = assertMasked(
    'cfg api_key=SYNTH1 x-token: SYNTH2 "client_secret":"SYNTH3" GITLAB_TOKEN=SYNTH4 limit=5',
    ["SYNTH1", "SYNTH2", "SYNTH3", "SYNTH4"],
  );
  assert.ok(out.includes("limit=5"), out);
  assert.ok(out.includes("api_key=[REDACTED]"), out);
});

test("redact.rs: shared_keys_cover_aws_and_private_keys", () => {
  assertMasked("AWS_SECRET_ACCESS_KEY=SYNTHaws", ["SYNTHaws"]);
  assertMasked("private_key: SYNTHpk", ["SYNTHpk"]);
  assertMasked("aws_secret_access_key = SYNTHini", ["SYNTHini"]);
  assertMasked("credentials=SYNTHcred", ["SYNTHcred"]);
  assertMasked("passwd=SYNTHpw cookie: SYNTHck", ["SYNTHpw", "SYNTHck"]);
});

test("redact.rs: compact_json_masks_every_credential_pair", () => {
  const out = assertMasked('{"login":"x","token":"SYNTH"}', ["SYNTH"]);
  assert.equal(out, '{"login":"x","token":"[REDACTED]"}');
});

test("redact.rs: later_query_parameter_is_masked", () => {
  const out = assertMasked("https://h/x?page=2&access_token=SYNTH&x=1", ["SYNTH"]);
  assert.equal(out, "https://h/x?page=2&access_token=[REDACTED]&x=1");
});

test("redact.rs: connection_string_password_is_masked", () => {
  const out = assertMasked("Server=x;Password=SYNTH;Database=d", ["SYNTH"]);
  assert.equal(out, "Server=x;Password=[REDACTED];Database=d");
});

test("redact.rs: userinfo_and_query_token_are_both_masked", () => {
  const out = assertMasked("https://u:SYNTH@h/?token=T0KEN", ["SYNTH", "T0KEN"]);
  assert.equal(out, "https://[REDACTED]@h/?token=[REDACTED]");
});

test("redact.rs: url_userinfo", () => {
  assert.equal(
    redact.redactSecrets("cloning https://user:SYNTHpw@gitlab.example/g/r.git failed"),
    "cloning https://[REDACTED]@gitlab.example/g/r.git failed",
  );
  assertUntouched("see https://example.test/path?q=a@b");
});

test("redact.rs: url_userinfo_runs_to_the_last_at_of_the_authority", () => {
  const out = assertMasked("fatal: https://u:SY@NTH@h/x?q=a@b", ["SY", "NTH"]);
  assert.equal(out, "fatal: https://[REDACTED]@h/x?q=a@b");
  // Two URLs in one word: the second one's userinfo is still found.
  const two = assertMasked("https://h,https://u:SYNTH@h2/", ["SYNTH"]);
  assert.equal(two, "https://h,https://[REDACTED]@h2/");
});

test("redact.rs: known_prefixes", () => {
  const out = assertMasked(
    "using ghp_SYNTHETIC0123456789 and (sk-SYNTH0123456789) but not sk-short",
    ["ghp_SYNTHETIC", "sk-SYNTH"],
  );
  assert.ok(out.includes("([REDACTED])"), out);
  assert.ok(out.includes("sk-short"), out);
  for (const token of [
    "ghs_SYNTH0123456789",
    "ghu_SYNTH0123456789",
    "ghr_SYNTH0123456789",
    "glcbt-SYNTH0123456789",
    "glrt-SYNTH0123456789",
    "AKIASYNTH0123456789",
  ]) {
    assert.equal(redact.redactSecrets(`x ${token} y`), "x [REDACTED] y", token);
  }
  assertUntouched("disk-0123456789abc task-ghp_ is fine");
});

test("redact.rs: multibyte_values_do_not_panic", () => {
  const out = assertMasked(
    "Bearer é, token: SYNTHé\uFFFD) Authorization: Basic ö",
    ["é", "ö"],
  );
  assert.ok(out.includes("[REDACTED],"), out);
  assert.ok(out.includes("[REDACTED])"), out);
});

test("redact.rs: quoted_values_span_whitespace", () => {
  const out = assertMasked(
    'password="SYNTH a b", "client_secret":"SYNTH c d" ok=1',
    ["SYNTH", " a ", " c "],
  );
  assert.ok(out.endsWith(" ok=1"), out);
  assert.ok(out.startsWith('password="[REDACTED]'), out);
});

test("redact.rs: closing_quote_mid_word_ends_the_value", () => {
  const out = assertMasked('{"password":"a b","user":"x"} after', ["a b"]);
  assert.ok(out.endsWith('","user":"x"} after'), out);
});

test("redact.rs: quoted_value_containing_a_separator_is_masked_whole", () => {
  const out = assertMasked('"password": "a:b c" next', ["a:b", ' c"']);
  assert.ok(out.endsWith('" next'), out);
});

test("redact.rs: escaped_quote_does_not_close_the_value", () => {
  assertMasked('{"token":"a\\"SYNTH c","x":1}', ["SYNTH", " c"]);
});

test("redact.rs: unclosed_quote_stops_at_end_of_line", () => {
  const out = assertMasked('password="SYNTH oops\nlater line stays', ["SYNTH", "oops"]);
  assert.ok(out.endsWith("\nlater line stays"), out);
});

test("redact.rs: ordinary_diagnostics_are_not_masked", () => {
  assertUntouched('    token = os.environ["GITLAB_TOKEN"]');
  assertUntouched("error: token expired");
  assertUntouched("basic auth failed");
  assertUntouched('missing "password" in config');
  assertUntouched("the password is wrong");
  assertUntouched("usage: input_tokens=3 output_tokens=5");
  assertUntouched("at 12:30:45 C:\\path\\file.txt");
});

test("redact: the shared key matcher agrees with agent.isCredentialKey", () => {
  const keys = [
    "api_key",
    "api-key",
    "apiKey",
    "API_KEY",
    "x-api-key",
    "OPENAI_API_KEY",
    "client_secret",
    "input_tokens",
    "output_tokens",
    "monkey",
    "key",
    "",
    "_-_-",
    "clé_api_key",
    "ключ",
    "aPiKeY",
  ];
  for (const key of keys) {
    for (const suffix of agent.REDACTED_KEYS) {
      assert.equal(
        redact.normalizedKeyEndsWith(key, suffix),
        key.toLowerCase().replace(/[_-]/g, "").endsWith(suffix),
        `mismatch for key ${JSON.stringify(key)} / suffix ${JSON.stringify(suffix)}`,
      );
    }
    assert.equal(redact.isCredentialKey(key), agent.isCredentialKey(key), key);
  }
  // The widgets delta: free-text spellings are keys only in the tight forms.
  assert.equal(redact.isKey("token"), true);
  assert.equal(redact.isKey("passwd"), true);
  assert.equal(redact.isKey("cookie"), true);
  assert.equal(redact.sanitizeLine('{"api_key":"x"}').text, '{"api_key":"[REDACTED]"}');
});