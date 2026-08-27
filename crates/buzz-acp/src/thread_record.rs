//! Render structured protocol events tied to a thread — asks (44300), their
//! outcomes (44301 resolved / 44302 withdrawn), and decision logs (44303) —
//! as a deterministic `[Thread Record]` prompt section.
//!
//! Purely parse-and-render: no LLM, no inference. Entries are read off signed
//! protocol events; a malformed entry is skipped rather than errored so one
//! broken event can never fail the turn it describes. The section is per-turn
//! (not standing context) because ask status changes mid-session (open ->
//! resolved), and is rendered by [`render_thread_record`].

use std::collections::HashMap;

use nostr::Event;

use crate::queue::{resolve_prompt_label, sanitize_prompt_label, PromptProfileLookup};

/// Cap per category before the `(showing N of M)` truncation note.
const MAX_ASKS: usize = 20;
const MAX_DECISIONS: usize = 20;

/// One Ask (kind 44300) raised from this thread.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadAsk {
    /// Event id, hex. An outcome's `e` tag names this.
    pub id: String,
    /// `decision`, `question`, `credential`, `blocker`, or `stall`.
    pub ask_type: String,
    /// One-line statement of what was needed.
    pub headline: String,
    /// Pubkey of who is waiting for an answer, from the ask's `p` tag.
    pub audience_pubkey: Option<String>,
    /// `created_at`, unix seconds.
    pub created_at_secs: u64,
}

/// How an open ask closed.
#[derive(Debug, Clone, PartialEq)]
pub enum AskOutcomeKind {
    /// Kind 44301, with the recorded answer when present.
    Resolved { answer: Option<String> },
    /// Kind 44302, with its required reason.
    Withdrawn { reason: String },
}

/// A kind 44301/44302 event closing a specific ask (`e` tag).
#[derive(Debug, Clone, PartialEq)]
pub struct AskOutcome {
    /// Event id of the ask this outcome closes.
    pub ask_id: String,
    /// Pubkey of who resolved/withdrew (owner label source).
    pub signer_pubkey: String,
    /// `created_at`, unix seconds.
    pub created_at_secs: u64,
    pub outcome: AskOutcomeKind,
}

/// A kind 44303 decision log linked to this thread via its `e` tag.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadDecision {
    /// Grant category, ASCII-lowercased on ingest.
    pub category: String,
    /// What was decided.
    pub decision: String,
    /// The stateable undo path every logged decision must carry.
    pub undo_path: String,
    /// `created_at`, unix seconds.
    pub created_at_secs: u64,
}

/// Read one kind-44300 ask off an event, or `None` when the event is not an
/// ask or its content is unusable. Skips malformed entries; never errors.
pub fn read_thread_ask(event: &Event) -> Option<ThreadAsk> {
    if event.kind.as_u16() as u32 != buzz_core::kind::KIND_ASK {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let headline = value
        .get("headline")
        .and_then(|v| v.as_str())
        .and_then(sanitize_prompt_label)?;
    let ask_type = event
        .tags
        .iter()
        .find_map(|tag| {
            let parts = tag.as_slice();
            if parts.len() == 2 && parts[0].as_str() == "ask-type" {
                parts.get(1).map(|value| value.as_str())
            } else {
                None
            }
        })
        .or_else(|| value.get("type").and_then(|v| v.as_str()))
        .unwrap_or("question");
    let audience_pubkey = event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.len() == 2 && parts[0].as_str() == "p" {
            Some(parts[1].to_string())
        } else {
            None
        }
    });
    Some(ThreadAsk {
        id: event.id.to_hex(),
        ask_type: sanitize_prompt_label(ask_type)?,
        headline,
        audience_pubkey,
        created_at_secs: event.created_at.as_secs(),
    })
}

