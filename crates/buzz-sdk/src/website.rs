//! Typed builders and parsers for Website Manager events.
//!
//! Actions are built from the shared `buzz-core` wire contract so the CLI, the
//! desktop surface, and tests cannot drift from the relay parser. Heads and
//! receipts are relay-authored; these parsers only decode the shape a reader
//! validates against before rendering.

use buzz_core::kind::{
    KIND_TASK_REPORT, KIND_WEBSITE_ACTION, KIND_WEBSITE_HEAD, KIND_WEBSITE_RECEIPT,
};
use buzz_core::website::{WebsiteAction, WebsiteReceipt, WebsiteReview};
use nostr::{Event, EventBuilder, Kind, Tag};
use uuid::Uuid;

use crate::SdkError;

/// Tag name a QA task report uses to bind revision, manifest, and report.
pub const WEBSITE_QA_TAG: &str = "website-qa";

/// Identity tags read off a relay-signed website head (kind 30203).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebsiteHeadIdentity {
    /// Canonical job UUID (`d` tag).
    pub job_id: Uuid,
    /// Channel the head belongs to.
    pub channel: String,
    /// Canonical CompanyTask id.
    pub task_id: String,
    /// Root event id of the job thread.
    pub thread_root: String,
    /// Pinned review-card Block instance event id.
    pub instance_event_id: String,
    /// Pinned Block manifest event id.
    pub manifest_event_id: String,
    /// Row generation.
    pub generation: u64,
    /// `p` tag values: owner first (if present), coordinator second.
    pub participants: Vec<String>,
}

/// Build a signed-action-ready website action event.
pub fn build_website_action(action: &WebsiteAction) -> Result<EventBuilder, SdkError> {
    let content = action.content_value().to_string();
    let tags = action
        .event_tags()
        .map_err(|error| SdkError::InvalidInput(error.to_string()))?;
    Ok(EventBuilder::new(Kind::Custom(KIND_WEBSITE_ACTION as u16), content).tags(tags))
}

/// Parse a relay-signed website head's content review record.
pub fn parse_website_head(event: &Event) -> Result<WebsiteReview, SdkError> {
    if event.kind.as_u16() as u32 != KIND_WEBSITE_HEAD {
        return Err(SdkError::InvalidInput("event is not a website head".into()));
    }
    WebsiteReview::parse(event.content.as_bytes())
        .map_err(|error| SdkError::InvalidInput(error.to_string()))
}

/// Read the identity tags off a relay-signed website head.
pub fn parse_website_head_identity(event: &Event) -> Result<WebsiteHeadIdentity, SdkError> {
    if event.kind.as_u16() as u32 != KIND_WEBSITE_HEAD {
        return Err(SdkError::InvalidInput("event is not a website head".into()));
    }
    let tag = |name: &str| {
        event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() == 2 && parts[0] == name).then(|| parts[1].clone())
        })
    };
    let job_id = tag("d")
        .and_then(|value| Uuid::parse_str(&value).ok())
        .ok_or_else(|| SdkError::InvalidInput("website head has no job id".into()))?;
    let channel =
        tag("h").ok_or_else(|| SdkError::InvalidInput("website head has no channel".into()))?;
    let task_id =
        tag("task").ok_or_else(|| SdkError::InvalidInput("website head has no task".into()))?;
    let thread_root =
        tag("thread").ok_or_else(|| SdkError::InvalidInput("website head has no thread".into()))?;
    let instance_event_id = tag("instance")
        .ok_or_else(|| SdkError::InvalidInput("website head has no instance".into()))?;
    let manifest_event_id = tag("manifest")
        .ok_or_else(|| SdkError::InvalidInput("website head has no manifest".into()))?;
    let generation = tag("generation")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| SdkError::InvalidInput("website head has no generation".into()))?;
    let participants = event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() == 2 && parts[0] == "p").then(|| parts[1].clone())
        })
        .collect();
    Ok(WebsiteHeadIdentity {
        job_id,
        channel,
        task_id,
        thread_root,
        instance_event_id,
        manifest_event_id,
        generation,
        participants,
    })
}

/// Parse a relay-signed website receipt (kind 40028).
pub fn parse_website_receipt(event: &Event) -> Result<WebsiteReceipt, SdkError> {
    if event.kind.as_u16() as u32 != KIND_WEBSITE_RECEIPT {
        return Err(SdkError::InvalidInput(
            "event is not a website receipt".into(),
        ));
    }
    serde_json::from_str(&event.content).map_err(|error| SdkError::InvalidInput(error.to_string()))
}

