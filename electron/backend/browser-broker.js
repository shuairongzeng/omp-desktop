'use strict';

/* The one CDP connection to a tab's Chromium: its debugging pipe, shared by
 * every client — the panel's own connection and each agent connection.
 *
 * Port of src-tauri/src/browser/broker/ (mod.rs, outbox.rs, route.rs,
 * fake.rs) and, at the wire level, src-tauri/src/browser/wire.rs.
 *
 * FRAMING — mirrors Rust exactly: the `--remote-debugging-pipe` protocol is
 * NUL-terminated JSON, NOT newline-delimited and NOT Content-Length. Chromium
 * reads fd 3 and writes fd 4; every message is one JSON object followed by a
 * single 0x00 byte (Rust `write_loop` pushes `0`; `read_loop` uses
 * `BufRead::read_until(0)`). A frame without its terminator at EOF, or one
 * over MAX_MESSAGE, ends the connection. (The batch context's
 * "newline-delimited" wording is wrong; Rust is the source of truth.)
 *
 * No port is opened anywhere: Chromium listens on nothing, so nothing can
 * reach the browser except through this broker. Each client gets a session of
 * its own (`Target.attachToBrowserTarget`), addressed without a `sessionId`:
 * the broker adds the client's root session on the way to Chromium and strips
 * it on the way back, gives every command a pipe-wide id, and keeps clients to
 * the sessions they own. Replies find their sender even when Chromium answers
 * without a `sessionId`.
 *
 * Node differences from the Rust implementation (documented, not hidden):
 * - No threads: the reader is a 'data' listener, the writer an async loop over
 *   the same bounded outbox, so a sender never blocks on the pipe either.
 * - No Weak<Broker>: dropping the JS handle cannot close the broker, because
 *   JS has no deterministic destruction. Call `broker.close()`; the launched
 *   Chromium's stderr end also closes it (browser-process.js), as does the
 *   pipe's own end.
 * - Rust copies each member's raw JSON through untouched; here routing parses
 *   and re-serialises (key order and JSON formatting of numbers can differ,
 *   values cannot).
 * - `client.send(method, params, {sessionId})` is the facade the Electron
 *   backend uses; it owns request ids and resolves with `result`. Messages
 *   that are neither its replies nor events are dropped (Rust exposes them).
 *   A client with an `event` listener is the reader and consumes events as
 *   they arrive; with none, events wait in that client's bounded outbox, and
 *   an overflow cuts the client exactly like Rust's reading thread falling
 *   behind.
 */

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

/** Longest message read from Chromium (Rust MAX_MESSAGE: 256 MiB). */
const MAX_MESSAGE = 256 << 20;

/** Longest command a client may send (Rust MAX_COMMAND: 100 MiB - 64 KiB). */
const MAX_COMMAND = (100 << 20) - (64 << 10);

/** Bytes that may wait in an outbox (Rust MAX_QUEUED: 64 MiB). */
const MAX_QUEUED = 64 << 20;

/** How long attaching a client may take (Rust ATTACH_TIMEOUT). */
const ATTACH_TIMEOUT = 10_000;

const CLOSED = 'browser connection closed';

/** `Fixture.roots`: the root sessions the fake has attached and not detached. */
const ROOTS = 'Fixture.roots';

/** A target id whose attach fails, as for a target that is gone. */
const ATTACH_REFUSED = 'Fixture.refusedTarget';

/** A target id whose attach succeeds, and whose session is detached at once. */
const DETACHED_AT_ONCE = 'Fixture.detachedTarget';

const ATTACH_METHODS = new Set(['Target.attachToTarget', 'Target.attachToBrowserTarget']);

// ── bounded outbox (outbox.rs) ───────────────────────────────────────────────

/**
 * A queue of CDP messages, bounded in bytes and never blocking whoever fills
 * it. Mirrors Rust `Outbox`: the message at the head does not count toward the
 * cap, so one larger than the cap still goes; `push` cuts the outbox (and
 * drops its backlog, the way a client that fell too far behind is cut), while
 * `offer` refuses without closing (the queue toward Chromium, whose sender
 * gets an error instead).
 */
