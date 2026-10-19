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
    /// The connection dropped or failed — back off and retry.
    Retry,
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
        match connect_once(&app, &mgr, &url, generation, &mut stop).await {
            End::Stopped => {
                mgr.clear_outbox(generation);
                mgr.set_status(&app, "off");
                return;
            }
            End::Retry => mgr.set_status(&app, "reconnecting"),
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

async fn connect_once(
    app: &AppHandle,
    mgr: &Arc<RemoteManager>,
    url: &str,
    generation: u64,
    stop: &mut oneshot::Receiver<()>,
) -> End {
    let stream = match tokio_tungstenite::connect_async(url).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            mgr.set_status(app, &format!("error: {e}"));
            return End::Retry;
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
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                    writer.abort();
                    break End::Retry;
                }
                Some(Ok(_)) => {} // pings/pongs/binary: nothing to do
                Some(Err(_)) => {
                    writer.abort();
                    break End::Retry;
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
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
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
}
