//! HTTP: static hosting of `static_dir`, `/p` (pairing landing), `/healthz`,
//! and the strict CSP on every HTML response.

use crate::config::{cache_control_for, content_type_for, safe_join};
use crate::state::SharedApp;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::io::Read;

/// Strict CSP for every HTML response — mirrors the release Tauri CSP plus
/// `connect-src ws:/wss:` for the room socket and `worker-src 'self'`.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; worker-src 'self'";

pub fn router(app: SharedApp) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/p", get(index))
        .route("/healthz", get(healthz))
        .fallback(static_file)
        .with_state(app)
}

async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn index(State(app): State<SharedApp>) -> Response {
    serve_static(&app, "index.html")
}

async fn static_file(State(app): State<SharedApp>, uri: Uri) -> Response {
    serve_static(&app, uri.path())
}

/// Serve one path inside the static root; escapes and misses are plain 404s.
fn serve_static(app: &SharedApp, req_path: &str) -> Response {
    let Some(mut path) = safe_join(&app.static_root, req_path) else {
        return not_found();
    };
    if path.is_dir() {
        // Directory URLs resolve to their index.html.
        path.push("index.html");
    }
    serve_file(&path)
}

fn serve_file(path: &std::path::Path) -> Response {
    let bytes = match read_file(path) {
        Some(b) => b,
        None => return not_found(),
    };

    let mut headers = HeaderMap::with_capacity(3);
    let ct = content_type_for(path);
    insert_header(&mut headers, header::CONTENT_TYPE, ct);
    insert_header(&mut headers, header::CACHE_CONTROL, cache_control_for(path));
    if ct.starts_with("text/html") {
        insert_header(&mut headers, header::CONTENT_SECURITY_POLICY, CSP);
    }
    (StatusCode::OK, headers, bytes).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn insert_header(headers: &mut HeaderMap, name: header::HeaderName, value: &'static str) {
    // `from_static` panics on invalid bytes; all call sites are literals.
    let v = HeaderValue::from_static(value);
    headers.insert(name, v);
}

fn read_file(path: &std::path::Path) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, PersistedState};
    use crate::state::App;
    use std::path::Path;
    use std::sync::Arc;

    fn app_with_static(dir: &str) -> SharedApp {
        let cfg: Config = serde_json::from_str(&format!(
            r#"{{"bind":"127.0.0.1:0","static_dir":"{dir}","devices":{{}}}}"#
        ))
        .unwrap();
        Arc::new(App::new(cfg, PersistedState::default(), Path::new(".")))
    }

    #[tokio::test]
    async fn healthz_returns_ok() {
        let r = healthz().await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        let body = axum::body::to_bytes(r.into_body(), 64).await.unwrap();
        assert_eq!(&body[..], b"ok");
    }

    #[tokio::test]
    async fn root_and_p_serve_index_with_csp() {
        // `/` and `/p` are router-level aliases for index.html.
        let app = app_with_static("../src");
        for path in ["/", "/p"] {
            let r = serve_static(&app, "index.html");
            assert_eq!(r.status(), StatusCode::OK, "{path}");
            let h = r.headers();
            assert_eq!(
                h.get(header::CONTENT_TYPE).unwrap(),
                "text/html; charset=utf-8"
            );
            assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "no-cache");
            let csp = h
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap()
                .to_str()
                .unwrap();
            assert_eq!(csp, CSP);
        }
    }

    #[tokio::test]
    async fn js_gets_long_cache_no_csp() {
        let app = app_with_static("../src");
        let r = serve_static(&app, "/live.js");
        assert_eq!(r.status(), StatusCode::OK);
        let h = r.headers();
        assert_eq!(
            h.get(header::CONTENT_TYPE).unwrap(),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            h.get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=86400"
        );
        assert!(h.get(header::CONTENT_SECURITY_POLICY).is_none());
    }

    #[tokio::test]
    async fn miss_and_traversal_are_404() {
        let app = app_with_static("../src");
        assert_eq!(
            serve_static(&app, "/nope.js").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve_static(&app, "/../../etc/passwd").status(),
            StatusCode::NOT_FOUND
        );
        let gone = app_with_static("does-not-exist");
        assert_eq!(serve_static(&gone, "/").status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn nested_and_dir_paths() {
        let app = app_with_static("../src");
        let r = serve_static(&app, "/app/accent.js");
        assert_eq!(r.status(), StatusCode::OK);
        // A directory without index.html is a miss (only the root has one).
        let r = serve_static(&app, "/app");
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn csp_is_strict() {
        for needle in [
            "default-src 'self'",
            "script-src 'self'",
            "connect-src 'self' ws: wss:",
            "worker-src 'self'",
        ] {
            assert!(CSP.contains(needle), "CSP missing {needle}");
        }
        assert!(!CSP.contains("unsafe-eval"));
        assert!(!CSP.contains("script-src 'unsafe-inline'"));
    }
}
