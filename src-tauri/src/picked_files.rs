//! Files arriving from the OS: dropped onto the composer, sitting on the
//! clipboard after a file-manager copy, or picked as a background image.
//!
//! With `dragDropEnabled: true` (`tauri.conf.json`) the webview never sees
//! HTML5 file drops — Tauri delivers `tauri://drag-drop` events carrying
//! full paths (files *and* folders) instead. The composer inserts those
//! paths as text; the one exception is a dropped image, which keeps the
//! paste/pick attachment pipeline and needs its bytes, read here.
//!
//! For paste, the webview's own `clipboardData` carries image bytes (a
//! screenshot) but no file paths and no folders, so the composer asks
//! [`copied_file_paths`] instead: a file-manager copy puts the path list on
//! the OS clipboard (`CF_HDROP` on Windows), which a screenshot does not —
//! that difference is what tells "paste these paths" apart from "attach
//! this image".
//!
//! The background-image tweak stores a path under the app's config dir;
//! [`copy_background`] makes that copy so a moved or deleted original never
//! breaks the setting.

use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// Generous ceiling for a dropped image's raw bytes; the frontend's
/// `prepareImage` downscales/re-encodes before anything reaches the agent.
const MAX_DROPPED_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// A file read on the composer's behalf: its base name and base64 contents.
#[derive(Debug, serde::Serialize)]
pub struct DroppedFile {
    pub name: String,
    pub data: String,
}

/// Read a dropped file's bytes so the composer can run it through the image
/// attachment pipeline. Directories never get here — the composer inserts
/// their path as text instead — and anything else dropped is text-inserted
/// too, so refusing non-files is a guard, not a feature.
pub fn read(path: String) -> Result<DroppedFile, String> {
    let path = std::path::PathBuf::from(path);
    let meta =
        fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    if meta.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!("file too large: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    Ok(DroppedFile {
        name,
        data: STANDARD.encode(bytes),
    })
}

/// Paths of the files/folders a file manager has on the clipboard, or an
/// empty list: clipboard held by another kind of content (text, a
/// screenshot, an app-specific format), or the clipboard could not be
/// opened at all. Callers treat empty as "not a file copy" and fall back to
/// their image/text handling.
pub fn copied_file_paths() -> Vec<String> {
    imp::copied_file_paths()
}

/// Copy a picked background image to `<config_dir>/backgrounds/background.<ext>`
/// and return the copy's path. Single slot: any previous `background.*` is
/// removed first, so the dir never accumulates stale picks.
pub fn copy_background(config_dir: &Path, src: &Path) -> Result<String, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let dir = config_dir.join("backgrounds");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for entry in fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("cannot read entry: {e}"))?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("background.")
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    let dest = dir.join(format!("background.{ext}"));
    fs::copy(src, &dest).map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    /// Win32 clipboard format for an `HDROP` path list — what Explorer and
    /// every other file manager write on Ctrl+C/Ctrl+X of a selection.
    const CF_HDROP: u32 = 15;

    pub fn copied_file_paths() -> Vec<String> {
        // SAFETY: single-threaded clipboard open/close pairing; the HDROP
        // handle is borrowed only between OpenClipboard and CloseClipboard,
        // and DragQueryFileW is called with correctly sized buffers.
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Vec::new(); // held by another app — treat as no files
            }
            let mut out = Vec::new();
            let handle = GetClipboardData(CF_HDROP);
            if !handle.is_null() {
                // For CF_HDROP the returned handle *is* the HDROP; no lock.
                let hdrop = handle.cast();
                let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
                for i in 0..count {
                    let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
                    if len == 0 {
                        continue;
                    }
                    let mut buf = vec![0u16; len as usize + 1];
                    if DragQueryFileW(hdrop, i, buf.as_mut_ptr(), len + 1) == 0 {
                        continue;
                    }
                    buf.truncate(len as usize);
                    out.push(String::from_utf16_lossy(&buf));
                }
            }
            CloseClipboard();
            out
        }
    }
}

/// No file-list clipboard read is wired up outside Windows yet: the empty
/// list keeps the composer's existing paste behaviour there (image bytes
/// attach, file pastes are ignored), matching what it did before this
/// command existed.
#[cfg(not(windows))]
mod imp {
    pub fn copied_file_paths() -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_file_bytes_reads_bytes_and_name() {
        let dir = std::env::temp_dir().join("omp-desktop-dropped-test");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pic.png");
        fs::write(&file, b"\x89PNG").unwrap();
        let got = read(file.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.name, "pic.png");
        assert_eq!(STANDARD.decode(&got.data).unwrap(), b"\x89PNG");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_file_bytes_refuses_a_directory() {
        let err = read(std::env::temp_dir().to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("not a file"), "unexpected error: {err}");
    }

    #[test]
    fn read_file_bytes_refuses_a_missing_path() {
        let err = read("definitely/not/there.png".to_string()).unwrap_err();
        assert!(err.contains("could not read"), "unexpected error: {err}");
    }

    #[test]
    fn copied_file_paths_never_fails() {
        // Whatever is on the test machine's clipboard — or no clipboard at
        // all (a headless session) — the contract is a list, never an error.
        let _ = copied_file_paths();
    }
}
