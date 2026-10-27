'use strict';

/* remote-crypto.js — the desktop half of the R8 E2E core, in Node.
 *
 * Port of `src-tauri/src/remote/crypto.rs`; the protocol is defined by
 * `docs/architecture/remote-e2e-contract.md` (v2) and this file keeps the
 * Rust file's math byte-for-byte:
 *
 *   pairing MS : MS = HKDF-SHA256(X25519(my_eph, peer_pk),
 *                                  salt = phone_pk || desk_pk,
 *                                  info = "omp-e2e-master-v2")
 *                (no pair_id in the salt — the ephemerals are fresh per
 *                pairing and the phone never learns the relay's pair_id)
 *   hs MAC key : HKDF-SHA256(MS, salt = "", info = "omp-e2e-hs-mac-v2")
 *   phone MAC  : HMAC(key, "P" || phone_pk)
 *   desk MAC   : HMAC(key, "D" || desk_pk || phone_pk)
 *   session    : shared = X25519(my_eph, peer_eph)
 *                K_c2d = HKDF(shared, salt = phone_pk || desk_pk, "omp-e2e-c2d-v2")
 *                K_d2c = HKDF(shared, salt = phone_pk || desk_pk, "omp-e2e-d2c-v2")
 *   enc        : d = AES-256-GCM(key, nonce, aad, plaintext) || 16B tag
 *                nonce = 4 zero bytes || u64 big-endian seq
 *                AAD   = utf8 "enc:<seq>" (decimal)
 *                receive: seq must be STRICTLY greater than the last
 *                accepted one (gaps allowed, repeats/regressions never)
 *
 * Everything here is pure: no sockets, no timers, no storage — the
 * connector in `remote-conn.js` wires it to the relay. Node's own X25519
 * (`crypto.diffieHellman`) and AES-256-GCM carry the primitives; the
 * phone's noble bundle implements the same contract, so every derivation
 * must agree with it exactly (interop is regression-tested).
 *
 * Seq values are JS safe integers here (Number, or BigInt when supplied):
 * a connection cannot reach 2^53 frames, and the wire value is still
 * written as a full u64 big-endian nonce.
 */

const crypto = require('node:crypto');

// ── contract labels ─────────────────────────────────────────────────────────

/** Pairing master secret info label (contract §pairing, step 5). */
const MS_INFO = Buffer.from('omp-e2e-master-v2', 'utf8');
/** `hs` MAC key derivation label (contract §hs). */
const HS_MAC_INFO = Buffer.from('omp-e2e-hs-mac-v2', 'utf8');
/** Phone→desktop session key label. */
const C2D_INFO = Buffer.from('omp-e2e-c2d-v2', 'utf8');
/** Desktop→phone session key label. */
const D2C_INFO = Buffer.from('omp-e2e-d2c-v2', 'utf8');

/** AES-256 key / HKDF output / HMAC tag length. */
const KEY_LEN = 32;
/** AES-GCM tag length. */
const TAG_LEN = 16;
/** 4 zero bytes ‖ u64 BE seq. */
const NONCE_LEN = 12;

/** DER prefixes for raw 32-byte X25519 keys (RFC 8410 SPKI / PKCS#8). */
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const MAX_SAFE_SEQ = BigInt(Number.MAX_SAFE_INTEGER);

// ── base64 (the contract's pk/mac/d/ms wire encoding) ──────────────────────

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard base64 encode of bytes → wire string. */
function b64Encode(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Standard base64 decode. Rust's `STANDARD` engine rejects malformed input,
 * so this is strict too: charset/padding validity plus a canonical
 * re-encode check (Node silently accepts non-zero trailing bits).
 */
function b64Decode(s) {
  if (typeof s !== 'string') throw new TypeError('b64: not a string');
  if (!B64_RE.test(s) || s.length % 4 !== 0) throw new Error('b64: invalid');
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) throw new Error('b64: invalid');
  return buf;
}

// ── key material ────────────────────────────────────────────────────────────

function isKeyObject(v) {
  return v instanceof crypto.KeyObject;
}

