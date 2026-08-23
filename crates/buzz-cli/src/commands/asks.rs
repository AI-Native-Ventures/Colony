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

use buzz_core::interrupt::{parse_ask, parse_resolution, parse_withdrawal, AskType, NO_INITIATIVE};
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_STATE, KIND_ASK_WITHDRAWAL, KIND_EMPLOYEE,
    KIND_MANAGED_AGENT,
};

use crate::client::{
    extract_tag_value, normalize_write_response, write_conflict_reason, BuzzClient,
};
use crate::error::CliError;
use crate::validate::{read_or_stdin, validate_hex64, validate_uuid};
use crate::AskFileArgs;

/// Fully-validated fields for constructing an Ask event (kind
/// [`KIND_ASK`]). Shared by `raise` and `escalate`: escalate is exactly
/// this plus a `prior` tag and a new audience; see [`build_ask_event`].
///
/// Public so tests that prove the ask path end to end build the event the
/// same way the CLI does. `crates/buzz-test-client/tests/e2e_interrupts.rs`
/// keeps its own copy of this shape, which is one drift away from proving a
/// tag layout no agent actually sends; anything new builds from here.
pub struct AskEventFields<'a> {
    /// Canonical `ask-type` tag value, as `ask_type_str` produces it.
    pub ask_type: &'a str,
    /// Audience pubkey, 64-char hex, one tier above the filer.
    pub audience_hex: &'a str,
    /// Initiative id this ask groups under, or `None` when the work belongs
    /// to no initiative; see `initiative_tag_value` for what `None` files as.
    pub initiative_id: Option<&'a str>,
    /// Task ids this ask blocks on; at least one is required.
    pub task_ids: &'a [String],
    /// Dedupe slug, `[a-z0-9-]{1,64}`.
    pub need_key: &'a str,
    /// Origin thread root event id, 64-char hex.
    pub thread_hex: Option<&'a str>,
    /// The ask this one supersedes, 64-char hex.
    pub prior_hex: Option<&'a str>,
    /// Category slug; hard-list categories forbid `default_option`.
    pub category: Option<&'a str>,
    /// Channel UUID this ask concerns.
    pub channel: Option<&'a str>,
    /// The one line the audience reads.
    pub headline: &'a str,
    /// What waiting costs, in the filer's own words.
    pub cost_of_delay: &'a str,
    /// `(label, consequence)` pairs; each option states its external effect.
    pub options: &'a [(String, String)],
    /// Label of the option that applies if nobody answers in time.
    pub default_option: Option<&'a str>,
    /// Seconds until `default_option` applies.
    pub window_secs: Option<u64>,
}

/// Build a two-element string tag, e.g. `["need", "batch-size"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// The `initiative` tag value for an ask, given the initiative the filer's
/// work belongs to.
///
/// `None` is the ordinary case, not an error: every chat-derived implicit
/// task carries no initiative (`buzz_sdk::implicit_task`), so requiring one
/// here would mean an agent doing the most common kind of work could never
/// file an ask at all. Those asks group under the same reserved value the
/// relay's stall sweep already files initiative-less tasks under
/// ([`buzz_core::interrupt::NO_INITIATIVE`]), rather than a second
/// convention that would split one condition across two grouping keys.
fn initiative_tag_value(initiative_id: Option<&str>) -> &str {
    initiative_id.unwrap_or(NO_INITIATIVE)
}

