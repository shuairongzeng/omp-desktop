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
mod settings;

pub use settings::{RemoteSettings, RemoteStateView};

use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};

/// Frame types the webview may ask us to send; everything else the relay
/// speaks is either inbound-only or reserved to the relay itself.
const SENDABLE: [&str; 7] = [
    "res",
    "evt",
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
#[tauri::command]
pub fn remote_send(frame: Value, mgr: State<'_, Arc<RemoteManager>>) -> Result<(), String> {
    let t = frame.get("t").and_then(Value::as_str).unwrap_or("");
    if !SENDABLE.contains(&t) {
        return Err(format!("frame type {t:?} is not sendable"));
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
