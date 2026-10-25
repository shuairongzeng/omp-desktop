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
    /// PEM of the relay's TLS certificate, pinned at "trust this server"
    /// (TOFU). Empty = trust the system roots (normal CA-signed relay).
    /// Self-hosted relays on bare IPs run self-signed certs that no system
    /// root accepts; pinning trusts exactly this cert, nothing else.
    pub pinned_cert_pem: String,
    /// Friendly name for this desktop in the phone's device picker. Empty
    /// = fall back to the machine's hostname (`display_name`).
    pub device_name: String,
    /// E2E master secrets by paired phone (`ph` = the phone token's
    /// SHA-256 hex, the same key the relay and the revoke flow use).
    /// `ms` is the b64 32-byte pairing master secret; an entry without
    /// one (or no entry) is a pre-v2 pairing: treated as unpaired, the
    /// UI must ask for a re-pair (`docs/architecture/remote-e2e-contract.md`).
    pub phones: std::collections::BTreeMap<String, PhoneSecret>,
}

/// One phone's E2E material in `remote.json`.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct PhoneSecret {
    /// b64 X25519-derived master secret; `None` = pre-v2 entry.
    pub ms: Option<String>,
}

impl RemoteSettings {
    /// The b64 `ms` stored for phone `ph`, or `None` when the phone is
    /// unknown or paired pre-v2 (both mean "not e2e-paired").
    pub fn phone_ms(&self, ph: &str) -> Option<&str> {
        self.phones.get(ph).and_then(|p| p.ms.as_deref())
    }

    /// DER bytes of the pinned cert, if any.
    pub fn pinned_cert_der(&self) -> Option<Vec<u8>> {
        use base64::Engine;
        let pem = self.pinned_cert_pem.trim();
        if pem.is_empty() {
            return None;
        }
        let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        base64::engine::general_purpose::STANDARD.decode(b64).ok()
    }
}

impl RemoteSettings {
    pub const fn ready(&self) -> bool {
        !self.server.is_empty() && !self.device_id.is_empty() && !self.device_token.is_empty()
    }

    /// The name reported to the relay's `device_info` (the phone's device
    /// picker shows it): the user's choice, else the machine's hostname,
    /// else a generic fallback. Truncated to 80 chars like the relay does.
    pub fn display_name(&self) -> String {
        let chosen = self.device_name.trim();
        let name = if chosen.is_empty() {
            hostname().unwrap_or_else(|| "omp-desktop".to_string())
        } else {
            chosen.to_string()
        };
        name.chars().take(80).collect()
    }

    /// The os tag sent with the name (`std::env::consts::OS`: one of
    /// `windows` / `macos` / `linux` / …; the phone maps it to a label).
    pub const fn os_name() -> &'static str {
        std::env::consts::OS
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
        let base = ws_scheme(self.server.trim().trim_end_matches('/'));
        format!(
            "{base}/ws?role=desktop&device={}&token={}",
            self.device_id, self.device_token
        )
    }
}

/// The server setting as a WebSocket origin: `https:`/`http:` rescheme to
/// `wss:`/`ws:`, an existing `ws(s)://` passes through, a bare host
/// defaults to `wss://`.
fn ws_scheme(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    if let Some(rest) = base.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    if base.starts_with("wss://") || base.starts_with("ws://") {
        return base.to_string();
    }
    format!("wss://{base}")
}

/// What the frontend sees (never the token).
#[derive(Serialize, Clone)]
pub struct RemoteStateView {
    pub enabled: bool,
    pub server: String,
    pub device_id: String,
    pub status: String,
    /// A cert is pinned (TOFU done): the connector trusts exactly that one.
    /// The UI words the trust prompt by it — first trust, or re-trust after
    /// the server's cert changed (a pinned root rejects the new leaf as
    /// unknown-issuer again, so re-pinning is the fix there too).
    pub pinned_cert: bool,
    /// The user's chosen picker name (empty = hostname fallback applies).
    pub device_name: String,
}

/// The machine's hostname from the environment (Windows sets
/// `COMPUTERNAME`, unix shells set `HOSTNAME`) — a display fallback only,
/// so a missing or blank var just falls through to the generic name.
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
        let mut s = RemoteSettings {
            device_id: "aa".into(),
            device_token: "bb".into(),
            server: "https://relay.example.com/".into(),
            ..Default::default()
        };
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
        let mut s = RemoteSettings {
            enabled: true,
            server: "https://relay.example.com".into(),
            ..Default::default()
        };
        s.ensure_identity();
        let bytes = serde_json::to_vec(&s).unwrap();
        let back: RemoteSettings = serde_json::from_slice(&bytes).unwrap();
        assert!(back.enabled && back.ready());

        // An old remote.json without `device_name` *and* without `phones`
        // still loads (serde default): the E2E v2 additions are additive.
        let legacy = br#"{"enabled":true,"server":"https://x","device_id":"aa","device_token":"bb","pinned_cert_pem":""}"#;
        let back: RemoteSettings = serde_json::from_slice(legacy).unwrap();
        assert_eq!(back.device_name, "");
        assert!(back.phones.is_empty());
        assert!(back.ready());

        // A v2 file with one phone's `ms` and one pre-v2 entry without.
        let v2 = br#"{"enabled":true,"server":"https://x","device_id":"aa","device_token":"bb",
            "phones":{"aabb":{"ms":"c2VjcmV0"},"ccdd":{}}}"#;
        let back: RemoteSettings = serde_json::from_slice(v2).unwrap();
        assert_eq!(back.phone_ms("aabb"), Some("c2VjcmV0"));
        assert_eq!(back.phone_ms("ccdd"), None); // pre-v2 entry: no ms
        assert_eq!(back.phone_ms("nobody"), None); // unknown phone
    }

    #[test]
    fn display_name_prefers_choice_then_truncates() {
        let mut s = RemoteSettings {
            device_name: "  My PC  ".into(),
            ..Default::default()
        };
        assert_eq!(s.display_name(), "My PC");
        s.device_name = "x".repeat(200);
        assert_eq!(s.display_name().chars().count(), 80);
        // Empty choice: the env hostname or the generic fallback — always
        // non-empty and within the relay's cap.
        s.device_name = String::new();
        let fallback = s.display_name();
        assert_ne!(fallback.trim(), "");
        assert!(fallback.chars().count() <= 80);
    }

    #[test]
    fn os_name_is_the_std_tag() {
        assert_eq!(RemoteSettings::os_name(), std::env::consts::OS);
        assert_ne!(RemoteSettings::os_name(), "");
    }
}
