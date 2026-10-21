//! Reads omp's persisted session history (`~/.omp/agent/sessions/**/*.jsonl`)
//! for the conversation-history panel, and validates `resume` values coming
//! back over the Tauri IPC boundary before they reach `agent::spawn::spawn_omp`.
//!
//! # Session identity
//! omp persists each session as a `<filesystem-safe-ISO8601>_<uuid>.jsonl`
//! file (see [`canonical_id_from_stem`]). That file path — and the uuid
//! extracted from it — is the **only** durable join key for a session.
//! `get_state().sessionId`, returned over the omp RPC boundary, is per-load
//! and ephemeral: it MUST NOT be persisted as a foreign key or compared
//! across two separate `get_state` calls to decide whether they refer to
//! "the same session". Wiring session-switch/resume logic against it will
//! silently misbehave across reloads.
//!
//! Submodules:
//! - [`tests`] — unit tests for the pure parse/scan/validate helpers below.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Information about a persisted session on disk.
///
/// The durable identity of a session is `path` (and the uuid embedded in
/// its filename, see [`canonical_id_from_stem`]) — not `id`, which is
/// merely a copy of the `session` event's `id` field from the JSONL body
/// and, for sessions resumed over RPC, must never be conflated with a
/// live `get_state().sessionId` from a different `get_state` call.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SavedSession {
    pub id: String,
    pub title: String,
    pub timestamp: String,
    /// Last-activity timestamp: the later of the latest `message` event's
    /// top-level `timestamp` and the latest retitle's `title` event
    /// `updatedAt` — i.e. when the conversation was actually last touched,
    /// regardless of when it was created (`timestamp`). Every other event
    /// type is deliberately excluded, in particular `session` and the
    /// `custom` lifecycle events omp appends around an RPC child's exit
    /// (e.g. `session_exit`): those are stamped with wall-clock time when
    /// the child process terminates, not when the user last did anything,
    /// so resuming a dormant session and closing the tab without sending a
    /// new message must not bump it back to the top of the history list.
    /// `None` only for a file with no `message` or `title` event at all,
    /// in which case callers fall back to `timestamp` (see `scan_dir`'s
    /// sort and the frontend history modal's display, both of which do
    /// `updated_at.unwrap_or(timestamp)`).
    pub updated_at: Option<String>,
    pub cwd: String,
    pub project_name: String,
    pub path: String,
    pub message_count: usize,
    /// Set only when `list_saved_sessions` ran with a search `query` that
    /// matched this session's message text: the matching region, the query
    /// hit plus ~40 chars of context on each side, standing in for
    /// `preview` in the history modal's rows. `None` for the unqueried
    /// list (and for a query that matched only title/project fields, where
    /// `preview` still tells the story).
    pub match_snippet: Option<String>,
    pub preview: Option<String>,
}

/// Resolve the sessions directory from already-gathered inputs.
///
/// Delegates the `PI_CODING_AGENT_DIR`-for-built-in-only precedence to
/// [`crate::profiles::agent_dir_for`] — the same rule `keybindings::mod`
/// needs for its config reader, now defined once so the two cannot diverge.
/// Extracted from [`sessions_root_dir`] purely so that precedence is
/// assertable without a Tauri `AppHandle` - the same split `scan_dir` uses.
fn sessions_root_for(home: &Path, profile: Option<&str>, env_dir: Option<&OsStr>) -> PathBuf {
    crate::profiles::agent_dir_for(home, profile, env_dir).join("sessions")
}

/// Locate the directory where omp persists sessions for a resolved `profile`
/// (`None` = built-in): `~/.omp/agent/sessions`, or
/// `~/.omp/profiles/<id>/agent/sessions` for a named one (see
/// [`crate::profiles::agent_dir`]).
///
/// `PI_CODING_AGENT_DIR` is honoured only for the built-in profile. That
/// mirrors the installed omp binary's own precedence - verified by running
/// `PI_CODING_AGENT_DIR=… omp --profile <id>`, which still resolved its
/// models/sessions under `~/.omp/profiles/<id>/` - so the history panel
/// reads the same tree the child process writes.
pub fn sessions_root_dir(app: &AppHandle, profile: Option<&str>) -> Option<PathBuf> {
    let env_dir = std::env::var_os("PI_CODING_AGENT_DIR");
    app.path()
        .home_dir()
        .ok()
        .map(|home| sessions_root_for(&home, profile, env_dir.as_deref()))
}

