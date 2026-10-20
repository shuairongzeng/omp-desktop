//! Projected event replay for the paired phone
//! (`docs/architecture/remote-control.md`).
//!
//! `AgentBridge::replay_events` answers "what did this tab miss after `seq`?"
//! for a local webview that reassembles everything it sees. The handset is a
//! different consumer: its history comes from the windowed transcript channel
//! ([`crate::remote_transcript`]), so the chunked `rpc_chunk` frames that
//! dominate a busy replay are pure cost over its few-Mbit/s uplink — hundreds
//! of kilobytes the phone will never reassemble. It also only needs the
//! disconnect gap, not the whole journal window: anything older is covered by
//! its existing windowed refetch.
//!
//! This module wraps the journal query with that projection. The wire shape of
//! [`Replay`] is untouched, so the frontend parses the reply exactly like
//! `replay_events`.

use tauri::State;

use crate::agent::journal::{JournalEvent, Replay};
use crate::agent::AgentBridge;

/// Most events a projected replay carries. The phone recovers older misses
/// from its windowed transcript refetch, so those events would only lengthen
/// the reply.
const MAX_PROJECTED_EVENTS: usize = 400;

/// Events a session's frontend hasn't seen yet, projected for the paired
/// phone: `rpc_chunk` frames removed and the reply bounded to the newest
/// [`MAX_PROJECTED_EVENTS`] events.
///
/// `after_seq` behaves exactly as in `replay_events`. When the projection
/// itself removed events, `dropped` is set so the phone falls back to its
/// transcript refetch for the gap.
///
/// # Errors
///
/// Returns `Err` when the session's journal cannot be read — for instance
/// when `session_id` is unknown.
#[tauri::command]
pub fn remote_replay_events(
    bridge: State<'_, AgentBridge>,
    session_id: String,
    after_seq: u64,
) -> Result<Replay, String> {
    bridge
        .replay_events(&session_id, after_seq)
        .map(project_replay)
}

/// Remove the frames the phone cannot use and bound the count.
///
/// Events whose `text` parses to a JSON object with `type == "rpc_chunk"`
/// are dropped: the phone's content arrives from its transcript window
/// instead. Text that does not parse is kept — it may be a raw line the
/// phone's live path understands. Event contents and `head_seq` are never
/// mutated.
///
/// The newest [`MAX_PROJECTED_EVENTS`] surviving events are kept; older ones
/// are dropped and reported through `dropped`, which also passes any existing
/// `dropped` through untouched.
#[must_use]
pub fn project_replay(replay: Replay) -> Replay {
    let Replay {
        events,
        head_seq,
        dropped,
    } = replay;
    // Walk newest-first so the cap stops the work early: a long replay is
    // mostly chunks the phone will never see, and parsing the events that
    // the cap discards anyway would cost the same CPU we are saving on the
    // wire.
    let mut kept: Vec<JournalEvent> = Vec::with_capacity(events.len().min(MAX_PROJECTED_EVENTS));
    let mut capped = false;
    for event in events.into_iter().rev() {
        if is_rpc_chunk(&event.text) {
            continue;
        }
        if kept.len() == MAX_PROJECTED_EVENTS {
            capped = true;
            break;
        }
        kept.push(event);
    }
    kept.reverse();
    Replay {
        events: kept,
        head_seq,
        dropped: dropped || capped,
    }
}

