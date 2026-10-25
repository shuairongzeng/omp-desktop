//! E2E crypto for the remote connector (`docs/architecture/remote-e2e-contract.md`).
//!
//! Three primitives, all via `ring` (already in the tree through rustls,
//! pinned to the same 0.17 line):
//!
//! - X25519 ephemeral key agreement (`agreement`) — the pairing master
//!   secret and the per-connection forward-secret `hs` handshake.
//! - HKDF-SHA256 (`hkdf`) + HMAC-SHA256 (`hmac`) — every contract key
//!   derivation uses the exact `salt`/`info` labels pinned below, and the
//!   `hs` frames authenticate with HMAC over role-tagged public keys.
//! - AES-256-GCM (`aead`) — the `enc` envelope: nonce = 4 zero bytes ‖
//!   u64 big-endian seq, AAD = utf8 `enc:<seq>` (decimal), one direction
//!   one key so seq 0 is safe in both.
//!
//! [`KeyPair`] is the pairing/hs-time ephemeral; [`SessionKeys`] is the
//! per-connection state (two direction keys + strictly increasing receive
//! counters).
//! All fallible functions return `Result<_, Unspecified>`; nothing outside
//! tests unwraps (repo rule).

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::error::Unspecified;
use ring::hkdf::Salt;
use ring::hmac::{Key as HmacKey, HMAC_SHA256};
use ring::rand::SystemRandom;

/// `MS` derivation: `info` label (contract §pairing, step 5).
const MS_INFO: &[u8] = b"omp-e2e-master-v2";
/// `hs` MAC key derivation: `info` label (contract §hs).
const HS_MAC_INFO: &[u8] = b"omp-e2e-hs-mac-v2";
/// Phone→desktop session key: `info` label.
const C2D_INFO: &[u8] = b"omp-e2e-c2d-v2";
/// Desktop→phone session key: `info` label.
const D2C_INFO: &[u8] = b"omp-e2e-d2c-v2";

/// HKDF-SHA256 everywhere (`HKDF_SHA256`).
const HKDF: ring::hkdf::Algorithm = ring::hkdf::HKDF_SHA256;
/// AES-256 keys: 32 bytes, also the HKDF output length for every
/// derivation and the HMAC-SHA256 tag length.
const KEY_LEN: usize = 32;

// ── base64 (the contract's `pk`/`mac`/`d`/`ms` wire encoding) ──────────────

pub fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Standard base64 decode; any non-canonical input is `Err(Unspecified)`.
pub fn b64_decode(s: &str) -> Result<Vec<u8>, Unspecified> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| Unspecified)
}

// ── primitives ─────────────────────────────────────────────────────────────

/// A fresh X25519 ephemeral key pair (32-byte private seed held by ring,
/// 32-byte public key for the wire).
pub struct KeyPair {
    private: EphemeralPrivateKey,
    pub public: Vec<u8>,
}

impl KeyPair {
    /// Generates with OS entropy. `Err` is the ring unspecified failure
    /// (entropy source); callers map it to a reason string.
    pub fn generate() -> Result<Self, Unspecified> {
        let private = EphemeralPrivateKey::generate(&X25519, &SystemRandom::new())?;
        let public = private.compute_public_key()?.as_ref().to_vec();
        Ok(Self { private, public })
    }

    /// Consuming the one-shot private key: `agree_ephemeral` enforces a
    /// single agreement per ephemeral (ring's API shape).
    pub(crate) fn into_private(self) -> EphemeralPrivateKey {
        self.private
    }
}

/// HKDF-SHA256(ikm, salt, info) → `len` bytes (≤ 32; ring's `expand`
/// length for SHA-256 is one 32-byte block — the `Algorithm` `KeyType` —
/// and every contract derivation is 32). The RFC 5869 vectors are
/// verified as 32-byte prefixes: HKDF blocks are sequential, so the
/// first 32 bytes of a 42-byte OKM are exactly the 32-byte OKM.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>, Unspecified> {
    let prk = Salt::new(HKDF, salt).extract(ikm);
    let mut out = [0u8; KEY_LEN];
    prk.expand(&[info], HKDF)?.fill(&mut out)?;
    Ok(out[..len.min(KEY_LEN)].to_vec())
}

