//! `buzz outreach`: draft and track the one-email-per-lead outreach cards
//! the owner approves.
//!
//! Every card is the bundled `@outreach-email` composite Block, published with
//! exactly the tags `buzz blocks invoke` writes. This command group exists so
//! an agent turns one Discovery Lead into one reviewable card in one call,
//! instead of hand-writing the instance JSON.

use buzz_core::{
    block::validate_manifest_instance, discovery_workspace::DiscoveryLeadDetail,
    kind::KIND_BLOCK_RECEIPT,
};
use nostr::PublicKey;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::commands::blocks::{
    fetch_actions, publish_instance, resolve_active, InstancePublication,
};
use crate::commands::discovery::fetch_lead;
use crate::validate::{parse_event_id, parse_uuid, read_or_stdin};
use crate::{client::BuzzClient, error::CliError, OutputFormat, OutreachCmd, OutreachStatusArg};

/// Catalog handle of the bundled outreach email composite.
const OUTREACH_HANDLE: &str = "outreach-email";
/// What approving one of these cards actually does, in the owner's terms.
/// Part of the approval hash, so it cannot change after the yes.
const OUTREACH_ACTION: &str = "Send this email from your Gmail";
/// Signed action id the owner's Approve button raises.
const ACTION_APPROVE: &str = "outreach.approve";
/// Signed action id the owner's Skip button raises.
const ACTION_SKIP: &str = "outreach.skip";

/// Route `buzz outreach ...`.
pub async fn dispatch(
    command: OutreachCmd,
    client: &BuzzClient,
    format: &OutputFormat,
) -> Result<(), CliError> {
    match command {
        OutreachCmd::Draft {
            channel,
            lead,
            subject,
            body,
            from,
            to,
            expires_in,
            reply_to,
            processor,
        } => {
            draft(
                client,
                DraftRequest {
                    channel: &channel,
                    lead,
                    subject: &subject,
                    body: &body,
                    from: &from,
                    to: to.as_deref(),
                    expires_in: &expires_in,
                    reply_to: reply_to.as_deref(),
                    processor: processor.as_deref(),
                },
            )
            .await
        }
        OutreachCmd::List {
            channel,
            status,
            limit,
        } => list(client, &channel, status, limit, format).await,
    }
}

/// Everything `buzz outreach draft` was asked for, before any resolution.
struct DraftRequest<'a> {
    channel: &'a str,
    lead: Uuid,
    subject: &'a str,
    body: &'a str,
    from: &'a str,
    to: Option<&'a str>,
    expires_in: &'a str,
    reply_to: Option<&'a str>,
    processor: Option<&'a str>,
}

async fn draft(client: &BuzzClient, request: DraftRequest<'_>) -> Result<(), CliError> {
    let channel_id = parse_uuid(request.channel)?;
    let reply_to = request.reply_to.map(parse_event_id).transpose()?;
    // No explicit processor: the relay defaults it to the attention audience,
    // the owner who decides, so the owner's desktop answers the card's buttons.
    let processor = match request.processor {
        Some(raw) => Some(
            PublicKey::parse(raw)
                .map_err(|error| CliError::Usage(format!("invalid processor pubkey: {error}")))?,
        ),
        None => None,
    };
    let expires_in = parse_duration_seconds(request.expires_in)?;
    let body = read_or_stdin(request.body)?;
    let lead = fetch_lead(client, request.lead).await?;
    let destination = resolve_destination(&lead, request.to)?;
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let data = build_instance_data(&InstanceFacts {
        business_name: &lead.lead.name,
        destination: &destination,
        from: request.from.trim(),
        subject: request.subject,
        body: &body,
        lead_id: lead.lead.lead_id,
        campaign_id: lead.lead.campaign_id,
        expires_at: now.saturating_add(expires_in),
    });

    let resolved = resolve_active(client, OUTREACH_HANDLE).await?;
    validate_manifest_instance(&resolved.manifest, &data).map_err(|error| {
        CliError::Usage(format!(
            "outreach email does not satisfy the @{OUTREACH_HANDLE} schema: {error}"
        ))
    })?;

    let output = publish_instance(
        client,
        InstancePublication {
            channel_id,
            manifest: &resolved,
            data,
            fallback: None,
            processor,
            reply_to,
        },
    )
    .await?;
    println!("{output}");
    Ok(())
}

