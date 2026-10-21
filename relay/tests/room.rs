//! Integration tests: real tokio-tungstenite clients against a relay bound
//! to an ephemeral port, exercising the full room + pairing protocol.

// A bin-crate integration test cannot import the binary's modules; the
// tests spawn the relay through its public surface by rebuilding the same
// router the binary serves. The relay is a bin, so we relink the module
// tree here via `#[path]`.
#[path = "../src/config.rs"]
mod config;
#[path = "../src/frame.rs"]
mod frame;
#[path = "../src/http.rs"]
mod http;
#[path = "../src/state.rs"]
mod state;
#[path = "../src/ws.rs"]
mod ws;

use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const DEVICE: &str = "demo-device";
const DEVICE_TOKEN: &str = "change-me-desktop-token";
const DEVICE_HASH: &str = "782920e555444d744e919f36bb885730f42b2e951f02d89407d421ab536106d8";

struct Relay {
    addr: std::net::SocketAddr,
    state_file: PathBuf,
    _guard: tokio::sync::oneshot::Sender<()>,
}

/// Spawn the relay on an ephemeral port with the demo device + a temp
/// state file. Static dir points at the repo's real `src/`.
async fn spawn_relay() -> Relay {
    let dir = tempdir();
    let state_file = dir.join("relay-state.json");
    let cfg = config::Config {
        bind: "127.0.0.1:0".into(),
        // Absolute: the app resolves a relative static_dir against its own
        // base dir (the tempdir here), not the test's CWD.
        static_dir: Some(
            std::fs::canonicalize("../src")
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ),
        devices: [(DEVICE.into(), DEVICE_HASH.into())].into_iter().collect(),
        state_file: Some(state_file.to_string_lossy().into_owned()),
    };
    let app = Arc::new(state::App::new(
        cfg,
        config::PersistedState::default(),
        &dir,
    ));
    let router = ws::router(app);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let serve = axum::serve(listener, router);
        tokio::select! {
            _ = serve => {}
            _ = rx => {}
        }
    });
    Relay {
        addr,
        state_file,
        _guard: tx,
    }
}

fn tempdir() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "relay-it-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn ws_url(relay: &Relay, query: &str) -> String {
    format!("ws://{}/ws?{}", relay.addr, query)
}

