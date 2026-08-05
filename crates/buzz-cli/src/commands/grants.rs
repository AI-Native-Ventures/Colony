//! `buzz grants`: the owner-facing surface for Colony delegation grants
//! (kind 30189), the owner-signed heads that let a leader or executive
//! decide a bounded category autonomously.
//!
//! Mirrors `commands/asks.rs`: `create` and `revoke` build the event, then
//! self-validate it against [`buzz_core::interrupt::parse_grant`] before
//! submitting, since the relay enforces the same parser, so a CLI-side
//! rejection here is guaranteed to also be a relay-side rejection, and the
//! agent gets it without a network round trip.

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::interrupt::parse_grant;
use buzz_core::kind::KIND_DELEGATION_GRANT;

use crate::client::{extract_d_tag, normalize_write_response, BuzzClient};
use crate::error::CliError;

/// Build a two-element string tag, e.g. `["d", "grant-copy"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// Build the `EventBuilder` for a delegation grant head (kind
/// [`KIND_DELEGATION_GRANT`]) from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_grant`'s rules (hard-list category, vague
/// scope, non-negative cap, ...). Callers MUST self-validate the signed
/// event with [`parse_grant`] before submitting it; see `cmd_create`.
fn build_grant_event(
    id: &str,
    category: &str,
    scope: &str,
    cap_nano_usd: Option<i64>,
    active: bool,
) -> Result<EventBuilder, CliError> {
    let tags = vec![tag(&["d", id])?];

    let mut content = serde_json::json!({
        "category": category,
        "scope": scope,
        "active": active,
    });
    if let Some(cap) = cap_nano_usd {
        content["cap_nano_usd"] = serde_json::json!(cap);
    }

    Ok(EventBuilder::new(
        Kind::Custom(KIND_DELEGATION_GRANT as u16),
        content.to_string(),
    )
    .tags(tags))
}

/// Publish (or update) a delegation grant head (kind
/// [`KIND_DELEGATION_GRANT`]). A fresh `create` (and every `revoke`, which
/// republishes through this same builder) is always `active: true` at the
/// call site that isn't a revoke; the relay separately enforces that only a
/// current community owner may sign this kind.
async fn cmd_create(
    client: &BuzzClient,
    id: &str,
    category: &str,
    scope: &str,
    cap_nano_usd: Option<i64>,
) -> Result<(), CliError> {
    let builder = build_grant_event(id, category, scope, cap_nano_usd, true)?;
    let event = client.sign_event(builder)?;
    parse_grant(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed grant event failed the relay's own validation ({error}); fix the named \
             field and retry"
        ))
    })?;

    submit_grant_write(client, event).await
}

/// Revoke a grant: read its current head (newest by `created_at` among
/// events whose `d` tag equals `id`), then republish the same
/// category/scope/cap with `active: false`. The record stays; only its
/// `active` flag flips.
async fn cmd_revoke(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_DELEGATION_GRANT] });
    let heads = client.query_all(filter).await?;

    let current = heads
        .into_iter()
        .filter(|event| extract_d_tag(event) == id)
        .max_by_key(|event| {
            event
                .get("created_at")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
        })
        .ok_or_else(|| CliError::Usage(format!("no grant head found with id '{id}'")))?;

    let existing: nostr::Event = serde_json::from_value(current).map_err(|error| {
        CliError::Other(format!(
            "failed to parse existing grant head as an event: {error}"
        ))
    })?;
    let parsed = parse_grant(&existing).map_err(|error| {
        CliError::Usage(format!(
            "existing grant head with id '{id}' failed the relay's own validation ({error})"
        ))
    })?;

    let builder = build_grant_event(
        id,
        &parsed.category,
        &parsed.scope,
        parsed.cap_nano_usd,
        false,
    )?;
    let event = client.sign_event(builder)?;
    parse_grant(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed grant event failed the relay's own validation ({error})"
        ))
    })?;

    submit_grant_write(client, event).await
}

