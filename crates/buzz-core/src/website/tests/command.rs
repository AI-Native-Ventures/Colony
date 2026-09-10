//! Unit tests for the website action and decision wire contract.

use nostr::{EventBuilder, Keys, Kind, Tag};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::kind::KIND_WEBSITE_ACTION;
use crate::website::{
    is_reserved_website_action_id, parse_website_action, parse_website_decision_action, sha256_hex,
    validate_public_url, PreviewArtifactRef, WebsiteAction, WebsiteActionOp, WebsiteCommandError,
    WebsiteReceipt, WebsiteReview, WEBSITE_ACTION_SCHEMA, WEBSITE_APPROVE_ACTION_ID,
    WEBSITE_REQUEST_CHANGES_ACTION_ID,
};

const CHANNEL: &str = "0d1e2f30-0000-4000-8000-000000000001";
const TASK: &str = "task-website";
const THREAD: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INSTANCE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const MANIFEST: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const COORDINATOR: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn artifact(url: &str, sha256: &str) -> PreviewArtifactRef {
    PreviewArtifactRef {
        url: url.to_owned(),
        sha256: sha256.to_owned(),
    }
}

fn signed(
    keys: &Keys,
    content: &Value,
    generation: Option<u64>,
) -> nostr::Event {
    let mut tags = vec![
        Tag::parse(["h", CHANNEL]).expect("h"),
        Tag::parse(["task", TASK]).expect("task"),
        Tag::parse(["thread", THREAD]).expect("thread"),
        Tag::parse(["request", &Uuid::new_v4().to_string()]).expect("request"),
        Tag::parse(["instance", INSTANCE]).expect("instance"),
        Tag::parse(["manifest", MANIFEST]).expect("manifest"),
    ];
    if let Some(generation) = generation {
        tags.push(Tag::parse(["generation", &generation.to_string()]).expect("generation"));
    }
    EventBuilder::new(Kind::Custom(KIND_WEBSITE_ACTION as u16), content.to_string())
        .tags(tags)
        .sign_with_keys(keys)
        .expect("sign action")
}

fn create_content() -> Value {
    json!({
        "op": "create",
        "schema": WEBSITE_ACTION_SCHEMA,
        "coordinator": COORDINATOR,
        "sourceUrl": "https://source.colony.test/sites/acme",
        "researchPersonas": ["persona-research"],
        "buildPersonas": ["persona-build"],
        "reviewPersonas": ["persona-review"],
    })
}

#[test]
fn parses_a_well_formed_create_without_generation() {
    let keys = Keys::generate();
    let action = parse_website_action(&signed(&keys, &create_content(), None))
        .expect("valid create parses");
    assert_eq!(action.channel_id, CHANNEL.parse::<Uuid>().unwrap());
    assert_eq!(action.task_id, TASK);
    assert_eq!(action.thread_root, THREAD);
    assert_eq!(action.generation, None);
    assert_eq!(action.actor, keys.public_key());
    match action.op {
        WebsiteActionOp::Create {
            coordinator,
            build_personas,
            review_personas,
            ..
        } => {
            assert_eq!(coordinator, COORDINATOR);
            assert_eq!(build_personas, vec!["persona-build"]);
            assert_eq!(review_personas, vec!["persona-review"]);
        }
        other => panic!("expected create, got {other:?}"),
    }
}

#[test]
fn rejects_a_create_that_carries_a_generation() {
    let keys = Keys::generate();
    let error = parse_website_action(&signed(&keys, &create_content(), Some(1)))
        .expect_err("create with generation must fail");
    assert_eq!(error.code(), "invalid_content");
}

#[test]
fn rejects_a_create_without_instance_or_manifest() {
    let keys = Keys::generate();
    let mut event = signed(&keys, &create_content(), None);
    event
        .tags
        .retain(|tag| tag.as_slice().first().map(String::as_str) != Some("instance"));
    assert_eq!(
        parse_website_action(&event).unwrap_err().code(),
        "invalid_content"
    );
}