/// Connect a client; `ua` sets the User-Agent (becomes the phone name).
async fn connect(
    url: &str,
    ua: Option<&str>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    // Build from the URL (IntoClientRequest generates Sec-WebSocket-Key);
    // a hand-built Builder request has none and the handshake is rejected.
    let mut req = url.into_client_request().unwrap();
    if let Some(ua) = ua {
        req.headers_mut().insert("User-Agent", ua.parse().unwrap());
    }
    let (stream, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    stream
}

/// Read the next text frame as JSON (panics on timeout — tests only).
async fn next_json<S>(s: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = timeout(Duration::from_secs(10), s.next())
            .await
            .expect("timed out waiting for frame")
            .expect("stream ended")
            .expect("ws error");
        match msg {
            Message::Text(t) => {
                // The relay's join-time `hello` (t=hello + caps) is
                // positional noise for other assertions; the dedicated
                // hello tests read it via raw_json.
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["t"] == "hello" && v.get("caps").is_some() {
                    continue;
                }
                return v;
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

/// Read the next text frame as JSON, skipping only pings — unlike
/// [`next_json`], hello frames are returned (the hello tests need them).
async fn raw_json<S>(s: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = timeout(Duration::from_secs(10), s.next())
            .await
            .expect("timed out waiting for frame")
            .expect("stream ended")
            .expect("ws error");
        match msg {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

async fn send<S>(s: &mut S, v: Value)
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    s.send(Message::Text(serde_json::to_string(&v).unwrap().into()))
        .await
        .unwrap();
}

/// Expect the connection to close (returns the close code).
async fn expect_close<S>(s: &mut S) -> Option<u16>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match timeout(Duration::from_secs(10), s.next()).await {
            Err(_) => return None, // hard timeout, no close frame
            Ok(None) => return None,
            Ok(Some(Err(_))) => return None,
            Ok(Some(Ok(Message::Close(Some(f))))) => {
                return Some(u16::from(f.code));
            }
            Ok(Some(Ok(Message::Close(None)))) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

async fn connect_desktop(
    relay: &Relay,
) -> impl futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
       + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
       + Unpin {
    connect(
        &ws_url(
            relay,
            &format!("role=desktop&device={DEVICE}&token={DEVICE_TOKEN}"),
        ),
        Some("relay-test-desktop/1.0"),
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bad_token_is_rejected_before_upgrade() {
    let relay = spawn_relay().await;
    let url = ws_url(&relay, "role=desktop&device=demo-device&token=wrong");
    let req = url
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .unwrap()
        .into_client_request()
        .unwrap();
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status().as_u16(), 401);
        }
        other => panic!("expected Http(401), got {other:?}"),
    }
}

#[tokio::test]
async fn unknown_device_is_rejected() {
    let relay = spawn_relay().await;
    let url = ws_url(&relay, "role=desktop&device=nope&token=x");
    let req = url
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .unwrap()
        .into_client_request()
        .unwrap();
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status().as_u16(), 401);
        }
        other => panic!("expected Http(401), got {other:?}"),
    }
}

#[tokio::test]
async fn full_pairing_flow() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // 1. desktop opens a pairing session
    send(&mut desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(&mut desktop).await;
    assert_eq!(code["t"], "pair_code");
    let pair_url = code["url"].as_str().unwrap().to_string();
    assert!(
        pair_url.starts_with("https://"),
        "url from Host: {pair_url}"
    );
    assert!(pair_url.contains("/p#"));
    let pair_token = pair_url.rsplit('#').next().unwrap().to_string();
    assert_eq!(pair_token.len(), 64);
    let _code = code["code"].as_str().unwrap();
    assert_eq!(_code.len(), 9);

    // 2. phone presents the pair token
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&pair={pair_token}")),
        Some("iPhone; relay-test/1.0"),
    )
    .await;

    // 3. desktop sees the pair_request with the UA
    let req = next_json(&mut desktop).await;
    assert_eq!(req["t"], "pair_request");
    let pair_id = req["pair_id"].as_str().unwrap().to_string();
    assert_eq!(req["agent"], "iPhone; relay-test/1.0");

    // 4. desktop grants
    send(
        &mut desktop,
        serde_json::json!({"t":"pair_grant","pair_id":pair_id}),
    )
    .await;

    // 5. phone gets `paired` with a token, then the close
    let paired = next_json(&mut phone).await;
    assert_eq!(paired["t"], "paired");
    assert_eq!(paired["device"], DEVICE);
    let phone_token = paired["token"].as_str().unwrap().to_string();
    assert_eq!(phone_token.len(), 64);
    expect_close(&mut phone).await;

    // 6. state persisted
    let st = std::fs::read_to_string(&relay.state_file).unwrap();
    let st: Value = serde_json::from_str(&st).unwrap();
    let expected_hash = {
        // sha256 of phone_token
        use sha2::Digest;
        let d = sha2::Sha256::digest(phone_token.as_bytes());
        d.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    assert!(st["devices"][DEVICE]["phones"][&expected_hash]["name"]
        .as_str()
        .unwrap()
        .contains("iPhone"));

    // 7. phone reconnects with the real token → desktop sees peer online
    let _phone2 = connect(
        &ws_url(
            &relay,
            &format!("role=phone&device={DEVICE}&token={phone_token}"),
        ),
        Some("iPhone; relay-test/1.0"),
    )
    .await;
    let peer = next_json(&mut desktop).await;
    assert_eq!(peer["t"], "peer");
    assert_eq!(peer["phone"].as_str().unwrap().len(), 8);
    assert!(peer["online"].as_bool().unwrap());
    assert!(peer["name"].as_str().unwrap().contains("iPhone"));
}

#[tokio::test]
async fn pair_token_is_single_use() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    send(&mut desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(&mut desktop).await;
    let pair_token = code["url"]
        .as_str()
        .unwrap()
        .rsplit('#')
        .next()
        .unwrap()
        .to_string();

    // First use consumes it (even without a grant).
    let phone = connect(
        &ws_url(&relay, &format!("role=phone&pair={pair_token}")),
        Some("UA"),
    )
    .await;
    let _ = next_json(&mut desktop).await; // pair_request
    drop(phone);

    // Second use: 401 before upgrade.
    let url = ws_url(&relay, &format!("role=phone&pair={pair_token}"));
    let req = url
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .unwrap()
        .into_client_request()
        .unwrap();
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status().as_u16(), 401);
        }
        other => panic!("expected Http(401), got {other:?}"),
    }
}

