//! `buzz asks`: the agent-facing surface for Colony's interrupt protocol.
//!
//! Every subcommand here constructs the exact tags/content shape
//! `buzz_core::interrupt` parses (kinds 44300-44302). `raise` and
//! `escalate` self-validate the event they just signed against
//! [`buzz_core::interrupt::parse_ask`] before submitting it, since the relay
//! enforces the same parser, so a CLI-side rejection here is guaranteed to
//! also be a relay-side rejection, and the agent gets it without a network
//! round trip. `answer` and `withdraw` do the same against
//! [`parse_resolution`]/[`parse_withdrawal`].

use std::collections::HashSet;

use nostr::{EventBuilder, Kind, PublicKey, Tag};

use buzz_core::interrupt::{parse_ask, parse_resolution, parse_withdrawal, AskType};
use buzz_core::kind::{KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL};

use crate::client::{extract_tag_value, normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{read_or_stdin, validate_hex64, validate_uuid};
use crate::AskFileArgs;

/// Fully-validated fields for constructing an Ask event (kind
/// [`KIND_ASK`]). Shared by `raise` and `escalate`: escalate is exactly
/// this plus a `prior` tag and a new audience; see [`build_ask_event`].
struct AskEventFields<'a> {
    ask_type: &'a str,
    audience_hex: &'a str,
    initiative_id: &'a str,
    task_ids: &'a [String],
    need_key: &'a str,
    thread_hex: Option<&'a str>,
    prior_hex: Option<&'a str>,
    category: Option<&'a str>,
    channel: Option<&'a str>,
    headline: &'a str,
    cost_of_delay: &'a str,
    options: &'a [(String, String)],
    default_option: Option<&'a str>,
    window_secs: Option<u64>,
}

/// Build a two-element string tag, e.g. `["need", "batch-size"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// Build the `EventBuilder` for a Colony interrupt Ask (kind [`KIND_ASK`])
/// from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_ask`'s rules (need-slug format, hard-list
/// vs. `default_option`, `default_window_secs` bounds, ...). Callers MUST
/// self-validate the signed event with [`parse_ask`] before submitting it;
/// see `cmd_raise_ask`.
fn build_ask_event(fields: &AskEventFields) -> Result<EventBuilder, CliError> {
    let audience = PublicKey::from_hex(fields.audience_hex)
        .map_err(|error| CliError::Usage(format!("invalid --to pubkey: {error}")))?;

    let mut tags = vec![
        tag(&["ask-type", fields.ask_type])?,
        Tag::public_key(audience),
        tag(&["initiative", fields.initiative_id])?,
        tag(&["need", fields.need_key])?,
    ];
    for task_id in fields.task_ids {
        tags.push(tag(&["task", task_id])?);
    }
    if let Some(thread) = fields.thread_hex {
        tags.push(tag(&["e", thread])?);
    }
    if let Some(prior) = fields.prior_hex {
        tags.push(tag(&["prior", prior])?);
    }
    if let Some(category) = fields.category {
        tags.push(tag(&["category", category])?);
    }
    if let Some(channel) = fields.channel {
        tags.push(tag(&["h", channel])?);
    }

    let mut content = serde_json::json!({
        "headline": fields.headline,
        "cost_of_delay": fields.cost_of_delay,
    });
    if !fields.options.is_empty() {
        content["options"] = serde_json::Value::Array(
            fields
                .options
                .iter()
                .map(|(label, consequence)| {
                    serde_json::json!({ "label": label, "consequence": consequence })
                })
                .collect(),
        );
    }
    if let Some(default_option) = fields.default_option {
        content["default_option"] = serde_json::Value::String(default_option.to_string());
    }
    if let Some(window_secs) = fields.window_secs {
        content["default_window_secs"] = serde_json::json!(window_secs);
    }

    Ok(EventBuilder::new(Kind::Custom(KIND_ASK as u16), content.to_string()).tags(tags))
}

/// Build the `EventBuilder` for an Ask resolution (kind
/// [`KIND_ASK_RESOLUTION`]). Callers MUST self-validate the signed event
/// with [`parse_resolution`] before submitting it.
fn build_resolution_event(
    ask_hex: &str,
    answer: serde_json::Value,
) -> Result<EventBuilder, CliError> {
    let tags = vec![tag(&["e", ask_hex])?];
    let content = serde_json::json!({ "answer": answer }).to_string();
    Ok(EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content).tags(tags))
}