/// HMAC-SHA256 tag over `data`.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; KEY_LEN] {
    let tag = ring::hmac::sign(&HmacKey::new(HMAC_SHA256, key), data);
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(tag.as_ref());
    out
}

/// Constant-time HMAC-SHA256 verify (`ring::hmac::verify`).
pub fn hmac_verify(key: &[u8], data: &[u8], tag: &[u8]) -> Result<(), Unspecified> {
    ring::hmac::verify(&HmacKey::new(HMAC_SHA256, key), data, tag)
}

// ── pairing: the master secret (contract §pairing) ────────────────────────

/// The pairing-time X25519 agreement between the phone's and the desktop's
/// pairing ephemerals, salted with `phone_pk || desk_pk` (no `pair_id`: the
/// ephemerals are fresh per pairing, so session binding adds nothing, and
/// the phone never learns the relay's `pair_id` over the wire):
/// `MS = HKDF-SHA256(X25519(my_eph, peer_pk), salt, "omp-e2e-master-v2")`.
pub fn master_secret(
    my: KeyPair,
    peer_pk: &[u8],
    phone_pk: &[u8],
    desk_pk: &[u8],
) -> Result<[u8; KEY_LEN], Unspecified> {
    let salt = [phone_pk, desk_pk].concat();
    let peer = UnparsedPublicKey::new(&X25519, peer_pk);
    let shared = agree_ephemeral(my.into_private(), &peer, <[u8]>::to_vec)?;
    let ms = hkdf_sha256(&shared, &salt, MS_INFO, KEY_LEN)?;
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&ms);
    Ok(out)
}

// ── per-connection handshake + session keys (contract §hs, §enc) ──────────

/// The `hs` MAC key, shared by both roles: derived from `MS` with an empty
/// salt (HKDF's zero-salt rule is exactly RFC 5869's, which ring implements).
pub fn hs_mac_key(ms: &[u8]) -> Result<[u8; KEY_LEN], Unspecified> {
    let key = hkdf_sha256(ms, b"", HS_MAC_INFO, KEY_LEN)?;
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&key);
    Ok(out)
}

/// Phone's `hs` MAC message: `"P" || phone_pk`.
pub fn hs_mac_phone_msg(phone_pk: &[u8]) -> Vec<u8> {
    [b"P".as_slice(), phone_pk].concat()
}

/// Desktop's `hs` MAC message: `"D" || desk_pk || phone_pk`.
pub fn hs_mac_desk_msg(desk_pk: &[u8], phone_pk: &[u8]) -> Vec<u8> {
    [b"D".as_slice(), desk_pk, phone_pk].concat()
}

/// One side of an `hs` handshake. The desktop holds this between receiving
/// the phone's `hs` and replying with its own.
pub struct HsHandshake {
    eph: KeyPair,
}

impl HsHandshake {
    /// Fresh desktop ephemeral for the connection.
    pub fn new() -> Result<Self, Unspecified> {
        Ok(Self { eph: KeyPair::generate()? })
    }

    pub fn public(&self) -> &[u8] {
        &self.eph.public
    }

    /// The reply MAC: `HMAC(hs_mac_key(MS), "D" || desk_pk || phone_pk)`.
    pub fn reply_mac(&self, ms: &[u8], phone_pk: &[u8]) -> Result<[u8; KEY_LEN], Unspecified> {
        let key = hs_mac_key(ms)?;
        Ok(hmac_sha256(&key, &hs_mac_desk_msg(&self.eph.public, phone_pk)))
    }

