//! The summon hotkey (`ctrl+alt+space` by default): a global shortcut that
//! un-minimizes and focuses the main window and tells the webview it was
//! summoned, from any app (or from behind the tray toggle).
//!
//! The chord is read from `<app config>/global-hotkey.json`, with no
//! temp-dir fallback: another local account could plant a `chord` there and
//! rebind our shortcut. A missing file keeps the default; any other failure
//! (unparsable JSON, unknown chord, registration refused by the OS because
//! another app owns the combination) only logs: the app must always start,
//! a broken hotkey must not take the whole launcher down with it.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// The event the webview gets when the hotkey fires. Empty payload on
/// purpose: the frontend reaction (focus the composer) needs nothing else,
/// and a payload would just be a second contract to keep in sync. Used by
/// `tray.rs`'s show path too, hence `pub(crate)`.
// `redundant_pub_crate` fires because this module is private; the
// visibility is real — the tray menu reaches across modules for the event
// name so the hotkey and the tray can never drift apart on it.
#[allow(clippy::redundant_pub_crate)]
pub(crate) const SUMMON_EVENT: &str = "app://summon";

/// The default chord: `ctrl+alt+space`. Chosen for not colliding with any
/// Windows/macos system chord we know of, and for being pressable with one
/// (left) hand.
const DEFAULT_CHORD: &str = "ctrl+alt+space";

/// What `global-hotkey.json` holds. `deny_unknown_fields`: a renamed key
/// (`hotkey`, `shortcut`) must fail loudly as a config error (logged, then
/// the default chord) rather than silently register nothing.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HotkeyConfig {
    chord: String,
}

/// Read the configured chord from `config` (the `global-hotkey.json` under
/// the app config dir). Missing file → the default; read or parse failure →
/// the default, with a warning that names the file so the user can fix it.
/// Returns the *normalized* chord string (see [`normalize_chord`]).
fn configured_chord(config: Option<&Path>) -> String {
    let Some(path) = config else {
        return DEFAULT_CHORD.to_owned();
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return DEFAULT_CHORD.to_owned(),
        Err(e) => {
            eprintln!(
                "[omp-desktop] hotkey config {} unreadable ({e}); using {DEFAULT_CHORD}",
                path.display()
            );
            return DEFAULT_CHORD.to_owned();
        }
    };
    let parsed: HotkeyConfig = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!(
                "[omp-desktop] hotkey config {} invalid ({e}); using {DEFAULT_CHORD}",
                path.display()
            );
            return DEFAULT_CHORD.to_owned();
        }
    };
    normalize_chord(&parsed.chord).unwrap_or_else(|| {
        eprintln!(
            "[omp-desktop] hotkey config {} has an unparsable chord {:?}; using {DEFAULT_CHORD}",
            path.display(),
            parsed.chord
        );
        DEFAULT_CHORD.to_owned()
    })
}

/// Normalize a user chord: lowercase, one `+` between keys, modifiers in a
/// fixed order (ctrl, alt, shift, super) ahead of exactly one plain key.
/// `None` for anything that is not that shape — zero or several plain keys,
/// unknown modifiers, empty or stray separators — so the caller falls back
/// to the default instead of registering something the user did not ask
/// for. `"super"`/`"cmd"`/`"meta"`/`"win"` all mean `super`.
///
/// The output is exactly the spelling the plugin's `Shortcut` parser
/// accepts, so [`register`] never fails on normalization's account.
fn normalize_chord(raw: &str) -> Option<String> {
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut super_key = false;
    let mut keys: Vec<&str> = Vec::new();
    for part in raw.split('+') {
        let part = part.trim();
        if part.is_empty() {
            return None; // "+x", "ctrl++x", "x+"
        }
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "super" | "cmd" | "command" | "meta" | "win" | "windows" => super_key = true,
            _ => {
                // A plain key: normalize the case the parser is strict
                // about (letters, F-keys) and keep named keys as-is below.
                keys.push(part);
            }
        }
    }
    if keys.len() != 1 {
        return None; // no key, or a chord of two plain keys
    }
    let key = normalize_key(keys[0])?;
    let mut parts: Vec<&str> = Vec::with_capacity(5);
    if ctrl {
        parts.push("ctrl");
    }
    if alt {
        parts.push("alt");
    }
    if shift {
        parts.push("shift");
    }
    if super_key {
        parts.push("super");
    }
    parts.push(&key);
    Some(parts.join("+"))
}

