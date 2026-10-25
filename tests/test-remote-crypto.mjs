#!/usr/bin/env node
// Regression script for src/app/remote-crypto.js — the phone side of the
// R8 E2E crypto core (docs/architecture/remote-e2e-contract.md). The
// primitives themselves are pinned to published test vectors so a noble
// upgrade cannot silently change the math (both ends must interop):
//   - X25519: RFC 7748 §6.1;
//   - HKDF-SHA256: RFC 5869 A.1 (Case 1);
//   - AES-256-GCM: the NIST GCM test vectors (zero key/IV case).
// On top of the vectors: the full contract flow — pairing MS derivation
// agreeing on both ends, the hs MACs (phone/desk), the session keys,
// and the enc envelope roundtrip including the tamper/replay refusals.
// The vendored noble bundle (src/noble-e2e.js → window.NOBLE_E2E) loads
// into a stub window first, exactly as the page order does.
// Run: node tests/test-remote-crypto.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nobleSrc = readFileSync(join(root, "src/noble-e2e.js"), "utf8");
const cryptoSrc = readFileSync(join(root, "src/app/remote-crypto.js"), "utf8");

// The page order: the bundle installs NOBLE_E2E, remote-crypto.js builds
// OMP_E2E on top of it. atob/btoa are the Node globals (the module's
// b64 helpers use them).
const win = {};
// eslint-disable-next-line no-new-func
new Function("window", "atob", "btoa", nobleSrc)(win, atob, btoa);
// eslint-disable-next-line no-new-func
new Function("window", "atob", "btoa", cryptoSrc)(win, atob, btoa);
const E = win.OMP_E2E;
assert.ok(E, "module exports window.OMP_E2E");

const hexToB = (h) => {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
};
const bToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(label);
    console.error(`FAIL: ${label}`);
    console.error(err instanceof Error ? err.stack : err);
    return;
  }
  passed++;
}

// A fresh 32-byte master secret, for checks that only need SOME key.
const anyMs = () => E.masterSecret(
  E.pairEph().priv, E.pairEph().pub, E.pairEph().pub, E.pairEph().pub);

// ── the vendored bundle's own surface ───────────────────────────────────────

check("the noble bundle installs exactly the five primitives the contract needs", () => {
  assert.deepEqual(Object.keys(win.NOBLE_E2E).sort(), ["gcm", "hkdf", "hmac", "sha256", "x25519"]);
});