/// Read one ask-closing event (kind 44301 resolution or 44302 withdrawal),
/// or `None` when the event is not an outcome, carries no `e` tag naming an
/// ask, or has unusable content. Skips malformed entries; never errors.
///
/// This reads WHICH ask closed and how. It never invents an ask line on its
/// own — see [`render_thread_record`] for how an outcome whose ask was not
/// fetched behaves.
pub fn read_ask_outcome(event: &Event) -> Option<AskOutcome> {
    let outcome = match event.kind.as_u16() as u32 {
        buzz_core::kind::KIND_ASK_RESOLUTION => {
            let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
            // Absent/null answer is not malformed — an acknowledgement-style
            // resolution carries no free text — but any present answer must
            // display sanely or the resolution renders without one.
            let answer = match value.get("answer") {
                Some(v) if !v.is_null() => Some(json_answer_display(v)),
                _ => None,
            };
            AskOutcomeKind::Resolved {
                answer: answer.and_then(|s| sanitize_prompt_label(&s)),
            }
        }
        buzz_core::kind::KIND_ASK_WITHDRAWAL => {
            let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
            // The relay refuses withdrawals without a reason; treat an
            // unreadable one as malformed rather than rendering "[withdrawn]"
            // with nothing to explain why.
            AskOutcomeKind::Withdrawn {
                reason: sanitize_prompt_label(value.get("reason")?.as_str()?)?,
            }
        }
        _ => return None,
    };
    Some(AskOutcome {
        ask_id: e_tag_value(event)?.to_string(),
        signer_pubkey: event.pubkey.to_hex(),
        created_at_secs: event.created_at.as_secs(),
        outcome,
    })
}

/// Read one kind-44303 decision log, or `None` when the event is not a
/// decision log or lacks any of its required non-empty fields (`decision`,
/// `undo_path`, `category`). Skips malformed entries; never errors.
pub fn read_thread_decision(event: &Event) -> Option<ThreadDecision> {
    if event.kind.as_u16() as u32 != buzz_core::kind::KIND_DECISION_LOG {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    Some(ThreadDecision {
        category: sanitize_prompt_label(value.get("category")?.as_str()?)?,
        decision: sanitize_prompt_label(value.get("decision")?.as_str()?)?,
        undo_path: sanitize_prompt_label(value.get("undo_path")?.as_str()?)?,
        created_at_secs: event.created_at.as_secs(),
    })
}

/// Render a non-string JSON answer into display text (strings show bare).
fn json_answer_display(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// First well-formed `e` tag value on an event.
fn e_tag_value(event: &Event) -> Option<&str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() == 2 && parts[0].as_str() == "e").then_some(parts[1].as_str())
    })
}

/// Compact relative age for a timestamp at or before now.
fn relative_age(created_at_secs: u64, now_secs: u64) -> String {
    const MINUTE: u64 = 60;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;
    let secs_ago = now_secs.saturating_sub(created_at_secs);
    match secs_ago {
        s if s < MINUTE => "just now".to_string(),
        s if s < HOUR => format!("{}m ago", s / MINUTE),
        s if s < DAY => format!("{}h ago", s / HOUR),
        s if s < DAY * 7 => format!("{}d ago", s / DAY),
        s => format!("{}w ago", s / (DAY * 7)),
    }
}

/// Label for a pubkey through the profile lookup, falling back to the raw
/// pubkey hex when no profile resolves.
fn actor_label(pubkey: &str, profile_lookup: Option<&PromptProfileLookup>) -> String {
    resolve_prompt_label(pubkey, profile_lookup).unwrap_or_else(|| pubkey.to_string())
}

/// Explicit truncation header: when more than `max` items exist, the header
/// names exactly how many of how many are shown instead of silently dropping
/// the tail.
fn truncated_header(header: &str, total: usize, max: usize) -> String {
    if total > max {
        format!("{header} (showing {max} of {total}):")
    } else {
        format!("{header}:")
    }
}