/** Raw 32-byte X25519 public key from a KeyObject, DER, raw Buffer or b64. */
function rawPublicKey(pk) {
  if (isKeyObject(pk)) {
    if (pk.type !== 'public' || pk.asymmetricKeyType !== 'x25519') {
      throw new Error('x25519: not a public key');
    }
    const der = pk.export({ type: 'spki', format: 'der' });
    return Buffer.from(der.subarray(SPKI_X25519_PREFIX.length));
  }
  const buf = typeof pk === 'string' ? b64Decode(pk) : Buffer.from(pk);
  if (buf.length === KEY_LEN) return buf;
  if (buf.length === SPKI_X25519_PREFIX.length + KEY_LEN
    && buf.subarray(0, SPKI_X25519_PREFIX.length).equals(SPKI_X25519_PREFIX)) {
    return buf.subarray(SPKI_X25519_PREFIX.length);
  }
  throw new Error('x25519: not a public key');
}

/** KeyObject from a raw 32-byte seed or a PKCS#8 DER. */
function privateKeyObject(priv) {
  if (isKeyObject(priv)) {
    if (priv.type !== 'private' || priv.asymmetricKeyType !== 'x25519') {
      throw new Error('x25519: not a private key');
    }
    return priv;
  }
  const buf = typeof priv === 'string' ? b64Decode(priv) : Buffer.from(priv);
  const der = buf.length === KEY_LEN
    ? Buffer.concat([PKCS8_X25519_PREFIX, buf])
    : buf;
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('x25519: not a private key');
  return key;
}

/** A fresh X25519 ephemeral: `{ privateKey, publicKey, pk, pkB64 }`. */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const pk = rawPublicKey(publicKey);
  return { privateKey, publicKey, pk, pkB64: b64Encode(pk) };
}

/**
 * A key pair from a fixed 32-byte private seed (X25519 clamps internally,
 * so RFC 7748's unclamped seeds work verbatim — the Rust tests use the
 * same trick through ring's fixed RNG).
 */
function keyPairFromSeed(seed) {
  const privateKey = privateKeyObject(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  const pk = rawPublicKey(publicKey);
  return { privateKey, publicKey, pk, pkB64: b64Encode(pk) };
}

/** X25519 agreement: raw 32-byte shared secret. */
function x25519SharedSecret(myPrivateKey, peerPublicKey) {
  const priv = privateKeyObject(myPrivateKey);
  const pub = crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, rawPublicKey(peerPublicKey)]),
    format: 'der',
    type: 'spki',
  });
  return Buffer.from(crypto.diffieHellman({ privateKey: priv, publicKey: pub }));
}

// ── HKDF / HMAC ─────────────────────────────────────────────────────────────

/** HKDF-SHA256(ikm, salt, info) → `len` bytes (contract derivations: 32). */
function hkdfSha256(ikm, salt, info, len = KEY_LEN) {
  const out = crypto.hkdfSync(
    'sha256',
    Buffer.from(ikm),
    salt == null ? Buffer.alloc(0) : Buffer.from(salt),
    info == null ? Buffer.alloc(0) : Buffer.from(info),
    len,
  );
  return Buffer.from(out);
}

/** HMAC-SHA256 tag (32 bytes) over `data`. */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest();
}

/** Constant-time HMAC verification; false on length mismatch. */
function hmacVerify(key, data, tag) {
  const want = hmacSha256(key, data);
  const got = Buffer.from(tag);
  return got.length === want.length && crypto.timingSafeEqual(want, got);
}

// ── AES-256-GCM primitive ───────────────────────────────────────────────────