class Outbox {
  constructor(limit = MAX_QUEUED) {
    this._items = [];
    this._bytes = 0;
    this._closed = false;
    this._limit = limit;
    this._waiters = [];
  }

  get size() {
    return this._items.length;
  }

  get bytes() {
    return this._bytes;
  }

  isClosed() {
    return this._closed;
  }

  _fits(length) {
    const front = this._items[0];
    return front === undefined || this._bytes - front.length + length <= this._limit;
  }

  _wake() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const wake of waiters) wake();
  }

  /** Queue `text`; false when closed, or just closed because it overflowed. */
  push(text) {
    return this._queue(text, true) === 'ok';
  }

  /** Queue `text` unless closed or it would overflow: 'ok' | 'closed' | 'full'. */
  offer(text) {
    return this._queue(text, false);
  }

  _queue(text, cut) {
    if (this._closed) return 'closed';
    if (!this._fits(text.length)) {
      if (cut) {
        this._closed = true;
        this._items = [];
        this._bytes = 0;
        this._wake();
      }
      return 'full';
    }
    this._items.push(text);
    this._bytes += text.length;
    this._wake();
    return 'ok';
  }

  /** No more messages; what is queued can still be received. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._wake();
  }

  _pop() {
    const text = this._items.shift();
    if (text !== undefined) this._bytes -= text.length;
    return text;
  }

  /** The next queued message without waiting, or undefined. */
  tryPop() {
    return this._pop();
  }

  _wait(timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      this._waiters.push(wake);
      if (timeoutMs !== null && timeoutMs !== undefined) {
        timer = setTimeout(wake, Math.max(0, timeoutMs));
      }
    });
  }

  /** The next message, waiting up to `timeoutMs`: {type, text?}. */
  async recv(timeoutMs = 0) {
    if (this._items.length === 0 && !this._closed) await this._wait(timeoutMs);
    const text = this._pop();
    if (text !== undefined) return { type: 'message', text };
    return { type: this._closed ? 'closed' : 'timeout' };
  }

  /** The next message, waiting as long as it takes; null once closed (even
   *  with messages left: they are not wanted any more). */
  async nextUntilClosed() {
    while (this._items.length === 0 && !this._closed) await this._wait(null);
    if (this._closed) return null;
    const text = this._pop();
    return text === undefined ? null : text;
  }
}

// ── framing ──────────────────────────────────────────────────────────────────

/**
 * Splits a byte stream into NUL-terminated JSON frames, without re-copying the
 * bytes already buffered (a 100 MiB message arrives in many chunks).
 */
class FrameDecoder {
  constructor(max, onFrame, onOverflow) {
    this._max = max;
    this._parts = [];
    this._length = 0;
    this._onFrame = onFrame;
    this._onOverflow = onOverflow;
  }

  feed(chunk) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let offset = 0;
    for (;;) {
      const end = bytes.indexOf(0, offset);
      if (end === -1) {
        const rest = bytes.length - offset;
        if (this._length + rest > this._max) {
          this._onOverflow();
          return;
        }
        if (rest > 0) {
          this._parts.push(bytes.subarray(offset));
          this._length += rest;
        }
        return;
      }
      const piece = bytes.subarray(offset, end);
      const frame = this._length > 0 ? Buffer.concat([...this._parts, piece]) : piece;
      this._parts = [];
      this._length = 0;
      offset = end + 1;
      this._onFrame(frame.toString('utf8'));
    }
  }
}

// ── envelopes (wire.rs) ──────────────────────────────────────────────────────

function parseObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * The top-level fields routing reads, or null when the message is not a CDP
 * envelope (Rust `Envelope::parse` fails on a non-object, a non-u64 id, a
 * non-string `method`, or a `sessionId` that is neither string nor null).
 */