#[tokio::test]
async fn pair_denied_flow() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    send(&mut desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(&mut desktop).await;
    let pair_token = code["url"]
        .as_str()
        .unwrap()
        .rsplit('#')
        .next()
        .unwrap()
        .to_string();

    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&pair={pair_token}")),
        Some("DeniedUA"),
    )
    .await;
    let req = next_json(&mut desktop).await;
    let pair_id = req["pair_id"].as_str().unwrap().to_string();

    send(
        &mut desktop,
        serde_json::json!({"t":"pair_deny","pair_id":pair_id}),
    )
    .await;
    let denied = next_json(&mut phone).await;
    assert_eq!(denied["t"], "pair_denied");
    expect_close(&mut phone).await;
}

#[tokio::test]
async fn cmd_routes_phone_to_desktop_with_conn_id_tag() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // Pair a phone quickly (reuse flow helpers).
    let phone_token = pair_phone(&relay, &mut desktop, "TagUA").await;
    let mut phone = connect(
        &ws_url(
            &relay,
            &format!("role=phone&device={DEVICE}&token={phone_token}"),
        ),
        Some("TagUA"),
    )
    .await;
    let _peer = next_json(&mut desktop).await; // phone online

    // cmd → desktop, tagged with `from`
    send(
        &mut phone,
        serde_json::json!({"t":"cmd","id":42,"name":"send_command","args":{"q":"hi"}}),
    )
    .await;
    let cmd = next_json(&mut desktop).await;
    assert_eq!(cmd["t"], "cmd");
    assert_eq!(cmd["id"], 42);
    assert_eq!(cmd["name"], "send_command");
    assert_eq!(cmd["args"]["q"], "hi");
    assert_eq!(cmd["from"].as_str().unwrap().len(), 8);
    let conn_id = cmd["from"].as_str().unwrap().to_string();

    // phone leaves → desktop gets the offline peer frame (same conn id)
    drop(phone);
    let gone = eventually_json(&mut desktop, "peer").await;
    assert_eq!(gone["phone"], conn_id.as_str());
    assert_eq!(gone["online"], false);
}

#[tokio::test]
async fn evt_broadcasts_to_all_phones() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    let tok1 = pair_phone(&relay, &mut desktop, "PhoneOne").await;
    let tok2 = pair_phone(&relay, &mut desktop, "PhoneTwo").await;
    let mut p1 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok1}")),
        Some("PhoneOne"),
    )
    .await;
    let mut p2 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok2}")),
        Some("PhoneTwo"),
    )
    .await;
    let _ = next_json(&mut desktop).await; // p1 online
    let _ = next_json(&mut desktop).await; // p2 online

    send(
        &mut desktop,
        serde_json::json!({"t":"evt","name":"agent://line/s1","payload":{"chunk":"x"}}),
    )
    .await;
    for p in [&mut p1, &mut p2] {
        // The join-time greet (presence) frames interleave; pick the evt out.
        let evt = eventually_json(p, "evt").await;
        assert_eq!(evt["name"], "agent://line/s1");
        assert_eq!(evt["payload"]["chunk"], "x");
        assert!(evt.get("from").is_none(), "desktop frames are never tagged");
    }
}