/// Build the `EventBuilder` for an Ask withdrawal (kind
/// [`KIND_ASK_WITHDRAWAL`]). Callers MUST self-validate the signed event
/// with [`parse_withdrawal`] before submitting it.
fn build_withdrawal_event(ask_hex: &str, reason: &str) -> Result<EventBuilder, CliError> {
    let tags = vec![tag(&["e", ask_hex])?];
    let content = serde_json::json!({ "reason": reason }).to_string();
    Ok(EventBuilder::new(Kind::Custom(KIND_ASK_WITHDRAWAL as u16), content).tags(tags))
}

/// Canonicalize a CLI `--type` value, rejecting `stall` (relay-generated
/// only, see `buzz_core::interrupt::AskType`'s docs). `clap`'s own
/// `value_parser` already restricts this flag to the four filable
/// variants; this is defense in depth against a future clap change, not
/// the primary gate.
fn ask_type_str(raw: &str) -> Result<&'static str, CliError> {
    match AskType::parse(raw) {
        Some(AskType::Stall) => Err(CliError::Usage(
            "ask-type 'stall' is relay-generated (a task going event-silent); it cannot be \
             filed directly. Use decision, question, credential, or blocker."
                .into(),
        )),
        Some(parsed) => Ok(parsed.as_str()),
        None => Err(CliError::Usage(format!(
            "unknown --type '{raw}'; must be one of decision, question, credential, blocker"
        ))),
    }
}

/// Parse `--option label=consequence` flags into `(label, consequence)` pairs.
fn parse_options(raw: &[String]) -> Result<Vec<(String, String)>, CliError> {
    raw.iter()
        .map(|entry| {
            let (label, consequence) = entry.split_once('=').ok_or_else(|| {
                CliError::Usage(format!(
                    "invalid --option '{entry}': expected format label=consequence"
                ))
            })?;
            if label.is_empty() {
                return Err(CliError::Usage(format!(
                    "invalid --option '{entry}': label must not be empty"
                )));
            }
            Ok((label.to_string(), consequence.to_string()))
        })
        .collect()
}

/// File a new Ask (`raise`) or re-file one upward (`escalate`, when
/// `prior` is `Some`). Both share this construction path: escalate is
/// exactly a raise plus a `prior` tag and a new audience.
async fn cmd_raise_ask(
    client: &BuzzClient,
    fields: &AskFileArgs,
    prior: Option<&str>,
) -> Result<(), CliError> {
    let ask_type = ask_type_str(&fields.ask_type)?;
    validate_hex64(&fields.to)?;
    if let Some(prior_hex) = prior {
        validate_hex64(prior_hex)?;
    }
    if let Some(thread) = &fields.thread {
        validate_hex64(thread)?;
    }
    if let Some(channel) = &fields.channel {
        validate_uuid(channel)?;
    }

    // Signing an event whose `p` tag names the signer itself silently
    // drops that tag (nostr::EventBuilder's default self-tagging guard),
    // which would otherwise surface here as an opaque "tag `p` must
    // appear exactly once" parse error. Catch it explicitly so the agent
    // is told exactly what to change.
    let my_pubkey = client.keys().public_key().to_hex();
    if fields.to.eq_ignore_ascii_case(&my_pubkey) {
        return Err(CliError::Usage(format!(
            "--to must not be the filer's own pubkey ({my_pubkey}); an ask can only go to a \
             different agent one tier up (worker -> its leader, leader -> the executive, \
             executive -> a community owner)"
        )));
    }

    let cost_of_delay = read_or_stdin(&fields.cost_of_delay)?;
    let headline = read_or_stdin(&fields.headline)?;
    let options = parse_options(&fields.option)?;

    let builder = build_ask_event(&AskEventFields {
        ask_type,
        audience_hex: &fields.to,
        initiative_id: &fields.initiative,
        task_ids: &fields.task,
        need_key: &fields.need,
        thread_hex: fields.thread.as_deref(),
        prior_hex: prior,
        category: fields.category.as_deref(),
        channel: fields.channel.as_deref(),
        headline: &headline,
        cost_of_delay: &cost_of_delay,
        options: &options,
        default_option: fields.default.as_deref(),
        window_secs: fields.window_secs,
    })?;

    let event = client.sign_event(builder)?;
    parse_ask(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed ask event failed the relay's own validation ({error}); fix the named \
             field and retry"
        ))
    })?;

    submit_ask_write(client, event).await
}

