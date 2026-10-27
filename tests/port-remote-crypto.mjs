#!/usr/bin/env node
/* Parity + interop tests for the Electron E2E port.
 *
 *   electron/backend/remote-crypto.js  ←  src-tauri/src/remote/crypto.rs
 *   electron/backend/remote-conn.js    ←  src-tauri/src/remote/conn.rs
 *
 * Three layers, mirroring the Rust suites and then crossing the wire:
 *   1. Rust crypto parity: RFC 7748 / RFC 5869 / NIST GCM vectors, hs
 *      round trip, enc round trip, replay + tamper refusals.
 *   2. Cross-implementation interop: the phone's shipped JS
 *      (src/noble-e2e.js + src/app/remote-crypto.js, loaded into a stub
 *      window exactly like the page does) against this Node port — phone
 *      hs accepted, envelopes both directions, replays refused both ends.
 *   3. conn.rs parity: the tls_failure_reason strings, backoff cap,
 *      device_info shape, plaintext-cmd rejection, per-phone fan-out.
 *
 * Run: node tests/port-remote-crypto.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = require(join(root, 'electron/backend/remote-crypto.js'));
const {
  RemoteConnector,
  tlsOptions,
  tlsFailureReason,
  connectFailureReason,
  nextBackoff,
  backoffSchedule,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  STATUS_REPLACED,
  REPLACED_CLOSE_CODE,
  deviceInfoFrame,
  osName,
  displayName,
  E2E_REQUIRED,
} = require(join(root, 'electron/backend/remote-conn.js'));

// ── harness ────────────────────────────────────────────────────────────────

let checks = 0;
async function checkAsync(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  checks += 1;
}
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  checks += 1;
}

const hexToBuf = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const bufToHex = (b) => Buffer.from(b).toString('hex');
const u8 = (b) => Uint8Array.from(b);
const b64 = (b) => Buffer.from(b).toString('base64');

// ── phone-side bundle (the shipped scripts, loaded as the page does) ──────

const nobleSrc = readFileSync(join(root, 'src/noble-e2e.js'), 'utf8');
const phoneCryptoSrc = readFileSync(join(root, 'src/app/remote-crypto.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', 'atob', 'btoa', nobleSrc)(win, atob, btoa);
// eslint-disable-next-line no-new-func
new Function('window', 'atob', 'btoa', phoneCryptoSrc)(win, atob, btoa);
const E = win.OMP_E2E;

check('phone bundle loads and exposes OMP_E2E (interop partner present)', () => {
  if (!win.NOBLE_E2E || !E) throw new Error('phone crypto bundle did not install');
});

// ── 1. Rust crypto parity ──────────────────────────────────────────────────

// RFC 7748 §6.1, the same seeds the Rust test feeds ring.
const ALICE_PRIV = hexToBuf(
  '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const BOB_PRIV = hexToBuf(
  '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
const ALICE_PUB = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const BOB_PUB = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
const SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

check('X25519 matches RFC 7748 §6.1 (public keys and shared secret)', () => {
  const alice = C.keyPairFromSeed(ALICE_PRIV);
  const bob = C.keyPairFromSeed(BOB_PRIV);
  if (bufToHex(alice.pk) !== ALICE_PUB) throw new Error('alice pk');
  if (bufToHex(bob.pk) !== BOB_PUB) throw new Error('bob pk');
  if (bufToHex(C.x25519SharedSecret(ALICE_PRIV, hexToBuf(BOB_PUB))) !== SHARED) throw new Error('shared');
  if (bufToHex(C.x25519SharedSecret(BOB_PRIV, hexToBuf(ALICE_PUB))) !== SHARED) throw new Error('shared rev');
});

check('HKDF-SHA256 matches RFC 5869 case 1 (32-byte OKM prefix)', () => {
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from(Array.from({ length: 13 }, (_, i) => i));
  const info = Buffer.from(Array.from({ length: 10 }, (_, i) => 0xf0 + i));
  const okm = C.hkdfSha256(ikm, salt, info, 32);
  const want = '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf';
  if (bufToHex(okm) !== want) throw new Error(bufToHex(okm));
});

check('HKDF-SHA256 matches RFC 5869 case 3 (empty salt and info)', () => {
  const okm = C.hkdfSha256(Buffer.alloc(22, 0x0b), Buffer.alloc(0), Buffer.alloc(0), 32);
  const want = '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d';
  if (bufToHex(okm) !== want) throw new Error(bufToHex(okm));
});

check('AES-256-GCM matches the NIST/McGrew-Viega vector (empty AAD)', () => {
  const key = hexToBuf(
    'feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const iv = hexToBuf('cafebabefacedbaddecaf888');
  const pt = hexToBuf(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72'
    + '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
  const ct = hexToBuf(
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa'
    + '8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662');
  const tag = hexToBuf('eb9f796c8d356fc31a8433884b696f4f');
  const sealed = C.gcmSeal(key, iv, Buffer.alloc(0), pt);
  if (!sealed.subarray(0, sealed.length - 16).equals(ct)) throw new Error('ct mismatch');
  if (!sealed.subarray(sealed.length - 16).equals(tag)) throw new Error('tag mismatch');
  if (!C.gcmOpen(key, iv, Buffer.alloc(0), sealed).equals(pt)) throw new Error('open mismatch');
});

check('nonce is 4 zero bytes ‖ u64 BE seq (contract §enc)', () => {
  const n0 = C.nonceForSeq(0);
  const n1 = C.nonceForSeq(1);
  const nBig = C.nonceForSeq(0x0102030405060708n);
  if (n0.length !== 12 || bufToHex(n0) !== '000000000000000000000000') throw new Error('seq 0');
  if (bufToHex(n1) !== '000000000000000000000001') throw new Error('seq 1');
  if (bufToHex(nBig) !== '000000000102030405060708') throw new Error('big seq');
  if (C.aadForSeq(7).toString() !== 'enc:7') throw new Error('aad');
});

check('both master-secret directions agree; the salt binds both pks', () => {
  const phone = C.generateKeyPair();
  const desk = C.generateKeyPair();
  const a = C.masterSecret({
    myPrivateKey: phone.privateKey,
    peerPublicKey: desk.pk,
    phonePk: phone.pk,
    deskPk: desk.pk,
  });
  const b = C.masterSecret({
    myPrivateKey: desk.privateKey,
    peerPublicKey: phone.pk,
    phonePk: phone.pk,
    deskPk: desk.pk,
  });
  if (!a.equals(b) || a.length !== 32) throw new Error('MS mismatch');
  const other = C.generateKeyPair();
  const c = C.masterSecret({
    myPrivateKey: desk.privateKey,
    peerPublicKey: phone.pk,
    phonePk: other.pk,
    deskPk: desk.pk,
  });
  if (a.equals(c)) throw new Error('phone pk must change the salt');
  // The requested pairing-name alias is the same function.
  if (!C.pairKeyFromCode({
    myPrivateKey: phone.privateKey,
    peerPublicKey: desk.pk,
    phonePk: phone.pk,
    deskPk: desk.pk,
  }).equals(a)) throw new Error('pairKeyFromCode alias');
});

/** Build the phone half of an hs exchange with the desktop's own primitives. */
function phoneSide(ms, deskPk) {
  const eph = C.generateKeyPair();
  const mac = C.hsPhoneMac(ms, eph.pk);
  const keys = C.sessionKeys(...(() => {
    const shared = C.x25519SharedSecret(eph.privateKey, deskPk);
    const { c2d, d2c } = C.deriveSessionKeys(shared, eph.pk, deskPk);
    // The phone seals with c2d and opens with d2c — the mirror of the
    // desktop's SessionKeys(c2d, d2c).
    return [d2c, c2d];
  })());
  return { eph, mac, keys };
}

