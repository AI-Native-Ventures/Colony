//! `buzz content`: the content calendar's agent-facing surface.
//!
//! Campaigns (30195), posts (30196), house style (30197), and the brand kit
//! (30198) are written by the content agent; decisions (40025) are written
//! by the owner. Every write here self-validates against the same parser the
//! relay runs at ingest, so a rejection arrives without a network round trip
//! and names the field that caused it.
//!
//! The agent renders and measures on its own machine. This command stores what
//! it produced; it never produces anything itself.

use std::fs;

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::content::{
    parse_content_campaign, parse_content_decision, parse_content_post, parse_content_style,
    post_address, GateVerdict, ParsedContentPost, SCHEMA_CONTENT_CAMPAIGN, SCHEMA_CONTENT_DECISION,
    SCHEMA_CONTENT_POST, SCHEMA_CONTENT_STYLE,
};
use buzz_core::content_brand_kit::{parse_content_brand_kit, SCHEMA_CONTENT_BRAND_KIT};
use buzz_core::kind::{
    KIND_CONTENT_BRAND_KIT, KIND_CONTENT_CAMPAIGN, KIND_CONTENT_DECISION, KIND_CONTENT_POST,
    KIND_CONTENT_STYLE,
};

use crate::client::{head_is_newer, normalize_write_response, write_conflict_reason, BuzzClient};
use crate::error::CliError;

/// Default scope for the house-style record.
const DEFAULT_STYLE_SCOPE: &str = "house";

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// Read a JSON document from a path, a leading-`@` path, or stdin (`-`).
///
/// The `@file` spelling is what the rest of the Buzz surface documents, and a
/// path without it is what a shell tab-completes. Both work rather than one
/// failing with a file-not-found naming a file the caller can see on disk.
fn read_json_arg(arg: &str) -> Result<serde_json::Value, CliError> {
    let raw = if arg == "-" {
        use std::io::Read;
        let mut buffer = String::new();
        std::io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|error| CliError::Usage(format!("could not read stdin: {error}")))?;
        buffer
    } else {
        let path = arg.strip_prefix('@').unwrap_or(arg);
        fs::read_to_string(path)
            .map_err(|error| CliError::Usage(format!("could not read JSON {path}: {error}")))?
    };
    serde_json::from_str(&raw)
        .map_err(|error| CliError::Usage(format!("invalid JSON in {arg}: {error}")))
}

/// Stamp the pinned schema onto a body, or refuse a body that names another.
///
/// Injecting saves every caller from repeating a constant. Refusing a mismatch
/// keeps the injection from silently rewriting a document that was built for a
/// different record and passed to the wrong subcommand.
fn apply_schema(
    mut body: serde_json::Value,
    schema: &'static str,
) -> Result<serde_json::Value, CliError> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| CliError::Usage("the --data document must be a JSON object".to_string()))?;
    match object.get("schema").and_then(|v| v.as_str()) {
        None => {
            object.insert("schema".to_string(), serde_json::json!(schema));
        }
        Some(found) if found == schema => {}
        Some(found) => {
            return Err(CliError::Usage(format!(
                "this document declares schema `{found}`, but this command writes `{schema}`"
            )));
        }
    }
    Ok(body)
}

/// Sign, self-validate, and submit, reporting the relay's write result.
///
/// Mirrors `commands::decisions::submit_decision_write`: any response the
/// relay did not durably store is a write conflict, after printing the full
/// response so nothing is flattened away.
async fn submit(
    client: &BuzzClient,
    builder: EventBuilder,
    validate: impl Fn(&nostr::Event) -> Result<(), CliError>,
) -> Result<(), CliError> {
    let event = client.sign_event(builder)?;
    validate(&event)?;
    let raw = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&raw));
    match write_conflict_reason(&raw) {
        Some(reason) => Err(CliError::Conflict(reason)),
        None => Ok(()),
    }
}

fn validation_error(error: impl std::fmt::Display) -> CliError {
    CliError::Usage(format!(
        "the constructed event failed the relay's own validation ({error}); fix the named field \
         and retry"
    ))
}

// ── campaigns ─────────────────────────────────────────────────────────────

async fn cmd_campaign_set(client: &BuzzClient, id: &str, data: &str) -> Result<(), CliError> {
    let body = apply_schema(read_json_arg(data)?, SCHEMA_CONTENT_CAMPAIGN)?;
    let builder = EventBuilder::new(Kind::Custom(KIND_CONTENT_CAMPAIGN as u16), body.to_string())
        .tags(vec![tag(&["d", id])?]);
    submit(client, builder, |event| {
        parse_content_campaign(event)
            .map(|_| ())
            .map_err(validation_error)
    })
    .await
}

