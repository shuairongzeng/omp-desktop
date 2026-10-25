//! Room registry: one room per device id (desktop + phones), pairing
//! sessions, per-connection outboxes, and token minting.
//!
//! Every mutation of `rooms`/`pairings`/`state` happens inside a
//! `tokio::sync::Mutex` guard that is dropped before any `.await`; sends to
//! other connections go through bounded `mpsc` outboxes, so one slow client
//! can never block a room.

use crate::config::{PersistedState, PhoneEntry, PAIR_TTL_SECS};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// Per-connection outbound queue bound. A full queue closes that one
/// connection (see `send_or_close`), never blocks the room.
pub const OUTBOX_CAP: usize = 256;

/// Text frames above this size are dropped (not fatal); the sender gets a
/// `{"t":"dropped","reason":"oversize",…}` reply.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Seconds the desktop has to answer a `pair_request` after the phone
/// presented the pair token.
pub const PAIR_DECISION_SECS: u64 = 60;

pub type SharedApp = Arc<App>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Desktop,
    Phone,
}

/// One live connection, either role. Phones carry their token hash (for
/// revocation close-out) and paired name (for presence frames).
#[derive(Debug, Clone)]
pub struct Conn {
    pub id: String,
    pub role: Role,
    pub device: String,
    pub phone_hash: Option<String>,
    pub phone_name: Option<String>,
}

/// A queued writer-side message for one connection.
pub enum Outbound {
    Text(String),
    Close(u16),
}

/// The send half of one connection's outbox. A full queue kills the
/// connection (pump exits after draining), never blocks the room.
#[derive(Debug, Clone)]
pub struct Outbox {
    tx: mpsc::Sender<Outbound>,
    /// Set by `send_or_close` on a full queue; the pump watches it and
    /// exits after flushing what it already queued.
    dead: Arc<std::sync::atomic::AtomicBool>,
}

impl Outbox {
    /// Enqueue one message; on a full queue mark the connection dead and
    /// drop the message instead of blocking.
    pub fn send(&self, msg: Outbound) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(msg) {
            self.dead.store(true, Ordering::Release);
        }
    }
}

#[derive(Default)]
pub struct Room {
    pub desktop: Option<Conn>,
    pub desktop_tx: Option<Outbox>,
    /// conn id → (conn, outbox)
    pub phones: HashMap<String, (Conn, Outbox)>,
}

#[derive(Default)]
pub struct Rooms {
    pub map: HashMap<String, Room>,
}

/// An in-flight pairing, keyed by `pair_id` in `App::pairings`.
#[derive(Debug)]
pub struct Pairing {
    pub pair_id: String,
    /// The single-use secret that travels in the pairing URL fragment.
    pub pair_token: String,
    /// Human-checkable code (`ABCD-1234`) shown on the desktop.
    pub code: String,
    pub device: String,
    /// User-Agent of the phone that presented the pair token (empty until
    /// then); becomes the persisted phone name when the phone supplied no
    /// friendly name.
    pub user_agent: String,
    /// Phone-supplied friendly name from the pairing WS query (`&name=`,
    /// cleaned by the handler); takes precedence over `user_agent`.
    pub friendly_name: Option<String>,
    /// Pair-token expiry (from `pair_begin`, 5 min).
    pub expires_at: Instant,
    /// The phone's E2E pairing key from its `pair_hello` (base64 X25519
    /// public key, opaque to the relay). In-memory only — never
    /// persisted, never logged.
    pub phone_pk: Option<String>,
    /// Set once the phone connects; carries the grant/deny verdict to it.
    pub phone_tx: Option<Outbox>,
}

/// Result of presenting a pair token at the WS handshake.
#[derive(Debug)]
pub enum PairAuth {
    Ok(Pairing),
    /// No session with that token (never issued, already used, or pruned).
    Unknown,
    /// Token found but past its 5-minute TTL (consumed either way).
    Expired,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PhoneRow {
    pub hash: String,
    pub name: String,
    pub paired_at: i64,
}

/// Shared application state.
pub struct App {
    pub config: crate::config::Config,
    /// `static_dir` and `state_file` resolved against the config file's
    /// directory, so the relay works from any working directory.
    pub static_root: PathBuf,
    state_file: PathBuf,
    pub state: tokio::sync::Mutex<PersistedState>,
    pub rooms: tokio::sync::Mutex<Rooms>,
    pub pairings: tokio::sync::Mutex<HashMap<String, Pairing>>,
    conn_counter: AtomicU64,
}

impl App {
    pub fn new(config: crate::config::Config, state: PersistedState, config_dir: &Path) -> Self {
        // Absolute base, so lexical `..` normalization can never collapse
        // into a shorter-than-intended relative path.
        let base = if config_dir.is_absolute() {
            config_dir.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(config_dir)
        };
        let static_root =
            crate::config::resolve_path(&base, config.static_dir.as_deref().unwrap_or("../dist"));
        let state_file = crate::config::resolve_path(
            &base,
            config.state_file.as_deref().unwrap_or("./relay-state.json"),
        );
        App {
            config,
            static_root,
            state_file,
            state: tokio::sync::Mutex::new(state),
            rooms: tokio::sync::Mutex::new(Rooms::default()),
            pairings: tokio::sync::Mutex::new(HashMap::new()),
            conn_counter: AtomicU64::new(1),
        }
    }