function envelope(text) {
  const value = parseObject(text);
  if (!value) return null;
  const id = value.id;
  if (id !== undefined && id !== null && !(Number.isSafeInteger(id) && id >= 0)) return null;
  if (value.method !== undefined && typeof value.method !== 'string') return null;
  if (value.sessionId !== undefined && value.sessionId !== null && typeof value.sessionId !== 'string') {
    return null;
  }
  return {
    id: id === null ? undefined : id,
    method: value.method,
    sessionId: value.sessionId === null ? undefined : value.sessionId,
    value,
  };
}

/** The `sessionId` inside a `params` or `result` object, if it is a string. */
function innerSession(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return typeof value.sessionId === 'string' ? value.sessionId : undefined;
}

/** A CDP error reply, as Chromium words its own. */
function errorReply(id, sessionId, code, message) {
  const reply = { error: { code, message } };
  if (id !== undefined) reply.id = id;
  if (sessionId !== undefined) reply.sessionId = sessionId;
  return JSON.stringify(reply);
}

/** `text` without its top-level `sessionId`; other members keep their order. */
function stripSession(text) {
  const value = parseObject(text);
  if (!value) return text;
  const out = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== 'sessionId') out[key] = member;
  }
  return JSON.stringify(out);
}

/** `text` with `id` replaced by `id` and, when `strip`, without `sessionId`. */
function rebuild(text, id, strip) {
  const value = parseObject(text);
  if (!value) return text;
  const out = { id };
  for (const [key, member] of Object.entries(value)) {
    if (key === 'id') continue;
    if (strip && key === 'sessionId') continue;
    out[key] = member;
  }
  return JSON.stringify(out);
}

/** Write one NUL-terminated frame, resolving once the stream flushed it. */
function writeFrame(stream, text) {
  const bytes = Buffer.from(`${text}\u0000`, 'utf8');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    stream.once('error', onError);
    try {
      stream.write(bytes, (error) => finish(error || undefined));
    } catch (error) {
      finish(error);
    }
  });
}

// ── broker (broker/mod.rs) ───────────────────────────────────────────────────

let brokerCounter = 0;

class Broker {
  constructor(from, to, options = {}) {
    this.id = `${process.pid.toString(16).padStart(8, '0')}-${(brokerCounter += 1).toString(16)}`;
    /** Alias for callers that name it `browserId`. */
    this.browserId = this.id;
    this._from = from;
    this._to = to;
    this._maxQueued = options.maxQueuedBytes ?? MAX_QUEUED;
    this._toChromium = new Outbox(this._maxQueued);
    this._clients = new Map();
    this._roots = new Map();
    this._owners = new Map();
    this._inFlight = new Map();
    this._attaching = new Map();
    this._waiters = new Map();
    this._nextId = 1;
    this._nextClient = 0;
    this._alive = true;
    this._readerDone = false;
    this._writerDone = false;
    this._read = new FrameDecoder(MAX_MESSAGE, (frame) => this._route(frame), () => this.close());
    this._started = false;
  }

  /** Whether the pipe still works. */
  isAlive() {
    return this._alive;
  }

  _start() {
    if (this._started) return;
    this._started = true;
    const onData = (chunk) => {
      if (!this._alive) return;
      this._read.feed(chunk);
    };
    const onEnd = () => {
      this._readerDone = true;
      this.close();
    };
    this._from.on('data', onData);
    this._from.once('end', onEnd);
    this._from.once('close', onEnd);
    this._from.once('error', onEnd);
    this._writeLoop().catch(() => {});
  }

  async _writeLoop() {
    try {
      for (;;) {
        const message = await this._toChromium.nextUntilClosed();
        if (message === null) break;
        await writeFrame(this._to, message);
      }
    } catch {
      // The pipe failed: the connection is gone either way.
    }
    this._writerDone = true;
    try {
      this._to.end();
    } catch {
      // Already ended or destroyed by its owner.
    }
    this.close();
  }