/// Extract text content from a message content block array.
fn extract_text_from_content(content: &serde_json::Value) -> Option<String> {
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    } else if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Update running per-message state from a `"message"` event's payload.
/// Only `user`/`assistant` turns count towards `message_count` or update
/// the preview/fallback-title — `toolResult` entries hold raw tool output
/// (file contents, bash output) and would otherwise inflate the turn count
/// and leak into the preview line.
///
/// Split out of `parse_session_file` purely to keep that function under
/// the project's line-count lint threshold; it has no independent purpose.
fn apply_message_event(
    val: &serde_json::Value,
    message_count: &mut usize,
    fallback_title: &mut String,
    last_preview: &mut Option<String>,
    text_blob: Option<&mut String>,
) {
    let msg = val.get("message");
    let role = msg
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("");
    if role != "user" && role != "assistant" {
        return;
    }
    *message_count += 1;

    let Some(text) = msg
        .and_then(|m| m.get("content"))
        .and_then(extract_text_from_content)
    else {
        return;
    };

    if role == "user" && fallback_title.is_empty() {
        // Truncate first user message as fallback title
        *fallback_title = if text.chars().count() > 60 {
            format!("{}…", text.chars().take(60).collect::<String>())
        } else {
            text.clone()
        };
    }
    // Search corpus for `list_saved_sessions`'s `query` filter: user and
    // assistant text only (toolResult output is raw file bytes, see the
    // doc comment above), lowercased once here so the match itself is a
    // plain substring, and capped at 100 KB — the corpus exists to find a
    // hit, not to hold the conversation, and matches past the cap would
    // only miss deep history, not corrupt it.
    if let Some(blob) = text_blob {
        if blob.len() < TEXT_BLOB_CAP_BYTES {
            blob.push_str(&text.to_lowercase());
            blob.push('\n');
        }
    }
    // Keep latest text as preview snippet
    *last_preview = Some(if text.chars().count() > 120 {
        format!("{}…", text.chars().take(120).collect::<String>())
    } else {
        text
    });
}

/// Record `candidate` as the session's last-activity timestamp if it is
/// later than (or the first) value seen so far for `current`.
///
/// Compares raw strings — valid only because every omp timestamp uses the
/// same ISO-8601 UTC-with-milliseconds format (`…T…Z`), which sorts
/// lexicographically in chronological order (see the `session` event's
/// `timestamp` field, parsed the same way just below). Comparing instead
/// of letting the last line win is load-bearing: the `title` event is
/// always the physically first line of the file, yet it carries the
/// timestamp of the *latest* retitle — an explicit `/rename` or omp's own
/// automatic one — which can postdate every `message` line that follows
/// it. Forked sessions add a second case: they copy the parent's messages
/// verbatim, including their pre-fork timestamps, so a later line in the
/// file is not guaranteed to carry a later timestamp there either.
fn update_last_activity(current: &mut Option<String>, candidate: &str) {
    if current.as_deref().is_none_or(|cur| candidate > cur) {
        *current = Some(candidate.to_string());
    }
}

/// Byte cap for the search corpus collected per file when a `query` is in
/// flight (see [`apply_message_event`]). 100 KB keeps the per-scan cost of
/// even a thousand sessions well under a frame while covering any
/// conversation a user could reasonably expect to find by substring.
const TEXT_BLOB_CAP_BYTES: usize = 100 * 1024;