/// List asks (kind [`KIND_ASK`]), optionally scoped to asks addressed to
/// me (`--audience me`), filed by me (`--filed-by me`), and/or currently
/// open (`--status open`).
///
/// Ask status (open/resolved/withdrawn) lives only in the relay's internal
/// `asks` projection table, which has no HTTP read surface, so
/// `--status open` is computed here from the public event stream: an ask
/// is open unless a resolution or withdrawal (kind 44301/44302) names it
/// via `e`.
async fn cmd_list_asks(
    client: &BuzzClient,
    audience: Option<&str>,
    filed_by: Option<&str>,
    status: Option<&str>,
) -> Result<(), CliError> {
    let my_pubkey = client.keys().public_key().to_hex();
    let mut filter = serde_json::json!({ "kinds": [KIND_ASK] });
    if audience == Some("me") {
        filter["#p"] = serde_json::json!([my_pubkey]);
    }
    if filed_by == Some("me") {
        filter["authors"] = serde_json::json!([my_pubkey]);
    }

    let mut asks = client.query_all(filter).await?;
    if status == Some("open") {
        asks = filter_open_asks(client, asks).await?;
    }

    println!(
        "{}",
        serde_json::to_string(&asks).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Drop any ask event that already has a resolution or withdrawal
/// pointing at it via `e`.
async fn filter_open_asks(
    client: &BuzzClient,
    asks: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, CliError> {
    if asks.is_empty() {
        return Ok(asks);
    }
    let ask_ids: Vec<String> = asks
        .iter()
        .filter_map(|event| event.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();

    let closing_filter = serde_json::json!({
        "kinds": [KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL],
        "#e": ask_ids,
    });
    let closing_events = client.query_all(closing_filter).await?;
    let closed_ids: HashSet<String> = closing_events
        .iter()
        .map(|event| extract_tag_value(event, "e"))
        .filter(|id| !id.is_empty())
        .collect();

    Ok(asks
        .into_iter()
        .filter(|event| {
            let id = event
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            !closed_ids.contains(id)
        })
        .collect())
}

/// Answer an open ask (kind [`KIND_ASK_RESOLUTION`]).
///
/// Resolutions carry no `h` tag: they are global events. A channel-scoped
/// auth token will be rejected; use one authorized to write global events.
async fn cmd_answer_ask(client: &BuzzClient, ask: &str, answer_json: &str) -> Result<(), CliError> {
    validate_hex64(ask)?;
    let raw_answer = read_or_stdin(answer_json)?;
    let answer: serde_json::Value = serde_json::from_str(&raw_answer)
        .map_err(|error| CliError::Usage(format!("--answer-json is not valid JSON: {error}")))?;

    let builder = build_resolution_event(ask, answer)?;
    let event = client.sign_event(builder)?;
    parse_resolution(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed resolution event failed the relay's own validation ({error})"
        ))
    })?;

    submit_ask_write(client, event).await
}

/// Withdraw an open ask (kind [`KIND_ASK_WITHDRAWAL`]): only the
/// executive or the relay may do this; the relay enforces that.
///
/// Withdrawals carry no `h` tag: they are global events. A channel-scoped
/// auth token will be rejected; use one authorized to write global events.
async fn cmd_withdraw_ask(client: &BuzzClient, ask: &str, reason: &str) -> Result<(), CliError> {
    validate_hex64(ask)?;
    let reason = read_or_stdin(reason)?;

    let builder = build_withdrawal_event(ask, &reason)?;
    let event = client.sign_event(builder)?;
    parse_withdrawal(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed withdrawal event failed the relay's own validation ({error})"
        ))
    })?;

    submit_ask_write(client, event).await
}

/// Submit a signed ask-protocol event and report the relay's write result.
///
/// The broker reports both a true duplicate (`"duplicate: original ask
/// <hex>"`, e.g. a concurrent filer losing the race for the same `need`)
/// and any other refusal, including a bad altitude, as `accepted:
/// false` with a `"conflict: <reason>"` message. Either way the full
/// response (including, for a duplicate, the ORIGINAL ask's `event_id`,
/// what the caller is actually blocked on) is printed before the write is
/// reported as a conflict (exit code 5), so nothing is flattened away.
async fn submit_ask_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
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