  /** End the connection: every client and pending call ends, the writer stops.
   *  Idempotent and callable from anywhere. Chromium itself is the caller's
   *  to stop. */
  close() {
    if (!this._alive) {
      this._toChromium.close();
      return;
    }
    this._alive = false;
    for (const waiter of this._waiters.values()) waiter.reject(new Error(CLOSED));
    this._waiters.clear();
    this._attaching.clear();
    const clients = [...this._clients.values()];
    this._clients.clear();
    this._roots.clear();
    this._owners.clear();
    this._inFlight.clear();
    for (const client of clients) client._end();
    this._toChromium.close();
  }

  /** A root-session command; resolves with its `result`, rejects with its
   *  error (or `${method}: timed out` / `browser connection closed`). */
  request(method, params = {}, timeoutMs = null) {
    return new Promise((resolve, reject) => {
      if (!this._alive) {
        reject(new Error(CLOSED));
        return;
      }
      const wire = this._nextId++;
      let timer = null;
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this._waiters.set(wire, waiter);
      if (timeoutMs !== null && timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this._waiters.delete(wire)) reject(new Error(`${method}: timed out`));
        }, timeoutMs);
      }
      const message = JSON.stringify({ id: wire, method, params });
      this._enqueue(message).catch((error) => {
        if (this._waiters.delete(wire)) waiter.reject(error);
      });
    });
  }

  /** A browser-level client: a fresh browser session of its own. Returns at
   *  once; `send`/`sessionFor` await the attach and reject if it fails. */
  client() {
    const id = (this._nextClient += 1);
    const client = new BrokerClient(this, id, this._maxQueued);
    this._clients.set(id, client);
    client._ready = this._attachClient(client, 'Target.attachToBrowserTarget', {});
    client._ready.catch(() => this._removeClient(id));
    return client;
  }

  _enqueue(message) {
    const refused = this._toChromium.offer(message);
    if (refused === 'ok') return Promise.resolve();
    return Promise.reject(
      new Error(refused === 'full' ? 'browser pipe: too much waiting to be sent' : CLOSED),
    );
  }

  _attachClient(client, method, params) {
    if (!this._alive) return Promise.reject(new Error(CLOSED));
    const wire = this._nextId++;
    this._attaching.set(wire, { clientId: client._id });
    const attached = new Promise((resolve, reject) => {
      let timer = null;
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._attaching.delete(wire);
          reject(error);
        },
      };
      this._waiters.set(wire, waiter);
      timer = setTimeout(() => {
        if (this._waiters.delete(wire)) {
          this._attaching.delete(wire);
          reject(new Error(`${method}: timed out`));
        }
      }, ATTACH_TIMEOUT);
      this._enqueue(JSON.stringify({ id: wire, method, params })).catch((error) => {
        if (this._waiters.delete(wire)) waiter.reject(error);
      });
    });
    return attached.then((result) => {
      const session = innerSession(result);
      if (session === undefined) throw new Error('attach reply has no sessionId');
      if (!this._alive) throw new Error(CLOSED);
      return session;
    });
  }

  _isRoot(clientId, session) {
    return this._roots.get(clientId) === session;
  }

  _route(text) {
    if (!this._alive) return;
    const env = envelope(text);
    if (!env) return;
    if (env.id !== undefined) {
      const sent = this._inFlight.get(env.id);
      if (sent !== undefined) {
        this._inFlight.delete(env.id);
        this._deliverReply(sent, env, text);
        return;
      }
    }
    if (env.sessionId === undefined) {
      this._rootMessage(env, text);
      return;
    }
    const clientId = this._owners.get(env.sessionId);
    if (clientId === undefined) return;
    let rewritten = null;
    if (env.method === 'Target.attachedToTarget') {
      const child = innerSession(env.value.params);
      if (child !== undefined) this._owners.set(child, clientId);
    } else if (env.method === 'Target.detachedFromTarget') {
      const child = innerSession(env.value.params);
      if (child !== undefined && !this._isRoot(clientId, child)) this._owners.delete(child);
    }
    if (this._isRoot(clientId, env.sessionId)) rewritten = stripSession(text);
    this._deliver(clientId, rewritten === null ? text : rewritten);
  }

  _rootMessage(env, text) {
    if (env.id !== undefined) {
      const attaching = this._attaching.get(env.id);
      if (attaching !== undefined) {
        this._attaching.delete(env.id);
        const root = innerSession(env.value.result);
        if (root !== undefined && this._alive && this._clients.has(attaching.clientId)) {
          this._roots.set(attaching.clientId, root);
          this._owners.set(root, attaching.clientId);
        }
      }
      const waiter = this._waiters.get(env.id);
      if (waiter !== undefined) {
        this._waiters.delete(env.id);
        if (env.value.error) {
          const error = new Error(
            typeof env.value.error.message === 'string' ? env.value.error.message : 'CDP error',
          );
          error.code = env.value.error.code;
          error.data = env.value.error.data;
          waiter.reject(error);
        } else {
          waiter.resolve(env.value.result);
        }
      }
      return;
    }
    if (env.method === 'Target.detachedFromTarget') {
      const session = innerSession(env.value.params);
      if (session !== undefined) {
        for (const [clientId, root] of this._roots) {
          if (root === session) {
            this._removeClient(clientId);
            break;
          }
        }
      }
    }
  }

  _deliverReply(sent, env, text) {
    if (sent.attach) {
      const child = innerSession(env.value.result);
      if (child !== undefined) this._owners.set(child, sent.clientId);
    }
    const strip = env.sessionId !== undefined && this._isRoot(sent.clientId, env.sessionId);
    this._deliver(sent.clientId, rebuild(text, sent.id, strip));
  }

  _deliver(clientId, text) {
    const client = this._clients.get(clientId);
    if (!client) return;
    if (!client._incoming(text)) this._removeClient(clientId);
  }

  /** Send one client command as the client wrote it; may answer it with a
   *  local error reply instead of reaching Chromium. */
  _clientSend(client, text) {
    if (client._ended) throw new Error(CLOSED);
    if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND) {
      const value = parseObject(text);
      const id = value && Number.isSafeInteger(value.id) && value.id >= 0 ? value.id : undefined;
      const session = value && typeof value.sessionId === 'string' ? value.sessionId : undefined;
      client._incoming(errorReply(id, session, -32600, 'Message is too long'));
      return Promise.resolve();
    }
    const wire = this._nextId++;
    let routed;
    try {
      routed = this._outbound(client._id, text, wire);
    } catch (reply) {
      client._incoming(reply);
      return Promise.resolve();
    }
    return this._enqueue(routed).catch((error) => {
      this._inFlight.delete(wire);
      throw error;
    });
  }

  _outbound(clientId, text, wire) {
    const value = parseObject(text);
    if (!value) throw errorReply(undefined, undefined, -32700, 'Message must be a valid JSON object');
    const id = value.id;
    if (!(Number.isSafeInteger(id) && id >= 0)) {
      throw errorReply(undefined, undefined, -32600, "Message must have integer 'id' property");
    }
    let session;
    if ('sessionId' in value && value.sessionId !== null) {
      if (typeof value.sessionId !== 'string') {
        throw errorReply(id, undefined, -32600, "Message may have string 'sessionId' property");
      }
      session = value.sessionId;
    }
    let root;
    if (session === undefined) {
      root = this._roots.get(clientId);
      if (root === undefined) throw errorReply(id, undefined, -32001, 'Client is closed.');
    } else if (this._owners.get(session) !== clientId) {
      throw errorReply(id, session, -32001, 'Session with given id not found.');
    }
    const attach = typeof value.method === 'string' && ATTACH_METHODS.has(value.method);
    const out = { id: wire };
    if (root !== undefined) out.sessionId = root;
    // Rust `rewritten(root.is_some())`: the member sessionId is stripped
    // only when the root replaced it; a message that carries its OWN owned
    // session keeps it on the wire, or Chromium answers browser-level
    // ("'Page.navigate' wasn't found").
    for (const [key, member] of Object.entries(value)) {
      if (key === 'id') continue;
      if (key === 'sessionId' && root !== undefined) continue;
      out[key] = member;
    }
    this._inFlight.set(wire, { clientId, id, attach });
    return JSON.stringify(out);
  }

  _removeClient(clientId) {
    const client = this._clients.get(clientId);
    if (!client) return;
    this._clients.delete(clientId);
    const root = this._roots.get(clientId);
    this._roots.delete(clientId);
    for (const [session, owner] of this._owners) {
      if (owner === clientId) this._owners.delete(session);
    }
    for (const [wire, sent] of this._inFlight) {
      if (sent.clientId === clientId) this._inFlight.delete(wire);
    }
    for (const [wire, attaching] of this._attaching) {
      if (attaching.clientId !== clientId) continue;
      this._attaching.delete(wire);
      const waiter = this._waiters.get(wire);
      if (waiter !== undefined) {
        this._waiters.delete(wire);
        waiter.reject(new Error(CLOSED));
      }
    }
    client._end();
    if (root !== undefined && this._alive) {
      const wire = this._nextId++;
      this._enqueue(
        JSON.stringify({ id: wire, method: 'Target.detachFromTarget', params: { sessionId: root } }),
      ).catch(() => {});
    }
  }
}

