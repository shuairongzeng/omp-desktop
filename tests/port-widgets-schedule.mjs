/* Port parity tests for electron/backend/widgets/schedule.js.

   Every case in src-tauri/src/widgets/schedule.rs's #[cfg(test)] table is
   ported one-to-one (same name, same sequence of events and clock moves), plus
   the pure-helper cases from config.rs (`path_matches`, `matches`, `wants`)
   that the scheduler depends on.

   Run with: node tests/port-widgets-schedule.mjs */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schedule = require('../electron/backend/widgets/schedule.js');

const {
  GLOBAL_KEY,
  MAX_CONCURRENT_RUNS,
  TRIGGER,
  PHASE,
  createScheduler,
  pathMatches,
  pluginMatches,
  pluginWants,
  normalizePlugin,
  bit,
  bits,
  dueNow,
  rearm,
  clampTimerDue,
  timerWanted,
} = schedule;

const { ACTIVATE, TURN_END, BRANCH, MANUAL, INTERVAL } = TRIGGER;
const MIN = 60_000;

// ── fixtures (mirroring the Rust test helpers) ──────────────────────────────

function plugin(id, scope, triggers, intervalMs = null) {
  return {
    id,
    title: id,
    command: ['x'],
    matchPath: null,
    matchRemote: null,
    triggers,
    timeoutMs: 1_000,
    intervalMs,
    enabled: true,
    scope,
  };
}

const tab = (id) => plugin(id, 'tab', [ACTIVATE, TURN_END, BRANCH]);
const globalPlugin = (id) => plugin(id, 'global', [ACTIVATE, TURN_END, BRANCH]);
const key = (scopeKey, pluginId) => ({ scopeKey, pluginId });

const ok = () => ({ ok: true, value: '{}', error: null, durationMs: 3 });
const err = (message) => ({ ok: false, value: null, error: message, durationMs: 3 });

/** `[scopeKey, pluginId, session, trigger]` of every start action. */
function starts(actions) {
  return actions
    .filter((a) => a.type === 'start')
    .map((a) => [a.key.scopeKey, a.key.pluginId, a.session, a.trigger]);
}

/** `[scopeKey, pluginId]` of every kill action. */
function kills(actions) {
  return actions
    .filter((a) => a.type === 'kill')
    .map((a) => [a.key.scopeKey, a.key.pluginId]);
}

/** `[scopeKey, pluginId]` of every removed action, sorted. */
function removed(actions) {
  return actions
    .filter((a) => a.type === 'removed')
    .map((a) => [a.key.scopeKey, a.key.pluginId])
    .sort((x, y) => x.join('\u0000').localeCompare(y.join('\u0000')));
}

/** A scheduler with a clock: rail and window visible, every plugin approved. */
class H {
  constructor(plugins) {
    this.s = createScheduler({ now: () => this.now });
    this.now = 1_000_000;
    this.view = {
      session: null,
      railVisible: true,
      windowVisible: true,
      hidden: new Set(),
    };
    this.config(plugins);
    this.pushView();
  }

  ev(event) {
    return this.s.handle(event, this.now);
  }

  config(plugins, approved) {
    const ids = approved ?? new Set(plugins.map((p) => p.id));
    return this.ev({ type: 'config', plugins, approved: ids });
  }

  pushView() {
    return this.ev({
      type: 'view',
      view: { ...this.view, hidden: new Set(this.view.hidden) },
    });
  }

  open(session, project) {
    return this.openCtx(session, project, '', 'main');
  }

  openCtx(session, project, remote, branch) {
    return this.ev({ type: 'session_opened', session, ctx: { project, remote, branch } });
  }

  activate(session) {
    this.view.session = session;
    return this.pushView();
  }

  seq(k) {
    const state = this.s.run(k);
    assert.ok(state, 'run state');
    return state.seq;
  }

  phase(k) {
    const state = this.s.run(k);
    assert.ok(state, 'run state');
    return state.phase;
  }

  /** Finishes the current run of `k`. */
  finish(k, outcome) {
    return this.finishSeq(k, this.seq(k), outcome);
  }

  finishSeq(k, seq, outcome) {
    return this.ev({ type: 'finished', key: { ...k }, seq, outcome });
  }

  turnEnd(session) {
    return this.ev({ type: 'turn_end', session });
  }

  branch(session, name) {
    return this.ev({ type: 'branch', session, branch: name });
  }

  manual(id) {
    return this.ev({ type: 'manual', pluginId: id });
  }

  /** Advances the clock to the next deadline and ticks. */
  tickToDeadline() {
    this.now = this.s.nextDeadline();
    assert.notEqual(this.now, null, 'a timer');
    return this.ev({ type: 'tick' });
  }

  /** Opens and activates `s1` (project `/p`) and finishes the activation runs. */
  static settled(plugins) {
    const h = new H(plugins);
    h.open('s1', '/p');
    const actions = h.activate('s1');
    const keys = actions.filter((a) => a.type === 'start').map((a) => a.key);
    for (const k of keys) h.finish(k, ok());
    return h;
  }
}

// ── start / finish / coalescing ─────────────────────────────────────────────

test('activation_starts_a_run_with_a_fresh_seq', () => {
  const h = new H([tab('git')]);
  h.open('s1', '/p');
  const a = h.activate('s1');
  assert.deepEqual(starts(a), [['s1', 'git', 's1', ACTIVATE]]);
  const st = h.s.run(key('s1', 'git'));
  assert.ok(st);
  assert.equal(st.phase, PHASE.RUNNING);
  assert.equal(st.trigger, ACTIVATE);
  assert.equal(st.seq, 1);
  assert.ok(a.some((x) => x.type === 'changed' && x.key.scopeKey === 's1' && x.key.pluginId === 'git'));
});