/** Seal `plaintext` → ciphertext ‖ 16-byte tag. */
function gcmSeal(key, nonce, aad, plaintext) {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  const aadBuf = Buffer.from(aad == null ? Buffer.alloc(0) : aad);
  if (aadBuf.length) cipher.setAAD(aadBuf);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/** Open ciphertext ‖ tag; throws on a bad tag (tamper/wrong AAD/wrong key). */
function gcmOpen(key, nonce, aad, sealed) {
  const buf = Buffer.from(sealed);
  if (buf.length < TAG_LEN) throw new Error('e2e: bad enc envelope');
  const ct = buf.subarray(0, buf.length - TAG_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  const aadBuf = Buffer.from(aad == null ? Buffer.alloc(0) : aad);
  if (aadBuf.length) decipher.setAAD(aadBuf);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('e2e: authentication failed');
  }
}

/** 12-byte nonce: 4 zero bytes ‖ u64 big-endian seq. */
function nonceForSeq(seq) {
  const n = Buffer.alloc(NONCE_LEN);
  n.writeBigUInt64BE(seqToBigInt(seq), 4);
  return n;
}

/** AAD: utf8 `enc:<seq>` with the seq in decimal (contract §enc). */
function aadForSeq(seq) {
  return Buffer.from(`enc:${seqToBigInt(seq).toString(10)}`, 'utf8');
}

function seqToBigInt(seq) {
  if (typeof seq === 'bigint') {
    if (seq < 0n) throw new Error('e2e: seq out of range');
    return seq;
  }
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('e2e: seq out of range');
  return BigInt(seq);
}

// ── pairing: the master secret (contract §pairing) ─────────────────────────

/**
 * `MS = HKDF-SHA256(X25519(my_priv, peer_pk), salt = phone_pk || desk_pk,
 * "omp-e2e-master-v2")`. Both ends pass the two public keys in phone-then-
 * desktop order, so the salt agrees whichever side computes it.
 */
function masterSecret({ myPrivateKey, peerPublicKey, phonePk, deskPk }) {
  const peer = rawPublicKey(peerPublicKey);
  const phone = rawPublicKey(phonePk);
  const desk = rawPublicKey(deskPk);
  const shared = x25519SharedSecret(myPrivateKey, peer);
  return hkdfSha256(shared, Buffer.concat([phone, desk]), MS_INFO, KEY_LEN);
}

/**
 * The pairing key from the pairing exchange's material — the port's
 * requested name for `masterSecret`. The v2 contract has no short-code
 * KDF (the relay's `pair_code` is only human-checkable and never reaches
 * the key schedule), so "code" here is the pairing handshake's key
 * material: `{ myPrivateKey, peerPublicKey, phonePk, deskPk }` (or the
 * same four positionally).
 */
function pairKeyFromCode(material, peerPublicKey, phonePk, deskPk) {
  if (arguments.length > 1) {
    return masterSecret({
      myPrivateKey: material,
      peerPublicKey,
      phonePk,
      deskPk,
    });
  }
  return masterSecret(material);
}

// ── per-connection handshake (contract §hs) ────────────────────────────────

/** `hs` MAC key: HKDF(MS, salt = "", "omp-e2e-hs-mac-v2"), shared by roles. */
function hsMacKey(ms) {
  return hkdfSha256(ms, Buffer.alloc(0), HS_MAC_INFO, KEY_LEN);
}

/** Phone MAC message: `"P" || phone_pk`. */
function hsMacPhoneMsg(phonePk) {
  return Buffer.concat([Buffer.from('P', 'utf8'), rawPublicKey(phonePk)]);
}

/** Desktop MAC message: `"D" || desk_pk || phone_pk`. */
function hsMacDeskMsg(deskPk, phonePk) {
  return Buffer.concat([
    Buffer.from('D', 'utf8'),
    rawPublicKey(deskPk),
    rawPublicKey(phonePk),
  ]);
}

/** Phone-side MAC over its own ephemeral pk. */
function hsPhoneMac(ms, phonePk) {
  return hmacSha256(hsMacKey(ms), hsMacPhoneMsg(phonePk));
}

/** Desktop-side MAC binding our ephemeral to the phone's. */
function hsDeskMac(ms, deskPk, phonePk) {
  return hmacSha256(hsMacKey(ms), hsMacDeskMsg(deskPk, phonePk));
}

/** Session keys from the X25519 agreement, salted `phone_pk || desk_pk`. */
function deriveSessionKeys(shared, phonePk, deskPk) {
  const salt = Buffer.concat([rawPublicKey(phonePk), rawPublicKey(deskPk)]);
  return {
    c2d: hkdfSha256(shared, salt, C2D_INFO, KEY_LEN),
    d2c: hkdfSha256(shared, salt, D2C_INFO, KEY_LEN),
  };
}

/**
 * The desktop side of one `hs` exchange — the port of Rust's `HsHandshake`.
 * `replyMac()` answers the phone's frame; `complete()` verifies the phone's
 * MAC (fail → the caller closes the connection) and installs the session.
 */
class HsHandshake {
  constructor(keyPair = generateKeyPair()) {
    this._kp = keyPair;
    this._done = false;
  }

  /** Our ephemeral public key (raw 32 bytes). */
  get pk() {
    return this._kp.pk;
  }

  /** Our ephemeral public key as the wire `pk` (b64). */
  get pkB64() {
    return this._kp.pkB64;
  }

  /** Reply MAC: `HMAC(hs_mac_key(MS), "D" || desk_pk || phone_pk)`. */
  replyMac(ms, phonePk) {
    return hsDeskMac(ms, this.pk, phonePk);
  }

  /** Verify the phone's MAC, then derive and return the session keys. */
  complete(ms, phonePk, phoneMac) {
    if (this._done) throw new Error('hs: handshake already completed');
    if (!hmacVerify(hsMacKey(ms), hsMacPhoneMsg(phonePk), phoneMac)) {
      throw new Error('hs: key confirmation failed');
    }
    this._done = true;
    const shared = x25519SharedSecret(this._kp.privateKey, phonePk);
    const { c2d, d2c } = deriveSessionKeys(shared, phonePk, this.pk);
    return new SessionKeys(c2d, d2c);
  }
}

/** Fresh desktop `hs` handshake (Rust's `HsHandshake::new`). */
function hsInit() {
  return new HsHandshake();
}

/** `hs.verify + keys` shorthand: mirrors `HsHandshake::finish`. */
function hsComplete(handshake, ms, phonePk, phoneMac) {
  return handshake.complete(ms, phonePk, phoneMac);
}

// ── the enc envelope (contract §enc) ───────────────────────────────────────

/**
 * Per-connection AES-256-GCM state: `c2d` opens inbound phone frames,
 * `d2c` seals outbound desktop frames, both with their own counter.
 * Replay protection is the Rust rule verbatim: the first frame may carry
 * any seq (0 included) but it becomes the high-water mark; every later
 * frame must be strictly greater. Gaps are legal, repeats never are.
 */
class SessionKeys {
  constructor(c2d, d2c) {
    const c2dKey = Buffer.from(c2d);
    const d2cKey = Buffer.from(d2c);
    if (c2dKey.length !== KEY_LEN || d2cKey.length !== KEY_LEN) {
      throw new Error('e2e: session keys must be 32 bytes');
    }
    this._c2d = c2dKey;
    this._d2c = d2cKey;
    this._recvSeq = null;
    this._sendSeq = 0;
  }

  /** Highest inbound seq accepted so far (`null` before the first). */
  get recvSeq() {
    return this._recvSeq;
  }

  /** Next outbound seq to stamp. */
  get sendSeq() {
    return this._sendSeq;
  }

  /**
   * Seal one plaintext frame with `d2c` at the next seq.
   * Returns `{ seq, sealed }` — `sealed` is ciphertext ‖ tag.
   */
  seal(plaintext) {
    const seq = this._sendSeq;
    if (!Number.isSafeInteger(seq)) throw new Error('e2e: seq exhausted');
    const sealed = gcmSeal(this._d2c, nonceForSeq(seq), aadForSeq(seq), plaintext);
    this._sendSeq = seq + 1;
    return { seq, sealed };
  }

  /** Seal at an explicit seq (interop/tests; does not move the counter). */
  sealAt(seq, plaintext) {
    seqToBigInt(seq);
    return gcmSeal(this._d2c, nonceForSeq(seq), aadForSeq(seq), plaintext);
  }

  /** Open an inbound envelope with `c2d`; throws on replay/tamper. */
  open(seq, sealed) {
    const s = seqToBigInt(seq);
    if (s > MAX_SAFE_SEQ) throw new Error('e2e: seq out of range');
    if (this._recvSeq !== null && s <= BigInt(this._recvSeq)) {
      throw new Error('e2e: replay or regression');
    }
    const plain = gcmOpen(this._c2d, nonceForSeq(s), aadForSeq(s), sealed);
    this._recvSeq = Number(s);
    return plain;
  }

  /** Seal a JSON frame into the wire envelope `{t:"enc",seq,d}`. */
  sealFrame(frame) {
    const { seq, sealed } = this.seal(Buffer.from(JSON.stringify(frame), 'utf8'));
    return { t: 'enc', seq, d: b64Encode(sealed) };
  }

  /** Open a wire envelope and parse its JSON frame. */
  openFrame(envelope) {
    const d = envelope && typeof envelope.d === 'string'
      ? b64Decode(envelope.d)
      : envelope && Buffer.isBuffer(envelope.d)
        ? envelope.d
        : null;
    if (!d) throw new Error('e2e: bad enc envelope');
    return JSON.parse(this.open(envelope.seq, d).toString('utf8'));
  }
}

/** Session keys from raw 32-byte `K_c2d` / `K_d2c` (the hs derivation). */
function sessionKeys(c2d, d2c) {
  return new SessionKeys(c2d, d2c);
}

function _rawKey(keys, field) {
  if (keys instanceof SessionKeys) return keys[`_${field}`];
  if (Buffer.isBuffer(keys) || keys instanceof Uint8Array) return Buffer.from(keys);
  if (keys && (Buffer.isBuffer(keys[field]) || keys[field] instanceof Uint8Array)) {
    return Buffer.from(keys[field]);
  }
  if (keys && typeof keys[field] === 'string') return b64Decode(keys[field]);
  throw new Error(`e2e: missing ${field} key`);
}

/**
 * Encrypt one frame at `seq` → wire envelope `{t:"enc",seq,d}`.
 * `keys` is a `SessionKeys`, `{ d2c }`, or the raw 32-byte `d2c` key.
 * `plaintext` may be a JSON string, Buffer, or any JSON value.
 */
function encEnvelope(seq, plaintext, keys) {
  const s = seqToBigInt(seq);
  if (s > MAX_SAFE_SEQ) throw new Error('e2e: seq out of range');
  const key = keys instanceof SessionKeys ? keys._d2c : _rawKey(keys, 'd2c');
  const data = typeof plaintext === 'string' || Buffer.isBuffer(plaintext)
    ? Buffer.from(plaintext)
    : Buffer.from(JSON.stringify(plaintext), 'utf8');
  const sealed = gcmSeal(key, nonceForSeq(s), aadForSeq(s), data);
  return { t: 'enc', seq: Number(s), d: b64Encode(sealed) };
}

/**
 * Decrypt one envelope → Buffer plaintext (or a parsed frame when
 * `options.json`). Replay window: every seq ≤ `lastSeq` is refused
 * (strictly increasing, gaps allowed — the Rust `SessionKeys::open`
 * rule). `lastSeq` defaults to -1 for stateless callers; a `SessionKeys`
 * instance tracks it itself and ignores the argument.
 *
 * Accepts either `(seq, d, keys, lastSeq)` or `(envelope, keys, lastSeq)`.
 */
function decEnvelope(a, b, c, d) {
  let seq;
  let payload;
  let keys;
  let lastSeq;
  if (a && typeof a === 'object' && !Buffer.isBuffer(a) && !(a instanceof Uint8Array)
    && Object.prototype.hasOwnProperty.call(a, 'seq')) {
    seq = a.seq;
    payload = a.d;
    keys = b;
    lastSeq = c;
  } else {
    seq = a;
    payload = b;
    keys = c;
    lastSeq = d;
  }
  const s = seqToBigInt(seq);
  if (lastSeq != null) {
    // -1 (the phone's "nothing accepted yet") means no watermark.
    const raw = typeof lastSeq === 'bigint' ? lastSeq : Number(lastSeq);
    if (!(typeof raw === 'bigint' && raw < 0n) && !(typeof raw === 'number' && raw < 0)) {
      const last = seqToBigInt(lastSeq);
      if (s <= last) throw new Error('e2e: replay or regression');
    }
  }
  const key = keys instanceof SessionKeys ? null : _rawKey(keys, 'c2d');
  const sealed = typeof payload === 'string' ? b64Decode(payload) : Buffer.from(payload);
  if (keys instanceof SessionKeys) return keys.open(s, sealed);
  return gcmOpen(key, nonceForSeq(s), aadForSeq(s), sealed);
}

module.exports = {
  // contract labels / sizes
  MS_INFO,
  HS_MAC_INFO,
  C2D_INFO,
  D2C_INFO,
  KEY_LEN,
  TAG_LEN,
  NONCE_LEN,
  // codecs
  b64Encode,
  b64Decode,
  // key material
  generateKeyPair,
  keyPairFromSeed,
  rawPublicKey,
  privateKeyObject,
  x25519SharedSecret,
  // kdf / mac
  hkdfSha256,
  hmacSha256,
  hmacVerify,
  hsMacKey,
  hsMacPhoneMsg,
  hsMacDeskMsg,
  hsPhoneMac,
  hsDeskMac,
  deriveSessionKeys,
  // pairing
  masterSecret,
  pairKeyFromCode,
  // handshake
  HsHandshake,
  hsInit,
  hsComplete,
  // envelope
  gcmSeal,
  gcmOpen,
  nonceForSeq,
  aadForSeq,
  SessionKeys,
  sessionKeys,
  encEnvelope,
  decEnvelope,
};