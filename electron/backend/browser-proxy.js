/* electron/backend/browser-proxy.js — Node port of
   `src-tauri/src/browser/proxy/`: the placeholder CDP port the agent
   connects to, in front of the lazily launched Chromium. Chromium itself
   listens on no TCP port (its CDP runs over the broker's pipe).

   Pipeline, in this order (nothing launches before admission):
   1. peer check, BEFORE any byte of the request is read: only a socket of
      the OS user this app runs as is served, anyone else's is closed
      unanswered. At most MAX_PEER_CHECKS run at once; a connection that
      finds none free is closed unanswered. Only a connection that passed
      waits for its head among MAX_UNVETTED, so another user's sockets never
      displace ours.
   2. request-head vetting (`admit`): origin-form target, exactly one
      loopback `Host`, no browser-only header, and outside `/json*` a
      WebSocket upgrade. A web page can therefore not start a Chromium.
   3. routing, then the lazy launch (`ensureBroker`, called once the request
      would be answered).
   4. `/json*` discovery answered FROM THE BROKER, with WebSocket URLs
      pointing back at this proxy.
   5. a WebSocket upgrade becomes a broker client of its own, pumped message
      by message, with a read-only Tap looking along. The tap's observer
      feed is a bounded, non-blocking queue; a tap that fails (or a full
      queue) switches observation off for that connection and NEVER stops
      forwarding.

   Framing note: the Broker pipe behind `browser-broker.js` is NOT newline
   delimited. Rust's `broker/mod.rs` reads with `BufRead::read_until(0)`, so
   each CDP message is NUL-terminated (JSON + 0x00). This module speaks the
   Broker/BrokerClient contract only, so it does not care, but the batch
   context's "newline-delimited" was wrong.

   Peer check — Rust vs Node, expressibility gap:
   - Rust macOS does NOT use `getpeereid`; `proxy/peer.rs` runs
     `/usr/sbin/lsof -nP -a -iTCP@<peer> -sTCP:ESTABLISHED -Fpun`, and
     accepts only when the line naming `<peer>-><ours>` belongs to
     `geteuid()`'s process. Linux reads `/proc/net/tcp{,6}`; Windows reads
     `GetExtendedTcpTable`. Anything else refuses.
   - Node has no `getpeereid`/`SO_PEERCRED` binding: `node:net` exposes no
     credentials for the peer, and `socket._handle.fd` is internal and not
     usable from JS without a native addon. This port therefore mirrors
     Rust's lsof path exactly (`lsofLists` is a line-for-line port of
     `lsof::lists`), and the Linux `/proc/net/tcp{,6}` parse
     (`procfsSameUser`). Windows refuses (no TCP owner table readable from
     JS). Same check, same trust model, but a snapshot via lsof rather than a
     kernel credential call — a native addon would be needed to close that.
     `startProxy({ peerCheck })` exists so tests (and a future addon) can
     substitute the check.

   Deviations: `startProxy` takes an already-created Broker or an async
   factory (`ensureBroker`), so "launch" is the factory call and admission
   provably precedes it. Discovery needs the broker id for its URL;
   `broker.id` (or `browserId`) is used, else one generated per proxy. */

'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const { execFile } = require('node:child_process');

/** Longest request head a client may send (`MAX_HEAD`). */
const MAX_HEAD = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
/** Admitted connections served at once. */
const MAX_CONNECTIONS = 32;
/** Peer checks running at once. */
const MAX_PEER_CHECKS = 8;
/** Our user's connections waiting for their request head, at most. */
const MAX_UNVETTED = 32;
/** Largest command the broker takes (`broker::MAX_COMMAND`). */
const MAX_COMMAND = 100 * 1024 * 1024 - 64 * 1024;
/** Largest command the tap reads; a client message over it is skipped. */
const MAX_TAPPED_COMMAND = 1 << 20;
/** Largest reply or event the tap reads. */
const MAX_REPLY = 64 << 10;
/** Messages queued for one connection's observer, at most. */
const QUEUE_MESSAGES = 1024;
/** Bytes queued for one connection's observer, at most. */
const QUEUE_BYTES = 4 * MAX_TAPPED_COMMAND;
const LSOF_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const TEXT = 'text/plain; charset=UTF-8';
const JSON_TYPE = 'application/json; charset=UTF-8';
/** Chromium's error for a target id it does not know. */
const NO_TARGET = 'No target with given id found';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** `Target.attachedToTarget` as Chromium writes it (see `proxy/feed.rs`). */
const ATTACHED = '{"method":"Target.attachedToTarget"';

const PAGE_INTENTS = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  'Page.bringToFront',
  'Page.captureScreenshot',
]);