#[tokio::test]
async fn offline_fast_fail_and_desktop_replacement() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    let tok = pair_phone(&relay, &mut desktop, "OfflineUA").await;
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("OfflineUA"),
    )
    .await;
    let _ = next_json(&mut desktop).await; // phone online

    // A second desktop replaces the first: old one gets 4000.
    let mut desktop2 = connect_desktop(&relay).await;
    let code = expect_close(&mut desktop).await;
    assert_eq!(code, Some(4000), "old desktop must close with 4000");

    // Phones see the new desktop come online — replacement is atomic: the
    // old connection's cleanup stays silent (the room already belongs to
    // the new desktop), so there is no offline flap.
    let peer = next_json(&mut phone).await; // peer desktop:true
    assert_eq!(peer["desktop"], true);

    // cmd routes to the NEW desktop.
    send(
        &mut phone,
        serde_json::json!({"t":"cmd","id":7,"name":"send_command"}),
    )
    .await;
    let cmd = next_json(&mut desktop2).await;
    assert_eq!(cmd["id"], 7);

    // Now drop the new desktop: cmd gets the offline fast-fail. The greet
    // and replacement presence frames interleave — wait out the offline one.
    drop(desktop2);
    loop {
        let v = next_json(&mut phone).await;
        if v["t"] == "peer" && v["desktop"] == Value::Bool(false) {
            break;
        }
    }
    send(
        &mut phone,
        serde_json::json!({"t":"cmd","id":8,"name":"send_command"}),
    )
    .await;
    let res = eventually_json(&mut phone, "res").await;
    assert_eq!(res["id"], 8);
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"], "desktop offline");
}

#[tokio::test]
async fn revoke_drops_live_phone_and_lists() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    let tok = pair_phone(&relay, &mut desktop, "RevokeUA").await;
    let phone_hash = {
        use sha2::Digest;
        let d = sha2::Sha256::digest(tok.as_bytes());
        d.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };

    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("RevokeUA"),
    )
    .await;
    let _ = next_json(&mut desktop).await; // phone online

    // list_phones shows it
    send(&mut desktop, serde_json::json!({"t":"list_phones"})).await;
    let list = next_json(&mut desktop).await;
    assert_eq!(list["t"], "phones");
    assert_eq!(list["list"].as_array().unwrap().len(), 1);
    assert_eq!(list["list"][0]["hash"], phone_hash);

    // revoke → ack + phone dropped
    send(
        &mut desktop,
        serde_json::json!({"t":"revoke","phone_hash":phone_hash}),
    )
    .await;
    let ack = next_json(&mut desktop).await;
    assert_eq!(ack["t"], "revoked");
    assert_eq!(ack["phone_hash"], phone_hash);
    expect_close(&mut phone).await;

    // state no longer has the hash; a reconnect is 401.
    let st: Value =
        serde_json::from_str(&std::fs::read_to_string(&relay.state_file).unwrap()).unwrap();
    assert!(st["devices"][DEVICE]["phones"]
        .as_object()
        .unwrap()
        .is_empty());
    let url = ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}"));
    let req = url
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .unwrap()
        .into_client_request()
        .unwrap();
    let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
    match err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status().as_u16(), 401);
        }
        other => panic!("expected Http(401), got {other:?}"),
    }
}

#[tokio::test]
async fn oversize_frame_gets_dropped_notice_not_disconnect() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    let tok = pair_phone(&relay, &mut desktop, "BigUA").await;
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("BigUA"),
    )
    .await;
    let _ = next_json(&mut desktop).await; // phone online

    // >1 MiB cmd: dropped notice carries the id; connection survives.
    let big = "x".repeat(1024 * 1024 + 10);
    let frame = serde_json::json!({"t":"cmd","id":99,"name":"send_command","args":{"blob":big}});
    phone
        .send(Message::Text(serde_json::to_string(&frame).unwrap().into()))
        .await
        .unwrap();
    let dropped = eventually_json(&mut phone, "dropped").await;
    assert_eq!(dropped["reason"], "oversize");
    assert_eq!(dropped["id"], 99);

    // Connection still works: a normal cmd still routes.
    send(
        &mut phone,
        serde_json::json!({"t":"cmd","id":100,"name":"send_command"}),
    )
    .await;
    let cmd = next_json(&mut desktop).await;
    assert_eq!(cmd["id"], 100);
}

