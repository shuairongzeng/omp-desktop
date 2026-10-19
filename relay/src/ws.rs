//! `/ws`: pre-upgrade auth, room join, frame routing, the pairing state
//! machine, heartbeat, and per-connection bounded outboxes.
//!
//! Concurrency model: one pump task per connection owns the socket
//! (read + write + ping tick); routing decisions happen inline in that
//! task. Cross-connection sends go through `Outbox::send` on
//! bounded outboxes, so a stuck peer closes itself instead of blocking a
//! room. Room/pairing/state mutexes are never held across an `.await`.
//!
//! Pairing: the pre-auth phone's socket is owned by a dedicated wait task;
//! the desktop's `pair_grant`/`pair_deny` reaches it through the pairing's
//! stored outbox (`Outbound::Text` verdict, then `Outbound::Close`).

use crate::config::{phone_name, sha256_hex};
use crate::frame::{self, Inbound};
use crate::state::{App, Conn, Outbound, Outbox, PairAuth, Pairing, Role, SharedApp};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::sink::SinkExt;
use futures_util::stream::{SplitSink, SplitStream, StreamExt};
use serde::Deserialize;
use std::time::{Duration, Instant};

/// Relay → client ping every 25 s (the spec's heartbeat cadence).
const PING_PERIOD: Duration = Duration::from_secs(25);
/// Drop a connection silent for 90 s (no pong, no frames).
const SILENT_KILL: Duration = Duration::from_secs(90);

/// Close codes the relay sends (4xxx = application-specific).
mod close_code {
    pub const REPLACED: u16 = 4000;
    pub const PAIR_DENIED: u16 = 4001;
    pub const REVOKED: u16 = 4004;
}

#[derive(Deserialize, Debug)]
pub(crate) struct WsQuery {
    role: Option<String>,
    device: Option<String>,
    token: Option<String>,
    pair: Option<String>,
}

/// The WebSocket endpoint: authenticate from the query string BEFORE
/// upgrading; any failure answers 401 and no upgrade happens.
pub async fn ws_handler(
    State(app): State<SharedApp>,
    Query(q): Query<WsQuery>,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ua = header_str(&headers, header::USER_AGENT);
    // `pair_begin` builds the pair URL from this request's Host.
    let host = header_str(&headers, header::HOST);

    match q.role.as_deref() {
        Some("desktop") => {
            let (Some(device), Some(token)) = (q.device.clone(), q.token.clone()) else {
                return unauthorized();
            };
            // Device must exist in config AND sha256(token) must match.
            let ok = app
                .config
                .devices
                .get(&device)
                .is_some_and(|expected| expected == &sha256_hex(&token));
            if !ok {
                return unauthorized();
            }
            ws.on_upgrade(move |socket| desktop_session(app, socket, device, host))
        }
        Some("phone") => {
            if let Some(pair_tok) = q.pair.clone() {
                // First-time pairing: single-use pair token with a 5-min TTL.
                let session = match app.take_pairing_by_token(&pair_tok).await {
                    PairAuth::Ok(s) => s,
                    _ => return unauthorized(),
                };
                return pairing_wait(app, ws, session, ua).await;
            }
            let (Some(device), Some(token)) = (q.device.clone(), q.token.clone()) else {
                return unauthorized();
            };
            let hash = sha256_hex(&token);
            // sha256 must match a persisted phone hash for that device.
            if !app.has_phone(&device, &hash).await {
                return unauthorized();
            }
            let name = app.phone_name_for(&device, &hash).await.unwrap_or_default();
            ws.on_upgrade(move |socket| phone_session(app, socket, device, hash, name))
        }
        _ => unauthorized(),
    }
}