    /// The resolved state file path.
    pub fn state_path(&self) -> &Path {
        &self.state_file
    }

    /// 8-hex-char connection id. splitmix64 scrambles the counter (a
    /// bijection), so ids are unique and look random without bookkeeping.
    pub fn next_conn_id(&self) -> String {
        let n = self.conn_counter.fetch_add(1, Ordering::Relaxed);
        format!("{:08x}", splitmix64(n) & 0xFFFF_FFFF)
    }

    /// Fresh bounded outbox for one connection: the send handle (goes in
    /// the room registry) and the receive half (goes to the pump).
    pub fn outbox() -> (Outbox, mpsc::Receiver<Outbound>) {
        let (tx, rx) = mpsc::channel(OUTBOX_CAP);
        (
            Outbox {
                tx,
                dead: Arc::default(),
            },
            rx,
        )
    }

    // ---- pairing sessions ----

    pub async fn insert_pairing(&self, session: Pairing) {
        let mut p = self.pairings.lock().await;
        p.insert(session.pair_id.clone(), session);
    }

    /// Remove and return a pairing by pair id (grant/deny decision path).
    pub async fn take_pairing(&self, pair_id: &str) -> Option<Pairing> {
        let mut p = self.pairings.lock().await;
        p.remove(pair_id)
    }

    /// Remove a pairing if still present (pump exit / late grant no-op).
    pub async fn remove_pairing(&self, pair_id: &str) {
        let mut p = self.pairings.lock().await;
        p.remove(pair_id);
    }

    /// Drop pairings whose 5-minute token TTL has passed.
    pub async fn prune_expired_pairings(&self) {
        let now = Instant::now();
        let mut p = self.pairings.lock().await;
        p.retain(|_, s| s.expires_at > now);
    }

    /// Consume a pair token (single-use, even when expired). The human
    /// `ABCD-1234` code is an alias for the token — it's what the desktop
    /// shows for manual entry when scanning the QR is impractical.
    pub async fn take_pairing_by_token(&self, token: &str) -> PairAuth {
        let mut p = self.pairings.lock().await;
        let Some(key) = p
            .iter()
            .find(|(_, s)| s.pair_token == token || s.code.eq_ignore_ascii_case(token))
            .map(|(k, _)| k.clone())
        else {
            return PairAuth::Unknown;
        };
        let session = p.remove(&key).expect("key just found in this map");
        if session.expires_at <= Instant::now() {
            PairAuth::Expired
        } else {
            PairAuth::Ok(session)
        }
    }

    // ---- persisted phone registry ----

    /// Store the desktop's self-reported display info (`device_info`).
    pub async fn persist_device_info(&self, device: &str, info: crate::config::DeviceInfo) {
        let mut st = self.state.lock().await;
        st.devices.entry(device.to_string()).or_default().info = Some(info);
        if let Err(e) = st.save(self.state_path()) {
            tracing::error!("relay: state save failed: {e}");
        }
    }

    /// The stored display info for a device (greeting a joining phone).
    pub async fn device_info(&self, device: &str) -> Option<crate::config::DeviceInfo> {
        let st = self.state.lock().await;
        st.devices.get(device).and_then(|d| d.info.clone())
    }

    /// Mint a phone token and persist its hash under the device.
    pub async fn persist_phone(&self, device: &str, hash: String, entry: PhoneEntry) {
        let mut st = self.state.lock().await;
        st.devices
            .entry(device.to_string())
            .or_default()
            .phones
            .insert(hash, entry);
        // Sync write of a few-KB JSON under the lock: sub-millisecond, and
        // keeps save+state consistent without a second lock dance.
        if let Err(e) = st.save(self.state_path()) {
            tracing::error!("relay: state save failed: {e}");
        }
    }