/// One plain key in the canonical spelling the plugin parser accepts:
/// F-keys and digits verbatim, letters uppercased, `space` for `"space"`.
/// `None` for a key the parser does not know — those return the same
/// "unparsable chord" default fallback as a malformed chord. Aliases the
/// user may reasonably write (`return`→`enter`, `del`→`delete`) are
/// canonicalized to the spelling the parser's key table has.
fn normalize_key(key: &str) -> Option<String> {
    if key.eq_ignore_ascii_case("space") {
        return Some("space".to_owned());
    }
    let lowered = key.to_ascii_lowercase();
    if lowered.len() == 1 && lowered.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(lowered.to_ascii_uppercase());
    }
    if lowered.len() == 1 && lowered.chars().all(|c| c.is_ascii_digit()) {
        return Some(lowered);
    }
    if let Some(rest) = lowered.strip_prefix('f') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return Some(lowered);
        }
    }
    // Named keys the parser accepts as-is, in lowercase, plus the aliases
    // mapped onto them: `return`→`enter`, `del`→`delete`…
    let canonical = match lowered.as_str() {
        "tab" => "tab",
        "enter" | "return" => "enter",
        "escape" | "esc" => "escape",
        "backspace" => "backspace",
        "delete" | "del" => "delete",
        "insert" => "insert",
        "home" => "home",
        "end" => "end",
        "pageup" => "pageup",
        "pagedown" | "page-down" => "pagedown",
        "up" => "up",
        "down" => "down",
        "left" => "left",
        "right" => "right",
        _ => return None,
    };
    Some(canonical.to_owned())
}

/// Un-minimize, show and focus the main window, then tell the webview it
/// was summoned. Used by the hotkey and by the tray's show path; errors
/// only log, since there is no meaningful recovery from "cannot focus a
/// window the user asked for" beyond trying again next time.
fn summon(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Err(e) = app.emit(SUMMON_EVENT, ()) {
        eprintln!("[omp-desktop] summon event not delivered: {e}");
    }
}

