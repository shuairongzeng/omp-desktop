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
    use base64::Engine;
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
                    route(app, text.as_str());
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(cf))) => {
                    writer.abort();
                    break End::Retry(format!("closed by relay: {}", cf.map(|c| c.code.to_string()).unwrap_or_default()));
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

/// One inbound frame: phone commands go to the executor in the webview,
/// control frames (pairing, phone list, drop notices) to the Settings UI.
fn route(app: &AppHandle, text: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match frame.get("t").and_then(Value::as_str) {
        Some("cmd") => {
            let _ = app.emit(EVT_PHONE, &frame);
        }
        Some(_) => {
            let _ = app.emit(EVT_CONTROL, &frame);
        }
        None => {}
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