check('hs round trip: desktop verifies, replies, derives the same keys', () => {
  const phonePair = C.generateKeyPair();
  const deskPair = C.generateKeyPair();
  const ms = C.masterSecret({
    myPrivateKey: deskPair.privateKey,
    peerPublicKey: phonePair.pk,
    phonePk: phonePair.pk,
    deskPk: deskPair.pk,
  });
  const hs = C.hsInit();
  const phonePk = C.generateKeyPair();
  const phoneMac = C.hsPhoneMac(ms, phonePk.pk);
  const replyMac = hs.replyMac(ms, phonePk.pk);
  if (!replyMac.equals(C.hsDeskMac(ms, hs.pk, phonePk.pk))) throw new Error('reply mac');
  const deskKeys = C.hsComplete(hs, ms, phonePk.pk, phoneMac);
  // The phone's own derivation of the same session.
  const shared = C.x25519SharedSecret(phonePk.privateKey, hs.pk);
  const { c2d, d2c } = C.deriveSessionKeys(shared, phonePk.pk, hs.pk);
  const phoneKeys = C.sessionKeys(d2c, c2d);
  const env = deskKeys.sealFrame({ t: 'res', id: 7, ok: true });
  const inner = phoneKeys.openFrame(env);
  if (inner.id !== 7 || inner.ok !== true) throw new Error('round trip');
  const back = phoneKeys.sealFrame({ t: 'cmd', id: 8 });
  if (deskKeys.openFrame(back).id !== 8) throw new Error('reverse');
  // The handshake is one-shot, like the consuming Rust API.
  let threw = false;
  try { C.hsComplete(hs, ms, phonePk.pk, phoneMac); } catch { threw = true; }
  if (!threw) throw new Error('second complete must fail');
});

