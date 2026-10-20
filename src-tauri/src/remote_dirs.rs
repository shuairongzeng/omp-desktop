//! Read-only directory listing for the paired phone's file browser
//! (`docs/architecture/remote-control.md`).
//!
//! Phone frames execute in the desktop's webview (see `remote`), which cannot
//! enumerate the filesystem itself (strict CSP, asset protocol disabled, no
//! shell plugin), so the listing is answered here. Only subdirectories are
//! listed, hidden entries are filtered out and the result is capped: one
//! browse step costs a single bounded directory read, never a tree walk.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Ceiling on the subdirectories one listing returns.
const MAX_ENTRIES: usize = 500;

/// One selectable folder in a listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirEntry {
    /// The folder's name as a child of the listed directory.
    pub name: String,
    /// Absolute path, the value a drill-down sends back as `path`.
    pub path: String,
}

/// One level of the filesystem, as the phone's browser renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirListing {
    /// The listed folder's parent; `None` for the platform roots and for a
    /// folder without a parent (the filesystem root).
    pub parent: Option<String>,
    /// Subdirectories, sorted case-insensitively by name.
    pub entries: Vec<DirEntry>,
}

/// List the subdirectories of `path`, or the platform roots when it is absent
/// (`None`) — the browse UI's entry point.
///
/// # Errors
///
/// Returns `Err` when `path` does not exist, is not a directory, or its
/// entries cannot be read; the message includes the underlying I/O error.
#[tauri::command]
pub fn remote_list_dirs(path: Option<String>) -> Result<DirListing, String> {
    path.map_or_else(
        || {
            Ok(DirListing {
                parent: None,
                entries: roots(),
            })
        },
        |path| list_dirs(&path),
    )
}

/// One bounded read of `path`'s subdirectories (see [`remote_list_dirs`]).
fn list_dirs(path: &str) -> Result<DirListing, String> {
    let root = Path::new(path);
    let meta = fs::metadata(root).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{path}: not a directory"));
    }
    let read_dir = fs::read_dir(root).map_err(|e| format!("{path}: {e}"))?;
    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("{path}: {e}"))?;
        // `entry_path.is_dir()` follows symlinks, so a symlinked directory is
        // offered as a browsable folder.
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
        });
    }
    // Case-insensitive primary key; the exact name breaks ties so the order is
    // stable for names differing only in case.
    entries.sort_by_cached_key(|entry| (entry.name.to_lowercase(), entry.name.clone()));
    entries.truncate(MAX_ENTRIES);
    Ok(DirListing {
        parent: root.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// The roots listing: the platform's starting points that actually exist,
/// deduplicated, in a fixed order.
fn roots() -> Vec<DirEntry> {
    let mut seen: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    for candidate in root_candidates() {
        if !candidate.is_dir() {
            continue;
        }
        let path = candidate.to_string_lossy().into_owned();
        if seen.contains(&path) {
            continue;
        }
        let name = candidate
            .file_name()
            .map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
        seen.push(path.clone());
        entries.push(DirEntry { name, path });
    }
    entries
}

/// Candidate roots before the existence check: the filesystem root, the
/// conventional user-parent folder(s), and the home directory.
#[cfg(not(target_os = "windows"))]
fn root_candidates() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/")];
    for dir in ["/Users", "/home"] {
        let dir = PathBuf::from(dir);
        if dir.is_dir() {
            roots.push(dir);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            roots.push(PathBuf::from(home));
        }
    }
    roots
}

/// Candidate roots before the existence check: every drive root and the
/// profile directory. A missing drive is filtered out by [`roots`].
#[cfg(target_os = "windows")]
fn root_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .collect();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        if !profile.is_empty() {
            roots.push(PathBuf::from(profile));
        }
    }
    roots
}

/// Whether a child directory is hidden and therefore not offered.
#[cfg(not(target_os = "windows"))]
const fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// On Windows the system bookkeeping folders are hidden by name rather than
/// by a dot prefix.
#[cfg(target_os = "windows")]
const fn is_hidden(name: &str) -> bool {
    name.eq_ignore_ascii_case("$Recycle.Bin")
        || name.eq_ignore_ascii_case("System Volume Information")
}

#[cfg(test)]
mod tests {
    use super::{remote_list_dirs, DirListing, MAX_ENTRIES};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "omp-remote-dirs-test-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ))
    }

    fn as_arg(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn listing(path: &Path) -> DirListing {
        remote_list_dirs(Some(as_arg(path))).expect("list directory")
    }

    fn names(listing: &DirListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_subdirectories_sorted_case_insensitively() {
        let root = unique_temp_dir("sorted");
        std::fs::create_dir(&root).expect("create fixture dir");
        for dir in ["Beta", "alpha", "Gamma", "delta"] {
            std::fs::create_dir(root.join(dir)).expect("create fixture dir");
        }
        std::fs::write(root.join("not-a-dir.txt"), b"x").expect("write fixture file");

        let listing = remote_list_dirs(Some(as_arg(&root))).expect("list directory");

        assert_eq!(names(&listing), ["alpha", "Beta", "delta", "Gamma"]);
        assert_eq!(listing.parent, root.parent().map(as_arg));
        let first = &listing.entries[0];
        assert_eq!(first.path, as_arg(&root.join("alpha")));

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn skips_dot_directories() {
        let root = unique_temp_dir("hidden");
        std::fs::create_dir_all(root.join(".git")).expect("create hidden dir");
        std::fs::create_dir(root.join("src")).expect("create visible dir");

        let listing = listing(&root);

        assert_eq!(names(&listing), ["src"]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn skips_windows_system_directories() {
        let root = unique_temp_dir("hidden");
        std::fs::create_dir_all(&root).expect("create fixture root");
        for dir in ["$Recycle.Bin", "System Volume Information", "src"] {
            std::fs::create_dir(root.join(dir)).expect("create fixture dir");
        }

        let listing = listing(&root);

        assert_eq!(names(&listing), ["src"]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_path_is_an_error() {
        let root = unique_temp_dir("missing");
        let target = as_arg(&root);

        let err = remote_list_dirs(Some(target.clone())).expect_err("missing path must fail");

        assert!(err.contains(&target), "unexpected error: {err}");
    }

    #[test]
    fn file_path_is_an_error() {
        let root = unique_temp_dir("file");
        std::fs::create_dir(&root).expect("create fixture dir");
        let file = root.join("plain.txt");
        std::fs::write(&file, b"x").expect("write fixture file");

        let err = remote_list_dirs(Some(as_arg(&file))).expect_err("file path must fail");

        assert!(err.contains("not a directory"), "unexpected error: {err}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn roots_listing_has_no_parent_and_entries_exist() {
        let listing = remote_list_dirs(None).expect("list roots");

        assert!(listing.parent.is_none());
        assert_ne!(listing.entries.len(), 0);
        assert!(listing
            .entries
            .iter()
            .all(|entry| Path::new(&entry.path).is_dir()));
    }

    #[test]
    fn caps_entries_at_500() {
        let root = unique_temp_dir("cap");
        std::fs::create_dir(&root).expect("create fixture dir");
        for i in 0..=MAX_ENTRIES {
            std::fs::create_dir(root.join(format!("d{i:03}"))).expect("create fixture dir");
        }

        let listing = listing(&root);

        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert_eq!(listing.entries[0].name, "d000");
        assert_eq!(listing.entries[MAX_ENTRIES - 1].name, "d499");

        std::fs::remove_dir_all(&root).ok();
    }
}
