//! `buzz decisions`: the leader/executive-facing surface for Colony
//! decision logs (kind 44303), the audit trail written when an agent
//! decides something on its own authority under a delegation grant (`buzz
//! grants`, kind 30189).
//!
//! Mirrors `commands/asks.rs`: `log` builds the event, then self-validates
//! it against [`buzz_core::interrupt::parse_decision_log`] before
//! submitting, since the relay enforces the same parser, so a CLI-side
//! rejection here is guaranteed to also be a relay-side rejection, and the
//! agent gets it without a network round trip.

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::interrupt::parse_decision_log;
use buzz_core::kind::KIND_DECISION_LOG;

use crate::client::{normalize_write_response, write_conflict_reason, BuzzClient};
use crate::error::CliError;
use crate::validate::validate_hex64;

/// Build a two-element string tag, e.g. `["grant", "grant-copy"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// The validated fields of a decision log, shared by `cmd_log` and
/// [`build_decision_log_event`] so neither crosses clippy's arity limit.
/// Same shape-and-purpose as `commands::asks::AskEventFields`: borrowed,
/// parser-facing values extracted from the clap arguments.
struct DecisionLogFields<'a> {
    /// The delegation grant id this decision was made under.
    grant: &'a str,
    /// Task ids this decision covers, at least one.
    task_ids: &'a [String],
    /// Content `category` field.
    category: &'a str,
    /// Content `decision` field.
    decision: &'a str,
    /// Content `undo_path` field.
    undo_path: &'a str,
    /// Money moved, in integer nanoUSD, when any.
    amount_nano_usd: Option<i64>,
    /// Origin thread root event id, 64-char hex.
    thread_hex: Option<&'a str>,
}

/// Build the `EventBuilder` for a decision log (kind [`KIND_DECISION_LOG`])
/// from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_decision_log`'s rules (hard-list category,
/// non-negative amount, required non-empty undo path, ...). Callers MUST
/// self-validate the signed event with [`parse_decision_log`] before
/// submitting it; see `cmd_log`.
fn build_decision_log_event(fields: &DecisionLogFields) -> Result<EventBuilder, CliError> {
    let mut tags = vec![tag(&["grant", fields.grant])?];
    for task_id in fields.task_ids {
        tags.push(tag(&["task", task_id])?);
    }
    if let Some(thread) = fields.thread_hex {
        tags.push(tag(&["e", thread])?);
    }

    let mut content = serde_json::json!({
        "decision": fields.decision,
        "undo_path": fields.undo_path,
        "category": fields.category,
    });
    if let Some(amount) = fields.amount_nano_usd {
        content["amount_nano_usd"] = serde_json::json!(amount);
    }

    Ok(EventBuilder::new(Kind::Custom(KIND_DECISION_LOG as u16), content.to_string()).tags(tags))
}

/// Record a decision made under a delegation grant (kind
/// [`KIND_DECISION_LOG`]). The relay separately enforces that `category`
/// matches the cited grant's, that the grant is currently active, and that
/// the grant's spending cap (if any) is respected.
async fn cmd_log(client: &BuzzClient, fields: &DecisionLogFields<'_>) -> Result<(), CliError> {
    if let Some(thread) = fields.thread_hex {
        validate_hex64(thread)?;
    }

    let builder = build_decision_log_event(fields)?;
    let event = client.sign_event(builder)?;
    parse_decision_log(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed decision log event failed the relay's own validation ({error}); fix \
             the named field and retry"
        ))
    })?;

    submit_decision_write(client, event).await
}

/// List decision logs (kind [`KIND_DECISION_LOG`]), newest first.
async fn cmd_list(client: &BuzzClient) -> Result<(), CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_DECISION_LOG] });
    let logs = client.query_all(filter).await?;
    println!(
        "{}",
        serde_json::to_string(&logs).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Submit a signed decision log event and report the relay's write result.
/// Same shape as `commands::asks::submit_ask_write`: any response the relay
/// did not durably store is surfaced as a write conflict (exit code 5),
/// after printing the full response so nothing is flattened away.
/// Classification is [`write_conflict_reason`]'s; see its doc comment for
/// why `accepted` alone is not the test.
async fn submit_decision_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
    let raw = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&raw));

    match write_conflict_reason(&raw) {
        Some(reason) => Err(CliError::Conflict(reason)),
        None => Ok(()),
    }
}

