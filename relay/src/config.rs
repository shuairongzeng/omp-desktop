//! Config + persisted state, and the small pure helpers (path safety,
//! content types, phone-name truncation) shared by the HTTP and WS modules.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Seconds a pair token stays valid and the desktop has to decide.
pub const PAIR_TTL_SECS: u64 = 300;

/// Fail-fast `main` error: a String, printed with the config path context.
pub type LoadError = String;

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub bind: String,
    #[serde(default)]
    pub static_dir: Option<String>,
    pub devices: HashMap<String, String>,
    #[serde(default)]
    pub state_file: Option<String>,
}

impl Config {
    /// Read + parse `relay-config.json`; every failure is a clear message
    /// naming the file. Device values are validated as sha256-hex so a
    /// mis-hexed token can never silently fail every auth attempt.
    pub fn load(path: &Path) -> Result<Self, LoadError> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read config {}: {e}", path.display()))?;
        let cfg: Config = serde_json::from_str(&raw)
            .map_err(|e| format!("invalid config {}: {e}", path.display()))?;
        for (id, hash) in &cfg.devices {
            if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!(
                    "config {}: device {id} token hash must be 64 hex chars (sha256 of the device token)",
                    path.display()
                ));
            }
        }
        if let Err(e) = cfg.bind.parse::<std::net::SocketAddr>() {
            return Err(format!(
                "config {}: bind {:?} is not a valid socket address: {e}",
                path.display(),
                cfg.bind
            ));
        }
        Ok(cfg)
    }
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub struct PhoneEntry {
    pub name: String,
    pub paired_at: i64,
}

/// The desktop's self-reported identity (`device_info` frame on connect):
/// what the phone's device picker shows instead of a 64-hex room id.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub name: String,
    #[serde(default)]
    pub os: String,
}

/// `relay-state.json`: phones ever paired, per device. The device token
/// hashes live in the config file; state only tracks phones.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct PersistedState {
    #[serde(default)]
    pub devices: HashMap<String, DeviceState>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct DeviceState {
    /// sha256-hex of phone token → name/paired_at.
    #[serde(default)]
    pub phones: HashMap<String, PhoneEntry>,
    /// The desktop's latest self-reported name/os (its `device_info`
    /// frame); what a joining phone's picker row shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<DeviceInfo>,
}

impl PersistedState {
    /// Missing file is fine (first boot). Present-but-invalid is fatal.
    pub fn load(path: &Path) -> Result<Self, LoadError> {
        let raw = match std::fs::read_to_string(path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("cannot read state file {}: {e}", path.display())),
        };
        serde_json::from_str(&raw)
            .map_err(|e| format!("invalid state file {}: {e}", path.display()))
    }

    /// Atomic write: tmp file beside the target, then rename over it.
    pub fn save(&self, path: &Path) -> Result<(), LoadError> {
        let body =
            serde_json::to_string_pretty(self).map_err(|e| format!("serialize state: {e}"))?;
        write_atomic(path, body.as_bytes())
    }
}

/// Atomic file write: `path`'s parent is created if needed, bytes land in
/// `<path>.tmp` in the same directory, then rename replaces the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), LoadError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
    }
    let mut tmp = path.to_path_buf();
    tmp.set_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))
}

/// `sha256(token)` as lowercase hex — the credential digest used by config
/// device tokens, phone token persistence, and revocation.
pub fn sha256_hex(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Resolve `raw` against `base`: absolute paths (and Windows drive paths)
/// win, everything else is joined onto `base` and lexically normalized.
pub fn resolve_path(base: &Path, raw: &str) -> PathBuf {
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        base.join(raw_path)
    };
    normalize(&joined)
}

