//! One window of an omp session transcript, read straight from its `.jsonl`
//! file for the paired phone's windowed transcript channel
//! (`docs/architecture/remote-control.md`).
//!
//! `omp`'s own `get_messages` serializes the whole in-memory context, and on a
//! long session that is both expensive to build and far too large for the
//! phone's uplink. The session file on disk already holds those rows, so the
//! window is sliced here instead: one bounded line scan, a cursor identical to
//! the phone's previous `sliceWindow`, and per-block caps so no single block
//! dominates the reply frame.

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};

use serde::Serialize;
use serde_json::Value;

/// Reply size when the caller asks for no particular window.
const DEFAULT_LIMIT: usize = 200;
/// Smallest window the caller may request (the phone needs at least one row).
const MIN_LIMIT: usize = 1;
/// Ceiling on one window, in messages.
const MAX_LIMIT: usize = 1000;
/// Longest block text kept verbatim; longer blocks are cut and marked.
const MAX_BLOCK_CHARS: usize = 4000;
/// Appended to a capped block so the phone's UI can say why it stops.
const TRUNCATION_SUFFIX: &str = "\n…[truncated for phone]";
/// Ceiling on one window's serialized size, in bytes. Per-block caps bound a
/// single block; this bounds the whole reply, because a message may carry
/// many capped blocks and the handset's uplink (a few Mbit/s) turns every
/// extra megabyte into seconds. Oldest rows of the requested window are
/// dropped until the budget holds — the cursor still reports them as older.
const MAX_WINDOW_BYTES: usize = 300_000;

/// One contiguous, oldest-first page of a session's messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWindow {
    /// The rows of this window with their nested `message` objects verbatim
    /// (apart from capped blocks).
    pub messages: Vec<Value>,
    /// Whether the file holds messages older than this window.
    pub has_older: bool,
    /// Cursor for the next page older than this one; pass it as `before`.
    pub next_before: usize,
}

/// Read one window of the transcript at `path`.
///
/// `before` is the exclusive end cursor (absent means the newest page) and
/// `limit` the page size, defaulting to [`DEFAULT_LIMIT`] and clamped to
/// `1..=1000`.
///
/// # Errors
///
/// Returns `Err` when `path` cannot be opened or read; the message includes the
/// underlying I/O error.
#[tauri::command]
pub fn remote_transcript_window(
    path: String,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<TranscriptWindow, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(MIN_LIMIT, MAX_LIMIT);
    let (len, offsets) = scan_messages(&path)?;
    let end = before.map_or(len, |b| b.min(len));
    let mut start = end.saturating_sub(limit);
    // The newest page is what the phone asks for first, and the file's tail
    // is all it needs for that: re-read only the bytes from the window's
    // first row (one seek), never the whole file.
    let from = offsets.get(start).copied().unwrap_or(0);
    let mut window = load_from(&path, from, end - start)?;
    // A message may carry many capped blocks, so the per-block cap alone
    // does not bound the reply: shed the oldest rows until the serialized
    // window fits the uplink budget. Each row is serialized once — the shed
    // loop re-serializing the whole window per drop was seconds of CPU; the
    // cursor follows what was sent.
    let mut sizes: Vec<usize> = window
        .iter()
        .map(|m| serde_json::to_vec(m).map_or(0, |v| v.len()))
        .collect();
    let mut total: usize = sizes.iter().sum();
    while window.len() > 1 && total > MAX_WINDOW_BYTES {
        total -= sizes.remove(0);
        window.remove(0);
        start += 1;
    }

    Ok(TranscriptWindow {
        messages: window,
        has_older: start > 0,
        next_before: start,
    })
}

/// Byte offset of every `message` row, oldest first.
///
/// Rows of other types and rows that do not parse (including lines that are
/// not UTF-8) are skipped: a session file is append-only, so one damaged line
/// must not hide the rest of the history. Offsets let a caller re-read just
/// the tail it needs (see [`load_from`]).
fn scan_messages(path: &str) -> Result<(usize, Vec<u64>), String> {
    let file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut offsets = Vec::new();
    let mut line = Vec::new();
    let mut offset: u64 = 0;

    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("read {path}: {e}"))?;
        if read == 0 {
            break;
        }
        let start = offset;
        offset += read as u64;
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if !is_message_row(text) {
            continue;
        }
        offsets.push(start);
    }

    Ok((offsets.len(), offsets))
}