#[tokio::test]
async fn phone_join_is_greeted_with_presence_and_device_info() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // The desktop announces itself; the relay stores it for future greets.
    send(
        &mut desktop,
        serde_json::json!({"t":"device_info","name":"My PC","os":"windows"}),
    )
    .await;

    let tok = pair_phone(&relay, &mut desktop, "PickerUA").await;
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("PickerUA"),
    )
    .await;

    // The join greet carries both the stored identity and live presence.
    let device = eventually_json(&mut phone, "device").await;
    assert_eq!(device["name"], "My PC");
    assert_eq!(device["os"], "windows");
    let peer = eventually_json(&mut phone, "peer").await;
    assert_eq!(peer["desktop"], true);

    // A device_info change reaches connected phones.
    send(
        &mut desktop,
        serde_json::json!({"t":"device_info","name":"Renamed","os":"windows"}),
    )
    .await;
    let device = eventually_json(&mut phone, "device").await;
    assert_eq!(device["name"], "Renamed");

    // And it is persisted for later greets.
    let st: Value =
        serde_json::from_str(&std::fs::read_to_string(&relay.state_file).unwrap()).unwrap();
    assert_eq!(st["devices"][DEVICE]["info"]["name"], "Renamed");
    assert_eq!(st["devices"][DEVICE]["info"]["os"], "windows");
}

#[tokio::test]
async fn phone_join_without_desktop_is_greeted_offline() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    let tok = pair_phone(&relay, &mut desktop, "LateUA").await;
    drop(desktop);

    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("LateUA"),
    )
    .await;
    // Either the greet itself or the dropped desktop's cleanup broadcast
    // says offline; the phone must see peer desktop:false either way.
    loop {
        let v = next_json(&mut phone).await;
        if v["t"] == "peer" && v["desktop"] == Value::Bool(false) {
            break;
        }
    }
}