/// List delegation grant heads (kind [`KIND_DELEGATION_GRANT`]), keeping
/// only the newest head per `d` tag, newest first, optionally filtered to
/// grants whose newest head is `active`.
async fn cmd_list(client: &BuzzClient, active_only: bool) -> Result<(), CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_DELEGATION_GRANT] });
    let heads = client.query_all(filter).await?;
    let mut newest = newest_heads_by_d_tag(heads);

    if active_only {
        newest.retain(|event| {
            serde_json::from_value::<nostr::Event>(event.clone())
                .ok()
                .and_then(|parsed_event| parse_grant(&parsed_event).ok())
                .map(|grant| grant.active)
                .unwrap_or(false)
        });
    }

    println!(
        "{}",
        serde_json::to_string(&newest).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Reduce a list of grant-head events to the newest one per `d` tag, sorted
/// newest first by `created_at`.
fn newest_heads_by_d_tag(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut newest: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for event in events {
        let d_tag = extract_d_tag(&event);
        let created_at = event
            .get("created_at")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let should_replace = newest
            .get(&d_tag)
            .map(|existing| {
                let existing_created_at = existing
                    .get("created_at")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                created_at > existing_created_at
            })
            .unwrap_or(true);
        if should_replace {
            newest.insert(d_tag, event);
        }
    }

    let mut result: Vec<serde_json::Value> = newest.into_values().collect();
    result.sort_by(|a, b| {
        let a_created_at = a
            .get("created_at")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let b_created_at = b
            .get("created_at")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        b_created_at.cmp(&a_created_at)
    });
    result
}

/// Submit a signed grant event and report the relay's write result. Same
/// shape as `commands::asks::submit_ask_write`: any `accepted: false`
/// response (including a NIP-33 LWW `"duplicate: ..."` dominance report) is
/// surfaced as a write conflict (exit code 5), after printing the full
/// response so nothing is flattened away.
async fn submit_grant_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
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

/// Dispatch a `buzz grants` subcommand.
pub async fn dispatch(cmd: crate::GrantsCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::GrantsCmd;
    match cmd {
        GrantsCmd::Create {
            id,
            category,
            scope,
            cap_nano_usd,
        } => cmd_create(client, &id, &category, &scope, cap_nano_usd).await,
        GrantsCmd::Revoke { id } => cmd_revoke(client, &id).await,
        GrantsCmd::List { active } => cmd_list(client, active).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn signed_grant(
        id: &str,
        category: &str,
        scope: &str,
        cap_nano_usd: Option<i64>,
        active: bool,
    ) -> nostr::Event {
        let owner = Keys::generate();
        let builder = build_grant_event(id, category, scope, cap_nano_usd, active)
            .expect("build_grant_event");
        builder.sign_with_keys(&owner).expect("sign")
    }

    fn offline_client() -> BuzzClient {
        let keys = Keys::generate();
        BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here")
    }

    /// Step 1 (RED before `build_grant_event` exists): a `create`-shaped
    /// event round-trips through the real parser, not a hand-asserted shape
    /// of our own. Category is lowercased on the way out; cap is preserved.
    #[test]
    fn build_grant_event_round_trips_through_parse_grant() {
        let event = signed_grant(
            "grant-copy",
            "Copy_Change",
            "blog post titles",
            Some(500_000),
            true,
        );
        let parsed =
            parse_grant(&event).expect("parse_grant should accept a CLI-constructed event");

        assert_eq!(parsed.grant_id, "grant-copy");
        assert_eq!(parsed.category, "copy_change");
        assert_eq!(parsed.scope, "blog post titles");
        assert_eq!(parsed.cap_nano_usd, Some(500_000));
        assert!(parsed.active);
    }

    #[test]
    fn build_grant_event_omits_cap_when_absent() {
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, true);
        let parsed = parse_grant(&event).expect("parse_grant should accept this event");
        assert_eq!(parsed.cap_nano_usd, None);
    }

    #[test]
    fn build_grant_event_carries_active_false_for_revoke() {
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, false);
        let parsed = parse_grant(&event).expect("parse_grant should accept this event");
        assert!(!parsed.active);
    }

    /// A hard-list `--category` (e.g. "spend") must be rejected by
    /// self-validation before any network call.
    #[tokio::test]
    async fn create_rejects_hard_list_category_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(&client, "grant-spend", "spend", "some scope", None)
            .await
            .expect_err("a hard-list category must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A wildcard `--scope` ("*") must be rejected by self-validation before
    /// any network call.
    #[tokio::test]
    async fn create_rejects_wildcard_scope_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(&client, "grant-copy", "copy_change", "*", None)
            .await
            .expect_err("a wildcard scope must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A negative `--cap-nano-usd` must be rejected by self-validation
    /// before any network call.
    #[tokio::test]
    async fn create_rejects_negative_cap_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(
            &client,
            "grant-copy",
            "copy_change",
            "blog post titles",
            Some(-1),
        )
        .await
        .expect_err("a negative cap must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }
}