/// Render the `[Thread Record]` section, or `None` when there is nothing to
/// show (no asks and no decisions) — the caller then emits no block at all.
///
/// Outcome pairing: each outcome applies only when the ask it names was
/// actually fetched in `asks`. An outcome arriving whose ask was not fetched
/// is ignored (a resolution naming an ask the agent cannot find in context
/// would be unanswerable), and any fetched ask still renders `[open]` until
/// its own outcome arrives — so a fetch-window race degrades to "still open",
/// never to an orphaned outcome line.
///
/// Both categories render newest first, with the item's unique key as a
/// deterministic tie-break so two events sharing a created_at second order
/// identically run-to-run.
pub fn render_thread_record(
    asks: &[ThreadAsk],
    outcomes: &[AskOutcome],
    decisions: &[ThreadDecision],
    profile_lookup: Option<&PromptProfileLookup>,
    now_secs: u64,
) -> Option<String> {
    if asks.is_empty() && decisions.is_empty() {
        return None;
    }
    let outcomes_by_ask: HashMap<&str, &AskOutcome> = outcomes
        .iter()
        .filter(|outcome| asks.iter().any(|ask| ask.id == outcome.ask_id))
        .map(|outcome| (outcome.ask_id.as_str(), outcome))
        .collect();

    let mut sections = Vec::new();

    let mut sorted_asks: Vec<&ThreadAsk> = asks.iter().collect();
    sorted_asks.sort_by(|a, b| {
        b.created_at_secs
            .cmp(&a.created_at_secs)
            .then_with(|| b.id.cmp(&a.id))
    });

    let mut ask_lines = Vec::with_capacity(sorted_asks.len());
    for ask in &sorted_asks {
        let age = relative_age(ask.created_at_secs, now_secs);
        let ty = &ask.ask_type;
        let resolved_line = |outcome: &AskOutcome, answer: &Option<String>| {
            let resolver = actor_label(&outcome.signer_pubkey, profile_lookup);
            let outcomed_age = relative_age(outcome.created_at_secs, now_secs);
            match answer {
                Some(text) => {
                    format!(" -> answered by {resolver} ({outcomed_age}): \"{text}\"")
                }
                None => format!(" -> answered by {resolver} ({outcomed_age})"),
            }
        };
        let line = match outcomes_by_ask.get(ask.id.as_str()).map(|o| &o.outcome) {
            Some(AskOutcomeKind::Resolved { answer }) => format!(
                "- [resolved] {ty}: \"{}\"{}",
                ask.headline,
                resolved_line(outcomes_by_ask[ask.id.as_str()], answer)
            ),
            Some(AskOutcomeKind::Withdrawn { reason }) => {
                let outcome = outcomes_by_ask[ask.id.as_str()];
                let withdrawn_age = relative_age(outcome.created_at_secs, now_secs);
                format!(
                    "- [withdrawn] {ty}: \"{}\" (raised {age}, withdrawn \
                     {withdrawn_age}: \"{reason}\")",
                    ask.headline
                )
            }
            None => {
                let audience = ask
                    .audience_pubkey
                    .as_deref()
                    .map(|pk| actor_label(pk, profile_lookup))
                    .unwrap_or_else(|| "unspecified".to_string());
                format!(
                    "- [open] {ty}: \"{}\" (raised {age}, audience: {audience})",
                    ask.headline
                )
            }
        };
        ask_lines.push(line);
    }

    if !ask_lines.is_empty() {
        sections.push(truncated_header("Asks", asks.len(), MAX_ASKS));
        sections.extend(ask_lines.into_iter().take(MAX_ASKS));
    }

    if !decisions.is_empty() {
        let mut sorted_decisions: Vec<&ThreadDecision> = decisions.iter().collect();
        sorted_decisions.sort_by(|a, b| {
            b.created_at_secs
                .cmp(&a.created_at_secs)
                .then_with(|| b.undo_path.cmp(&a.undo_path))
        });
        let decision_lines: Vec<String> = sorted_decisions
            .iter()
            .map(|d| {
                format!(
                    "- [{}] \"{}\" -- undo: {} ({})",
                    d.category,
                    d.decision,
                    d.undo_path,
                    relative_age(d.created_at_secs, now_secs)
                )
            })
            .collect();
        if decisions.len() > MAX_DECISIONS {
            sections.push(format!(
                "Decisions (showing {MAX_DECISIONS} of {} under \
                 delegation grants):",
                decisions.len()
            ));
        } else {
            sections.push("Decisions (under delegation grants):".to_string());
        }
        sections.extend(decision_lines.into_iter().take(MAX_DECISIONS));
    }

    let mut rendered = String::from(
        "[Thread Record]\nStructured events for this thread. These are signed protocol events, complete regardless of how old the thread is.",
    );
    for part in sections {
        rendered.push('\n');
        rendered.push_str(&part);
    }
    Some(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Kind;

    const NOW: u64 = 1_000_000;

    fn event(kind: u32, content: &str, tags: &[&[&str]]) -> Event {
        let keys = nostr::Keys::generate();
        let tag_list: Vec<nostr::Tag> = tags
            .iter()
            .map(|parts| nostr::Tag::parse(parts.iter().copied()).unwrap())
            .collect();
        nostr::EventBuilder::new(Kind::from(kind as u16), content)
            .tags(tag_list)
            .custom_created_at(nostr::Timestamp::from(NOW))
            .sign_with_keys(&keys)
            .unwrap()
    }

    fn ask_event(content: &str, extra_tags: &[&[&str]]) -> Event {
        event(buzz_core::kind::KIND_ASK, content, extra_tags)
    }

    fn lookup_entry(pubkey: &str, display_name: &str) -> PromptProfileLookup {
        let mut map = HashMap::new();
        map.insert(
            pubkey.to_ascii_lowercase(),
            crate::queue::PromptProfile {
                display_name: Some(display_name.to_string()),
                nip05_handle: None,
                is_agent: false,
            },
        );
        map
    }

    #[test]
    fn a_resolved_ask_renders_the_answer_line() {
        let ask = ask_event(
            r#"{"headline":"Ship pricing page v2?"}"#,
            &[&["ask-type", "decision"]],
        );
        let outcome = event(
            buzz_core::kind::KIND_ASK_RESOLUTION,
            r#"{"answer":"Option B"}"#,
            &[&["e", &ask.id.to_hex()]],
        );
        let rendered = render_thread_record(
            &[read_thread_ask(&ask).unwrap()],
            &[read_ask_outcome(&outcome).unwrap()],
            &[],
            None,
            NOW + 2 * 86400,
        )
        .expect("resolved ask must render");
        assert!(rendered.starts_with("[Thread Record]\n"));
        assert!(rendered.contains("Structured events for this thread."));
        assert!(rendered.contains("- [resolved] decision: \"Ship pricing page v2?\""));
        assert!(rendered.contains("answered by"));
        assert!(rendered.contains(": \"Option B\""));
        assert!(rendered.contains("(2d ago)"));
        assert!(!rendered.contains("[open]"), "a resolved ask is not open");
    }

    #[test]
    fn an_open_ask_renders_open_status_and_audience() {
        let audience = nostr::Keys::generate().public_key().to_hex();
        let ask = ask_event(
            r#"{"headline":"Staging DB creds expired"}"#,
            &[&["ask-type", "blocker"], &["p", &audience]],
        );
        let lookup = lookup_entry(&audience, "Owner");
        let rendered = render_thread_record(
            &[read_thread_ask(&ask).unwrap()],
            &[],
            &[],
            Some(&lookup),
            NOW + 3 * 3600,
        )
        .expect("open ask must render");
        assert!(
            rendered.contains(
                "- [open] blocker: \"Staging DB creds expired\" (raised 3h ago, \
                 audience: Owner)"
            ),
            "actual: {rendered}"
        );
    }

    #[test]
    fn a_withdrawn_ask_renders_the_reason() {
        let ask = ask_event(r#"{"headline":"Need pager duty rotation"}"#, &[]);
        let outcome = event(
            buzz_core::kind::KIND_ASK_WITHDRAWAL,
            r#"{"reason":"rotated manually"}"#,
            &[&["e", &ask.id.to_hex()]],
        );
        let rendered = render_thread_record(
            &[read_thread_ask(&ask).unwrap()],
            &[read_ask_outcome(&outcome).unwrap()],
            &[],
            None,
            NOW + 7200,
        )
        .expect("withdrawn ask must render");
        assert!(
            rendered.contains(
                "- [withdrawn] question: \"Need pager duty rotation\" (raised \
                 2h ago, withdrawn 2h ago: \"rotated manually\")"
            ),
            "actual: {rendered}"
        );
    }

    #[test]
    fn a_decision_log_renders_category_undo_path_and_age() {
        let decision = event(
            buzz_core::kind::KIND_DECISION_LOG,
            r#"{"decision":"Bumped relay Postgres to 2x","undo_path":"scale back down","category":"infra"}"#,
            &[&["grant", "g-1"]],
        );
        let rendered = render_thread_record(
            &[],
            &[],
            &[read_thread_decision(&decision).unwrap()],
            None,
            NOW + 86400,
        )
        .expect("decision must render");
        assert!(rendered.contains("Decisions (under delegation grants):"));
        assert!(
            rendered.contains(
                "- [infra] \"Bumped relay Postgres to 2x\" -- undo: scale back \
                 down (1d ago)"
            ),
            "actual: {rendered}"
        );
        assert!(!rendered.contains("Asks:"), "asks block omitted when empty");
    }

    #[test]
    fn asks_render_newest_first() {
        let builder = |created_at: u64| {
            let keys = nostr::Keys::generate();
            nostr::EventBuilder::new(
                Kind::from(buzz_core::kind::KIND_ASK as u16),
                format!(r#"{{"headline":"{created_at}"}}"#),
            )
            .custom_created_at(nostr::Timestamp::from(created_at))
            .sign_with_keys(&keys)
            .unwrap()
        };
        let older = read_thread_ask(&builder(100)).unwrap();
        let newer = read_thread_ask(&builder(200)).unwrap();

        // Feed oldest first so the test proves sorting, not input order.
        let rendered =
            render_thread_record(&[older, newer], &[], &[], None, 1_000).expect("should render");
        // Both headlines are digits themselves; newest (200) must precede
        // oldest (100) inside the Asks block.
        let newer_pos = rendered.find("\"200\"").expect("newest ask rendered");
        let older_pos = rendered.find("\"100\"").expect("oldest ask rendered");
        assert!(newer_pos < older_pos, "asks must render newest first");
    }

    #[test]
    fn capping_adds_an_explicit_showing_note() {
        let asks: Vec<Event> = (0..25)
            .map(|i| ask_event(&format!(r#"{{"headline":"Ask number {i:02}"}}"#), &[]))
            .collect();
        let parsed: Vec<ThreadAsk> = asks.iter().map(|e| read_thread_ask(e).unwrap()).collect();
        let rendered = render_thread_record(&parsed, &[], &[], None, NOW)
            .expect("capped asks must still render");
        assert!(rendered.contains("Asks (showing 20 of 25):"));
        let shown = rendered.lines().filter(|l| l.starts_with("- ")).count();
        assert_eq!(shown, 20);

        let decisions: Vec<ThreadDecision> = (0..23)
            .map(|i| ThreadDecision {
                category: "infra".into(),
                decision: format!("decision {i:02}"),
                undo_path: "revert".into(),
                created_at_secs: i as u64,
            })
            .collect();
        let rendered = render_thread_record(&[], &[], &decisions, None, NOW)
            .expect("capped decisions must render");
        assert!(rendered.contains("Decisions (showing 20 of 23 under delegation grants):"));
    }

    #[test]
    fn malformed_entries_are_skipped_not_errored() {
        // Wrong kind.
        let message = event(buzz_core::kind::KIND_STREAM_MESSAGE, "hello", &[]);
        assert!(read_thread_ask(&message).is_none());
        assert!(read_ask_outcome(&message).is_none());
        assert!(read_thread_decision(&message).is_none());

        // Malformed JSON.
        let broken_ask = ask_event("{not json", &[]);
        assert!(read_thread_ask(&broken_ask).is_none());
        let broken_outcome = event(
            buzz_core::kind::KIND_ASK_RESOLUTION,
            "{oops",
            &[&["e", "deadbeef"]],
        );
        assert!(read_ask_outcome(&broken_outcome).is_none());

        // Missing required fields: no headline; withdrawal without reason;
        // decision missing undo_path/category.
        let no_headline = ask_event(r#"{"type":"question"}"#, &[]);
        assert!(read_thread_ask(&no_headline).is_none());
        let withdrawal_no_reason =
            event(buzz_core::kind::KIND_ASK_WITHDRAWAL, "{}", &[&["e", "aa"]]);
        assert!(read_ask_outcome(&withdrawal_no_reason).is_none());
        let decision_no_undo = event(
            buzz_core::kind::KIND_DECISION_LOG,
            r#"{"decision":"x","category":"infra"}"#,
            &[],
        );
        assert!(read_thread_decision(&decision_no_undo).is_none());

        // Outcome with no e tag naming an ask.
        let resolution_without_e = event(
            buzz_core::kind::KIND_ASK_RESOLUTION,
            r#"{"answer":null}"#,
            &[],
        );
        assert!(read_ask_outcome(&resolution_without_e).is_none());

        // All-malformed input renders no section at all rather than an error.
        assert!(render_thread_record(&[], &[], &[], None, NOW).is_none());
    }

    #[test]
    fn content_control_chars_are_stripped_before_rendering() {
        // The \t here is the two-character JSON escape, so serde_json decodes
        // it into a real tab inside the headline string.
        let ask = ask_event(
            r#"{"headline":"creds rotated\tfor real"}"#,
            &[&["ask-type", "credential"]],
        );
        let parsed = read_thread_ask(&ask).expect("tab-bearing headline parses");
        assert_eq!(parsed.headline, "creds rotatedfor real");
        let rendered = render_thread_record(&[parsed], &[], &[], None, NOW).unwrap();
        let ask_line = rendered
            .lines()
            .find(|l| l.starts_with("- [open]"))
            .unwrap();
        assert_eq!(ask_line.matches('\n').count(), 0);
        assert_eq!(ask_line.matches('\t').count(), 0);
    }

    #[test]
    fn a_resolution_whose_ask_was_not_fetched_leaves_fetched_asks_open() {
        // The race: round trip 2 fetched an outcome naming an ask that round
        // trip 1 never returned. The agent has no [open] line for it, so an
        // orphaned resolved line would point at something it cannot see.
        let fetched_ask = ask_event(r#"{"headline":"Visible ask"}"#, &[&["ask-type", "blocker"]]);
        let unknown_ask_id = nostr::Keys::generate().public_key(); // not the fetched id
        let phantom_resolution = event(
            buzz_core::kind::KIND_ASK_RESOLUTION,
            r#"{"answer":"mystery answer"}"#,
            &[&["e", &unknown_ask_id.to_hex()]],
        );
        let rendered = render_thread_record(
            &[read_thread_ask(&fetched_ask).unwrap()],
            &[read_ask_outcome(&phantom_resolution).unwrap()],
            &[],
            None,
            NOW + 60,
        )
        .expect("the fetched ask must still render");
        assert!(
            rendered.contains("- [open] blocker: \"Visible ask\""),
            "fetched ask degrades to open: {rendered}"
        );
        assert!(!rendered.contains("mystery answer"));
        assert!(!rendered.contains("[resolved]"));
    }
}