#[tokio::test]
async fn http_static_and_healthz() {
    let relay = spawn_relay().await;
    let base = format!("http://{}/", relay.addr);

    // healthz
    let resp = reqwest_get(format!("{base}healthz")).await;
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body, "ok");

    // index with CSP
    let resp = reqwest_get(base.clone()).await;
    assert_eq!(resp.status, 200);
    assert!(resp
        .headers
        .iter()
        .any(|(k, _)| k == "content-security-policy"));

    // /p serves the same index
    let resp = reqwest_get(format!("{base}p")).await;
    assert_eq!(resp.status, 200);
    assert!(resp.body.contains("<!DOCTYPE html>") || resp.body.contains("<html"));

    // traversal rejected
    let resp = reqwest_get(format!("{base}../../etc/passwd")).await;
    assert!(
        resp.status == 404 || resp.status == 400,
        "got {}",
        resp.status
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct SimpleResp {
    status: u16,
    body: String,
    headers: Vec<(String, String)>,
}

/// Plain GET via a one-shot TCP client (no extra deps: hand-rolled HTTP/1.1).
async fn reqwest_get(url: String) -> SimpleResp {
    let parsed = url.trim_start_matches("http://").to_string();
    let (host_port, path) = parsed.split_once('/').unwrap_or((parsed.as_str(), ""));
    let path = format!("/{path}");
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_default();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect();
    // strip chunked framing if present
    let body = if headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"))
    {
        let mut out = String::new();
        let mut rest = body;
        while let Some((sz, remainder)) = rest.split_once("\r\n") {
            let n = usize::from_str_radix(sz.trim(), 16).unwrap_or(0);
            if n == 0 {
                break;
            }
            let chunk: String = remainder.chars().take(n).collect();
            out.push_str(&chunk);
            rest = &remainder[(n * 2).min(remainder.len())..];
        }
        out
    } else {
        body.to_string()
    };
    SimpleResp {
        status,
        body,
        headers,
    }
}

/// Run a complete pairing (begin→code→request→grant→paired) and return the
/// phone token. Closes the pair socket; the caller reconnects.
async fn pair_phone<S>(relay: &Relay, desktop: &mut S, ua: &str) -> String
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    send(desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(desktop).await;
    assert_eq!(code["t"], "pair_code");
    let pair_token = code["url"]
        .as_str()
        .unwrap()
        .rsplit('#')
        .next()
        .unwrap()
        .to_string();

    let mut phone = connect(
        &ws_url(relay, &format!("role=phone&pair={pair_token}")),
        Some(ua),
    )
    .await;
    let req = next_json(desktop).await;
    assert_eq!(req["t"], "pair_request");
    let pair_id = req["pair_id"].as_str().unwrap().to_string();
    send(
        desktop,
        serde_json::json!({"t":"pair_grant","pair_id":pair_id}),
    )
    .await;
    let paired = next_json(&mut phone).await;
    assert_eq!(paired["t"], "paired");
    paired["token"].as_str().unwrap().to_string()
}

/// Poll frames until one matches `t` (presence frames interleave).
async fn eventually_json<S>(s: &mut S, want: &str) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    for _ in 0..20 {
        let v = next_json(s).await;
        if v["t"].as_str() == Some(want) {
            return v;
        }
    }
    panic!("no frame with t={want} arrived");
}

// ---------------------------------------------------------------------------
// res unicast / hello / phone friendly names
// ---------------------------------------------------------------------------

#[tokio::test]
async fn res_with_from_unicasts_only_to_target_phone() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    let tok1 = pair_phone(&relay, &mut desktop, "UniOne").await;
    let tok2 = pair_phone(&relay, &mut desktop, "UniTwo").await;
    let mut p1 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok1}")),
        Some("UniOne"),
    )
    .await;
    let mut p2 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok2}")),
        Some("UniTwo"),
    )
    .await;
    let peer1 = eventually_json(&mut desktop, "peer").await; // p1 online
    let conn1 = peer1["phone"].as_str().unwrap().to_string();
    let _ = eventually_json(&mut desktop, "peer").await; // p2 online

    // A res echoing p1's conn id: only p1 sees it.
    send(
        &mut desktop,
        serde_json::json!({"t":"res","id":11,"ok":true,"value":"just you","from":conn1}),
    )
    .await;
    let res = eventually_json(&mut p1, "res").await;
    assert_eq!(res["id"], 11);
    assert_eq!(res["value"], "just you");
    // p2 must NOT see it: the next res p2 can receive is a later marker.
    send(
        &mut desktop,
        serde_json::json!({"t":"res","id":12,"ok":true,"value":"marker"}),
    )
    .await;
    for p in [&mut p1, &mut p2] {
        let res = eventually_json(p, "res").await;
        assert_eq!(res["id"], 12, "unicast frame (id 11) must not reach p2");
    }

    // No `from` → broadcast: both phones see it.
    send(
        &mut desktop,
        serde_json::json!({"t":"res","id":13,"ok":true,"value":"all"}),
    )
    .await;
    for p in [&mut p1, &mut p2] {
        let res = eventually_json(p, "res").await;
        assert_eq!(res["id"], 13);
        assert!(res.get("from").is_none(), "desktop res is never tagged");
    }
}

