//! The global prompt history: `<app config dir>/prompt-history.json`.
//!
//! The composer's per-tab recall (`live.js` `promptHistories`) dies with
//! the tab; this store is the cross-session, cross-project list the prompt
//! history modal shows under "all sessions". A prompt lands here at the
//! same moment it lands in the per-tab list (`live.js` `_recordPrompt`),
//! already normalized (plan-mode framing stripped).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config_file::ConfigFile;
use crate::text::prefix_within;

/// Longest kept list. Generous next to the per-tab recall cap (the
/// `promptHistoryLimit` tweak, default 100): this list is the archive.
const MAX_PROMPTS: usize = 200;

/// A single stored prompt is capped so a pasted file's worth of text cannot
/// bloat the JSON every user pays to load at startup.
const MAX_PROMPT_BYTES: usize = 8 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptHistoryFile {
    /// Newest first; a re-sent prompt moves to the front, not a duplicate.
    prompts: Vec<String>,
}

pub struct PromptHistoryStore {
    /// The file, or memory (no app config folder: the list lasts for the
    /// app run).
    backing: ConfigFile,
}

impl PromptHistoryStore {
    /// Create a store pointing at `path` (the file need not exist yet), or
    /// a memory-only one for `None`.
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            backing: ConfigFile::new(path),
        }
    }

    /// Newest first. Unlocked: `write_atomic` never exposes a half-written
    /// file, so a read racing a record only sees the previous list.
    pub fn list(&self) -> Vec<String> {
        self.backing.read_or_default::<PromptHistoryFile>().prompts
    }

    /// Record `text` (trimmed, byte-capped) as the most recent prompt and
    /// return the updated list. Empty prompts are a no-op.
    pub fn record(&self, text: &str) -> Result<Vec<String>, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(self.list());
        }
        let capped = prefix_within(trimmed, MAX_PROMPT_BYTES).to_string();
        self.backing
            .update(
                move |file: &mut PromptHistoryFile| {
                    file.prompts.retain(|p| p != &capped);
                    file.prompts.insert(0, capped);
                    file.prompts.truncate(MAX_PROMPTS);
                },
                |_| (),
            )
            // The projection above returns nothing; the updated list is a
            // fresh unlocked read (a cloned projection trips
            // clippy::redundant_clone and buys nothing).
            .map(|()| self.list())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_dedupes_and_orders_newest_first() {
        let store = PromptHistoryStore::new(None);
        store.record("first").unwrap();
        store.record("second").unwrap();
        store.record("first").unwrap();
        assert_eq!(store.list(), vec!["first", "second"]);
    }

    #[test]
    fn record_ignores_blank_and_caps_the_list() {
        let store = PromptHistoryStore::new(None);
        assert_eq!(store.record("   ").unwrap(), Vec::<String>::new());
        for i in 0..MAX_PROMPTS + 20 {
            store.record(&format!("prompt {i}")).unwrap();
        }
        let list = store.list();
        assert_eq!(list.len(), MAX_PROMPTS);
        assert_eq!(list[0], format!("prompt {}", MAX_PROMPTS + 19));
    }

    #[test]
    fn record_caps_a_huge_prompt_without_losing_it() {
        let store = PromptHistoryStore::new(None);
        let huge = "x".repeat(MAX_PROMPT_BYTES * 3);
        store.record(&huge).unwrap();
        assert_eq!(store.list()[0].len(), MAX_PROMPT_BYTES);
    }

    #[test]
    fn a_file_backed_store_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "omp-prompt-history-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let path = dir.join("prompt-history.json");
        PromptHistoryStore::new(Some(path.clone()))
            .record("persisted")
            .unwrap();
        let reopened = PromptHistoryStore::new(Some(path));
        assert_eq!(reopened.list(), vec!["persisted"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