/// The resolved facts one outreach card is built from.
struct InstanceFacts<'a> {
    business_name: &'a str,
    destination: &'a str,
    from: &'a str,
    subject: &'a str,
    body: &'a str,
    lead_id: Uuid,
    campaign_id: Uuid,
    expires_at: u64,
}

/// Shape the `@outreach-email` instance data. Nothing here is optional: the
/// manifest requires every field, and a pending card is the only thing an
/// agent may draft.
fn build_instance_data(facts: &InstanceFacts<'_>) -> Value {
    json!({
        "action": OUTREACH_ACTION,
        "business_name": facts.business_name.trim(),
        "destination": facts.destination,
        "from": facts.from,
        "content": {
            "subject": facts.subject.trim(),
            "body": facts.body.trim()
        },
        "lead_id": facts.lead_id,
        "campaign_id": facts.campaign_id,
        "expires_at": facts.expires_at,
        "status": "pending"
    })
}

/// Pick the recipient mailbox: `--to` when given, otherwise the Lead's own
/// email. A Lead with neither is a usage error that names the Lead, because
/// nobody can fix it from the card.
fn resolve_destination(lead: &DiscoveryLeadDetail, to: Option<&str>) -> Result<String, CliError> {
    if let Some(to) = to.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(to.to_owned());
    }
    lead.email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            CliError::Usage(format!(
                "lead {} ({}) has no email; pass --to with a recipient mailbox",
                lead.lead.lead_id, lead.lead.name
            ))
        })
}

/// Parse a duration such as `90s`, `30m`, `72h` or `3d`. A bare integer is
/// read as seconds. Zero is rejected: a card that expires on arrival is never
/// what the caller meant.
fn parse_duration_seconds(raw: &str) -> Result<u64, CliError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(CliError::Usage("--expires-in must not be empty".to_owned()));
    }
    let (digits, multiplier) = match value.chars().last() {
        Some('s') => (&value[..value.len() - 1], 1_u64),
        Some('m') => (&value[..value.len() - 1], 60),
        Some('h') => (&value[..value.len() - 1], 3_600),
        Some('d') => (&value[..value.len() - 1], 86_400),
        _ => (value, 1),
    };
    let amount: u64 = digits.parse().map_err(|_| {
        CliError::Usage(format!(
            "invalid --expires-in `{raw}`: use a count with an optional s, m, h or d suffix"
        ))
    })?;
    let seconds = amount.checked_mul(multiplier).ok_or_else(|| {
        CliError::Usage(format!("--expires-in `{raw}` is too large to represent"))
    })?;
    if seconds == 0 {
        return Err(CliError::Usage(
            "--expires-in must be greater than zero".to_owned(),
        ));
    }
    Ok(seconds)
}

/// One outreach card as `buzz outreach list` reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OutreachRow {
    event_id: String,
    lead_id: String,
    destination: String,
    subject: String,
    status: String,
    updated_at: u64,
}

async fn list(
    client: &BuzzClient,
    raw_channel: &str,
    status: Option<OutreachStatusArg>,
    limit: Option<usize>,
    format: &OutputFormat,
) -> Result<(), CliError> {
    let channel = parse_uuid(raw_channel)?;
    let instances = client
        .query_all(json!({
            "kinds": [9],
            "#h": [channel.to_string()]
        }))
        .await?;
    let actions = fetch_actions(client, channel, None, None).await?;
    let receipts = client
        .query_all(json!({
            "kinds": [KIND_BLOCK_RECEIPT],
            "#h": [channel.to_string()]
        }))
        .await?;

    let mut rows = collect_rows(&instances, &actions, &receipts);
    rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
    if let Some(status) = status {
        rows.retain(|row| row.status == status.as_str());
    }
    if let Some(limit) = limit {
        rows.truncate(limit);
    }
    let output: Vec<Value> = rows.iter().map(|row| render_row(row, format)).collect();
    println!(
        "{}",
        serde_json::to_string(&output)
            .map_err(|error| CliError::Other(format!("could not serialize rows: {error}")))?
    );
    Ok(())
}