/// Whether a raw jsonl line is a `message` row, without parsing it: walk the
/// top-level keys and compare the `type` key's string value. The scan runs
/// over every line of a file that reaches hundreds of MB, where a full
/// `serde_json::from_str` per line is seconds of CPU; this is one byte pass.
/// String- and depth-aware, so a `"type"` inside a nested block (omp's
/// serializer orders keys alphabetically — `message.content[].type` comes
/// first) never counts.
fn is_message_row(line: &str) -> bool {
    let b = line.as_bytes();
    let mut i = 0;
    let mut depth = 0i32;
    loop {
        while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n' | b',' | b':') {
            i += 1;
        }
        if i >= b.len() {
            return false;
        }
        match b[i] {
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
            }
            b'[' => i = skip_brackets(b, i),
            b']' => i += 1,
            b'"' => {
                let end = skip_string(b, i);
                if depth == 1 {
                    // A top-level key (raw slice: machine-written keys carry
                    // no escapes); its value decides when the key is `type`.
                    let key = &line[i + 1..end - 1];
                    i = end;
                    while i < b.len() && matches!(b[i], b' ' | b'\t' | b':') {
                        i += 1;
                    }
                    if key == "type" {
                        return line[i..].starts_with("\"message\"");
                    }
                    i = skip_value(b, i);
                } else {
                    i = end;
                }
            }
            _ => i = skip_value(b, i), // number, true, false, null
        }
    }
}

/// Index just past the string starting at `i` (its opening quote).
const fn skip_string(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' => return j + 1,
            _ => j += 1,
        }
    }
    b.len()
}

/// Index just past the `[`/`{` run starting at `i`, strings and nesting aware.
fn skip_brackets(b: &[u8], i: usize) -> usize {
    let (open, close) = (b[i], if b[i] == b'[' { b']' } else { b'}' });
    let mut j = i + 1;
    let mut depth = 1i32;
    while j < b.len() && depth > 0 {
        match b[j] {
            b'"' => j = skip_string(b, j),
            c if c == open => {
                depth += 1;
                j += 1;
            }
            c if c == close => {
                depth -= 1;
                j += 1;
            }
            b'[' | b'{' => j = skip_brackets(b, j),
            _ => j += 1,
        }
    }
    j
}

/// Index just past the scalar/compound value starting at `i`.
fn skip_value(b: &[u8], i: usize) -> usize {
    match b.get(i) {
        Some(b'"') => skip_string(b, i),
        Some(b'[' | b'{') => skip_brackets(b, i),
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']') {
                j += 1;
            }
            j
        }
    }
}

/// `count` message rows from byte offset `from`, oldest first, capped.
fn load_from(path: &str, from: u64, count: usize) -> Result<Vec<Value>, String> {
    let mut file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut messages = Vec::with_capacity(count);
    let mut line = Vec::new();

    while messages.len() < count {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("read {path}: {e}"))?;
        if read == 0 {
            break;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        let Ok(row) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(mut message) = row.get("message").cloned() else {
            continue;
        };
        cap_blocks(&mut message);
        messages.push(message);
    }

    Ok(messages)
}

/// Cap every long text block in `message`'s `content` array in place.
///
/// Only the block types that render as text are touched; ids, roles, images
/// and unknown fields pass through untouched.
fn cap_blocks(message: &mut Value) {
    let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for block in blocks {
        let Some(kind) = block.get("type").and_then(Value::as_str) else {
            continue;
        };
        let field = match kind {
            "text" => "text",
            "thinking" => "thinking",
            "toolResult" => "content",
            _ => continue,
        };
        let Some(slot) = block.get_mut(field) else {
            continue;
        };
        let Some(text) = slot.as_str() else {
            continue;
        };
        if text.chars().count() > MAX_BLOCK_CHARS {
            *slot = Value::String(capped(text));
        }
    }
}