fn header_str(headers: &axum::http::HeaderMap, name: header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

// ---------------------------------------------------------------------------
// Session entry points
// ---------------------------------------------------------------------------

async fn desktop_session(app: SharedApp, socket: WebSocket, device: String, host: String) {
    let conn = register_desktop(&app, &device).await;
    pump(app, socket, conn, host).await;
}

async fn phone_session(
    app: SharedApp,
    socket: WebSocket,
    device: String,
    hash: String,
    name: String,
) {
    let conn = register_phone(&app, &device, &hash, &name).await;
    pump(app, socket, conn, String::new()).await;
}

async fn register_desktop(app: &SharedApp, device: &str) -> Conn {
    let conn = Conn {
        id: app.next_conn_id(),
        role: Role::Desktop,
        device: device.to_string(),
        phone_hash: None,
        phone_name: None,
    };
    let (tx, _rx) = App::outbox();
    let replaced: Option<Outbox> = {
        let mut rooms = app.rooms.lock().await;
        let room = rooms.map.entry(device.to_string()).or_default();
        let old = room.desktop_tx.take();
        room.desktop = Some(conn.clone());
        room.desktop_tx = Some(tx);
        old
    };
    // One desktop per room: a new connection replaces the old one (4000).
    if let Some(old_tx) = replaced {
        old_tx.send(Outbound::Close(close_code::REPLACED));
    }
    // Room is online: phones learn via `peer`.
    broadcast_to_phones(app, device, &frame::emit::peer_desktop(true)).await;
    conn
}

async fn register_phone(app: &SharedApp, device: &str, hash: &str, name: &str) -> Conn {
    let conn = Conn {
        id: app.next_conn_id(),
        role: Role::Phone,
        device: device.to_string(),
        phone_hash: Some(hash.to_string()),
        phone_name: Some(name.to_string()),
    };
    let (tx, _rx) = App::outbox();
    {
        let mut rooms = app.rooms.lock().await;
        rooms
            .map
            .entry(device.to_string())
            .or_default()
            .phones
            .insert(conn.id.clone(), (conn.clone(), tx));
    }
    // The desktop refcounts per-phone subscriptions from these peer frames.
    tell_desktop(app, device, &frame::emit::peer_phone(&conn.id, name, true)).await;
    conn
}

// ---------------------------------------------------------------------------
// Pairing wait (pre-auth phone socket)
// ---------------------------------------------------------------------------

/// Hold the pre-auth phone's socket while the desktop decides: the pairing
/// carries the phone's outbox; the desktop's grant/deny handler writes the
/// verdict into it. 60 s with no verdict = denied by timeout.
async fn pairing_wait(
    app: SharedApp,
    ws: WebSocketUpgrade,
    mut session: Pairing,
    ua: String,
) -> Response {
    session.user_agent = ua;
    let pair_id = session.pair_id.clone();
    let device = session.device.clone();
    let (phone_tx, phone_rx) = App::outbox();
    session.phone_tx = Some(phone_tx.clone()); // phone needs its own reply handle
                                               // Tell the room's desktop a phone wants in (it shows the approve/deny
                                               // dialog). No desktop → immediate denial.
    if let Some(dtx) = desktop_sender(&app, &device).await {
        dtx.send(Outbound::Text(frame::emit::pair_request(
            &pair_id,
            &session.user_agent,
        )));
    } else {
        // No desktop in the room: the wait task denies immediately.
        phone_tx.send(Outbound::Text(frame::emit::pair_denied()));
        phone_tx.send(Outbound::Close(close_code::PAIR_DENIED));
    }
    app.insert_pairing(session).await;

    ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();
        let mut phone_rx = phone_rx;
        let deadline = Instant::now() + Duration::from_secs(crate::state::PAIR_DECISION_SECS);
        // Pin-safe timeout: created once outside the select loop
        // (`Sleep` is !Unpin, so it cannot be a `&mut` select arm).
        let timeout = tokio::time::sleep_until(deadline.into());
        tokio::pin!(timeout);
        loop {
            tokio::select! {
                out = phone_rx.recv() => {
                    match out {
                        Some(Outbound::Text(t)) => {
                            if sink.send(Message::Text(t.into())).await.is_err() {
                                break;
                            }
                        }
                        Some(Outbound::Close(code)) => {
                            let _ = sink.send(Message::Close(Some(close_frame(code)))).await;
                            break;
                        }
                        None => break,
                    }
                }
                // A pre-auth phone can only await its verdict; its frames
                // (if any) are ignored.
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => continue,
                        Some(Err(_)) => break,
                    }
                }
                _ = &mut timeout => break,
            }
        }
        // Session over either way: single-use cleanup. Dropping the outbox
        // is enough — its receiver is gone with this task.
        app.remove_pairing(&pair_id).await;
    })
}

