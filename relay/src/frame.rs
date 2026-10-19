//! Envelope validation (per-type field checks). The relay never parses
//! payloads beyond the envelope the spec pins, so malformed frames can't be
//! forwarded into the desktop. Unknown `t` values are ignored (forward
//! compatibility).

use serde_json::Value;

/// Classification of an inbound text frame.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// Envelope validated; `t` and `id` extracted.
    Valid(Frame),
    /// Broken JSON or a known type with missing/ill-typed fields.
    Invalid,
    /// Structurally fine, but an unknown `t` (relay ignores it).
    UnknownType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub t: String,
    /// `cmd`/`res` correlation id, when present.
    pub id: Option<u64>,
    /// `pair_grant`/`pair_deny` pair id, when present.
    pub pair_id: Option<String>,
    /// `revoke` phone hash, when present.
    pub phone_hash: Option<String>,
}

/// Envelope rules (`docs/architecture/remote-control.md`):
/// - `t` is a required string.
/// - `cmd` requires string `name` (incl. `sub`/`unsub`, which are ordinary
///   command names to the relay, never special-cased here).
/// - `res` requires integer `id` + boolean `ok`.
/// - `evt` requires string `name`.
/// - `pair_begin`/`list_phones` carry no fields.
/// - `pair_grant`/`pair_deny` require string `pair_id`.
/// - `revoke` requires string `phone_hash`.
pub fn parse(text: &str) -> Inbound {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Inbound::Invalid,
    };
    let Some(obj) = v.as_object() else {
        return Inbound::Invalid;
    };
    let Some(t) = obj.get("t").and_then(Value::as_str) else {
        return Inbound::Invalid;
    };
    let str_field = |k: &str| obj.get(k).and_then(Value::as_str).map(String::from);
    let id = obj.get("id").and_then(Value::as_u64);
    let frame = |t: &str, pair_id: Option<String>, phone_hash: Option<String>| {
        Inbound::Valid(Frame {
            t: t.to_string(),
            id,
            pair_id,
            phone_hash,
        })
    };

    match t {
        "cmd" | "evt" | "sub" | "unsub" => {
            if str_field("name").is_some() {
                frame(t, None, None)
            } else {
                Inbound::Invalid
            }
        }
        "res" => {
            let ok = obj.get("ok").map(Value::is_boolean).unwrap_or(false);
            if ok && id.is_some() {
                frame(t, None, None)
            } else {
                Inbound::Invalid
            }
        }
        "pair_begin" | "list_phones" => frame(t, None, None),
        "pair_grant" | "pair_deny" => match str_field("pair_id") {
            Some(pid) => frame(t, Some(pid), None),
            None => Inbound::Invalid,
        },
        "revoke" => match str_field("phone_hash") {
            Some(h) => frame(t, None, Some(h)),
            None => Inbound::Invalid,
        },
        _ => Inbound::UnknownType,
    }
}

/// `{"t":"res","ok":false,"error":"desktop offline"}` — the fast-fail a
/// phone gets for a cmd sent while no desktop is in the room.
pub fn res_offline(id: Option<u64>) -> String {
    emit::res(id, false, Some("desktop offline"))
}

/// Insert `"from":"<conn_id>"` into a frame's top-level object (phone →
/// desktop tagging for subscription refcounting). Desktop → phone frames
/// are never tagged.
pub fn tag_from(text: &str, conn_id: &str) -> String {
    let mut v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return text.to_string(),
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("from".to_string(), Value::String(conn_id.to_string()));
        serde_json::to_string(&v).unwrap_or_else(|_| text.to_string())
    } else {
        text.to_string()
    }
}

/// Frames the relay itself emits.
pub mod emit {
    use super::Value;

    fn json(v: Value) -> String {
        v.to_string()
    }

    pub fn res(id: Option<u64>, ok: bool, error: Option<&str>) -> String {
        json(serde_json::json!({"t":"res","id":id,"ok":ok,"error":error}))
    }

    /// Oversize drop notice to the sender only.
    pub fn dropped_oversize(id: Option<u64>) -> String {
        json(serde_json::json!({"t":"dropped","reason":"oversize","id":id}))
    }