#[test]
fn rejects_a_missing_request_tag() {
    let keys = Keys::generate();
    let event = EventBuilder::new(
        Kind::Custom(KIND_WEBSITE_ACTION as u16),
        create_content().to_string(),
    )
    .tags([
        Tag::parse(["h", CHANNEL]).expect("h"),
        Tag::parse(["task", TASK]).expect("task"),
        Tag::parse(["thread", THREAD]).expect("thread"),
    ])
    .sign_with_keys(&keys)
    .expect("sign");
    assert_eq!(
        parse_website_action(&event).unwrap_err().code(),
        "missing_tag"
    );
}

#[test]
fn rejects_unknown_operations_and_decision_smuggling() {
    let keys = Keys::generate();
    let unknown = json!({
        "op": "publish",
        "schema": WEBSITE_ACTION_SCHEMA,
    });
    assert_eq!(
        parse_website_action(&signed(&keys, &unknown, None))
            .unwrap_err()
            .code(),
        "unknown_operation"
    );

    let decision = json!({
        "op": "decision",
        "schema": WEBSITE_ACTION_SCHEMA,
        "kind": "approve",
    });
    assert_eq!(
        parse_website_action(&signed(&keys, &decision, Some(2)))
            .unwrap_err()
            .code(),
        "decision_via_website_action"
    );
}

#[test]
fn add_revision_validates_refs_and_requires_generation() {
    let keys = Keys::generate();
    let revision = json!({
        "op": "addRevision",
        "schema": WEBSITE_ACTION_SCHEMA,
        "revision": 1,
        "manifest": artifact("https://cdn.colony.test/previews/r1.json", HASH),
        "sourceUrl": "https://source.colony.test/sites/acme",
        "archive": artifact("https://cdn.colony.test/archives/r1.tar.gz", HASH),
        "captures": {
            "before": artifact("https://cdn.colony.test/captures/before.png", HASH),
            "desktop": artifact("https://cdn.colony.test/captures/desktop.png", HASH),
            "mobile": artifact("https://cdn.colony.test/captures/mobile.png", HASH),
        },
    });
    assert!(parse_website_action(&signed(&keys, &revision, Some(1))).is_ok());
    assert_eq!(
        parse_website_action(&signed(&keys, &revision, None))
            .unwrap_err()
            .code(),
        "invalid_generation"
    );

    let mut insecure = revision.clone();
    insecure["manifest"]["url"] = json!("http://cdn.colony.test/previews/r1.json");
    assert_eq!(
        parse_website_action(&signed(&keys, &insecure, Some(1)))
            .unwrap_err()
            .code(),
        "invalid_url"
    );
}

#[test]
fn handover_rejects_empty_and_duplicate_assets() {
    let keys = Keys::generate();
    let base = json!({
        "op": "handover",
        "schema": WEBSITE_ACTION_SCHEMA,
        "approvedRevision": 1,
        "approvedManifestSha256": HASH,
        "sourceUrl": "https://source.colony.test/sites/acme",
        "sourceArchive": artifact("https://cdn.colony.test/archives/r1.tar.gz", HASH),
        "assets": [{"path": "index.html", "artifact": artifact("https://cdn.colony.test/site/index.html", HASH)}],
    });
    assert!(parse_website_action(&signed(&keys, &base, Some(3))).is_ok());

    let mut duplicate = base.clone();
    let asset = duplicate["assets"][0].clone();
    duplicate["assets"] = json!([asset.clone(), asset]);
    assert_eq!(
        parse_website_action(&signed(&keys, &duplicate, Some(3)))
            .unwrap_err()
            .code(),
        "duplicate_asset_path"
    );

    let mut empty = base;
    empty["assets"] = json!([]);
    assert_eq!(
        parse_website_action(&signed(&keys, &empty, Some(3)))
            .unwrap_err()
            .code(),
        "invalid_handover_assets"
    );
}