function messageOf(error) {
  if (error == null) return 'unknown error';
  return typeof error === 'string' ? error : String(error.message ?? error);
}

function withTimeout(promise, millis, method) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method}: timed out`)), millis);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A response refusing a request: status line and body. */
class Refusal extends Error {
  constructor(status, body) {
    super(body);
    this.status = status;
    this.body = body;
  }
}

// ── HTTP head: reading and vetting (`proxy/http.rs`) ───────────────────────

/** A field name of token characters and a value without control bytes. */
function validHeader(name, value) {
  if (!name) return false;
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) return false;
  for (const byte of Buffer.from(value, 'utf8')) {
    if (byte < 0x20 && byte !== 0x09) return false;
    if (byte === 0x7f) return false;
  }
  return true;
}

/**
 * A header only a web browser sends: `Origin`, or fetch metadata other than
 * `Sec-Fetch-Mode` (Node's fetch sends that alone; a browser adds
 * `Sec-Fetch-Site` too).
 */
function fromBrowser(name) {
  const lower = name.toLowerCase();
  if (lower === 'origin') return true;
  return lower.startsWith('sec-fetch-') && lower !== 'sec-fetch-mode';
}

/** Whitelist the literal hosts Chromium accepts, with an optional port. */
function loopbackAuthority(authority) {
  let host = authority;
  let suffix = '';
  if (authority.startsWith('[::1]')) {
    host = '[::1]';
    suffix = authority.slice(5);
  } else {
    const colon = authority.indexOf(':');
    if (colon !== -1) {
      host = authority.slice(0, colon);
      suffix = authority.slice(colon);
    }
  }
  const lower = host.toLowerCase();
  if (lower !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  if (!suffix) return true;
  const port = suffix.slice(1);
  return suffix.startsWith(':') && /^[0-9]+$/.test(port) && Number(port) <= 65535;
}

/**
 * Vets a request head (with or without its trailing CRLFCRLF) before the
 * lazy launch. `Err`-style: throws a `Refusal` with the reason.
 */
function admit(head) {
  let text;
  if (typeof head === 'string') text = head;
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(head));
    } catch {
      throw new Refusal('403 Forbidden', 'request head is not text');
    }
  }
  if (text.endsWith('\r\n\r\n')) text = text.slice(0, -4);
  const lines = text.split('\r\n');
  const [method = '', target] = (lines.shift() ?? '').split(' ');
  if (typeof target !== 'string' || !target.startsWith('/')) {
    throw new Refusal('403 Forbidden', 'origin-form target required');
  }
  let host = null;
  let browser = false;
  let upgrade = false;
  let wsKey = null;
  let wsVersion = null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Refusal('403 Forbidden', 'malformed header');
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (!validHeader(name, value)) throw new Refusal('403 Forbidden', 'malformed header');
    const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '');
    const lower = name.toLowerCase();
    if (lower === 'host') {
      if (host != null) throw new Refusal('403 Forbidden', 'loopback Host required');
      host = trimmed;
    } else if (fromBrowser(name)) {
      browser = true;
    } else if (lower === 'upgrade') {
      upgrade ||= trimmed.split(',').some((token) => token.trim().toLowerCase() === 'websocket');
    } else if (lower === 'sec-websocket-key') {
      wsKey = trimmed;
    } else if (lower === 'sec-websocket-version') {
      wsVersion = trimmed;
    }
  }
  if (host == null || !loopbackAuthority(host)) {
    throw new Refusal('403 Forbidden', 'loopback Host required');
  }
  if (browser) throw new Refusal('403 Forbidden', 'requests from a web browser are refused');
  if (!target.startsWith('/json') && !upgrade) {
    throw new Refusal('403 Forbidden', 'WebSocket upgrade required');
  }
  return { method, target, wsKey, wsVersion };
}

/**
 * Read up to the blank line ending the request head. Returns
 * `{ head, headLen, leftover }` (head includes the terminator) or null on
 * EOF, over the cap, or past the deadline.
 */
function readHead(socket, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onEnd);
      // Keep the bytes after the head in the stream until the WebSocket pump
      // takes the socket: flowing mode without a listener would drop them.
      socket.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      const from = Math.max(0, buffer.length - 3);
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf('\r\n\r\n', from);
      if (at !== -1) {
        const headLen = at + 4;
        return finish(headLen <= MAX_HEAD ? { head: buffer.subarray(0, headLen), headLen, leftover: buffer.subarray(headLen) } : null);
      }
      if (buffer.length > MAX_HEAD) finish(null);
    };
    const onEnd = () => finish(null);
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
    socket.on('close', onEnd);
    socket.resume();
  });
}

/** A plain response; the connection ends with it. */
function respond(socket, status, body, contentType = TEXT) {
  if (socket.destroyed) return;
  const bytes = Buffer.byteLength(body, 'utf8');
  socket.write(`HTTP/1.1 ${status}\r\nContent-Type: ${contentType}\r\nContent-Length: ${bytes}\r\nConnection: close\r\n\r\n${body}`);
  socket.end();
}

// ── routing and `/json*` discovery (`proxy/discovery.rs`) ──────────────────

/**
 * The discovery request behind a `/json*` target. `Err` (thrown `Refusal`)
 * is the response refusing it. Only `/json/new` cares about the method.
 */
function parseDiscovery(method, target) {
  const mark = target.indexOf('?');
  const rawPath = mark === -1 ? target : target.slice(0, mark);
  const query = mark === -1 ? '' : target.slice(mark + 1);
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (path === '/json' || path === '/json/list') return { kind: 'list' };
  if (path === '/json/version') return { kind: 'version' };
  if (path === '/json/new') {
    if (method === 'PUT') return { kind: 'new', url: query };
    throw new Refusal('405 Method Not Allowed', '/json/new creates a page: it supports only the PUT verb');
  }
  if (path.startsWith('/json/activate/')) {
    const id = path.slice('/json/activate/'.length);
    if (id) return { kind: 'activate', id };
  }
  if (path.startsWith('/json/close/')) {
    const id = path.slice('/json/close/'.length);
    if (id) return { kind: 'close', id };
  }
  throw new Refusal('404 Not Found', 'unknown discovery endpoint');
}

/** What an admitted request asks for, decided before anything launches. */
function routeFor(admitted) {
  if (admitted.target.startsWith('/json')) {
    return { kind: 'discovery', request: parseDiscovery(admitted.method, admitted.target) };
  }
  const path = admitted.target.split(/[?#]/)[0] ?? '';
  let page = null;
  if (!path.startsWith('/devtools/browser/')) {
    const prefix = '/devtools/page/';
    const id = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (!id) throw new Refusal('404 Not Found', 'no such endpoint');
    page = id;
  }
  if (admitted.method !== 'GET' || admitted.wsVersion !== '13') {
    throw new Refusal('400 Bad Request', 'a WebSocket upgrade is a GET with Sec-WebSocket-Version: 13');
  }
  const key = admitted.wsKey;
  if (!key) throw new Refusal('400 Bad Request', 'Sec-WebSocket-Key required');
  return { kind: 'socket', page, key };
}

/** `%XX` escapes decoded; anything else, a malformed escape too, kept. */
function percentDecode(text) {
  if (!text.includes('%')) return text;
  const bytes = Buffer.from(text, 'utf8');
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    const escaped = bytes[i] === 0x25 && isHex(bytes[i + 1]) && isHex(bytes[i + 2])
      ? parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16)
      : null;
    if (escaped != null) {
      out.push(escaped);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  return Buffer.from(out).toString('utf8');
}

function isHex(byte) {
  return byte != null && /[0-9A-Fa-f]/.test(String.fromCharCode(byte));
}

/** `value[key]` (null when absent). */
function take(value, key) {
  const found = value?.[key];
  return found === undefined ? null : found;
}

/** A `/json/list` entry from a CDP `TargetInfo`. */
function entry(info, port) {
  const id = take(info, 'targetId');
  return {
    description: '',
    devtoolsFrontendUrl: '',
    id,
    title: take(info, 'title'),
    type: take(info, 'type'),
    url: take(info, 'url'),
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id ?? ''}`,
  };
}