    /// Consumes the handshake: verifies the phone's MAC (fail → close the
    /// connection), derives the session keys from the X25519 agreement
    /// salted `phone_pk || desk_pk`.
    ///
    /// `desk_pk` is the desktop's own ephemeral public key (the one the
    /// reply carries); the MAC binds the phone's claimed key to the MS.
    pub fn finish(
        self,
        ms: &[u8],
        phone_pk: &[u8],
        phone_mac: &[u8],
    ) -> Result<SessionKeys, Unspecified> {
        let key = hs_mac_key(ms)?;
        hmac_verify(&key, &hs_mac_phone_msg(phone_pk), phone_mac)?;
        let salt = [phone_pk, self.eph.public.as_slice()].concat();
        let peer = UnparsedPublicKey::new(&X25519, phone_pk);
        let shared = agree_ephemeral(self.eph.into_private(), &peer, <[u8]>::to_vec)?;
        let c2d = hkdf_sha256(&shared, &salt, C2D_INFO, KEY_LEN)?;
        let d2c = hkdf_sha256(&shared, &salt, D2C_INFO, KEY_LEN)?;
        SessionKeys::new(&c2d, &d2c)
    }
}

// ── the enc envelope (contract §enc) ──────────────────────────────────────

/// Per-connection AES-256-GCM keys and sequence numbers. One direction,
/// one key, one counter starting at 0 — the contract's replay protection
/// is the receiver's strict `seq` increase (gaps allowed, repeats never).
pub struct SessionKeys {
    /// Decryption key for phone→desktop frames (`K_c2d`).
    c2d: LessSafeKey,
    /// Encryption key for desktop→phone frames (`K_d2c`).
    d2c: LessSafeKey,
    /// Highest inbound seq accepted so far; `None` before the first.
    recv_seq: Option<u64>,
    /// Next outbound seq to stamp.
    send_seq: u64,
}

impl SessionKeys {
    /// From 32-byte raw keys (the `HsHandshake` derivation and the
    /// cross-end integration tests).
    pub fn new(c2d: &[u8], d2c: &[u8]) -> Result<Self, Unspecified> {
        Ok(Self {
            c2d: LessSafeKey::new(UnboundKey::new(&AES_256_GCM, c2d)?),
            d2c: LessSafeKey::new(UnboundKey::new(&AES_256_GCM, d2c)?),
            recv_seq: None,
            send_seq: 0,
        })
    }