// ── client ───────────────────────────────────────────────────────────────────

class BrokerClient extends EventEmitter {
  constructor(broker, id, maxQueued) {
    super();
    this._broker = broker;
    this._id = id;
    this._outbox = new Outbox(maxQueued);
    this._nextId = 0;
    this._pending = new Map();
    this._sessions = new Map();
    this._attachingTargets = new Map();
    this._ended = false;
    this._flushing = false;
    /** Resolves with the client's root session; rejects when attach failed. */
    this._ready = null;
  }

  _incoming(text) {
    if (this._ended) return true;
    const value = parseObject(text);
    if (!value) return true;
    const id = value.id;
    if (Number.isSafeInteger(id) && id >= 0 && this._pending.has(id)) {
      const { resolve, reject } = this._pending.get(id);
      this._pending.delete(id);
      if (value.error) {
        const error = new Error(
          typeof value.error.message === 'string' ? value.error.message : 'CDP error',
        );
        error.code = value.error.code;
        error.data = value.error.data;
        reject(error);
      } else {
        resolve(value.result);
      }
      return true;
    }
    if (typeof value.method !== 'string') return true; // a stray reply: no consumer here
    const event = { method: value.method, params: value.params, sessionId: value.sessionId };
    if (event.method === 'Target.detachedFromTarget') {
      const detached = innerSession(event.params);
      if (detached !== undefined) {
        for (const [target, session] of this._sessions) {
          if (session === detached) this._sessions.delete(target);
        }
      }
    }
    if (this.listenerCount('event') > 0) {
      this.emit('event', event);
      return true;
    }
    return this._outbox.push(JSON.stringify(event));
  }

