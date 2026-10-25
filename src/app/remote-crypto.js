/* remote-crypto.js — the R8 E2E crypto core, phone side
 * (docs/architecture/remote-e2e-contract.md, the sole definition).
 *
 * The phone is a plain browser over the relay, frequently a self-signed
 * cert — no secure context, so window.crypto.subtle is missing. Every
 * primitive here is pure JS from the vendored noble bundle
 * (src/noble-e2e.js → window.NOBLE_E2E, IIFE, no eval, CSP-safe).
 *
 * This module owns the CONTRACT's math and nothing else:
 *  - pairing: X25519 ephemerals + the MS (master secret) derivation;
 *  - the per-connection `hs` handshake: MAC computation/verification and
 *    the two session keys (K_c2d / K_d2c) from fresh ephemerals;
 *  - the `enc` envelope: AES-256-GCM with the 12-byte seq nonce, the
 *    `enc:<seq>` AAD, and strictly-incoming-seq replay protection;
 *  - b64 codecs for the wire.
 *
 * No socket, no storage, no DOM — remote-transport.js wires it up.
 * Inert under a real desktop webview (same guard as every remote-*.js).
 */
(function () {
  "use strict";
  if (window.__TAURI__) return; // real desktop webview

  const N = () => window.NOBLE_E2E;
  if (!N()) throw new Error("remote-crypto.js: window.NOBLE_E2E is missing (load src/noble-e2e.js first)");

  const enc = new TextEncoder();

  // ── b64 codecs ────────────────────────────────────────────────────
  const b64From = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  };
  const b64Bytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesHex = (bytes) => {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  };

  const cat = (...arrays) => {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const a of arrays) { out.set(a, at); at += a.length; }
    return out;
  };

  // ── pairing: the master secret (MS) ───────────────────────────────
  /* Contract §pairing:
   *   MS = HKDF-SHA256(ikm = X25519(my_priv, peer_pk),
   *                    salt = utf8(pair_id) || phone_pk || desk_pk,
   *                    info = "omp-e2e-master-v2", 32 bytes)
   * The MS is stored per device (b64) and never leaves storage otherwise;
   * every connection derives fresh ephemerals from it. */

  /** One pairing-side ephemeral: { priv, pub } (32B each, b64-safe). */
  const pairEph = () => {
    const { secretKey, publicKey } = N().x25519.keygen();
    return { priv: secretKey, pub: publicKey };
  };

  /** The MS, from the pairing ephemerals both ends published. The phone
   *  holds its own priv + the desktop's pk; order matters exactly as the
   *  contract spells it (salt = pair_id bytes || phone_pk || desk_pk). */
  const masterSecret = (myPriv, peerPk, phonePk, deskPk) => {
    const ikm = N().x25519.getSharedSecret(myPriv, peerPk);
    const salt = cat(phonePk, deskPk);
    return N().hkdf(N().sha256, ikm, salt, enc.encode("omp-e2e-master-v2"), 32);
  };

  // ── per-connection handshake (hs) ─────────────────────────────────
  /* Contract §hs:
   *   mac key  = HKDF(MS, salt = empty, info = "omp-e2e-hs-mac-v2")
   *   phone mac = HMAC(key, "P" || phone_pk)
   *   desk   mac = HMAC(key, "D" || desk_pk || phone_pk)
   *   shared  = X25519(my_eph, peer_eph)
   *   K_c2d   = HKDF(shared, salt = phone_pk||desk_pk, "omp-e2e-c2d-v2")
   *   K_d2c   = HKDF(shared, salt = phone_pk||desk_pk, "omp-e2e-d2c-v2")
   * (labels verbatim from the contract) */

  const hsMacKey = (ms) =>
    N().hkdf(N().sha256, ms, new Uint8Array(0), enc.encode("omp-e2e-hs-mac-v2"), 32);

  const macPhone = (ms, phonePk) =>
    N().hmac(N().sha256, hsMacKey(ms), cat(enc.encode("P"), phonePk));
  const macDesk = (ms, deskPk, phonePk) =>
    N().hmac(N().sha256, hsMacKey(ms), cat(enc.encode("D"), deskPk, phonePk));

  /** Fresh hs ephemerals + this phone's hs frame payload (pk, mac).
   *  Returns { priv, pk, mac } — pk/mac go on the wire, priv stays local. */
  const startHs = (ms) => {
    const { secretKey, publicKey } = N().x25519.keygen();
    return { priv: secretKey, pk: publicKey, mac: macPhone(ms, publicKey) };
  };

  /** Verify the desktop's hs frame ({pk, mac}) against the MS: the MAC
   *  covers "D"||desk_pk||phone_pk, phone_pk being OUR hs public key. */
  const verifyDeskHs = (ms, deskPk, mac, phonePk) => {
    let got;
    try { got = b64Bytes(mac); } catch { return false; }
    if (got.length !== 32) return false;
    let want;
    try { want = macDesk(ms, deskPk, phonePk); } catch { return false; }
    if (want.length !== got.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
    return diff === 0;
  };

  /** The two session keys after both hs frames landed. Returns
   *  { c2d, d2c } (32B each): c2d seals phone→desktop, d2c opens
   *  desktop→phone. */
  const sessionKeys = (myEphPriv, peerEphPk, phonePk, deskPk) => {
    const shared = N().x25519.getSharedSecret(myEphPriv, peerEphPk);
    const salt = cat(phonePk, deskPk);
    return {
      c2d: N().hkdf(N().sha256, shared, salt, enc.encode("omp-e2e-c2d-v2"), 32),
      d2c: N().hkdf(N().sha256, shared, salt, enc.encode("omp-e2e-d2c-v2"), 32),
    };
  };

  // ── the enc envelope ──────────────────────────────────────────────
  /* Contract §enc:
   *   nonce = 4 zero bytes || u64-BE seq (per direction, from 0)
   *   AAD   = utf8 "enc:<seq>" (decimal)
   *   d     = b64( AES-256-GCM(plaintextFrameJSON) ) — ct||tag
   *   receive: seq must be STRICTLY greater than the last seen. */

  const NONCE_LEN = 12;
  const nonce = (seq) => {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("e2e seq out of range");
    const n = new Uint8Array(NONCE_LEN);
    // 4 zero bytes, then the u64 big-endian in bytes 4..11 — 8 slots
    // for 8 bytes (safe integers fit 53 bits, so the top bytes stay 0).
    n[4] = Math.floor(seq / 2 ** 56) & 0xff; // eslint-disable-line no-bitwise
    n[5] = Math.floor(seq / 2 ** 48) & 0xff; // eslint-disable-line no-bitwise
    n[6] = Math.floor(seq / 2 ** 40) & 0xff; // eslint-disable-line no-bitwise
    n[7] = Math.floor(seq / 2 ** 32) & 0xff; // eslint-disable-line no-bitwise
    n[8] = Math.floor(seq / 2 ** 24) & 0xff; // eslint-disable-line no-bitwise
    n[9] = Math.floor(seq / 2 ** 16) & 0xff; // eslint-disable-line no-bitwise
    n[10] = (seq >>> 8) & 0xff; // eslint-disable-line no-bitwise
    n[11] = seq & 0xff; // eslint-disable-line no-bitwise
    return n;
  };
  const aad = (seq) => enc.encode(`enc:${seq}`);

  /** Seal one outbound frame: { t:"enc", seq, d } (JSON-ready). The
   *  caller owns the seq counter (one per direction, starting at 0). */
  const seal = (key, seq, frame) => {
    const plain = enc.encode(JSON.stringify(frame));
    const d = N().gcm(key, nonce(seq), aad(seq)).encrypt(plain);
    return { t: "enc", seq, d: b64From(d) };
  };

  /** Open one inbound enc envelope. `lastSeq` is the highest sequence
   *  this direction has accepted; a seq of `lastSeq` or lower is a
   *  replay and throws. Returns { frame, seq } — the caller stores seq
   *  as the new high-water mark only on success. */
  const open = (key, lastSeq, env) => {
    if (!env || env.t !== "enc" || !Number.isInteger(env.seq) || env.seq < 0) {
      throw new Error("e2e: bad enc envelope");
    }
    if (env.seq <= lastSeq) throw new Error("e2e: replay or regression");
    if (typeof env.d !== "string") throw new Error("e2e: bad enc envelope");
    let ct;
    try { ct = b64Bytes(env.d); } catch { throw new Error("e2e: bad enc envelope"); }
    if (ct.length < 16) throw new Error("e2e: bad enc envelope");
    let plain;
    try {
      plain = N().gcm(key, nonce(env.seq), aad(env.seq)).decrypt(ct);
    } catch {
      throw new Error("e2e: authentication failed");
    }
    let frame;
    try { frame = JSON.parse(new TextDecoder().decode(plain)); } catch {
      throw new Error("e2e: bad enc envelope");
    }
    return { frame, seq: env.seq };
  };

  /** sha256 of a string, hex — the `ph` the hs frame carries
   *  (contract: "<token sha256 hex>"). */
  const sha256Hex = (s) => bytesHex(N().sha256(enc.encode(s)));

  window.OMP_E2E = {
    // b64 / hex
    b64From, b64Bytes, bytesHex,
    // hashing
    sha256: (s) => N().sha256(typeof s === "string" ? enc.encode(s) : s), sha256Hex,
    // pairing
    pairEph, masterSecret,
    // hs handshake
    hsMacKey, macPhone, macDesk, startHs, verifyDeskHs, sessionKeys,
    // enc envelope
    nonce, aad, seal, open,
  };
})();