fn render_row(row: &OutreachRow, format: &OutputFormat) -> Value {
    match format {
        OutputFormat::Compact => json!({
            "event_id": row.event_id,
            "subject": row.subject,
            "status": row.status
        }),
        OutputFormat::Json => json!({
            "event_id": row.event_id,
            "lead_id": row.lead_id,
            "destination": row.destination,
            "subject": row.subject,
            "status": row.status,
            "updated_at": row.updated_at
        }),
    }
}

/// Build one row per outreach instance, with its status advanced by whatever
/// accepted actions and receipts the channel already holds.
fn collect_rows(instances: &[Value], actions: &[Value], receipts: &[Value]) -> Vec<OutreachRow> {
    let decisions = collect_decisions(actions);
    instances
        .iter()
        .filter_map(|event| outreach_row(event, &decisions, receipts))
        .collect()
}

/// One accepted signed action against an outreach card.
struct Decision {
    instance_id: String,
    action_id: String,
    created_at: u64,
}

fn collect_decisions(actions: &[Value]) -> Vec<Decision> {
    let mut decisions: Vec<Decision> = actions
        .iter()
        .filter_map(|event| {
            let tag = find_tag(event, "block-action")?;
            if tag.len() != 5 || tag.first().map(String::as_str) != Some("block-action") {
                return None;
            }
            Some(Decision {
                instance_id: tag.get(3)?.clone(),
                action_id: tag.get(2)?.clone(),
                created_at: created_at(event),
            })
        })
        .collect();
    decisions.sort_by_key(|decision| decision.created_at);
    decisions
}

