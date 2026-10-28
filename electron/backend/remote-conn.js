'use strict';

/* remote-conn.js — the outbound relay WebSocket client, ported from
 * `src-tauri/src/remote/conn.rs`.
 *
 * One connector per enabled desktop: connect to the relay's `/ws?role=
 * desktop&device=…&token=…`, announce `device_info`, answer each phone's
 * `hs` handshake, and open/seal the E2E `enc` envelopes that carry every
 * business frame (contract v2). Framing parity notes:
 *
 *  - TLS: `pinned_cert_pem` present → trust exactly that cert (Node's `ca`
 *    replaces the Mozilla store, rustls's `RootCertStore::empty()` + add
 *    does the same); absent → system roots. Handshake failures are
 *    classified by `tlsFailureReason()` into the exact strings the Rust
 *    connector puts in the status line, so the Settings trust prompt
 *    triggers on the same text.
 *  - Backoff: 1s doubling to a 30s cap; the first failure of an attempt
 *    keeps its reason in `reconnecting (<reason>)`.
 *  - Close code 4000 stops the loop with the Rust "another desktop is
 *    online with this device id" message: retrying would trade the room
 *    back and forth forever.
 *  - Plaintext `cmd` is a pre-v2 phone and gets the contract's typed
 *    rejection so its UI can say "reload the phone page".
 *  - A bad envelope (tag/replay) drops that phone's session; its next
 *    `hs` re-establishes it.
 *
 * Events:
 *   'status'  (string)          — connector status line (Rust's set_status)
 *   'open'    ()                — socket ready
 *   'close'   ({code, reason})  — socket closed (before any retry)
 *   'frame'   (frame, meta)     — inbound plaintext control frame, or a
 *                                 decrypted inner frame with `meta.conn`
 *   'session' ({conn, ph})      — an `hs` installed fresh session keys
 *   'warn'    (message)         — E2E refusals worth logging
 *   'error'   (Error)           — an attempt failed (retry continues)
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const C = require('./remote-crypto');

// ── constants (conn.rs) ─────────────────────────────────────────────────────

/** Keepalive ping cadence (conn.rs `PING_EVERY`). */
const PING_EVERY_MS = 25_000;
/** First reconnect delay (conn.rs `run`). */
const BACKOFF_INITIAL_MS = 1_000;
/** Reconnect delay cap (conn.rs `BACKOFF_MAX`). */
const BACKOFF_MAX_MS = 30_000;
/** Connect attempt timeout (conn.rs `connect_once`). */
const CONNECT_TIMEOUT_MS = 15_000;
/** Relay close code: "replaced by a newer desktop for this device id". */
const REPLACED_CLOSE_CODE = 4000;
/** The status the Rust connector parks on after a 4000 close. */
const STATUS_REPLACED =
  'off (another desktop is online with this device id — remote.json was copied?)';

/** Control frames travel in plaintext (contract §frames table). */
const PLAINTEXT_TYPES = new Set([
  'hello',
  'peer',
  'device',
  'device_info',
  'ping',
  'pong',
  // Rust's remote_send: only res/evt ride enc envelopes; the pairing and
  // phone-admin frames go out plaintext (no phone session exists yet to
  // seal for — wrapping them silently dropped pair_begin: zero frames).
  'pair_begin',
  'pair_grant',
  'pair_deny',
  'list_phones',
  'revoke',
  'pair_hello',
  'pair_request',
  'pair_grant',
  'pair_code',
  'paired',
  'pair_done',
  'revoke',
  'list_phones',
  'hs',
]);

/** The contract's typed rejection for a pre-v2 plaintext business frame. */
const E2E_REQUIRED = 'e2e required — reload the phone page';

// ── TLS (conn.rs `tls_connector` / `tls_failure_reason`) ───────────────────

/**
 * ws TLS options mirroring `tls_connector`: a stored pin is the whole
 * trust store (Node's `ca` replaces the default roots), no pin means the
 * system roots. An unparsable pin falls back to system roots exactly like
 * Rust's `pinned_cert_der()` returning `None`.
 */
