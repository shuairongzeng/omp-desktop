//! The outbound connection loop: connect, pump frames, reconnect with
//! capped exponential backoff, stop cleanly when remote access is toggled
//! off. One task per enabled connector; see `mod.rs` for the framing.

use super::{RemoteManager, RemoteSettings, EVT_CONTROL, EVT_PHONE};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

const PING_EVERY: Duration = Duration::from_secs(25);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

enum End {
    /// The user turned remote access off — do not reconnect.
    Stopped,
    /// The relay closed the socket with code 4000 ("replaced by a newer
    /// connection"): another desktop is online with the same device id —
    /// the natural case is a `remote.json` copied to a second machine.
    /// Retrying would trade the room back and forth forever, so stop and
    /// say why instead.
    Replaced,
    /// The connection dropped or failed — back off and retry. Carries the
    /// reason so the status line keeps it through the backoff.
    Retry(String),
}

pub async fn run(
    app: AppHandle,
    mgr: Arc<RemoteManager>,
    settings: RemoteSettings,
    generation: u64,
    mut stop: oneshot::Receiver<()>,
) {
    let url = settings.ws_url();
    let mut backoff = Duration::from_secs(1);
    loop {
        mgr.set_status(&app, "connecting");
        match connect_once(&app, &mgr, &url, &settings, generation, &mut stop).await {
            End::Stopped => {
                mgr.clear_outbox(generation);
                mgr.set_status(&app, "off");
                return;
            }
            End::Replaced => {
                mgr.clear_outbox(generation);
                mgr.set_status(
                    &app,
                    "off (another desktop is online with this device id — remote.json was copied?)",
                );
                return;
            }
            End::Retry(reason) => mgr.set_status(&app, &format!("reconnecting ({reason})")),
        }
        // Interruptible backoff sleep.
        if tokio::time::timeout(backoff, &mut stop).await.is_ok() {
            mgr.clear_outbox(generation);
            mgr.set_status(&app, "off");
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// TLS connector: the pinned self-signed cert when one is stored (TOFU,
/// `RemoteSettings.pinned_cert_pem`), otherwise the system roots.
fn tls_connector(settings: &RemoteSettings) -> Option<tokio_tungstenite::Connector> {
    let der = settings.pinned_cert_der()?;
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(der))
        .ok()?;
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Some(tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(
        config,
    )))
}

/// The one connect failure the user can fix from Settings: the relay's
/// cert is not trusted (self-signed, nothing pinned yet). Naming it in the
/// status is what makes the TOFU prompt's trigger honest — a bare
/// `error: …` left the user staring at a reconnect loop with no way in.
/// Every other failure stays generic; the caller formats those itself.
///
/// tokio-tungstenite 0.30 surfaces a rustls handshake failure two ways:
/// `Error::Tls` on the config path, and — what the async connect actually
/// produces — `Error::Io(InvalidData)` whose source *is* the rustls error.
/// Match both, classify once.
fn tls_failure_reason(e: &tokio_tungstenite::tungstenite::Error) -> Option<String> {
    use tokio_tungstenite::tungstenite::error::TlsError;
    let re: &rustls::Error = match e {
        tokio_tungstenite::tungstenite::Error::Tls(TlsError::Rustls(re)) => re,
        tokio_tungstenite::tungstenite::Error::Io(io) => {
            io.get_ref()?.downcast_ref::<rustls::Error>()?
        }
        _ => return None,
    };
    match re {
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => {
            Some("certificate not trusted (self-signed?)".into())
        }
        rustls::Error::InvalidCertificate(ce) => Some(format!("certificate rejected: {ce}")),
        _ => None,
    }
}

// ── TOFU cert fetch ─────────────────────────────────────────────────────

/// Accept-any-verifier used exactly once per server, from
/// `remote_trust_server_cert`, to fetch the cert we then pin.
#[derive(Debug)]
struct AcceptAll;
impl rustls::client::danger::ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Connect once (accepting anything) and return the server's leaf cert as
/// PEM. Only ever called from `remote_trust_server_cert`.
pub async fn fetch_server_cert_pem(settings: &RemoteSettings) -> Result<String, String> {
    use base64::Engine;
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(AcceptAll))
        .with_no_client_auth();
    let connector = tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config));
    let (stream, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async_tls_with_config(
            settings.ws_url(),
            None,
            false,
            Some(connector),
        ),
    )
    .await
    .map_err(|_| "connect timeout (15s)".to_string())?
    .map_err(|e| format!("connect: {e}"))?;
    let peer = stream.get_ref();
    let der = match peer {
        tokio_tungstenite::MaybeTlsStream::Rustls(s) => s
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first().cloned())
            .ok_or("server presented no certificate")?,
        _ => return Err("not a TLS connection".into()),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).map_err(|e| e.to_string())?);
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    Ok(pem)
}