#[tokio::test]
async fn res_with_stale_from_degrades_to_broadcast() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    let tok1 = pair_phone(&relay, &mut desktop, "GoneUA").await;
    let tok2 = pair_phone(&relay, &mut desktop, "StayUA").await;
    let p1 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok1}")),
        Some("GoneUA"),
    )
    .await;
    let peer = eventually_json(&mut desktop, "peer").await; // p1 online
    let gone_conn = peer["phone"].as_str().unwrap().to_string();
    drop(p1);
    let gone = eventually_json(&mut desktop, "peer").await; // p1 offline
    assert_eq!(gone["phone"], gone_conn.as_str());

    let mut p2 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok2}")),
        Some("StayUA"),
    )
    .await;
    let _ = eventually_json(&mut desktop, "peer").await; // p2 online

    // `from` names a connection that left: degrade to broadcast so the
    // frame is never lost.
    send(
        &mut desktop,
        serde_json::json!({"t":"res","id":21,"ok":true,"value":"fallback","from":gone_conn}),
    )
    .await;
    let res = eventually_json(&mut p2, "res").await;
    assert_eq!(res["id"], 21);
    assert_eq!(res["value"], "fallback");
}

#[tokio::test]
async fn hello_frame_on_join_relay_and_desktop_broadcast() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // Every join (any role) immediately gets the relay's own hello.
    let hello = raw_json(&mut desktop).await;
    assert_eq!(hello["t"], "hello");
    assert_eq!(hello["v"], 1);
    let caps = hello["caps"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "res-unicast"));
    assert!(caps.iter().any(|c| c == "transcript-window"));
    assert!(caps.iter().any(|c| c == "hello"));

    // A joining phone also gets the relay hello first.
    let tok = pair_phone(&relay, &mut desktop, "HelloUA").await;
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("HelloUA"),
    )
    .await;
    let ph = raw_json(&mut phone).await;
    assert_eq!(ph["t"], "hello");
    assert_eq!(ph["v"], 1);

    // The desktop's own hello (its caps) is broadcast like an evt.
    send(
        &mut desktop,
        serde_json::json!({"t":"hello","v":1,"caps":["gz","transcript-window","ask-sync"]}),
    )
    .await;
    let desktop_hello = eventually_hello_with_caps(&mut phone, "gz").await;
    assert_eq!(desktop_hello["v"], 1);
    assert!(
        desktop_hello["caps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "ask-sync")
    );
}

#[tokio::test]
async fn pair_wait_socket_gets_relay_hello_too() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;
    send(&mut desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(&mut desktop).await;
    let pair_token = code["url"]
        .as_str()
        .unwrap()
        .rsplit('#')
        .next()
        .unwrap()
        .to_string();

    // The pre-auth pair socket is greeted with the relay hello before
    // (or while) waiting for its verdict.
    let mut phone = connect(
        &ws_url(&relay, &format!("role=phone&pair={pair_token}")),
        Some("PairHelloUA"),
    )
    .await;
    let first = raw_json(&mut phone).await;
    assert_eq!(first["t"], "hello");
    assert_eq!(first["v"], 1);
    assert!(first["caps"].as_array().is_some());
    // And the normal pair flow still works behind it.
    let req = next_json(&mut desktop).await;
    assert_eq!(req["t"], "pair_request");
    send(
        &mut desktop,
        serde_json::json!({"t":"pair_grant","pair_id":req["pair_id"].as_str().unwrap()}),
    )
    .await;
    let paired = next_json(&mut phone).await;
    assert_eq!(paired["t"], "paired");
}