/// Build the exact QA binding tag for a KIND_TASK_REPORT event.
pub fn website_qa_binding_tag(
    revision: u32,
    manifest_sha256: &str,
    report_url: &str,
    report_sha256: &str,
) -> Result<Tag, SdkError> {
    Tag::parse([
        WEBSITE_QA_TAG,
        &revision.to_string(),
        manifest_sha256,
        report_url,
        report_sha256,
    ])
    .map_err(|error| SdkError::InvalidTag(error.to_string()))
}

/// Build the QA task report an independent reviewer signs.
///
/// The report names the canonical task and binds the exact revision, manifest,
/// and QA report artifact, so the relay can refuse a generic task report as QA
/// evidence for an unrelated revision.
pub fn build_website_qa_task_report(
    task_id: &str,
    revision: u32,
    manifest_sha256: &str,
    report_url: &str,
    report_sha256: &str,
    note: &str,
) -> Result<EventBuilder, SdkError> {
    let binding = website_qa_binding_tag(revision, manifest_sha256, report_url, report_sha256)?;
    let task =
        Tag::parse(["task", task_id]).map_err(|error| SdkError::InvalidTag(error.to_string()))?;
    Ok(EventBuilder::new(Kind::Custom(KIND_TASK_REPORT as u16), note).tags([task, binding]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::website::{WebsiteActionOp, WEBSITE_ACTION_SCHEMA};
    use nostr::Keys;
    use serde_json::json;

    const CHANNEL: &str = "0d1e2f30-0000-4000-8000-000000000001";
    const TASK: &str = "task-website";
    const THREAD: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const INSTANCE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const MANIFEST: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COORDINATOR: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn action_builder_round_trips_through_the_core_parser() {
        let action = WebsiteAction {
            channel_id: CHANNEL.parse().expect("channel"),
            task_id: TASK.to_owned(),
            thread_root: THREAD.to_owned(),
            instance_event_id: Some(INSTANCE.to_owned()),
            manifest_event_id: Some(MANIFEST.to_owned()),
            request_id: Uuid::new_v4(),
            generation: None,
            actor: Keys::generate().public_key(),
            op: WebsiteActionOp::Create {
                coordinator: COORDINATOR.to_owned(),
                source_url: "https://source.colony.test/sites/acme".to_owned(),
                research_personas: vec!["persona-research".to_owned()],
                build_personas: vec!["persona-build".to_owned()],
                review_personas: vec!["persona-review".to_owned()],
            },
        };
        let event = build_website_action(&action)
            .expect("builder")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        let parsed = buzz_core::website::parse_website_action(&event).expect("core parser");
        assert_eq!(parsed.actor, event.pubkey);
        assert_eq!(parsed.task_id, TASK);
    }

    #[test]
    fn qa_task_report_binds_revision_and_report() {
        let event = build_website_qa_task_report(
            TASK,
            2,
            HASH,
            "https://cdn.colony.test/qa/r2/report.json",
            HASH,
            "reviewed",
        )
        .expect("builder")
        .sign_with_keys(&Keys::generate())
        .expect("sign");
        let binding = event
            .tags
            .iter()
            .find(|tag| {
                tag.as_slice()
                    .first()
                    .is_some_and(|part| part == WEBSITE_QA_TAG)
            })
            .expect("binding tag");
        assert_eq!(binding.as_slice()[1], "2");
        assert_eq!(binding.as_slice()[2], HASH);
        assert_eq!(event.kind.as_u16() as u32, KIND_TASK_REPORT);
    }

    #[test]
    fn receipt_parser_reads_the_wire_shape() {
        let keys = Keys::generate();
        let event = EventBuilder::new(
            Kind::Custom(KIND_WEBSITE_RECEIPT as u16),
            json!({
                "schema": "colony.website-receipt/v1",
                "op": "create",
                "outcome": "applied",
                "jobId": Uuid::from_u128(3),
                "generation": 1,
                "revision": 0,
                "headEventId": HASH,
            })
            .to_string(),
        )
        .sign_with_keys(&keys)
        .expect("sign");
        let receipt = parse_website_receipt(&event).expect("receipt parses");
        assert_eq!(receipt.op, "create");
        assert_eq!(receipt.generation, 1);
        let _ = WEBSITE_ACTION_SCHEMA;
    }
}