#[test]
fn persona_lists_must_be_disjoint_and_bounded() {
    let keys = Keys::generate();
    let mut overlap = create_content();
    overlap["reviewPersonas"] = json!(["persona-build"]);
    assert_eq!(
        parse_website_action(&signed(&keys, &overlap, None))
            .unwrap_err()
            .code(),
        "invalid_personas"
    );

    let mut too_many = create_content();
    too_many["buildPersonas"] = json!((0..65).map(|i| format!("p{i}")).collect::<Vec<_>>());
    assert_eq!(
        parse_website_action(&signed(&keys, &too_many, None))
            .unwrap_err()
            .code(),
        "invalid_personas"
    );
}

#[test]
fn payload_digest_tracks_payload_not_request_identity() {
    let base = WebsiteAction {
        channel_id: CHANNEL.parse().expect("channel"),
        task_id: TASK.to_owned(),
        thread_root: THREAD.to_owned(),
        instance_event_id: Some(INSTANCE.to_owned()),
        manifest_event_id: Some(MANIFEST.to_owned()),
        request_id: Uuid::new_v4(),
        generation: Some(4),
        actor: Keys::generate().public_key(),
        op: WebsiteActionOp::BeginWork,
    };
    let retry = WebsiteAction {
        request_id: Uuid::new_v4(),
        ..base.clone()
    };
    assert_eq!(base.payload_digest(), retry.payload_digest());

    let changed_generation = WebsiteAction {
        generation: Some(5),
        ..base.clone()
    };
    assert_ne!(base.payload_digest(), changed_generation.payload_digest());

    let changed_op = WebsiteAction {
        op: WebsiteActionOp::Ready,
        ..base.clone()
    };
    assert_ne!(base.payload_digest(), changed_op.payload_digest());
}

#[test]
fn job_id_derivation_is_stable_and_scope_sensitive() {
    let community = Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
    let job = WebsiteAction::derive_job_id(community, TASK, THREAD);
    assert_eq!(job, WebsiteAction::derive_job_id(community, TASK, THREAD));
    assert_ne!(
        job,
        WebsiteAction::derive_job_id(community, "other-task", THREAD)
    );
    assert_ne!(
        job,
        WebsiteAction::derive_job_id(Uuid::from_u128(2), TASK, THREAD)
    );
}

#[test]
fn reserved_decision_action_ids_and_content() {
    assert!(is_reserved_website_action_id(WEBSITE_APPROVE_ACTION_ID));
    assert!(is_reserved_website_action_id(WEBSITE_REQUEST_CHANGES_ACTION_ID));
    assert!(!is_reserved_website_action_id("website.publish"));

    let job_id = Uuid::new_v4();
    let approve = parse_website_decision_action(
        WEBSITE_APPROVE_ACTION_ID,
        &json!({
            "schema": WEBSITE_ACTION_SCHEMA,
            "jobId": job_id,
            "taskId": TASK,
            "generation": 3,
            "revision": 2,
            "manifestSha256": HASH,
        }),
    )
    .expect("approve parses");
    assert_eq!(approve.kind.as_str(), "approve");
    assert_eq!(approve.generation, 3);

    let request = parse_website_decision_action(
        WEBSITE_REQUEST_CHANGES_ACTION_ID,
        &json!({
            "schema": WEBSITE_ACTION_SCHEMA,
            "jobId": job_id,
            "taskId": TASK,
            "generation": 3,
            "revision": 2,
            "manifestSha256": HASH,
            "note": "tighten the hero",
        }),
    )
    .expect("request changes parses");
    assert_eq!(request.kind.as_str(), "requestChanges");
    assert_eq!(request.note.as_deref(), Some("tighten the hero"));

    assert_eq!(
        parse_website_decision_action(
            WEBSITE_APPROVE_ACTION_ID,
            &json!({
                "schema": WEBSITE_ACTION_SCHEMA,
                "jobId": job_id,
                "taskId": TASK,
                "revision": 2,
                "manifestSha256": HASH,
            }),
        )
        .unwrap_err()
        .code(),
        "invalid_content"
    );

    assert_eq!(
        parse_website_decision_action("website.publish", &json!({}))
            .unwrap_err()
            .code(),
        "unknown_decision_action"
    );
}

