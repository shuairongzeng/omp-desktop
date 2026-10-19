//! relay — a single-binary self-hosted relay for phone ↔ desktop remote
//! control (see docs/architecture/remote-control.md). Serves the phone UI
//! statically and hosts one WebSocket room per desktop.

mod config;
mod frame;
mod http;
mod state;
mod ws;

use state::SharedApp;
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    // Config path: argv[1] or ./relay-config.json.
    let mut args = std::env::args_os();
    let _program = args.next();
    let config_path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("relay-config.json"));

    // Fail fast, clearly. No tokens in any message or log.
    let cfg = match config::Config::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("relay: {e}");
            std::process::exit(1);
        }
    };
    let device_count = cfg.devices.len();
    let bind = cfg
        .bind
        .parse::<std::net::SocketAddr>()
        .unwrap_or_else(|e| {
            eprintln!("relay: invalid bind {:?}: {e}", cfg.bind);
            std::process::exit(1);
        });

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config_dir = config_dir_of(&config_path);
    let persisted = match config::PersistedState::load(&state_file_of(&cfg, &config_dir)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("relay: {e}");
            std::process::exit(1);
        }
    };
    let phone_count: usize = persisted.devices.values().map(|d| d.phones.len()).sum();

    let app: SharedApp = Arc::new(state::App::new(cfg, persisted, &config_dir));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| {
            // Unrecoverable: nothing can run without a reactor.
            eprintln!("relay: cannot start tokio runtime: {e}");
            std::process::exit(1);
        });

    runtime.block_on(async move {
        tracing::info!(
            bind = %app.config.bind,
            devices = device_count,
            paired_phones = phone_count,
            "relay starting (tokens are never logged)"
        );

        let router = ws::router(Arc::clone(&app));

        let listener = tokio::net::TcpListener::bind(bind)
            .await
            .unwrap_or_else(|e| {
                eprintln!("relay: cannot bind {}: {e}", app.config.bind);
                std::process::exit(1);
            });

        // Pair-token sweeper: 1/60s pass removes expired pairings.
        let sweeper = {
            let app = Arc::clone(&app);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    app.prune_expired_pairings().await;
                }
            })
        };

        let addr = listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| app.config.bind.clone());
        tracing::info!(%addr, "relay listening");

        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .unwrap_or_else(|e| {
                eprintln!("relay: server error: {e}");
                std::process::exit(1);
            });

        sweeper.abort();
        // Rooms die with the process; state is saved on every mutation, so
        // nothing needs flushing here.
        tracing::info!("relay stopped");
    });
}

/// Directory of the config file (paths inside it resolve against this).
fn config_dir_of(config_path: &std::path::Path) -> std::path::PathBuf {
    config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Config-relative state file (spec: default `./relay-state.json`).
fn state_file_of(cfg: &config::Config, config_dir: &std::path::Path) -> PathBuf {
    config::resolve_path(
        config_dir,
        cfg.state_file.as_deref().unwrap_or("./relay-state.json"),
    )
}

/// Ctrl-C / SIGTERM → graceful stop.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_of_variants() {
        assert_eq!(
            config_dir_of(std::path::Path::new("/srv/relay-config.json")),
            PathBuf::from("/srv")
        );
        assert_eq!(
            config_dir_of(std::path::Path::new("relay-config.json")),
            PathBuf::from(".")
        );
        assert_eq!(
            config_dir_of(std::path::Path::new("./cfg/relay.json")),
            PathBuf::from("./cfg")
        );
    }

    #[test]
    fn state_file_default_and_override() {
        let dir = PathBuf::from("/srv");
        let cfg: config::Config =
            serde_json::from_str(r#"{"bind":"127.0.0.1:1","devices":{}}"#).unwrap();
        assert_eq!(
            state_file_of(&cfg, &dir),
            PathBuf::from("/srv/relay-state.json")
        );

        let cfg: config::Config = serde_json::from_str(
            r#"{"bind":"127.0.0.1:1","devices":{},"state_file":"./state.json"}"#,
        )
        .unwrap();
        assert_eq!(state_file_of(&cfg, &dir), PathBuf::from("/srv/state.json"));
    }
}