/// Parse a single `.jsonl` session file and extract metadata. When
/// `text_blob` is `Some`, user/assistant message text is also accumulated
/// (lowercased, capped) into it — `list_saved_sessions`'s `query` filter
/// passes one in; every other caller passes `None` and the blob is never
/// built.
fn parse_session_file(path: &Path, mut text_blob: Option<&mut String>) -> Option<SavedSession> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut explicit_title = String::new();
    let mut fallback_title = String::new();
    let mut timestamp = String::new();
    let mut updated_at: Option<String> = None;
    let mut cwd = String::new();
    let mut message_count = 0usize;
    let mut last_preview: Option<String> = None;
    let mut blob = text_blob.as_deref_mut().map(|_| String::new());

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        if line.is_empty() {
            continue;
        }

        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };

        let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

        // Last activity is tracked only from `message` (a real turn) and
        // `title` (the latest retitle, explicit `/rename` or omp's own
        // automatic one) events — see the `updated_at` doc
        // comment on `SavedSession` for why every other event type,
        // including the exit lifecycle event omp appends when an RPC
        // child for this session terminates, is deliberately excluded.
        match event_type {
            "title" => {
                if let Some(t) = val.get("title").and_then(|s| s.as_str()) {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        explicit_title = trimmed.to_string();
                    }
                }
                if let Some(ts) = val.get("updatedAt").and_then(|s| s.as_str()) {
                    update_last_activity(&mut updated_at, ts);
                }
            }
            "session" => {
                if let Some(id) = val.get("id").and_then(|s| s.as_str()) {
                    session_id = id.to_string();
                }
                if let Some(ts) = val.get("timestamp").and_then(|s| s.as_str()) {
                    timestamp = ts.to_string();
                }
                if let Some(dir) = val.get("cwd").and_then(|s| s.as_str()) {
                    cwd = dir.to_string();
                }
            }
            "message" => {
                apply_message_event(
                    &val,
                    &mut message_count,
                    &mut fallback_title,
                    &mut last_preview,
                    blob.as_mut(),
                );
                if let Some(ts) = val.get("timestamp").and_then(|s| s.as_str()) {
                    update_last_activity(&mut updated_at, ts);
                }
            }
            _ => {}
        }
    }

    // The caller's blob slot (when a query asked for one) gets whatever the
    // cap allowed to accumulate. Written before the `None` return below so
    // the borrow checker sees the `&mut` parameter used on every path; the
    // caller discards it when `None` comes back.
    if let Some((slot, collected)) = text_blob.zip(blob) {
        *slot = collected;
    }

    if session_id.is_empty() && timestamp.is_empty() {
        return None;
    }

    let title = if !explicit_title.is_empty() {
        explicit_title
    } else if !fallback_title.is_empty() {
        fallback_title
    } else {
        "Untitled conversation".to_string()
    };

    let project_name = if cwd.is_empty() {
        "Default".to_string()
    } else {
        Path::new(&cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cwd)
            .to_string()
    };

    Some(SavedSession {
        // Prefer the filename-derived uuid — the durable identity (see the
        // module doc comment) — over the JSONL body's `session.id` field.
        // They agree in the common case; falling back to the body's id
        // only covers a file that doesn't match the expected
        // `<timestamp>_<uuid>.jsonl` shape (e.g. an imported session).
        id: canonical_id_from_stem(path).map_or(session_id, str::to_string),
        title,
        timestamp,
        updated_at,
        cwd,
        project_name,
        path: path.to_string_lossy().into_owned(),
        message_count,
        match_snippet: None,
        preview: last_preview,
    })
}

/// Normalize a `cwd` value for cross-platform comparison: forward slashes,
/// no trailing slash, case-insensitive.
fn normalize_cwd(cwd: &str) -> String {
    cwd.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Snippet for a text-blob hit: `needle` plus ~40 chars of context on each
/// side, cut on char boundaries (the blob is lowercased text; indices from
/// a byte search are valid as-is). Newlines in the window become spaces so
/// the one-line row stays one line. `None` when `needle` isn't in `blob` —
/// a title/project hit must keep `preview` as the row's second line.
fn match_snippet(blob: &str, needle: &str) -> Option<String> {
    // ~40 chars of context each side, snapped to char boundaries (a byte
    // index from `find` is always one; an arbitrary offset is not).
    const CTX: usize = 40;
    let start = blob.find(needle)?;
    let end = start + needle.len();
    let snap_start = blob
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| i <= start)
        .nth_back(CTX)
        .unwrap_or(0);
    let snap_end = blob
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| i >= end)
        .nth(CTX)
        .unwrap_or(blob.len());
    let text = blob[snap_start..snap_end].replace('\n', " ");
    Some(text.trim().to_string())
}