#[test]
fn receipt_encodes_camel_case_without_optional_decision() {
    let receipt = WebsiteReceipt {
        schema: "colony.website-receipt/v1".to_owned(),
        op: "beginWork".to_owned(),
        outcome: "applied".to_owned(),
        job_id: Uuid::from_u128(9),
        generation: 2,
        revision: 0,
        head_event_id: HASH.to_owned(),
        decision_id: None,
    };
    let encoded = receipt.encode().expect("receipt encodes");
    assert!(encoded.contains("\"headEventId\""));
    assert!(!encoded.contains("decisionId"));
}

#[test]
fn content_round_trips_through_parse() {
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
    let content = action.content_value();
    let parsed = parse_website_action(&signed(
        &Keys::generate(),
        &content,
        action.generation,
    ))
    .expect("round trip parses");
    assert_eq!(
        WebsiteAction {
            actor: parsed.actor.clone(),
            ..action
        },
        parsed
    );
}

#[test]
fn handover_access_request_is_bounded_and_attributed() {
    let keys = Keys::generate();
    let handover = json!({
        "op": "handover",
        "schema": WEBSITE_ACTION_SCHEMA,
        "approvedRevision": 1,
        "approvedManifestSha256": HASH,
        "sourceUrl": "https://source.colony.test/sites/acme",
        "sourceArchive": artifact("https://cdn.colony.test/archives/r1.tar.gz", HASH),
        "assets": [{"path": "index.html", "artifact": artifact("https://cdn.colony.test/site/index.html", HASH)}],
        "accessRequest": {
            "text": "Point the apex at our host.\nDNS: A record -> 203.0.113.7",
            "authoredBy": COORDINATOR,
        },
    });
    assert!(parse_website_action(&signed(&keys, &handover, Some(3))).is_ok());

    let mut bad_text = handover.clone();
    bad_text["accessRequest"]["text"] = json!("bad\u{7}control");
    assert_eq!(
        parse_website_action(&signed(&keys, &bad_text, Some(3)))
            .unwrap_err()
            .code(),
        "invalid_content"
    );

    let mut bad_author = handover;
    bad_author["accessRequest"]["authoredBy"] = json!("not-a-pubkey");
    assert_eq!(
        parse_website_action(&signed(&keys, &bad_author, Some(3)))
            .unwrap_err()
            .code(),
        "invalid_identity"
    );
}

#[test]
fn public_url_guard_rejects_loopback_and_credentials() {
    assert!(validate_public_url("https://cdn.colony.test/site/index.html").is_ok());
    assert!(validate_public_url("https://localhost/site").is_err());
    assert!(validate_public_url("https://user:pass@cdn.colony.test/site").is_err());
}

#[test]
fn manifest_hash_helper_is_lowercase_hex() {
    let hash = sha256_hex(b"manifest");
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
}

#[test]
fn empty_review_parse_reports_shape_error() {
    let error = WebsiteReview::parse(b"{}").expect_err("empty review is invalid");
    assert_eq!(error.code(), "review_json");
}

#[test]
fn content_over_budget_is_refused_before_parsing() {
    let keys = Keys::generate();
    let mut event = signed(&keys, &create_content(), None);
    let padding = "x".repeat(200_000);
    event.content = format!("{}{}", event.content, padding);
    assert_eq!(
        parse_website_action(&event).unwrap_err().code(),
        "content_too_large"
    );
}

#[test]
fn website_command_error_codes_are_stable() {
    assert_eq!(WebsiteCommandError::InvalidKind.code(), "invalid_kind");
    assert_eq!(
        WebsiteCommandError::DecisionViaWebsiteAction.code(),
        "decision_via_website_action"
    );
}