function tlsOptions(pinnedCertPem) {
  const pem = typeof pinnedCertPem === 'string' ? pinnedCertPem.trim() : '';
  if (!pem || !pem.includes('-----BEGIN CERTIFICATE-----')) {
    return { rejectUnauthorized: true };
  }
  // Rust's `pinned_cert_der()` returns None (→ system roots) when the PEM
  // body does not decode; do the same instead of handing ws garbage.
  const body = pem.split(/\r?\n/)
    .filter((line) => !line.startsWith('-----'))
    .join('')
    .trim();
  if (!body) return { rejectUnauthorized: true };
  try {
    if (!C.b64Decode(body).length) return { rejectUnauthorized: true };
  } catch {
    return { rejectUnauthorized: true };
  }
  const der = Buffer.from(body, 'base64');
  // rustls accepts a pinned LEAF as its own trust anchor; OpenSSL does not
  // (CA:FALSE leaves fail UNABLE_TO_VERIFY_LEAF_SIGNATURE as `ca`). Pin the
  // leaf by DER equality instead: same security, Node-shaped.
  const selfSignedLeaf = isSelfSignedLeaf(der);
  if (selfSignedLeaf) {
    return {
      rejectUnauthorized: false,
      checkServerIdentity: (_host, cert) =>
        cert && cert.raw && cert.raw.equals(der)
          ? undefined
          : new Error('pinned certificate mismatch'),
    };
  }
  return { ca: [pem], rejectUnauthorized: true };
}

/** issuer == subject and Basic Constraints CA:FALSE (or absent): a leaf
 *  that signed itself — the relay's cert shape. */
function isSelfSignedLeaf(der) {
  try {
    const cert = new (require('node:crypto').X509Certificate)(der);
    return cert.issuer === cert.subject && !/CA:TRUE/.test(cert.toString());
  } catch {
    return false;
  }
}

/** OpenSSL codes that all mean rustls's `CertificateError::UnknownIssuer`. */
const UNKNOWN_ISSUER_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);

/** The other certificate failures, named as rustls's `CertificateError`. */
const CERTIFICATE_ERROR_NAMES = {
  CERT_HAS_EXPIRED: 'Expired',
  CERT_NOT_YET_VALID: 'NotValidYet',
  CERT_REVOKED: 'Revoked',
  ERR_TLS_CERT_ALTNAME_INVALID: 'NotValidForName',
  CERT_SIGNATURE_FAILURE: 'BadSignature',
  CERT_INVALID_PURPOSE: 'InvalidPurpose',
};

/** Collect the error and its wrapped causes (ws nests TLS errors). */
function errorChain(err) {
  const out = [];
  let cur = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    out.push(cur);
    if (typeof cur === 'string') break;
    cur = cur.cause || cur.nativeError || null;
    if (cur === err) break;
  }
  return out;
}

/**
 * The connector's one user-fixable failure: the relay cert is untrusted
 * (self-signed and nothing pinned). Returns `null` for every other
 * failure, exactly like the Rust classifier — the caller formats those.
 *
 * Node has a single TLS wrap (ws surfaces OpenSSL codes on the error
 * directly), but the chain walk also covers `cause`/`nativeError` for the
 * `ERR_TLS_*` family, mirroring Rust's two match arms.
 */
function tlsFailureReason(err, optsPinned = false) {
  if (!err) return null;
  for (const node of errorChain(err)) {
    if (typeof node === 'string') continue;
    const code = node.code;
    if (typeof code === 'string') {
      if (UNKNOWN_ISSUER_CODES.has(code)) {
        return 'certificate not trusted (self-signed?)';
      }
      if (Object.prototype.hasOwnProperty.call(CERTIFICATE_ERROR_NAMES, code)) {
        return `certificate rejected: ${CERTIFICATE_ERROR_NAMES[code]}`;
      }
    }
    const message = typeof node.message === 'string' ? node.message : '';
    // A pinned `ca` that does not match the served cert fails as
    // ERR_TLS_CERT_ALTNAME_INVALID / DEPTH_ZERO_SELF_SIGNED_CERT against the
    // PIN, not the roots: naming it "not trusted" would re-offer the trust
    // prompt for a cert the user already pinned (retrust wording needs the
    // status to say certificate, but a wrong pin must not loop the prompt).
    if (optsPinned && /ALTNAME|CERT_HAS_EXPIRED|ERR_TLS/.test(String(node.code ?? ''))) continue;
    if (/self[- ]signed certificate/i.test(message)
      || /unable to verify the first certificate/i.test(message)
      || /unable to get (local )?issuer certificate/i.test(message)) {
      return 'certificate not trusted (self-signed?)';
    }
  }
  return null;
}