// ---------------------------------------------------------------------------
// The connection pump
// ---------------------------------------------------------------------------

/// Read → route, outbox → write, ping tick. `host` (desktop only) builds
/// the pair URL for `pair_begin`.
async fn pump(app: SharedApp, socket: WebSocket, conn: Conn, host: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = App::outbox();

    // Register this pump's own outbox as the connection's send handle.
    install_outbox(&app, &conn, tx.clone()).await;

    let mut ping = tokio::time::interval(PING_PERIOD);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // first tick fires immediately; skip it

    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_seen.elapsed() > SILENT_KILL {
                    tracing::info!(conn = %conn.id, "closing silent connection");
                    break;
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            out = rx.recv() => {
                match out {
                    Some(Outbound::Text(t)) => {
                        if sink.send(Message::Text(t.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Outbound::Close(code)) => {
                        let _ = sink.send(Message::Close(Some(close_frame(code)))).await;
                        break;
                    }
                    None => break,
                }
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        last_seen = Instant::now();
                        if t.len() > crate::state::MAX_FRAME_BYTES {
                            // Oversize: drop the FRAME (never the
                            // connection), tell only the sender.
                            let id = serde_json::from_str::<serde_json::Value>(t.as_str())
                                .ok()
                                .and_then(|v| v.get("id").and_then(|i| i.as_u64()));
                            tx.send(Outbound::Text(frame::emit::dropped_oversize(id)));
                        } else {
                            handle_frame(&app, &conn, &tx, t.as_str(), &host).await;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        last_seen = Instant::now();
                        if sink.send(Message::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_seen = Instant::now();
                    }
                    Some(Ok(Message::Binary(_) | Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                }
            }
        }
    }

    cleanup(&app, &conn).await;
}

/// Wire this pump's outbox into the room registry (replacing the
/// registration-time placeholder).
async fn install_outbox(app: &SharedApp, conn: &Conn, tx: Outbox) {
    let mut rooms = app.rooms.lock().await;
    let Some(room) = rooms.map.get_mut(&conn.device) else {
        return;
    };
    match conn.role {
        Role::Desktop => room.desktop_tx = Some(tx),
        Role::Phone => {
            if let Some(entry) = room.phones.get_mut(&conn.id) {
                entry.1 = tx;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Frame routing
// ---------------------------------------------------------------------------

/// Per-frame dispatch by role (envelope-validated, size-checked upstream).
async fn handle_frame(app: &SharedApp, conn: &Conn, tx: &Outbox, text: &str, host: &str) {
    let Inbound::Valid(f) = frame::parse(text) else {
        return; // malformed or unknown `t`: dropped silently
    };

    match (conn.role, f.t.as_str()) {
        // ---- phone → relay → desktop ----
        (Role::Phone, "cmd") => {
            match desktop_sender(app, &conn.device).await {
                Some(dtx) => {
                    // Tag with the sender's conn id (desktop refcounts
                    // subscriptions per phone). Desktop→phone frames are
                    // never tagged.
                    let forwarded = frame::tag_from(text, &conn.id);
                    dtx.send(Outbound::Text(forwarded));
                }
                None => {
                    // Offline fast-fail with a typed error.
                    tx.send(Outbound::Text(frame::res_offline(f.id)));
                }
            }
        }
        (Role::Phone, "res" | "evt") => {} // dropped: phones never emit these

        // ---- desktop → relay → phones (verbatim) ----
        (Role::Desktop, "res" | "evt") => {
            broadcast_to_phones(app, &conn.device, text).await;
        }
        (Role::Desktop, "cmd") => {} // dropped: desktop never issues cmds

        // ---- control frames ----
        (Role::Desktop, "pair_begin") => {
            let code = crate::state::pair_code();
            let token = crate::state::pair_token();
            let pair_id = crate::state::pair_id();
            let url = pair_url(host, &token);
            let session = Pairing {
                pair_id: pair_id.clone(),
                pair_token: token,
                code: code.clone(),
                device: conn.device.clone(),
                user_agent: String::new(),
                expires_at: crate::state::pair_ttl(),
                phone_tx: None,
            };
            app.insert_pairing(session).await;
            tx.send(Outbound::Text(frame::emit::pair_code(&code, &url)));
            tracing::info!(device = %conn.device, pair_id = %pair_id, "pairing session opened");
        }
        (Role::Desktop, "pair_grant") => {
            let Some(pair_id) = f.pair_id.as_deref() else {
                return;
            };
            let Some(mut session) = app.take_pairing(pair_id).await else {
                return;
            };
            let Some(phone_tx) = session.phone_tx.take() else {
                return;
            };
            let token = crate::state::random_token();
            app.persist_phone(
                &session.device,
                sha256_hex(&token),
                crate::config::PhoneEntry {
                    name: phone_name(&session.user_agent),
                    paired_at: crate::state::unix_now(),
                },
            )
            .await;
            phone_tx.send(Outbound::Text(frame::emit::paired(&session.device, &token)));
            // Then close: the phone reconnects with the real token.
            phone_tx.send(Outbound::Close(close_code::REPLACED));
            tracing::info!(device = %session.device, "phone paired");
        }
        (Role::Desktop, "pair_deny") => {
            let Some(pair_id) = f.pair_id.as_deref() else {
                return;
            };
            if let Some(mut session) = app.take_pairing(pair_id).await {
                if let Some(phone_tx) = session.phone_tx.take() {
                    phone_tx.send(Outbound::Text(frame::emit::pair_denied()));
                    phone_tx.send(Outbound::Close(close_code::PAIR_DENIED));
                }
            }
        }
        (Role::Desktop, "revoke") => {
            let Some(hash) = f.phone_hash.as_deref() else {
                return;
            };
            app.revoke_phone(&conn.device, hash).await;
            // Close any live phone connection carrying that hash.
            let to_close: Vec<Outbox> = {
                let rooms = app.rooms.lock().await;
                rooms
                    .map
                    .get(&conn.device)
                    .map(|r| {
                        r.phones
                            .values()
                            .filter(|(c, _)| c.phone_hash.as_deref() == Some(hash))
                            .map(|(_, t)| t.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            };
            for phone_tx in to_close {
                phone_tx.send(Outbound::Close(close_code::REVOKED));
            }
            // Ack to the desktop (idempotent UI).
            tx.send(Outbound::Text(frame::emit::revoked(hash)));
            tracing::info!(device = %conn.device, "phone revoked");
        }
        (Role::Desktop, "list_phones") => {
            let list = app.phone_list(&conn.device).await;
            tx.send(Outbound::Text(frame::emit::phones(&list)));
        }
        _ => {} // unknown/other-role combinations: dropped
    }
}

/// Pair URL from the request Host: `https://<host>/p#<pair-token>`. The
/// token only ever appears in the fragment, never a path or log.
fn pair_url(host: &str, token: &str) -> String {
    if host.is_empty() {
        format!("http://localhost/p#{token}")
    } else {
        format!("https://{host}/p#{token}")
    }
}

async fn desktop_sender(app: &SharedApp, device: &str) -> Option<Outbox> {
    let rooms = app.rooms.lock().await;
    rooms.map.get(device).and_then(|r| r.desktop_tx.clone())
}

async fn broadcast_to_phones(app: &SharedApp, device: &str, text: &str) {
    let phones: Vec<Outbox> = {
        let rooms = app.rooms.lock().await;
        rooms
            .map
            .get(device)
            .map(|r| r.phones.values().map(|(_, t)| t.clone()).collect())
            .unwrap_or_default()
    };
    for tx in phones {
        tx.send(Outbound::Text(text.to_string()));
    }
}

async fn tell_desktop(app: &SharedApp, device: &str, text: &str) {
    if let Some(tx) = desktop_sender(app, device).await {
        tx.send(Outbound::Text(text.to_string()));
    }
}

/// Room teardown for one connection: remove from the registry, emit the
/// matching presence frame(s).
async fn cleanup(app: &SharedApp, conn: &Conn) {
    let removed = {
        let mut rooms = app.rooms.lock().await;
        let Some(room) = rooms.map.get_mut(&conn.device) else {
            return;
        };
        match conn.role {
            Role::Desktop => {
                let was_current = room.desktop.as_ref().is_some_and(|c| c.id == conn.id);
                if was_current {
                    room.desktop = None;
                    room.desktop_tx = None;
                }
                was_current
            }
            Role::Phone => room.phones.remove(&conn.id).is_some(),
        }
    };
    if !removed {
        return;
    }
    match conn.role {
        Role::Desktop => {
            broadcast_to_phones(app, &conn.device, &frame::emit::peer_desktop(false)).await;
        }
        Role::Phone => {
            let name = conn.phone_name.clone().unwrap_or_default();
            tell_desktop(
                app,
                &conn.device,
                &frame::emit::peer_phone(&conn.id, &name, false),
            )
            .await;
        }
    }
}

fn close_frame(code: u16) -> CloseFrame {
    CloseFrame {
        code,
        reason: match code {
            close_code::REPLACED => "replaced by a newer connection",
            close_code::PAIR_DENIED => "pairing denied",
            close_code::REVOKED => "revoked",
            _ => "closing",
        }
        .into(),
    }
}

/// Writer halves (tests use these types too).
#[allow(dead_code)]
type WsSink = SplitSink<WebSocket, Message>;
#[allow(dead_code)]
type WsStream = SplitStream<WebSocket>;

/// The full relay router: static hosting + `/ws`. `main` and the tests
/// both build this.
pub fn router(app: SharedApp) -> axum::Router {
    let http_app = std::sync::Arc::clone(&app); // Arc handle for the http router
    axum::Router::new()
        .route("/ws", axum::routing::get(ws_handler))
        .with_state(app)
        .merge(crate::http::router(http_app))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_url_built_from_host() {
        assert_eq!(
            pair_url("relay.example:443", "tok1"),
            "https://relay.example:443/p#tok1"
        );
        assert_eq!(pair_url("", "tok2"), "http://localhost/p#tok2");
    }

    #[test]
    fn close_frame_reasons() {
        assert_eq!(close_frame(close_code::REPLACED).code, close_code::REPLACED);
        assert!(close_frame(close_code::REPLACED)
            .reason
            .as_str()
            .contains("replaced"));
        assert!(close_frame(close_code::REVOKED)
            .reason
            .as_str()
            .contains("revoked"));
        assert!(close_frame(close_code::PAIR_DENIED)
            .reason
            .as_str()
            .contains("denied"));
        assert_eq!(close_frame(4999).reason.as_str(), "closing");
    }

    #[test]
    fn close_codes_are_application_range() {
        assert!((4000..=4999).contains(&close_code::REPLACED));
        assert!((4000..=4999).contains(&close_code::PAIR_DENIED));
        assert!((4000..=4999).contains(&close_code::REVOKED));
    }

    #[test]
    fn heartbeat_constants_match_spec() {
        assert_eq!(PING_PERIOD, Duration::from_secs(25));
        assert_eq!(SILENT_KILL, Duration::from_secs(90));
    }
}