    /// Delete a phone hash from persisted state; true when it existed.
    pub async fn revoke_phone(&self, device: &str, hash: &str) -> bool {
        let mut st = self.state.lock().await;
        let existed = st
            .devices
            .get_mut(device)
            .is_some_and(|d| d.phones.remove(hash).is_some());
        if existed {
            if let Err(e) = st.save(self.state_path()) {
                tracing::error!("relay: state save failed: {e}");
            }
        }
        existed
    }

    /// `list_phones` payload (owned rows, sorted by name) from state.
    pub async fn phone_list(&self, device: &str) -> Vec<PhoneRow> {
        let st = self.state.lock().await;
        let mut rows: Vec<PhoneRow> = st
            .devices
            .get(device)
            .map(|d| {
                d.phones
                    .iter()
                    .map(|(h, e)| PhoneRow {
                        hash: h.clone(),
                        name: e.name.clone(),
                        paired_at: e.paired_at,
                    })
                    .collect()
            })
            .unwrap_or_default();
        rows.sort_by(|a, b| a.name.cmp(&b.name).then(a.hash.cmp(&b.hash)));
        rows
    }

    /// Does a persisted phone hash exist for this device (phone auth)?
    pub async fn has_phone(&self, device: &str, hash: &str) -> bool {
        let st = self.state.lock().await;
        st.devices
            .get(device)
            .is_some_and(|d| d.phones.contains_key(hash))
    }

    /// Paired name for a phone hash (presence frames to the desktop).
    pub async fn phone_name_for(&self, device: &str, hash: &str) -> Option<String> {
        let st = self.state.lock().await;
        st.devices
            .get(device)
            .and_then(|d| d.phones.get(hash))
            .map(|e| e.name.clone())
    }
}

/// 256-bit random token, hex-encoded (device/phone/pair secrets).
pub fn random_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    let mut s = String::with_capacity(64);
    for b in buf {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Single-use pair token (256-bit, hex) — the URL-fragment secret.
pub fn pair_token() -> String {
    random_token()
}

/// Pairing session id (16 hex chars).
pub fn pair_id() -> String {
    random_token()[..16].to_string()
}

/// Human-checkable pairing code: `ABCD-1234`.
pub fn pair_code() -> String {
    use rand::Rng;
    let letters: [u8; 4] = std::array::from_fn(|_| b'A' + rand::rng().random_range(0..26u8));
    let digits: [u8; 4] = std::array::from_fn(|_| b'0' + rand::rng().random_range(0..10u8));
    // rand::rng guaranteed non-failing; from_utf8 on A-Z0-9 cannot fail.
    let letters = std::str::from_utf8(&letters).unwrap_or("AAAA");
    let digits = std::str::from_utf8(&digits).unwrap_or("0000");
    format!("{letters}-{digits}")
}

/// Unix seconds for `paired_at`.
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 5-minute pair-token TTL.
pub fn pair_ttl() -> Instant {
    Instant::now() + std::time::Duration::from_secs(PAIR_TTL_SECS)
}

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, PhoneEntry};