fn outreach_row(event: &Value, decisions: &[Decision], receipts: &[Value]) -> Option<OutreachRow> {
    let block = find_tag(event, "block")?;
    if block.len() != 5 || block.get(2).map(String::as_str) != Some(OUTREACH_HANDLE) {
        return None;
    }
    let instance_id = block.get(4)?.clone();
    let data: Value = find_tag(event, "block-data")
        .and_then(|tag| tag.get(1).cloned())
        .and_then(|raw| serde_json::from_str(&raw).ok())?;
    let drafted_at = created_at(event);
    let (status, updated_at) = derive_status(
        text(&data, "status").unwrap_or("pending").to_owned(),
        drafted_at,
        &instance_id,
        decisions,
        receipts,
    );
    Some(OutreachRow {
        event_id: event.get("id").and_then(Value::as_str)?.to_owned(),
        lead_id: text(&data, "lead_id").unwrap_or_default().to_owned(),
        destination: text(&data, "destination").unwrap_or_default().to_owned(),
        subject: data
            .get("content")
            .and_then(|content| content.get("subject"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        status,
        updated_at,
    })
}

/// Advance a drafted status through this instance's accepted decisions and
/// their receipts, in relay order.
///
/// An approve makes the card `approved`; a receipt reporting that the approved
/// send succeeded makes it `sent`; a failed or timed-out receipt makes it
/// `failed`; a skip, or a denied receipt, makes it `skipped`.
fn derive_status(
    drafted: String,
    drafted_at: u64,
    instance_id: &str,
    decisions: &[Decision],
    receipts: &[Value],
) -> (String, u64) {
    let mut status = drafted;
    let mut updated_at = drafted_at;
    for decision in decisions
        .iter()
        .filter(|decision| decision.instance_id == instance_id)
    {
        let next = match decision.action_id.as_str() {
            ACTION_APPROVE => Some("approved"),
            ACTION_SKIP => Some("skipped"),
            _ => None,
        };
        if let Some(next) = next {
            status = next.to_owned();
            updated_at = decision.created_at;
        }
    }
    for (receipt_status, receipt_at) in receipt_states(instance_id, receipts) {
        let next = match receipt_status.as_str() {
            "succeeded" if status == "approved" => Some("sent"),
            "denied" => Some("skipped"),
            "failed" | "timed-out" => Some("failed"),
            _ => None,
        };
        if let Some(next) = next {
            status = next.to_owned();
            updated_at = receipt_at;
        }
    }
    (status, updated_at)
}

/// Receipt statuses for one instance, oldest first.
fn receipt_states(instance_id: &str, receipts: &[Value]) -> Vec<(String, u64)> {
    let mut states: Vec<(String, u64)> = receipts
        .iter()
        .filter_map(|event| {
            let tag = find_tag(event, "block-receipt")?;
            if tag.len() != 5 || tag.get(2).map(String::as_str) != Some(instance_id) {
                return None;
            }
            Some((tag.get(4)?.clone(), created_at(event)))
        })
        .collect();
    states.sort_by_key(|(_, at)| *at);
    states
}

fn find_tag(event: &Value, name: &str) -> Option<Vec<String>> {
    event
        .get("tags")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|tag| {
            let parts: Vec<String> = tag
                .as_array()?
                .iter()
                .map(|part| part.as_str().unwrap_or_default().to_owned())
                .collect();
            (parts.first().map(String::as_str) == Some(name)).then_some(parts)
        })
        .next()
}

fn created_at(event: &Value) -> u64 {
    event
        .get("created_at")
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn text<'a>(data: &'a Value, field: &str) -> Option<&'a str> {
    data.get(field).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::{
        build_instance_data, collect_rows, derive_status, parse_duration_seconds,
        resolve_destination, InstanceFacts, OUTREACH_ACTION,
    };
    use buzz_core::discovery_workspace::DiscoveryLeadDetail;
    use serde_json::{json, Value};
    use uuid::Uuid;

    fn lead_fixture(email: Option<&str>) -> DiscoveryLeadDetail {
        serde_json::from_value(json!({
            "lead_id": "3f2a91c4-6d18-4a7b-9e02-5c81b7d4a610",
            "campaign_id": "c81d4e9a-2f36-4b58-8a71-0d6e3f95c247",
            "industry_id": "home-services",
            "vertical_id": "plumbing",
            "status": "accepted",
            "name": "Atlantic Plumbing",
            "website": "https://atlanticplumb.co.za",
            "phone": null,
            "full_address": null,
            "city": null,
            "state": null,
            "country": null,
            "category": null,
            "subtypes": [],
            "rating_hundredths": null,
            "reviews_count": null,
            "source_url": null,
            "image_url": null,
            "added_at": "2026-09-01T00:00:00Z",
            "owner_persona_id": null,
            "website_override": null,
            "email": email,
            "phone_override": null,
            "linkedin_url": null,
            "contact_name": null,
            "contact_title": null,
            "notes": null,
            "score": null,
            "updated_by": null,
            "updated_at": null
        }))
        .expect("lead fixture")
    }

    #[test]
    fn durations_accept_suffixes_and_reject_nonsense() {
        assert_eq!(parse_duration_seconds("72h").expect("hours"), 259_200);
        assert_eq!(parse_duration_seconds("30m").expect("minutes"), 1_800);
        assert_eq!(parse_duration_seconds("3d").expect("days"), 259_200);
        assert_eq!(parse_duration_seconds("90s").expect("seconds"), 90);
        assert_eq!(parse_duration_seconds(" 45 ").expect("bare"), 45);

        for bad in [
            "",
            "0",
            "0h",
            "-1h",
            "72hh",
            "abc",
            "h",
            "99999999999999999999d",
        ] {
            assert!(
                parse_duration_seconds(bad).is_err(),
                "`{bad}` must be rejected"
            );
        }
    }

    #[test]
    fn destination_prefers_the_override_then_the_lead_email() {
        let lead = lead_fixture(Some("info@atlanticplumb.co.za"));
        assert_eq!(
            resolve_destination(&lead, None).expect("lead email"),
            "info@atlanticplumb.co.za"
        );
        assert_eq!(
            resolve_destination(&lead, Some(" owner@atlanticplumb.co.za ")).expect("override"),
            "owner@atlanticplumb.co.za"
        );
        assert_eq!(
            resolve_destination(&lead, Some("   ")).expect("blank override falls back"),
            "info@atlanticplumb.co.za"
        );
    }

    #[test]
    fn a_lead_with_no_email_names_itself_in_the_usage_error() {
        let lead = lead_fixture(None);
        let error = resolve_destination(&lead, None)
            .expect_err("a lead with no email cannot be drafted")
            .to_string();
        assert!(
            error.contains("3f2a91c4-6d18-4a7b-9e02-5c81b7d4a610"),
            "{error}"
        );
        assert!(error.contains("Atlantic Plumbing"), "{error}");
        assert!(error.contains("--to"), "{error}");

        let blank = lead_fixture(Some("  "));
        assert!(resolve_destination(&blank, None).is_err());
    }

    #[test]
    fn instance_data_matches_the_manifest_schema_and_expiry() {
        let lead = lead_fixture(Some("info@atlanticplumb.co.za"));
        let data = build_instance_data(&InstanceFacts {
            business_name: &lead.lead.name,
            destination: "info@atlanticplumb.co.za",
            from: "basheer@horizonlabs.co.za",
            subject: "  Winter boiler special  ",
            body: "  Hi team,\n\nTen minutes this week?  ",
            lead_id: lead.lead.lead_id,
            campaign_id: lead.lead.campaign_id,
            expires_at: 1_000 + parse_duration_seconds("72h").expect("duration"),
        });

        assert_eq!(data["action"], OUTREACH_ACTION);
        assert_eq!(data["business_name"], "Atlantic Plumbing");
        assert_eq!(data["destination"], "info@atlanticplumb.co.za");
        assert_eq!(data["from"], "basheer@horizonlabs.co.za");
        assert_eq!(data["content"]["subject"], "Winter boiler special");
        assert_eq!(
            data["content"]["body"],
            "Hi team,\n\nTen minutes this week?"
        );
        assert_eq!(data["lead_id"], lead.lead.lead_id.to_string());
        assert_eq!(data["campaign_id"], lead.lead.campaign_id.to_string());
        assert_eq!(data["expires_at"], 1_000 + 259_200);
        assert_eq!(data["status"], "pending");

        let manifest = buzz_core::block::parse_manifest(include_str!(
            "../../../buzz-relay/src/core_blocks/composites/outreach-email.json"
        ))
        .expect("bundled outreach manifest");
        buzz_core::block::validate_manifest_instance(&manifest, &data)
            .expect("drafted data satisfies the bundled schema");
    }

    #[test]
    fn a_bad_field_fails_the_bundled_schema_before_anything_is_published() {
        let manifest = buzz_core::block::parse_manifest(include_str!(
            "../../../buzz-relay/src/core_blocks/composites/outreach-email.json"
        ))
        .expect("bundled outreach manifest");
        let data = build_instance_data(&InstanceFacts {
            business_name: "Atlantic Plumbing",
            destination: "not-an-email",
            from: "basheer@horizonlabs.co.za",
            subject: "Winter boiler special",
            body: "Hi team",
            lead_id: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
            expires_at: 1_789_142_400,
        });
        let error = buzz_core::block::validate_manifest_instance(&manifest, &data)
            .expect_err("a malformed recipient must abort the draft")
            .to_string();
        assert!(
            error.contains("not-an-email") || error.contains("email"),
            "{error}"
        );
    }

    fn instance_event(instance_id: &str, created_at: u64, status: &str) -> Value {
        json!({
            "id": "a".repeat(64),
            "created_at": created_at,
            "tags": [
                ["h", "7f2b1d0e-3c4a-4f6b-9a81-2d5e7c9b0a14"],
                ["block", "1", "outreach-email", &"b".repeat(64), instance_id],
                ["block-data", json!({
                    "lead_id": "3f2a91c4-6d18-4a7b-9e02-5c81b7d4a610",
                    "destination": "info@atlanticplumb.co.za",
                    "content": {"subject": "Winter boiler special", "body": "Hi"},
                    "status": status
                }).to_string()]
            ]
        })
    }

    fn action_event(instance_id: &str, action_id: &str, created_at: u64) -> Value {
        json!({
            "id": "c".repeat(64),
            "created_at": created_at,
            "tags": [["block-action", "1", action_id, instance_id, Uuid::new_v4().to_string()]]
        })
    }

    fn receipt_event(instance_id: &str, status: &str, created_at: u64) -> Value {
        json!({
            "id": "d".repeat(64),
            "created_at": created_at,
            "tags": [[
                "block-receipt",
                "1",
                instance_id,
                Uuid::new_v4().to_string(),
                status
            ]]
        })
    }

    #[test]
    fn rows_only_cover_outreach_cards() {
        let instance_id = Uuid::new_v4().to_string();
        let other = json!({
            "id": "e".repeat(64),
            "created_at": 10,
            "tags": [["block", "1", "approval", &"b".repeat(64), Uuid::new_v4().to_string()]]
        });
        let prose = json!({ "id": "f".repeat(64), "created_at": 11, "tags": [] });
        let rows = collect_rows(
            &[instance_event(&instance_id, 12, "pending"), other, prose],
            &[],
            &[],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[0].destination, "info@atlanticplumb.co.za");
        assert_eq!(rows[0].subject, "Winter boiler special");
        assert_eq!(rows[0].updated_at, 12);
    }

    #[test]
    fn status_follows_the_accepted_decisions_and_their_receipts() {
        let instance_id = Uuid::new_v4().to_string();
        let approved = collect_rows(
            &[instance_event(&instance_id, 10, "pending")],
            &[action_event(&instance_id, "outreach.approve", 20)],
            &[],
        );
        assert_eq!(approved[0].status, "approved");
        assert_eq!(approved[0].updated_at, 20);

        let sent = collect_rows(
            &[instance_event(&instance_id, 10, "pending")],
            &[action_event(&instance_id, "outreach.approve", 20)],
            &[receipt_event(&instance_id, "succeeded", 30)],
        );
        assert_eq!(sent[0].status, "sent");
        assert_eq!(sent[0].updated_at, 30);

        let skipped = collect_rows(
            &[instance_event(&instance_id, 10, "pending")],
            &[action_event(&instance_id, "outreach.skip", 20)],
            &[],
        );
        assert_eq!(skipped[0].status, "skipped");

        let failed = collect_rows(
            &[instance_event(&instance_id, 10, "pending")],
            &[action_event(&instance_id, "outreach.approve", 20)],
            &[receipt_event(&instance_id, "failed", 30)],
        );
        assert_eq!(failed[0].status, "failed");
    }

    #[test]
    fn another_instances_decisions_never_move_this_card() {
        let mine = Uuid::new_v4().to_string();
        let theirs = Uuid::new_v4().to_string();
        let rows = collect_rows(
            &[instance_event(&mine, 10, "pending")],
            &[action_event(&theirs, "outreach.approve", 20)],
            &[receipt_event(&theirs, "succeeded", 30)],
        );
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[0].updated_at, 10);
    }

    #[test]
    fn a_succeeded_receipt_without_an_approval_does_not_claim_a_send() {
        let instance_id = Uuid::new_v4().to_string();
        let (status, updated_at) = derive_status(
            "pending".to_owned(),
            10,
            &instance_id,
            &[],
            &[receipt_event(&instance_id, "succeeded", 30)],
        );
        assert_eq!(status, "pending");
        assert_eq!(updated_at, 10);
    }
}