/// `text` cut to [`MAX_BLOCK_CHARS`] chars plus [`TRUNCATION_SUFFIX`].
fn capped(text: &str) -> String {
    let cut = text
        .char_indices()
        .nth(MAX_BLOCK_CHARS)
        .map_or(text.len(), |(byte, _)| byte);
    let mut out = String::with_capacity(cut + TRUNCATION_SUFFIX.len());
    out.push_str(&text[..cut]);
    out.push_str(TRUNCATION_SUFFIX);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp_file(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "omp-remote-transcript-test-{tag}-{}-{n}-{nanos}.jsonl",
            std::process::id()
        ))
    }

    fn message(role: &str, text: &str) -> String {
        serde_json::json!({
            "type": "message",
            "message": {
                "role": role,
                "content": [{"type": "text", "text": text}],
            },
        })
        .to_string()
    }

    /// Five message rows interleaved with two noise rows of other types.
    fn fixture(tag: &str) -> PathBuf {
        let path = unique_temp_file(tag);
        let lines = [
            r#"{"type":"session","version":3}"#.to_owned(),
            message("user", "m0"),
            message("assistant", "m1"),
            r#"{"type":"model_change","model":"x"}"#.to_owned(),
            message("user", "m2"),
            message("assistant", "m3"),
            message("user", "m4"),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").expect("write fixture transcript");
        path
    }

    fn texts(window: &TranscriptWindow) -> Vec<&str> {
        window
            .messages
            .iter()
            .filter_map(|m| {
                m.get("content")
                    .and_then(Value::as_array)
                    .and_then(|b| b.first())
                    .and_then(|b| b.get("text"))
                    .and_then(Value::as_str)
            })
            .collect()
    }

    #[test]
    fn newest_window_reports_older_rows_and_a_cursor() {
        let path = fixture("window");
        let window = remote_transcript_window(path.to_string_lossy().into_owned(), None, Some(2))
            .expect("readable fixture");

        assert_eq!(texts(&window), ["m3", "m4"]);
        assert!(window.has_older);
        assert_eq!(window.next_before, 3);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn head_window_has_no_older_rows() {
        let path = fixture("head");
        let first = remote_transcript_window(path.to_string_lossy().into_owned(), Some(3), Some(3))
            .expect("readable fixture");

        assert_eq!(texts(&first), ["m0", "m1", "m2"]);
        assert!(!first.has_older);
        assert_eq!(first.next_before, 0);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn long_text_block_is_capped_and_the_rest_is_verbatim() {
        let path = unique_temp_file("cap");
        let long = "x".repeat(MAX_BLOCK_CHARS + 500);
        let line = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": long, "annotations": ["keep"]},
                    {"type": "thinking", "thinking": "short"},
                ],
            },
        });
        std::fs::write(&path, line.to_string() + "\n").expect("write fixture transcript");

        let window = remote_transcript_window(path.to_string_lossy().into_owned(), None, None)
            .expect("readable fixture");
        let blocks = window.messages[0]
            .get("content")
            .and_then(Value::as_array)
            .expect("content array");
        let text = blocks[0].get("text").and_then(Value::as_str).expect("text");

        assert!(text.ends_with(TRUNCATION_SUFFIX));
        assert_eq!(
            text.chars().count(),
            MAX_BLOCK_CHARS + TRUNCATION_SUFFIX.chars().count()
        );
        assert_eq!(
            blocks[0].get("annotations"),
            Some(&serde_json::json!(["keep"]))
        );
        assert_eq!(
            blocks[1].get("thinking").and_then(Value::as_str),
            Some("short")
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn scanner_reads_omp_key_order_and_string_traps() {
        // omp serializes keys alphabetically: the nested content block's
        // `type` precedes the row's own. A `"type"` inside a string value
        // must not count either.
        assert!(is_message_row(
            r#"{"message":{"content":[{"type":"text","text":"x"}],"role":"user"},"type":"message"}"#
        ));
        assert!(is_message_row(
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"a \"type\": \"toolResult\" trap"}]}}"#
        ));
        assert!(!is_message_row(r#"{"type":"model_change","model":"x"}"#));
        assert!(!is_message_row(r#"{"type":"session","version":3}"#));
        assert!(!is_message_row(
            r#"{"message":{"content":[{"type":"text"}]},"type":"toolResult"}"#
        ));
        assert!(!is_message_row("not json at all"));
    }

    #[test]
    fn window_reads_rows_written_in_omp_key_order() {
        let path = unique_temp_file("omp-order");
        let rows = (0..5)
            .map(|n| {
                format!(
                    r#"{{"message":{{"content":[{{"type":"text","text":"m{n}"}}],"role":"user"}},"type":"message"}}"#
                )
            })
            .collect::<Vec<_>>();
        std::fs::write(&path, rows.join("\n") + "\n").expect("write fixture transcript");

        let window = remote_transcript_window(path.to_string_lossy().into_owned(), None, Some(2))
            .expect("window over omp-ordered rows");

        assert_eq!(texts(&window), ["m3", "m4"]);
        assert!(window.has_older);
        assert_eq!(window.next_before, 3);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn window_sheds_oldest_rows_to_fit_the_wire_budget() {
        let path = unique_temp_file("budget");
        // Five rows of sixteen capped blocks each (~64 KB apiece after
        // capping): the whole window is over the wire budget, so the oldest
        // rows must be shed while the newest survives.
        let fat = "y".repeat(MAX_BLOCK_CHARS + 10);
        let blocks = (0..16)
            .map(|_| serde_json::json!({"type": "text", "text": fat}))
            .collect::<Vec<_>>();
        let rows = (0..5)
            .map(|n| {
                serde_json::json!({
                    "type": "message",
                    "message": { "role": "user", "content": blocks, "index": n },
                })
                .to_string()
            })
            .collect::<Vec<_>>();
        std::fs::write(&path, rows.join("\n") + "\n").expect("write fixture transcript");

        let window = remote_transcript_window(path.to_string_lossy().into_owned(), None, Some(5))
            .expect("readable fixture");
        let bytes = serde_json::to_vec(&window.messages)
            .expect("serialize")
            .len();

        assert!(bytes <= MAX_WINDOW_BYTES, "window over budget: {bytes}");
        assert!(window.messages.len() < 5, "nothing was shed");
        assert!(window.has_older);
        // The newest row always survives: shedding stops at one row.
        let last = window.messages.last().expect("newest row");
        assert_eq!(last.get("index"), Some(&serde_json::json!(4)));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_errors() {
        let path = unique_temp_file("missing");

        let err =
            remote_transcript_window(path.to_string_lossy().into_owned(), None, None).unwrap_err();

        assert!(err.contains("open"), "unexpected error: {err}");
    }
}