/// Build the `EventBuilder` for a Colony interrupt Ask (kind [`KIND_ASK`])
/// from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_ask`'s rules (need-slug format, hard-list
/// vs. `default_option`, `default_window_secs` bounds, ...). Callers MUST
/// self-validate the signed event with [`parse_ask`] before submitting it;
/// see `cmd_raise_ask`.
pub fn build_ask_event(fields: &AskEventFields) -> Result<EventBuilder, CliError> {
    let audience = PublicKey::from_hex(fields.audience_hex)
        .map_err(|error| CliError::Usage(format!("invalid --to pubkey: {error}")))?;

    let mut tags = vec![
        tag(&["ask-type", fields.ask_type])?,
        Tag::public_key(audience),
        tag(&["initiative", initiative_tag_value(fields.initiative_id)])?,
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

/// Upper bound on how many of the most recent managed-agent heads at the
/// filer's `d` tag [`resolve_default_audience`] scans for one naming a
/// manager. Mirrors the relay's own bounded head walks.
const MAX_MANAGER_HEAD_CANDIDATES: usize = 20;

/// Resolve the filer's manager from the relay's reporting-line records: the
/// audience `asks raise` defaults to when `--to` is omitted.
///
/// Two sources, in the order authority sits:
///
/// 1. an employee head (kind 30190) at the filer's pubkey -- relay-signed,
///    so trustworthy as published;
/// 2. else managed-agent heads (kind 30177) at the same coordinate,
///    newest first, skipping any head the filer authored itself and taking
///    the first that names a manager. A client cannot verify owner-
///    authorship (it does not know the membership table), so this is a
///    best-effort mirror of the relay's read-time rule; the relay's altitude
///    check remains the real gate on whatever audience is chosen, so a
///    forged line can misroute an ask to an agent it should not reach but
///    can never make an invalid ask land.
fn extract_manager_tag(event: &serde_json::Value) -> Option<String> {
    event
        .get("tags")?
        .as_array()?
        .iter()
        .filter_map(|tag| tag.as_array())
        .find(|parts| parts.first().and_then(|v| v.as_str()) == Some("manager"))
        .and_then(|parts| parts.get(1))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

async fn resolve_default_audience(client: &BuzzClient) -> Result<String, CliError> {
    let my_pubkey = client.keys().public_key().to_hex();

    // 1. Employee heads are relay-signed; NIP-33 latest-wins means only the
    //    newest head at this coordinate counts. Its verdict is final -- this
    //    mirrors `agent_manager`, which reads the employees row INSTEAD of
    //    any head for employed pubkeys.
    let filter = serde_json::json!({ "kinds": [KIND_EMPLOYEE], "#d": [my_pubkey] });
    let events = client.query_all(filter).await?;
    if let Some(newest) = events.first() {
        return match extract_manager_tag(newest) {
            Some(manager) => Ok(manager),
            None => Err(CliError::Usage(format!(
                "no manager is recorded for {my_pubkey}, so no default audience exists: pass \
                 --to explicitly. Asks must go to an agent exactly one tier up (worker -> its \
                 leader, leader -> the executive, executive -> a community owner); without a \
                 reporting line the filer must name the recipient itself"
            ))),
        };
    }

    // 2. Managed-agent heads, newest first, ignoring self-published ones.
    let filter = serde_json::json!({
        "kinds": [KIND_MANAGED_AGENT],
        "#d": [my_pubkey],
    });
    let events = client.query_all(filter).await?;
    for event in events.iter().take(MAX_MANAGER_HEAD_CANDIDATES) {
        let author = event
            .get("pubkey")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if author.eq_ignore_ascii_case(&my_pubkey) {
            continue;
        }
        if let Some(manager) = extract_manager_tag(event) {
            return Ok(manager);
        }
    }

    Err(CliError::Usage(format!(
        "no manager is recorded for {my_pubkey}, so no default audience exists: pass --to \
         explicitly. Asks must go to an agent exactly one tier up (worker -> its leader, \
         leader -> the executive, executive -> a community owner); without a reporting line \
         the filer must name the recipient itself"
    )))
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
///
/// The audience is `fields.to`, or -- on a plain raise with no `--to` --
/// the filer's manager, resolved from the relay. Escalation has no default:
/// it exists to move a need ABOVE the audience that already has it, so
/// naming the recipient explicitly is the point.
async fn cmd_raise_ask(
    client: &BuzzClient,
    fields: &AskFileArgs,
    prior: Option<&str>,
) -> Result<(), CliError> {
    let ask_type = ask_type_str(&fields.ask_type)?;
    if prior.is_some() && fields.to.is_none() {
        return Err(CliError::Usage(
            "escalate requires an explicit --to: an escalation moves the ask to whoever is \
             one tier above its current audience, and only the filer knows who that is"
                .into(),
        ));
    }
    let to = match &fields.to {
        Some(to) => to.clone(),
        None => resolve_default_audience(client).await?,
    };

    validate_hex64(&to)?;
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
    if to.eq_ignore_ascii_case(&my_pubkey) {
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
        audience_hex: &to,
        initiative_id: fields.initiative.as_deref(),
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
///
/// Each listed ask also carries its ask-state head (kind 30200) under an
/// `ask_state` key when one exists: the relay-signed `deadline_at` and the
/// named expiry outcome, exactly as a subscribing app sees them. The value
/// is never recomputed here -- the CLI and the app read the same head, so
/// they cannot disagree.
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

    let head_ids: Vec<String> = asks
        .iter()
        .filter_map(|event| event.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    if !head_ids.is_empty() {
        let heads_filter = serde_json::json!({
            "kinds": [KIND_ASK_STATE],
            "#d": head_ids,
        });
        let heads = client.query_all(heads_filter).await?;
        asks = attach_ask_states(asks, &heads);
    }

    println!(
        "{}",
        serde_json::to_string(&asks).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Attach each ask's ask-state head content under an `ask_state` key,
/// keyed by the head's `d` tag matching the ask's event id. When several
/// revisions of one head come back (an older relay that did not replace),
/// the newest `created_at` wins, mirroring NIP-33 latest-wins. An ask with
/// no head is left untouched.
fn attach_ask_states(
    mut asks: Vec<serde_json::Value>,
    heads: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut by_d: std::collections::HashMap<String, (i64, serde_json::Value)> =
        std::collections::HashMap::new();
    for head in heads {
        let d_tag = extract_tag_value(head, "d");
        if d_tag.is_empty() {
            continue;
        }
        let created_at = match head.get("created_at").and_then(serde_json::Value::as_i64) {
            Some(created_at) => created_at,
            None => continue,
        };
        // Event content arrives as raw JSON text; attach it parsed so
        // consumers read `ask_state.deadline_at` directly. A head whose
        // content does not parse is skipped rather than attached as a
        // string an agent would have to re-parse.
        let content = match head.get("content").and_then(serde_json::Value::as_str) {
            Some(raw) => match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(content) => content,
                Err(_) => continue,
            },
            None => continue,
        };
        match by_d.get(&d_tag) {
            // Keep the newest revision per coordinate.
            Some((existing_at, _)) if *existing_at >= created_at => {}
            _ => {
                by_d.insert(d_tag, (created_at, content));
            }
        }
    }
    for ask in asks.iter_mut() {
        let id = match ask.get("id").and_then(serde_json::Value::as_str) {
            Some(id) => id.to_owned(),
            None => continue,
        };
        if let Some((_, content)) = by_d.get(&id) {
            ask["ask_state"] = content.clone();
        }
    }
    asks
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
///
/// **The answer must never carry a secret value.** `answer` is any JSON and
/// the relay does not inspect it, but the resolution is stored unencrypted,
/// fans out like any other event, and nothing scopes it to the ask's
/// participants -- so an API key pasted here is readable by anyone on the
/// relay. A `credential` ask deliberately carries no secret-value field for
/// exactly this reason (`docs/nips/NIP-IQ.md`, "Ask types"): the credential
/// itself travels out of band and this resolution is the acknowledgement
/// that it did.
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
///
/// Classification is [`write_conflict_reason`]'s, so a write the relay
/// discarded rather than stored is a conflict even when it comes back
/// `accepted: true`; see its doc comment.
async fn submit_ask_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
    let raw = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&raw));

    match write_conflict_reason(&raw) {
        Some(reason) => Err(CliError::Conflict(reason)),
        None => Ok(()),
    }
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
            initiative_id: Some("init-1"),
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
            initiative_id: Some("init-2"),
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

    /// An agent whose work belongs to no initiative can still file an ask.
    ///
    /// This is the ordinary case, not an edge one: every task Colony creates
    /// from chat carries `initiative_id: None` (`buzz_sdk::implicit_task`),
    /// and `--initiative` used to be required, so a worker on such a task had
    /// nothing valid to pass and could not file an ask at all. The reserved
    /// grouping value is what makes the event constructible, and `parse_ask`
    /// -- the relay's own parser -- has to accept it or nothing is proven.
    #[test]
    fn an_ask_about_work_with_no_initiative_files_under_the_reserved_value() {
        let audience = Keys::generate();
        let task_ids = vec!["horizonlabs:chat:0001".to_string()];
        let fields = AskEventFields {
            ask_type: "blocker",
            audience_hex: &audience.public_key().to_hex(),
            initiative_id: None,
            task_ids: &task_ids,
            need_key: "dns-txt-record",
            thread_hex: None,
            prior_hex: None,
            category: None,
            channel: None,
            headline: "DNS needs a TXT record only you can add",
            cost_of_delay: "the site cannot go live until this lands",
            options: &[],
            default_option: None,
            window_secs: None,
        };

        let event = signed_ask(&fields);
        let parsed =
            parse_ask(&event).expect("an ask about initiative-less work must be constructible");
        assert_eq!(
            parsed.initiative_id, NO_INITIATIVE,
            "it must group under the same reserved value the relay's stall sweep uses, \
             not a second convention"
        );
        assert_eq!(parsed.task_ids, task_ids);
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

    /// The broker's own duplicate (`accepted: false`) is a conflict and
    /// keeps the original ask id the caller is actually blocked on.
    #[test]
    fn a_broker_duplicate_is_a_conflict_naming_the_original_ask() {
        assert_eq!(
            write_conflict_reason(r#"{"accepted":false,"message":"duplicate: original ask abc"}"#)
                .as_deref(),
            Some("original ask abc")
        );
        assert_eq!(
            write_conflict_reason("not json").as_deref(),
            Some("not json")
        );
    }

    /// A write the relay discarded rather than stored comes back
    /// `accepted: true` with a bare `"duplicate:"`. It is a conflict here
    /// too: nothing was written, so reporting success would be a lie.
    #[test]
    fn a_discarded_write_is_a_conflict_despite_accepted_true() {
        assert!(
            write_conflict_reason(r#"{"accepted":true,"message":"duplicate:"}"#).is_some(),
            "a write the relay stored nothing for must not report success"
        );
        assert_eq!(
            write_conflict_reason(r#"{"accepted":true,"message":"stored"}"#),
            None
        );
    }

    /// `buzz asks list` must surface the same deadline value the app reads:
    /// the ask-state head content attached verbatim under `ask_state`,
    /// newest revision winning, asks without a head left untouched.
    #[test]
    fn attach_ask_states_merges_the_newest_head_per_ask() {
        let ask_id = "1".repeat(64);
        let other_id = "2".repeat(64);
        let asks = vec![
            serde_json::json!({ "id": ask_id, "content": "ask" }),
            serde_json::json!({ "id": other_id, "content": "other" }),
        ];
        let heads = vec![
            // Older revision of the first ask's head: superseded below.
            serde_json::json!({
                "id": "a".repeat(64),
                "created_at": 100,
                "tags": [["d", ask_id]],
                "content": r#"{"status":"open","deadline_at":900}"#,
            }),
            serde_json::json!({
                "id": "b".repeat(64),
                "created_at": 200,
                "tags": [["d", ask_id]],
                "content": r#"{"status":"resolved","closed_at":250}"#,
            }),
        ];

        let merged = attach_ask_states(asks, &heads);
        let first_state = merged[0].get("ask_state").expect("head attached");
        assert_eq!(
            first_state
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("resolved"),
            "the newest head revision must win"
        );
        assert_eq!(first_state.get("deadline_at"), None);
        assert!(
            merged[1].get("ask_state").is_none(),
            "an ask with no head must be left untouched"
        );
    }

    fn sample_file_args(to: Option<String>) -> AskFileArgs {
        AskFileArgs {
            ask_type: "decision".to_string(),
            to,
            initiative: Some("init-1".to_string()),
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

        let fields = sample_file_args(Some(my_pubkey.clone()));
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

        let fields = sample_file_args(Some(my_pubkey.clone()));
        let prior = "e".repeat(64);
        let error = cmd_raise_ask(&client, &fields, Some(&prior))
            .await
            .expect_err("a self-addressed escalation must be rejected");

        assert!(matches!(error, CliError::Usage(_)));
    }

    /// An escalation has no default audience: it exists to move a need above
    /// the party that already has it, so omitting `--to` is refused before
    /// any network call rather than guessed at.
    #[tokio::test]
    async fn escalate_requires_an_explicit_audience() {
        let keys = Keys::generate();
        let client = BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here");

        let fields = sample_file_args(None);
        let prior = "f".repeat(64);
        let error = cmd_raise_ask(&client, &fields, Some(&prior))
            .await
            .expect_err("an audience-less escalation must be rejected");

        match error {
            CliError::Usage(message) => {
                assert!(
                    message.contains("--to"),
                    "error must say what to do: {message}"
                )
            }
            other => panic!("expected CliError::Usage, got {other:?}"),
        }
    }
}