#[tokio::test]
async fn phone_query_name_cleaned_and_preferred_over_ua() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // Pair with a friendly name in the query (control chars + surrounding
    // spaces): the relay stores the CLEANED name.
    let tok = pair_phone_with_name(
        &relay,
        &mut desktop,
        "IgnoredUA",
        Some("\u{1}Pixel\u{7} 9\u{1b}"),
    )
    .await;
    let _phone = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("IgnoredUA"),
    )
    .await;
    let peer = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer["name"], "Pixel 9");

    // A name longer than 60 chars is truncated (chars, not bytes).
    let tok2 = pair_phone_with_name(&relay, &mut desktop, "IgnoredUA", Some(&"x".repeat(80)))
        .await;
    let _phone2 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok2}")),
        Some("IgnoredUA"),
    )
    .await;
    let peer2 = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer2["name"].as_str().unwrap().chars().count(), 60);

    // Multi-byte names truncate at 60 chars too.
    let tok3 = pair_phone_with_name(&relay, &mut desktop, "IgnoredUA", Some(&"\u{5b89}".repeat(100)))
        .await;
    let _phone3 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok3}")),
        Some("IgnoredUA"),
    )
    .await;
    let peer3 = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer3["name"].as_str().unwrap().chars().count(), 60);

    // A control-only name falls back to the UA.
    let tok4 = pair_phone_with_name(&relay, &mut desktop, "FallbackUA", Some("\u{1}\u{2}")).await;
    let _phone4 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok4}")),
        Some("FallbackUA"),
    )
    .await;
    let peer4 = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer4["name"], "FallbackUA");
}

#[tokio::test]
async fn phone_reconnect_with_query_name_overrides_persisted() {
    let relay = spawn_relay().await;
    let mut desktop = connect_desktop(&relay).await;

    // Paired without a friendly name (UA persisted)…
    let tok = pair_phone(&relay, &mut desktop, "OldUA").await;
    // …then reconnects supplying one: the query name wins for presence.
    let phone = connect(
        &ws_url(
            &relay,
            &format!(
                "role=phone&device={DEVICE}&token={tok}&name={}",
                urlencode("Android · 15")
            ),
        ),
        Some("OldUA"),
    )
    .await;
    let peer = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer["name"], "Android · 15");

    // And a reconnect WITHOUT the name falls back to the persisted one.
    drop(phone);
    let _ = eventually_json(&mut desktop, "peer").await; // offline
    let _phone2 = connect(
        &ws_url(&relay, &format!("role=phone&device={DEVICE}&token={tok}")),
        Some("OldUA"),
    )
    .await;
    let peer2 = eventually_json(&mut desktop, "peer").await;
    assert_eq!(peer2["name"], "OldUA");
}

// ---------------------------------------------------------------------------
// Extra helpers
// ---------------------------------------------------------------------------

/// Like [`pair_phone`], but the pair socket's URL carries a friendly
/// `name` (percent-encoded — control characters cannot ride a URL raw).
async fn pair_phone_with_name<S>(
    relay: &Relay,
    desktop: &mut S,
    ua: &str,
    name: Option<&str>,
) -> String
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    send(desktop, serde_json::json!({"t":"pair_begin"})).await;
    let code = next_json(desktop).await;
    assert_eq!(code["t"], "pair_code");
    let pair_token = code["url"]
        .as_str()
        .unwrap()
        .rsplit('#')
        .next()
        .unwrap()
        .to_string();

    let query = match name {
        Some(n) => format!("role=phone&pair={pair_token}&name={}", urlencode(n)),
        None => format!("role=phone&pair={pair_token}"),
    };
    let mut phone = connect(&ws_url(relay, &query), Some(ua)).await;
    let req = next_json(desktop).await;
    assert_eq!(req["t"], "pair_request");
    let pair_id = req["pair_id"].as_str().unwrap().to_string();
    send(
        desktop,
        serde_json::json!({"t":"pair_grant","pair_id":pair_id}),
    )
    .await;
    let paired = next_json(&mut phone).await;
    assert_eq!(paired["t"], "paired");
    paired["token"].as_str().unwrap().to_string()
}

/// Poll raw frames until a hello whose caps include `cap` (both the relay
/// hello and a desktop hello carry caps; the cap pins whose is whose).
async fn eventually_hello_with_caps<S>(s: &mut S, cap: &str) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    for _ in 0..20 {
        let v = raw_json(s).await;
        if v["t"] == "hello"
            && v["caps"]
                .as_array()
                .is_some_and(|c| c.iter().any(|x| x == cap))
        {
            return v;
        }
    }
    panic!("no hello with cap {cap} arrived");
}

/// Percent-encode a query component (control chars and separators out).
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