  _flush() {
    if (this._flushing || this._ended) return;
    if (this.listenerCount('event') === 0) return;
    this._flushing = true;
    queueMicrotask(() => {
      this._flushing = false;
      while (!this._ended && this.listenerCount('event') > 0) {
        const text = this._outbox.tryPop();
        if (text === undefined) return;
        const value = parseObject(text);
        if (value) this.emit('event', value);
      }
    });
  }

  on(event, listener) {
    const result = super.on(event, listener);
    if (event === 'event') this._flush();
    return result;
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  /** Send one CDP command; resolves with its `result`. `opts.sessionId`
   *  addresses a flattened Target session. */
  async send(method, params = {}, opts = {}) {
    if (this._ended) throw new Error(CLOSED);
    await this._ready;
    if (this._ended) throw new Error(CLOSED);
    const id = (this._nextId += 1);
    const message = { id, method, params: params === undefined ? {} : params };
    if (opts && opts.sessionId !== undefined && opts.sessionId !== null) {
      message.sessionId = opts.sessionId;
    }
    const answered = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    try {
      await this._broker._clientSend(this, JSON.stringify(message));
    } catch (error) {
      this._pending.delete(id);
      throw error;
    }
    return answered;
  }

  /** The flattened session of `targetId`, attached once and cached (Rust
   *  `Target.attachToTarget` with `flatten: true`). */
  async sessionFor(targetId) {
    if (typeof targetId !== 'string') throw new Error('targetId must be a string');
    const cached = this._sessions.get(targetId);
    if (cached !== undefined) return cached;
    const attaching = this._attachingTargets.get(targetId);
    if (attaching !== undefined) return attaching;
    const attached = (async () => {
      const result = await this.send('Target.attachToTarget', { targetId, flatten: true });
      const session = innerSession(result);
      if (session === undefined) throw new Error('attach reply has no sessionId');
      this._sessions.set(targetId, session);
      return session;
    })().finally(() => this._attachingTargets.delete(targetId));
    this._attachingTargets.set(targetId, attached);
    return attached;
  }

  /** End this client; idempotent. Emits `close`. */
  close() {
    if (this._ended) return;
    this._outbox.close();
    this._broker._removeClient(this._id);
  }

  _end() {
    if (this._ended) return;
    this._ended = true;
    this._outbox.close();
    for (const { reject } of this._pending.values()) reject(new Error(CLOSED));
    this._pending.clear();
    this.emit('close');
  }
}

// ── the test fake (broker/fake.rs) ───────────────────────────────────────────

/**
 * A Chromium stand-in on the far end of an in-memory pipe pair, for suites
 * that drive a Broker without a browser.
 *
 * `reply(request)` answers a command with an array of messages, `null` to end
 * the pipe (as a crash would), or `undefined` for "no answer" (treated as an
 * empty array, like Rust's `Some(vec![])`). It may be async. Attaching,
 * detaching, `Browser.getVersion` and ROOTS are answered by the fake itself;
 * a command on a session the fake handed out reaches `reply` without its
 * `sessionId` (as the broker wrote it), exactly like fake.rs.
 */
class FakeBroker {
  static async create(reply = () => undefined, options = {}) {
    const fake = new FakeBroker(reply, options);
    await fake._ready;
    return fake;
  }