check('wrong MS fails the hs MAC', () => {
  const ms = Buffer.alloc(32, 1);
  const evil = Buffer.alloc(32, 9);
  const phonePk = C.generateKeyPair();
  const mac = C.hsPhoneMac(ms, phonePk.pk);
  let threw = false;
  try { C.hsComplete(C.hsInit(), evil, phonePk.pk, mac); } catch { threw = true; }
  if (!threw) throw new Error('evil MS accepted');
  if (!C.hsComplete(C.hsInit(), ms, phonePk.pk, mac)) throw new Error('control');
});

check('enc/dec round trip both directions', () => {
  const keys = C.sessionKeys(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  const phoneKeys = C.sessionKeys(Buffer.alloc(32, 2), Buffer.alloc(32, 1));
  const cmd = Buffer.from(JSON.stringify({ t: 'cmd', id: 7, name: 'get_state' }));
  const s0 = keys.seal(cmd);
  if (s0.seq !== 0) throw new Error('seq starts at 0');
  if (!C.decEnvelope(s0.seq, s0.sealed, { c2d: Buffer.alloc(32, 2) }).equals(cmd)) {
    throw new Error('desktop open');
  }
  if (!phoneKeys.open(s0.seq, s0.sealed).equals(cmd)) throw new Error('phone open');
  const res = Buffer.from(JSON.stringify({ t: 'res', id: 7, ok: true }));
  const s1 = phoneKeys.seal(res);
  if (s1.seq !== 0) throw new Error('per-direction counter');
  if (!keys.open(s1.seq, s1.sealed).equals(res)) throw new Error('desktop open reverse');
});

check('tampered ciphertext and tag are refused', () => {
  const desk = C.sessionKeys(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  const phone = C.sessionKeys(Buffer.alloc(32, 2), Buffer.alloc(32, 1));
  const sealed = Buffer.from(phone.seal(Buffer.from('attack at dawn')).sealed);
  sealed[0] ^= 0x01;
  let threw = false;
  try { desk.open(0, sealed); } catch { threw = true; }
  if (!threw) throw new Error('ciphertext tamper accepted');
  const sealed2 = Buffer.from(phone.seal(Buffer.from('second')).sealed);
  sealed2[sealed2.length - 1] ^= 0x80;
  threw = false;
  try { desk.open(1, sealed2); } catch { threw = true; }
  if (!threw) throw new Error('tag tamper accepted');
});

check('AAD binds the seq: a valid envelope at the wrong claimed seq fails', () => {
  const phone = C.sessionKeys(Buffer.alloc(32, 2), Buffer.alloc(32, 1));
  const env = phone.sealFrame({ t: 'cmd', id: 1 }); // seq 0
  // Control: the right seq opens under the right key.
  if (JSON.parse(C.decEnvelope(0, env.d, { c2d: Buffer.alloc(32, 1) })).id !== 1) {
    throw new Error('control open');
  }
  let threw = false;
  try {
    C.decEnvelope(1, env.d, { c2d: Buffer.alloc(32, 1) });
  } catch { threw = true; }
  if (!threw) throw new Error('AAD did not bind the seq');
});

check('seq replay, repeat and regression are refused; gaps are allowed', () => {
  const desk = C.sessionKeys(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  const phone = C.sessionKeys(Buffer.alloc(32, 2), Buffer.alloc(32, 1));
  const first = phone.seal(Buffer.from('first'));
  if (first.seq !== 0) throw new Error('first seq');
  desk.open(first.seq, first.sealed);
  let threw = false;
  try { desk.open(0, first.sealed); } catch { threw = true; }
  if (!threw) throw new Error('replay accepted');
  // Gap: seq 5 (the sender counter is stamped explicitly) is legal.
  const gapEnv = C.encEnvelope(5, { t: 'cmd', id: 5 }, { d2c: Buffer.alloc(32, 1) });
  const gapSealed = C.b64Decode(gapEnv.d);
  desk.open(5, gapSealed);
  // Anything ≤ the watermark is refused, equal included.
  threw = false;
  try { desk.open(5, gapSealed); } catch { threw = true; }
  if (!threw) throw new Error('equal seq accepted');
  threw = false;
  try { desk.open(4, first.sealed); } catch { threw = true; }
  if (!threw) throw new Error('regression accepted');
  // Stateless helper carries the same strict window; -1 is the phone's
  // "nothing accepted yet" sentinel.
  threw = false;
  try {
    C.decEnvelope(3, C.encEnvelope(3, 'x', { d2c: Buffer.alloc(32, 2) }).d,
      { c2d: Buffer.alloc(32, 2) }, 3);
  } catch { threw = true; }
  if (!threw) throw new Error('lastSeq boundary accepted');
  const stateless = C.decEnvelope(3, C.encEnvelope(3, 'x', { d2c: Buffer.alloc(32, 2) }).d,
    { c2d: Buffer.alloc(32, 2) }, -1);
  if (stateless.toString() !== 'x') throw new Error('lastSeq -1 sentinel');
});

check('base64 wire codec is strict (non-canonical input rejected)', () => {
  const raw = Buffer.alloc(32, 7);
  if (!C.b64Decode(C.b64Encode(raw)).equals(raw)) throw new Error('round trip');
  for (const bad of ['!!!!', 'AAAAA', 'A', 'aGVsbG8', 'AB==']) {
    let threw = false;
    try { C.b64Decode(bad); } catch { threw = true; }
    if (!threw) throw new Error(`accepted ${bad}`);
  }
});

// ── 2. cross-implementation interop (phone JS ⇄ desktop Node) ────────────

const PH = 'a'.repeat(64); // the ph key (phone token sha256 hex)
const phonePair = E.pairEph();
const deskPair = C.generateKeyPair();

check('pairing: phone and desktop derive the same MS', () => {
  const msPhone = E.masterSecret(
    phonePair.priv, u8(deskPair.pk), phonePair.pub, u8(deskPair.pk));
  const msDesk = C.masterSecret({
    myPrivateKey: deskPair.privateKey,
    peerPublicKey: phonePair.pub,
    phonePk: phonePair.pub,
    deskPk: deskPair.pk,
  });
  if (bufToHex(Buffer.from(msPhone)) !== bufToHex(msDesk)) throw new Error('MS mismatch');
});

const msPhone = Buffer.from(E.masterSecret(
  phonePair.priv, u8(deskPair.pk), phonePair.pub, u8(deskPair.pk)));
const msDesk = C.masterSecret({
  myPrivateKey: deskPair.privateKey,
  peerPublicKey: phonePair.pub,
  phonePk: phonePair.pub,
  deskPk: deskPair.pk,
});

// A connector with the desktop's stored MS; a fake open socket for sends.
function liveConnector(phones = { [PH]: b64(msDesk) }) {
  const conn = new RemoteConnector({ phones, deviceName: 'Studio' });
  const sent = [];
  conn.socket = { readyState: 1, send: (text) => sent.push(JSON.parse(text)) };
  return { conn, sent };
}

check('interop: phone hs frame → desktop hsComplete accepts and its reply verifies', () => {
  const { conn } = liveConnector();
  const hs = E.startHs(u8(msPhone));
  const reply = conn.acceptHs({
    t: 'hs',
    v: 2,
    ph: PH,
    pk: E.b64From(hs.pk),
    mac: E.b64From(hs.mac),
    from: 'conn-1',
  });
  if (!reply || reply.t !== 'hs' || reply.v !== 2 || reply.to !== 'conn-1') {
    throw new Error('no hs reply');
  }
  if (!E.verifyDeskHs(u8(msPhone), u8(C.b64Decode(reply.pk)), reply.mac, hs.pk)) {
    throw new Error('phone rejected the desktop reply MAC');
  }
  if (!conn.sessions.has('conn-1')) throw new Error('session not installed');
  if (conn.phoneConns.get('conn-1').ph !== PH) throw new Error('conn→ph binding');

  // Phone-side session keys from the very same handshake.
  const deskPk = u8(C.b64Decode(reply.pk));
  const pkeys = E.sessionKeys(hs.priv, deskPk, hs.pk, deskPk);

  // Phone → desktop: the phone seals, the connector opens and dispatches.
  const seen = [];
  conn.on('frame', (frame, meta) => seen.push({ frame, meta }));
  const cmd = { t: 'cmd', id: 7, name: 'get_state', args: {} };
  const env = E.seal(pkeys.c2d, 0, cmd);
  conn._onText(JSON.stringify({ ...env, from: 'conn-1' }));
  if (!seen.length || seen[0].frame.id !== 7) throw new Error('phone cmd not opened');
  if (seen[0].meta.conn !== 'conn-1' || seen[0].meta.enc !== true) throw new Error('meta');

  // Desktop → phone: the connector seals, the phone opens.
  const { conn: conn2, sent } = liveConnector();
  const hs2 = E.startHs(u8(msPhone));
  const reply2 = conn2.acceptHs({
    t: 'hs', v: 2, ph: PH, pk: E.b64From(hs2.pk), mac: E.b64From(hs2.mac), from: 'conn-1',
  });
  conn2.socket = { readyState: 1, send: (text) => sent.push(JSON.parse(text)) };
  const wire = conn2.send({ t: 'res', id: 7, ok: true, to: 'conn-1' });
  if (wire.length !== 1 || wire[0].t !== 'enc' || wire[0].to !== 'conn-1') {
    throw new Error('desktop frame not wrapped');
  }
  const deskPk2 = u8(C.b64Decode(reply2.pk));
  const pkeys2 = E.sessionKeys(hs2.priv, deskPk2, hs2.pk, deskPk2);
  const opened = E.open(pkeys2.d2c, -1, sent[sent.length - 1]);
  if (opened.frame.id !== 7 || opened.frame.ok !== true) throw new Error('phone open');
  if (opened.frame.to) throw new Error('routing `to` must not leak into the plaintext');
});

check('interop: unknown phone / wrong MS never gets an hs reply or session', () => {
  const { conn } = liveConnector({ [PH]: b64(Buffer.alloc(32, 9)) });
  const hs = E.startHs(u8(msPhone));
  const reply = conn.acceptHs({
    t: 'hs', v: 2, ph: PH, pk: E.b64From(hs.pk), mac: E.b64From(hs.mac), from: 'conn-bad',
  });
  if (reply !== null || conn.sessions.has('conn-bad')) throw new Error('wrong MS accepted');
  const unknown = conn.acceptHs({
    t: 'hs', v: 2, ph: 'b'.repeat(64), pk: E.b64From(hs.pk), mac: E.b64From(hs.mac), from: 'c',
  });
  if (unknown !== null) throw new Error('unknown phone got a reply');
});

check('interop: replays are refused on both sides', () => {
  // Phone side: same desktop envelope twice.
  const { conn } = liveConnector();
  const hs = E.startHs(u8(msPhone));
  const reply = conn.acceptHs({
    t: 'hs', v: 2, ph: PH, pk: E.b64From(hs.pk), mac: E.b64From(hs.mac), from: 'conn-r',
  });
  const deskPk = u8(C.b64Decode(reply.pk));
  const pkeys = E.sessionKeys(hs.priv, deskPk, hs.pk, deskPk);
  const env = conn.sessions.get('conn-r').keys.sealFrame({ t: 'evt', n: 1 });
  if (E.open(pkeys.d2c, -1, env).frame.n !== 1) throw new Error('first open');
  let threw = false;
  try { E.open(pkeys.d2c, env.seq, env); } catch { threw = true; }
  if (!threw) throw new Error('phone accepted a replay');

  // Desktop side: the same phone envelope twice drops the session.
  const warns = [];
  conn.on('warn', (m) => warns.push(m));
  const cmdEnv = E.seal(pkeys.c2d, 0, { t: 'cmd', id: 1 });
  conn._onText(JSON.stringify({ ...cmdEnv, from: 'conn-r' }));
  if (!conn.sessions.has('conn-r')) throw new Error('session dropped on first frame');
  conn._onText(JSON.stringify({ ...cmdEnv, from: 'conn-r' }));
  if (conn.sessions.has('conn-r')) throw new Error('replay did not drop the session');
  if (!warns.length) throw new Error('no warn emitted for replay');
});

check('interop: tampered envelope drops the desktop session; seq gaps open', () => {
  const { conn } = liveConnector();
  const hs = E.startHs(u8(msPhone));
  const reply = conn.acceptHs({
    t: 'hs', v: 2, ph: PH, pk: E.b64From(hs.pk), mac: E.b64From(hs.mac), from: 'conn-t',
  });
  const deskPk = u8(C.b64Decode(reply.pk));
  const pkeys = E.sessionKeys(hs.priv, deskPk, hs.pk, deskPk);
  // A gap (seq 5) is legal, exactly like the Rust receiver.
  const gap = E.seal(pkeys.c2d, 5, { t: 'cmd', id: 5 });
  conn._onText(JSON.stringify({ ...gap, from: 'conn-t' }));
  if (!conn.sessions.has('conn-t')) throw new Error('gap rejected');
  // A tampered copy of a later envelope kills the session.
  const bad = E.seal(pkeys.c2d, 6, { t: 'cmd', id: 6 });
  const raw = C.b64Decode(bad.d);
  raw[0] ^= 0x01;
  conn._onText(JSON.stringify({ ...bad, d: b64(raw), from: 'conn-t' }));
  if (conn.sessions.has('conn-t')) throw new Error('tamper kept the session');
});

check('interop: per-phone fan-out — each phone decrypts its own unicast', () => {
  const conn = new RemoteConnector({ phones: {} });
  const phoneA = E.pairEph();
  const phoneB = E.pairEph();
  const deskA = C.generateKeyPair();
  const deskB = C.generateKeyPair();
  const msA = Buffer.from(E.masterSecret(phoneA.priv, u8(deskA.pk), phoneA.pub, u8(deskA.pk)));
  const msB = Buffer.from(E.masterSecret(phoneB.priv, u8(deskB.pk), phoneB.pub, u8(deskB.pk)));
  conn.setPhoneSecret('phA', b64(msA));
  conn.setPhoneSecret('phB', b64(msB));

  const hsA = E.startHs(u8(msA));
  const hsB = E.startHs(u8(msB));
  // Interop encoding: replicate what acceptHs needs, one per ph.
  const repA = conn.acceptHs({
    t: 'hs', v: 2, ph: 'phA', pk: E.b64From(hsA.pk), mac: E.b64From(hsA.mac), from: 'cA',
  });
  const repB = conn.acceptHs({
    t: 'hs', v: 2, ph: 'phB', pk: E.b64From(hsB.pk), mac: E.b64From(hsB.mac), from: 'cB',
  });
  const sent = [];
  conn.socket = { readyState: 1, send: (t) => sent.push(JSON.parse(t)) };
  const wire = conn.send({ t: 'evt', kind: 'state' });
  if (wire.length !== 2) throw new Error('fan-out count');
  const tos = wire.map((f) => f.to).sort();
  if (tos.join(',') !== 'cA,cB') throw new Error('fan-out targets');
  if (wire[0].seq !== 0 || wire[1].seq !== 0) throw new Error('per-phone counters');

  const pkA = u8(C.b64Decode(repA.pk));
  const pkB = u8(C.b64Decode(repB.pk));
  const keysA = E.sessionKeys(hsA.priv, pkA, hsA.pk, pkA);
  const keysB = E.sessionKeys(hsB.priv, pkB, hsB.pk, pkB);
  const envA = sent.find((f) => f.to === 'cA');
  const envB = sent.find((f) => f.to === 'cB');
  if (E.open(keysA.d2c, -1, envA).frame.kind !== 'state') throw new Error('phone A');
  if (E.open(keysB.d2c, -1, envB).frame.kind !== 'state') throw new Error('phone B');
  // Cross-opening under the other phone's key must fail.
  let threw = false;
  try { E.open(keysB.d2c, -1, envA); } catch { threw = true; }
  if (!threw) throw new Error('phone B opened phone A envelope');
});

// ── 3. conn.rs parity ──────────────────────────────────────────────────────

check('tls_failure_reason names the untrusted cert (Rust strings verbatim)', () => {
  const selfSigned = Object.assign(new Error('self-signed certificate'), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
  if (tlsFailureReason(selfSigned) !== 'certificate not trusted (self-signed?)') {
    throw new Error(String(tlsFailureReason(selfSigned)));
  }
  // Rust also classifies the io-wrapped shape (cause chain here).
  const wrapped = new Error('socket hang up', { cause: selfSigned });
  if (tlsFailureReason(wrapped) !== 'certificate not trusted (self-signed?)') {
    throw new Error('cause chain not classified');
  }
  const noCode = new Error('unable to verify the first certificate');
  if (tlsFailureReason(noCode) !== 'certificate not trusted (self-signed?)') {
    throw new Error('message fallback');
  }
});

check('tls_failure_reason names other cert failures and passes the rest through', () => {
  const expired = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
  if (tlsFailureReason(expired) !== 'certificate rejected: Expired') throw new Error('expired');
  const altname = Object.assign(new Error('altnames'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  if (tlsFailureReason(altname) !== 'certificate rejected: NotValidForName') throw new Error('altname');
  if (tlsFailureReason(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) !== null) {
    throw new Error('non-TLS classified');
  }
  if (tlsFailureReason(new Error('boom')) !== null) throw new Error('generic classified');
  if (tlsFailureReason(null) !== null) throw new Error('null classified');
  // The caller's generic format (conn.rs `unwrap_or_else`).
  if (connectFailureReason(new Error('boom')) !== 'error: boom') throw new Error('generic format');
  if (connectFailureReason(Object.assign(new Error('Opening handshake has timed out'), {}))
    !== 'error: connect timeout (15s)') throw new Error('timeout format');
});

check('tlsOptions mirrors rustls pin semantics (pin replaces roots)', () => {
  const bare = tlsOptions('');
  if (bare.rejectUnauthorized !== true || 'ca' in bare) throw new Error('no-pin options');
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
  const pinned = tlsOptions(pem);
  if (pinned.rejectUnauthorized !== true || pinned.ca.length !== 1 || pinned.ca[0] !== pem.trim()) {
    throw new Error('pin options');
  }
  // A blank value falls back to the system roots, like pinned_cert_der().
  if ('ca' in tlsOptions('   \n')) throw new Error('blank pin');
  // An unparsable PEM body does the same (Rust `pinned_cert_der() == None`).
  const garbage = '-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----';
  if ('ca' in tlsOptions(garbage)) throw new Error('garbage pin');
});

check('backoff doubles from 1s and caps at 30s (conn.rs test)', () => {
  let b = BACKOFF_INITIAL_MS;
  for (let i = 0; i < 10; i += 1) b = nextBackoff(b);
  if (b !== BACKOFF_MAX_MS || b !== 30_000) throw new Error(String(b));
  const sched = backoffSchedule(4);
  if (sched.join(',') !== '1000,2000,4000,8000') throw new Error(sched.join(','));
});

check('device_info frame shape matches conn.rs', () => {
  const f = deviceInfoFrame({ deviceName: '  Studio  ', os: 'macos', env: {} });
  if (f.t !== 'device_info' || f.name !== 'Studio' || f.os !== 'macos') {
    throw new Error(JSON.stringify(f));
  }
  const fallback = deviceInfoFrame({ deviceName: '', os: 'linux', env: {} });
  if (!fallback.name || fallback.name !== 'omp-desktop') throw new Error(fallback.name);
  if (displayName('x'.repeat(100), {}).length !== 80) throw new Error('80-char cap');
  if (osName('darwin') !== 'macos' || osName('win32') !== 'windows') throw new Error('os map');
});

check('plaintext cmd gets the contract rejection (verbatim error)', () => {
  const { conn, sent } = liveConnector();
  conn._onText(JSON.stringify({ t: 'cmd', id: 5, name: 'get_state', from: 'conn-x' }));
  const res = sent[sent.length - 1];
  if (!res || res.t !== 'res' || res.id !== 5 || res.ok !== false) throw new Error('no res');
  if (res.error !== E2E_REQUIRED) throw new Error(res.error);
  if (res.error !== 'e2e required — reload the phone page') throw new Error('string drift');
  if (res.from !== 'conn-x') throw new Error('from not echoed');
  // `send` of an already-sealed envelope is not double-wrapped.
  const env = { t: 'enc', seq: 3, d: 'AAAA' };
  if (conn.send(env)[0] !== env) throw new Error('envelope re-wrapped');
  // Control frames stay plaintext.
  if (conn.send({ t: 'device_info', name: 'x', os: 'macos' })[0].t !== 'device_info') {
    throw new Error('control wrapped');
  }
});

check('close status: 4000 parks the connector, other codes retry', () => {
  const conn = new RemoteConnector({});
  conn._options = { retry: true, pinnedCertPem: '' };
  conn._stopped = false;
  conn._onDisconnected(REPLACED_CLOSE_CODE, '');
  if (conn.status !== STATUS_REPLACED) throw new Error(conn.status);
  if (!STATUS_REPLACED.includes('another desktop is online with this device id')) {
    throw new Error('status drift');
  }
  if (REPLACED_CLOSE_CODE !== 4000) throw new Error('code drift');
  // A normal close keeps its reason in the reconnecting status (and the
  // retry timer is cleared so the test exits).
  const conn2 = new RemoteConnector({});
  conn2._options = { retry: true, pinnedCertPem: '' };
  conn2._stopped = false;
  conn2._onDisconnected(1006, 'boom');
  if (!/^reconnecting \(stream error: boom\)$/.test(conn2.status)) throw new Error(conn2.status);
  conn2.stop();
});



check('unknown conn enc ignored, malformed hs refused, no-session broadcast sends nothing', () => {
  const { conn, sent } = liveConnector();
  // No session for this conn yet: the envelope is ignored (its hs will
  // establish one), exactly like Rust's route_enc `None` arm.
  conn._onText(JSON.stringify({ t: 'enc', seq: 0, d: 'AAAA', from: 'ghost' }));
  if (conn.sessions.size !== 0 || sent.length !== 0) throw new Error('ghost enc handled');
  // Malformed / wrong-length hs material never produces a reply.
  for (const bad of [
    { t: 'hs', v: 2, ph: PH, pk: 'AAAA', mac: 'AAAA', from: 'c' },
    { t: 'hs', v: 2, ph: PH, from: 'c' },
    { t: 'hs', v: 2, ph: PH, pk: E.b64From(C.generateKeyPair().pk), mac: 'AAAA', from: 'c' },
  ]) {
    if (conn.acceptHs(bad) !== null || conn.sessions.has('c')) {
      throw new Error('malformed hs accepted');
    }
  }
  // remote.json's nested shape works; a pre-v2 entry (no ms) is unpaired.
  const nested = new RemoteConnector({
    phones: { [PH]: { ms: b64(msDesk) }, ['c'.repeat(64)]: {} },
  });
  if (!nested.phoneMs(PH).equals(msDesk)) throw new Error('nested ms');
  if (nested.phoneMs('c'.repeat(64)) !== null) throw new Error('pre-v2 entry paired');
  // Broadcast with no live sessions is a no-op, not an error.
  if (conn.send({ t: 'evt', kind: 'x' }).length !== 0) throw new Error('empty broadcast');
  // A targeted frame without a session is a programming error.
  let threw = false;
  try { conn.send({ t: 'res', id: 1, to: 'ghost' }); } catch { threw = true; }
  if (!threw) throw new Error('targeted frame without session');
});

// ── 4. live loopback: connect / announce / hs / enc / plaintext rejection ──

/** Poll `cond` until true, or fail after `ms`. */
async function waitFor(cond, label, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolve on the next `event`, reject after `ms`. */
function once(emitter, event, ms = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    function onEvent(...args) {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    }
    emitter.once(event, onEvent);
  });
}

await checkAsync('reconnect loop retries at the 1s→2s backoff after a failed connect', async () => {
  // Reserve a port, then release it so the connect is refused fast.
  const srv = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(srv, 'listening');
  const { port } = srv.address();
  const closed = once(srv, 'close');
  srv.close();
  await closed;

  const conn = new RemoteConnector({});
  const attempts = [];
  conn.on('status', (s) => { if (s === 'connecting') attempts.push(Date.now()); });
  conn.on('error', () => {});
  conn.connect(`ws://127.0.0.1:${port}/ws?role=desktop&device=aa&token=bb`, {
    handshakeTimeout: 1_000,
  }).catch(() => {});
  await waitFor(() => attempts.length >= 2, 'second connect attempt', 5_000);
  const gap = attempts[1] - attempts[0];
  conn.stop();
  if (gap < 700 || gap > 2_500) throw new Error(`backoff gap ${gap}ms`);
});

await checkAsync('live ws: announce, accept phone hs, open/ seal enc, reject plaintext cmd', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = server.address();
  const serverSaw = [];
  let peerSocket = null;
  const connected = new Promise((resolve) => {
    server.once('connection', (socket) => {
      peerSocket = socket;
      socket.on('message', (data) => serverSaw.push(JSON.parse(data.toString())));
      resolve();
    });
  });

  const conn = new RemoteConnector({ phones: { [PH]: b64(msDesk) }, deviceName: 'Studio' });
  const statuses = [];
  conn.on('status', (s) => statuses.push(s));
  const frames = [];
  conn.on('frame', (frame, meta) => frames.push({ frame, meta }));

  await conn.connect(`ws://127.0.0.1:${port}/ws?role=desktop&device=aa&token=bb`, {
    retry: false,
    handshakeTimeout: 5_000,
  });
  await connected;

  // device_info is the first frame on every connect.
  await waitFor(() => serverSaw.length >= 1, "device_info");
  const info = serverSaw[0];
  if (info.t !== 'device_info' || info.name !== 'Studio' || !info.os) {
    throw new Error(`device_info: ${JSON.stringify(info)}`);
  }
  if (!statuses.includes('online')) throw new Error('no online status');

  // The "phone" on the server end answers the desktop hs and derives keys.
  const hs = E.startHs(u8(msPhone));
  peerSocket.send(JSON.stringify({
    t: 'hs', v: 2, ph: PH, pk: E.b64From(hs.pk), mac: E.b64From(hs.mac), from: 'srv-conn',
  }));
  await waitFor(() => serverSaw.some((f) => f.t === 'hs'), "hs reply");
  const reply = serverSaw.find((f) => f.t === 'hs');
  if (reply.to !== 'srv-conn' || reply.v !== 2) throw new Error('hs reply routing');
  if (!E.verifyDeskHs(u8(msPhone), u8(C.b64Decode(reply.pk)), reply.mac, hs.pk)) {
    throw new Error('desktop reply MAC failed');
  }
  const deskPk = u8(C.b64Decode(reply.pk));
  const pkeys = E.sessionKeys(hs.priv, deskPk, hs.pk, deskPk);

  // phone → desktop enc
  const cmdEnv = E.seal(pkeys.c2d, 0, { t: 'cmd', id: 9, name: 'get_state' });
  peerSocket.send(JSON.stringify({ ...cmdEnv, from: 'srv-conn' }));
  await waitFor(() => frames.length > 0, "inbound enc");
  if (frames[0].frame.id !== 9 || frames[0].meta.conn !== 'srv-conn') {
    throw new Error('enc frame not routed');
  }

  // desktop → phone enc (send wraps after hs)
  serverSaw.length = 0;
  conn.send({ t: 'res', id: 9, ok: true, to: 'srv-conn' });
  await waitFor(() => serverSaw.length > 0, "outbound enc");
  const resEnv = serverSaw[0];
  if (resEnv.t !== 'enc' || resEnv.to !== 'srv-conn') throw new Error('res not encrypted');
  if (E.open(pkeys.d2c, -1, resEnv).frame.id !== 9) throw new Error('phone open of desktop res');

  // plaintext cmd gets the typed rejection on the wire.
  serverSaw.length = 0;
  peerSocket.send(JSON.stringify({ t: 'cmd', id: 42, from: 'srv-conn' }));
  await waitFor(() => serverSaw.length > 0, "plaintext rejection");
  if (serverSaw[0].error !== E2E_REQUIRED) throw new Error('plaintext cmd accepted');

  // Close code 4000 parks the connector with the Rust status.
  const parked = once(conn, 'status');
  peerSocket.close(4000);
  const parkedStatus = await parked;
  if (parkedStatus !== STATUS_REPLACED) throw new Error(parkedStatus);
  conn.stop();
  server.close();
  await once(server, 'close');
});

// ── result ────────────────────────────────────────────────────────────────

console.log(`port-remote-crypto: ${checks} checks passed`);