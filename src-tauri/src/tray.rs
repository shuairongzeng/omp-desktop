//! The system-tray entry: left-click toggles the main window between
//! shown and hidden, and the right-click menu has `show omp` and `quit`
//! (`quit` goes through the same `RunEvent::Exit` → `kill_child_processes`
//! cleanup as closing the window does — see the `quit` handler).
//!
//! This is deliberately *not* a "keep running in the tray" mode: closing
//! the window with its × still exits the app as before. The tray only adds
//! a way back in for a window hidden by the left-click toggle (or the OS
//! minimizing it), so a hidden window is not lost.
//!
//! Every failure only logs: a missing icon, a menu that cannot be built,
//! a tray the platform refuses — none may take the app down (same rule as
//! the summon hotkey, `global_hotkey.rs`).

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Menu-item id for `show omp`. Matched by string, since the handler gets
/// the menu event's id only.
const SHOW_ITEM_ID: &str = "show";

/// Menu-item id for `quit`.
const QUIT_ITEM_ID: &str = "quit";

/// Create the tray icon and its menu (called from `setup`). All failures
/// log and leave the app without a tray, which is a cosmetic loss only.
// `redundant_pub_crate`: `setup` sits in the crate root, so `fn` would
// *work*, but the visibility documents the cross-module contract the
// crate root already spells `tray::init`.
#[allow(clippy::redundant_pub_crate)]
pub(crate) fn init(app: &tauri::App) {
    let menu = match build_menu(app) {
        Ok(menu) => menu,
        Err(e) => {
            eprintln!("[omp-desktop] tray menu not built: {e}");
            return;
        }
    };
    let builder = TrayIconBuilder::with_id("omp-tray")
        .tooltip("omp")
        .menu(&menu);
    // `app.default_window_icon()` is the bundled icon; `None` (an iconless
    // build) builds a tray with the platform's placeholder, which on
    // Windows is a blank slot — still functional, so not an error.
    let builder = if let Some(icon) = app.default_window_icon() {
        builder.icon(icon.clone())
    } else {
        eprintln!("[omp-desktop] tray using the default icon: no bundled window icon");
        builder
    };
    let builder = builder
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ITEM_ID => summon(app),
            QUIT_ITEM_ID => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });
    if let Err(e) = builder.build(app) {
        eprintln!("[omp-desktop] tray icon not created: {e}");
    }
}

/// The right-click menu: `show omp`, `quit` — in the house style (all
/// lower case, no trailing period).
fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, SHOW_ITEM_ID, "show omp", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ITEM_ID, "quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// Show, un-minimize and focus the main window, without the summon event:
/// the user is already looking at the tray, so there is nothing to tell
/// the webview. Errors only log (see [`summon`]'s counterpart in
/// `global_hotkey.rs` for the rationale).
fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// The tray icon's left click: toggle the main window between shown and
/// hidden. A visible, un-minimized window hides (the user's "get it out of
/// my face"); a hidden or minimized one shows again. `is_visible` alone
/// cannot tell those apart on every platform (a minimized window can
/// report visible), so both checks run.
fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(true);
        let minimized = win.is_minimized().unwrap_or(false);
        if visible && !minimized {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}

/// Show, un-minimize, focus and announce: what the summon hotkey and the
/// tray's `show omp` share.
fn summon(app: &AppHandle) {
    show_window(app);
    if let Err(e) = app.emit(crate::global_hotkey::SUMMON_EVENT, ()) {
        eprintln!("[omp-desktop] summon event not delivered: {e}");
    }
}

/// Quit from the tray menu: close the main window, which is the same path
/// the × takes — `RunEvent::ExitRequested`/`RunEvent::Exit`, and so
/// `kill_child_processes` in `handle_run_event`. Deliberately NOT
/// `app.exit(0)`: that skips the held-close confirmation path the window
/// close goes through (`CloseGuard`), and with it the webview's
/// "ask before closing a busy tab".
fn quit(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.close() {
            eprintln!("[omp-desktop] tray quit could not close the window: {e}");
        }
    } else {
        // No window to close (should not happen in this single-window app,
        // but a destroyed window must not make the menu item a no-op).
        app.exit(0);
    }
}