/** Rust's `tls_failure_reason(e).unwrap_or_else(|| format!("error: {e}"))`. */
function connectFailureReason(err) {
  const classified = tlsFailureReason(err);
  if (classified) return classified;
  const message = err && err.message ? err.message : String(err);
  if (/timed out|timeout/i.test(message)) return 'error: connect timeout (15s)';
  return `error: ${message}`;
}

/** Next reconnect delay: double, capped (conn.rs `backoff * 2` → 30s). */
function nextBackoff(currentMs) {
  const base = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : BACKOFF_INITIAL_MS;
  return Math.min(base * 2, BACKOFF_MAX_MS);
}

/** The full delay schedule starting at 1s (`backoffSchedule(3)` → 1s,2s,4s). */
function backoffSchedule(count) {
  const out = [];
  let ms = BACKOFF_INITIAL_MS;
  for (let i = 0; i < count; i += 1) {
    out.push(ms);
    ms = nextBackoff(ms);
  }
  return out;
}

// ── device identity (conn.rs `device_info_frame` / settings.rs) ────────────

/** Rust's `std::env::consts::OS` naming from Node's `process.platform`. */
function osName(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}

/** The machine hostname fallback (settings.rs `hostname`). */
function hostname(env = process.env) {
  const value = (env.COMPUTERNAME || env.HOSTNAME || '').trim();
  return value || null;
}

/** Chosen name, else hostname, else "omp-desktop"; capped at 80 chars. */
function displayName(deviceName, env = process.env) {
  const chosen = typeof deviceName === 'string' ? deviceName.trim() : '';
  const name = chosen || hostname(env) || 'omp-desktop';
  return Array.from(name).slice(0, 80).join('');
}

/** The first frame on every connect: this desktop in the phone's picker. */
function deviceInfoFrame({ deviceName = '', os = osName(), env = process.env } = {}) {
  return { t: 'device_info', name: displayName(deviceName, env), os };
}

// ── the connector ──────────────────────────────────────────────────────────

class RemoteConnector extends EventEmitter {
  /**
   * `options`:
   *   phones      — `{ ph: b64 ms }` (or Buffer) map, the paired-phone MSes
   *                 from `remote.json`; `setPhoneSecret` updates it live.
   *   deviceName  — picker name (empty → hostname fallback).
   *   os          — picker os tag (default: this machine).
   */
  constructor(options = {}) {
    super();
    this._phoneSecrets = new Map();
    this.setPhoneSecrets(options.phones || {});
    this.deviceName = typeof options.deviceName === 'string' ? options.deviceName : '';
    this.os = options.os || osName();

    /** conn id → { ph, keys: SessionKeys }. */
    this.sessions = new Map();
    /** conn id → { ph, online } (relay `peer` frames). */
    this.phoneConns = new Map();

    this.status = 'off';
    this.socket = null;
    this.backoffMs = BACKOFF_INITIAL_MS;
    this._queue = [];
    this._url = null;
    this._options = {};
    this._stopped = true;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._openWaiters = [];
  }

  // ── phone secrets ──────────────────────────────────────────────────────

  /**
   * Replace the ph → MS map. Accepts `remote.json`'s `phones` object
   * verbatim (`{ ph: { ms: "<b64>" } }`), a flat `{ ph: "<b64>" }` map,
   * or Buffers. An entry without `ms` is a pre-v2 pairing: it is skipped
   * (unpaired), exactly like Rust's `phone_ms()` returning None.
   */
  setPhoneSecrets(phones) {
    this._phoneSecrets = new Map();
    for (const [ph, value] of Object.entries(phones || {})) {
      if (value && typeof value === 'object' && !Buffer.isBuffer(value)
        && !(value instanceof Uint8Array)) {
        if (value.ms == null) continue; // pre-v2 entry: unpaired
        this.setPhoneSecret(ph, value.ms);
      } else {
        this.setPhoneSecret(ph, value);
      }
    }
  }

