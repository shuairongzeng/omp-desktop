/* Port parity tests for electron/backend/browser-view.js,
   electron/backend/browser-proxy.js and electron/backend/browser-annotate.js.

   Mirrors:
   - src-tauri/src/browser/view/frames.rs (ack gating, timeout, latest wins)
   - src-tauri/src/browser/view/model.rs (follow/hold, target events, tabs)
   - src-tauri/src/browser/view/input.rs (release/deliberate)
   - src-tauri/src/browser/view/tests.rs (startScreencast, ack flow, input)
   - src-tauri/src/browser/proxy/{tap,http,discovery,peer,feed}.rs
   - src-tauri/src/browser/proxy/tests.rs (admission before launch, /json,
     peer check, pump)
   - src-tauri/src/browser/annotate/{pick,capture,mod}.rs and tests.rs
     (install sequence, pick gating, clipped capture)

   The real broker is a sibling slice; these tests use their own minimal fake
   implementing the batch contract (Broker.client(), BrokerClient.send/
   sessionFor/on/close).

   Run: node tests/port-browser-view.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';

import viewBackend from '../electron/backend/browser-view.js';
import proxyBackend from '../electron/backend/browser-proxy.js';
import annotateBackend from '../electron/backend/browser-annotate.js';

const {
  View,
  FrameFlow,
  Frame,
  chromiumAck,
  jpegSize,
  NOT_ATTACHED,
} = viewBackend;

const {
  startProxy,
  admit,
  routeFor,
  parseDiscovery,
  intentTap,
  Tap,
  Observer,
  encodeFrame,
  decodeFrame,
  lsofLists,
  procfsSameUser,
  percentDecode,
  Refusal,
} = proxyBackend;

const {
  Annotate,
  install,
  pick,
  parsePick,
  clip,
  viewportOf,
  OVERLAY,
  WORLD,
  BINDING,
  HIDE,
  SHOW,
  PICK_AFTER_RELEASE_MS,
} = annotateBackend;

// ── the fake broker (batch contract) ───────────────────────────────────────

class FakeClient {
  constructor(broker) {
    this.broker = broker;
    this.listeners = { event: [], close: [] };
    this.closed = false;
  }

  on(name, callback) {
    (this.listeners[name] ??= []).push(callback);
    return this;
  }

  async send(method, params = {}, opts = {}) {
    this.broker.commands.push({ method, params, opts });
    if (this.closed) throw new Error('cdp connection closed');
    const reply = this.broker.reply?.(method, params, opts);
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  }

  async sessionFor(targetId) {
    (this.broker.sessionForCalls ??= []).push(targetId);
    return `session-${targetId}`;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.listeners.close) callback();
  }

  emitEvent(event) {
    for (const callback of this.listeners.event) callback(event);
  }

  emitClose() {
    for (const callback of this.listeners.close) callback();
  }
}

class FakeBroker {
  constructor() {
    this.id = 'B1';
    this.commands = [];
    this.clients = [];
    this.closed = false;
    this.reply = () => ({});
  }

  client() {
    const client = new FakeClient(this);
    this.clients.push(client);
    return client;
  }

  isAlive() {
    return !this.closed;
  }

  close() {
    this.closed = true;
  }

  commandsFor(method) {
    return this.commands.filter((command) => command.method === method);
  }

  lastCommand(method) {
    return this.commandsFor(method).at(-1) ?? null;
  }

  lastClient() {
    return this.clients.at(-1) ?? null;
  }
}

// ── tiny async helpers ─────────────────────────────────────────────────────

const delay = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

async function until(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('condition not met in time');
    await delay(5);
  }
}

// A JPEG header whose SOF says 400x300 (from view/emit.rs tests).
const HEADER =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wAFAAEC/8AAEQgBLAGQAwEiAAIRAQMRAQ==';

const frame = (n) => Frame.create(`frame${n}`, n, n);
const ack = (id) => chromiumAck('s', { sessionId: id });
const numbered = (n, seq) => new Frame({ ...frame(n), seq });

// ── Frame: JPEG size and wire form (view/emit.rs tests) ────────────────────

test('frame: jpeg size is read past other segments', () => {
  assert.deepEqual(jpegSize(HEADER), [400, 300]);
  const one = Frame.create(HEADER, 200, 150);
  assert.deepEqual([one.w, one.h, one.cssW, one.cssH], [400, 300, 200, 150]);
  assert.equal(one.b64, HEADER, 'passed through untouched');
  assert.equal(jpegSize(HEADER.slice(0, 30)), null, 'cut before the frame header');
  assert.equal(jpegSize('iVBORw0KGgoAAAANSUhEUgAA'), null, 'a PNG');
  assert.equal(jpegSize(''), null);
  const fallback = Frame.create('', 200, 150);
  assert.deepEqual([fallback.w, fallback.h], [200, 150]);
});

test('frame: the wire form is a header and the decoded JPEG', () => {
  const one = new Frame({ ...Frame.create(HEADER, 200, 150), seq: 0x0102030405060708n });
  const wire = one.wire();
  assert.equal(wire.readBigUInt64LE(0), 0x0102030405060708n);
  assert.equal(wire.readUInt32LE(8), 200);
  assert.equal(wire.readUInt32LE(12), 150);
  assert.deepEqual(wire.subarray(16), Buffer.from(HEADER, 'base64'));
  assert.equal(Frame.create('not base64!', 1, 1).wire(), null);
});

test('frame: proportions are checked against the CSS size', () => {
  const of = (w, h, cssW, cssH) => new Frame({ b64: '', w, h, cssW, cssH });
  assert.ok(of(800, 600, 400, 300).hasCssProportions());
  assert.ok(of(1280, 657, 1280, 657).hasCssProportions());
  assert.ok(of(801, 600, 400, 300).hasCssProportions(), 'rounding');
  assert.ok(!of(400, 205, 400, 300).hasCssProportions(), 'window surface');
});

// ── screencast ack gating (view/frames.rs tests) ───────────────────────────

test('screencast: no frame is emitted until the panel acks and the latest wins', async () => {
  const flow = new FrameFlow({ ackTimeoutMs: 30_000 });
  flow.put(1, frame(1), ack(1));
  const first = await flow.next();
  assert.deepEqual(first.frame, [1, numbered(1, 1)]);
  assert.deepEqual(first.acks, [], "Chromium's ack waits for the panel");

  for (let n = 2; n <= 4; n += 1) flow.put(1, frame(n), ack(n));
  let settled = false;
  const second = flow.next().then((step) => {
    settled = true;
    return step;
  });
  await delay(80);
  assert.equal(settled, false, 'frame 1 is still in flight');
  flow.ack(7);
  await delay(80);
  assert.equal(settled, false, 'an ack of another frame changes nothing');
  flow.ack(1);
  const step = await second;
  assert.deepEqual(step.frame, [1, numbered(4, 2)], '2 and 3 skipped');
  assert.deepEqual(step.acks, [ack(2), ack(3), ack(1)], 'skipped and painted frames are acked now');
  flow.close();
});

test('screencast: a lost ack times out', async () => {
  const timeout = 120;
  const flow = new FrameFlow({ ackTimeoutMs: timeout });
  flow.put(1, frame(1), ack(1));
  const sent = Date.now();
  await flow.next();
  flow.put(1, frame(2), ack(2));
  const step = await flow.next();
  assert.ok(Date.now() - sent >= timeout);
  assert.deepEqual(step.frame, [1, numbered(2, 2)]);
  assert.deepEqual(step.acks, [ack(1)]);
  flow.close();
});

test('screencast: an ack with nothing waiting still releases Chromium', async () => {
  const flow = new FrameFlow({ ackTimeoutMs: 30_000 });
  flow.put(3, frame(1), ack(1));
  await flow.next();
  flow.ack(1);
  assert.deepEqual(await flow.next(), { acks: [ack(1)], frame: null });
  flow.put(1, frame(2), ack(2));
  flow.clear();
  flow.put(4, frame(3), null);
  const step = await flow.next();
  assert.deepEqual(step.frame, [4, numbered(3, 2)], 'a cleared frame is gone, the activation stays with its frame');
  assert.deepEqual(step.acks, [ack(2)]);
  flow.close();
});

test('screencast: closing wakes a waiting emitter', async () => {
  const flow = new FrameFlow();
  const waiting = flow.next();
  await delay(20);
  flow.close();
  assert.equal(await waiting, null);
  flow.put(1, frame(1), null);
  assert.equal(await flow.next(), null, 'closed stays closed');
});

// ── the View's screencast wiring (view/tests.rs) ───────────────────────────

async function viewWithScreencast({ width = 400, height = 300, dpr = 2 } = {}) {
  const broker = new FakeBroker();
  const view = new View({ broker, sessionId: 's' });
  const client = broker.clients[0];
  view.setSize(width, height, dpr);
  view.setActive('t1', 's1');
  const frames = [];
  await view.startScreencast(client, (one) => frames.push(one));
  return { broker, view, client, frames };
}

function frameEvent(sessionId, id, metadata = { deviceWidth: 400, deviceHeight: 300 }) {
  return {
    method: 'Page.screencastFrame',
    sessionId,
    params: { data: HEADER, metadata, sessionId: id },
  };
}

test('view: startScreencast sizes the viewport and acks only after frameAck', async () => {
  const { broker, view, client, frames } = await viewWithScreencast();
  const metrics = broker.lastCommand('Emulation.setDeviceMetricsOverride');
  assert.deepEqual(metrics.params, { width: 400, height: 300, deviceScaleFactor: 2, mobile: false });
  const started = broker.lastCommand('Page.startScreencast');
  assert.deepEqual(started.params, {
    format: 'jpeg',
    quality: 70,
    maxWidth: 800,
    maxHeight: 600,
    everyNthFrame: 1,
  });
  assert.equal(started.opts.sessionId, 's1');

  client.emitEvent(frameEvent('s1', 7));
  await until(() => frames.length === 1);
  assert.equal(frames[0].seq, 1);
  assert.deepEqual([frames[0].w, frames[0].h, frames[0].cssW, frames[0].cssH], [400, 300, 400, 300]);
  assert.equal(broker.commandsFor('Page.screencastFrameAck').length, 0, 'the first frame waits for the panel');

  client.emitEvent(frameEvent('s1', 8));
  client.emitEvent(frameEvent('s1', 9));
  client.emitEvent(frameEvent('s1', 10));
  await delay(60);
  assert.equal(frames.length, 1, 'one frame in flight at a time');

  view.frameAck(frames[0].seq);
  await until(() => frames.length === 2);
  assert.equal(frames[1].seq, 2);
  const acks = broker.commandsFor('Page.screencastFrameAck').map((command) => [command.params.sessionId, command.opts.sessionId]);
  assert.deepEqual(acks, [
    [8, 's1'],
    [9, 's1'],
    [7, 's1'],
  ]);
  view.close();
});

test('view: an image without its metadata proportions is acked, not shown', async () => {
  const { broker, view, client, frames } = await viewWithScreencast();
  client.emitEvent(frameEvent('s1', 7, { deviceWidth: 400, deviceHeight: 205 }));
  await until(() => broker.commandsFor('Page.screencastFrameAck').length === 1);
  assert.equal(frames.length, 0, 'clicks would map wrong through it');
  assert.equal(broker.lastCommand('Page.screencastFrameAck').params.sessionId, 7);
  view.close();
});

test('view: a frame of a page no longer shown is acked, not delivered', async () => {
  const { broker, view, client, frames } = await viewWithScreencast();
  view.setActive('t2', 's2');
  client.emitEvent(frameEvent('s1', 7));
  await until(() => broker.commandsFor('Page.screencastFrameAck').length === 1);
  assert.equal(frames.length, 0);
  view.close();
});

// ── follow and hold (view/model.rs tests) ──────────────────────────────────

const pageInfo = (id) => ({ targetId: id, type: 'page', title: '', url: 'u' });
const created = (id) => ['Target.targetCreated', { targetInfo: pageInfo(id) }];

function followingView({ followHoldMs = 5000 } = {}) {
  const broker = new FakeBroker();
  const view = new View({ broker, followHoldMs });
  view._upsertPage(pageInfo('a'));
  view.setActive('a', 'sa');
  view.startFollowing();
  return view;
}

test('follow: a listed page is followed at once', () => {
  const view = followingView();
  view._upsertPage(pageInfo('b'));
  assert.equal(view.follow('b'), true);
  assert.equal(view.pendingFollow, null);
});

test('follow: a page not listed yet is followed when it appears', () => {
  const view = followingView();
  assert.equal(view.follow('b'), false, 'not there yet');
  const [m1, p1] = created('c');
  assert.equal(view.applyTargetEvent(m1, p1), null, 'not it');
  const [m2, p2] = created('b');
  assert.equal(view.applyTargetEvent(m2, p2), 'b');
  assert.equal(view.applyTargetEvent(m2, p2), null, 'once');
});

test('follow: only the latest unknown page is waited for', () => {
  const view = followingView();
  assert.equal(view.follow('b'), false);
  assert.equal(view.follow('c'), false);
  const [m1, p1] = created('b');
  assert.equal(view.applyTargetEvent(m1, p1), null);
  const [m2, p2] = created('c');
  assert.equal(view.applyTargetEvent(m2, p2), 'c');
});

test('follow: a follow held back by the user choice is kept for when the hold ends', () => {
  const view = followingView();
  view._upsertPage(pageInfo('b'));
  view._upsertPage(pageInfo('c'));
  view.hold();
  const picked = view.userActivated;
  assert.equal(view.followDeadline(), null, 'nothing kept yet');
  assert.equal(view.follow('b'), false, 'held');
  assert.equal(view.follow('c'), false, 'held');
  assert.equal(view.followDeadline(), picked + view.holdMs);
  assert.equal(view.takeHeldFollow(), null, 'the hold is not over');
  view.userActivated = picked - view.holdMs - 1000;
  assert.equal(view.takeHeldFollow(), 'c', 'the newest report');
  assert.equal(view.takeHeldFollow(), null, 'once');
  assert.equal(view.follow('b'), true, 'no hold: followed at once');
});

test('follow: a page that appears during a hold is kept for when it ends', () => {
  const view = followingView();
  assert.equal(view.follow('c'), false, 'not listed yet');
  view.hold();
  const [method, params] = created('c');
  assert.equal(view.applyTargetEvent(method, params), null, 'held');
  view.userActivated = view.now() - view.holdMs - 1000;
  assert.equal(view.takeHeldFollow(), 'c');
});

test('follow: a closed page is no longer waited for', () => {
  const view = followingView();
  view._upsertPage(pageInfo('b'));
  view.hold();
  assert.equal(view.follow('b'), false);
  assert.equal(view.removePage('b'), true);
  assert.equal(view.removePage('b'), false, 'gone already');
  assert.equal(view.followDeadline(), null);
  view.userActivated = null;
  assert.equal(view.follow('x'), false, 'not listed yet');
  assert.equal(view.removePage('x'), false, 'never listed, but no longer awaited');
  const [method, params] = created('x');
  assert.equal(view.applyTargetEvent(method, params), null);
});

test('follow: following waits for startFollowing and for the choice to age', () => {
  const broker = new FakeBroker();
  const view = new View({ broker, followHoldMs: 5000 });
  view._upsertPage(pageInfo('a'));
  view.setActive('a', 'sa');
  view._upsertPage(pageInfo('b'));
  assert.equal(view.follow('b'), false, 'not before following started');
  view.startFollowing();
  assert.equal(view.follow('b'), true);
  view.hold();
  assert.equal(view.follow('b'), false, 'the user just picked a tab');
  view.userActivated = view.now() - view.holdMs - 1;
  assert.equal(view.follow('b'), true, 'the choice is old enough');
});

test('pages: target events update pages without following them', () => {
  const view = followingView();
  const [method, params] = created('b');
  assert.equal(view.applyTargetEvent(method, params), null);
  assert.equal(view.pages().length, 2, 'listed, though not followed');
  const renamed = {
    targetInfo: { targetId: 'b', type: 'page', title: 'B', url: 'u2' },
  };
  assert.equal(view.applyTargetEvent('Target.targetInfoChanged', renamed), null);
  assert.equal(view.page('b').title, 'B');
  const worker = { targetInfo: { targetId: 'w', type: 'service_worker' } };
  view.applyTargetEvent('Target.targetCreated', worker);
  assert.equal(view.pages().length, 2, 'pages only');
});

test('pages: a destroyed page is dropped and a shown one leaves no active page', () => {
  const view = followingView();
  view._upsertPage(pageInfo('b'));
  view.setActive('b', 'sb');
  assert.equal(view.applyTargetEvent('Target.targetDestroyed', { targetId: 'b' }), null);
  assert.equal(view.page('b'), null);
  assert.equal(view.active, null, 'a closed page leaves the view with none');
  assert.deepEqual(view.pages().map((page) => [page.targetId, page.active]), [['a', false]]);
});

test('view: a started screencast reports the running state', async () => {
  const broker = new FakeBroker();
  const view = new View({ broker });
  const client = broker.clients[0];
  const states = [];
  view.on('message', (message) => {
    if (message.type === 'state') states.push(message.value);
  });
  view.setSize(400, 300, 1);
  view.setActive('t1', 's1');
  await view.startScreencast(client, () => {});
  assert.equal(states.at(-1).status, 'running');
  client.emitClose();
  assert.equal(states.at(-1).status, 'stopped');
  assert.equal(states.at(-1).error, 'browser connection lost');
});

test('view: the shown page drives loading, history and title state', async () => {
  const broker = new FakeBroker();
  broker.reply = (method) => {
    if (method === 'Page.getNavigationHistory') {
      return { currentIndex: 1, entries: [{ id: 1, url: 'https://a/' }, { id: 2, url: 'https://b/' }] };
    }
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { targetId: 't1', type: 'page', title: 'B title', url: 'https://b/' } };
    }
    return {};
  };
  const view = new View({ broker });
  const client = broker.clients[0];
  view._upsertPage(pageInfo('t1'));
  view.setActive('t1', 's1');
  const states = [];
  view.on('message', (message) => {
    if (message.type === 'state') states.push(message.value);
  });
  client.emitEvent({ method: 'Page.frameStartedLoading', sessionId: 'other', params: { frameId: 't1' } });
  assert.equal(states.length, 0, "another session's page events are ignored");

  client.emitEvent({ method: 'Page.frameNavigated', sessionId: 's1', params: { frame: { id: 't1', url: 'https://b/' } } });
  await until(() => states.at(-1)?.canBack === true);
  assert.deepEqual(
    [states.at(-1).url, states.at(-1).canBack, states.at(-1).canForward],
    ['https://b/', true, false],
    'history comes from Page.getNavigationHistory on the shown session',
  );
  assert.deepEqual(broker.lastCommand('Page.getNavigationHistory').opts, { sessionId: 's1' });

  client.emitEvent({ method: 'Page.frameStartedLoading', sessionId: 's1', params: { frameId: 't1' } });
  assert.equal(states.at(-1).loading, true);
  client.emitEvent({ method: 'Page.loadEventFired', sessionId: 's1' });
  assert.equal(states.at(-1).loading, false);
  await until(() => view.page('t1').title === 'B title', 2000);

  client.emitEvent({
    method: 'Page.frameNavigated',
    sessionId: 's1',
    params: { frame: { id: 't1', url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://gone.test/' } },
  });
  await until(() => states.at(-1)?.error != null);
  assert.equal(states.at(-1).error, 'could not load https://gone.test/');
  assert.equal(states.at(-1).url, 'https://gone.test/');
  view.close();
});

test('pages: a target event is the Rust TabInfo shape, emitted once per change', async () => {
  const broker = new FakeBroker();
  broker.reply = (method) =>
    method === 'Target.getTargets'
      ? {
          targetInfos: [
            { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
            { targetId: 'w', type: 'service_worker', title: '', url: '' },
          ],
        }
      : {};
  const view = new View({ broker });
  const messages = [];
  view.on('message', (message) => messages.push(message));
  await view.discover();
  assert.deepEqual(view.pages(), [{ targetId: 't1', title: 'A', url: 'https://a.test/', active: false }]);
  assert.deepEqual(messages.at(-1), {
    type: 'tabs',
    value: [{ targetId: 't1', title: 'A', url: 'https://a.test/', active: false }],
  });
  const before = messages.length;
  view._publishTabs();
  assert.equal(messages.length, before, 'unchanged tabs are not emitted again');
  view.setActive('t1', 's1');
  assert.deepEqual(messages.at(-1).value[0].active, true, 'the active mark is part of it');
  view.close();
});

test('pages: a size is range-checked like model::Size', () => {
  const view = new View({ broker: new FakeBroker() });
  assert.ok(view.setSize(400, 300, 2));
  for (const [w, h, dpr] of [
    [0, 300, 1],
    [400, 0, 1],
    [9000, 300, 1],
    [400, 300, 0],
    [400, 300, 9],
    [4096, 300, 2.5],
    [400, 8000, 1.5],
  ]) {
    assert.throws(() => view.setSize(w, h, dpr), /invalid panel size/, `${w}x${h}@${dpr}`);
  }
  assert.equal(view.setSize(400, 300, 1.5).px(400), 600);
  assert.ok(view.setSize(4096, 2160, 2), '8192 device px');
});

// ── input (view/input.rs, view/core.rs tests) ──────────────────────────────

function activeView() {
  const broker = new FakeBroker();
  const view = new View({ broker });
  view.setActive('a', 'sa');
  return view;
}

test('input: goes to the page shown with its session, a release stamps the panel', async () => {
  const view = activeView();
  const broker = view.client.broker;
  const releases = [];
  view.on('panelRelease', (at) => releases.push(at));
  await view.input('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
  });
  assert.equal(broker.lastCommand('Input.dispatchMouseEvent').opts.sessionId, 'sa');
  assert.equal(view.panelReleasedWithin(2000), false);
  await view.input('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 1, y: 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
  });
  assert.equal(view.panelReleasedWithin(2000), true);
  assert.equal(releases.length, 1, 'the annotate gating clock hears it');
  view.close();
});

test('input: of an earlier activation is dropped, not sent', async () => {
  const view = activeView();
  const broker = view.client.broker;
  const before = broker.commands.length;
  view._inputDraining = true; // hold the queue, as Rust input_gate does
  const sent = view.input('Input.insertText', { text: 'x' });
  view.setActive('b', 'sb');
  view._inputDraining = false;
  await view._drainInput();
  await sent;
  assert.equal(broker.commands.length, before, 'dropped, not redirected');
  view.close();
});

test('input: past 512 queued gestures input is refused', async () => {
  const view = activeView();
  view._inputDraining = true;
  for (let i = 0; i < 512; i += 1) view.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: i, y: i });
  await assert.rejects(view.input('Input.insertText', { text: 'x' }), /browser is busy/);
});

test('input: a page command refused while the page commits is sent again', async () => {
  const broker = new FakeBroker();
  let refusals = 2;
  broker.reply = (method) => {
    if (method === 'Page.getNavigationHistory' && refusals > 0) {
      refusals -= 1;
      throw new Error(NOT_ATTACHED);
    }
    return {};
  };
  const view = new View({ broker });
  view.setActive('a', 'sa');
  await view.call('Page.getNavigationHistory', {}, { sessionId: 'sa' });
  assert.equal(broker.commandsFor('Page.getNavigationHistory').length, 3, 'two refusals, then the answer');
  view.close();
});

test('input: other errors and browser commands are not sent again', async () => {
  const broker = new FakeBroker();
  broker.reply = (method) => {
    if (method === 'Page.reload') throw new Error('boom');
    if (method === 'Target.getTargets') throw new Error(NOT_ATTACHED);
    return {};
  };
  const view = new View({ broker });
  view.setActive('a', 'sa');
  await assert.rejects(view.call('Page.reload', {}, { sessionId: 'sa' }));
  await assert.rejects(view.call('Target.getTargets', {}));
  assert.equal(broker.commandsFor('Page.reload').length, 1);
  assert.equal(broker.commandsFor('Target.getTargets').length, 1);
  view.close();
});

// ── intent tap (proxy/tap.rs tests) ────────────────────────────────────────

test('tap: the intent predicate is the Rust intent list', () => {
  for (const method of [
    'Page.navigate',
    'Page.reload',
    'Page.navigateToHistoryEntry',
    'Page.bringToFront',
    'Page.captureScreenshot',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'Target.activateTarget',
    'Target.createTarget',
  ]) {
    assert.equal(intentTap(method), true, method);
  }
  for (const method of [
    'Page.enable',
    'Page.getNavigationHistory',
    'Runtime.evaluate',
    'DOM.getDocument',
    'Target.setAutoAttach',
    'Target.getTargets',
    'Target.attachToTarget',
    'Emulation.setDeviceMetricsOverride',
  ]) {
    assert.equal(intentTap(method), false, method);
  }
});

function tapOn(page = null) {
  const reported = [];
  const tap = new Tap({ page, onTarget: (target) => reported.push(target) });
  return { tap, reported };
}

const command = (tap, message) => tap.onMessage('client', message);
const server = (tap, message) => tap.onMessage('server', message);
const inSession = (id, method, sessionId) => ({ id, method, params: {}, sessionId });

test('tap: a command in an attached session names its page', () => {
  const { tap, reported } = tapOn();
  server(tap, { method: 'Target.attachedToTarget', params: { sessionId: 's1', targetInfo: { targetId: 'T1', type: 'page' } } });
  command(tap, inSession(1, 'Page.navigate', 's1'));
  assert.deepEqual(reported, ['T1']);
});

test('tap: an attach reply names a session but is no intent', () => {
  const { tap, reported } = tapOn();
  command(tap, { id: 7, method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } });
  server(tap, { id: 7, result: { sessionId: 's2' } });
  assert.deepEqual(reported, [], 'attached is not worked in');
  command(tap, inSession(8, 'Page.reload', 's2'));
  assert.deepEqual(reported, ['T2']);
  command(tap, inSession(9, 'Page.reload', 'unknown'));
  assert.deepEqual(reported, ['T2'], 'a session nobody told us about');
});

test('tap: a detached session is forgotten', () => {
  const { tap, reported } = tapOn();
  server(tap, { method: 'Target.attachedToTarget', params: { sessionId: 's1', targetInfo: { targetId: 'T1', type: 'page' } } });
  server(tap, { method: 'Target.detachedFromTarget', params: { sessionId: 's1' } });
  command(tap, inSession(1, 'Page.navigate', 's1'));
  assert.deepEqual(reported, []);
});

test('tap: only page sessions count', () => {
  const { tap, reported } = tapOn();
  server(tap, { method: 'Target.attachedToTarget', params: { sessionId: 'frame', targetInfo: { targetId: 'F1', type: 'iframe' } } });
  command(tap, inSession(1, 'Input.dispatchMouseEvent', 'frame'));
  command(tap, { id: 2, method: 'Target.attachToTarget', params: { targetId: 'F1' } });
  server(tap, { id: 2, result: { sessionId: 'frame' } });
  command(tap, inSession(3, 'Input.dispatchMouseEvent', 'frame'));
  assert.deepEqual(reported, []);
});

test('tap: a created page is reported from the reply, once', () => {
  const { tap, reported } = tapOn();
  command(tap, { id: 3, method: 'Target.createTarget', params: {} });
  assert.deepEqual(reported, [], 'the page has no id yet');
  server(tap, { id: 4, result: { targetId: 'other' } });
  server(tap, { id: 3, error: { message: 'no' } });
  assert.deepEqual(reported, [], 'an unrelated or failed reply');
  command(tap, { id: 5, method: 'Target.createTarget', params: {} });
  server(tap, { id: 5, result: { targetId: 'T5' } });
  server(tap, { id: 5, result: { targetId: 'T5' } });
  assert.deepEqual(reported, ['T5'], 'once; the failed id 3 is retired');
});

test('tap: activating a target names it', () => {
  const { tap, reported } = tapOn();
  command(tap, { id: 1, method: 'Target.activateTarget', params: { targetId: 'T9' } });
  assert.deepEqual(reported, ['T9']);
});

test('tap: a page connection works in its own page', () => {
  const { tap, reported } = tapOn('B7');
  command(tap, { id: 1, method: 'Page.bringToFront', params: {} });
  assert.deepEqual(reported, ['B7']);
  const browser = tapOn();
  command(browser.tap, { id: 1, method: 'Page.bringToFront', params: {} });
  assert.deepEqual(browser.reported, [], 'a browser connection has no page of its own');
});

test('tap: messages that are not JSON are ignored', () => {
  const { tap, reported } = tapOn();
  tap.onMessage('client', '{not json');
  tap.onMessage('server', '[1,');
  server(tap, { method: 'Target.attachedToTarget', params: { sessionId: 's1', targetInfo: { targetId: 'T1', type: 'page' } } });
  command(tap, inSession(1, 'Page.navigate', 's1'));
  assert.deepEqual(reported, ['T1']);
});

test('tap: pending requests are bounded oldest first', () => {
  const { tap, reported } = tapOn();
  for (let id = 1; id <= 2000; id += 1) {
    command(tap, { id, method: 'Target.createTarget', params: {} });
  }
  server(tap, { id: 1, result: { targetId: 'old' } });
  server(tap, { id: 2000, result: { targetId: 'new' } });
  assert.deepEqual(reported, ['new']);
});

test('tap: too many sessions cannot be followed', () => {
  const { tap } = tapOn();
  for (let n = 0; n < 4096; n += 1) {
    server(tap, { method: 'Target.attachedToTarget', params: { sessionId: `s${n}`, targetInfo: { targetId: 'T', type: 'page' } } });
  }
  assert.throws(
    () => server(tap, { method: 'Target.attachedToTarget', params: { sessionId: 'last', targetInfo: { targetId: 'T', type: 'page' } } }),
    /too many sessions/,
  );
});

test('observer: a full queue switches observation off without blocking forwarding', async () => {
  const seen = [];
  let received = 0;
  const observer = new Observer({ onMessage: () => seen.push(1) });
  observer.tap = { onMessage: () => { received += 1; throw new Error('boom'); } };
  for (let i = 0; i < 2000; i += 1) observer.push('client', `{"i":${i}}`);
  assert.equal(observer.offReason, 'observer queue full', 'the queue is bounded');
  await delay(20);
  assert.equal(seen.length, 0, 'nothing was observed');
  assert.equal(received, 0);
  const second = new Observer({});
  second.tap = { onMessage: () => { throw new Error('boom'); } };
  second.push('server', '{}');
  await delay(20);
  assert.equal(second.offReason, 'boom', 'a failing tap goes off');
});

// ── admission (proxy/http.rs tests) ────────────────────────────────────────

const headOf = (path, extra = '', { host = '127.0.0.1', method = 'GET' } = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}\r\n`;

test('admit: discovery needs one loopback Host and no browser headers', () => {
  const admitted = admit(headOf('/json/list'));
  assert.deepEqual([admitted.method, admitted.target], ['GET', '/json/list']);
  assert.equal(admitted.wsKey, null);
  assert.throws(() => admit(headOf('/json/list', 'Origin: http://evil.test\r\n')), /requests from a web browser are refused/);
  assert.throws(() => admit(headOf('/json/list', 'Sec-Fetch-Site: cross-site\r\n')), /requests from a web browser are refused/);
  assert.ok(admit(headOf('/json/list', 'Sec-Fetch-Mode: cors\r\n')), "Node fetch's only fetch-metadata header is allowed");
  assert.throws(() => admit(headOf('/json/list', '', { host: 'evil.test' })), /loopback Host required/);
  assert.throws(() => admit(headOf('/json/list', 'Host: 127.0.0.1\r\n')), /loopback Host required/, 'two Hosts');
  assert.throws(() => admit(headOf('https://evil.test/')), /origin-form target required/);
  assert.throws(() => admit('GET /json/list HTTP/1.1\r\nBad Header: x\r\n\r\n'), /malformed header/);
  assert.throws(() => admit(Buffer.from('GET /json/list HTTP/1.1\r\nHost: 127.0.0.1\r\nX: \xff\r\n\r\n', 'latin1')), /request head is not text/);
  assert.throws(() => admit(headOf('/devtools/browser/B1')), /WebSocket upgrade required/);
  assert.deepEqual(
    admit(headOf('/devtools/browser/B1', 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: abc\r\n')).wsKey,
    'abc',
  );
});

test('route: a WebSocket target is GET with version 13 and a key', () => {
  const socket = routeFor(
    admit(headOf('/devtools/browser/B1', 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: abc\r\n')),
  );
  assert.deepEqual(socket, { kind: 'socket', page: null, key: 'abc' });
  const page = routeFor(
    admit(headOf('/devtools/page/T1', 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: k\r\n')),
  );
  assert.equal(page.page, 'T1');
  assert.throws(
    () => routeFor(admit(headOf('/devtools/page/T1', 'Upgrade: websocket\r\nSec-WebSocket-Key: k\r\n'))),
    /Sec-WebSocket-Version: 13/,
  );
  assert.throws(
    () => routeFor(admit(headOf('/devtools/page/', 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: k\r\n'))),
    /no such endpoint/,
  );
  assert.throws(
    () => routeFor(admit(headOf('/nope', 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: k\r\n'))),
    /no such endpoint/,
  );
});

test('discovery: paths parse like proxy/discovery.rs', () => {
  assert.deepEqual(parseDiscovery('GET', '/json'), { kind: 'list' });
  assert.deepEqual(parseDiscovery('GET', '/json/list?t=1'), { kind: 'list' });
  assert.deepEqual(parseDiscovery('GET', '/json/'), { kind: 'list' });
  assert.deepEqual(parseDiscovery('GET', '/json/version'), { kind: 'version' });
  assert.deepEqual(parseDiscovery('PUT', '/json/new?about:blank'), { kind: 'new', url: 'about:blank' });
  assert.throws(() => parseDiscovery('GET', '/json/new?about:blank'), /supports only the PUT verb/);
  assert.deepEqual(parseDiscovery('GET', '/json/activate/T1'), { kind: 'activate', id: 'T1' });
  assert.deepEqual(parseDiscovery('GET', '/json/close/T1'), { kind: 'close', id: 'T1' });
  for (const unknown of ['/json/activate/', '/json/close', '/json/protocol', '/jsonx', '/json/version/x']) {
    assert.throws(() => parseDiscovery('GET', unknown), /unknown discovery endpoint/, unknown);
  }
});

test('discovery: a new page URL is percent-decoded', () => {
  assert.equal(percentDecode('about:blank'), 'about:blank');
  assert.equal(percentDecode('https://e.example/a%20b?q=%26'), 'https://e.example/a b?q=&');
  assert.equal(percentDecode('100%'), '100%');
  assert.equal(percentDecode('%zz%4'), '%zz%4');
});

// ── peer check (proxy/peer.rs tests) ───────────────────────────────────────

test('peer: lsof lists only the client end held by our uid', () => {
  const PEER = '127.0.0.1:50123';
  const OURS = '127.0.0.1:41000';
  const OTHER = '127.0.0.1:50124';
  const client = `${PEER}->${OURS}`;
  const output = (rows) => rows.map(([fd, uid, name]) => `p1\nu${uid}\nf${fd}\nn${name}\n`).join('');
  assert.ok(lsofLists(output([[10, 501, `${OURS}->${PEER}`], [20, 501, client]]), client, 501));
  assert.ok(!lsofLists(output([[10, 501, `${OURS}->${PEER}`], [20, 502, client]]), client, 501), 'another user');
  assert.ok(!lsofLists(output([[10, 501, `${OURS}->${PEER}`]]), client, 501), 'only our own end');
  assert.ok(!lsofLists(output([[20, 501, `${OTHER}->${OURS}`]]), client, 501), 'some other connection');
  assert.ok(!lsofLists(`p1\nu501\np2\nf3\nn${client}\n`, client, 501), 'a uid from an earlier record never carries over');
  assert.ok(!lsofLists('', client, 501));
});

function hexWord(octets) {
  return Buffer.from(octets).readUInt32LE(0).toString(16).toUpperCase().padStart(8, '0');
}

function procEnd(octets, port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  if (octets.length === 4) return `${hexWord(octets)}:${hexPort}`;
  const words = [];
  for (let i = 0; i < 16; i += 4) words.push(hexWord(octets.slice(i, i + 4)));
  return `${words.join('')}:${hexPort}`;
}

function procRow(local, remote, uid) {
  return `   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 4242 1 0000000000000000 20 4 30 10 -1`;
}

test('peer: /proc/net/tcp rows accept a client of our uid', () => {
  const PEER = { family: 'IPv4', address: '127.0.0.1', port: 50123 };
  const OURS = { family: 'IPv4', address: '127.0.0.1', port: 41000 };
  const OTHER = { family: 'IPv4', address: '127.0.0.1', port: 50124 };
  const v4 = (endpoint) => procEnd(endpoint.address.split('.').map(Number), endpoint.port);
  const mapped = (endpoint) => procEnd([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...endpoint.address.split('.').map(Number)], endpoint.port);
  const rows = (list) => list.join('\n');
  assert.ok(procfsSameUser(rows([procRow(v4(OURS), v4(PEER), 1000), procRow(v4(PEER), v4(OURS), 1000)]), PEER, OURS));
  assert.ok(
    procfsSameUser(rows([procRow(v4(OURS), v4(PEER), 1000), procRow(mapped(PEER), mapped(OURS), 1000)]), PEER, OURS),
    'a dual-stack client shows up in tcp6, v4-mapped',
  );
  assert.ok(!procfsSameUser(rows([procRow(v4(OURS), v4(PEER), 1000), procRow(v4(PEER), v4(OURS), 1001)]), PEER, OURS));
  assert.ok(!procfsSameUser(rows([procRow(v4(OURS), v4(PEER), 1000), procRow(v4(OTHER), v4(OURS), 1000)]), PEER, OURS));
  assert.ok(!procfsSameUser(rows([procRow(v4(OURS), v4(PEER), 1000)]), PEER, OURS), 'our own end alone');
  assert.ok(!procfsSameUser('', PEER, OURS));
});

// ── the proxy: admission before launch, discovery, pipes ───────────────────

function proxyBroker() {
  const broker = new FakeBroker();
  broker.reply = (method, params = {}) => {
    if (method === 'Browser.getVersion') {
      return {
        product: 'HeadlessChrome/999',
        protocolVersion: '1.3',
        userAgent: 'UA',
        jsVersion: '1.0',
        revision: 'r1',
      };
    }
    if (method === 'Target.getTargets') {
      return {
        targetInfos: [
          { targetId: 'T1', type: 'page', title: 'A', url: 'https://a.test/' },
          { targetId: 'B1', type: 'browser', title: '', url: '' },
        ],
      };
    }
    if (method === 'Target.createTarget') return { targetId: 'T9' };
    if (method === 'Target.activateTarget' && params.targetId === 'missing') {
      throw new Error('No target with given id found');
    }
    return {};
  };
  return broker;
}

async function startTestProxy({ broker = proxyBroker(), peerCheck = async () => true, onTarget = () => {} } = {}) {
  let launches = 0;
  const proxy = await startProxy({
    broker: async () => {
      launches += 1;
      return broker;
    },
    peerCheck,
    onTarget,
  });
  return { proxy, broker, launches: () => launches };
}

function httpRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseResponse(text) {
  const at = text.indexOf('\r\n\r\n');
  return { head: text.slice(0, at), body: text.slice(at + 4), status: text.slice(0, text.indexOf('\r\n')) };
}

test('proxy: a web-page request is refused before anything launches', async () => {
  const { proxy, broker, launches } = await startTestProxy();
  try {
    const response = parseResponse(
      await httpRequest(proxy.port, headOf('/json/list', 'Origin: http://evil.test\r\n', { host: `127.0.0.1:${proxy.port}` })),
    );
    assert.equal(response.status, 'HTTP/1.1 403 Forbidden');
    assert.match(response.body, /requests from a web browser are refused/);
    assert.equal(launches(), 0, 'the lazy launch did not run');
    assert.equal(broker.commands.length, 0, 'nor did any CDP command');
    const noUpgrade = parseResponse(await httpRequest(proxy.port, headOf('/devtools/browser/B1', '', { host: `127.0.0.1:${proxy.port}` })));
    assert.equal(noUpgrade.status, 'HTTP/1.1 403 Forbidden');
    assert.equal(launches(), 0);
  } finally {
    await proxy.close();
  }
});

test('proxy: /json is answered from the broker with proxy-pointing sockets', async () => {
  const { proxy, broker, launches } = await startTestProxy();
  try {
    const list = parseResponse(
      await httpRequest(proxy.port, headOf('/json/list', '', { host: `127.0.0.1:${proxy.port}` })),
    );
    assert.equal(list.status, 'HTTP/1.1 200 OK');
    assert.match(list.head, /Content-Type: application\/json/);
    const entries = JSON.parse(list.body);
    assert.equal(entries.length, 1, 'browser targets are filtered');
    assert.deepEqual(entries[0], {
      description: '',
      devtoolsFrontendUrl: '',
      id: 'T1',
      title: 'A',
      type: 'page',
      url: 'https://a.test/',
      webSocketDebuggerUrl: `ws://127.0.0.1:${proxy.port}/devtools/page/T1`,
    });
    assert.equal(launches(), 1);

    const version = JSON.parse(
      parseResponse(await httpRequest(proxy.port, headOf('/json/version', '', { host: `127.0.0.1:${proxy.port}` }))).body,
    );
    assert.deepEqual(version, {
      Browser: 'HeadlessChrome/999',
      'Protocol-Version': '1.3',
      'User-Agent': 'UA',
      'V8-Version': '1.0',
      'WebKit-Version': 'r1',
      webSocketDebuggerUrl: `ws://127.0.0.1:${proxy.port}/devtools/browser/B1`,
    });
    assert.equal(broker.commandsFor('Browser.getVersion').length >= 1, true);
  } finally {
    await proxy.close();
  }
});

test('proxy: /json/new is PUT-only and creates from the broker', async () => {
  const { proxy, launches } = await startTestProxy();
  try {
    const refused = parseResponse(
      await httpRequest(proxy.port, headOf('/json/new?about:blank', '', { host: `127.0.0.1:${proxy.port}` })),
    );
    assert.equal(refused.status, 'HTTP/1.1 405 Method Not Allowed');
    assert.equal(launches(), 0, 'refused before the launch');
    const created = JSON.parse(
      parseResponse(
        await httpRequest(
          proxy.port,
          headOf('/json/new?https%3A%2F%2Fe.test%2Fa%20b', '', { host: `127.0.0.1:${proxy.port}`, method: 'PUT' }),
        ),
      ).body,
    );
    assert.deepEqual(created, {
      description: '',
      devtoolsFrontendUrl: '',
      id: 'T9',
      title: 'https://e.test/a b',
      type: 'page',
      url: 'https://e.test/a b',
      webSocketDebuggerUrl: `ws://127.0.0.1:${proxy.port}/devtools/page/T9`,
    });
  } finally {
    await proxy.close();
  }
});

test('proxy: unknown targets are Chrome 404s, known ones are activated and closed', async () => {
  const { proxy } = await startTestProxy();
  try {
    const missing = parseResponse(
      await httpRequest(proxy.port, headOf('/json/activate/missing', '', { host: `127.0.0.1:${proxy.port}` })),
    );
    assert.equal(missing.status, 'HTTP/1.1 404 Not Found');
    assert.equal(missing.body, 'No such target id: missing');
    const activated = parseResponse(
      await httpRequest(proxy.port, headOf('/json/activate/T1', '', { host: `127.0.0.1:${proxy.port}` })),
    );
    assert.equal(activated.body, 'Target activated');
    assert.equal(
      parseResponse(await httpRequest(proxy.port, headOf('/json/close/T1', '', { host: `127.0.0.1:${proxy.port}` }))).body,
      'Target is closing',
    );
  } finally {
    await proxy.close();
  }
});

test('proxy: a foreign peer is closed unread, before anything launches', async () => {
  const { proxy, broker, launches } = await startTestProxy({ peerCheck: async () => false });
  try {
    const received = await new Promise((resolve) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      const chunks = [];
      socket.on('connect', () => socket.write(headOf('/json/list', '', { host: `127.0.0.1:${proxy.port}` })));
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', () => {});
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    assert.equal(received, '', 'not even a response');
    assert.equal(launches(), 0);
    assert.equal(broker.commands.length, 0);
  } finally {
    await proxy.close();
  }
});

// ── the WebSocket pump ─────────────────────────────────────────────────────

class TestWsClient {
  static connect(port, path) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const key = crypto.randomBytes(16).toString('base64');
      let buffer = Buffer.alloc(0);
      let upgraded = false;
      let head = '';
      const messages = [];
      const waiters = [];

      const deliver = () => {
        for (let i = 0; i < waiters.length; i += 1) {
          const waiter = waiters[i];
          const found = messages.findIndex((message) => waiter.predicate(message));
          if (found !== -1) {
            const [message] = messages.splice(found, 1);
            waiters.splice(i, 1);
            i -= 1;
            waiter.resolve(message);
          }
        }
      };

      const parseFrames = () => {
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = buffer[0] & 0x0f;
          const masked = (buffer[1] & 0x80) !== 0;
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < offset + 2) return;
            length = buffer.readUInt16BE(offset);
            offset += 2;
          } else if (length === 127) {
            if (buffer.length < offset + 8) return;
            length = Number(buffer.readBigUInt64BE(offset));
            offset += 8;
          }
          if (masked) throw new Error('a server frame must not be masked');
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) {
            messages.push(JSON.parse(payload.toString('utf8')));
            deliver();
          } else if (opcode === 0x8) {
            socket.end();
            return;
          }
        }
      };

      const client = {
        socket,
        key,
        get head() {
          return head;
        },
        send(message) {
          const text = typeof message === 'string' ? message : JSON.stringify(message);
          socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'), { mask: true }));
        },
        recv(predicate = () => true, timeout = 2000) {
          const found = messages.findIndex((message) => predicate(message));
          if (found !== -1) return Promise.resolve(messages.splice(found, 1)[0]);
          return new Promise((resolveMessage, rejectMessage) => {
            const timer = setTimeout(() => {
              const at = waiters.indexOf(waiter);
              if (at !== -1) waiters.splice(at, 1);
              rejectMessage(new Error('no WebSocket message'));
            }, timeout);
            const waiter = {
              predicate,
              resolve: (message) => {
                clearTimeout(timer);
                resolveMessage(message);
              },
            };
            waiters.push(waiter);
          });
        },
        close() {
          socket.end();
        },
      };

      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const at = buffer.indexOf('\r\n\r\n');
          if (at === -1) return;
          head = buffer.subarray(0, at).toString('utf8');
          buffer = buffer.subarray(at + 4);
          upgraded = true;
          if (!head.startsWith('HTTP/1.1 101')) {
            reject(new Error(`bad upgrade: ${head}`));
            return;
          }
          resolve(client);
        }
        parseFrames();
      });
      socket.on('connect', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
        );
      });
    });
  }
}

test('proxy: a browser WebSocket pumps commands and events, and the tap follows intents', async () => {
  const reported = [];
  const { proxy, broker } = await startTestProxy({ onTarget: (target) => reported.push(target) });
  const ws = await TestWsClient.connect(proxy.port, '/devtools/browser/B1');
  try {
    const expected = crypto.createHash('sha1').update(ws.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.ok(ws.head.includes(`Sec-WebSocket-Accept: ${expected}`), ws.head);

    ws.send({ id: 1, method: 'Target.getTargets', params: {} });
    const reply = await ws.recv((message) => message.id === 1);
    assert.equal(reply.result.targetInfos.length, 2);

    broker.lastClient().emitEvent({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S1', targetInfo: { targetId: 'T1', type: 'page' } },
    });
    const event = await ws.recv((message) => message.method === 'Target.attachedToTarget');
    assert.deepEqual(event, {
      method: 'Target.attachedToTarget',
      params: { sessionId: 'S1', targetInfo: { targetId: 'T1', type: 'page' } },
    });

    ws.send({ id: 2, method: 'Page.navigate', params: { url: 'https://a.test/' }, sessionId: 'S1' });
    await ws.recv((message) => message.id === 2);
    await until(() => reported.includes('T1'));

    ws.send({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' });
    await ws.recv((message) => message.id === 3);
    ws.send({ id: 4, method: 'Page.enable', params: {}, sessionId: 'S1' });
    await ws.recv((message) => message.id === 4);
    assert.deepEqual(reported, ['T1'], 'only the intent command was reported');
    assert.equal(broker.commandsFor('Page.navigate')[0].opts.sessionId, 'S1');
  } finally {
    ws.close();
    await proxy.close();
  }
});

test('proxy: a page WebSocket attaches its page session and defaults commands to it', async () => {
  const reported = [];
  const { proxy, broker } = await startTestProxy({ onTarget: (target) => reported.push(target) });
  const ws = await TestWsClient.connect(proxy.port, '/devtools/page/T1');
  try {
    assert.deepEqual(broker.sessionForCalls, ['T1']);
    ws.send({ id: 1, method: 'Page.navigate', params: { url: 'https://a.test/' } });
    await ws.recv((message) => message.id === 1);
    assert.deepEqual(broker.commandsFor('Page.navigate')[0].opts, { sessionId: 'session-T1' });
    await until(() => reported.includes('T1'));
    broker.lastClient().emitEvent({ method: 'Page.loadEventFired', sessionId: 'session-T1' });
    const loaded = await ws.recv((message) => message.method === 'Page.loadEventFired');
    assert.equal(loaded.sessionId, 'session-T1');
    broker.lastClient().emitEvent({ method: 'Other.session', sessionId: 'another-session' });
    await delay(50);
    await assert.rejects(ws.recv((message) => message.method === 'Other.session', 100), /no WebSocket message/);
  } finally {
    ws.close();
    await proxy.close();
  }
});

test('proxy: a broker failure is an error reply, not a dropped socket', async () => {
  const broker = proxyBroker();
  broker.reply = (method) => {
    if (method === 'Page.reload') throw new Error('boom');
    return {};
  };
  const { proxy } = await startTestProxy({ broker });
  const ws = await TestWsClient.connect(proxy.port, '/devtools/browser/B1');
  try {
    ws.send({ id: 9, method: 'Page.reload', params: {} });
    const reply = await ws.recv((message) => message.id === 9);
    assert.deepEqual(reply, { id: 9, error: { code: -32000, message: 'boom' } });
  } finally {
    ws.close();
    await proxy.close();
  }
});

test('proxy: WebSocket frames decode only masked, bounded client frames', () => {
  const payload = Buffer.from('{"id":1}');
  const frame = decodeFrame(encodeFrame(0x1, payload, { mask: true }));
  assert.equal(frame.opcode, 0x1);
  assert.deepEqual(frame.payload, payload);
  assert.throws(() => decodeFrame(encodeFrame(0x1, payload)), /masked/);
  const huge = Buffer.alloc(10);
  huge[0] = 0x81;
  huge[1] = 0x80 | 127;
  huge.writeBigUInt64BE(1_000_000n, 2);
  assert.throws(() => decodeFrame(huge, 1024), /message too big/);
  assert.equal(decodeFrame(encodeFrame(0x1, payload, { mask: true }).subarray(0, 4)), null, 'incomplete');
});

// ── annotate: install, pick gating, capture ────────────────────────────────

const pickJson = (kind, w, extra = {}) => {
  const rect = { x: 1, y: 2, w, h: 4 };
  return JSON.stringify({
    kind,
    selector: null,
    tag: null,
    html: null,
    text: null,
    rect,
    docRect: rect,
    url: 'http://a/',
    ...extra,
  });
};

test('annotate: install sends the Rust overlay sequence', async () => {
  const broker = new FakeBroker();
  const client = broker.client();
  const annotate = await install(client, 't1');
  assert.deepEqual(
    broker.commands.map((command) => command.method),
    ['Runtime.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument'],
  );
  assert.deepEqual(broker.commands[0].opts, { sessionId: 'session-t1' });
  assert.deepEqual(broker.commands[1].params, { name: BINDING, executionContextName: WORLD });
  assert.deepEqual(broker.commands[2].params, { source: OVERLAY, worldName: WORLD, runImmediately: true });
  assert.ok(OVERLAY.includes('__ompAnnotateSet') && OVERLAY.includes('__ompAnnotateHide'));
  assert.deepEqual(broker.sessionForCalls, ['t1']);
  await annotate.install();
  assert.equal(broker.commands.length, 3, 'idempotent');
});

test('annotate: an element pick is parsed and bounded', () => {
  const long = 'é'.repeat(20005);
  const parsed = parsePick(
    pickJson('element', 3, { selector: 'button.save', tag: 'button', html: long, text: long }),
  );
  assert.equal(parsed.selector, 'button.save');
  assert.equal(Array.from(parsed.html).length, 20000);
  assert.equal(Array.from(parsed.text).length, 500);
  assert.deepEqual(parsed.rect, { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(parsed.docRect, { x: 1, y: 2, w: 3, h: 4 });
});

test('annotate: document rect is required, validated and camelCase', () => {
  assert.equal(parsePick(pickJson('area', 3, { docRect: null })), null, 'nothing to capture');
  const documentRect = { x: 100, y: 1200, w: 3, h: 4 };
  const parsed = parsePick(pickJson('area', 3, { docRect: documentRect }));
  assert.deepEqual(parsed.docRect, documentRect);
  assert.equal('doc_rect' in parsed, false);
  for (const docRect of [
    { x: 0, y: 0, w: -1, h: 4 },
    { x: 0, y: 0, w: 3, h: -1 },
    { x: 'NaN', y: 0, w: 3, h: 4 },
    { x: 1e9, y: 0, w: 3, h: 4 },
  ]) {
    assert.equal(parsePick(pickJson('area', 3, { docRect })), null, JSON.stringify(docRect));
  }
});

test('annotate: an area pick carries no element fields and needs a pixel', () => {
  const parsed = parsePick(pickJson('area', 3, { selector: 'x', html: '<b>' }));
  assert.deepEqual([parsed.selector, parsed.tag, parsed.html, parsed.text], [null, null, null, null]);
  assert.equal(parsePick(pickJson('area', 0)), null, 'empty area');
  assert.equal(parsePick(pickJson('area', 0.5)), null, 'thinner than a pixel');
  assert.equal(parsePick(pickJson('area', -1)), null);
});

test('annotate: malformed and over-bound picks are refused', () => {
  assert.equal(parsePick('not json'), null);
  assert.equal(parsePick(pickJson('other', 3)), null);
  assert.equal(parsePick(pickJson('element', 3)), null, 'an element without selector and tag');
  const huge = pickJson('area', 3, { url: 'x'.repeat(300 * 1024) });
  assert.equal(parsePick(huge), null, 'over the payload bound');
});

test('annotate: a lone surrogate escape is refused', () => {
  const payload = pickJson('element', 3, { selector: 'p', tag: 'p' }).replace('http://a/', 'http://a/\\ud800');
  assert.equal(parsePick(payload), null);
});

test('annotate: a pick counts only after a panel mouse release', () => {
  const now = 10_000;
  const payload = pickJson('area', 3);
  assert.equal(pick(payload, { releasedAt: null, now }), null, 'no release');
  assert.equal(pick(payload, { releasedAt: now - PICK_AFTER_RELEASE_MS - 1, now }), null, 'too long ago');
  assert.equal(pick(payload, { releasedAt: now + 5, now }), null, 'a release in the future is not one');
  assert.equal(pick(payload, { releasedAt: now - 5, now }) !== null, true);
  assert.ok(pick(payload, { releasedAt: now - PICK_AFTER_RELEASE_MS, now }), 'at the edge');
  assert.ok(pick(payload, { releasedAt: now - 10, now }));
});

test('annotate: the view drive a pick: panel mouseup, then the binding reports it', async () => {
  const broker = new FakeBroker();
  const view = new View({ broker });
  const client = broker.clients[0];
  view.setActive('t1', 'session-t1');
  const annotate = await install(client, 't1', { view });
  const picked = [];
  annotate.on('pick', (one) => picked.push(one));

  client.emitEvent({
    method: 'Runtime.executionContextCreated',
    sessionId: 'session-t1',
    params: { context: { id: 5, name: WORLD } },
  });
  await annotate.setOn(true);
  const enables = broker.commandsFor('Runtime.evaluate');
  assert.deepEqual(enables.at(-2).params, {
    expression: 'window.__ompAnnotateSet && window.__ompAnnotateSet(true)',
    contextId: 5,
  });

  const binding = (payload) => ({
    method: 'Runtime.bindingCalled',
    sessionId: 'session-t1',
    params: { name: BINDING, executionContextId: 5, payload },
  });
  client.emitEvent(binding(pickJson('area', 3)));
  assert.equal(picked.length, 0, 'no panel release yet');

  await view.input('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 1, y: 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
  });
  client.emitEvent(binding(pickJson('element', 3, { selector: 'button.save', tag: 'button' })));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].selector, 'button.save');
  assert.deepEqual(annotate.picked, { sessionId: 'session-t1', contextId: 5, docRect: { x: 1, y: 2, w: 3, h: 4 } });

  annotate.lastPanelRelease = null; // the agent's own click is not the user's
  client.emitEvent(binding(pickJson('area', 3)));
  assert.equal(picked.length, 1);
  view.close();
});

test('annotate: a capture is cut to the viewport, scaled, and unhides the overlay', async () => {
  const broker = new FakeBroker();
  broker.reply = (method, params = {}) => {
    if (method === 'Runtime.evaluate' && params.expression === HIDE) {
      return { result: { value: { x: 0, y: 1000, w: 400, h: 300, dpr: 2 } } };
    }
    if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgo=' };
    return {};
  };
  const client = broker.client();
  const annotate = await install(client, 't1');
  client.emitEvent({ method: 'Runtime.executionContextCreated', sessionId: 'session-t1', params: { context: { id: 5, name: WORLD } } });
  annotate.lastPanelRelease = Date.now();
  annotate.handleEvent({
    method: 'Runtime.bindingCalled',
    sessionId: 'session-t1',
    params: {
      name: BINDING,
      executionContextId: 5,
      payload: pickJson('area', 3, { docRect: { x: 10, y: 1100, w: 50, h: 20 }, rect: { x: 10, y: 100, w: 50, h: 20 } }),
    },
  });
  assert.ok(annotate.picked);
  const shot = await annotate.capture(null);
  assert.deepEqual(shot, { data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  const screenshot = broker.commandsFor('Page.captureScreenshot').at(-1);
  assert.deepEqual(screenshot.params, {
    format: 'png',
    clip: { x: 10, y: 1100, width: 50, height: 20, scale: 1 },
    captureBeyondViewport: false,
  });
  const expressions = broker.commandsFor('Runtime.evaluate').map((command) => command.params.expression);
  assert.ok(expressions.indexOf(HIDE) < expressions.indexOf('0') || expressions.includes(HIDE));
  assert.equal(expressions.at(-1), SHOW, 'the overlay is shown again');
});

test('annotate: a capture without a pick, or of an area out of view, fails after showing the overlay', async () => {
  const broker = new FakeBroker();
  broker.reply = (method, params = {}) => {
    if (method === 'Runtime.evaluate' && params.expression === HIDE) {
      return { result: { value: { x: 0, y: 1000, w: 400, h: 300, dpr: 1 } } };
    }
    return {};
  };
  const client = broker.client();
  const annotate = await install(client, 't1');
  client.emitEvent({ method: 'Runtime.executionContextCreated', sessionId: 'session-t1', params: { context: { id: 5, name: WORLD } } });
  await assert.rejects(annotate.capture(null), /the page changed since the pick/);

  annotate.lastPanelRelease = Date.now();
  annotate.handleEvent({
    method: 'Runtime.bindingCalled',
    sessionId: 'session-t1',
    params: {
      name: BINDING,
      executionContextId: 5,
      payload: pickJson('area', 3, { docRect: { x: 0, y: 0, w: 50, h: 20 }, rect: { x: 0, y: 0, w: 50, h: 20 } }),
    },
  });
  await assert.rejects(annotate.capture(null), /the picked area is out of view/);
  assert.equal(broker.commandsFor('Runtime.evaluate').at(-1).params.expression, SHOW);
});

test('annotate: clips are cut to the viewport and scaled within the pixel budget', () => {
  const viewport = { area: { x: 0, y: 1000, w: 400, h: 300 }, dpr: 1 };
  assert.deepEqual(clip({ x: 10, y: 1100, w: 50, h: 20 }, viewport), {
    x: 10, y: 1100, width: 50, height: 20, scale: 1,
  });
  assert.deepEqual(clip({ x: -20, y: 900, w: 1000, h: 9000 }, viewport), {
    x: 0, y: 1000, width: 400, height: 300, scale: 1,
  }, 'a whole long page is only its visible part');
  for (const out of [{ x: 0, y: 0, w: 50, h: 20 }, { x: 0, y: 1299.5, w: 50, h: 20 }]) {
    assert.throws(() => clip(out, viewport), /the picked area is out of view/);
  }
  const big = { area: { x: 0, y: 0, w: 1600, h: 900 }, dpr: 4 };
  const computed = clip({ x: 0, y: 0, w: 1600, h: 900 }, big);
  assert.ok(Math.abs(1600 * 4 * computed.scale - 2000) < 1e-6);
  for (const bad of [
    { x: NaN, y: 1000, w: 5, h: 5 },
    { x: 0, y: Infinity, w: 5, h: 5 },
    { x: 0, y: 1000, w: NaN, h: 5 },
    { x: 0, y: 1000, w: -5, h: 5 },
  ]) {
    assert.throws(() => clip(bad, viewport), /invalid capture area/);
  }
});

test('annotate: viewports parse only finite, positive-DPR values', () => {
  assert.deepEqual(viewportOf({ x: 0, y: 10, w: 400, h: 300, dpr: 2 }), {
    area: { x: 0, y: 10, w: 400, h: 300 },
    dpr: 2,
  });
  for (const bad of [
    null,
    {},
    { x: 0, y: 10, w: 400, h: 300, dpr: 0 },
    { x: 0, y: '10', w: 400, h: 300, dpr: 1 },
    { x: 0, y: 10, w: -4, h: 300, dpr: 1 },
  ]) {
    assert.equal(viewportOf(bad), null, JSON.stringify(bad));
  }
});

// ── the annotate module surface ────────────────────────────────────────────

test('annotate: closing switches the overlay off in every context first', async () => {
  const broker = new FakeBroker();
  const client = broker.client();
  const annotate = await install(client, 't1');
  client.emitEvent({ method: 'Runtime.executionContextCreated', sessionId: 'session-t1', params: { context: { id: 5, name: WORLD } } });
  client.emitEvent({ method: 'Runtime.executionContextCreated', sessionId: 'session-t1', params: { context: { id: 6, name: WORLD } } });
  await annotate.setOn(true);
  const before = broker.commandsFor('Runtime.evaluate').length;
  annotate.close();
  const offs = broker.commandsFor('Runtime.evaluate').slice(before).map((command) => command.params);
  assert.deepEqual(offs, [
    { expression: 'window.__ompAnnotateSet && window.__ompAnnotateSet(false)', contextId: 5 },
    { expression: 'window.__ompAnnotateSet && window.__ompAnnotateSet(false)', contextId: 6 },
  ], 'the page keeps running after detach: its overlay must be off');
  assert.equal(broker.commandsFor('Runtime.evaluate').at(-1).opts.sessionId, 'session-t1');
});

test('annotate: Annotate is exported with the contract methods', () => {
  const annotate = new Annotate({ client: new FakeBroker().client(), targetId: 't1' });
  for (const method of ['install', 'setOn', 'pick', 'capture', 'close', 'notePanelRelease']) {
    assert.equal(typeof annotate[method], 'function', method);
  }
  assert.equal(typeof install, 'function');
  assert.equal(typeof Refusal, 'function');
});