/// SHA-256 fingerprint of a PEM cert, colon-separated hex for display.
pub fn cert_fingerprint_pem(pem: &str) -> String {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_default();
    let hash = crate::json_store::hex_sha256(&der);
    hash.as_bytes()
        .chunks(2)
        .map(|c| std::str::from_utf8(c).unwrap_or("??").to_string())
        .collect::<Vec<_>>()
        .join(":")
}

/// The `device_info` frame: this desktop's display identity for the
/// phone's device picker. Sent first on every connect (and on a rename);
/// the relay persists it and forwards it to the room's phones.
pub(super) fn device_info_frame(settings: &RemoteSettings) -> Value {
    serde_json::json!({
        "t": "device_info",
        "name": settings.display_name(),
        "os": RemoteSettings::os_name(),
    })
}

async fn connect_once(
    app: &AppHandle,
    mgr: &Arc<RemoteManager>,
    url: &str,
    settings: &RemoteSettings,
    generation: u64,
    stop: &mut oneshot::Receiver<()>,
) -> End {
    let stream = match tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async_tls_with_config(url, None, false, tls_connector(settings)),
    )
    .await
    {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(e)) => {
            return End::Retry(tls_failure_reason(&e).unwrap_or_else(|| format!("error: {e}")));
        }
        Err(_) => {
            return End::Retry("error: connect timeout (15s)".into());
        }
    };
    let (mut sink, mut source) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    // Announce the picker identity before any phone frame can queue: the
    // channel buffers it and the writer task flushes it in order.
    let _ = tx.send(device_info_frame(settings));
    // The inbound router answers on the same queue (hs replies, the
    // plaintext-cmd rejection), so it needs its own sender handle.
    let route_tx = tx.clone();
    mgr.set_outbox(generation, tx);
    mgr.set_status(app, "online");

    // Outbound pump: queued frames + a keepalive ping.
    let mut ping = tokio::time::interval(PING_EVERY);
    let writer = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Some(v) => {
                        if sink.send(tokio_tungstenite::tungstenite::Message::Text(v.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = ping.tick() => {
                    if sink.send(tokio_tungstenite::tungstenite::Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let end = loop {
        tokio::select! {
            _ = &mut *stop => {
                writer.abort();
                break End::Stopped;
            }
            msg = source.next() => match msg {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                    route(app, mgr, &route_tx, text.as_str());
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(cf))) => {
                    writer.abort();
                    // 4000: the relay replaced us with a newer desktop
                    // connection for the same device id (see `End::Replaced`).
                    if cf.as_ref().is_some_and(|c| u16::from(c.code) == 4000) {
                        break End::Replaced;
                    }
                    break End::Retry(format!(
                        "closed by relay: {}",
                        cf.map_or(String::new(), |c| c.code.to_string())
                    ));
                }
                None => {
                    writer.abort();
                    break End::Retry("connection ended".into());
                }
                Some(Ok(_)) => {} // pings/pongs/binary: nothing to do
                Some(Err(e)) => {
                    writer.abort();
                    break End::Retry(format!("stream error: {e}"));
                }
            },
        }
    };
    mgr.clear_outbox(generation);
    end
}

/// One inbound frame. E2E v2 (contract): business frames arrive only as
/// `enc` envelopes; a plaintext `cmd` is a pre-v2 phone and gets the
/// contract's typed rejection so its UI can say "reload the page".
/// Control frames (`pair_request`/`pair_done`/`peer`/`hs`) drive the
/// pairing and session bookkeeping on the manager, then reach the UI.
fn route(
    app: &AppHandle,
    mgr: &Arc<RemoteManager>,
    outbox: &mpsc::UnboundedSender<Value>,
    text: &str,
) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match frame.get("t").and_then(Value::as_str) {
        Some("cmd") => {
            // Plaintext business frame: v2 has no plaintext fallback.
            let id = frame.get("id").and_then(Value::as_u64);
            let from = frame.get("from").and_then(Value::as_str);
            let mut res = serde_json::json!({
                "t": "res",
                "id": id,
                "ok": false,
                "error": "e2e required — reload the phone page",
            });
            if let Some(f) = from {
                res["from"] = Value::String(f.to_string());
            }
            let _ = outbox.send(res);
        }
        Some("enc") => route_enc(app, mgr, &frame),
        Some("hs") => route_hs(mgr, outbox, &frame),
        Some("peer") => {
            // The relay's phone presence: conn + ph let us bind sessions;
            // a leaving phone drops its session.
            let online = frame
                .get("online")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(conn) = frame.get("conn").and_then(Value::as_str) {
                let ph = frame.get("ph").and_then(Value::as_str);
                mgr.note_phone_conn(conn, ph, online);
            }
            let _ = app.emit(EVT_CONTROL, &frame);
        }
        Some("pair_request") => {
            // v2: the phone's pairing ephemeral pk rides along; the grant
            // (remote_send) answers with ours.
            if let Some(pair_id) = frame
                .get("pair_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                let pk = frame
                    .get("pk")
                    .and_then(Value::as_str)
                    .and_then(|s| super::crypto::b64_decode(s).ok());
                mgr.begin_pairing(&pair_id, pk.as_deref());
            }
            let _ = app.emit(EVT_CONTROL, &frame);
        }
        Some("pair_done") => {
            // The relay's post-pairing confirmation: `ph` is the phone's
            // token hash — the MS is derived from the stored pairing
            // record (both ephemerals) and persisted under `ph`.
            let pair_id = frame.get("pair_id").and_then(Value::as_str);
            let ph = frame.get("ph").and_then(Value::as_str);
            if let Some((pair_id, ph)) = pair_id.zip(ph) {
                if let Err(e) = mgr.finish_pairing(pair_id, ph) {
                    eprintln!("[omp-desktop] remote e2e: pairing persist failed: {e}");
                }
            }
            let _ = app.emit(EVT_CONTROL, &frame);
        }
        Some(_) => {
            let _ = app.emit(EVT_CONTROL, &frame);
        }
        None => {}
    }
}

/// `enc` arm: open with the phone's session keys and dispatch the inner
/// frame into the webview, exactly as the pre-E2E plaintext path did.
fn route_enc(app: &AppHandle, mgr: &Arc<RemoteManager>, frame: &Value) {
    let Some(conn) = frame.get("from").and_then(Value::as_str) else {
        return;
    };
    let Some(seq) = frame.get("seq").and_then(Value::as_u64) else {
        return;
    };
    let Some(d) = frame.get("d").and_then(Value::as_str) else {
        return;
    };
    let Ok(sealed) = super::crypto::b64_decode(d) else {
        return;
    };
    // Open and dispatch; a failure (bad tag, replay) closes the
    // connection — the caller checks the manager's session state.
    let opened = mgr.with_session(conn, |keys| keys.open(seq, &sealed));
    match opened {
        Some(Ok(plain)) => {
            if let Ok(inner) = serde_json::from_slice::<Value>(&plain) {
                let _ = app.emit(EVT_PHONE, &inner);
            }
        }
        Some(Err(_)) => {
            // MAC/seq failure: warn and kill the session; the
            // connection loop's next ping/reconnect recovers.
            eprintln!(
                "[omp-desktop] remote e2e: bad frame from phone conn {conn}; dropping session"
            );
            mgr.note_phone_conn(conn, None, false);
        }
        None => {
            // Unknown conn: an enc from a phone we have no session
            // for (pre-hs, or after a drop). Ignore — its hs will
            // (re)establish the session.
        }
    }
}

/// `hs` arm: verify the phone's MAC under its stored MS, answer with our
/// own ephemeral + MAC, and install the session keys.
fn route_hs(mgr: &Arc<RemoteManager>, outbox: &mpsc::UnboundedSender<Value>, frame: &Value) {
    let ph = frame.get("ph").and_then(Value::as_str);
    let pk = frame.get("pk").and_then(Value::as_str);
    let mac = frame.get("mac").and_then(Value::as_str);
    // The relay tags phone→desktop frames with `from` (the phone's
    // connection id) — that is the session key, not any `conn` field.
    let conn = frame.get("from").and_then(Value::as_str);
    let Some(((ph, pk), (mac, conn))) = ph.zip(pk).zip(mac.zip(conn)) else {
        // Malformed hs: no recovery path, drop it on the floor.
        return;
    };
    let Some(ms) = mgr.phone_ms(ph) else {
        // Unknown/unpaired phone: contract says close; we at least
        // never answer, so the phone's UI shows its own error.
        eprintln!("[omp-desktop] remote e2e: hs from unknown phone {ph}");
        return;
    };
    let Ok(pk_bytes) = super::crypto::b64_decode(pk) else {
        return;
    };
    let Ok(mac_bytes) = super::crypto::b64_decode(mac) else {
        return;
    };
    let Ok(hs) = super::crypto::HsHandshake::new() else {
        return;
    };
    // The reply needs our pk + MAC — both computed before the
    // one-shot `finish` consumes the handshake (same MS and phone
    // pk as the verification inside, so a success here agrees).
    let reply_pk = super::crypto::b64_encode(hs.public());
    let reply_mac = hs
        .reply_mac(&ms, &pk_bytes)
        .map_or_default(|m| super::crypto::b64_encode(&m));
    match hs.finish(&ms, &pk_bytes, &mac_bytes) {
        Ok(keys) => {
            let _ = outbox.send(serde_json::json!({
                "t": "hs", "v": 2,
                "pk": reply_pk,
                "mac": reply_mac,
                "to": conn,
            }));
            mgr.note_phone_conn(conn, Some(ph), true);
            mgr.set_session(conn, keys);
        }
        Err(_) => {
            // MAC failure: warn (contract) and drop the phone.
            eprintln!("[omp-desktop] remote e2e: hs MAC failed for phone {ph}; refusing session");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_capped() {
        let mut b = Duration::from_secs(1);
        for _ in 0..10 {
            b = (b * 2).min(BACKOFF_MAX);
        }
        assert_eq!(b, Duration::from_secs(30));
    }

    #[test]
    fn device_info_frame_shape() {
        let s = RemoteSettings {
            device_name: "  Studio  ".into(),
            ..Default::default()
        };
        let f = device_info_frame(&s);
        assert_eq!(f["t"], "device_info");
        assert_eq!(f["name"], "Studio");
        assert_eq!(f["os"], std::env::consts::OS);
        // No chosen name: the hostname fallback keeps `name` non-empty.
        let s2 = RemoteSettings::default();
        let f2 = device_info_frame(&s2);
        assert_ne!(f2["name"].as_str().unwrap_or("").trim(), "");
    }
    #[test]
    fn tls_failure_reason_names_the_untrusted_cert() {
        use tokio_tungstenite::tungstenite::error::TlsError;
        let rustls_err = rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
        // The Settings trust prompt triggers on these substrings — the two
        // ends of the flow meet here.
        let check = |reason: String| {
            assert!(reason.contains("certificate"), "{reason}");
            assert!(reason.contains("not trusted"), "{reason}");
        };
        // The config-path wrap.
        let tls = tokio_tungstenite::tungstenite::Error::Tls(TlsError::Rustls(Box::new(
            rustls_err.clone(),
        )));
        check(tls_failure_reason(&tls).expect("unknown issuer is the TOFU case"));
        // The wrap the async connect actually produces: an io::Error whose
        // source is the rustls error (verified against the live relay).
        let io = tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls_err,
        ));
        check(tls_failure_reason(&io).expect("the io-wrapped handshake failure"));
    }

    #[test]
    fn tls_failure_reason_passes_other_failures_through() {
        use tokio_tungstenite::tungstenite::error::TlsError;
        // A non-TLS failure: no classification, the caller's generic text.
        let plain = tokio_tungstenite::tungstenite::Error::ConnectionClosed;
        assert_eq!(tls_failure_reason(&plain), None);
        // A TLS failure that is not about the cert's trust: still None.
        let other = tokio_tungstenite::tungstenite::Error::Tls(TlsError::Rustls(Box::new(
            rustls::Error::General("boom".into()),
        )));
        assert_eq!(tls_failure_reason(&other), None);
    }
}