    pub fn pair_code(code: &str, url: &str) -> String {
        json(serde_json::json!({"t":"pair_code","code":code,"url":url}))
    }

    pub fn pair_request(pair_id: &str, agent: &str) -> String {
        json(serde_json::json!({"t":"pair_request","pair_id":pair_id,"agent":agent}))
    }

    pub fn paired(device: &str, token: &str) -> String {
        json(serde_json::json!({"t":"paired","device":device,"token":token}))
    }

    pub fn pair_denied() -> String {
        json(serde_json::json!({"t":"pair_denied"}))
    }

    /// `peer` frame → phones: desktop presence.
    pub fn peer_desktop(online: bool) -> String {
        json(serde_json::json!({"t":"peer","desktop":online}))
    }

    /// `peer` frame → desktop: per-phone presence (subscription refcount).
    pub fn peer_phone(conn_id: &str, name: &str, online: bool) -> String {
        json(serde_json::json!({"t":"peer","phone":conn_id,"name":name,"online":online}))
    }

    pub fn revoked(phone_hash: &str) -> String {
        json(serde_json::json!({"t":"revoked","phone_hash":phone_hash}))
    }

    pub fn phones(list: &[crate::state::PhoneRow]) -> String {
        json(serde_json::json!({"t":"phones","list":list}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_envelopes() {
        let cases = [
            r#"{"t":"cmd","id":42,"name":"send_command","args":{"a":1}}"#,
            r#"{"t":"cmd","name":"sub","args":{"name":"agent://line/1"}}"#,
            r#"{"t":"cmd","name":"unsub","args":{}}"#,
            r#"{"t":"sub","name":"agent://line/1"}"#,
            r#"{"t":"unsub","name":"agent://line/1"}"#,
            r#"{"t":"res","id":42,"ok":true,"value":1}"#,
            r#"{"t":"res","id":42,"ok":false,"error":"x"}"#,
            r#"{"t":"evt","name":"agent://line/1","payload":{"deep":[1]}}"#,
            r#"{"t":"pair_begin"}"#,
            r#"{"t":"pair_grant","pair_id":"ab"}"#,
            r#"{"t":"pair_deny","pair_id":"ab"}"#,
            r#"{"t":"revoke","phone_hash":"h"}"#,
            r#"{"t":"list_phones"}"#,
        ];
        for c in cases {
            assert!(matches!(parse(c), Inbound::Valid(_)), "{c} must parse");
        }
    }

    #[test]
    fn parse_extracts_fields() {
        let Inbound::Valid(f) = parse(r#"{"t":"cmd","id":42,"name":"send_command"}"#) else {
            panic!();
        };
        assert_eq!(f.t, "cmd");
        assert_eq!(f.id, Some(42));
        assert_eq!(f.pair_id, None);

        let Inbound::Valid(f) = parse(r#"{"t":"pair_grant","pair_id":"xyz"}"#) else {
            panic!();
        };
        assert_eq!(f.pair_id.as_deref(), Some("xyz"));

        let Inbound::Valid(f) = parse(r#"{"t":"revoke","phone_hash":"h1"}"#) else {
            panic!();
        };
        assert_eq!(f.phone_hash.as_deref(), Some("h1"));
    }

    #[test]
    fn parse_invalid_envelopes() {
        let cases = [
            "not json",
            "[]",
            "3",
            "{}",
            r#"{"t":1}"#,
            r#"{"id":1}"#,
            r#"{"t":"cmd"}"#,
            r#"{"t":"cmd","id":1,"name":2}"#,
            r#"{"t":"res","id":1}"#,
            r#"{"t":"res","ok":true}"#,
            r#"{"t":"res","ok":"yes","id":1}"#,
            r#"{"t":"evt"}"#,
            r#"{"t":"evt","name":5}"#,
            r#"{"t":"pair_grant"}"#,
            r#"{"t":"pair_deny","pair_id":1}"#,
            r#"{"t":"revoke"}"#,
            r#"{"t":"sub"}"#,
            r#"{"t":"unsub","name":null}"#,
        ];
        for c in cases {
            assert!(
                !matches!(parse(c), Inbound::Valid(_)),
                "{c} must be invalid"
            );
        }
    }

    #[test]
    fn unknown_type_reported() {
        assert_eq!(parse(r#"{"t":"future_frame","x":1}"#), Inbound::UnknownType);
        // Missing t is Invalid, not Unknown
        assert_eq!(parse(r#"{"x":1}"#), Inbound::Invalid);
    }

    #[test]
    fn offline_res_shape() {
        let v: Value = serde_json::from_str(&res_offline(Some(7))).unwrap();
        assert_eq!(v["t"], "res");
        assert_eq!(v["id"], 7);
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "desktop offline");

        let v: Value = serde_json::from_str(&res_offline(None)).unwrap();
        assert!(v["id"].is_null());
    }

    #[test]
    fn dropped_oversize_shape() {
        let v: Value = serde_json::from_str(&emit::dropped_oversize(Some(9))).unwrap();
        assert_eq!(v["t"], "dropped");
        assert_eq!(v["reason"], "oversize");
        assert_eq!(v["id"], 9);
        let v: Value = serde_json::from_str(&emit::dropped_oversize(None)).unwrap();
        assert!(v["id"].is_null());
    }

    #[test]
    fn tag_from_adds_conn_id() {
        let out = tag_from(
            r#"{"t":"cmd","id":5,"name":"send_command","args":{"a":1}}"#,
            "ab12",
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["from"], "ab12");
        assert_eq!(v["t"], "cmd");
        assert_eq!(v["id"], 5);
        assert_eq!(v["name"], "send_command");
        // payload untouched
        assert_eq!(v["args"]["a"], 1);
    }

    #[test]
    fn tag_from_edge_cases() {
        // Invalid JSON: passthrough (never invent a frame).
        assert_eq!(tag_from("oops", "x"), "oops");
        // Non-object: passthrough.
        assert_eq!(tag_from("[1,2]", "x"), "[1,2]");
    }

    #[test]
    fn emit_shapes() {
        let v: Value = serde_json::from_str(&emit::peer_desktop(true)).unwrap();
        assert_eq!(v["t"], "peer");
        assert_eq!(v["desktop"], true);

        let v: Value = serde_json::from_str(&emit::peer_phone("c1", "Pixel", false)).unwrap();
        assert_eq!(v["phone"], "c1");
        assert_eq!(v["name"], "Pixel");
        assert_eq!(v["online"], false);

        let v: Value = serde_json::from_str(&emit::revoked("deadbeef")).unwrap();
        assert_eq!(v["t"], "revoked");
        assert_eq!(v["phone_hash"], "deadbeef");

        let v: Value = serde_json::from_str(&emit::paired("dev1", "tok1")).unwrap();
        assert_eq!(v["t"], "paired");
        assert_eq!(v["device"], "dev1");
        assert_eq!(v["token"], "tok1");

        let v: Value =
            serde_json::from_str(&emit::pair_code("ABCD-1234", "https://h/p#tok")).unwrap();
        assert_eq!(v["code"], "ABCD-1234");
        assert_eq!(v["url"], "https://h/p#tok");

        let v: Value = serde_json::from_str(&emit::pair_request("pid", "iPhone UA")).unwrap();
        assert_eq!(v["pair_id"], "pid");
        assert_eq!(v["agent"], "iPhone UA");

        let v: Value = serde_json::from_str(&emit::pair_denied()).unwrap();
        assert_eq!(v["t"], "pair_denied");

        let list = vec![
            crate::state::PhoneRow {
                hash: "h1".into(),
                name: "a".into(),
                paired_at: 1,
            },
            crate::state::PhoneRow {
                hash: "h2".into(),
                name: "b".into(),
                paired_at: 2,
            },
        ];
        let v: Value = serde_json::from_str(&emit::phones(&list)).unwrap();
        assert_eq!(v["t"], "phones");
        assert_eq!(v["list"][0]["hash"], "h1");
        assert_eq!(v["list"][1]["name"], "b");
        assert_eq!(v["list"][1]["paired_at"], 2);
    }
}