  /**
   * Store one phone's b64 (or raw) master secret. `null`/`undefined`
   * removes it (the phone reads as unpaired).
   */
  setPhoneSecret(ph, ms) {
    if (typeof ph !== 'string' || !ph) throw new TypeError('phone secret: bad ph');
    if (ms == null) {
      this._phoneSecrets.delete(ph);
      return;
    }
    const bytes = typeof ms === 'string' ? C.b64Decode(ms) : Buffer.from(ms);
    if (bytes.length !== C.KEY_LEN) throw new Error('phone secret: ms must be 32 bytes');
    this._phoneSecrets.set(ph, bytes);
  }

  /** The MS for `ph`, or null (unknown or pre-v2 pairing). */
  phoneMs(ph) {
    return this._phoneSecrets.get(ph) || null;
  }

  // ── connection lifecycle ───────────────────────────────────────────────

  /**
   * Connect to the relay. `options`: `{ pinnedCertPem, retry, deviceInfo,
   * handshakeTimeout }`. Resolves once the socket is open (the first
   * attempt); with `retry: false` a failed attempt rejects instead of
   * scheduling the backoff retry. A connection that drops later is
   * retried with the conn.rs schedule unless `retry` is false.
   */
  connect(url, options = {}) {
    if (this.socket || this._reconnectTimer) {
      return Promise.reject(new Error('remote-conn: already connecting'));
    }
    if (typeof url !== 'string' || !url) {
      return Promise.reject(new TypeError('remote-conn: url required'));
    }
    this._url = url;
    this._options = {
      pinnedCertPem: '',
      retry: true,
      deviceInfo: true,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      ...options,
    };
    this._stopped = false;
    this.backoffMs = BACKOFF_INITIAL_MS;
    return new Promise((resolve, reject) => {
      this._openWaiters.push({ resolve, reject });
      this._attempt();
    });
  }

  /** Stop reconnecting and close the socket (conn.rs `stop` path). */
  stop() {
    this._stopped = true;
    this._clearTimers();
    this._queue.length = 0;
    this.sessions.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    for (const waiter of this._openWaiters.splice(0)) {
      waiter.reject(new Error('remote-conn: stopped'));
    }
    this._setStatus('off');
  }

