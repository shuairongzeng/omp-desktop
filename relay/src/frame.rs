//! Envelope validation (per-type field checks). The relay never parses
//! payloads beyond the envelope the spec pins, so malformed frames can't be
//! forwarded into the desktop. Unknown `t` values are ignored (forward
//! compatibility).
//!
//! E2E note (`docs/architecture/remote-e2e-contract.md`): the `enc` frame's
//! `d` field is ciphertext and stays opaque end to end; the relay checks
//! only that it is a string. Same for the public keys riding `hs` and the
//! `pair_*` frames — pass-through, never inspected.

use serde_json::Value;

/// Classification of an inbound text frame. The valid payload is boxed:
/// the two E2E passthrough fields (`pk`, `to`) grew `Frame` past the
/// point where a stack copy per parse is free.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// Envelope validated; `t` and `id` extracted.
    Valid(Box<Frame>),
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
    /// `device_info` display name (required there; `cmd`/`evt` carry their
    /// own `name` in the verbatim payload, never extracted here).
    pub name: Option<String>,
    /// `device_info` os tag, when present.
    pub os: Option<String>,
    /// Top-level `from` (the sender's connection id), when present. The
    /// relay tags phone→desktop `cmd`/`enc` frames with it; a desktop `res`
    /// may echo it back for unicast routing.
    pub from: Option<String>,
    /// `enc`/`hs`/`pair_*` public key passthrough (base64; opaque to the
    /// relay — only the envelope is checked, never the key material).
    pub pk: Option<String>,
    /// `enc`/`hs` unicast target connection id (desktop→phone routing),
    /// when present.
    pub to: Option<String>,
}