/// Dispatch a `buzz asks` subcommand.
pub async fn dispatch(cmd: crate::AsksCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::AsksCmd;
    match cmd {
        AsksCmd::Raise { fields } => cmd_raise_ask(client, &fields, None).await,
        AsksCmd::Escalate { prior, fields } => cmd_raise_ask(client, &fields, Some(&prior)).await,
        AsksCmd::List {
            audience,
            filed_by,
            status,
        } => {
            cmd_list_asks(
                client,
                audience.as_deref(),
                filed_by.as_deref(),
                status.as_deref(),
            )
            .await
        }
        AsksCmd::Answer { ask, answer_json } => cmd_answer_ask(client, &ask, &answer_json).await,
        AsksCmd::Withdraw { ask, reason } => cmd_withdraw_ask(client, &ask, &reason).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn signed_ask(fields: &AskEventFields) -> nostr::Event {
        let filer = Keys::generate();
        let builder = build_ask_event(fields).expect("build_ask_event");
        builder.sign_with_keys(&filer).expect("sign")
    }

    /// Step 1 (RED before `build_ask_event`/`AskEventFields` exist):
    /// a `raise`-shaped event round-trips through the real parser, not a
    /// hand-asserted shape of our own.
    #[test]
    fn build_ask_event_round_trips_through_parse_ask() {
        let audience = Keys::generate();
        let task_ids = vec!["task-9".to_string()];
        let options = vec![("A".to_string(), "sends 47 emails".to_string())];
        let fields = AskEventFields {
            ask_type: "decision",
            audience_hex: &audience.public_key().to_hex(),
            initiative_id: "init-1",
            task_ids: &task_ids,
            need_key: "batch-size",
            thread_hex: None,
            prior_hex: None,
            category: Some("outreach_pacing"),
            channel: None,
            headline: "Choose batch size",
            cost_of_delay: "47 leads wait",
            options: &options,
            default_option: Some("A"),
            window_secs: Some(3600),
        };

        let event = signed_ask(&fields);
        let parsed = parse_ask(&event).expect("parse_ask should accept a CLI-constructed event");

        assert_eq!(parsed.ask_type, AskType::Decision);
        assert_eq!(parsed.audience_hex, audience.public_key().to_hex());
        assert_eq!(parsed.initiative_id, "init-1");
        assert_eq!(parsed.task_ids, vec!["task-9".to_string()]);
        assert_eq!(parsed.need_key, "batch-size");
        assert_eq!(parsed.origin_thread_hex, None);
        assert_eq!(parsed.prior_ask_hex, None);
        assert_eq!(parsed.category.as_deref(), Some("outreach_pacing"));
        assert_eq!(parsed.headline, "Choose batch size");
        assert_eq!(parsed.cost_of_delay, "47 leads wait");
        assert_eq!(parsed.default_option.as_deref(), Some("A"));
        assert_eq!(parsed.default_window_secs, Some(3600));
    }

    /// `escalate`-shaped event: same builder, `prior_hex` set.
    #[test]
    fn build_ask_event_with_prior_round_trips_through_parse_ask() {
        let audience = Keys::generate();
        let prior = "a".repeat(64);
        let thread = "b".repeat(64);
        let task_ids = vec!["task-1".to_string(), "task-2".to_string()];
        let fields = AskEventFields {
            ask_type: "blocker",
            audience_hex: &audience.public_key().to_hex(),
            initiative_id: "init-2",
            task_ids: &task_ids,
            need_key: "prod-db-creds",
            thread_hex: Some(&thread),
            prior_hex: Some(&prior),
            category: None,
            channel: None,
            headline: "Need prod DB credentials",
            cost_of_delay: "migration blocked",
            options: &[],
            default_option: None,
            window_secs: None,
        };

        let event = signed_ask(&fields);
        let parsed = parse_ask(&event).expect("parse_ask should accept an escalate-shaped event");

        assert_eq!(parsed.ask_type, AskType::Blocker);
        assert_eq!(parsed.task_ids, task_ids);
        assert_eq!(parsed.origin_thread_hex.as_deref(), Some(thread.as_str()));
        assert_eq!(parsed.prior_ask_hex.as_deref(), Some(prior.as_str()));
        assert_eq!(parsed.default_option, None);
    }

    #[test]
    fn build_resolution_event_round_trips_through_parse_resolution() {
        let ask_hex = "c".repeat(64);
        let builder =
            build_resolution_event(&ask_hex, serde_json::json!({"choice": "B"})).expect("build");
        let signer = Keys::generate();
        let event = builder.sign_with_keys(&signer).expect("sign");

        let parsed = parse_resolution(&event).expect("parse_resolution should accept this event");
        assert_eq!(parsed.ask_event_hex, ask_hex);
        assert_eq!(parsed.answer, serde_json::json!({"choice": "B"}));
        assert!(!parsed.default_executed);
    }

    #[test]
    fn build_withdrawal_event_round_trips_through_parse_withdrawal() {
        let ask_hex = "d".repeat(64);
        let builder =
            build_withdrawal_event(&ask_hex, "stale, superseded by a new plan").expect("build");
        let signer = Keys::generate();
        let event = builder.sign_with_keys(&signer).expect("sign");

        let parsed = parse_withdrawal(&event).expect("parse_withdrawal should accept this event");
        assert_eq!(parsed.ask_event_hex, ask_hex);
        assert_eq!(parsed.reason, "stale, superseded by a new plan");
    }

    #[test]
    fn ask_type_str_rejects_stall() {
        let error = ask_type_str("stall").unwrap_err();
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn ask_type_str_rejects_unknown() {
        let error = ask_type_str("urgent").unwrap_err();
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn ask_type_str_accepts_filable_variants() {
        for (input, expected) in [
            ("decision", "decision"),
            ("question", "question"),
            ("credential", "credential"),
            ("blocker", "blocker"),
        ] {
            assert_eq!(ask_type_str(input).unwrap(), expected);
        }
    }

    #[test]
    fn parse_options_splits_label_and_consequence() {
        let raw = vec![
            "A=sends 47 emails".to_string(),
            "B=sends 15 emails".to_string(),
        ];
        let parsed = parse_options(&raw).unwrap();
        assert_eq!(
            parsed,
            vec![
                ("A".to_string(), "sends 47 emails".to_string()),
                ("B".to_string(), "sends 15 emails".to_string()),
            ]
        );
    }

    #[test]
    fn parse_options_rejects_missing_equals() {
        let raw = vec!["A only".to_string()];
        let error = parse_options(&raw).unwrap_err();
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn parse_options_rejects_empty_label() {
        let raw = vec!["=no label".to_string()];
        let error = parse_options(&raw).unwrap_err();
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn response_accepted_reads_the_accepted_field() {
        assert!(response_accepted(r#"{"accepted":true}"#));
        assert!(!response_accepted(r#"{"accepted":false}"#));
        assert!(!response_accepted("not json"));
    }

    #[test]
    fn response_message_strips_to_the_message_field() {
        assert_eq!(
            response_message(r#"{"message":"duplicate: original ask abc"}"#),
            "duplicate: original ask abc"
        );
        assert_eq!(response_message("not json"), "not json");
    }

    fn sample_file_args(to: String) -> AskFileArgs {
        AskFileArgs {
            ask_type: "decision".to_string(),
            to,
            initiative: "init-1".to_string(),
            task: vec!["task-1".to_string()],
            need: "batch-size".to_string(),
            headline: "Choose batch size".to_string(),
            cost_of_delay: "47 leads wait".to_string(),
            thread: None,
            category: None,
            option: vec![],
            default: None,
            window_secs: None,
            channel: None,
        }
    }

    /// Regression: `nostr::EventBuilder` silently drops a `p` tag that
    /// matches the signer's own pubkey, which would otherwise surface as
    /// an opaque "tag `p` must appear exactly once" parse error. This must
    /// be caught explicitly, before any network call (the relay URL here
    /// is a closed port and would fail the test if a request were made).
    #[tokio::test]
    async fn raise_rejects_self_addressed_ask_before_any_network_call() {
        let keys = Keys::generate();
        let my_pubkey = keys.public_key().to_hex();
        let client = BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here");

        let fields = sample_file_args(my_pubkey.clone());
        let error = cmd_raise_ask(&client, &fields, None)
            .await
            .expect_err("a self-addressed ask must be rejected");

        match error {
            CliError::Usage(message) => assert!(
                message.contains(&my_pubkey),
                "error should name the offending pubkey so the agent knows what to change: {message}"
            ),
            other => panic!("expected CliError::Usage, got {other:?}"),
        }
    }

    /// Same guard, exercised through `escalate` (prior = Some).
    #[tokio::test]
    async fn escalate_rejects_self_addressed_ask_before_any_network_call() {
        let keys = Keys::generate();
        let my_pubkey = keys.public_key().to_hex();
        let client = BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here");

        let fields = sample_file_args(my_pubkey.clone());
        let prior = "e".repeat(64);
        let error = cmd_raise_ask(&client, &fields, Some(&prior))
            .await
            .expect_err("a self-addressed escalation must be rejected");

        assert!(matches!(error, CliError::Usage(_)));
    }
}