  _clearTimers() {
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
    this._pingTimer = null;
    this._reconnectTimer = null;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /** 'error' without a listener would throw (EventEmitter); a failed
   *  attempt is normal here, so it must not kill the process. */
  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _attempt() {
    if (this._stopped) return;
    this._setStatus('connecting');
    const opts = this._options;
    let socket;
    try {
      socket = new WebSocket(this._url, {
        ...tlsOptions(opts.pinnedCertPem),
        handshakeTimeout: opts.handshakeTimeout,
      });
    } catch (err) {
      this._attemptFailed(err);
      return;
    }
    this.socket = socket;
    let opened = false;
    let failed = false;

    socket.on('open', () => {
      opened = true;
      this.backoffMs = BACKOFF_INITIAL_MS;
      this._setStatus('online');
      this._startPing();
      if (opts.deviceInfo) {
        this._sendJson(deviceInfoFrame({ deviceName: this.deviceName, os: this.os }));
      }
      for (const waiter of this._openWaiters.splice(0)) waiter.resolve(this);
      this.emit('open');
      this._flushQueue();
    });

    socket.on('message', (data) => {
      this._onText(typeof data === 'string' ? data : data.toString('utf8'));
    });

    socket.on('error', (err) => {
      if (!opened && !failed) {
        failed = true;
        this._attemptFailed(err);
      } else {
        this._emitError(err);
      }
    });

    socket.on('close', (code, reasonBuf) => {
      if (this.socket === socket) this.socket = null;
      // Session keys are per socket; the next connection re-runs hs.
      this.sessions.clear();
      const reason = reasonBuf ? reasonBuf.toString('utf8') : '';
      this.emit('close', { code, reason });
      // ws emits `error` then `close`; the error path already cleared the
      // timers and scheduled the retry (or rejected the connect), so
      // clearing here would cancel the pending reconnect.
      if (failed) return;
      this._clearTimers();
      if (this._stopped) return;
      if (!opened) {
        // Closed before open without an `error` (rare): count as failure.
        failed = true;
        this._attemptFailed(new Error(reason || 'connection ended'));
        return;
      }
      this._onDisconnected(code, reason);
    });
  }

  _attemptFailed(err) {
    this.socket = null;
    this._clearTimers();
    const reason = connectFailureReason(err);
    this._emitError(err);
    const keepRetrying = this._options.retry !== false && !this._stopped;
    const waiters = this._openWaiters.splice(0);
    if (!keepRetrying) {
      for (const waiter of waiters) waiter.reject(err);
      this._stopped = true;
      this._setStatus('off');
      return;
    }
    this._setStatus(`reconnecting (${reason})`);
    this._scheduleReconnect();
  }

  /** A previously-open socket dropped: retry unless replaced/stopped. */
  _onDisconnected(code, reason) {
    if (code === REPLACED_CLOSE_CODE) {
      this._stopped = true;
      this._setStatus(STATUS_REPLACED);
      return;
    }
    const why = code === 1006
      ? `stream error: ${reason || 'connection ended'}`
      : `closed by relay: ${code}`;
    if (this._options.retry === false) {
      this._stopped = true;
      this._setStatus('off');
      return;
    }
    this._setStatus(`reconnecting (${why})`);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = this.backoffMs;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._attempt();
    }, delay);
    this.backoffMs = nextBackoff(this.backoffMs);
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.ping();
        } catch {
          /* the close handler reconciles */
        }
      }
    }, PING_EVERY_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  // ── outbound ───────────────────────────────────────────────────────────

  /**
   * Send one frame. Control frames go plaintext; business frames are
   * sealed into `enc` envelopes — per phone, unicast with `to` (the v2
   * desktop always targets one phone), or fanned out one envelope per
   * live session for a broadcast. Frames sent before `open` are queued in
   * order, like the Rust outbox channel. Returns the wire frames.
   */
  send(frame) {
    const wire = this._wrap(frame);
    for (const item of wire) this._sendJson(item);
    return wire;
  }

  /** Encrypt-for-wire decision without touching the socket. */
  _wrap(frame) {
    if (!frame || typeof frame !== 'object') throw new TypeError('remote-conn: frame object required');
    if (frame.t === 'enc' || PLAINTEXT_TYPES.has(frame.t)) return [frame];
    const inner = { ...frame };
    const target = inner.to;
    delete inner.to;
    if (target) {
      const { keys } = this.sessions.get(target) || {};
      if (!keys) throw new Error(`remote-conn: no e2e session for phone conn ${target}`);
      return [{ ...keys.sealFrame(inner), to: target }];
    }
    const out = [];
    for (const [conn, session] of this.sessions) {
      out.push({ ...session.keys.sealFrame(inner), to: conn });
    }
    return out;
  }

  _sendJson(frame) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this._queue.push(frame);
  }

  _flushQueue() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const queued = this._queue.splice(0);
    for (const frame of queued) this.socket.send(JSON.stringify(frame));
  }

  // ── inbound routing (conn.rs `route`) ──────────────────────────────────

  _onText(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    switch (frame.t) {
      case 'cmd':
        this._rejectPlaintextCmd(frame);
        break;
      case 'enc':
        this._routeEnc(frame);
        break;
      case 'hs': {
        const reply = this.acceptHs(frame);
        if (reply) this._sendJson(reply);
        break;
      }
      case 'peer': {
        const conn = typeof frame.conn === 'string' ? frame.conn : null;
        if (conn) {
          this.phoneConns.set(conn, {
            ph: typeof frame.ph === 'string' ? frame.ph : null,
            online: frame.online === true,
          });
          if (frame.online !== true) this.sessions.delete(conn);
        }
        this.emit('frame', frame, { control: true });
        break;
      }
      default:
        this.emit('frame', frame, { control: true });
        break;
    }
  }

  _rejectPlaintextCmd(frame) {
    const res = { t: 'res', id: frame.id == null ? null : frame.id, ok: false, error: E2E_REQUIRED };
    if (typeof frame.from === 'string') res.from = frame.from;
    this._sendJson(res);
  }

  _routeEnc(frame) {
    const conn = typeof frame.from === 'string' ? frame.from : null;
    if (!conn || !Number.isInteger(frame.seq) || typeof frame.d !== 'string') return;
    const session = this.sessions.get(conn);
    if (!session) return; // pre-hs or dropped: its hs re-establishes
    let plain;
    try {
      plain = session.keys.open(frame.seq, C.b64Decode(frame.d));
    } catch (err) {
      // Bad tag/replay: warn and drop the session (conn.rs route_enc).
      this.emit('warn', `remote e2e: bad frame from phone conn ${conn}; dropping session`);
      this.sessions.delete(conn);
      const peer = this.phoneConns.get(conn);
      if (peer) this.phoneConns.set(conn, { ...peer, online: false });
      return;
    }
    let inner;
    try {
      inner = JSON.parse(plain.toString('utf8'));
    } catch {
      return;
    }
    this.emit('frame', inner, { conn, ph: session.ph, enc: true });
  }

  /**
   * Answer one phone `hs` frame and install its session keys. Returns the
   * reply frame (`{t:"hs",v:2,pk,mac,to}`) or null when the frame is
   * malformed, the phone is unknown/pre-v2, or the MAC fails — in the
   * latter cases the connection is left to die, exactly like Rust's
   * route_hs (no reply, no session).
   */
  acceptHs(frame) {
    const ph = typeof frame.ph === 'string' ? frame.ph : null;
    const pkB64 = typeof frame.pk === 'string' ? frame.pk : null;
    const macB64 = typeof frame.mac === 'string' ? frame.mac : null;
    const conn = typeof frame.from === 'string' ? frame.from : null;
    if (!ph || !pkB64 || !macB64 || !conn) return null;
    const ms = this.phoneMs(ph);
    if (!ms) {
      // A hs can beat the pair_done that stores its MS (the phone connects
      // the moment the relay says paired): keep it for one retry.
      this._pendingUnknownHs = frame;
      this.emit('warn', `remote e2e: hs from unknown phone ${ph}`);
      return null;
    }
    let phonePk;
    let phoneMac;
    try {
      phonePk = C.b64Decode(pkB64);
      phoneMac = C.b64Decode(macB64);
    } catch {
      return null;
    }
    if (phonePk.length !== C.KEY_LEN || phoneMac.length !== C.KEY_LEN) return null;
    const handshake = C.hsInit();
    const replyPk = handshake.pkB64;
    const replyMac = C.b64Encode(handshake.replyMac(ms, phonePk));
    let keys;
    try {
      keys = C.hsComplete(handshake, ms, phonePk, phoneMac);
    } catch {
      this.emit('warn', `remote e2e: hs MAC failed for phone ${ph}; refusing session`);
      return null;
    }
    this.sessions.set(conn, { ph, keys });
    const peer = this.phoneConns.get(conn) || {};
    this.phoneConns.set(conn, { ...peer, ph, online: true });
    this.emit('session', { conn, ph });
    return { t: 'hs', v: 2, pk: replyPk, mac: replyMac, to: conn };
  }
}

module.exports = {
  RemoteConnector,
  // TLS classification / options
  tlsOptions,
  tlsFailureReason,
  connectFailureReason,
  // schedule
  nextBackoff,
  backoffSchedule,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  CONNECT_TIMEOUT_MS,
  PING_EVERY_MS,
  REPLACED_CLOSE_CODE,
  STATUS_REPLACED,
  // identity
  osName,
  hostname,
  displayName,
  deviceInfoFrame,
  // framing
  PLAINTEXT_TYPES,
  E2E_REQUIRED,
};