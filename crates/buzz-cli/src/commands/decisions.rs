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

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;

/// Build a two-element string tag, e.g. `["grant", "grant-copy"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// Build the `EventBuilder` for a decision log (kind [`KIND_DECISION_LOG`])
/// from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_decision_log`'s rules (hard-list category,
/// non-negative amount, required non-empty undo path, ...). Callers MUST
/// self-validate the signed event with [`parse_decision_log`] before
/// submitting it; see `cmd_log`.
fn build_decision_log_event(
    grant: &str,
    tasks: &[String],
    category: &str,
    decision: &str,
    undo_path: &str,
    amount_nano_usd: Option<i64>,
) -> Result<EventBuilder, CliError> {
    let mut tags = vec![tag(&["grant", grant])?];
    for task_id in tasks {
        tags.push(tag(&["task", task_id])?);
    }

    let mut content = serde_json::json!({
        "decision": decision,
        "undo_path": undo_path,
        "category": category,
    });
    if let Some(amount) = amount_nano_usd {
        content["amount_nano_usd"] = serde_json::json!(amount);
    }

    Ok(EventBuilder::new(Kind::Custom(KIND_DECISION_LOG as u16), content.to_string()).tags(tags))
}

/// Record a decision made under a delegation grant (kind
/// [`KIND_DECISION_LOG`]). The relay separately enforces that `category`
/// matches the cited grant's, that the grant is currently active, and that
/// the grant's spending cap (if any) is respected.
async fn cmd_log(
    client: &BuzzClient,
    grant: &str,
    tasks: &[String],
    category: &str,
    decision: &str,
    undo_path: &str,
    amount_nano_usd: Option<i64>,
) -> Result<(), CliError> {
    let builder =
        build_decision_log_event(grant, tasks, category, decision, undo_path, amount_nano_usd)?;
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
/// Same shape as `commands::asks::submit_ask_write`: any `accepted: false`
/// response is surfaced as a write conflict (exit code 5), after printing
/// the full response so nothing is flattened away.
async fn submit_decision_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
    let raw = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&raw));

    if response_accepted(&raw) {
        return Ok(());
    }
    let message = response_message(&raw);
    let reason = message
        .strip_prefix("duplicate: ")
        .or_else(|| message.strip_prefix("conflict: "))
        .unwrap_or(&message)
        .to_owned();
    Err(CliError::Conflict(reason))
}

fn response_accepted(response: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(response)
        .ok()
        .and_then(|value| value.get("accepted").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn response_message(response: &str) -> String {
    serde_json::from_str::<serde_json::Value>(response)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| response.to_owned())
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
        } => {
            cmd_log(
                client,
                &grant,
                &task,
                &category,
                &decision,
                &undo_path,
                amount_nano_usd,
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

    fn signed_decision_log(
        grant: &str,
        tasks: &[String],
        category: &str,
        decision: &str,
        undo_path: &str,
        amount_nano_usd: Option<i64>,
    ) -> nostr::Event {
        let signer = Keys::generate();
        let builder =
            build_decision_log_event(grant, tasks, category, decision, undo_path, amount_nano_usd)
                .expect("build_decision_log_event");
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
        let event = signed_decision_log(
            "grant-copy",
            &tasks,
            "Copy_Change",
            "shortened the title",
            "revert commit abc",
            Some(500_000),
        );
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
        let event = signed_decision_log(
            "grant-copy",
            &tasks,
            "copy_change",
            "shortened the title",
            "revert commit abc",
            None,
        );
        let parsed =
            parse_decision_log(&event).expect("parse_decision_log should accept this event");
        assert_eq!(parsed.amount_nano_usd, None);
    }

    /// A hard-list `--category` must be rejected by self-validation before
    /// any network call.
    #[tokio::test]
    async fn log_rejects_hard_list_category_before_any_network_call() {
        let client = offline_client();
        let tasks = vec!["task-1".to_string()];
        let error = cmd_log(
            &client,
            "grant-spend",
            &tasks,
            "spend",
            "moved money",
            "revert commit abc",
            None,
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
            "grant-copy",
            &tasks,
            "copy_change",
            "shortened the title",
            "revert commit abc",
            Some(-1),
        )
        .await
        .expect_err("a negative amount must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }
}
