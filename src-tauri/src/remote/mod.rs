//! Remote control connector (`docs/architecture/remote-control.md`).
//!
//! Outbound WSS to the user's relay — no inbound ports. The connector is
//! deliberately dumb: a phone frame arriving from the relay is `app.emit`'d
//! into the desktop's own webview (`remote://phone`), where
//! `src/app/remote-agent.js` executes it through the same bridge the local
//! UI uses; answers and event forwards travel back through the
//! [`remote_send`] command. The webview is the executor, so the phone sees
//! exactly the desktop's sessions and there is no parallel command table
//! to keep in sync.
//!
//! Settings live in `<app config>/remote.json`. The file holds the device
//! token in cleartext — it is a credential on the owner's own machine, like
//! the API keys omp itself stores; the relay only ever keeps its hash.

mod conn;
mod crypto;
mod settings;

pub use settings::{RemoteSettings, RemoteStateView};

use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};

/// Frame types the webview may ask us to send; everything else the relay
/// speaks is either inbound-only or reserved to the relay itself. `hello`
/// is the v2 caps broadcast (the `e2e` cap) — the agent sends it on
/// connect and on every phone join, as before.
const SENDABLE: [&str; 8] = [
    "res",
    "evt",
    "hello",
    "pair_begin",
    "pair_grant",
    "pair_deny",
    "list_phones",
    "revoke",
];

/// A phone's `cmd` frame, straight from the relay.
pub const EVT_PHONE: &str = "remote://phone";
/// Every other inbound control frame (`pair_request`, `pair_code`,
/// `phones`, `revoked`, `dropped`).
pub const EVT_CONTROL: &str = "remote://control";
/// A [`RemoteStateView`], re-emitted on every connection state change.
pub const EVT_STATUS: &str = "remote://status";

pub struct RemoteManager {
    settings_path: Option<PathBuf>,
    /// Current connection state, mirrored into every `remote://status`.
    status: Mutex<String>,
    /// Sender half of the running connection's outbound queue; `None` while
    /// disabled or between reconnects. A send while `None` fails soft — the
    /// phone's command already got the relay's offline error.
    outbox: Mutex<Option<(u64, mpsc::UnboundedSender<Value>)>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    /// Bumped per (re)start so a dying connection can't clear the outbox of
    /// the one that replaced it.
    generation: AtomicU64,
    /// E2E (contract v2): in-flight pairings by `pair_id`, from the relay's
    /// `pair_request` (carrying the phone's `pk`) until the relay's
    /// `pair_done` (carrying `ph`) lets us derive and persist the master
    /// secret.
    pairing: Mutex<std::collections::BTreeMap<String, PairingRecord>>,
    /// E2E session keys by the phone's connection id (the `conn` field of
    /// the relay's `peer` frames / the `from` the relay stamps on inbound
    /// frames). One entry per live e2e phone.
    sessions: Mutex<std::collections::BTreeMap<String, crypto::SessionKeys>>,
    /// The `ph` (phone token hash) behind each live phone connection, from
    /// the relay's `peer` frames (`conn` + `ph`), so a `pair_done` arriving
    /// after a phone connects still binds by hash and the Settings revoke
    /// flow keeps its existing key.
    phone_hash: Mutex<std::collections::BTreeMap<String, String>>,
}

/// One in-flight pairing (E2E v2): the phone's ephemeral public key and
/// ours, held between `pair_request` and `pair_done`.
struct PairingRecord {
    phone_pk: Vec<u8>,
    desk: crypto::KeyPair,
}