    fn app() -> App {
        let cfg: Config = serde_json::from_str(r#"{"bind":"127.0.0.1:0","devices":{}}"#).unwrap();
        App::new(cfg, PersistedState::default(), Path::new("."))
    }

    #[test]
    fn splitmix64_is_deterministic_and_injective() {
        assert_eq!(splitmix64(1), splitmix64(1));
        assert_ne!(splitmix64(1), splitmix64(2));
        let mut seen = std::collections::HashSet::new();
        for i in 0..1000u64 {
            assert!(seen.insert(splitmix64(i)), "collision at {i}");
        }
    }

    #[tokio::test]
    async fn conn_ids_unique_8_hex() {
        let app = app();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let id = app.next_conn_id();
            assert_eq!(id.len(), 8);
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn token_shapes() {
        for f in [random_token, pair_token] {
            let t = f();
            assert_eq!(t.len(), 64);
            assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert_ne!(random_token(), random_token());
        assert_eq!(pair_id().len(), 16);
    }

    #[test]
    fn pair_code_shape() {
        for _ in 0..50 {
            let c = pair_code();
            assert_eq!(c.len(), 9);
            let parts: Vec<&str> = c.split('-').collect();
            assert_eq!(parts.len(), 2);
            assert_eq!(parts[0].len(), 4);
            assert_eq!(parts[1].len(), 4);
            assert!(parts[0].chars().all(|c| c.is_ascii_uppercase()));
            assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[tokio::test]
    async fn pairing_ttl_expiry_and_single_use() {
        let app = app();
        // Fresh session → Ok
        let s = Pairing {
            pair_id: pair_id(),
            pair_token: pair_token(),
            code: pair_code(),
            device: "d".into(),
            user_agent: String::new(),
            friendly_name: None,
            expires_at: Instant::now() + std::time::Duration::from_secs(300),
            phone_pk: None,
            phone_tx: None,
        };
        let tok = s.pair_token.clone();
        app.insert_pairing(s).await;
        assert!(matches!(
            app.take_pairing_by_token(&tok).await,
            PairAuth::Ok(_)
        ));
        // Single-use: the token is gone.
        assert!(matches!(
            app.take_pairing_by_token(&tok).await,
            PairAuth::Unknown
        ));

        // Expired session → Expired (and consumed)
        let s2 = Pairing {
            pair_id: pair_id(),
            pair_token: pair_token(),
            code: pair_code(),
            device: "d".into(),
            user_agent: String::new(),
            friendly_name: None,
            expires_at: Instant::now() - std::time::Duration::from_secs(1),
            phone_pk: None,
            phone_tx: None,
        };
        let tok2 = s2.pair_token.clone();
        app.insert_pairing(s2).await;
        assert!(matches!(
            app.take_pairing_by_token(&tok2).await,
            PairAuth::Expired
        ));
        assert!(matches!(
            app.take_pairing_by_token(&tok2).await,
            PairAuth::Unknown
        ));
    }

    #[tokio::test]
    async fn prune_expired_pairings_keeps_fresh() {
        let app = app();
        let fresh = Pairing {
            pair_id: pair_id(),
            pair_token: pair_token(),
            code: pair_code(),
            device: "d".into(),
            user_agent: String::new(),
            friendly_name: None,
            expires_at: Instant::now() + std::time::Duration::from_secs(60),
            phone_pk: None,
            phone_tx: None,
        };
        let stale = Pairing {
            pair_id: pair_id(),
            pair_token: pair_token(),
            code: pair_code(),
            device: "d".into(),
            user_agent: String::new(),
            friendly_name: None,
            expires_at: Instant::now() - std::time::Duration::from_secs(1),
            phone_pk: None,
            phone_tx: None,
        };
        let stale_id = stale.pair_id.clone();
        let fresh_id = fresh.pair_id.clone();
        app.insert_pairing(stale).await;
        app.insert_pairing(fresh).await;
        app.prune_expired_pairings().await;
        assert!(app.take_pairing(&stale_id).await.is_none());
        assert!(app.take_pairing(&fresh_id).await.is_some());
    }

    #[tokio::test]
    async fn persist_list_revoke_phone() {
        let dir = tempdir();
        let cfg: Config = serde_json::from_str(&format!(
            r#"{{"bind":"127.0.0.1:0","devices":{{}},"state_file":"{}/s.json"}}"#,
            dir.to_string_lossy().replace('\\', "/")
        ))
        .unwrap();
        let app = App::new(cfg, PersistedState::default(), &dir);

        let hash = crate::config::sha256_hex("phone-tok");
        app.persist_phone(
            "dev1",
            hash.clone(),
            PhoneEntry {
                name: "Pixel".into(),
                paired_at: 42,
            },
        )
        .await;
        assert!(app.has_phone("dev1", &hash).await);
        assert_eq!(
            app.phone_name_for("dev1", &hash).await.as_deref(),
            Some("Pixel")
        );

        let list = app.phone_list("dev1").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].hash, hash);
        assert_eq!(list[0].name, "Pixel");
        assert_eq!(list[0].paired_at, 42);

        assert!(app.revoke_phone("dev1", &hash).await);
        assert!(!app.has_phone("dev1", &hash).await);
        assert!(!app.revoke_phone("dev1", &hash).await);
        assert!(app.phone_list("dev1").await.is_empty());

        // Device info: none until reported, then stored and persisted.
        assert_eq!(app.device_info("dev1").await, None);
        app.persist_device_info(
            "dev1",
            crate::config::DeviceInfo {
                name: "My PC".into(),
                os: "windows".into(),
            },
        )
        .await;
        assert_eq!(
            app.device_info("dev1").await,
            Some(crate::config::DeviceInfo {
                name: "My PC".into(),
                os: "windows".into()
            })
        );
        // State actually persisted (fresh App sees it).
        let cfg2: Config = serde_json::from_str(&format!(
            r#"{{"bind":"127.0.0.1:0","devices":{{}},"state_file":"{}/s.json"}}"#,
            dir.to_string_lossy().replace('\\', "/")
        ))
        .unwrap();
        let app2 = App::new(cfg2, PersistedState::default(), &dir);
        assert!(!app2.has_phone("dev1", &hash).await);
    }

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "relay-state-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