function jsonAnswer(value) {
  return { status: '200 OK', contentType: JSON_TYPE, body: JSON.stringify(value) };
}

function textAnswer(body) {
  return { status: '200 OK', contentType: TEXT, body };
}

/**
 * A command on target `id` that failed with `error`: Chrome's own 404 when
 * the target does not exist, the error otherwise.
 */
function unknownTarget(id, error) {
  if (messageOf(error) === NO_TARGET) {
    return { status: '404 Not Found', contentType: TEXT, body: `No such target id: ${id}` };
  }
  throw error;
}

/** One discovery client per broker, reused by every discovery request. */
function discoveryClient(state, broker) {
  if (!state.discovery || state.discovery.broker !== broker) {
    try {
      state.discovery?.client?.close?.();
    } catch {
      // A dead broker's client is already closed.
    }
    state.discovery = { broker, client: broker.client() };
  }
  return state.discovery.client;
}

/** Answer `request` from `broker`; `port` is this proxy's. */
async function answerDiscovery(request, { broker, state, port }) {
  const client = discoveryClient(state, broker);
  const call = (method, params) => withTimeout(client.send(method, params ?? {}), state.discoveryTimeoutMs, method);
  const browserId = broker.id ?? broker.browserId ?? (state.browserId ??= crypto.randomUUID());
  switch (request.kind) {
    case 'version': {
      const version = await call('Browser.getVersion', {});
      const out = {};
      for (const [key, field] of [
        ['Browser', 'product'],
        ['Protocol-Version', 'protocolVersion'],
        ['User-Agent', 'userAgent'],
        ['V8-Version', 'jsVersion'],
        ['WebKit-Version', 'revision'],
      ]) {
        out[key] = take(version, field);
      }
      out.webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/browser/${browserId}`;
      return jsonAnswer(out);
    }
    case 'list': {
      const targets = await call('Target.getTargets', {});
      const infos = targets?.targetInfos;
      if (!Array.isArray(infos)) throw new Error('Target.getTargets: no targetInfos');
      return jsonAnswer(infos.filter((info) => info?.type !== 'browser' && info?.type !== 'tab').map((info) => entry(info, port)));
    }
    case 'new': {
      const url = percentDecode(request.url ?? '') || 'about:blank';
      const created = await call('Target.createTarget', { url });
      const id = take(created, 'targetId');
      if (typeof id !== 'string') throw new Error('Target.createTarget: no targetId');
      return jsonAnswer(entry({ targetId: id, type: 'page', title: url, url }, port));
    }
    case 'activate': {
      try {
        await call('Target.activateTarget', { targetId: request.id });
      } catch (error) {
        return unknownTarget(request.id, error);
      }
      return textAnswer('Target activated');
    }
    case 'close': {
      try {
        await call('Target.closeTarget', { targetId: request.id });
      } catch (error) {
        return unknownTarget(request.id, error);
      }
      return textAnswer('Target is closing');
    }
    default:
      throw new Refusal('404 Not Found', 'unknown discovery endpoint');
  }
}

/** The status of a failed broker command: gone (503) or refused (502). */
function brokerFailure(broker) {
  return typeof broker?.isAlive === 'function' && !broker.isAlive() ? '503 Service Unavailable' : '502 Bad Gateway';
}

// ── peer check (`proxy/peer.rs`) ───────────────────────────────────────────

/**
 * Whether `lsof -F pun` output lists a socket named `name` held by a
 * process running as `uid`. One field per line, tagged by its first
 * character: `p` starts a process, `u` is its uid, `f` a descriptor, `n` the
 * file's name.
 */
function lsofLists(output, name, uid) {
  let owner = null;
  for (const line of String(output).split('\n')) {
    const tag = line.slice(0, 1);
    const value = line.slice(1);
    if (!tag) continue;
    if (tag === 'p') owner = null;
    else if (tag === 'u') owner = /^[0-9]+$/.test(value) ? Number(value) : null;
    else if (tag === 'n' && value === name && owner === uid) return true;
  }
  return false;
}

/** `/proc/net/tcp` word: `u32::from_str_radix(hex).to_ne_bytes()`. */
function procfsAddress(hex) {
  const value = parseInt(hex, 16);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return [...bytes].join('.');
}

/** `ADDR:PORT` as the kernel prints it (port in host order). */
function procfsEndpoint(field) {
  const [address, portHex] = String(field).split(':');
  if (!address || !portHex) return null;
  const port = parseInt(portHex, 16);
  if (!Number.isInteger(port)) return null;
  if (address.length === 8) {
    return { family: 'IPv4', address: procfsAddress(address), port };
  }
  if (address.length === 32) {
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 4; i += 1) {
      const word = parseInt(address.slice(i * 8, i * 8 + 8), 16);
      if (!Number.isInteger(word)) return null;
      bytes.writeUInt32LE(word, i * 4);
    }
    // A dual-stack client shows up v4-mapped: read it as its v4 address.
    const mapped = bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) return { family: 'IPv4', address: [...bytes.subarray(12, 16)].join('.'), port };
    const words = [];
    for (let i = 0; i < 8; i += 1) words.push(bytes.readUInt16BE(i * 2).toString(16));
    return { family: 'IPv6', address: words.join(':'), port };
  }
  return null;
}

function sameEndpoint(left, right) {
  return left != null && right != null && left.family === right.family && left.address === right.address && left.port === right.port;
}

/**
 * `procfs::same_user_in`: whether the client's end (`peer` -> `ours`) and our
 * own end (`ours` -> `peer`) of the connection are owned by the same uid.
 */
function procfsSameUser(tables, peer, ours) {
  let client = null;
  let server = null;
  for (const line of String(tables).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    // `sl local_address rem_address st tx:rx tr:when retrnsmt uid ...`
    const local = procfsEndpoint(fields[1]);
    const remote = procfsEndpoint(fields[2]);
    const uid = /^[0-9]+$/.test(fields[7]) ? Number(fields[7]) : null;
    if (!local || !remote || uid == null) continue;
    if (sameEndpoint(local, peer) && sameEndpoint(remote, ours)) client = uid;
    else if (sameEndpoint(local, ours) && sameEndpoint(remote, peer)) server = uid;
  }
  return client != null && client === server;
}

/** `/usr/sbin/lsof` output, or null when it cannot run or times out. */
function runLsof(selection) {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/lsof',
      ['-nP', '-a', selection, '-sTCP:ESTABLISHED', '-Fpun'],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: 'utf8' },
      (error, stdout) => {
        if (error && (error.killed || (error.code !== 1 && error.code !== 0))) return resolve(null);
        resolve(typeof stdout === 'string' ? stdout : '');
      },
    );
  });
}

/**
 * Whether the peer of a connection is a socket of our OS user. `peer` and
 * `ours` are `{ address, family, port }`.
 */
async function defaultSameUser({ peer, ours }) {
  if (!peer || !ours) return false;
  if (peer.family !== 'IPv4' || ours.family !== 'IPv4') return false;
  const name = `${peer.address}:${peer.port}->${ours.address}:${ours.port}`;
  if (process.platform === 'darwin') {
    const output = await runLsof(`-iTCP@${peer.address}:${peer.port}`);
    return output != null && lsofLists(output, name, process.geteuid());
  }
  if (process.platform === 'linux') {
    const tables = [];
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        tables.push(await fsp.readFile(path, 'utf8'));
      } catch {
        // The table does not exist on this kernel: the other one may.
      }
    }
    return procfsSameUser(tables.join('\n'), peer, ours);
  }
  // Windows refuses: its TCP owner table is not readable from Node.
  return false;
}

// ── the tap and its observer feed (`proxy/tap.rs`, `proxy/feed.rs`) ────────

/**
 * Whether `method` is a command that means "the agent worked in this page"
 * (`Tap::on_command`'s intent list). `Target.attachToTarget` is deliberately
 * not one: puppeteer stays attached to every page.
 */
function intentTap(method) {
  return method === 'Target.activateTarget' || method === 'Target.createTarget' || PAGE_INTENTS.has(method) || method.startsWith('Input.');
}

const MAX_SESSIONS = 4096;
const MAX_PENDING = 1024;

/**
 * A read-only observer of one proxy connection's CDP messages. One per
 * connection; `onTarget(targetId)` is told the page the agent worked in.
 */
class Tap {
  constructor({ page = null, onTarget = () => {} } = {}) {
    this.onTarget = onTarget;
    this.page = page;
    /** Session to its page; null for a session on something else. */
    this.sessions = new Map();
    /** Requests in flight, awaiting their reply: id -> request. */
    this.pending = new Map();
  }

  /** One complete message; `Err`-style: throws when the tap must go off. */
  onMessage(direction, message) {
    let envelope = message;
    if (typeof message === 'string') {
      try {
        envelope = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!envelope || typeof envelope !== 'object') return;
    if (direction === 'client') this._onCommand(envelope);
    else this._onReplyOrEvent(envelope);
  }

  _onCommand(command) {
    const method = typeof command.method === 'string' ? command.method : null;
    if (method == null) return;
    const id = Number.isInteger(command.id) ? command.id : null;
    if (method === 'Target.createTarget' && id != null) this._insert(id, { kind: 'create' });
    if (method === 'Target.attachToTarget' && id != null) {
      const targetId = command.params?.targetId;
      if (typeof targetId === 'string') this._insert(id, { kind: 'attach', target: targetId });
    }
    if (method === 'Target.activateTarget') {
      const targetId = command.params?.targetId;
      if (typeof targetId === 'string') this.onTarget(targetId);
      return;
    }
    const target = PAGE_INTENTS.has(method) || method.startsWith('Input.') ? this._targetOf(command) : null;
    if (target != null) this.onTarget(target);
  }

  /** The page a command is for: its session's, or the page connection's. */
  _targetOf(command) {
    if (typeof command.sessionId === 'string') {
      const page = this.sessions.get(command.sessionId);
      return page ?? null;
    }
    return this.page;
  }

  _insert(id, request) {
    this.pending.set(id, request);
    if (this.pending.size > MAX_PENDING) {
      let oldest = null;
      for (const key of this.pending.keys()) {
        if (oldest == null || key < oldest) oldest = key;
      }
      if (oldest != null) this.pending.delete(oldest);
    }
  }

  _onReplyOrEvent(message) {
    const method = typeof message.method === 'string' ? message.method : null;
    if (method === 'Target.attachedToTarget') {
      const session = message.params?.sessionId;
      if (typeof session === 'string') {
        const info = message.params?.targetInfo;
        const page = info?.type === 'page' && typeof info.targetId === 'string' ? info.targetId : null;
        this.sessions.set(session, page);
      }
    } else if (method === 'Target.detachedFromTarget') {
      const session = message.params?.sessionId;
      if (typeof session === 'string') this.sessions.delete(session);
    } else if (method == null) {
      this._onReply(message);
    }
    if (this.sessions.size > MAX_SESSIONS) throw new Error('too many sessions');
  }

  /**
   * A reply: `Target.createTarget` names the new page (agent intent),
   * `Target.attachToTarget` the session of its page (no intent). Result or
   * error, the reply retires its request.
   */
  _onReply(reply) {
    if (!Number.isInteger(reply.id)) return;
    const request = this.pending.get(reply.id);
    if (request == null) return;
    this.pending.delete(reply.id);
    if (request.kind === 'create') {
      const targetId = reply.result?.targetId;
      if (typeof targetId === 'string') this.onTarget(targetId);
    } else {
      const session = reply.result?.sessionId;
      if (typeof session === 'string' && !this.sessions.has(session)) this.sessions.set(session, request.target);
    }
  }
}

/**
 * The bounded, non-blocking observer feed of one connection. Pushing never
 * waits on the tap; a full queue (or a tap error) switches observation off,
 * and forwarding goes on regardless.
 */
class Observer {
  constructor(tap) {
    this.tap = tap;
    this.queue = [];
    this.bytes = 0;
    this.off = null;
    this.scheduled = false;
  }

  /** Queue `message` of `direction` ('client' | 'server') when it fits. */
  push(direction, message) {
    if (this.off) return;
    const size = Buffer.byteLength(message, 'utf8');
    const cap = direction === 'client' ? MAX_TAPPED_COMMAND : message.startsWith(ATTACHED) ? MAX_TAPPED_COMMAND : MAX_REPLY;
    if (size > cap) return;
    if (this.queue.length >= QUEUE_MESSAGES || this.bytes + size > QUEUE_BYTES) {
      this.off = 'observer queue full';
      return;
    }
    this.queue.push([direction, message, size]);
    this.bytes += size;
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this._drain());
    }
  }

  _drain() {
    this.scheduled = false;
    while (this.queue.length && !this.off) {
      const [direction, message, size] = this.queue.shift();
      this.bytes -= size;
      try {
        this.tap.onMessage(direction, message);
      } catch (error) {
        this.off = messageOf(error);
      }
    }
    if (this.off) {
      this.queue.length = 0;
      this.bytes = 0;
    }
  }

  /** Why the tap is off for this connection, if it is. */
  get offReason() {
    return this.off;
  }
}

// ── WebSocket framing (`proxy/ws.rs`, without tungstenite) ─────────────────

class WsError extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

function utf8Strict(payload) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new WsError(1003, 'CDP messages are UTF-8 JSON');
  }
}

/**
 * One frame from `buffer`, or null when it is incomplete. Client frames must
 * be masked; protocol violations throw a `WsError` with the close code.
 */
function decodeFrame(buffer, maxSize = Infinity) {
  if (buffer.length < 2) return null;
  if (buffer[0] & 0x70) throw new WsError(1002, 'reserved bits set');
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsError(1009, 'message too big');
    length = Number(big);
    offset += 8;
  }
  // Refused from the header: waiting for a frame the cap can never accept
  // would stall the connection instead of failing it.
  if (length > maxSize) throw new WsError(1009, 'message too big');
  if (!masked) throw new WsError(1002, 'client frames must be masked');
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i & 3];
  return { fin, opcode, payload, bytes: offset + length };
}

/** One frame to write; server frames are unmasked unless `mask` is set. */
function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, maskKey = null } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const length = data.length;
  const maskBit = mask ? 0x80 : 0;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), maskBit | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, data]);
  const key = maskKey ?? crypto.randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < length; i += 1) body[i] ^= key[i & 3];
  return Buffer.concat([header, Buffer.from(key), body]);
}

/**
 * An accepted WebSocket: assembles messages from frames, answers control
 * frames, and hands complete texts to `onMessage` (binary frames are texts
 * too when they are UTF-8, as in `proxy/ws.rs`).
 */
class WsSocket {
  constructor(socket, { leftover = null, maxSize = MAX_COMMAND, onMessage = () => {}, onClose = () => {} } = {}) {
    this.socket = socket;
    this.maxSize = maxSize;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = leftover && leftover.length ? Buffer.from(leftover) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentSize = 0;
    this.fragmentOpcode = null;
    this.closed = false;
    this.finished = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.resume();
    this._drain();
  }

  sendText(text) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    try {
      if (!this.socket.destroyed) this.socket.write(encodeFrame(0x8, payload));
    } catch {
      // The peer is gone; the socket below closes anyway.
    }
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    this._finish();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._drain();
  }

  _drain() {
    while (!this.closed) {
      let frame;
      try {
        frame = decodeFrame(this.buffer, this.maxSize);
      } catch (error) {
        this.close(error.code ?? 1002, error.message);
        return;
      }
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.length > 125)) {
      return this.close(1002, 'bad control frame');
    }
    switch (frame.opcode) {
      case 0x0: {
        if (this.fragmentOpcode == null) return this.close(1002, 'unexpected continuation');
        this.fragments.push(frame.payload);
        this.fragmentSize += frame.payload.length;
        if (this.fragmentSize > this.maxSize) return this.close(1009, 'message too big');
        if (!frame.fin) return;
        const opcode = this.fragmentOpcode;
        const payload = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentSize = 0;
        this.fragmentOpcode = null;
        return this._deliver(opcode, payload);
      }
      case 0x1:
      case 0x2:
        if (this.fragmentOpcode != null) return this.close(1002, 'expected continuation');
        if (frame.payload.length > this.maxSize) return this.close(1009, 'message too big');
        if (frame.fin) return this._deliver(frame.opcode, frame.payload);
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.fragmentSize = frame.payload.length;
        return undefined;
      case 0x8: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        return this.close(code, '');
      }
      case 0x9:
        if (!this.socket.destroyed) this.socket.write(encodeFrame(0xa, frame.payload));
        return undefined;
      case 0xa:
        return undefined; // pong
      default:
        return this.close(1002, 'unknown opcode');
    }
  }

  _deliver(opcode, payload) {
    if (payload.length > this.maxSize) return this.close(1009, 'message too big');
    let text;
    try {
      text = utf8Strict(payload);
    } catch (error) {
      return this.close(error.code, error.message);
    }
    // `opcode` is only read for the protocol's sake: both are text here.
    void opcode;
    this.onMessage(text);
    return undefined;
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.onClose();
  }
}

// ── the proxy ──────────────────────────────────────────────────────────────

/**
 * Bind the placeholder port and start accepting.
 *
 * `broker` is a Broker or an async factory returning one; the factory is
 * called only once a request passed the peer check, admission and routing
 * (so nothing launches Chromium for a refused request). `peerCheck` defaults
 * to `defaultSameUser` and may be replaced (tests, or a native addon).
 */
async function startProxy(options = {}) {
  const {
    broker: brokerSource = null,
    port = 0,
    host = '127.0.0.1',
    headTimeoutMs = HEAD_TIMEOUT_MS,
    peerCheck = defaultSameUser,
    onTarget = () => {},
    discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
  } = options;
  if (brokerSource == null) throw new Error('startProxy: broker required');
  const ensureBroker = typeof brokerSource === 'function' ? brokerSource : async () => brokerSource;

  const state = {
    ensureBroker,
    peerCheck,
    onTarget,
    headTimeoutMs,
    discoveryTimeoutMs,
    stopped: false,
    nextId: 0,
    peerChecks: 0,
    connections: 0,
    unvetted: [],
    live: new Map(),
    discovery: null,
    browserId: null,
    port: 0,
  };

  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => {});
    acceptConnection(state, socket).catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  state.port = server.address().port;

  return {
    port: state.port,
    server,
    /** Stop accepting and cut every live socket. */
    close: () => stopProxy(state, server),
  };
}

async function stopProxy(state, server) {
  state.stopped = true;
  try {
    state.discovery?.client?.close?.();
  } catch {
    // Already closed with its broker.
  }
  state.discovery = null;
  for (const socket of state.live.values()) socket.destroy();
  state.live.clear();
  await new Promise((resolve) => server.close(() => resolve()));
}

function takePermit(state, which) {
  if (state[which] >= (which === 'peerChecks' ? MAX_PEER_CHECKS : MAX_CONNECTIONS)) return false;
  state[which] += 1;
  return true;
}

/** Peer check first: a foreign socket is closed before anything is read. */
async function peerIsOurs(state, socket) {
  if (!takePermit(state, 'peerChecks')) return false;
  try {
    return await state.peerCheck({
      peer: { address: socket.remoteAddress, family: socket.remoteFamily, port: socket.remotePort },
      ours: { address: socket.localAddress, family: socket.localFamily, port: socket.localPort },
    });
  } catch {
    return false;
  } finally {
    state.peerChecks -= 1;
  }
}

function awaitHead(state, id, socket) {
  while (state.unvetted.length >= MAX_UNVETTED) {
    const oldest = state.unvetted.shift();
    oldest.socket.destroy();
  }
  state.unvetted.push({ id, socket });
  return true;
}

function headDone(state, id) {
  state.unvetted = state.unvetted.filter((waiting) => waiting.id !== id);
}

async function acceptConnection(state, socket) {
  if (state.stopped) return socket.destroy();
  const id = state.nextId++;
  state.live.set(id, socket);
  socket.on('close', () => {
    state.live.delete(id);
    headDone(state, id);
  });
  if (!(await peerIsOurs(state, socket))) return socket.destroy();
  if (state.stopped) return socket.destroy();
  awaitHead(state, id, socket);
  const head = await readHead(socket, state.headTimeoutMs);
  headDone(state, id);
  if (!head) return socket.destroy();

  let admitted;
  try {
    admitted = admit(head.head);
  } catch (error) {
    if (error instanceof Refusal) return respond(socket, error.status, error.body);
    return socket.destroy();
  }
  let route;
  try {
    route = routeFor(admitted);
  } catch (error) {
    if (error instanceof Refusal) return respond(socket, error.status, error.body);
    return socket.destroy();
  }
  if (!takePermit(state, 'connections')) {
    return respond(socket, '503 Service Unavailable', 'too many connections');
  }
  socket.once('close', () => {
    state.connections -= 1;
  });

  let broker;
  try {
    broker = await state.ensureBroker();
  } catch (error) {
    return respond(socket, '503 Service Unavailable', messageOf(error));
  }
  if (state.stopped) return socket.destroy();

  if (route.kind === 'discovery') {
    let answer;
    try {
      answer = await answerDiscovery(route.request, { broker, state, port: state.port });
    } catch (error) {
      if (error instanceof Refusal) return respond(socket, error.status, error.body);
      return respond(socket, brokerFailure(broker), messageOf(error));
    }
    return respond(socket, answer.status, answer.body, answer.contentType);
  }

  const client = broker.client();
  let pageSession = null;
  try {
    if (route.page != null) pageSession = await client.sessionFor(route.page);
  } catch (error) {
    try {
      client.close?.();
    } catch {
      // Already gone with the broker.
    }
    return respond(socket, brokerFailure(broker), messageOf(error));
  }
  return serveWebSocket(state, socket, route, head.leftover, client, pageSession);
}

/** Accept one agent's WebSocket and pump it through its broker client. */
function serveWebSocket(state, socket, route, leftover, client, pageSession) {
  const accept = crypto.createHash('sha1').update(route.key + WS_GUID).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay?.(true);

  const tap = new Tap({ page: route.page ?? null, onTarget: state.onTarget });
  if (pageSession != null) tap.sessions.set(pageSession, route.page);
  const observer = new Observer(tap);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      client.close?.();
    } catch {
      // Already closed by the broker.
    }
  };

  let ws = null;

  const forward = async (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // the broker would refuse it; nothing to answer
    }
    if (!message || typeof message.method !== 'string') return;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : (pageSession ?? undefined);
    const id = message.id;
    try {
      const result = await client.send(message.method, message.params ?? {}, sessionId != null ? { sessionId } : undefined);
      if (id != null) ws?.sendText(JSON.stringify({ id, result }));
    } catch (error) {
      if (id == null) return;
      const code = Number.isInteger(error?.code) ? error.code : -32000;
      ws?.sendText(JSON.stringify({ id, error: { code, message: messageOf(error) } }));
    }
  };

  ws = new WsSocket(socket, {
    leftover,
    onMessage: (text) => {
      observer.push('client', text); // tapped before it is forwarded
      forward(text);
    },
    onClose: finish,
  });

  client.on('event', (event) => {
    if (!event || typeof event.method !== 'string') return;
    const text = JSON.stringify({
      method: event.method,
      params: event.params ?? {},
      ...(event.sessionId != null ? { sessionId: event.sessionId } : {}),
    });
    observer.push('server', text); // tapped before it is forwarded
    if (pageSession != null && event.sessionId !== pageSession) return;
    ws.sendText(text);
  });
  client.on('close', () => ws.close(1001, 'browser connection closed'));
  socket.on('close', finish);
}

module.exports = {
  startProxy,
  admit,
  routeFor,
  parseDiscovery,
  answerDiscovery,
  intentTap,
  Tap,
  Observer,
  WsSocket,
  encodeFrame,
  decodeFrame,
  lsofLists,
  procfsSameUser,
  defaultSameUser,
  percentDecode,
  Refusal,
  MAX_HEAD,
  MAX_COMMAND,
  MAX_CONNECTIONS,
  MAX_PEER_CHECKS,
  MAX_UNVETTED,
  NO_TARGET,
};