/// Register the summon hotkey (called from `setup`). Every failure only
/// logs: the OS refusing the combination (another app owns it), a
/// missing config dir, an invalid chord — none may take the app down.
// `redundant_pub_crate`: `setup` sits in the crate root, so `fn` would
// *work*, but the visibility documents the cross-module contract the
// crate root already spells `global_hotkey::register`.
#[allow(clippy::redundant_pub_crate)]
pub(crate) fn register(app: &AppHandle, config: Option<&Path>) {
    let chord = configured_chord(config);
    let shortcut: Shortcut = match chord.parse() {
        Ok(shortcut) => shortcut,
        Err(e) => {
            eprintln!(
                "[omp-desktop] summon hotkey not registered: chord {chord:?} unparsable ({e})"
            );
            return;
        }
    };
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            // The plugin reports both press and release; only the press
            // summons, or every press would summon twice.
            if event.state() == ShortcutState::Pressed {
                summon(app);
            }
        });
    if let Err(e) = result {
        eprintln!("[omp-desktop] summon hotkey {chord} not registered: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_chord, DEFAULT_CHORD};

    #[test]
    fn the_default_chord_normalizes_to_itself() {
        assert_eq!(
            normalize_chord(DEFAULT_CHORD).as_deref(),
            Some(DEFAULT_CHORD)
        );
    }

    #[test]
    fn upper_case_and_stray_spaces_still_mean_the_same_chord() {
        assert_eq!(
            normalize_chord("CTRL+ALT+SPACE").as_deref(),
            Some("ctrl+alt+space")
        );
        assert_eq!(
            normalize_chord("ctrl + alt + space").as_deref(),
            Some("ctrl+alt+space")
        );
        assert_eq!(
            normalize_chord("  ctrl+alt+space  ").as_deref(),
            Some("ctrl+alt+space")
        );
    }

    #[test]
    fn modifiers_are_reordered_into_the_canonical_sequence() {
        assert_eq!(
            normalize_chord("alt+ctrl+space").as_deref(),
            Some("ctrl+alt+space")
        );
        assert_eq!(
            normalize_chord("shift+alt+super+ctrl+a").as_deref(),
            Some("ctrl+alt+shift+super+A")
        );
        assert_eq!(
            normalize_chord("shift+ctrl+tab").as_deref(),
            Some("ctrl+shift+tab")
        );
    }

    #[test]
    fn repeated_modifiers_stay_a_single_modifier() {
        assert_eq!(
            normalize_chord("ctrl+ctrl+space").as_deref(),
            Some("ctrl+space")
        );
        assert_eq!(
            normalize_chord("alt+alt+ctrl+A").as_deref(),
            Some("ctrl+alt+A")
        );
    }

    #[test]
    fn modifier_aliases_mean_the_canonical_modifier() {
        assert_eq!(normalize_chord("cmd+space").as_deref(), Some("super+space"));
        assert_eq!(
            normalize_chord("command+meta+space").as_deref(),
            Some("super+space")
        );
        assert_eq!(
            normalize_chord("option+ctrl+space").as_deref(),
            Some("ctrl+alt+space")
        );
        assert_eq!(
            normalize_chord("control+win+space").as_deref(),
            Some("ctrl+super+space")
        );
    }

    #[test]
    fn plain_keys_get_their_canonical_spelling() {
        assert_eq!(normalize_chord("a").as_deref(), Some("A"));
        assert_eq!(normalize_chord("ctrl+a").as_deref(), Some("ctrl+A"));
        assert_eq!(normalize_chord("ctrl+9").as_deref(), Some("ctrl+9"));
        assert_eq!(normalize_chord("ctrl+F5").as_deref(), Some("ctrl+f5"));
        assert_eq!(
            normalize_chord("ctrl+Return").as_deref(),
            Some("ctrl+enter")
        );
    }

    #[test]
    fn a_chord_without_a_plain_key_is_rejected() {
        assert_eq!(normalize_chord("ctrl+alt"), None);
        assert_eq!(normalize_chord(""), None);
        assert_eq!(normalize_chord("ctrl+alt+shift+super"), None);
    }

    #[test]
    fn a_chord_with_two_plain_keys_is_rejected() {
        assert_eq!(normalize_chord("ctrl+a+b"), None);
        assert_eq!(normalize_chord("a+b"), None);
    }

    #[test]
    fn malformed_separators_are_rejected() {
        assert_eq!(normalize_chord("+space"), None);
        assert_eq!(normalize_chord("ctrl++space"), None);
        assert_eq!(normalize_chord("ctrl+space+"), None);
        assert_eq!(normalize_chord("ctrl + + space"), None);
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert_eq!(normalize_chord("ctrl+banana"), None);
        assert_eq!(normalize_chord("ctrl++"), None);
        assert_eq!(normalize_chord("fn+space"), None);
    }

    #[test]
    fn a_normalized_chord_parses_as_a_plugin_shortcut() {
        use tauri_plugin_global_shortcut::Shortcut;
        for raw in [
            "ctrl+alt+space",
            "CTRL+ALT+SPACE",
            "ctrl + alt + space",
            "shift+ctrl+tab",
            "cmd+space",
            "ctrl+F5",
        ] {
            let normalized = normalize_chord(raw).expect("normalizable");
            normalized
                .parse::<Shortcut>()
                .unwrap_or_else(|e| panic!("{raw:?} → {normalized:?} must parse: {e}"));
        }
    }
}