async fn cmd_campaign_list(client: &BuzzClient) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_CONTENT_CAMPAIGN] }))
        .await?;
    println!(
        "{}",
        serde_json::to_string(&newest_heads(events)).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

// ── posts ─────────────────────────────────────────────────────────────────

async fn cmd_post_set(
    client: &BuzzClient,
    campaign: &str,
    slug: &str,
    data: &str,
) -> Result<(), CliError> {
    let body = apply_schema(read_json_arg(data)?, SCHEMA_CONTENT_POST)?;
    let address = post_address(campaign, slug);
    let builder = EventBuilder::new(Kind::Custom(KIND_CONTENT_POST as u16), body.to_string())
        .tags(vec![tag(&["d", &address])?]);
    submit(client, builder, |event| {
        parse_content_post(event)
            .map(|_| ())
            .map_err(validation_error)
    })
    .await
}

async fn cmd_post_list(client: &BuzzClient, campaign: Option<&str>) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_CONTENT_POST] }))
        .await?;
    let mut heads = newest_heads(events);
    if let Some(campaign) = campaign {
        let prefix = format!("{campaign}:");
        heads.retain(|event| crate::client::extract_d_tag(event).starts_with(&prefix));
    }
    println!(
        "{}",
        serde_json::to_string(&heads).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

async fn cmd_post_get(client: &BuzzClient, campaign: &str, slug: &str) -> Result<(), CliError> {
    let event = fetch_post_head(client, campaign, slug).await?;
    println!(
        "{}",
        serde_json::to_string(&event).unwrap_or_else(|_| "null".to_string())
    );
    Ok(())
}

// ── house style ───────────────────────────────────────────────────────────

async fn cmd_style_set(client: &BuzzClient, scope: &str, data: &str) -> Result<(), CliError> {
    let body = apply_schema(read_json_arg(data)?, SCHEMA_CONTENT_STYLE)?;
    let builder = EventBuilder::new(Kind::Custom(KIND_CONTENT_STYLE as u16), body.to_string())
        .tags(vec![tag(&["d", scope])?]);
    submit(client, builder, |event| {
        parse_content_style(event)
            .map(|_| ())
            .map_err(validation_error)
    })
    .await
}

async fn cmd_style_get(client: &BuzzClient, scope: &str) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({
            "kinds": [KIND_CONTENT_STYLE],
            "#d": [scope],
        }))
        .await?;
    let head = newest_heads(events).into_iter().next();
    println!(
        "{}",
        serde_json::to_string(&head).unwrap_or_else(|_| "null".to_string())
    );
    Ok(())
}

// ── brand kit ─────────────────────────────────────────────────────────────

async fn cmd_kit_set(client: &BuzzClient, id: &str, data: &str) -> Result<(), CliError> {
    let body = apply_schema(read_json_arg(data)?, SCHEMA_CONTENT_BRAND_KIT)?;
    let builder = EventBuilder::new(
        Kind::Custom(KIND_CONTENT_BRAND_KIT as u16),
        body.to_string(),
    )
    .tags(vec![tag(&["d", id])?]);
    submit(client, builder, |event| {
        parse_content_brand_kit(event)
            .map(|_| ())
            .map_err(validation_error)
    })
    .await
}

async fn cmd_kit_get(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({
            "kinds": [KIND_CONTENT_BRAND_KIT],
            "#d": [id],
        }))
        .await?;
    let head = newest_heads(events).into_iter().next();
    println!(
        "{}",
        serde_json::to_string(&head).unwrap_or_else(|_| "null".to_string())
    );
    Ok(())
}