/// Extract the durable uuid component from a saved-session filename stem.
///
/// omp names session files `<filesystem-safe-ISO8601>_<uuid>.jsonl`, e.g.
/// `2026-09-12T18-16-44-966Z_01a096d6-0aa6-75d7-804c-088913a441e6.jsonl`.
/// The uuid is the substring after the **last** underscore in the file
/// stem (the timestamp prefix does not itself contain an underscore, but
/// splitting on the last one keeps this robust if it ever did). Returns
/// `None` — never panics or returns a best-effort guess — when the stem
/// has no underscore or the trailing component doesn't look like a uuid
/// (32-36 characters of hex digits and hyphens only).
///
/// This is the only durable, cross-load identity for a session; see the
/// module doc comment. Never substitute a `get_state().sessionId` value
/// here or vice versa.
pub fn canonical_id_from_stem(path: &Path) -> Option<&str> {
    let stem = path.file_stem()?.to_str()?;
    let idx = stem.rfind('_')?;
    let uuid = &stem[idx + 1..];
    let looks_like_uuid =
        (32..=36).contains(&uuid.len()) && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    looks_like_uuid.then_some(uuid)
}

/// Walk `root` for `.jsonl` session files, optionally filtered by
/// `cwd_filter` and/or `query`.
/// Sessions are sorted newest-first by `updated_at` (falling back to `timestamp`).
///
/// `query` (non-empty after trim) is a case-insensitive substring matched
/// against each session's title/project fields and its user/assistant
/// message text (collected during the same parse pass, capped — see
/// [`parse_session_file`]). Non-matching sessions are dropped; a text
/// match also fills `match_snippet` with the hit plus ~40 chars of context
/// on each side. `query = None`/empty keeps the pre-query behaviour byte
/// for byte — the text blob is not even collected.
///
/// Split out from `scan_saved_sessions` (which resolves `root` from the
/// `AppHandle`) so the walk/filter/sort logic can be unit-tested against a
/// tempdir without a Tauri app instance.
fn scan_dir(
    root: &Path,
    cwd_filter: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<SavedSession>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(root).map_err(|e| format!("failed to read {}: {e}", root.display()))?;

    let norm_filter = cwd_filter.filter(|f| !f.is_empty()).map(normalize_cwd);
    let needle = query
        .filter(|q| !q.trim().is_empty())
        .map(|q| q.trim().to_lowercase());

    let mut sessions = Vec::new();

    for entry_res in entries {
        let Ok(entry) = entry_res else { continue };
        let folder_path = entry.path();
        if !folder_path.is_dir() {
            continue;
        }
        // `delete_saved_session` parks trashed sessions here; they must
        // not reappear in the history list.
        if folder_path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == ".trash")
        {
            continue;
        }

        let Ok(files) = fs::read_dir(&folder_path) else {
            continue;
        };

        for file_res in files {
            let Ok(file_entry) = file_res else { continue };
            let path = file_entry.path();
            if !path.is_file()
                || !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("jsonl"))
            {
                continue;
            }

            let mut text_blob = needle.as_deref().map(|_| String::new());
            let Some(mut session) = parse_session_file(&path, text_blob.as_mut()) else {
                continue;
            };
            if let Some(norm_filter) = &norm_filter {
                if &normalize_cwd(&session.cwd) != norm_filter {
                    continue;
                }
            }
            if let Some(needle) = &needle {
                let field_hit = session.title.to_lowercase().contains(needle)
                    || session.project_name.to_lowercase().contains(needle)
                    || session.cwd.to_lowercase().contains(needle);
                // The blob is only collected when a needle exists; a match
                // in it also fills the snippet the modal shows in place of
                // `preview`. A field-only hit keeps `preview`.
                let snippet = text_blob
                    .as_deref()
                    .and_then(|blob| match_snippet(blob, needle));
                if !field_hit && snippet.is_none() {
                    continue;
                }
                session.match_snippet = snippet;
            }
            sessions.push(session);
        }
    }

    // Sort descending by timestamp / updated_at (newest first)
    sessions.sort_by(|a, b| {
        let key_b = b.updated_at.as_ref().unwrap_or(&b.timestamp);
        let key_a = a.updated_at.as_ref().unwrap_or(&a.timestamp);
        key_b.cmp(key_a)
    });

    Ok(sessions)
}