  constructor(reply = () => undefined, options = {}) {
    this._reply = reply;
    this._options = options;
    this._toBroker = new PassThrough();
    this._fromBroker = new PassThrough();
    this._live = new Set();
    this._attached = 0;
    this._finished = false;
    this._done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
    this._decoder = new FrameDecoder(
      MAX_MESSAGE,
      (frame) => this._onFrame(frame),
      () => this._finish(),
    );
    this._fromBroker.on('data', (chunk) => this._decoder.feed(chunk));
    this._fromBroker.on('end', () => this._finish());
    this._fromBroker.on('close', () => this._finish());
    this._fromBroker.on('error', () => this._finish());
    this._pipePair = { from: this._toBroker, to: this._fromBroker };
    this.broker = null;
    this._ready = connect(this._pipePair, { maxQueuedBytes: options.maxQueuedBytes }).then((broker) => {
      this.broker = broker;
      return broker;
    });
  }

  /** Resolves when the fake's pipe ended. */
  get done() {
    return this._done;
  }

  get finished() {
    return this._finished;
  }

  /** The in-memory pipe pair the broker serves (tests may inject raw frames). */
  get pipePair() {
    return this._pipePair;
  }

  /** How many root sessions were attached so far. */
  get attachCount() {
    return this._attached;
  }

  /** The root sessions attached and not detached, in order. */
  get liveRoots() {
    return [...this._live];
  }

  finish() {
    this._finish();
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    try {
      this._toBroker.end();
    } catch {
      // Already ended.
    }
    this._resolveDone();
  }