/// Whether `text` is an `rpc_chunk` envelope.
///
/// These carry slices of one large RPC reply; without the rest of the reply
/// the phone cannot use a slice, and its transcript window supplies the
/// content. Unparseable text is not a chunk.
fn is_rpc_chunk(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|value| {
        value.get("type").and_then(serde_json::Value::as_str) == Some("rpc_chunk")
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{project_replay, JournalEvent, Replay, MAX_PROJECTED_EVENTS};

    fn event(seq: u64, text: impl AsRef<str>) -> JournalEvent {
        JournalEvent {
            seq,
            text: Arc::from(text.as_ref()),
        }
    }

    fn replay(events: Vec<JournalEvent>, head_seq: u64, dropped: bool) -> Replay {
        Replay {
            events,
            head_seq,
            dropped,
        }
    }

    fn seqs(replay: &Replay) -> Vec<u64> {
        replay.events.iter().map(|event| event.seq).collect()
    }

    #[test]
    fn rpc_chunk_events_are_dropped() {
        let projected = project_replay(replay(
            vec![
                event(1, r#"{"type":"message","text":"hi"}"#),
                event(2, r#"{"type":"rpc_chunk","id":"r1","index":0}"#),
                event(3, r#"{"type":"stdout","line":"$ ls"}"#),
            ],
            3,
            false,
        ));
        assert_eq!(seqs(&projected), vec![1, 3]);
        assert_eq!(
            &*projected.events[0].text,
            r#"{"type":"message","text":"hi"}"#
        );
        assert!(!projected.dropped);
    }

    #[test]
    fn unparseable_text_is_kept() {
        let raw = "not json at all";
        let projected = project_replay(replay(
            vec![
                event(1, raw),
                event(2, r#"["rpc_chunk"]"#),
                event(3, r#"{"type":"rpc_chunk""#),
                event(4, r#"{"type":"rpc_chunk"}"#),
            ],
            4,
            false,
        ));
        assert_eq!(seqs(&projected), vec![1, 2, 3]);
        assert_eq!(&*projected.events[0].text, raw);
    }

    #[test]
    fn cap_keeps_newest_400_and_sets_dropped() {
        let events = (1..=MAX_PROJECTED_EVENTS as u64 + 100)
            .map(|seq| event(seq, format!(r#"{{"type":"message","seq":{seq}}}"#)))
            .collect();
        let projected = project_replay(replay(events, 500, false));
        assert_eq!(projected.events.len(), MAX_PROJECTED_EVENTS);
        assert_eq!(seqs(&projected)[0], 101);
        assert_eq!(*seqs(&projected).last().unwrap(), 500);
        assert!(projected.dropped);
    }

    #[test]
    fn exactly_400_events_do_not_set_dropped() {
        let events = (1..=MAX_PROJECTED_EVENTS as u64)
            .map(|seq| event(seq, format!(r#"{{"type":"message","seq":{seq}}}"#)))
            .collect();
        let projected = project_replay(replay(events, 400, false));
        assert_eq!(projected.events.len(), MAX_PROJECTED_EVENTS);
        assert!(!projected.dropped);
    }

    #[test]
    fn cap_counts_only_kept_events() {
        // 500 chunks followed by 500 messages: the chunks must not consume
        // any of the 400 slots.
        let events = (1..=1000)
            .map(|seq| {
                let text = if seq <= 500 {
                    format!(r#"{{"type":"rpc_chunk","index":{seq}}}"#)
                } else {
                    format!(r#"{{"type":"message","seq":{seq}}}"#)
                };
                event(seq, text)
            })
            .collect();
        let projected = project_replay(replay(events, 1000, false));
        assert_eq!(projected.events.len(), MAX_PROJECTED_EVENTS);
        assert_eq!(seqs(&projected)[0], 601);
        assert!(projected.dropped);
    }

    #[test]
    fn dropped_passes_through() {
        let projected = project_replay(replay(
            vec![
                event(1, r#"{"type":"stdout","line":"a"}"#),
                event(2, r#"{"type":"stdout","line":"b"}"#),
            ],
            2,
            true,
        ));
        assert_eq!(seqs(&projected), vec![1, 2]);
        assert!(projected.dropped);
    }

    #[test]
    fn head_seq_is_untouched() {
        let projected = project_replay(replay(
            vec![event(7, r#"{"type":"rpc_chunk","id":"r"}"#)],
            9,
            false,
        ));
        assert_eq!(projected.head_seq, 9);
    }

    #[test]
    fn empty_replay_stays_empty() {
        let projected = project_replay(replay(Vec::new(), 0, false));
        assert!(projected.events.is_empty());
        assert_eq!(projected.head_seq, 0);
        assert!(!projected.dropped);
    }
}