/// Lexical normalization (no fs access): resolves `.` and `..`, keeps
/// Windows prefixes.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve a request path (already percent-decoded) inside `root`.
/// Returns `None` when the path escapes `root` — the caller answers 404,
/// not 403, so probing learns nothing.
pub fn safe_join(root: &Path, req_path: &str) -> Option<PathBuf> {
    // Request paths are URL paths: split on `/` (and `\`, the classic
    // Windows confusion trick), reject `..`, then append to the root. The
    // root itself is never re-parsed, so its own prefix/root components
    // survive untouched.
    let rel = req_path.trim_start_matches('/');
    if rel.starts_with('/') || rel.starts_with('\\') {
        return None;
    }
    let mut out = root.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s => {
                if s.contains('\0') {
                    return None;
                }
                // Percent-decoding happened upstream (axum's Uri); a
                // non-UTF-8 segment can't arrive via &str.
                out.push(s);
            }
        }
    }
    Some(out)
}

/// Content type by extension (no mime crate needed).
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// `Cache-Control`: everything revalidates every load. HTML because the
/// shim ships in it, and JS/CSS because the `?v=` stamp only changes with
/// the app *version* — a same-version redeploy (a fix to the phone page)
/// used to strand phones on the old scripts for a day. Revalidation is
/// cheap: `serve_file` answers 304 from the etag when nothing changed.
pub fn cache_control_for(_path: &Path) -> &'static str {
    "no-cache"
}

/// Display strings (phone names, device names) are truncated to 80 chars.
pub fn truncate_display(raw: &str) -> String {
    raw.chars().take(80).collect()
}

/// Phone display name: User-Agent truncated to 80 chars. The fallback
/// when a phone supplies no friendly name in the WS query.
pub fn phone_name(ua: &str) -> String {
    truncate_display(ua)
}

/// Max chars for a phone's query-supplied friendly name (WS `&name=`).
pub const PHONE_NAME_MAX_CHARS: usize = 60;