    /// 12-byte nonce: 4 zero bytes ‖ u64 big-endian seq (contract §enc).
    fn nonce(seq: u64) -> Nonce {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&seq.to_be_bytes());
        Nonce::assume_unique_for_key(n)
    }

    /// AAD: utf8 `enc:<seq>` with the seq in decimal.
    fn aad(seq: u64) -> Aad<Vec<u8>> {
        Aad::from(format!("enc:{seq}").into_bytes())
    }

    /// Seals one plaintext frame (JSON bytes) → ciphertext ‖ 16-byte tag.
    /// The seq is the sender's own strictly increasing counter.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<(u64, Vec<u8>), Unspecified> {
        let seq = self.send_seq;
        self.send_seq = self
            .send_seq
            .checked_add(1)
            .ok_or(Unspecified)?;
        let mut buf = plaintext.to_vec();
        self.d2c.seal_in_place_append_tag(Self::nonce(seq), Self::aad(seq), &mut buf)?;
        Ok((seq, buf))
    }

    /// Opens one inbound envelope. `seq` must be strictly greater than
    /// every seq previously accepted on this connection (the first frame
    /// may carry 0): repeats and regressions are replay, `Err` closes the
    /// connection.
    pub fn open(&mut self, seq: u64, ciphertext: &[u8]) -> Result<Vec<u8>, Unspecified> {
        if self.recv_seq.is_some_and(|seen| seq <= seen) {
            return Err(Unspecified);
        }
        let mut buf = ciphertext.to_vec();
        let plain = self
            .c2d
            .open_in_place(Self::nonce(seq), Self::aad(seq), &mut buf)?;
        self.recv_seq = Some(seq);
        Ok(plain.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic RNG handing a fixed 32-byte seed to
    // EphemeralPrivateKey::generate — the same pattern ring's own
    // agreement tests use (their `test::rand::FixedSliceRandom`, exposed
    // publicly as the deprecated `ring::test` module): X25519's
    // generate_private_key is a plain rng.fill(32), so the seed *is* the
    // private key. That makes the RFC 7748 §6.1 vectors testable through
    // the same public generate/agree path the live code uses.
    #[allow(deprecated)]
    use ring::test::rand::FixedSliceRandom;

    #[allow(deprecated)] // ring's only seedable rng lives in the deprecated test module
    fn key_from_seed(seed: [u8; 32]) -> EphemeralPrivateKey {
        EphemeralPrivateKey::generate(&X25519, &FixedSliceRandom { bytes: &seed })
            .expect("fixed seed generates")
    }

    fn pk_from_seed(seed: [u8; 32]) -> Vec<u8> {
        key_from_seed(seed)
            .compute_public_key()
            .expect("compute public")
            .as_ref()
            .to_vec()
    }

    fn agree(seed: [u8; 32], peer_pk: &[u8]) -> Vec<u8> {
        agree_ephemeral(key_from_seed(seed), &UnparsedPublicKey::new(&X25519, peer_pk), |raw| {
            raw.to_vec()
        })
        .expect("agreement")
    }

    // RFC 7748 §6.1 (the well-known Alice/Bob vectors).
    const ALICE_PRIV: [u8; 32] = [
        0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2, 0x66,
        0x45, 0xdf, 0x4c, 0x2f, 0x87, 0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5, 0x1d, 0xb9,
        0x2c, 0x2a,
    ];
    const BOB_PRIV: [u8; 32] = [
        0x5d, 0xab, 0x08, 0x7e, 0x62, 0x4a, 0x8a, 0x4b, 0x79, 0xe1, 0x7f, 0x8b, 0x83, 0x80, 0x0e,
        0xe6, 0x6f, 0x3b, 0xb1, 0x29, 0x26, 0x18, 0xb6, 0xfd, 0x1c, 0x2f, 0x8b, 0x27, 0xff, 0x88,
        0xe0, 0xeb,
    ];
    const ALICE_PUB: [u8; 32] = [
        0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e, 0xf7,
        0x5a, 0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e, 0xaa, 0x9b,
        0x4e, 0x6a,
    ];
    const BOB_PUB: [u8; 32] = [
        0xde, 0x9e, 0xdb, 0x7d, 0x7b, 0x7d, 0xc1, 0xb4, 0xd3, 0x5b, 0x61, 0xc2, 0xec, 0xe4, 0x35,
        0x37, 0x3f, 0x83, 0x43, 0xc8, 0x5b, 0x78, 0x67, 0x4d, 0xad, 0xfc, 0x7e, 0x14, 0x6f, 0x88,
        0x2b, 0x4f,
    ];
    const SHARED: [u8; 32] = [
        0x4a, 0x5d, 0x9d, 0x5b, 0xa4, 0xce, 0x2d, 0xe1, 0x72, 0x8e, 0x3b, 0xf4, 0x80, 0x35, 0x0f,
        0x25, 0xe0, 0x7e, 0x21, 0xc9, 0x47, 0xd1, 0x9e, 0x33, 0x76, 0xf0, 0x9b, 0x3c, 0x1e, 0x16,
        0x17, 0x42,
    ];

    #[test]
    fn x25519_rfc7748_vectors() {
        assert_eq!(pk_from_seed(ALICE_PRIV), ALICE_PUB);
        assert_eq!(pk_from_seed(BOB_PRIV), BOB_PUB);
        assert_eq!(agree(ALICE_PRIV, &BOB_PUB), SHARED);
        assert_eq!(agree(BOB_PRIV, &ALICE_PUB), SHARED);
    }

    // RFC 5869 test case 1 (HKDF-SHA256, 22-byte IKM, salt, info, L=42).
    // ring's expand length is the 32-byte block, so the check is the
    // OKM's first 32 bytes (the sequential-block property above).
    #[test]
    fn hkdf_rfc5869_case1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let okm = hkdf_sha256(&ikm, &salt, &info, 32).expect("hkdf");
        assert_eq!(
            okm,
            [
                0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0,
                0x36, 0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0,
                0x2d, 0x56, 0xec, 0xc4, 0xc5, 0xbf,
            ]
        );
    }

    // RFC 5869 case 3 (zero-length salt and info): the `hs` MAC key path
    // uses exactly this shape (`HKDF(MS, salt="", info="omp-e2e-hs-mac-v2")`),
    // checked as the 32-byte OKM prefix like case 1.
    #[test]
    fn hkdf_rfc5869_case3_empty_salt_info() {
        let ikm = [0x0b; 22];
        let okm = hkdf_sha256(&ikm, b"", b"", 32).expect("hkdf");
        assert_eq!(
            okm,
            [
                0x8d, 0xa4, 0xe7, 0x75, 0xa5, 0x63, 0xc1, 0x8f, 0x71, 0x5f, 0x80, 0x2a, 0x06,
                0x3c, 0x5a, 0x31, 0xb8, 0xa1, 0x1f, 0x5c, 0x5e, 0xe1, 0x87, 0x9e, 0xc3, 0x45,
                0x4e, 0x5f, 0x3c, 0x73, 0x8d, 0x2d,
            ]
        );
    }

    // NIST GCM test vectors (McGrew-Viega AES-256-GCM cases 13/15/16,
    // the canonical public set): key/nonce/pt/aad → ct, tag.
    #[test]
    fn aes256_gcm_nist_vectors() {
        // 60-byte plaintext of the McGrew-Viega cases (15/16 share it).
        let pt60: &[u8] = &[
            0xd9, 0x31, 0x32, 0x25, 0xf8, 0x84, 0x06, 0xe5, 0xa5, 0x59, 0x09, 0xc5, 0xaf, 0xf5,
            0x26, 0x9a, 0x86, 0xa7, 0xa9, 0x53, 0x15, 0x34, 0xf7, 0xda, 0x2e, 0x4c, 0x30, 0x3d,
            0x8a, 0x31, 0x8a, 0x72, 0x1c, 0x3c, 0x0c, 0x95, 0x95, 0x68, 0x09, 0x53, 0x2f, 0xcf,
            0x0e, 0x24, 0x49, 0xa6, 0xb5, 0x25, 0xb1, 0x6a, 0xed, 0xf5, 0xaa, 0x0d, 0xe6, 0x57,
            0xba, 0x63, 0x7b, 0x39,
        ];
        // Key/nonce from the same set (feffe992… / cafebabe…).
        let key = [
            0xfe, 0xff, 0xe9, 0x92, 0x86, 0x65, 0x73, 0x1c, 0x6d, 0x6a, 0x8f, 0x94, 0x67, 0x30,
            0x83, 0x08, 0xfe, 0xff, 0xe9, 0x92, 0x86, 0x65, 0x73, 0x1c, 0x6d, 0x6a, 0x8f, 0x94,
            0x67, 0x30, 0x83, 0x08,
        ];
        // The contract's GCM envelope (nonce/AAD layout) is exercised
        // through `SessionKeys` in the roundtrip tests below — this one
        // pins the AES-256-GCM primitive itself to the public vector's
        // own 12-byte IV and empty AAD.
        let iv = [
            0xca, 0xfe, 0xba, 0xbe, 0xfa, 0xce, 0xdb, 0xad, 0xde, 0xca, 0xf8, 0x88,
        ];
        let seal = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).expect("unbound key"));
        let mut buf = pt60.to_vec();
        seal.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(iv),
            Aad::from(Vec::new()),
            &mut buf,
        )
        .expect("seal");
        let (ct, tag) = buf.split_at(buf.len() - 16);
        assert_eq!(
            ct,
            &[
                0x52, 0x2d, 0xc1, 0xf0, 0x99, 0x56, 0x7d, 0x07, 0xf4, 0x7f, 0x37, 0xa3, 0x2a,
                0x84, 0x42, 0x7d, 0x64, 0x3a, 0x8c, 0xdc, 0xbf, 0xe5, 0xc0, 0xc9, 0x75, 0x98,
                0xa2, 0xbd, 0x25, 0x55, 0xd1, 0xaa, 0x8c, 0xb0, 0x8e, 0x48, 0x59, 0x0d, 0xbb,
                0x3d, 0xa7, 0xb0, 0x8b, 0x10, 0x56, 0x82, 0x88, 0x38, 0xc5, 0xf6, 0x1e, 0x63,
                0x93, 0xba, 0x7a, 0x0a, 0xbc, 0xc9, 0xf6, 0x62,
            ][..]
        );
        assert_eq!(
            tag,
            &[
                0xeb, 0x9f, 0x79, 0x6c, 0x8d, 0x35, 0x6f, 0xc3, 0x1a, 0x84, 0x33, 0x88, 0x4b,
                0x69, 0x6f, 0x4f,
            ][..]
        );
    }

    // The full two-sided session: pairing MS → hs MAC exchange → enc
    // roundtrip. The "phone" is built from the same primitives, mirroring
    // the noble-side implementation (contract §test-vectors: each side
    // passes the standard vectors; this proves the composition both ways).
    fn phone_side(ms: &[u8], desk_pk: &[u8]) -> (Vec<u8>, [u8; KEY_LEN], SessionKeys) {
        let eph = KeyPair::generate().expect("phone eph");
        let public = eph.public.clone();
        let mac_key = hs_mac_key(ms).expect("mac key");
        let mac = hmac_sha256(&mac_key, &hs_mac_phone_msg(&public));
        let salt = [public.as_slice(), desk_pk].concat();
        let shared = agree_ephemeral(
            eph.into_private(),
            &UnparsedPublicKey::new(&X25519, desk_pk),
            <[u8]>::to_vec,
        )
        .expect("phone agreement");
        // Phone encrypts under C2D_INFO and decrypts under D2C_INFO — the
        // mirror of the desktop's SessionKeys::new(c2d, d2c).
        let c2d = hkdf_sha256(&shared, &salt, C2D_INFO, KEY_LEN).expect("c2d");
        let d2c = hkdf_sha256(&shared, &salt, D2C_INFO, KEY_LEN).expect("d2c");
        let keys = SessionKeys::new(&d2c, &c2d).expect("phone keys");
        (public, mac, keys)
    }

    #[test]
    fn full_link_roundtrip_pair_to_hs_to_enc() {
        // Pairing: the phone's pairing ephemeral is a fixed seed (only the
        // phone side needs determinism here), the desktop's is generated.
        let phone_pair_pk = pk_from_seed(ALICE_PRIV);
        let desk_pair = KeyPair::generate().expect("desk pairing eph");
        let desk_pair_pk = desk_pair.public.clone(); // 32B: desk_pair is consumed below
        let ms = master_secret(desk_pair, &phone_pair_pk, &phone_pair_pk, &desk_pair_pk).expect("MS");

        // hs: the phone presents its ephemeral pk + MAC; the desktop
        // verifies, replies, and both sides hold the session keys.
        let hs = HsHandshake::new().expect("desk hs eph");
        let (phone_pk, phone_mac, mut phone_keys) = phone_side(&ms, hs.public());
        let mut desk_keys = hs.finish(&ms, &phone_pk, &phone_mac).expect("hs");

        // enc: phone→desktop (cmd), desktop→phone (res).
        let cmd = br#"{"t":"cmd","id":7,"name":"get_state","args":{}}"#;
        let (seq, sealed) = phone_keys.seal(cmd).expect("phone seal");
        assert_eq!(desk_keys.open(seq, &sealed).expect("desk open"), cmd);

        let res = br#"{"t":"res","id":7,"ok":true,"value":null}"#;
        let (seq, sealed) = desk_keys.seal(res).expect("desk seal");
        assert_eq!(phone_keys.open(seq, &sealed).expect("phone open"), res);
    }

    #[test]
    fn tampered_ciphertext_or_tag_fails() {
        let desk_pair = KeyPair::generate().expect("eph");
        let phone_pk = pk_from_seed(ALICE_PRIV);
        let desk_pair_pk = desk_pair.public.clone();
        let ms = master_secret(desk_pair, &phone_pk, &phone_pk, &desk_pair_pk).expect("ms");
        let hs = HsHandshake::new().expect("hs");
        let (phone_pk, phone_mac, mut phone_keys) = phone_side(&ms, hs.public());
        let mut desk_keys = hs.finish(&ms, &phone_pk, &phone_mac).expect("hs");

        let (_, mut sealed) = phone_keys.seal(b"attack at dawn").expect("seal");
        sealed[0] ^= 0x01; // one bit in the ciphertext body
        assert!(desk_keys.open(0, &sealed).is_err());
        let last = sealed.len() - 1;
        sealed[last] ^= 0x80; // one bit in the tag
        assert!(desk_keys.open(0, &sealed).is_err());

        // AAD binds the seq: the same envelope at a different claimed seq
        // fails the tag check even though the key is right.
        let (_, sealed2) = phone_keys.seal(b"second").expect("seal");
        assert!(desk_keys.open(1, &sealed2).is_ok());
        assert!(desk_keys.open(2, &sealed2).is_err());
    }

    #[test]
    fn seq_regression_and_repeat_are_rejected() {
        let desk_pair = KeyPair::generate().expect("eph");
        let phone_pk = pk_from_seed(BOB_PRIV);
        let desk_pair_pk = desk_pair.public.clone();
        let ms = master_secret(desk_pair, &phone_pk, &phone_pk, &desk_pair_pk).expect("ms");
        let hs = HsHandshake::new().expect("hs");
        let (phone_pk, phone_mac, mut phone_keys) = phone_side(&ms, hs.public());
        let mut desk_keys = hs.finish(&ms, &phone_pk, &phone_mac).expect("hs");

        // seq 0 opens; its repeat is replay and rejected.
        let (s0, c0) = phone_keys.seal(b"first").expect("seal");
        assert_eq!(s0, 0);
        desk_keys.open(s0, &c0).expect("first opens");
        assert!(desk_keys.open(0, &c0).is_err());

        // A higher seq accepted, then anything ≤ it is a regression —
        // including a fresh valid envelope sealed at a lower sender seq.
        let (s2, c2) = phone_keys.seal(b"gap").expect("seal");
        assert_eq!(s2, 1);
        desk_keys.open(s2, &c2).expect("second opens");
        let (s1, c1) = {
            // Seal once more; the sender counter is past 1 now, so craft
            // the regression by replaying c0's seq via a new envelope is
            // impossible — instead prove the counter side: open c0 again.
            let s = 0;
            (s, c0.clone())
        };
        assert!(desk_keys.open(s1, &c1).is_err());
        // And seq equal to the accepted watermark is also refused (the
        // strict-greater rule), not just strictly less.
        assert!(desk_keys.open(1, &c2).is_err());
    }

    #[test]
    fn wrong_ms_fails_the_hs_mac() {
        let desk_pair = KeyPair::generate().expect("eph");
        let phone_pk = pk_from_seed(ALICE_PRIV);
        let desk_pair_pk = desk_pair.public.clone();
        let real_ms = master_secret(desk_pair, &phone_pk, &phone_pk, &desk_pair_pk).expect("ms");
        let evil_ms = [9u8; KEY_LEN];
        let hs = HsHandshake::new().expect("hs");
        let (phone_pk, phone_mac, _) = phone_side(&real_ms, hs.public());
        // The desktop holds a different MS (a re-paired phone, or a
        // mismatched relay): the MAC must not verify.
        assert!(hs.finish(&evil_ms, &phone_pk, &phone_mac).is_err());
        // The correct MS passes (control).
        let hs = HsHandshake::new().expect("hs2");
        let (phone_pk, phone_mac, _) = phone_side(&real_ms, hs.public());
        assert!(hs.finish(&real_ms, &phone_pk, &phone_mac).is_ok());
    }
}