check("the bundle contains no eval / new Function (CSP: script-src 'self', no unsafe-eval)", () => {
  assert.ok(!/\beval\s*\(/.test(nobleSrc), "no eval( in the shipped text");
  assert.ok(!/new\s+Function\b/.test(nobleSrc), "no new Function in the shipped text");
});

// ── published vectors (the interop floor) ───────────────────────────────────

check("X25519 matches RFC 7748 §6.1 (public keys and shared secret)", () => {
  const alicePriv = hexToB("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bobPriv = hexToB("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const x = win.NOBLE_E2E.x25519;
  assert.equal(bToHex(x.getPublicKey(alicePriv)),
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(bToHex(x.getPublicKey(bobPriv)),
    "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  assert.equal(bToHex(x.getSharedSecret(alicePriv, x.getPublicKey(bobPriv))),
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
});

check("HKDF-SHA256 matches RFC 5869 A.1 (Case 1, 42 octets)", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = hexToB("000102030405060708090a0b0c");
  const info = hexToB("f0f1f2f3f4f5f6f7f8f9");
  const okm = win.NOBLE_E2E.hkdf(win.NOBLE_E2E.sha256, ikm, salt, info, 42);
  assert.equal(bToHex(okm),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
});

check("AES-256-GCM matches the NIST zero key/IV vector (empty pt, empty aad)", () => {
  const key = new Uint8Array(32).fill(0);
  const iv = new Uint8Array(12).fill(0);
  const ct = win.NOBLE_E2E.gcm(key, iv, new Uint8Array(0), new Uint8Array(0))
    .encrypt(new Uint8Array(0));
  // empty plaintext: the output is exactly the 16-byte tag
  assert.equal(ct.length, 16);
  assert.equal(bToHex(ct), "530f8afbc74536b9a963b4f1c4cb738b");
});

// ── contract: pairing MS ────────────────────────────────────────────────────

check("both pairing sides derive the SAME master secret, and the salt binds it", () => {
  // the salt binds both public keys (no pair_id: ephemerals are per-pairing)
  const phone = E.pairEph();
  const desk = E.pairEph();
  const msPhone = E.masterSecret(phone.priv, desk.pub, phone.pub, desk.pub);
  const msDesk = E.masterSecret(desk.priv, phone.pub, phone.pub, desk.pub);
  assert.deepEqual(msPhone, msDesk);
  assert.equal(msPhone.length, 32);
  // a different phone pk or desktop pk yields a different MS
  assert.notDeepEqual(msPhone, E.masterSecret(phone.priv, desk.pub, E.pairEph().pub, desk.pub));
  assert.notDeepEqual(msPhone, E.masterSecret(phone.priv, E.pairEph().pub, phone.pub, desk.pub));
});

// ── contract: the hs handshake ─────────────────────────────────────────────

check("hs MACs verify for the right key material and fail for every wrong one", () => {
  const ms = anyMs();
  const otherMs = anyMs();

  // the phone's hs: mac over "P"||phone_pk
  const hs = E.startHs(ms);
  assert.equal(hs.pk.length, 32);
  assert.equal(hs.mac.length, 32);
  assert.deepEqual(hs.mac, E.macPhone(ms, hs.pk));
  assert.notDeepEqual(hs.mac, E.macPhone(otherMs, hs.pk));

  // the desktop's reply: mac over "D"||desk_pk||phone_pk
  const deskEph = E.pairEph();
  const deskMac = E.macDesk(ms, deskEph.pub, hs.pk);
  assert.ok(E.verifyDeskHs(ms, deskEph.pub, E.b64From(deskMac), hs.pk));
  // one flipped MAC byte → rejected
  const flipped = deskMac.slice(); flipped[0] ^= 1;
  assert.ok(!E.verifyDeskHs(ms, deskEph.pub, E.b64From(flipped), hs.pk));
  // wrong phone_pk in the verification → rejected
  assert.ok(!E.verifyDeskHs(ms, deskEph.pub, E.b64From(deskMac), E.pairEph().pub));
  // wrong MS → rejected
  assert.ok(!E.verifyDeskHs(otherMs, deskEph.pub, E.b64From(deskMac), hs.pk));
  // non-b64 / short mac strings are refused, never thrown
  assert.ok(!E.verifyDeskHs(ms, deskEph.pub, "!!!not-base64!!!", hs.pk));
  assert.ok(!E.verifyDeskHs(ms, deskEph.pub, E.b64From(deskMac.slice(0, 16)), hs.pk));
});

check("both hs sides derive the SAME session keys, c2d ≠ d2c (direction binding)", () => {
  const ms = anyMs();
  const hs = E.startHs(ms); // the phone's eph
  const deskEph = E.pairEph(); // the desk's eph

  // phone side: my eph priv + peer (desk) eph pk
  const phoneKeys = E.sessionKeys(hs.priv, deskEph.pub, hs.pk, deskEph.pub);
  // desk side: my eph priv + peer (phone) eph pk — the SAME salt order
  const deskKeys = E.sessionKeys(deskEph.priv, hs.pk, hs.pk, deskEph.pub);
  assert.deepEqual(phoneKeys.c2d, deskKeys.c2d);
  assert.deepEqual(phoneKeys.d2c, deskKeys.d2c);
  assert.notDeepEqual(phoneKeys.c2d, phoneKeys.d2c);
  assert.equal(phoneKeys.c2d.length, 32);
  assert.equal(phoneKeys.d2c.length, 32);
});
check("the nonce is 4 zero bytes then the u64 big-endian seq", () => {
  assert.equal(bToHex(E.nonce(0)), "0".repeat(24));
  // seq=1: the u64's LSB lands in the last byte
  assert.equal(bToHex(E.nonce(1)), "0".repeat(22) + "01");
  // seq=256: bit 8 → second-to-last byte
  assert.equal(bToHex(E.nonce(256)), "0".repeat(20) + "0100");
  // 2**32 (bit 32) → the 5th byte from the LSB, i.e. nonce byte 7
  assert.equal(bToHex(E.nonce(2 ** 32)), "0".repeat(14) + "01" + "0".repeat(8));
  // 2**48 + 5: bit 48 → hex chars 10-11; bits 0+2 → 0x05 in the last byte
  assert.equal(bToHex(E.nonce(2 ** 48 + 5)), "0".repeat(10) + "01" + "0".repeat(10) + "05");
  // every nonce is exactly 12 bytes, whatever the seq
  for (const s of [0, 1, 255, 65535, 2 ** 31, 2 ** 48, 2 ** 53 - 1]) {
    assert.equal(E.nonce(s).length, 12);
  }
});

check("seal/open roundtrip carries the frame verbatim; the AAD binds the seq", () => {
  const key = anyMs();
  const frame = { t: "cmd", id: 7, name: "get_state", args: { deep: [1, 2, { s: "x" }] } };
  const env = E.seal(key, 3, frame);
  assert.equal(env.t, "enc");
  assert.equal(env.seq, 3);
  assert.equal(typeof env.d, "string");
  const opened = E.open(key, -1, env);
  assert.deepEqual(opened.frame, frame);
  assert.equal(opened.seq, 3);

  // the same ciphertext claimed under a different seq (different AAD) fails
  assert.throws(() => E.open(key, -1, { ...env, seq: 4 }), /authentication failed/);
});

check("tampering with the ciphertext is rejected (GCM tag)", () => {
  const key = anyMs();
  const env = E.seal(key, 0, { t: "res", id: 1, ok: true, value: { a: 1 } });
  const raw = E.b64Bytes(env.d);
  raw[0] ^= 1; // flip one ciphertext byte
  assert.throws(() => E.open(key, -1, { ...env, d: E.b64From(raw) }), /authentication failed/);
});

check("replays and regressions are rejected; gaps (dropped frames) are allowed", () => {
  const key = anyMs();
  const e0 = E.seal(key, 0, { t: "res", id: 1, ok: true, value: null });
  const e1 = E.seal(key, 1, { t: "res", id: 2, ok: true, value: null });
  const e5 = E.seal(key, 5, { t: "res", id: 3, ok: true, value: null });

  // 0 then 1: fine
  assert.equal(E.open(key, -1, e0).seq, 0);
  assert.equal(E.open(key, 0, e1).seq, 1);
  // replay of e1 (seq 1 <= last 1): rejected
  assert.throws(() => E.open(key, 1, e1), /replay or regression/);
  // replay of e0 (seq 0 <= last 1): rejected
  assert.throws(() => E.open(key, 1, e0), /replay or regression/);
  // jumping forward to 5 (a frame lost in between): allowed
  assert.equal(E.open(key, 1, e5).seq, 5);
});

check("malformed envelopes refuse with typed errors, never throw raw", () => {
  const key = anyMs();
  // d shorter than the 16-byte tag
  assert.throws(() => E.open(key, -1, { t: "enc", seq: 0, d: E.b64From(new Uint8Array(8)) }),
    /bad enc envelope/);
  // non-integer / negative seq
  assert.throws(() => E.open(key, -1, { t: "enc", seq: 1.5, d: "AAAA" }), /bad enc envelope/);
  assert.throws(() => E.open(key, -1, { t: "enc", seq: -1, d: "AAAA" }), /bad enc envelope/);
  // wrong shape entirely
  assert.throws(() => E.open(key, -1, null), /bad enc envelope/);
  assert.throws(() => E.open(key, -1, { t: "cmd", id: 1 }), /bad enc envelope/);
  // out-of-range seq for the nonce (beyond Number.MAX_SAFE_INTEGER)
  assert.throws(() => E.seal(key, 2 ** 53, { t: "res", id: 1, ok: true, value: null }),
    /out of range/);
});

check("b64 codecs roundtrip arbitrary bytes; sha256 of the empty string is the known digest", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
  assert.deepEqual(E.b64Bytes(E.b64From(bytes)), bytes);
  assert.deepEqual(E.b64Bytes(E.b64From(new Uint8Array(0))), new Uint8Array(0));
  assert.equal(bToHex(E.sha256("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // the hs `ph` helper: sha256 hex of the token
  assert.match(E.sha256Hex("t1"), /^[0-9a-f]{64}$/);
  assert.equal(E.sha256Hex("t1"), bToHex(E.sha256("t1")));
});

// ── the double-ended session (phone ↔ desk simulation) ─────────────────────

check("full roundtrip: pair → hs exchange → sealed frames both directions", () => {
  // pairing (both sides of the same exchange)
  const pairId = "pair-99";
  const phone = E.pairEph();
  const desk = E.pairEph();
  const ms = E.masterSecret(phone.priv, desk.pub, pairId, phone.pub, desk.pub);

  // hs: the phone publishes pk+mac; the desk's reply carries pk+mac back
  const hs = E.startHs(ms);
  const deskEph = E.pairEph();
  const deskMac = E.macDesk(ms, deskEph.pub, hs.pk);
  assert.ok(E.verifyDeskHs(ms, deskEph.pub, E.b64From(deskMac), hs.pk));

  // session keys from both sides
  const phoneKeys = E.sessionKeys(hs.priv, deskEph.pub, hs.pk, deskEph.pub);
  const deskKeys = E.sessionKeys(deskEph.priv, hs.pk, hs.pk, deskEph.pub);

  // phone → desk: seal with c2d (phone side), open with c2d (desk side)
  const cmd = { t: "cmd", id: 1, name: "send_command", args: { text: "héllo wörld" } };
  const envUp = E.seal(phoneKeys.c2d, 0, cmd);
  const openedUp = E.open(deskKeys.c2d, -1, envUp);
  assert.deepEqual(openedUp.frame, cmd);
  assert.equal(openedUp.seq, 0);

  // desk → phone: seal with d2c (desk side), open with d2c (phone side)
  const res = { t: "res", id: 1, ok: true, value: { gz: E.b64From(new Uint8Array([1, 2, 3])) } };
  const envDown = E.seal(deskKeys.d2c, 0, res);
  const openedDown = E.open(phoneKeys.d2c, -1, envDown);
  assert.deepEqual(openedDown.frame, res);

  // a second up-frame: seq 1, monotone on the desk side
  const envUp2 = E.seal(phoneKeys.c2d, 1, { t: "cmd", id: 2, name: "sub", args: { name: "n" } });
  assert.equal(E.open(deskKeys.c2d, 0, envUp2).seq, 1);

  // cross-direction keys do not open each other's envelopes
  assert.throws(() => E.open(phoneKeys.d2c, -1, envUp), /authentication failed/);
  // replay of the first up-envelope at the desk: rejected
  assert.throws(() => E.open(deskKeys.c2d, 1, envUp), /replay or regression/);
});

// ── summary ─────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`test-remote-crypto: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`test-remote-crypto: ${passed} checks passed`);