impl RemoteManager {
    /// Builds the manager and, when the user left remote access enabled,
    /// starts the connector straight away.
    pub fn new(app: &AppHandle, settings_path: Option<PathBuf>) -> Arc<Self> {
        // rustls in this process has both aws-lc-rs (via reqwest) and ring
        // (via tokio-tungstenite) compiled in — with two providers,
        // `ClientConfig::builder()` panics instead of picking one. Pin ring
        // as the process default so both stacks behave.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mgr = Arc::new(Self {
            settings_path,
            status: Mutex::new("off".into()),
            outbox: Mutex::new(None),
            stop: Mutex::new(None),
            generation: AtomicU64::new(0),
            pairing: Mutex::new(std::collections::BTreeMap::new()),
            sessions: Mutex::new(std::collections::BTreeMap::new()),
            phone_hash: Mutex::new(std::collections::BTreeMap::new()),
        });
        let settings = mgr.load_settings();
        if settings.enabled && settings.ready() {
            Self::start(&mgr, app.clone(), settings);
        }
        mgr
    }

    pub fn load_settings(&self) -> RemoteSettings {
        self.settings_path
            .as_ref()
            .map_or_else(RemoteSettings::default, |p| {
                crate::json_store::read_or_default(p)
            })
    }

    fn save_settings(&self, settings: &RemoteSettings) -> Result<(), String> {
        let path = self
            .settings_path
            .as_ref()
            .ok_or("no config dir; remote settings unavailable")?;
        let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
        crate::json_store::write_atomic(path, &bytes).map_err(|e| e.to_string())
    }

    pub(crate) fn set_status(&self, app: &AppHandle, status: &str) {
        *self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = status.to_string();
        let _ = app.emit(EVT_STATUS, self.view());
    }

    pub fn view(&self) -> RemoteStateView {
        let settings = self.load_settings();
        RemoteStateView {
            enabled: settings.enabled,
            server: settings.server,
            device_id: settings.device_id,
            status: self
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
            pinned_cert: !settings.pinned_cert_pem.trim().is_empty(),
            device_name: settings.device_name,
        }
    }

    /// Push a fresh `device_info` frame when the connector is live, so a
    /// rename reaches the relay (and the room's phones) without a
    /// reconnect. Offline: a no-op — the next connect announces it anyway.
    fn push_device_info(&self, settings: &RemoteSettings) {
        let frame = conn::device_info_frame(settings);
        let guard = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, tx)) = &*guard {
            let _ = tx.send(frame);
        }
    }

    pub(crate) fn set_outbox(&self, generation: u64, tx: mpsc::UnboundedSender<Value>) {
        *self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((generation, tx));
    }

    pub(crate) fn clear_outbox(&self, generation: u64) {
        let mut guard = self
            .outbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.as_ref().is_some_and(|(g, _)| *g == generation) {
            *guard = None;
        }
    }

    // ── E2E bookkeeping (contract v2; called from conn.rs) ─────────────

    /// A pairing request arrived carrying the phone's ephemeral `pk`:
    /// generate this desktop's pairing ephemeral for that `pair_id` and
    /// remember the phone's pk for the `pair_done` derivation. A v1
    /// `pair_request` (no `pk`) is a no-op — the pairing proceeds
    /// plaintext-less and the phone is treated as pre-v2 on connect.
    pub(crate) fn begin_pairing(&self, pair_id: &str, phone_pk: Option<&[u8]>) {
        let Some(phone_pk) = phone_pk else { return };
        if phone_pk.len() != 32 {
            return;
        }
        let Some(key) = crypto::KeyPair::generate().ok() else { return };
        self.pairing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                pair_id.to_string(),
                PairingRecord {
                    phone_pk: phone_pk.to_vec(),
                    desk: key,
                },
            );
    }

    /// The pairing UI answered; the `pair_grant` carries the desktop `pk`
    /// only when we hold a pairing record for this `pair_id`.
    pub(crate) fn pairing_pk(&self, pair_id: &str) -> Option<String> {
        let guard = self
            .pairing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .get(pair_id)
            .map(|r| crypto::b64_encode(&r.desk.public))
    }

    /// The relay confirmed the pairing (`pair_done` with the phone's token
    /// hash `ph`): derive `MS` and persist it under `ph` in `remote.json`.
    /// `Err` carries a human reason (derivation or persistence failure).
    pub(crate) fn finish_pairing(&self, pair_id: &str, ph: &str) -> Result<(), String> {
        let record = self
            .pairing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(pair_id);
        let Some(record) = record else {
            // A pairing we never saw a `pk` for (v1 phone): nothing to
            // store — the phone is paired without E2E and will be asked
            // to re-pair by the UI (contract: no plaintext fallback).
            return Ok(());
        };
        let desk_pk = record.desk.public.clone(); // 32-byte copy: record.desk is consumed by the agreement
        let ms = crypto::master_secret(record.desk, &record.phone_pk, &record.phone_pk, &desk_pk)
            .map_err(|_| "pairing key agreement failed".to_string())?;
        let ms_b64 = crypto::b64_encode(&ms);
        let mut settings = self.load_settings();
        settings
            .phones
            .entry(ph.to_string())
            .or_default()
            .ms = Some(ms_b64);
        self.save_settings(&settings)
    }


    /// A phone connection's session keys (after a verified `hs`).
    pub(crate) fn set_session(&self, conn: &str, keys: crypto::SessionKeys) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(conn.to_string(), keys);
    }

    /// The relay told us which `ph` a connection belongs to (`peer` with
    /// `conn` + `ph`); also drops any stale session for a gone conn.
    pub(crate) fn note_phone_conn(&self, conn: &str, ph: Option<&str>, online: bool) {
        if online {
            if let Some(ph) = ph {
                self.phone_hash
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(conn.to_string(), ph.to_string());
            }
        } else {
            self.sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(conn);
            self.phone_hash
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(conn);
        }
    }

    /// Session keys for a live phone connection, mutable for the seq
    /// counters (both directions live on one object).
    pub(crate) fn with_session<R>(
        &self,
        conn: &str,
        f: impl FnOnce(&mut crypto::SessionKeys) -> R,
    ) -> Option<R> {
        let mut guard = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.get_mut(conn).map(f)
    }

    /// Every live e2e phone connection id (for per-phone encryption of a
    /// broadcast evt; contract: v2 desktops unicast per phone).
    pub(crate) fn e2e_conns(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect()
    }

    /// The MS for a phone hash, decoded from `remote.json`.
    pub(crate) fn phone_ms(&self, ph: &str) -> Option<[u8; 32]> {
        let b64 = self.load_settings().phone_ms(ph)?.to_string();
        let ms = crypto::b64_decode(&b64).ok()?;
        ms.try_into().ok()
    }

    /// (Re)starts the connector task; a running one is stopped first.
    fn start(self: &Arc<Self>, app: AppHandle, settings: RemoteSettings) {
        self.stop_connector();
        let (stop_tx, stop_rx) = oneshot::channel();
        *self
            .stop
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stop_tx);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mgr = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            conn::run(app, mgr, settings, generation, stop_rx).await;
        });
    }

    fn stop_connector(&self) {
        // Take the handle under the guard, then signal after it drops — a
        // guard temp in the `if let` scrutinee would hold the lock across
        // the send.
        let stop = self
            .stop
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
    }
}