/// Scan `profile`'s sessions directory for saved `.jsonl` session files.
/// If `cwd_filter` is provided, only sessions whose `cwd` matches are
/// returned. A non-empty `query` additionally filters by case-insensitive
/// substring over title/project/cwd/message text and fills
/// `match_snippet` on text hits (see [`scan_dir`]).
///
/// # Errors
/// Returns an error when the home directory can't be resolved or the
/// sessions directory can't be read.
pub fn scan_saved_sessions(
    app: &AppHandle,
    cwd_filter: Option<&str>,
    query: Option<&str>,
    profile: Option<&str>,
) -> Result<Vec<SavedSession>, String> {
    let root = sessions_root_dir(app, profile)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    scan_dir(&root, cwd_filter, query)
}

/// Validate a `resume` value supplied over the Tauri IPC boundary against
/// `root` (the resolved sessions directory). Rejects anything that could be
/// re-tokenised as a flag by omp's argument parser, and requires the value
/// to be either a bare session id (hex digits and hyphens only) or an
/// existing `.jsonl` file whose canonical path lives under `root`.
///
/// Without this check, a malicious or buggy frontend value flows straight
/// into omp's argv (see `agent::spawn::spawn_omp`): a flag-shaped string
/// (e.g. `--auto-approve`) would be re-parsed by omp as a separate option,
/// or an arbitrary filesystem path could be opened as a "session".
fn validate_resume_against_root(root: &Path, resume: &str) -> Result<(), String> {
    if resume.starts_with('-') {
        return Err(format!("invalid resume value: {resume:?}"));
    }
    if resume.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Ok(());
    }
    let path = Path::new(resume);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("resume path does not exist: {resume:?} ({e})"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("sessions directory unavailable: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!(
            "resume path {resume:?} is outside the sessions directory"
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(format!(
            "resume path {resume:?} is not a .jsonl session file"
        ));
    }
    Ok(())
}

/// Validate a `resume` value against `profile`'s sessions directory. An
/// empty value is always accepted (means "no resume").
///
/// Confinement works differently for the two accepted forms. A *path* is
/// canonicalised and must live under this profile's root, so a path from
/// another profile's tree is rejected. A bare *session id* short-circuits
/// before `root` is consulted (see [`validate_resume_against_root`]) and is
/// therefore accepted verbatim; it stays confined because omp resolves an id
/// prefix inside whichever profile tree it was itself launched with, so
/// `--profile=B --resume=<A's id>` cannot reach A's data.
///
/// # Errors
/// Returns an error when the home directory can't be resolved or `resume`
/// is not a session id / `.jsonl` file under that root.
pub fn validate_resume(app: &AppHandle, resume: &str, profile: Option<&str>) -> Result<(), String> {
    if resume.is_empty() {
        return Ok(());
    }
    let root = sessions_root_dir(app, profile)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    validate_resume_against_root(&root, resume)
}

// ── history governance: delete / rename ─────────────────────────────────────

/// Canonicalise a session-file `path` coming over IPC and prove it is a
/// `.jsonl` file inside `root` — the same confinement
/// [`validate_resume_against_root`] imposes on resume values, reused by the
/// delete/rename history commands so a crafted frontend value can never
/// move or rewrite a file outside omp's sessions tree.
fn canonical_session_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.starts_with('-') {
        return Err(format!("invalid session path: {path:?}"));
    }
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("session path does not exist: {path:?} ({e})"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("sessions directory unavailable: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(format!(
            "session path {path:?} is outside the sessions directory"
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(format!(
            "session path {path:?} is not a .jsonl session file"
        ));
    }
    Ok(canonical)
}

/// Move a session file (validated to live under `root`) into
/// `<its directory>/.trash/`, creating the directory when missing. A
/// same-named file already in the trash gets a numeric suffix (`.1`,
/// `.2`, … — the first free one) rather than an overwrite, so repeated
/// delete/regenerate cycles never silently destroy earlier trash. Recovery
/// is manual (drag the file back out). omp never reads `.trash/`: the
/// sessions scan skips it by name (see `scan_dir`), so a trashed session
/// vanishes from the history list the moment the file lands there.
pub fn delete_saved_session(root: &Path, path: &str) -> Result<(), String> {
    let canonical = canonical_session_path(root, path)?;
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("session path has no parent: {path:?}"))?;
    let trash = parent.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("failed to create {}: {e}", trash.display()))?;
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("session path has no file name: {path:?}"))?;
    let mut target = trash.join(name);
    // Same-name conflict: `.1`, `.2`, … — first free suffix wins.
    let stem = canonical
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let mut n = 1;
    while target.exists() {
        target = trash.join(format!("{stem}.{n}.jsonl"));
        n += 1;
    }
    fs::rename(&canonical, &target).map_err(|e| {
        format!(
            "failed to move {} into {}: {e}",
            canonical.display(),
            target.display()
        )
    })
}