async fn cmd_kit_list(client: &BuzzClient) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_CONTENT_BRAND_KIT] }))
        .await?;
    println!(
        "{}",
        serde_json::to_string(&newest_heads(events)).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

// ── decisions ─────────────────────────────────────────────────────────────

/// Approve a post, or send it back with a note.
///
/// The decision is built from the post as it currently stands on the relay,
/// not from flags. That is what makes the record worth keeping: the approval
/// names the image hash and the gate verdict that were actually there when it
/// was signed, so a card edited afterwards reads as "approved, then changed"
/// rather than silently inheriting the sign-off.
async fn cmd_decide(
    client: &BuzzClient,
    campaign: &str,
    slug: &str,
    decision: &str,
    note: Option<&str>,
    correction_bin: Option<&str>,
    correction_text: Option<&str>,
) -> Result<(), CliError> {
    let head = fetch_post_head(client, campaign, slug).await?;
    let author = head
        .get("pubkey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::Other("post head carried no pubkey".to_string()))?
        .to_string();
    let parsed = parse_post_event(&head)?;

    let coordinate = format!(
        "{KIND_CONTENT_POST}:{author}:{}",
        post_address(campaign, slug)
    );

    // A post with no gate report has had nothing measured, which is exactly
    // what `incomplete` means. Reporting it as anything else would let an
    // unrendered card be approved as though its gates had run.
    let verdict = parsed.verdict().unwrap_or(GateVerdict::Incomplete);
    let mut target = serde_json::json!({ "verdict": verdict.as_str() });
    if let Some(image) = &parsed.image {
        target["image_sha256"] = serde_json::json!(image.sha256);
    }

    let mut body = serde_json::json!({
        "schema": SCHEMA_CONTENT_DECISION,
        "decision": decision,
        "target": target,
    });
    if let Some(note) = note {
        body["note"] = serde_json::json!(note);
    }
    match (correction_bin, correction_text) {
        (Some(bin), Some(text)) => {
            body["correction"] = serde_json::json!({ "bin": bin, "text": text });
        }
        (None, None) => {}
        _ => {
            return Err(CliError::Usage(
                "--correction-bin and --correction-text go together: a correction with no bin \
                 cannot be filed, and a bin with no text says nothing"
                    .to_string(),
            ));
        }
    }

    let builder = EventBuilder::new(Kind::Custom(KIND_CONTENT_DECISION as u16), body.to_string())
        .tags(vec![tag(&["a", &coordinate])?]);
    submit(client, builder, |event| {
        parse_content_decision(event)
            .map(|_| ())
            .map_err(validation_error)
    })
    .await
}

async fn cmd_decisions(
    client: &BuzzClient,
    campaign: Option<&str>,
    slug: Option<&str>,
) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_CONTENT_DECISION] }))
        .await?;
    let suffix = match (campaign, slug) {
        (Some(campaign), Some(slug)) => Some(format!(":{}", post_address(campaign, slug))),
        (Some(campaign), None) => Some(format!(":{campaign}:")),
        _ => None,
    };
    let filtered: Vec<serde_json::Value> = match suffix {
        None => events,
        Some(suffix) => events
            .into_iter()
            .filter(|event| crate::client::extract_tag_value(event, "a").contains(&suffix))
            .collect(),
    };
    println!(
        "{}",
        serde_json::to_string(&filtered).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

// ── shared helpers ────────────────────────────────────────────────────────

/// Reduce a list of NIP-33 events to the newest event per `d` tag.
///
/// A relay that still holds a superseded head, or a mesh that delivers two
/// revisions out of order, would otherwise show a card twice with different
/// contents. `head_is_newer` is the same ordering the rest of the CLI uses.
fn newest_heads(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut heads: Vec<serde_json::Value> = Vec::new();
    for event in events {
        let d_tag = crate::client::extract_d_tag(&event);
        match heads
            .iter()
            .position(|held| crate::client::extract_d_tag(held) == d_tag)
        {
            Some(index) => {
                if head_is_newer(&event, &heads[index]) {
                    heads[index] = event;
                }
            }
            None => heads.push(event),
        }
    }
    heads.sort_by_key(crate::client::extract_d_tag);
    heads
}

async fn fetch_post_head(
    client: &BuzzClient,
    campaign: &str,
    slug: &str,
) -> Result<serde_json::Value, CliError> {
    let address = post_address(campaign, slug);
    let events = client
        .query_all(serde_json::json!({
            "kinds": [KIND_CONTENT_POST],
            "#d": [address],
        }))
        .await?;
    newest_heads(events)
        .into_iter()
        .next()
        .ok_or_else(|| CliError::Usage(format!("no post found at {address}")))
}

/// Parse a relay event document with the same parser the relay used to store it.
fn parse_post_event(event: &serde_json::Value) -> Result<ParsedContentPost, CliError> {
    let typed: nostr::Event = serde_json::from_value(event.clone())
        .map_err(|error| CliError::Other(format!("post head was not a valid event: {error}")))?;
    parse_content_post(&typed)
        .map_err(|error| CliError::Other(format!("stored post failed validation: {error}")))
}

/// Dispatch a `buzz content` subcommand.
pub async fn dispatch(cmd: crate::ContentCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::ContentCmd;
    match cmd {
        ContentCmd::CampaignSet { id, data } => cmd_campaign_set(client, &id, &data).await,
        ContentCmd::CampaignList {} => cmd_campaign_list(client).await,
        ContentCmd::PostSet {
            campaign,
            slug,
            data,
        } => cmd_post_set(client, &campaign, &slug, &data).await,
        ContentCmd::PostList { campaign } => cmd_post_list(client, campaign.as_deref()).await,
        ContentCmd::PostGet { campaign, slug } => cmd_post_get(client, &campaign, &slug).await,
        ContentCmd::StyleSet { scope, data } => {
            cmd_style_set(
                client,
                scope.as_deref().unwrap_or(DEFAULT_STYLE_SCOPE),
                &data,
            )
            .await
        }
        ContentCmd::StyleGet { scope } => {
            cmd_style_get(client, scope.as_deref().unwrap_or(DEFAULT_STYLE_SCOPE)).await
        }
        ContentCmd::KitSet { id, data } => cmd_kit_set(client, &id, &data).await,
        ContentCmd::KitGet { id } => cmd_kit_get(client, &id).await,
        ContentCmd::KitList {} => cmd_kit_list(client).await,
        ContentCmd::Decide {
            campaign,
            slug,
            decision,
            note,
            correction_bin,
            correction_text,
        } => {
            cmd_decide(
                client,
                &campaign,
                &slug,
                &decision,
                note.as_deref(),
                correction_bin.as_deref(),
                correction_text.as_deref(),
            )
            .await
        }
        ContentCmd::Decisions { campaign, slug } => {
            cmd_decisions(client, campaign.as_deref(), slug.as_deref()).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(d: &str, created_at: i64, id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "created_at": created_at,
            "tags": [["d", d]],
        })
    }

    #[test]
    fn apply_schema_injects_when_absent() {
        let body = apply_schema(serde_json::json!({ "name": "x" }), SCHEMA_CONTENT_CAMPAIGN)
            .expect("inject");
        assert_eq!(
            body.get("schema").and_then(|v| v.as_str()),
            Some(SCHEMA_CONTENT_CAMPAIGN)
        );
    }

    #[test]
    fn apply_schema_accepts_a_matching_declaration() {
        let body = apply_schema(
            serde_json::json!({ "schema": SCHEMA_CONTENT_POST, "week": 1 }),
            SCHEMA_CONTENT_POST,
        )
        .expect("match");
        assert_eq!(body.get("week").and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn apply_schema_refuses_a_document_built_for_another_record() {
        // Passing a post body to campaign-set must fail loudly rather than be
        // silently relabelled and stored as a campaign.
        let error = apply_schema(
            serde_json::json!({ "schema": SCHEMA_CONTENT_POST }),
            SCHEMA_CONTENT_CAMPAIGN,
        )
        .expect_err("mismatch must be refused");
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn apply_schema_refuses_a_non_object_document() {
        assert!(apply_schema(serde_json::json!([1, 2]), SCHEMA_CONTENT_STYLE).is_err());
    }

    #[test]
    fn newest_heads_keeps_one_event_per_d_tag() {
        let heads = newest_heads(vec![
            event("a:one", 100, "old"),
            event("a:one", 200, "new"),
            event("a:two", 150, "other"),
        ]);
        assert_eq!(heads.len(), 2);
        let one = heads
            .iter()
            .find(|e| crate::client::extract_d_tag(e) == "a:one")
            .expect("a:one");
        assert_eq!(one.get("id").and_then(|v| v.as_str()), Some("new"));
    }

    #[test]
    fn newest_heads_ignores_arrival_order() {
        let forward = newest_heads(vec![event("a:one", 100, "old"), event("a:one", 200, "new")]);
        let reversed = newest_heads(vec![event("a:one", 200, "new"), event("a:one", 100, "old")]);
        assert_eq!(forward, reversed);
    }

    #[test]
    fn read_json_arg_accepts_a_leading_at_sign() {
        let dir = std::env::temp_dir().join("buzz-content-test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("body.json");
        std::fs::write(&path, r#"{"name":"x"}"#).expect("write");

        let plain = read_json_arg(path.to_str().expect("utf8")).expect("plain path");
        let at = read_json_arg(&format!("@{}", path.to_str().expect("utf8"))).expect("@ path");
        assert_eq!(plain, at);
        std::fs::remove_file(&path).ok();
    }
}