/// Dispatch a `buzz decisions` subcommand.
pub async fn dispatch(cmd: crate::DecisionsCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::DecisionsCmd;
    match cmd {
        DecisionsCmd::Log {
            grant,
            task,
            category,
            decision,
            undo_path,
            amount_nano_usd,
            thread,
        } => {
            cmd_log(
                client,
                &DecisionLogFields {
                    grant: &grant,
                    task_ids: &task,
                    category: &category,
                    decision: &decision,
                    undo_path: &undo_path,
                    amount_nano_usd,
                    thread_hex: thread.as_deref(),
                },
            )
            .await
        }
        DecisionsCmd::List {} => cmd_list(client).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn fields<'a>(
        grant: &'a str,
        tasks: &'a [String],
        category: &'a str,
        decision: &'a str,
        undo_path: &'a str,
        amount_nano_usd: Option<i64>,
    ) -> DecisionLogFields<'a> {
        DecisionLogFields {
            grant,
            task_ids: tasks,
            category,
            decision,
            undo_path,
            amount_nano_usd,
            thread_hex: None,
        }
    }

    fn signed_decision_log(fields: &DecisionLogFields) -> nostr::Event {
        let signer = Keys::generate();
        let builder = build_decision_log_event(fields).expect("build_decision_log_event");
        builder.sign_with_keys(&signer).expect("sign")
    }

    fn offline_client() -> BuzzClient {
        let keys = Keys::generate();
        BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here")
    }

    /// Step 1 (RED before `build_decision_log_event` exists): a
    /// `log`-shaped event round-trips through the real parser, not a
    /// hand-asserted shape of our own -- grant tag, every task tag,
    /// category, and amount all survive the round trip.
    #[test]
    fn build_decision_log_event_round_trips_through_parse_decision_log() {
        let tasks = vec!["task-1".to_string(), "task-2".to_string()];
        let event = signed_decision_log(&fields(
            "grant-copy",
            &tasks,
            "Copy_Change",
            "shortened the title",
            "revert commit abc",
            Some(500_000),
        ));
        let parsed = parse_decision_log(&event)
            .expect("parse_decision_log should accept a CLI-constructed event");

        assert_eq!(parsed.grant_id, "grant-copy");
        assert_eq!(parsed.task_ids, tasks);
        assert_eq!(parsed.category, "copy_change");
        assert_eq!(parsed.decision, "shortened the title");
        assert_eq!(parsed.undo_path, "revert commit abc");
        assert_eq!(parsed.amount_nano_usd, Some(500_000));
    }

    #[test]
    fn build_decision_log_event_omits_amount_when_absent() {
        let tasks = vec!["task-1".to_string()];
        let event = signed_decision_log(&fields(
            "grant-copy",
            &tasks,
            "copy_change",
            "shortened the title",
            "revert commit abc",
            None,
        ));
        let parsed =
            parse_decision_log(&event).expect("parse_decision_log should accept this event");
        assert_eq!(parsed.amount_nano_usd, None);
    }

    /// The optional origin-thread `e` tag mirrors `buzz asks raise --thread`:
    /// when present it must land on the event verbatim, and the parser --
    /// which treats the tag as informational -- must still accept the event.
    #[test]
    fn build_decision_log_event_includes_e_tag_for_thread() {
        let tasks = vec!["task-1".to_string()];
        let thread = "b".repeat(64);
        let mut log_fields = fields(
            "grant-copy",
            &tasks,
            "copy_change",
            "shortened the title",
            "revert commit abc",
            None,
        );
        log_fields.thread_hex = Some(&thread);
        let event = signed_decision_log(&log_fields);

        assert_eq!(
            event
                .tags
                .iter()
                .filter(|tag| tag.kind().to_string() == "e")
                .map(|tag| tag.content().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec![thread.as_str()]
        );

        parse_decision_log(&event)
            .expect("parse_decision_log should accept an event carrying an e tag");
    }

    /// A malformed `--thread` must be rejected by validation before any
    /// event is built or network call made.
    #[tokio::test]
    async fn log_rejects_malformed_thread_before_any_network_call() {
        let client = offline_client();
        let tasks = vec!["task-1".to_string()];
        let mut log_fields = fields(
            "grant-copy",
            &tasks,
            "copy_change",
            "shortened the title",
            "revert commit abc",
            None,
        );
        log_fields.thread_hex = Some("nothex");
        let error = cmd_log(&client, &log_fields)
            .await
            .expect_err("a malformed --thread must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A hard-list `--category` must be rejected by self-validation before
    /// any network call.
    #[tokio::test]
    async fn log_rejects_hard_list_category_before_any_network_call() {
        let client = offline_client();
        let tasks = vec!["task-1".to_string()];
        let error = cmd_log(
            &client,
            &fields(
                "grant-spend",
                &tasks,
                "spend",
                "moved money",
                "revert commit abc",
                None,
            ),
        )
        .await
        .expect_err("a hard-list category must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A negative `--amount-nano-usd` must be rejected by self-validation
    /// before any network call.
    #[tokio::test]
    async fn log_rejects_negative_amount_before_any_network_call() {
        let client = offline_client();
        let tasks = vec!["task-1".to_string()];
        let error = cmd_log(
            &client,
            &fields(
                "grant-copy",
                &tasks,
                "copy_change",
                "shortened the title",
                "revert commit abc",
                Some(-1),
            ),
        )
        .await
        .expect_err("a negative amount must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }
}