/// Envelope rules (`docs/architecture/remote-e2e-contract.md`):
/// - `t` is a required string.
/// - `cmd` requires string `name` (incl. `sub`/`unsub`, which are ordinary
///   command names to the relay, never special-cased here).
/// - `res` requires integer `id` + boolean `ok`.
/// - `evt` requires string `name`.
/// - `pair_begin`/`list_phones` carry no fields.
/// - `pair_grant`/`pair_deny` require string `pair_id`; `pair_grant` may
///   carry an optional string `pk` (the desktop's E2E pairing key).
/// - `revoke` requires string `phone_hash`.
/// - `device_info` requires string `name`; string `os` is optional.
/// - `hello` carries `v` + `caps` with no required fields (the relay and
///   desktop peers announce capabilities; the relay never parses `caps`).
/// - `pair_hello` (phone, on the pre-auth pair socket) requires string
///   `pk` (the phone's E2E pairing key).
/// - `hs` requires string `pk` + string `mac`; integer `v` and string `ph`
///   are optional.
/// - `enc` requires integer `seq` + string `d`; string `to` is optional
///   (desktop→phone unicast). The relay never parses the ciphertext.
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
    let from = str_field("from");
    let pk = str_field("pk");
    let to = str_field("to");
    let frame = |t: &str, pair_id: Option<String>, phone_hash: Option<String>| {
        Inbound::Valid(Box::new(Frame {
            t: t.to_string(),
            id,
            pair_id,
            phone_hash,
            name: None,
            os: None,
            from: from.clone(),
            pk: pk.clone(),
            to: to.clone(),
        }))
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
        // The desktop's display identity: `name` is required (an empty one
        // is the caller's business), `os` optional.
        "device_info" => match str_field("name") {
            Some(n) => Inbound::Valid(Box::new(Frame {
                t: t.to_string(),
                id,
                pair_id: None,
                phone_hash: None,
                name: Some(n),
                os: str_field("os"),
                from,
                pk,
                to,
            })),
            None => Inbound::Invalid,
        },
        // Capability handshake: the relay sends one on every join, the
        // desktop broadcasts one on connect. `v`/`caps` are opaque to the
        // relay (peers decide what to make of them).
        "hello" => frame(t, None, None),
        // E2E pairing key announcement (phone, pre-auth pair socket): the
        // string `pk` (the phone's X25519 public key) is required.
        "pair_hello" => match str_field("pk") {
            Some(_) => frame(t, None, None),
            None => Inbound::Invalid,
        },
        // E2E per-connection session handshake. `pk`+`mac` must be
        // strings; `v`/`ph` are not envelope-required (the endpoints
        // validate them).
        "hs" => match (str_field("pk"), str_field("mac")) {
            (Some(_), Some(_)) => frame(t, None, None),
            _ => Inbound::Invalid,
        },
        // E2E encrypted envelope. `seq` must be a non-negative integer and
        // `d` a string; the payload itself is never parsed. `to` (string)
        // is the optional desktop→phone unicast target.
        "enc" => match (obj.get("seq").and_then(Value::as_u64), str_field("d")) {
            (Some(_), Some(_)) => frame(t, None, None),
            _ => Inbound::Invalid,
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

    /// Capabilities the relay announces in its join-time `hello` frame:
    /// `res-unicast` (a `res` carrying `from` goes only to that phone),
    /// `transcript-window` (windowed get_messages is the norm), `hello`
    /// (this handshake itself exists).
    pub const RELAY_CAPS: [&str; 3] = ["res-unicast", "transcript-window", "hello"];

    fn json(v: Value) -> String {
        v.to_string()
    }

    pub fn res(id: Option<u64>, ok: bool, error: Option<&str>) -> String {
        json(serde_json::json!({"t":"res","id":id,"ok":ok,"error":error}))
    }

    /// The relay's own capability announcement, sent to every client on
    /// join: `{"t":"hello","v":1,"caps":["res-unicast","transcript-window","hello"]}`.
    pub fn hello() -> String {
        json(serde_json::json!({"t":"hello","v":1,"caps":RELAY_CAPS}))
    }

    /// Oversize drop notice to the sender only.
    pub fn dropped_oversize(id: Option<u64>) -> String {
        json(serde_json::json!({"t":"dropped","reason":"oversize","id":id}))
    }

    pub fn pair_code(code: &str, url: &str) -> String {
        json(serde_json::json!({"t":"pair_code","code":code,"url":url}))
    }

    /// Phone wants in (forwarded to the desktop). `pk` — the phone's E2E
    /// pairing key from its `pair_hello` — rides along when present.
    pub fn pair_request(pair_id: &str, agent: &str, pk: Option<&str>) -> String {
        json(serde_json::json!({"t":"pair_request","pair_id":pair_id,"agent":agent,"pk":pk}))
    }

    /// Grant verdict → the pairing phone. `pk` — the desktop's E2E pairing
    /// key from its `pair_grant` — rides along when present.
    pub fn paired(device: &str, token: &str, pk: Option<&str>) -> String {
        json(serde_json::json!({"t":"paired","device":device,"token":token,"pk":pk}))
    }

    /// Post-grant notice → the desktop, right after `paired` went to the
    /// phone: `ph` (sha256-hex of the fresh phone token) is the key the
    /// desktop stores its per-phone master secret under.
    pub fn pair_done(pair_id: &str, ph: &str) -> String {
        json(serde_json::json!({"t":"pair_done","pair_id":pair_id,"ph":ph}))
    }

    pub fn pair_denied() -> String {
        json(serde_json::json!({"t":"pair_denied"}))
    }

    /// `peer` frame → phones: desktop presence.
    pub fn peer_desktop(online: bool) -> String {
        json(serde_json::json!({"t":"peer","desktop":online}))
    }

    /// `device` frame → phones: the room desktop's display identity
    /// (persisted from its `device_info`; sent on join and on change).
    pub fn device(name: &str, os: &str) -> String {
        json(serde_json::json!({"t":"device","name":name,"os":os}))
    }

    /// `peer` frame → desktop: per-phone presence. `phone` and `conn` both
    /// carry the routing connection id (v2 endpoints key on `conn`; `phone`
    /// stays for the v1 desktop); `ph` is the phone's token hash so the
    /// desktop can map connections to per-phone master secrets.
    pub fn peer_phone(conn_id: &str, name: &str, online: bool, ph: Option<&str>) -> String {
        json(serde_json::json!({"t":"peer","phone":conn_id,"conn":conn_id,"name":name,"online":online,"ph":ph}))
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
            r#"{"t":"pair_grant","pair_id":"ab","pk":"ZGVzay1way0wMDA="}"#,
            r#"{"t":"pair_deny","pair_id":"ab"}"#,
            r#"{"t":"revoke","phone_hash":"h"}"#,
            r#"{"t":"list_phones"}"#,
            r#"{"t":"device_info","name":"My PC"}"#,
            r#"{"t":"device_info","name":"My PC","os":"windows"}"#,
            r#"{"t":"hello","v":1,"caps":["res-unicast","transcript-window","hello"]}"#,
            r#"{"t":"hello"}"#,
            r#"{"t":"pair_hello","pk":"cGhvbmUtcGstMDAwMDA="}"#,
            r#"{"t":"hs","v":2,"ph":"aabb…","pk":"b64","mac":"b64"}"#,
            r#"{"t":"hs","pk":"b64","mac":"b64"}"#,
            r#"{"t":"enc","seq":0,"d":"AAECAwQ="}"#,
            r#"{"t":"enc","seq":7,"d":"AAECAwQ=","to":"1a2b3c4d"}"#,
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

        let Inbound::Valid(f) = parse(r#"{"t":"device_info","name":"My PC","os":"windows"}"#)
        else {
            panic!();
        };
        assert_eq!(f.name.as_deref(), Some("My PC"));
        assert_eq!(f.os.as_deref(), Some("windows"));

        // `os` is optional.
        let Inbound::Valid(f) = parse(r#"{"t":"device_info","name":"My PC"}"#) else {
            panic!();
        };
        assert_eq!(f.name.as_deref(), Some("My PC"));
        assert_eq!(f.os, None);

        // A `cmd`'s `name` is payload, never extracted into the envelope.
        let Inbound::Valid(f) = parse(r#"{"t":"cmd","id":1,"name":"get_state"}"#) else {
            panic!();
        };
        assert_eq!(f.name, None);
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
            r#"{"t":"device_info"}"#,
            r#"{"t":"device_info","name":5}"#,
            // E2E envelope rules: missing / ill-typed required fields.
            r#"{"t":"pair_hello"}"#,
            r#"{"t":"pair_hello","pk":7}"#,
            r#"{"t":"hs","pk":"b64"}"#,
            r#"{"t":"hs","mac":"b64"}"#,
            r#"{"t":"hs","pk":"b64","mac":3}"#,
            r#"{"t":"enc","seq":0}"#,
            r#"{"t":"enc","d":"AAECAwQ="}"#,
            r#"{"t":"enc","seq":"0","d":"AAECAwQ="}"#,
            r#"{"t":"enc","seq":-1,"d":"AAECAwQ="}"#,
            r#"{"t":"enc","seq":1.5,"d":"AAECAwQ="}"#,
            r#"{"t":"enc","seq":0,"d":42}"#,
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

        let v: Value =
            serde_json::from_str(&emit::peer_phone("c1", "Pixel", false, Some("ph1"))).unwrap();
        assert_eq!(v["phone"], "c1");
        assert_eq!(v["conn"], "c1");
        assert_eq!(v["name"], "Pixel");
        assert_eq!(v["online"], false);
        assert_eq!(v["ph"], "ph1");

        let v: Value = serde_json::from_str(&emit::device("My PC", "windows")).unwrap();
        assert_eq!(v["t"], "device");
        assert_eq!(v["name"], "My PC");
        assert_eq!(v["os"], "windows");

        let v: Value = serde_json::from_str(&emit::revoked("deadbeef")).unwrap();
        assert_eq!(v["t"], "revoked");
        assert_eq!(v["phone_hash"], "deadbeef");

        let v: Value = serde_json::from_str(&emit::paired("dev1", "tok1", Some("pk1"))).unwrap();
        assert_eq!(v["t"], "paired");
        assert_eq!(v["device"], "dev1");
        assert_eq!(v["token"], "tok1");
        assert_eq!(v["pk"], "pk1");

        let v: Value =
            serde_json::from_str(&emit::pair_code("ABCD-1234", "https://h/p#tok")).unwrap();
        assert_eq!(v["code"], "ABCD-1234");
        assert_eq!(v["url"], "https://h/p#tok");

        let v: Value =
            serde_json::from_str(&emit::pair_request("pid", "iPhone UA", Some("ppk"))).unwrap();
        assert_eq!(v["pair_id"], "pid");
        assert_eq!(v["agent"], "iPhone UA");
        assert_eq!(v["pk"], "ppk");

        let v: Value = serde_json::from_str(&emit::pair_done("pid", "ph1")).unwrap();
        assert_eq!(v["t"], "pair_done");
        assert_eq!(v["pair_id"], "pid");
        assert_eq!(v["ph"], "ph1");

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

    #[test]
    fn e2e_optional_pk_absent_is_null_not_string() {
        // `pk`/`to` omitted → null in the emitted frames (serde keeps the
        // key with null so clients can key uniformly).
        let v: Value = serde_json::from_str(&emit::paired("d", "t", None)).unwrap();
        assert!(v["pk"].is_null());
        let v: Value = serde_json::from_str(&emit::pair_request("p", "a", None)).unwrap();
        assert!(v["pk"].is_null());
        let v: Value = serde_json::from_str(&emit::peer_phone("c1", "n", true, None)).unwrap();
        assert!(v["ph"].is_null());
    }

    #[test]
    fn e2e_envelope_extracts_pk_and_to() {
        let Inbound::Valid(f) = parse(
            r#"{"t":"enc","seq":3,"d":"AAECAwQ=","to":"feedbeef","pk":"aGFjaw=="}"#,
        ) else {
            panic!();
        };
        assert_eq!(f.t, "enc");
        assert_eq!(f.pk.as_deref(), Some("aGFjaw=="));
        assert_eq!(f.to.as_deref(), Some("feedbeef"));

        let Inbound::Valid(f) =
            parse(r#"{"t":"hs","v":2,"ph":"h","pk":"k","mac":"m"}"#) else {
                panic!();
            };
        assert_eq!(f.pk.as_deref(), Some("k"));
        assert_eq!(f.to, None);

        let Inbound::Valid(f) =
            parse(r#"{"t":"pair_grant","pair_id":"p","pk":"desk"}"#) else {
                panic!();
            };
        assert_eq!(f.pair_id.as_deref(), Some("p"));
        assert_eq!(f.pk.as_deref(), Some("desk"));

        // A non-string `to` is simply absent (never misroutes a unicast).
        let Inbound::Valid(f) =
            parse(r#"{"t":"enc","seq":1,"d":"AAECAwQ=","to":9}"#) else {
                panic!();
            };
        assert_eq!(f.to, None);
    }

    #[test]
    fn from_field_extracted_when_string() {
        // A desktop res echoing `from` (the unicast routing key).
        let Inbound::Valid(f) =
            parse(r#"{"t":"res","id":42,"ok":true,"value":1,"from":"a1b2c3d4"}"#)
        else {
            panic!();
        };
        assert_eq!(f.t, "res");
        assert_eq!(f.id, Some(42));
        assert_eq!(f.from.as_deref(), Some("a1b2c3d4"));

        // cmd frames the relay tags also extract `from`.
        let Inbound::Valid(f) = parse(r#"{"t":"cmd","id":5,"name":"x","from":"deadbeef"}"#)
        else {
            panic!();
        };
        assert_eq!(f.from.as_deref(), Some("deadbeef"));
        assert_eq!(f.name, None);

        // No `from` → None; a non-string `from` is ignored (never
        // misroutes a unicast).
        let Inbound::Valid(f) = parse(r#"{"t":"res","id":1,"ok":false,"error":"x"}"#) else {
            panic!();
        };
        assert_eq!(f.from, None);
        let Inbound::Valid(f) = parse(r#"{"t":"res","id":1,"ok":true,"from":7}"#) else {
            panic!();
        };
        assert_eq!(f.from, None);
    }

    #[test]
    fn relay_hello_shape() {
        let v: Value = serde_json::from_str(&emit::hello()).unwrap();
        assert_eq!(v["t"], "hello");
        assert_eq!(v["v"], 1);
        assert_eq!(v["caps"], serde_json::json!(emit::RELAY_CAPS));
    }
}