/// Rewrite a session file's first line (the `title` event — see the
/// `parse_session_file` doc comment; omp always keeps it physically first)
/// with a new `title` field, leaving every other byte of the file
/// untouched. Atomic write via [`crate::json_store::write_atomic`] (the
/// snapshot/temp+rename pattern the JSON stores use).
///
/// `title` is cleaned first: trimmed, newlines and other control
/// characters removed (the file is line-oriented JSONL — a raw newline
/// inside the first line would corrupt it), capped at 120 chars.
///
/// Reads the whole file into memory even though only the first line
/// changes: [`crate::json_store::write_atomic`] writes the destination by
/// rename, so the unchanged tail has to be handed to it as bytes. A
/// multi-GB session file is not a real shape (omp appends JSON events, and
/// the largest real transcripts run in the tens of MB), and the command
/// runs on a `spawn_blocking` thread.
pub fn rename_saved_session(root: &Path, path: &str, title: &str) -> Result<(), String> {
    let canonical = canonical_session_path(root, path)?;
    let cleaned: String = title
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(120)
        .collect();
    if cleaned.is_empty() {
        return Err("title must not be empty".to_string());
    }
    let bytes =
        fs::read(&canonical).map_err(|e| format!("failed to read {}: {e}", canonical.display()))?;
    let first_line_end = bytes
        .iter()
        .position(|&b| b == b'\n')
        .unwrap_or(bytes.len());
    let first = String::from_utf8_lossy(&bytes[..first_line_end]);
    let rest = &bytes[first_line_end..];
    let mut val: serde_json::Value = serde_json::from_str(first.trim())
        .map_err(|e| format!("session first line is not valid JSON: {e}"))?;
    // Only a `title` event's `title` field is replaced; the type and every
    // other field (id, updatedAt, …) survive verbatim, and so does every
    // byte after the first newline.
    if val.get("type").and_then(|t| t.as_str()) != Some("title") {
        return Err(format!(
            "session first line is not a title event: {}",
            canonical.display()
        ));
    }
    let Some(title_slot) = val.get_mut("title").filter(|t| t.is_string()) else {
        return Err(format!(
            "session first line has no title field: {}",
            canonical.display()
        ));
    };
    *title_slot = serde_json::Value::String(cleaned);
    let mut out = serde_json::to_string(&val)
        .map_err(|e| format!("failed to re-serialize title event: {e}"))?
        .into_bytes();
    // `rest` starts with the newline that ended the first line when there
    // was one; only a file whose single line ended without one needs it
    // appended. Never doubled: every other byte after the first line is
    // preserved verbatim.
    if rest.first() != Some(&b'\n') {
        out.push(b'\n');
    }
    out.extend_from_slice(rest);
    crate::json_store::write_atomic(&canonical, &out)
        .map_err(|e| format!("failed to write {}: {e}", canonical.display()))
}

/// [`delete_saved_session`] against `profile`'s sessions directory.
///
/// # Errors
/// Returns an error when the home directory can't be resolved or the move
/// fails (see [`delete_saved_session`]).
pub fn delete_saved_session_for(
    app: &AppHandle,
    path: &str,
    profile: Option<&str>,
) -> Result<(), String> {
    let root = sessions_root_dir(app, profile)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    delete_saved_session(&root, path)
}

/// [`rename_saved_session`] against `profile`'s sessions directory.
///
/// # Errors
/// Returns an error when the home directory can't be resolved or the
/// rewrite fails (see [`rename_saved_session`]).
pub fn rename_saved_session_for(
    app: &AppHandle,
    path: &str,
    title: &str,
    profile: Option<&str>,
) -> Result<(), String> {
    let root = sessions_root_dir(app, profile)
        .ok_or_else(|| "could not resolve home directory".to_string())?;
    rename_saved_session(&root, path, title)
}

#[cfg(test)]
mod tests;