  async _onFrame(frame) {
    if (this._finished) return;
    const request = parseObject(frame);
    if (!request) {
      this._finish();
      return;
    }
    const session = typeof request.sessionId === 'string' ? request.sessionId : null;
    let answers;
    try {
      if (session === null) {
        answers = this._rootsAnswer(request);
        if (answers === undefined) answers = this._reply(clone(request));
      } else if (this._live.has(session)) {
        const copy = clone(request);
        delete copy.sessionId;
        answers = this._reply(copy);
      } else {
        answers = this._reply(clone(request));
      }
      answers = await answers;
    } catch {
      this._finish();
      return;
    }
    if (answers === null) {
      this._finish();
      return;
    }
    const list = answers === undefined ? [] : answers;
    for (const answer of list) {
      if (this._finished) return;
      const message = clone(answer);
      if (message !== null && typeof message === 'object') {
        if (message.sessionId === null) delete message.sessionId;
        else if (message.sessionId === undefined && session !== null) message.sessionId = session;
      }
      this._toBroker.write(`${JSON.stringify(message)}\u0000`);
    }
  }

  _rootsAnswer(request) {
    const method = request.method;
    if (method === 'Target.attachToBrowserTarget' || method === 'Target.attachToTarget') {
      return this._attach(request);
    }
    if (method === 'Target.detachFromTarget') {
      const session = request.params && request.params.sessionId;
      if (typeof session === 'string') this._live.delete(session);
      return [{ id: request.id, result: {} }];
    }
    if (method === ROOTS) return [{ id: request.id, result: { roots: [...this._live] } }];
    if (method === 'Browser.getVersion') {
      return [
        {
          id: request.id,
          result: {
            protocolVersion: '1.3',
            product: 'FakeChrome/1.0',
            revision: '@0',
            userAgent: 'FakeChrome',
            jsVersion: '0.0',
          },
        },
      ];
    }
    return undefined;
  }

  _attach(request) {
    const target = request.params && request.params.targetId;
    if (target === ATTACH_REFUSED) {
      return [
        { id: request.id, error: { code: -32602, message: 'No target with given id found' } },
      ];
    }
    if (target === undefined && this._options.refuseBrowserAttach) {
      return [{ id: request.id, error: { code: -32602, message: 'Browser attach refused' } }];
    }
    this._attached += 1;
    const root = `root-${this._attached}`;
    const answers = [{ id: request.id, result: { sessionId: root } }];
    if (target === DETACHED_AT_ONCE) {
      answers.push({
        sessionId: null,
        method: 'Target.detachedFromTarget',
        params: { sessionId: root, targetId: target },
      });
    } else {
      this._live.add(root);
    }
    return answers;
  }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ── entry point ──────────────────────────────────────────────────────────────

function normalizePipePair(pipePair) {
  if (Array.isArray(pipePair)) return { from: pipePair[0], to: pipePair[1] };
  if (pipePair && typeof pipePair === 'object') {
    const from = pipePair.from ?? pipePair.fromChromium ?? pipePair.readable;
    const to = pipePair.to ?? pipePair.toChromium ?? pipePair.writable;
    return { from, to };
  }
  return {};
}

/**
 * Serve the pipe pair: `from` (Chromium's replies) is read, `to` (Chromium's
 * commands) written, until the pipe ends or the broker is closed.
 *
 * `options.maxQueuedBytes` lowers the outbox cap (tests); production uses the
 * Rust MAX_QUEUED.
 */
async function connect(pipePair, options = {}) {
  const { from, to } = normalizePipePair(pipePair);
  if (!from || typeof from.on !== 'function') {
    throw new TypeError('connect: `from` must be a readable stream');
  }
  if (!to || typeof to.write !== 'function') {
    throw new TypeError('connect: `to` must be a writable stream');
  }
  const broker = new Broker(from, to, options);
  broker._start();
  return broker;
}

module.exports = {
  connect,
  Broker,
  BrokerClient,
  FakeBroker,
  Outbox,
  FrameDecoder,
  MAX_MESSAGE,
  MAX_COMMAND,
  MAX_QUEUED,
  ATTACH_TIMEOUT,
  CLOSED,
  ROOTS,
  ATTACH_REFUSED,
  DETACHED_AT_ONCE,
};