#[tauri::command]
pub fn remote_get_state(mgr: State<'_, Arc<RemoteManager>>) -> RemoteStateView {
    mgr.view()
}

/// Enable/disable + set the relay URL. Enabling for the first time generates
/// the device identity; the token stays local (the relay stores its hash).
#[tauri::command]
pub fn remote_configure(
    enabled: bool,
    server: String,
    app: AppHandle,
    mgr: State<'_, Arc<RemoteManager>>,
) -> Result<RemoteStateView, String> {
    let mut settings = mgr.load_settings();
    settings.enabled = enabled;
    settings.server = server.trim().to_string();
    if enabled {
        settings.ensure_identity();
    }
    mgr.save_settings(&settings)?;
    if enabled && settings.ready() {
        RemoteManager::start(&mgr, app, settings);
    } else {
        mgr.stop_connector();
        mgr.set_status(&app, "off");
    }
    Ok(mgr.view())
}

/// Mints a new device token and returns it **once** — the user copies it into
/// the relay's config (which stores only its hash). Reconnects if enabled.
#[tauri::command]
pub fn remote_regenerate_token(
    app: AppHandle,
    mgr: State<'_, Arc<RemoteManager>>,
) -> Result<String, String> {
    let mut settings = mgr.load_settings();
    settings.device_token = settings::random_hex();
    mgr.save_settings(&settings)?;
    // The caller shows the token once (for the relay config); `settings`
    // itself moves into the connector task, so the return value is a copy.
    let token = settings.device_token.clone();
    if settings.enabled && settings.ready() {
        RemoteManager::start(&mgr, app, settings);
    }
    Ok(token)
}