test('triggers_while_running_coalesce_and_latest_wins', () => {
  const h = new H([tab('git')]);
  h.open('s1', '/p');
  h.activate('s1');
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  assert.deepEqual(starts(h.manual('git')), []);
  const st = h.s.run(key('s1', 'git'));
  assert.equal(st.queued, MANUAL, 'latest trigger wins');
  assert.equal(st.seq, 1, 'no second run');
});

test('finish_runs_the_queued_follow_up_once', () => {
  const h = new H([tab('git')]);
  h.open('s1', '/p');
  h.activate('s1');
  h.branch('s1', 'dev');
  const a = h.finish(key('s1', 'git'), ok());
  assert.deepEqual(starts(a), [['s1', 'git', 's1', BRANCH]]);
  const st = h.s.run(key('s1', 'git'));
  assert.equal(st.queued, null);
  assert.equal(st.phase, PHASE.RUNNING);
  assert.deepEqual(st.last.outcome, ok());
  const again = h.finish(key('s1', 'git'), ok());
  assert.deepEqual(starts(again), [], 'no second follow-up');
});

test('interval_never_overwrites_a_queued_non_interval_trigger', () => {
  const h = new H([plugin('t', 'tab', [ACTIVATE, TURN_END], MIN)]);
  h.open('s1', '/p');
  h.activate('s1');
  h.turnEnd('s1');
  h.tickToDeadline();
  const k = key('s1', 't');
  assert.equal(h.s.run(k).queued, TURN_END);
  h.manual('t');
  assert.equal(h.s.run(k).queued, MANUAL, 'non-interval still replaces');
});

test('interval_queues_when_nothing_else_is_queued', () => {
  const h = new H([plugin('t', 'tab', [ACTIVATE], MIN)]);
  h.open('s1', '/p');
  h.activate('s1');
  h.tickToDeadline();
  assert.equal(h.s.run(key('s1', 't')).queued, INTERVAL);
});

test('stale_or_unknown_results_are_ignored', () => {
  const h = H.settled([tab('git')]);
  const k = key('s1', 'git');
  const oldSeq = h.seq(k);
  h.manual('git');
  const fresh = h.seq(k);
  assert.notEqual(oldSeq, fresh);
  const a = h.finishSeq(k, oldSeq, err('old'));
  assert.deepEqual(a, []);
  assert.equal(h.phase(k), PHASE.RUNNING, 'old seq must not overwrite');
  const unknown = h.ev({
    type: 'finished',
    key: key('s9', 'git'),
    seq: fresh,
    outcome: ok(),
  });
  assert.deepEqual(unknown, [], 'unknown key');
  h.finish(k, ok());
  assert.equal(h.phase(k), PHASE.IDLE);
  const dup = h.finishSeq(k, fresh, err('dup'));
  assert.deepEqual(dup, [], 'an idle run takes no result');
  assert.deepEqual(h.s.run(k).last.outcome, ok());
});