/// Clean a phone-supplied friendly name (the WS query `&name=`): strip
/// control characters, trim, cap at 60 chars. `None` when absent or
/// nothing usable remains — the caller falls back to the UA-derived
/// name ([`phone_name`]).
pub fn clean_phone_name(raw: Option<&str>) -> Option<String> {
    let cleaned: String = raw?
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(PHONE_NAME_MAX_CHARS)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn sha256_hex_matches_reference() {
        // echo -n abc | sha256sum
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex("change-me-desktop-token"),
            "782920e555444d744e919f36bb885730f42b2e951f02d89407d421ab536106d8"
        );
        assert_eq!(sha256_hex("").len(), 64);
    }

    #[test]
    fn safe_join_basics() {
        let root = Path::new("/srv/static");
        assert_eq!(
            safe_join(root, "/index.html").unwrap(),
            PathBuf::from("/srv/static/index.html")
        );
        assert_eq!(
            safe_join(root, "/app/accent.js").unwrap(),
            PathBuf::from("/srv/static/app/accent.js")
        );
        assert_eq!(safe_join(root, "/").unwrap(), PathBuf::from("/srv/static"));
        assert_eq!(
            safe_join(root, "//a.js").unwrap(),
            PathBuf::from("/srv/static/a.js")
        );
        // `.` segments collapse; `..` is rejected outright (see below)
        assert_eq!(
            safe_join(root, "/./app/index.html").unwrap(),
            PathBuf::from("/srv/static/app/index.html")
        );
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let root = Path::new("/srv/static");
        for bad in [
            "/../etc/passwd",
            "/a/../../etc",
            "/a/b/../../../etc",
            "/..",
            "/a/..",
            "/..\\etc",
            "/a\\..\\..",
            "\\..\\etc",
            "/a\u{0}b",
        ] {
            assert!(safe_join(root, bad).is_none(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn safe_join_windows_root() {
        // On Windows, `/x` joining an absolute `C:\root` path stays inside.
        // The containment and the joined tail hold on every platform; only
        // the separator inside the root differs (on Unix `C:\srv\static` is
        // one relative component, so the tail joins with `/`).
        let root = Path::new("C:\\srv\\static");
        let out = safe_join(root, "/app/accent.js").unwrap();
        assert!(out.starts_with(root), "{out:?} must stay under {root:?}");
        assert_eq!(
            out.strip_prefix(root).unwrap(),
            Path::new("app").join("accent.js")
        );
    }

    #[test]
    fn content_types() {
        assert_eq!(
            content_type_for(Path::new("a.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("a.JS")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("x.woff2")), "font/woff2");
        assert_eq!(content_type_for(Path::new("x")), "application/octet-stream");
        assert_eq!(content_type_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type_for(Path::new("a.MAP")), "application/json");
        assert_eq!(content_type_for(Path::new("a.webp")), "image/webp");
        assert_eq!(
            content_type_for(Path::new("noext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn cache_control() {
        assert_eq!(cache_control_for(Path::new("i.html")), "no-cache");
        assert_eq!(cache_control_for(Path::new("i.HTM")), "no-cache");
        // JS/CSS revalidate too: the ?v= stamp only changes with the app
        // version, so a same-version redeploy must not strand phones.
        assert_eq!(cache_control_for(Path::new("app.js")), "no-cache");
    }

    #[test]
    fn phone_name_truncates_80_chars() {
        assert_eq!(phone_name(""), "");
        assert_eq!(phone_name("iPhone Safari"), "iPhone Safari");
        let long = "x".repeat(200);
        assert_eq!(phone_name(&long).chars().count(), 80);
        // Multi-byte safe: truncation at 80 *chars*, not bytes.
        let wide = "你".repeat(100);
        assert_eq!(phone_name(&wide).chars().count(), 80);
    }

    #[test]
    fn clean_phone_name_strips_and_truncates() {
        // None / empty / blank → None (caller falls back to the UA name).
        assert_eq!(clean_phone_name(None), None);
        assert_eq!(clean_phone_name(Some("")), None);
        assert_eq!(clean_phone_name(Some("   ")), None);
        // Control characters are stripped, surrounding whitespace trimmed.
        assert_eq!(
            clean_phone_name(Some("Pixel\u{7}\u{1b} 8")),
            Some("Pixel 8".into())
        );
        // Caps at 60 chars (chars, not bytes).
        assert_eq!(
            clean_phone_name(Some(&"x".repeat(80))).as_deref(),
            Some("x".repeat(60).as_str())
        );
        let wide = clean_phone_name(Some(&"你".repeat(100)));
        assert_eq!(wide.as_deref(), Some("你".repeat(60).as_str()));
        // Only control characters → nothing usable after cleaning.
        assert_eq!(clean_phone_name(Some("\u{1}\u{2}")), None);
        // Trim survives: the name is still used.
        assert_eq!(
            clean_phone_name(Some("  Android 14  ")),
            Some("Android 14".into())
        );
    }

    #[test]
    fn config_load_ok_and_errors() {
        let dir = tempdir();
        let p = dir.join("cfg.json");
        std::fs::write(
            &p,
            r#"{"bind":"127.0.0.1:8787","static_dir":"../src","devices":{"d1":"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"},"state_file":"./s.json"}"#,
        )
        .unwrap();
        let cfg = Config::load(&p).unwrap();
        assert_eq!(cfg.bind, "127.0.0.1:8787");
        assert_eq!(cfg.devices.len(), 1);
        assert_eq!(cfg.static_dir.as_deref(), Some("../src"));

        // Bad hash → clear error naming the device
        std::fs::write(&p, r#"{"bind":"127.0.0.1:1","devices":{"d1":"nothex"}}"#).unwrap();
        let err = Config::load(&p).unwrap_err();
        assert!(err.contains("d1") && err.contains("64 hex"), "{err}");

        // Bad bind
        std::fs::write(&p, r#"{"bind":"nope","devices":{}}"#).unwrap();
        assert!(Config::load(&p).unwrap_err().contains("bind"));

        // Unknown field rejected
        std::fs::write(&p, r#"{"bind":"127.0.0.1:1","devices":{},"oops":1}"#).unwrap();
        assert!(Config::load(&p).unwrap_err().contains("oops"));

        // Missing devices
        std::fs::write(&p, r#"{"bind":"127.0.0.1:1"}"#).unwrap();
        assert!(Config::load(&p).is_err());

        // Unreadable file
        let missing = dir.join("missing.json");
        let err = Config::load(&missing).unwrap_err();
        assert!(err.contains("missing.json"), "{err}");

        // Invalid JSON
        std::fs::write(&p, "nope{").unwrap();
        assert!(Config::load(&p).unwrap_err().contains("invalid config"));
    }

    #[test]
    fn config_optional_fields() {
        let dir = tempdir();
        let p = dir.join("cfg.json");
        std::fs::write(&p, r#"{"bind":"127.0.0.1:1","devices":{}}"#).unwrap();
        let cfg = Config::load(&p).unwrap();
        assert!(cfg.static_dir.is_none());
        assert!(cfg.state_file.is_none());
    }

    #[test]
    fn state_roundtrip_and_errors() {
        let dir = tempdir();
        let p = dir.join("state.json");

        // Missing → default
        assert!(PersistedState::load(&p).unwrap().devices.is_empty());

        let mut s = PersistedState::default();
        s.devices
            .entry("dev1".to_string())
            .or_default()
            .phones
            .insert(
                "hash1".to_string(),
                PhoneEntry {
                    name: "Pixel".into(),
                    paired_at: 123,
                },
            );
        s.save(&p).unwrap();
        let loaded = PersistedState::load(&p).unwrap();
        assert_eq!(loaded.devices["dev1"].phones["hash1"].name, "Pixel");
        assert_eq!(loaded.devices["dev1"].phones["hash1"].paired_at, 123);
        assert_eq!(loaded.devices["dev1"].info, None);

        // The desktop's self-reported info round-trips too.
        s.devices.get_mut("dev1").unwrap().info = Some(DeviceInfo {
            name: "My PC".into(),
            os: "windows".into(),
        });
        s.save(&p).unwrap();
        let loaded = PersistedState::load(&p).unwrap();
        assert_eq!(
            loaded.devices["dev1"].info,
            Some(DeviceInfo {
                name: "My PC".into(),
                os: "windows".into()
            })
        );

        // Unreadable
        std::fs::write(&p, "not json").unwrap();
        let err = PersistedState::load(&p).unwrap_err();
        assert!(err.contains("state.json"), "{err}");

        // Directory-blocking permission error surfaces as message
        let bad = dir.join("sub").join("state.json");
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("state.json.tmp"), "x").unwrap();
        std::fs::create_dir(&bad).unwrap(); // state.json IS a directory
        let err = PersistedState::default().save(&bad).unwrap_err();
        assert!(err.contains("state.json"), "{err}");
    }

    #[test]
    fn state_save_creates_parents_and_no_tmp_left() {
        let dir = tempdir();
        let p = dir.join("nested").join("deep").join("state.json");
        PersistedState::default().save(&p).unwrap();
        assert!(p.exists());
        assert!(!dir
            .join("nested")
            .join("deep")
            .join("state.json.tmp")
            .exists());
        let n: usize = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(n, 1);
    }

    #[test]
    fn resolve_path_cases() {
        let base = Path::new("/srv/relay");
        assert_eq!(resolve_path(base, "./s"), PathBuf::from("/srv/relay/s"));
        assert_eq!(resolve_path(base, "../src"), PathBuf::from("/srv/src"));
        assert_eq!(
            resolve_path(base, "s.json"),
            PathBuf::from("/srv/relay/s.json")
        );
        if cfg!(windows) {
            assert_eq!(resolve_path(base, "C:/abs"), PathBuf::from("C:/abs"));
        } else {
            assert_eq!(resolve_path(base, "/abs"), PathBuf::from("/abs"));
        }
    }

    /// Minimal temp dir (no tempfile dep).
    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "relay-cfg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