/// Rename this desktop in the phones' device picker. Persisted, and pushed
/// straight to the relay when the connector is live (no reconnect).
#[tauri::command]
pub fn remote_set_name(
    name: String,
    mgr: State<'_, Arc<RemoteManager>>,
) -> Result<RemoteStateView, String> {
    let mut settings = mgr.load_settings();
    settings.device_name = name.trim().chars().take(80).collect();
    mgr.save_settings(&settings)?;
    mgr.push_device_info(&settings);
    Ok(mgr.view())
}

/// Send one frame to the relay (see `SENDABLE`). The webview's remote agent
/// builds these; the allowlist keeps the IPC surface honest.
///
/// E2E v2: `res`/`evt` are the *business* frames — they ride encrypted,
/// per phone. A `res` unicast echoes the triggering cmd's `from` (the
/// phone's conn id); an `evt` broadcast is fanned out to every live e2e
/// session as one `enc` unicast per phone (the agent's per-phone `sub`
/// refcounting already keeps `from` on res). Control frames (`hello`,
/// pairing, revoke) stay plaintext per the contract.
#[tauri::command]
pub fn remote_send(frame: Value, mgr: State<'_, Arc<RemoteManager>>) -> Result<(), String> {
    let t = frame.get("t").and_then(Value::as_str).unwrap_or("").to_string();
    if !SENDABLE.contains(&t.as_str()) {
        return Err(format!("frame type {t:?} is not sendable"));
    }

    // Business frames → one enc envelope per target phone.
    if t == "res" || t == "evt" {
        let targets: Vec<String> = frame
            .get("from")
            .and_then(Value::as_str)
            .map_or_else(|| mgr.e2e_conns(), |s| vec![s.to_string()]);
        if targets.is_empty() {
            // Nobody e2e-connected: nothing to send (a v1 phone would see
            // plaintext, which v2 must never emit for business frames).
            return Ok(());
        }
        let plain = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
        let envelopes = targets
            .iter()
            .map(|conn| {
                mgr.with_session(conn, |keys| {
                    keys.seal(&plain).map(|(seq, sealed)| {
                        serde_json::json!({
                            "t": "enc",
                            "seq": seq,
                            "d": crypto::b64_encode(&sealed),
                            "to": conn,
                        })
                    })
                })
            })
            .collect::<Vec<_>>();
        // Clone the sender out of the guard so the lock is released
        // before the per-phone send loop (channel senders are cheap).
        let tx = {
            let guard = mgr
                .outbox
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some((_, tx)) = &*guard else {
                return Err("not connected".to_string());
            };
            let tx = tx.clone();
            drop(guard);
            tx
        };
        for env in envelopes.into_iter().flatten() {
            let env = env.map_err(|_| "session encryption failed".to_string())?;
            tx.send(env)
                .map_err(|_| "connection is closing".to_string())?;
        }
        return Ok(());
    }

    // A grant with our pairing ephemeral's pk attached (E2E pairing).
    let mut frame = frame;
    if t == "pair_grant" {
        if let Some(pair_id) = frame.get("pair_id").and_then(Value::as_str).map(str::to_owned) {
            if let Some(pk) = mgr.pairing_pk(&pair_id) {
                frame["pk"] = Value::String(pk);
            }
        }
    }
    let guard = mgr
        .outbox
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match &*guard {
        Some((_, tx)) => tx
            .send(frame)
            .map_err(|_| "connection is closing".to_string()),
        None => Err("not connected".to_string()),
    }
}

/// Trust-on-first-use for a self-signed relay: connect once accepting any
/// cert, pin the cert the server actually presented, and reconnect. Returns
/// the cert's SHA-256 fingerprint for the UI to show. The one unverified
/// hop is the whole point of TOFU — the UI surfaces the fingerprint so the
/// user can eyeball it against the server (`openssl s_client`) if they care.
#[tauri::command]
pub async fn remote_trust_server_cert(
    app: AppHandle,
    mgr: State<'_, Arc<RemoteManager>>,
) -> Result<String, String> {
    let settings = mgr.load_settings();
    if settings.server.is_empty() {
        return Err("set the relay URL first".into());
    }
    let pem = conn::fetch_server_cert_pem(&settings).await?;
    let fp = conn::cert_fingerprint_pem(&pem);
    let mut s2 = settings;
    s2.pinned_cert_pem = pem;
    mgr.save_settings(&s2)?;
    if s2.enabled && s2.ready() {
        RemoteManager::start(&mgr, app, s2);
    }
    Ok(fp)
}