test('a_late_result_lands_in_its_own_session', () => {
  const h = new H([tab('git')]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  h.activate('s2');
  assert.equal(h.phase(key('s2', 'git')), PHASE.RUNNING);
  h.finish(key('s1', 'git'), err('boom'));
  const s1 = h.s.run(key('s1', 'git'));
  assert.deepEqual(s1.last.outcome, err('boom'));
  assert.equal(h.phase(key('s2', 'git')), PHASE.RUNNING);
});

test('errors_keep_the_last_ok_time_and_the_previous_result_stays_while_running', () => {
  const h = new H([tab('git')]);
  h.open('s1', '/p');
  h.activate('s1');
  const k = key('s1', 'git');
  const t1 = h.now;
  h.finish(k, ok());
  h.now += 1_000;
  h.manual('git');
  let st = h.s.run(k);
  assert.equal(st.last.at, t1, 'kept while running');
  h.finish(k, err('x'));
  st = h.s.run(k);
  assert.equal(st.lastOkAt, t1);
  assert.equal(st.last.at, t1 + 1_000);
  assert.equal(st.trigger, MANUAL, 'trigger of the last finished run');
});

// ── sessions ────────────────────────────────────────────────────────────────

test('session_close_kills_and_removes_its_runs_only', () => {
  const h = new H([tab('t'), globalPlugin('g')]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s2');
  h.finish(key('s2', 't'), ok());
  h.finish(key(GLOBAL_KEY, 'g'), ok());
  h.activate('s1');
  // s1: t running, g fresh (no interval → also runs).
  const a = h.ev({ type: 'session_closed', session: 's1' });
  assert.deepEqual(kills(a), [['s1', 't']]);
  assert.deepEqual(removed(a), [['s1', 't']]);
  assert.equal(h.s.run(key('s1', 't')), null);
  assert.ok(h.s.run(key('s2', 't')));
  assert.ok(h.s.run(key(GLOBAL_KEY, 'g')), 'global survives');
  assert.equal(h.s.sessionCtx('s1'), null);
  assert.deepEqual(h.s.activeApplicable(), { active: null, ids: [] });
});

test('closing_the_active_session_stops_everything_until_it_reopens', () => {
  const h = H.settled([plugin('t', 'tab', [ACTIVATE, TURN_END], MIN)]);
  h.ev({ type: 'session_closed', session: 's1' });
  assert.equal(h.s.nextDeadline(), null, 'tab timers die with the active tab');
  assert.deepEqual(starts(h.manual('t')), []);
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  // A profile switch respawns the tab under the same id and the frontend does
  // not re-send its view: the reopened id is active again.
  assert.deepEqual(
    starts(h.open('s1', '/p')),
    [['s1', 't', 's1', ACTIVATE]],
    'a re-opened id is a fresh session',
  );
});

test('follow_up_is_suppressed_for_a_closed_tab', () => {
  const h = new H([tab('t')]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  h.turnEnd('s1');
  const seq = h.seq(key('s1', 't'));
  h.ev({ type: 'session_closed', session: 's1' });
  const a = h.ev({ type: 'finished', key: key('s1', 't'), seq, outcome: ok() });
  assert.deepEqual(a, []);
});

test('unknown_sessions_are_ignored', () => {
  const h = new H([tab('t')]);
  assert.deepEqual(h.turnEnd('nope'), []);
  assert.deepEqual(h.branch('nope', 'x'), []);
  assert.deepEqual(h.ev({ type: 'session_closed', session: 'nope' }), []);
  assert.deepEqual(starts(h.activate('nope')), [], 'view on an unknown session');
  assert.deepEqual(h.manual('t'), []);
  assert.equal(h.s.runs.size, 0);
});

test('a_view_sent_before_session_opened_activates_once_it_opens', () => {
  const h = new H([tab('t')]);
  assert.deepEqual(starts(h.activate('s1')), []);
  assert.deepEqual(starts(h.open('s1', '/p')), [['s1', 't', 's1', ACTIVATE]]);
});

// ── activation ──────────────────────────────────────────────────────────────

test('switching_tabs_activates_the_new_tab', () => {
  const h = H.settled([tab('a'), plugin('b', 'tab', [TURN_END], null)]);
  h.open('s2', '/q');
  const a = h.activate('s2');
  assert.deepEqual(starts(a), [['s2', 'a', 's2', ACTIVATE]], 'b does not want activate');
  h.finish(key('s2', 'a'), ok());
  const back = h.activate('s1');
  assert.deepEqual(starts(back), [['s1', 'a', 's1', ACTIVATE]], 'back again re-activates');
});

test('same_view_again_starts_nothing', () => {
  const h = H.settled([tab('a')]);
  assert.deepEqual(h.pushView(), []);
  assert.deepEqual(h.open('s1', '/p'), [], 'ctx refresh without match change');
});

test('global_plugins_run_on_activation_only_without_a_fresh_result', () => {
  const h = new H([
    plugin('gi', 'global', [ACTIVATE], MIN),
    plugin('gn', 'global', [ACTIVATE], null),
    plugin('gx', 'global', [TURN_END], MIN),
  ]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  const a = h.activate('s1');
  assert.deepEqual(
    starts(a),
    [
      [GLOBAL_KEY, 'gi', 's1', ACTIVATE],
      [GLOBAL_KEY, 'gn', 's1', ACTIVATE],
    ],
    'gx does not want activate',
  );
  // First run still in flight: a tab switch skips gi, gn coalesces.
  const b = h.activate('s2');
  assert.deepEqual(starts(b), []);
  assert.equal(h.s.run(key(GLOBAL_KEY, 'gi')).queued, null);
  assert.equal(h.s.run(key(GLOBAL_KEY, 'gn')).queued, ACTIVATE);
  h.finish(key(GLOBAL_KEY, 'gi'), ok());
  const c = h.finish(key(GLOBAL_KEY, 'gn'), ok());
  assert.deepEqual(starts(c), [[GLOBAL_KEY, 'gn', 's2', ACTIVATE]], 'follow-up uses the active tab');
  h.finish(key(GLOBAL_KEY, 'gn'), ok());
  h.now += MIN - 1;
  const d = h.activate('s1');
  assert.deepEqual(
    starts(d),
    [[GLOBAL_KEY, 'gn', 's1', ACTIVATE]],
    'fresh gi skipped; no interval = always',
  );
  h.finish(key(GLOBAL_KEY, 'gn'), ok());
  h.now += 1;
  const e = h.activate('s2');
  assert.deepEqual(
    starts(e),
    [
      [GLOBAL_KEY, 'gi', 's2', ACTIVATE],
      [GLOBAL_KEY, 'gn', 's2', ACTIVATE],
    ],
    'stale gi runs',
  );
});

test('a_global_result_is_shared_across_tabs', () => {
  const h = new H([plugin('g', 'global', [ACTIVATE], MIN)]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  h.finish(key(GLOBAL_KEY, 'g'), ok());
  h.activate('s2');
  const st = h.s.run(key(GLOBAL_KEY, 'g'));
  assert.equal(st.last.at, h.now);
  assert.equal(h.s.runs.size, 1);
  assert.deepEqual(starts(h.manual('g')), [[GLOBAL_KEY, 'g', 's2', MANUAL]], 'refresh from another tab');
});

test('hiding_or_showing_one_plugin_runs_only_that_plugin', () => {
  const h = H.settled([tab('a'), tab('b'), globalPlugin('g')]);
  h.view.hidden.add('b');
  assert.deepEqual(h.pushView(), [], 'hiding starts nothing');
  assert.deepEqual(starts(h.manual('b')), [], 'hidden = no runs');
  h.view.hidden.clear();
  assert.deepEqual(starts(h.pushView()), [['s1', 'b', 's1', ACTIVATE]]);
});

test('approving_one_plugin_runs_only_that_plugin', () => {
  const h = new H([]);
  h.ev({
    type: 'config',
    plugins: [tab('a'), tab('b')],
    approved: new Set(['a']),
  });
  h.open('s1', '/p');
  assert.deepEqual(starts(h.activate('s1')), [['s1', 'a', 's1', ACTIVATE]]);
  h.finish(key('s1', 'a'), ok());
  assert.deepEqual(starts(h.manual('b')), [], 'pending approval = no runs');
  const a = h.config([tab('a'), tab('b')]);
  assert.deepEqual(starts(a), [['s1', 'b', 's1', ACTIVATE]]);
});

test('hidden_rail_runs_nothing_and_showing_it_activates', () => {
  const h = new H([tab('a'), plugin('b', 'tab', [TURN_END], null)]);
  h.view.railVisible = false;
  h.pushView();
  h.open('s1', '/p');
  assert.deepEqual(starts(h.activate('s1')), []);
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  assert.deepEqual(starts(h.manual('a')), []);
  h.view.railVisible = true;
  const a = h.pushView();
  assert.deepEqual(
    starts(a),
    [
      ['s1', 'a', 's1', ACTIVATE],
      ['s1', 'b', 's1', TURN_END],
    ],
    'a activates; b replays the turn end it missed',
  );
});

test('match_is_enforced_per_session_and_rechecked_on_ctx_change', () => {
  const w = tab('w');
  w.matchPath = '/work';
  const r = tab('r');
  r.matchRemote = 'gitlab';
  const h = new H([w, r]);
  h.openCtx('s1', '/home/x', 'github.com/x', 'main');
  assert.deepEqual(starts(h.activate('s1')), []);
  assert.deepEqual(starts(h.manual('w')), [], 'manual needs a match too');
  const a = h.openCtx('s1', '/home/x', 'gitlab.com/x', 'main');
  assert.deepEqual(starts(a), [['s1', 'r', 's1', ACTIVATE]], 'remote now matches');
  h.openCtx('s2', '/work/y', '', 'main');
  assert.deepEqual(starts(h.activate('s2')), [['s2', 'w', 's2', ACTIVATE]]);
});

test('disabled_plugins_never_run', () => {
  const p = tab('d');
  p.enabled = false;
  p.intervalMs = MIN;
  const h = new H([p]);
  h.open('s1', '/p');
  assert.deepEqual(starts(h.activate('s1')), []);
  assert.deepEqual(starts(h.manual('d')), []);
  assert.equal(h.s.nextDeadline(), null, 'no timer');
});

// ── turn_end / branch / dirty ───────────────────────────────────────────────

test('turn_end_runs_wanting_plugins_of_the_active_tab', () => {
  const h = H.settled([
    tab('a'),
    plugin('b', 'tab', [ACTIVATE], null),
    globalPlugin('g'),
  ]);
  const a = h.turnEnd('s1');
  assert.deepEqual(starts(a), [
    ['s1', 'a', 's1', TURN_END],
    [GLOBAL_KEY, 'g', 's1', TURN_END],
  ]);
});

test('background_triggers_are_flushed_once_on_activation', () => {
  const h = H.settled([
    plugin('a', 'tab', [ACTIVATE, TURN_END], null),
    plugin('b', 'tab', [TURN_END, BRANCH], null),
    plugin('c', 'tab', [BRANCH], null),
    plugin('g', 'global', [TURN_END], null),
  ]);
  h.open('s2', '/q');
  assert.deepEqual(starts(h.activate('s2')), [['s2', 'a', 's2', ACTIVATE]]);
  h.finish(key('s2', 'a'), ok());
  // Background s1: nothing runs now.
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  h.openCtx('s1', '/p', '', 'dev');
  assert.deepEqual(starts(h.branch('s1', 'dev')), []);
  const a = h.activate('s1');
  assert.deepEqual(
    starts(a),
    [
      ['s1', 'a', 's1', ACTIVATE],
      ['s1', 'b', 's1', BRANCH],
      ['s1', 'c', 's1', BRANCH],
    ],
    'one run per plugin; latest dirty trigger; globals are not replayed',
  );
  for (const id of ['a', 'b', 'c']) h.finish(key('s1', id), ok());
  h.activate('s2');
  const again = h.activate('s1');
  assert.deepEqual(starts(again), [['s1', 'a', 's1', ACTIVATE]], 'flushed only once');
});

test('hidden_window_defers_turn_end_until_visible', () => {
  const h = H.settled([plugin('b', 'tab', [TURN_END], null)]);
  h.view.windowVisible = false;
  h.pushView();
  assert.deepEqual(starts(h.turnEnd('s1')), []);
  h.view.windowVisible = true;
  assert.deepEqual(starts(h.pushView()), [['s1', 'b', 's1', TURN_END]]);
  assert.deepEqual(starts(h.pushView()), [], 'once');
});

test('branch_is_deduplicated_and_the_first_one_only_recorded', () => {
  const h = new H([tab('a')]);
  h.openCtx('s1', '/p', '', '');
  h.activate('s1');
  h.finish(key('s1', 'a'), ok());
  assert.deepEqual(starts(h.branch('s1', 'main')), [], 'first seen only records');
  assert.deepEqual(starts(h.branch('s1', 'main')), [], 'same branch');
  assert.deepEqual(starts(h.branch('s1', 'dev')), [['s1', 'a', 's1', BRANCH]]);
  h.finish(key('s1', 'a'), ok());
  assert.deepEqual(starts(h.branch('s1', 'dev')), []);
});

test('the_branch_a_session_opened_on_counts_as_seen', () => {
  const h = H.settled([tab('a')]);
  assert.deepEqual(starts(h.branch('s1', 'main')), [], 'opened on main');
  h.openCtx('s1', '/p', '', 'dev');
  assert.deepEqual(starts(h.branch('s1', 'dev')), [['s1', 'a', 's1', BRANCH]]);
});

// ── manual ──────────────────────────────────────────────────────────────────

test('manual_ignores_the_trigger_list_but_needs_an_active_tab', () => {
  const h = new H([plugin('m', 'tab', [], null)]);
  h.open('s1', '/p');
  assert.deepEqual(starts(h.manual('m')), [], 'no active tab');
  assert.deepEqual(starts(h.activate('s1')), []);
  assert.deepEqual(starts(h.manual('m')), [['s1', 'm', 's1', MANUAL]]);
  assert.deepEqual(starts(h.manual('nope')), []);
});

// ── intervals ───────────────────────────────────────────────────────────────

test('interval_ticks_run_and_re_arm', () => {
  const h = H.settled([plugin('t', 'tab', [ACTIVATE], MIN)]);
  const start = h.now;
  assert.equal(h.s.nextDeadline(), start + MIN);
  assert.deepEqual(h.ev({ type: 'tick' }), [], 'not due yet');
  const a = h.tickToDeadline();
  assert.deepEqual(starts(a), [['s1', 't', 's1', INTERVAL]]);
  assert.equal(h.s.nextDeadline(), start + 2 * MIN);
});

test('hidden_window_pauses_ticks_and_catches_up_once_when_visible', () => {
  const h = H.settled([
    plugin('t', 'tab', [ACTIVATE], MIN),
    plugin('f', 'tab', [ACTIVATE], 10 * MIN),
  ]);
  h.view.windowVisible = false;
  h.pushView();
  const a = h.tickToDeadline();
  assert.deepEqual(starts(a), [], 'paused while hidden');
  assert.equal(h.s.nextDeadline(), h.now + MIN, 're-armed anyway');
  h.now += 1;
  h.view.windowVisible = true;
  const b = h.pushView();
  assert.deepEqual(starts(b), [['s1', 't', 's1', INTERVAL]], 'due one catches up; f is fresh');
  assert.equal(h.s.nextDeadline(), h.now + MIN, 'timer restarted');
  assert.deepEqual(starts(h.pushView()), []);
});

test('catch_up_treats_a_run_in_flight_as_fresh', () => {
  const h = new H([plugin('t', 'tab', [ACTIVATE], MIN)]);
  h.open('s1', '/p');
  h.activate('s1');
  h.view.windowVisible = false;
  h.pushView();
  h.now += 10 * MIN;
  h.view.windowVisible = true;
  assert.deepEqual(starts(h.pushView()), []);
  assert.equal(h.s.run(key('s1', 't')).queued, null);
});

test('tab_timers_follow_the_active_tab_and_restart_on_switch', () => {
  const h = H.settled([plugin('t', 'tab', [], MIN)]);
  h.open('s2', '/q');
  h.now += MIN / 2;
  assert.deepEqual(starts(h.activate('s2')), [], 'no activate trigger');
  assert.equal(h.s.nextDeadline(), h.now + MIN, 're-armed on switch');
  const a = h.tickToDeadline();
  assert.deepEqual(starts(a), [['s2', 't', 's2', INTERVAL]], 'runs for the active tab only');
});

test('global_timer_survives_tab_switches_and_rechecks_match', () => {
  const g = plugin('g', 'global', [], MIN);
  g.matchPath = '/work';
  const h = new H([g]);
  h.open('s1', '/work/a');
  h.open('s2', '/home/b');
  h.activate('s1');
  const due = h.s.nextDeadline();
  h.now += MIN / 2;
  h.activate('s2');
  assert.equal(h.s.nextDeadline(), due, 'not re-armed by a tab switch');
  assert.deepEqual(starts(h.tickToDeadline()), [], 'active tab does not match');
  h.activate('s1');
  assert.deepEqual(starts(h.tickToDeadline()), [[GLOBAL_KEY, 'g', 's1', INTERVAL]]);
});

test('global_follow_up_rechecks_match_against_the_active_tab', () => {
  const g = globalPlugin('g');
  g.matchPath = '/proj/a';
  const h = new H([g]);
  h.open('s1', '/proj/a/sub');
  h.open('s2', '/proj/b');
  h.activate('s1');
  h.turnEnd('s1');
  h.activate('s2');
  const a = h.finish(key(GLOBAL_KEY, 'g'), ok());
  assert.deepEqual(starts(a), [], 'active project no longer matches');
  assert.equal(h.s.run(key(GLOBAL_KEY, 'g')).queued, null);
});

test('interval_follow_ups_need_a_visible_window_and_for_tabs_the_active_tab', () => {
  const plugins = () => [
    plugin('t', 'tab', [ACTIVATE, TURN_END], MIN),
    plugin('g', 'global', [ACTIVATE], MIN),
  ];
  // Tab plugin, its tab no longer active.
  const h = new H(plugins());
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  h.tickToDeadline();
  h.activate('s2');
  const a = h.finish(key('s1', 't'), ok());
  assert.deepEqual(starts(a), [], 'tab interval follow-up needs its tab active');
  const b = h.finish(key(GLOBAL_KEY, 'g'), ok());
  assert.deepEqual(starts(b), [[GLOBAL_KEY, 'g', 's2', INTERVAL]], 'global ignores the tab');
  // Hidden window.
  const hidden = new H(plugins());
  hidden.open('s1', '/p');
  hidden.activate('s1');
  hidden.tickToDeadline();
  hidden.view.windowVisible = false;
  hidden.pushView();
  assert.deepEqual(starts(hidden.finish(key('s1', 't'), ok())), []);
  assert.deepEqual(starts(hidden.finish(key(GLOBAL_KEY, 'g'), ok())), []);
});

test('non_interval_follow_ups_run_for_background_tabs', () => {
  const h = new H([tab('t')]);
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  h.turnEnd('s1');
  h.activate('s2');
  const a = h.finish(key('s1', 't'), ok());
  assert.deepEqual(starts(a), [['s1', 't', 's1', TURN_END]]);
});

test('non_interval_follow_ups_respect_the_rail', () => {
  const h = new H([tab('t')]);
  h.open('s1', '/p');
  h.activate('s1');
  h.turnEnd('s1');
  h.view.railVisible = false;
  h.pushView();
  assert.deepEqual(starts(h.finish(key('s1', 't'), ok())), []);
});

test('clock_going_backwards_neither_panics_nor_stalls_timers', () => {
  const h = H.settled([
    plugin('t', 'tab', [ACTIVATE], MIN),
    plugin('g', 'global', [ACTIVATE], MIN),
  ]);
  h.now = 5;
  assert.deepEqual(h.ev({ type: 'tick' }), []);
  assert.equal(h.s.nextDeadline(), 5 + MIN, 'clamped to one interval');
  h.view.windowVisible = false;
  h.pushView();
  h.view.windowVisible = true;
  assert.deepEqual(starts(h.pushView()), [], 'a future finish time is fresh');
  h.now = 0;
  h.finish(key('s1', 't'), ok());
  assert.equal(starts(h.tickToDeadline()).length, 2);
});

// ── concurrency ─────────────────────────────────────────────────────────────

test('concurrency_is_capped_with_fifo_promotion', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const h = new H(ids.map(tab));
  h.open('s1', '/p');
  const a = h.activate('s1');
  assert.equal(starts(a).length, MAX_CONCURRENT_RUNS);
  assert.equal(h.phase(key('s1', 'e')), PHASE.WAITING);
  assert.equal(h.phase(key('s1', 'f')), PHASE.WAITING);
  // A trigger on a waiting run coalesces.
  h.manual('e');
  assert.equal(h.s.run(key('s1', 'e')).queued, MANUAL);
  const b = h.finish(key('s1', 'c'), ok());
  assert.deepEqual(starts(b), [['s1', 'e', 's1', ACTIVATE]], 'first in, first out');
  const c = h.finish(key('s1', 'a'), ok());
  assert.deepEqual(starts(c), [['s1', 'f', 's1', ACTIVATE]]);
  const d = h.finish(key('s1', 'e'), ok());
  assert.deepEqual(starts(d), [['s1', 'e', 's1', MANUAL]], 'its follow-up');
});

test('a_waiting_run_that_became_hidden_is_dropped_on_promotion', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const h = new H(ids.map(tab));
  h.open('s1', '/p');
  h.activate('s1');
  h.view.hidden.add('e');
  h.pushView();
  const a = h.finish(key('s1', 'a'), ok());
  assert.deepEqual(starts(a), []);
  assert.equal(h.phase(key('s1', 'e')), PHASE.IDLE);
});

test('closing_a_session_kills_waiting_runs_and_frees_slots', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const h = new H(ids.map(tab));
  h.open('s1', '/p');
  h.open('s2', '/q');
  h.activate('s1');
  const a = h.activate('s2');
  assert.deepEqual(starts(a), [], 'all slots taken');
  const b = h.ev({ type: 'session_closed', session: 's1' });
  assert.equal(kills(b).length, 5, 'four running, one waiting');
  assert.equal(removed(b).length, 5);
  assert.equal(starts(b).length, MAX_CONCURRENT_RUNS, "s2's waiting runs promoted");
  assert.ok(starts(b).every((s) => s[0] === 's2'));
});

// ── config reload ───────────────────────────────────────────────────────────

test('removed_or_unapproved_plugins_are_killed_and_removed', () => {
  const h = new H([tab('a'), tab('b'), globalPlugin('g')]);
  h.open('s1', '/p');
  h.activate('s1');
  h.finish(key('s1', 'b'), ok());
  const plugins = [tab('b'), globalPlugin('g')];
  const a = h.ev({
    type: 'config',
    plugins,
    approved: new Set(['b']),
  });
  assert.deepEqual(kills(a).sort(), [
    [GLOBAL_KEY, 'g'],
    ['s1', 'a'],
  ], 'removed / revoked approval');
  assert.deepEqual(removed(a), [
    [GLOBAL_KEY, 'g'],
    ['s1', 'a'],
  ]);
  assert.ok(h.s.run(key('s1', 'b')), 'b keeps its result');
  assert.deepEqual(starts(a), []);
});

test('a_late_result_of_a_killed_run_never_lands_in_a_new_run', () => {
  const h = new H([tab('a')]);
  h.open('s1', '/p');
  h.activate('s1');
  const oldSeq = h.seq(key('s1', 'a'));
  h.config([]);
  h.config([tab('a')]);
  assert.equal(h.phase(key('s1', 'a')), PHASE.RUNNING);
  h.ev({ type: 'finished', key: key('s1', 'a'), seq: oldSeq, outcome: err('killed') });
  assert.equal(h.phase(key('s1', 'a')), PHASE.RUNNING);
});

test('scope_change_drops_old_keys_and_reactivates', () => {
  const h = H.settled([tab('p')]);
  const a = h.config([globalPlugin('p')]);
  assert.deepEqual(removed(a), [['s1', 'p']]);
  assert.deepEqual(starts(a), [[GLOBAL_KEY, 'p', 's1', ACTIVATE]]);
});

test('other_field_changes_keep_results_and_do_not_rerun', () => {
  const h = H.settled([tab('a')]);
  const a2 = tab('a');
  a2.title = 'renamed';
  a2.timeoutMs = 5_000;
  const a = h.config([a2]);
  assert.deepEqual(a, []);
  assert.ok(h.s.run(key('s1', 'a')));
  assert.equal(h.s.plugin('a').title, 'renamed');
});

test('interval_change_rebuilds_the_timer_and_removal_drops_it', () => {
  const h = H.settled([plugin('t', 'tab', [ACTIVATE], MIN)]);
  const start = h.now;
  h.now += 10;
  h.config([plugin('t', 'tab', [ACTIVATE], MIN)]);
  assert.equal(h.s.nextDeadline(), start + MIN, 'unchanged timer kept');
  h.config([plugin('t', 'tab', [ACTIVATE], 2 * MIN)]);
  assert.equal(h.s.nextDeadline(), h.now + 2 * MIN, 'rebuilt');
  h.config([plugin('t', 'tab', [ACTIVATE], null)]);
  assert.equal(h.s.nextDeadline(), null);
});

test('approval_change_rebuilds_the_timer', () => {
  const p = () => plugin('t', 'global', [], MIN);
  const h = H.settled([p()]);
  h.ev({ type: 'config', plugins: [p()], approved: new Set() });
  assert.equal(h.s.nextDeadline(), null, 'unapproved: no timer');
  h.now += 5;
  h.config([p()]);
  assert.equal(h.s.nextDeadline(), h.now + MIN);
});

test('dirty_triggers_of_removed_plugins_are_forgotten', () => {
  const h = H.settled([plugin('b', 'tab', [TURN_END], null)]);
  h.open('s2', '/q');
  h.activate('s2');
  h.turnEnd('s1');
  h.config([]);
  h.config([plugin('b', 'tab', [TURN_END], null)]);
  assert.deepEqual(starts(h.activate('s1')), []);
});

// ── active_applicable ───────────────────────────────────────────────────────

test('active_applicable_lists_matching_approved_enabled_plugins', () => {
  const w = tab('w');
  w.matchPath = '/work';
  const gw = globalPlugin('gw');
  gw.matchPath = '/work';
  const off = tab('off');
  off.enabled = false;
  const plugins = [w, tab('any'), off, gw, tab('pending')];
  const h = new H([]);
  const approved = new Set(plugins.map((p) => p.id));
  approved.delete('pending');
  h.ev({ type: 'config', plugins, approved });
  assert.deepEqual(h.s.activeApplicable(), { active: null, ids: [] });
  h.open('s1', '/work/x');
  h.open('s2', '/home/y');
  h.activate('s1');
  assert.deepEqual(h.s.activeApplicable(), { active: 's1', ids: ['w', 'any', 'gw'] });
  h.activate('s2');
  assert.deepEqual(
    h.s.activeApplicable(),
    { active: 's2', ids: ['any'] },
    'global in a non-matching tab excluded',
  );
  h.view.hidden.add('any');
  h.view.railVisible = false;
  h.view.windowVisible = false;
  h.pushView();
  assert.deepEqual(
    h.s.activeApplicable(),
    { active: 's2', ids: ['any'] },
    'visibility and hidden cards do not matter',
  );
});

test('bits_yields_set_indices_in_order', () => {
  assert.deepEqual(bits(0), []);
  assert.deepEqual(bits(0b1010_0001), [0, 5, 7]);
  assert.deepEqual(bits(1n << 63n), [63]);
  assert.equal(bit(64), 0n);
});

// ── pure helpers from config.rs ─────────────────────────────────────────────

test('path_matches_is_a_directory_prefix_on_separator_boundaries', () => {
  assert.equal(pathMatches('/a/b', '/a/b'), true);
  assert.equal(pathMatches('/a/b', '/a/b/c'), true);
  assert.equal(pathMatches('/a/b/', '/a/b/c'), true);
  assert.equal(pathMatches('/a/b', '/a/bc'), false, 'no partial segment');
  assert.equal(pathMatches('/a/b', '/a/b/cd'), true);
  assert.equal(pathMatches('/a/b', '/x/a/b'), false);
  assert.equal(pathMatches('/a\\b', '/a/b/c'), true, 'separators are equivalent');
  assert.equal(pathMatches('/a/b', 'relative/b'), false, 'project must have the prefix');
  assert.equal(pathMatches('/a/bc', '/a/b'), false);
  assert.equal(pathMatches('', '/a/b'), false, 'empty is handled by pluginMatches');
  assert.equal(pathMatches('/', '/a/b'), true, 'root matches any absolute path');
  assert.equal(pathMatches('/', '/'), true);
  assert.equal(pathMatches('\\', '\\server\\share'), true, 'root on Windows separators');
  assert.equal(pathMatches('\\', 'C:\\x'), false, 'a drive path has no leading separator');
  assert.equal(pathMatches('/', 'relative'), false, 'root needs an absolute project');
});

test('plugin_matches_combines_path_prefix_and_remote_substring', () => {
  const p = { matchPath: null, matchRemote: null };
  assert.equal(pluginMatches(p, '/any', 'whatever'), true);
  assert.equal(pluginMatches({ matchPath: '', matchRemote: null }, '/any', ''), true);
  assert.equal(pluginMatches({ matchPath: '/work', matchRemote: null }, '/work/x', ''), true);
  assert.equal(pluginMatches({ matchPath: '/work', matchRemote: null }, '/home/x', ''), false);
  assert.equal(
    pluginMatches({ matchPath: null, matchRemote: 'gitlab' }, '/p', 'git@gitlab.com:x/y'),
    true,
  );
  assert.equal(pluginMatches({ matchPath: null, matchRemote: 'gitlab' }, '/p', 'github'), false);
  assert.equal(
    pluginMatches({ matchPath: '/work', matchRemote: 'gitlab' }, '/home', 'gitlab'),
    false,
    'both must hold',
  );
  assert.equal(pluginMatches({ matchPath: null, matchRemote: '' }, '/p', 'x'), true);
});

test('plugin_wants_follows_the_trigger_list_and_interval_ms', () => {
  const p = normalizePlugin(plugin('p', 'tab', [ACTIVATE, TURN_END], null));
  assert.equal(pluginWants(p, MANUAL), true, 'manual always');
  assert.equal(pluginWants(p, ACTIVATE), true);
  assert.equal(pluginWants(p, TURN_END), true);
  assert.equal(pluginWants(p, BRANCH), false);
  assert.equal(pluginWants(p, INTERVAL), false, 'no intervalMs');
  const timed = normalizePlugin(plugin('p', 'tab', [], MIN));
  assert.equal(pluginWants(timed, INTERVAL), true);
  assert.equal(pluginWants(timed, ACTIVATE), false);
});

test('normalize_plugin_accepts_snake_case_and_clamps_interval', () => {
  const p = normalizePlugin({
    id: 'x',
    scope: 'Global',
    triggers: ['TurnEnd', 'turn_end', 'manual', 'interval', 'bogus'],
    interval_ms: 0,
    match_path: '/w',
    match_remote: 'gl',
    enabled: undefined,
  });
  assert.equal(p.scope, 'global');
  assert.deepEqual(p.triggers, [TURN_END], 'deduped; manual/interval are not config triggers');
  assert.equal(p.intervalMs, null, '0 means no interval');
  assert.equal(p.matchPath, '/w');
  assert.equal(p.matchRemote, 'gl');
  assert.equal(p.enabled, true);
  const timed = normalizePlugin({ id: 'y', intervalMs: 15_000 });
  assert.equal(timed.intervalMs, 15_000);
  assert.equal(timed.scope, 'tab');
});

test('due_now_treats_in_flight_and_future_finishes_as_fresh', () => {
  const interval = MIN;
  const now = 1_000_000;
  assert.equal(dueNow(null, interval, now), true, 'never ran');
  assert.equal(
    dueNow({ phase: PHASE.RUNNING, last: null }, interval, now),
    false,
    'in flight is fresh',
  );
  assert.equal(
    dueNow({ phase: PHASE.WAITING, last: null }, interval, now),
    false,
    'queued is fresh',
  );
  assert.equal(dueNow({ phase: PHASE.IDLE, last: null }, interval, now), true);
  assert.equal(dueNow({ phase: PHASE.IDLE, last: { at: now - interval } }, interval, now), true);
  assert.equal(
    dueNow({ phase: PHASE.IDLE, last: { at: now - interval + 1 } }, interval, now),
    false,
  );
  assert.equal(
    dueNow({ phase: PHASE.IDLE, last: { at: now + 5 * interval } }, interval, now),
    false,
    'clock went backwards: a future finish is fresh',
  );
});

test('timer_wanted_and_rearm_and_clamp', () => {
  const timed = normalizePlugin(plugin('t', 'tab', [], MIN));
  const globalTimed = normalizePlugin(plugin('g', 'global', [], MIN));
  assert.equal(timerWanted(timed, true, false), false, 'tab timer needs an active tab');
  assert.equal(timerWanted(timed, true, true), true);
  assert.equal(timerWanted(timed, false, true), false, 'unapproved: no timer');
  assert.equal(timerWanted(globalTimed, true, false), true, 'global timer survives');
  const off = normalizePlugin({ ...plugin('o', 'tab', [], MIN), enabled: false });
  assert.equal(timerWanted(off, true, true), false);

  const timers = [null, null];
  rearm(timers, 0, timed, 1_000);
  assert.equal(timers[0], 1_000 + MIN);
  rearm(timers, 1, normalizePlugin(plugin('n', 'tab', [], null)), 1_000);
  assert.equal(timers[1], null, 'no interval → no-op');
  rearm(timers, 9, timed, 1_000);
  assert.equal(timers.length, 2, 'out of range is ignored');

  assert.equal(clampTimerDue(null, MIN, 5), null);
  assert.equal(clampTimerDue(10 * MIN, MIN, 5), 5 + MIN);
  assert.equal(clampTimerDue(5, MIN, 5), 5, 'never pushed forward');
  assert.equal(clampTimerDue(5, null, 5), 5);
});

test('config_rs_match_table', () => {
  const m = (prefix, project) => pluginMatches({ matchPath: prefix, matchRemote: null }, project, '');
  assert.equal(m('/Users/me/GIT', '/Users/me/GIT/x'), true);
  assert.equal(m('/Users/me/GIT', '/Users/me/GITHUB/x'), false, 'separators, not characters');
  assert.equal(m('/Users/me/GIT', '/Users/me/GIT'), true, 'the folder itself');
  assert.equal(m('/Users/me/GIT', '/Users/me/GIT/'), true, 'trailing separator');
  assert.equal(m('/Users/me/GIT', '/Users/me'), false, 'a parent is not inside');
  assert.equal(m('/Users/me/GIT', ''), false, 'tab without a project');
  assert.equal(m('/Users/me/GIT/', '/Users/me/GIT/x'), true);
  assert.equal(m('C:\\Users\\me\\GIT', 'C:\\Users\\me\\GIT\\x'), true);
  assert.equal(m('C:\\Users\\me\\GIT', 'C:/Users/me/GIT/x'), true);
  assert.equal(m('C:\\Users\\me\\GIT', 'C:\\Users\\me\\GITHUB'), false);
  assert.equal(m('/a/b', '\\a\\b\\c'), true);
  assert.equal(m('/', '/a/b'), true);
  assert.equal(m('/', '/'), true);
  assert.equal(m('/', '\\a'), true);
  assert.equal(m('/', 'relative/x'), false);
  assert.equal(m('/', ''), false);
  assert.equal(m('//', '/a'), true);

  const r = (remote) =>
    pluginMatches({ matchPath: null, matchRemote: 'example.com/team' }, '', remote);
  assert.equal(r('https://example.com/team/x.git'), true);
  assert.equal(r('https://example.com/other/x.git'), false);
  assert.equal(r(''), false, 'no remote');
});

test('createScheduler_uses_the_injected_clock_and_hooks', () => {
  let clock = 2_000_000;
  const fired = [];
  const killed = [];
  const changed = [];
  const gone = [];
  const s = createScheduler({
    now: () => clock,
    startRun: (a) => fired.push(a),
    killRun: (a) => killed.push(a),
    onChanged: (a) => changed.push(a),
    onRemoved: (a) => gone.push(a),
  });
  s.handle({
    type: 'config',
    plugins: [plugin('t', 'tab', [ACTIVATE], MIN)],
    approved: new Set(['t']),
  });
  s.handle({ type: 'view', view: { session: null, railVisible: true, windowVisible: true } });
  s.handle({ type: 'session_opened', session: 's1', ctx: { project: '/p' } });
  s.handle({ type: 'view', view: { session: 's1', railVisible: true, windowVisible: true } });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trigger, ACTIVATE);
  assert.equal(fired[0].session, 's1');
  assert.deepEqual(fired[0].key, { scopeKey: 's1', pluginId: 't' });
  assert.ok(changed.length >= 1, 'changed hook saw the new run');
  s.handle({
    type: 'finished',
    key: { scopeKey: 's1', pluginId: 't' },
    seq: 1,
    outcome: { ok: true, value: '{}' },
  });
  clock += MIN;
  s.handle({ type: 'tick' });
  assert.equal(fired.length, 2, 'tick due at the injected clock');
  assert.equal(fired[1].trigger, INTERVAL);
  s.handle({ type: 'session_closed', session: 's1' });
  assert.deepEqual(
    killed.map((a) => [a.key.scopeKey, a.key.pluginId]),
    [['s1', 't']],
  );
  assert.equal(gone.length, 1);
  assert.equal(s.nextDeadline(), null);
});