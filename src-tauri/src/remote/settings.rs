//! The connector's persisted settings (`<app config>/remote.json`).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct RemoteSettings {
    pub enabled: bool,
    /// Anything from `https://relay.example.com` to `wss://host:8787`.
    pub server: String,
    pub device_id: String,
    /// Cleartext local credential; the relay stores only its SHA-256.
    pub device_token: String,
}

impl RemoteSettings {
    pub fn ready(&self) -> bool {
        !self.server.is_empty() && !self.device_id.is_empty() && !self.device_token.is_empty()
    }

    pub fn ensure_identity(&mut self) {
        if self.device_id.is_empty() {
            self.device_id = random_hex();
        }
        if self.device_token.is_empty() {
            self.device_token = random_hex();
        }
    }

    /// The desktop's room URL on the relay. Both id and token are hex, so
    /// they need no percent-encoding in the query string.
    pub fn ws_url(&self) -> String {
        let base = self.server.trim().trim_end_matches('/');
        let base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if base.starts_with("wss://") || base.starts_with("ws://") {
            base.to_string()
        } else {
            format!("wss://{base}")
        };
        format!(
            "{base}/ws?role=desktop&device={}&token={}",
            self.device_id, self.device_token
        )
    }
}

/// What the frontend sees (never the token).
#[derive(Serialize, Clone)]
pub struct RemoteStateView {
    pub enabled: bool,
    pub server: String,
    pub device_id: String,
    pub status: String,
}

/// 256 bits of OS randomness as hex (device id, device token).
pub fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return String::new();
    }
    crate::json_store::hex_lower(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_normalizes_schemes() {
        let mut s = RemoteSettings::default();
        s.device_id = "aa".into();
        s.device_token = "bb".into();
        s.server = "https://relay.example.com/".into();
        assert_eq!(
            s.ws_url(),
            "wss://relay.example.com/ws?role=desktop&device=aa&token=bb"
        );
        s.server = "http://127.0.0.1:8787".into();
        assert!(s.ws_url().starts_with("ws://127.0.0.1:8787/ws"));
        s.server = "relay.example.com".into();
        assert!(s.ws_url().starts_with("wss://relay.example.com/ws"));
        s.server = "wss://already.example.com".into();
        assert!(s.ws_url().starts_with("wss://already.example.com/ws"));
    }

    #[test]
    fn ready_requires_all_three() {
        let mut s = RemoteSettings::default();
        assert!(!s.ready());
        s.server = "https://x".into();
        assert!(!s.ready());
        s.ensure_identity();
        assert!(s.ready());
        assert_eq!(s.device_id.len(), 64);
        assert_eq!(s.device_token.len(), 64);
        // Idempotent: a second call keeps the identity.
        let id = s.device_id.clone();
        s.ensure_identity();
        assert_eq!(s.device_id, id);
    }

    #[test]
    fn settings_roundtrip_via_json() {
        let mut s = RemoteSettings::default();
        s.enabled = true;
        s.server = "https://relay.example.com".into();
        s.ensure_identity();
        let bytes = serde_json::to_vec(&s).unwrap();
        let back: RemoteSettings = serde_json::from_slice(&bytes).unwrap();
        assert!(back.enabled && back.ready());
    }
}
